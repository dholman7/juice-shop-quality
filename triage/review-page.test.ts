/**
 * The review page's server, end to end: a real process on a throwaway checkout with its own git remote.
 * Tests run in order and share state; each says what it leaves behind.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FINDING, REVIEW_FILES, freePort, makeCheckout, startServer, type Checkout, type Server } from './review-page.fixture';

let repo: Checkout;
let server: Server;

before(async () => {
  repo = makeCheckout();
  server = await startServer(repo.root, freePort(0));
});
after(() => {
  server?.stop();
  repo?.cleanup();
});

const state = async () => (await fetch(`${server.url}/api/state`)).json();
const bugs = () => JSON.parse(readFileSync(join(repo.root, 'known-bugs.json'), 'utf8')).bugs as { id: string; jira: string; severity: string; tests: string[]; title: string }[];
const decisions = () => readFileSync(join(repo.root, 'triage/decisions.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: { message?: string; error?: string } }> {
  const res = await fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: { origin: server.url, 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}
const as = (body: Record<string, unknown>) => ({ reviewer: 'Dan Holman', ...body });

test('serves the page and everything left to decide', async () => {
  // Act
  const page = await fetch(server.url);
  const s = await state();

  // Assert
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>Juice Shop review<\/title>/);
  assert.equal(s.reviewer, 'Fixture Reviewer');
  assert.equal(s.demo, false);
  assert.deepEqual(s.severity.map((b: { id: string; band: string }) => [b.id, b.band]), [['BUG-003', 'high']]);
  assert.deepEqual(s.groups.map((g: { groupId: string }) => g.groupId), ['G-dup', 'G-hash', 'G-new', 'G-change', 'G-reject']);
  assert.equal(s.groups[0].candidates[0].id, 'BUG-001', 'same endpoint, both access checks');
  assert.deepEqual(s.groups[1].candidates, [], 'the hash group needs search');
  assert.deepEqual(s.zap.map((f: { ref: string }) => f.ref), [FINDING.ref]);
  assert.deepEqual(s.git, { branch: 'main', changed: [], unpushed: 0 });
});

test('refuses other hosts, other pages, and anything but JSON', async () => {
  // A wrong Host is what DNS rebinding looks like; Node's fetch can't override Host, so use http directly.
  const { request } = await import('node:http');
  const wrongHost = await new Promise<number>((resolve) => {
    request({ host: '127.0.0.1', port: server.port, path: '/api/state', headers: { host: 'evil.example' } }, (res) => resolve(res.statusCode ?? 0)).end();
  });
  assert.equal(wrongHost, 403);
  assert.equal((await post('/api/rescore', as({}), { origin: '' })).status, 403, 'no Origin');
  assert.equal((await post('/api/rescore', as({}), { origin: 'https://evil.example' })).status, 403, 'another site');
  assert.equal((await post('/api/rescore', 'a=1', { 'content-type': 'application/x-www-form-urlencoded' })).status, 415, 'a form post');
  assert.equal((await post('/api/rescore', 'not json')).status, 400);
  assert.equal((await fetch(`${server.url}/api/nope`)).status, 404);
  assert.deepEqual(decisions(), [], 'nothing was written');
});

test('every change needs a reviewer name on one line', async () => {
  for (const reviewer of ['', '   ', 'Dan\nReviewed-by: Someone Else', 'x'.repeat(81)]) {
    const res = await post('/api/rescore', { reviewer, bugId: 'BUG-003', impact: 4, likelihood: 3, reason: 'r' });
    assert.equal(res.status, 400, JSON.stringify(reviewer));
    assert.match(res.json.error ?? '', /your name/);
  }
});

test('severity check: the scored severity, a reason, and no empty changes', async () => {
  // Act
  const noReason = await post('/api/rescore', as({ bugId: 'BUG-003', impact: 4, likelihood: 3, reason: ' ' }));
  const fixed = await post('/api/rescore', as({ bugId: 'BUG-003', impact: 4, likelihood: 3, reason: 'matches I4 × L3 = 12' }));
  const again = await post('/api/rescore', as({ bugId: 'BUG-003', impact: 4, likelihood: 3, reason: 'again' }));
  const badScore = await post('/api/rescore', as({ bugId: 'BUG-003', impact: 6, likelihood: 3, reason: 'r' }));

  // Assert
  assert.equal(noReason.status, 400);
  assert.equal(fixed.json.message, 'BUG-003: medium → high');
  assert.equal(again.status, 400, 'nothing to change');
  assert.equal(badScore.status, 400);
  assert.deepEqual((await state()).severity, []);
  assert.equal(bugs().find((b) => b.id === 'BUG-003')?.severity, 'high');
});

test('a group joins a suggested bug, or one found by search or Jira key', async () => {
  // Act
  const search = await (await fetch(`${server.url}/api/search?q=hash`)).json();
  const dup = await post('/api/decide', as({ groupId: 'G-dup', verdict: 'decide', category: 'product-bug', target: { existing: 'BUG-001' } }));
  const hash = await post('/api/decide', as({ groupId: 'G-hash', verdict: 'decide', category: 'product-bug', target: { existing: 'shop-2' } }));
  const twice = await post('/api/decide', as({ groupId: 'G-dup', verdict: 'decide', category: 'product-bug', target: { existing: 'BUG-001' } }));

  // Assert
  assert.deepEqual(search.map((b: { id: string }) => b.id), ['BUG-002']);
  assert.equal(dup.json.message, 'added to BUG-001');
  assert.equal(hash.json.message, 'added to BUG-002');
  assert.equal(twice.status, 400, 'a decided group is not decided twice');
  assert.equal(bugs().find((b) => b.id === 'BUG-001')?.tests.length, 2);
  assert.deepEqual(decisions().map((d) => [d.groupId, d.verdict, d.bugId, d.reviewer]), [['G-dup', 'accepted', 'BUG-001', 'Dan Holman'], ['G-hash', 'accepted', 'BUG-002', 'Dan Holman']]);
});

test('a new bug needs a Jira key, a title, and scores; a bad one writes nothing', async () => {
  // Arrange
  const target = { jira: 'SHOP-40', title: 'An address with no name is accepted', impact: 2, likelihood: 2 };
  const before = { bugs: bugs().length, decisions: decisions().length };

  // Act
  const refused = await Promise.all([
    post('/api/decide', as({ groupId: 'G-new', verdict: 'decide', category: 'product-bug' })),
    post('/api/decide', as({ groupId: 'G-new', verdict: 'decide', category: 'product-bug', target: { ...target, jira: 'JIRA' } })),
    post('/api/decide', as({ groupId: 'G-new', verdict: 'decide', category: 'product-bug', target: { ...target, title: ' ' } })),
    post('/api/decide', as({ groupId: 'G-new', verdict: 'decide', category: 'product-bug', target: { ...target, impact: 0 } })),
  ]);
  const unchanged = { bugs: bugs().length, decisions: decisions().length };
  const filed = await post('/api/decide', as({ groupId: 'G-new', verdict: 'decide', category: 'product-bug', target }));

  // Assert
  for (const r of refused) assert.equal(r.status, 400, r.json.error ?? '');
  assert.deepEqual(unchanged, before);
  assert.equal(filed.json.message, 'filed as new bug BUG-004');
  const created = bugs().find((b) => b.id === 'BUG-004');
  assert.deepEqual([created?.jira, created?.severity, created?.title], ['SHOP-40', 'low', 'An address with no name is accepted']);
  assert.equal(decisions().at(-1).title, 'An address with no name is accepted');
});

test('changing the cause or rejecting files no bug, and is logged as such', async () => {
  // Act
  const changed = await post('/api/decide', as({ groupId: 'G-change', verdict: 'decide', category: 'test-bug' }));
  const rejected = await post('/api/decide', as({ groupId: 'G-reject', verdict: 'reject' }));
  const badCause = await post('/api/decide', as({ groupId: 'G-change', verdict: 'decide', category: 'nonsense' }));

  // Assert
  assert.equal(changed.json.message, 'recorded as test-bug');
  assert.equal(rejected.json.message, 'rejected: nothing filed');
  assert.equal(badCause.status, 400);
  assert.deepEqual(decisions().slice(-2).map((d) => [d.groupId, d.verdict, d.category, d.bugId]), [['G-change', 'changed', 'test-bug', undefined], ['G-reject', 'rejected', 'product-bug', undefined]]);
  assert.equal(bugs().length, 4);
  assert.deepEqual((await state()).groups, []);
});

test('a scan finding is dismissed only with a reason', async () => {
  // Act
  const noReason = await post('/api/zap', as({ ref: FINDING.ref, risk: FINDING.risk, verdict: 'dismissed', reason: '' }));
  const dismissed = await post('/api/zap', as({ ref: FINDING.ref, risk: FINDING.risk, verdict: 'dismissed', reason: 'Bearer tokens only' }));
  const again = await post('/api/zap', as({ ref: FINDING.ref, risk: FINDING.risk, verdict: 'bug', reason: '' }));

  // Assert
  assert.equal(noReason.status, 400);
  assert.equal(dismissed.json.message, 'dismissed');
  assert.equal(again.status, 400, 'already decided');
  assert.deepEqual((await state()).zap, []);
  const saved = JSON.parse(readFileSync(join(repo.root, 'security/zap-findings.json'), 'utf8')).findings;
  assert.deepEqual(saved.map((f: { ref: string; verdict: string; decidedBy: string }) => [f.ref, f.verdict, f.decidedBy]), [['10098', 'dismissed', 'Dan Holman']]);
});

test('saving commits only the review files, with the reviewer, and pushes', async () => {
  // Arrange: an unrelated change already staged must stay out of the commit
  writeFileSync(join(repo.root, 'README.md'), '# Fixture, edited\n');
  repo.git('add', 'README.md');
  assert.deepEqual((await state()).git.changed, ['known-bugs.json', 'triage/decisions.jsonl', 'security/zap-findings.json']);

  // Act
  const noMessage = await post('/api/commit', as({ message: '  ', push: true }));
  const saved = await post('/api/commit', as({ message: 'chore: record review by Dan Holman', push: true }));

  // Assert
  assert.equal(noMessage.status, 400);
  assert.match(saved.json.message ?? '', /^committed [0-9a-f]+ and pushed main$/);
  const files = repo.git('show', '--name-only', '--format=', 'HEAD').split('\n');
  assert.deepEqual(files.sort(), ['known-bugs.json', 'security/zap-findings.json', 'triage/decisions.jsonl']);
  assert.ok(files.every((f) => REVIEW_FILES.includes(f)));
  assert.match(repo.git('log', '-1', '--format=%B'), /chore: record review by Dan Holman\n\nReviewed-by: Dan Holman/);
  assert.equal(repo.git('rev-parse', 'HEAD'), repo.git('--git-dir', repo.remote, 'rev-parse', 'main'), 'the remote has it');
  assert.equal(repo.git('status', '--porcelain', '--', 'README.md'), 'M  README.md', 'the staged README is untouched');
  assert.deepEqual((await state()).git, { branch: 'main', changed: [], unpushed: 0 });
  assert.equal((await post('/api/commit', as({ message: 'm' }))).status, 400, 'nothing left to commit');
});

test('a failed push keeps the commit and can be retried', async () => {
  // Arrange: a change to save, and a remote that can't be reached
  await post('/api/rescore', as({ bugId: 'BUG-004', impact: 3, likelihood: 3, reason: 'two fields can be blank' }));
  repo.git('remote', 'set-url', 'origin', '/nonexistent/remote.git');

  // Act
  const failed = await post('/api/commit', as({ message: 'chore: re-score BUG-004', push: true }));
  const pending = (await state()).git;
  repo.git('remote', 'set-url', 'origin', repo.remote);
  const retried = await post('/api/push', as({}));

  // Assert
  assert.equal(failed.status, 400);
  assert.match(failed.json.error ?? '', /^committed [0-9a-f]+, but not pushed: /);
  assert.deepEqual(pending, { branch: 'main', changed: [], unpushed: 1 });
  assert.equal(retried.json.message, 'pushed main');
  assert.equal((await state()).git.unpushed, 0);
});

test('a push never sends commits that change other files', async () => {
  // Arrange: someone's own unpushed work, then a review change
  writeFileSync(join(repo.root, 'notes.txt'), 'work in progress\n');
  repo.git('add', 'notes.txt');
  repo.git('commit', '-qm', 'wip', '--', 'notes.txt');
  await post('/api/rescore', as({ bugId: 'BUG-004', impact: 2, likelihood: 3, reason: 'back to 6' }));

  // Act
  const held = await post('/api/commit', as({ message: 'chore: re-score', push: true }));
  const retry = await post('/api/push', as({}));

  // Assert
  assert.match(held.json.error ?? '', /^committed [0-9a-f]+, but not pushed: other unpushed commits change notes\.txt; push those yourself$/);
  assert.match(retry.json.error ?? '', /not pushed: other unpushed commits change notes\.txt/);
  assert.notEqual(repo.git('rev-parse', 'HEAD'), repo.git('--git-dir', repo.remote, 'rev-parse', 'main'), 'nothing was pushed');
  assert.equal((await state()).git.unpushed, 2);

  // Clean up: the owner pushes their own work
  repo.git('push', '-q');
});

test('a new branch is pushed with its upstream set; a detached HEAD is refused', async () => {
  // Arrange
  repo.git('checkout', '-qb', 'review/today');
  await post('/api/rescore', as({ bugId: 'BUG-004', impact: 3, likelihood: 3, reason: 'again 9' }));

  // Act
  const pushed = await post('/api/commit', as({ message: 'chore: review on a branch', push: true }));
  repo.git('checkout', '-q', '--detach');
  const s = await state();
  await post('/api/rescore', as({ bugId: 'BUG-004', impact: 2, likelihood: 3, reason: 'detached' }));
  const detached = await post('/api/commit', as({ message: 'm' }));

  // Assert
  assert.match(pushed.json.message ?? '', /^committed [0-9a-f]+ and pushed review\/today$/);
  assert.equal(repo.git('rev-parse', '--abbrev-ref', 'review/today@{upstream}'), 'origin/review/today');
  assert.equal(s.git.branch, undefined);
  assert.match(detached.json.error ?? '', /HEAD is detached/);

  // Clean up
  repo.git('checkout', '-q', '--', 'known-bugs.json');
  repo.git('checkout', '-q', 'main');
});

test('a proposals file that cannot be read is an error, not "no results"', async () => {
  // Arrange
  const path = join(repo.root, 'reports/triage/proposals.json');
  const good = readFileSync(path, 'utf8');
  writeFileSync(path, '{"groups": [');
  try {
    // Act
    const res = await fetch(`${server.url}/api/state`);

    // Assert
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /JSON/);
  } finally {
    writeFileSync(path, good);
  }
});

test('demo mode writes to .demo/ and never commits', async () => {
  // Arrange: a demo run's own proposals and scan summary, as `yarn demo` writes them
  mkdirSync(join(repo.root, '.demo'), { recursive: true });
  copyFileSync(join(repo.root, 'reports/triage/proposals.json'), join(repo.root, '.demo/proposals.json'));
  copyFileSync(join(repo.root, 'reports/zap/summary.json'), join(repo.root, '.demo/summary.json'));
  const demo = await startServer(repo.root, freePort(1000), { DEMO: '1' });
  const committed = readFileSync(join(repo.root, 'triage/decisions.jsonl'), 'utf8');
  const call = async (path: string, body: unknown) =>
    (await fetch(`${demo.url}${path}`, { method: 'POST', headers: { origin: demo.url, 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  try {
    // Act
    const s = await (await fetch(`${demo.url}/api/state`)).json();
    const decided = await call('/api/decide', as({ groupId: 'G-change', verdict: 'reject' }));
    const commit = await call('/api/commit', as({ message: 'm', push: true }));
    const push = await call('/api/push', as({}));

    // Assert
    assert.equal(s.demo, true);
    assert.equal(decided.message, 'rejected: nothing filed');
    assert.match(readFileSync(join(repo.root, '.demo/decisions.jsonl'), 'utf8'), /G-change/);
    assert.equal(readFileSync(join(repo.root, 'triage/decisions.jsonl'), 'utf8'), committed, 'committed decisions untouched');
    assert.match(commit.error, /demo mode/);
    assert.match(push.error, /demo mode/);
  } finally {
    demo.stop();
  }
});
