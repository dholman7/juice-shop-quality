/** Unit tests for the triage pieces that need no app: redaction, the rules, model-answer validation, grouping. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from './redact';
import { classify } from './heuristic';
import { validate } from './model';
import { groupFailures, signature } from './collect';
import { findCandidates, resource, searchBugs, titleSimilarity } from './duplicates';
import { fileBug } from './review-core';
import { readFileSync } from 'node:fs';
import { resetDemo, statePath } from '../src/review-state';
import { findBug, isScore, jiraKey, loadKnownBugs, rescore, severityFor, severityMismatches, type KnownBug } from '../src/known-bugs';
import type { Failure, FailureGroup } from './types';

const failure = (over: Partial<Failure> = {}): Failure => ({
  key: 'api/x.spec.ts › suite › refuses customer',
  title: 'refuses customer',
  file: 'api/x.spec.ts',
  outcome: 'unexpected',
  endpoint: 'basket.get',
  role: 'customer',
  error: 'Error: GET /rest/basket/:id as customer returned 200\nexpect(received).toContain(expected)',
  retries: 0,
  ...over,
});
const group = (...failures: Failure[]): FailureGroup => ({ id: 'G-1', signature: 's', failures });

test('redact removes tokens, emails, hashes, and card numbers', () => {
  // Arrange
  const raw = 'Bearer eyJhbGc.eyJkYXRh.sig qa.1@test.local 8a9f378cd4ae73dc7cc4432d0f4b0119 4111111111111111 "password":"x"';

  // Act
  const out = redact(raw);

  // Assert
  for (const secret of ['eyJ', 'qa.1@test.local', '8a9f378cd4', '4111111111111111', '"password":"x"']) {
    assert.ok(!out.includes(secret), `${secret} leaked: ${out}`);
  }
});

test('a status mismatch from the product is proposed as a product bug', () => {
  assert.equal(classify(group(failure())).category, 'product-bug');
});

test('a selector problem is proposed as a test bug', () => {
  const f = failure({ error: "Error: locator.click: Error: strict mode violation: getByText('x') resolved to 2 elements" });
  assert.equal(classify(group(f)).category, 'test-bug');
});

test('a 502 in a file path or line number is not an environment problem', () => {
  // Arrange: an assertion failure whose stack path and code frame contain 502
  const f = failure({ error: [
    'Error: GET /rest/basket/:id as customer returned 200',
    '  502 |   expect(res.status()).toBe(403);',
    '    at refused (/tmp/claude-502/repo/tests/api/isolation.spec.ts:502:99)',
  ].join('\n') });

  // Act / Assert
  assert.notEqual(classify(group(f)).category, 'environment');
});

test('a 503 from the app is still an environment problem', () => {
  const f = failure({ error: 'Error: GET /rest/products returned 503\n    at probe (/repo/src/probes.ts:12:3)' });
  assert.equal(classify(group(f)).category, 'environment');
});

test('a refused connection is proposed as an environment problem', () => {
  const f = failure({ error: 'Error: apiRequestContext.get: connect ECONNREFUSED 127.0.0.1:3000' });
  assert.equal(classify(group(f)).category, 'environment');
});

test('a pass on retry is proposed as flaky', () => {
  assert.equal(classify(group(failure({ outcome: 'flaky' }))).category, 'flaky');
});

test('a timeout is left to a person', () => {
  const f = failure({ error: 'Test timeout of 30000ms exceeded.' });
  assert.equal(classify(group(f)).category, 'needs-human');
});

test('model evidence that is not a quote is downgraded to needs-human', () => {
  // Act
  const p = validate(group(failure()), { category: 'product-bug', confidence: 'high', evidence: 'the server crashed with a null pointer', reasoning: 'x' });

  // Assert
  assert.equal(p.category, 'needs-human');
  assert.match(p.downgradedBecause ?? '', /not a quote/);
});

test('model reasoning left as a placeholder is downgraded to needs-human', () => {
  // Arrange: the exact reasoning the model returned on the first real run
  const reasoning = 'Placeholder; to be replaced after reading the test source.';

  // Act
  const p = validate(group(failure()), { category: 'product-bug', confidence: 'high', evidence: 'as customer returned 200', reasoning });

  // Assert
  assert.equal(p.category, 'needs-human');
  assert.match(p.downgradedBecause ?? '', /unfinished/);
});

test('model evidence that is a quote is kept', () => {
  const p = validate(group(failure()), { category: 'product-bug', confidence: 'high', evidence: 'as customer returned 200', reasoning: 'The product returned 200 where the policy refuses customers.' });
  assert.equal(p.category, 'product-bug');
  assert.equal(p.source, 'model');
});

test('the model cannot call a failure flaky unless a retry passed', () => {
  const p = validate(group(failure()), { category: 'flaky', confidence: 'high', evidence: 'as customer returned 200', reasoning: 'x' });
  assert.equal(p.category, 'needs-human');
});

test('the same defect seen by several roles forms one group', () => {
  // Arrange
  const roles = ['customer', 'deluxe', 'admin'].map((role) =>
    failure({ role, title: `refuses ${role}`, error: `Error: GET /rest/basket/:id as ${role} returned 200` }),
  );

  // Act
  const groups = groupFailures(roles);

  // Assert
  assert.equal(groups.length, 1);
  assert.equal(groups[0].failures.length, 3);
  assert.equal(signature(roles[0]), signature(roles[2]));
});

test('a role-matrix bug title names who got through and the rule', () => {
  // Arrange
  const roles = ['customer', 'deluxe'].map((role) =>
    failure({ file: 'api/access-matrix.spec.ts', endpoint: 'basketItems.list', role, title: `refuses ${role}`, error: `Error: GET /api/BasketItems as ${role} returned 200` }),
  );

  // Act
  const title = classify(group(...roles)).suggestedTitle;

  // Assert
  assert.equal(title, 'customer, deluxe can call GET /api/BasketItems (only admin should)');
});

test('a server error is titled as a failure, not as access granted', () => {
  const f = failure({ file: 'api/access-matrix.spec.ts', endpoint: 'basketItems.list', role: 'anonymous', title: 'refuses anonymous', error: 'Error: GET /api/BasketItems as anonymous returned 500' });
  assert.equal(classify(group(f)).suggestedTitle, 'GET /api/BasketItems fails with 500 for anonymous instead of refusing');
});

test('a behavior bug title states the requirement from the test title', () => {
  const f = failure({ key: 'api/checkout.spec.ts › R2 checkout › refuses to check out an empty basket', error: 'Expected: 400\nReceived: 200' });
  assert.equal(classify(group(f)).suggestedTitle, 'Not met: R2 checkout › refuses to check out an empty basket');
});

const MATRIX_KEY = 'api/access-matrix.spec.ts › R1 Customer data isolation › GET /rest/basket/:id › refuses customer';
const bug = (over: Partial<KnownBug> = {}): KnownBug => ({
  id: 'BUG-001',
  jira: 'SHOP-214',
  title: 'Any signed-in user can read any basket by id',
  severity: 'critical',
  impact: 5,
  likelihood: 5,
  area: 'R1',
  tests: [MATRIX_KEY],
  endpoints: ['basket.get'],
  approvedBy: 'Reviewer',
  approvedOn: '2026-11-17',
  ...over,
});
const isolation = (over: Partial<Failure> = {}) => failure({ file: 'api/isolation.spec.ts', ...over });

test('an open access bug on the same endpoint is suggested for a new access failure, with the reason', () => {
  // Arrange: an isolation failure on the endpoint a role-matrix bug was filed on
  const g = group(isolation({ endpoint: 'basket.get' }));

  // Act
  const [first] = findCandidates(g, 'Not met: R1 isolation › GET /rest/basket/:id on another customer\'s record', [bug()]);

  // Assert
  assert.equal(first.bug.id, 'BUG-001');
  assert.match(first.reasons[0], /same endpoint, both access checks: GET \/rest\/basket\/:id/);
});

test('two behavior rules on one endpoint are not suggested as the same defect', () => {
  // Arrange: "no address" and "empty basket" both fail on checkout, but are separate rules
  const empty = bug({ title: 'Not met: R2 checkout › refuses to check out an empty basket', tests: ['api/checkout.spec.ts › R2 checkout › refuses to check out an empty basket'], endpoints: ['basket.checkout'] });
  const g = group(failure({ file: 'api/checkout.spec.ts', endpoint: 'basket.checkout' }));

  // Act
  const found = findCandidates(g, 'Not met: R2 checkout › refuses an order without a delivery address and payment method', [empty]);

  // Assert
  assert.equal(found.length, 0);
});

test('one shared word is not a similar title', () => {
  assert.equal(titleSimilarity('reads another basket', 'basket quantity of zero'), 0);
});

test('access failures on the same record type are suggested', () => {
  const g = group(isolation({ endpoint: 'basket.coupon' }));
  const [first] = findCandidates(g, 'Not met: coupon applied to someone else', [bug()]);
  assert.match(first.reasons[0], /same records, both access checks: \/rest\/basket/);
});

test('behavior failures on the same record type are not suggested', () => {
  const g = group(failure({ file: 'api/checkout.spec.ts', endpoint: 'basket.coupon' }));
  assert.equal(findCandidates(g, 'Not met: coupon applied to someone else', [bug()]).length, 0);
});

test('the same rule on another endpoint is suggested by title', () => {
  // Arrange: quantity 0 was filed on update; quantity -1 fails on create
  const zero = bug({ title: 'Not met: R1 basket › rejects a quantity of 0', tests: ['api/customer-data.spec.ts › R1 basket › rejects a quantity of 0'], endpoints: ['basketItems.update'] });
  const g = group(failure({ file: 'api/customer-data.spec.ts', endpoint: 'basketItems.create' }));

  // Act
  const found = findCandidates(g, 'Not met: R1 basket › rejects a negative basket quantity', [zero]);

  // Assert
  assert.equal(found.length, 1);
  assert.match(found[0].reasons[0], /similar title/);
});

test('an unrelated bug is not suggested', () => {
  const g = group(failure({ endpoint: 'auth.login' }));
  assert.equal(findCandidates(g, 'Not met: login refuses SQL injection', [bug()]).length, 0);
});

test('a bug filed without endpoints can still match by title', () => {
  const g = group(isolation({ endpoint: 'basket.get' }));
  const found = findCandidates(g, 'Signed-in users read any basket by id', [bug({ endpoints: undefined })]);
  assert.equal(found.length, 1);
});

test('at most three suggestions, strongest first', () => {
  // Arrange: four bugs on the same endpoint, one also with a similar title
  const bugs = ['BUG-001', 'BUG-002', 'BUG-003', 'BUG-004'].map((id, n) => bug({ id, title: n === 3 ? 'Users read any basket' : `unrelated ${id}` }));

  // Act
  const found = findCandidates(group(isolation({ endpoint: 'basket.get' })), 'Users can read any basket by id', bugs);

  // Assert
  assert.equal(found.length, 3);
  assert.equal(found[0].bug.id, 'BUG-004');
  assert.ok(found.every((c, i) => i === 0 || c.score <= found[i - 1].score));
});

test('a record type stops at the first id, or is the whole path without one', () => {
  assert.equal(resource('/rest/basket/:id/checkout'), '/rest/basket');
  assert.equal(resource('/api/BasketItems'), '/api/basketitems');
  assert.notEqual(resource('/rest/user/change-password'), resource('/rest/user/authentication-details'));
});

test('severity is the band of impact × likelihood, at every boundary', () => {
  // Arrange: [impact, likelihood, severity]. No two scores multiply to 11 or 19, so the reachable edges are 5|6, 10|12, 16|20.
  const cases: [number, number, KnownBug['severity']][] = [
    [1, 1, 'low'], [1, 5, 'low'], [2, 3, 'medium'], [2, 5, 'medium'],
    [3, 4, 'high'], [4, 4, 'high'], [4, 5, 'critical'], [5, 5, 'critical'],
  ];

  // Act / Assert
  for (const [i, l, sev] of cases) assert.equal(severityFor(i, l), sev, `I${i} × L${l}`);
});

test('a score is a whole number from 1 to 5; anything else is refused', () => {
  for (const n of [1, 3, 5]) assert.ok(isScore(n), String(n));
  for (const n of [0, 6, -1, 2.5, Number.NaN, '3', undefined, null]) assert.ok(!isScore(n), String(n));
  assert.throws(() => severityFor(0, 5), /1–5/);
  assert.throws(() => severityFor(3, 6), /1–5/);
});

test('a bug whose severity is not its score band, or has no scores, is a mismatch', () => {
  // Arrange
  const bugs = [
    bug({ id: 'OK', impact: 4, likelihood: 3, severity: 'high' }),
    bug({ id: 'WRONG', impact: 5, likelihood: 5, severity: 'high' }),
    bug({ id: 'UNSCORED', impact: undefined as unknown as number, likelihood: undefined as unknown as number, severity: 'high' }),
  ];

  // Act
  const ids = severityMismatches(bugs).map((b) => b.id);

  // Assert
  assert.deepEqual(ids, ['WRONG', 'UNSCORED']);
});

test('re-scoring sets the severity from the new scores and records the change', () => {
  // Act
  const out = rescore(bug({ severity: 'high', impact: 4, likelihood: 3 }), 5, 5, 'every customer\'s record', 'Reviewer', '2026-11-17');

  // Assert
  assert.equal(out.severity, 'critical');
  assert.deepEqual([out.impact, out.likelihood], [5, 5]);
  assert.deepEqual(out.rerated, [{ from: 'high', to: 'critical', impact: 5, likelihood: 5, reason: 'every customer\'s record', by: 'Reviewer', on: '2026-11-17' }]);
});

test('re-scoring to the same scores fixes a mismatched severity', () => {
  const out = rescore(bug({ severity: 'high', impact: 5, likelihood: 5 }), 5, 5, 'matches I5 × L5 = 25', 'A', 'd');
  assert.equal(out.severity, 'critical');
  assert.deepEqual(severityMismatches([out]), []);
});

test('a second re-scoring keeps the first in the history', () => {
  const once = rescore(bug({ severity: 'high', impact: 4, likelihood: 3 }), 5, 5, 'first', 'A', '2026-11-17');
  assert.deepEqual(rescore(once, 2, 3, 'second', 'B', '2026-11-18').rerated?.map((r) => `${r.from}→${r.to}`), ['high→critical', 'critical→medium']);
});

test('re-scoring refuses no change, a blank reason, and invalid scores', () => {
  const b = bug({ severity: 'high', impact: 4, likelihood: 3 });
  assert.throws(() => rescore(b, 4, 3, 'same', 'A', 'd'), /already I4 × L3, high/);
  assert.throws(() => rescore(b, 5, 5, '   ', 'A', 'd'), /needs a reason/);
  assert.throws(() => rescore(b, 6, 5, 'too high', 'A', 'd'), /1–5/);
});

test('title search finds open bugs containing every word typed, in any case', () => {
  // Arrange
  const bugs = [
    bug({ id: 'BUG-008', title: 'The password hash is in the session token and in API responses' }),
    bug({ id: 'BUG-009', title: 'Password change does not check the current password' }),
  ];

  // Act
  const byOne = searchBugs('HASH', bugs).map((b) => b.id);
  const byTwo = searchBugs('password  current', bugs).map((b) => b.id);
  const byNone = searchBugs('coupon', bugs);

  // Assert
  assert.deepEqual(byOne, ['BUG-008']);
  assert.deepEqual(byTwo, ['BUG-009']);
  assert.deepEqual(byNone, []);
});

test('a Jira key is read in upper case; anything else is refused', () => {
  // Arrange
  const valid = { 'SHOP-240': 'SHOP-240', 'shop-12': 'SHOP-12', '  QA2-7 ': 'QA2-7' };
  const invalid = ['', '   ', 'SHOP', 'SHOP-', 'SHOP-0', '240', 'S-1', 'SHOP 240', 'SHOP-12a', 'BUG_008'];

  // Act / Assert
  for (const [raw, key] of Object.entries(valid)) assert.equal(jiraKey(raw), key, raw);
  for (const raw of invalid) assert.equal(jiraKey(raw), undefined, raw);
});

test('a bug is found by its id or its Jira key, in any case', () => {
  // Arrange
  const bugs = [bug({ id: 'BUG-008', jira: 'SHOP-221' }), bug({ id: 'BUG-009', jira: 'SHOP-222' })];

  // Act / Assert
  assert.equal(findBug(bugs, 'bug-008')?.id, 'BUG-008');
  assert.equal(findBug(bugs, ' shop-222 ')?.id, 'BUG-009');
  assert.equal(findBug(bugs, 'SHOP-999'), undefined);
  assert.equal(findBug(bugs, ''), undefined);
});

test('title search also matches the Jira key', () => {
  const bugs = [bug({ id: 'BUG-008', jira: 'SHOP-221' }), bug({ id: 'BUG-009', jira: 'SHOP-222' })];
  assert.deepEqual(searchBugs('shop-221', bugs).map((b) => b.id), ['BUG-008']);
});

test('every approved bug has its own valid Jira key and valid scores', () => {
  // Arrange
  const bugs = loadKnownBugs();

  // Act
  const keys = bugs.map((b) => b.jira);

  // Assert
  for (const b of bugs) assert.ok(typeof b.jira === 'string' && jiraKey(b.jira) === b.jira, `${b.id} has no valid Jira key`);
  for (const b of bugs) assert.ok(isScore(b.impact) && isScore(b.likelihood), `${b.id} has no valid impact and likelihood`);
  assert.equal(new Set(keys).size, keys.length, 'two bugs share a Jira key');
});

test('filing to an open bug by id or Jira key adds the group\'s tests and endpoints', () => {
  // Arrange
  const bugs = [bug({ id: 'BUG-008', jira: 'SHOP-221', tests: ['old'], endpoints: ['auth.login'] })];
  const g = group(failure({ key: 'new test', endpoint: 'password.change' }));

  // Act
  const byId = fileBug(bugs, g, { existing: 'bug-008' }, 'A', '2026-11-17');
  const byKey = fileBug(bugs, g, { existing: 'SHOP-221' }, 'A', '2026-11-17');

  // Assert
  for (const out of [byId, byKey]) {
    assert.equal(out.bugId, 'BUG-008');
    assert.equal(out.created, undefined);
    assert.deepEqual(out.bugs[0].tests, ['old', 'new test']);
    assert.deepEqual(out.bugs[0].endpoints, ['auth.login', 'password.change']);
  }
  assert.deepEqual(bugs[0].tests, ['old'], 'the input list is not changed');
});

test('a new bug gets the next id, its Jira key, and the severity of its scores', () => {
  // Act
  const out = fileBug([bug({ id: 'BUG-026', jira: 'SHOP-239' })], group(failure({ key: 'api/x.spec.ts › R2 checkout › t' })),
    { jira: ' shop-240 ', title: ' Coupon applies twice ', impact: 3, likelihood: 4 }, 'Dan', '2026-11-17');

  // Assert
  assert.equal(out.bugId, 'BUG-027');
  assert.deepEqual(
    { jira: out.created?.jira, title: out.created?.title, severity: out.created?.severity, area: out.created?.area, by: out.created?.approvedBy },
    { jira: 'SHOP-240', title: 'Coupon applies twice', severity: 'high', area: 'R2', by: 'Dan' },
  );
});

test('a new bug whose Jira key is already on file joins that bug', () => {
  const out = fileBug([bug({ id: 'BUG-008', jira: 'SHOP-221' })], group(failure()), { jira: 'shop-221', title: 't', impact: 1, likelihood: 1 }, 'A', 'd');
  assert.equal(out.bugId, 'BUG-008');
  assert.equal(out.created, undefined);
});

test('filing refuses an unknown bug, a bad Jira key, a blank title, and bad scores', () => {
  const bugs = [bug()];
  const g = group(failure());
  const newBug = { jira: 'SHOP-300', title: 'ok', impact: 3, likelihood: 3 };
  assert.throws(() => fileBug(bugs, g, { existing: 'BUG-999' }, 'A', 'd'), /no open bug/);
  assert.throws(() => fileBug(bugs, g, { ...newBug, jira: 'JIRA' }, 'A', 'd'), /not a Jira key/);
  assert.throws(() => fileBug(bugs, g, { ...newBug, title: '  ' }, 'A', 'd'), /needs a title/);
  for (const [impact, likelihood] of [[0, 3], [3, 6], [2.5, 3], [Number.NaN, 3]]) {
    assert.throws(() => fileBug(bugs, g, { ...newBug, impact, likelihood }, 'A', 'd'), /1 to 5/, `${impact}, ${likelihood}`);
  }
});

test('review state is the committed files, or empty copies in .demo/ with DEMO=1', () => {
  // Arrange
  const before = process.env.DEMO;
  const committedBugs = loadKnownBugs().length;
  try {
    // Act
    delete process.env.DEMO;
    const committed = statePath('knownBugs');
    process.env.DEMO = '1';
    resetDemo();
    const demo = { bugs: statePath('knownBugs'), decisions: statePath('decisions'), zap: statePath('zapFindings') };

    // Assert
    assert.match(committed, /\/known-bugs\.json$/);
    assert.doesNotMatch(committed, /\.demo/);
    assert.match(demo.bugs, /\/\.demo\/known-bugs\.json$/);
    assert.deepEqual(loadKnownBugs(), [], 'demo starts with no bugs');
    assert.equal(readFileSync(demo.decisions, 'utf8'), '');
    assert.deepEqual(JSON.parse(readFileSync(demo.zap, 'utf8')), { findings: [] });
  } finally {
    resetDemo();
    if (before === undefined) delete process.env.DEMO;
    else process.env.DEMO = before;
  }
  assert.equal(loadKnownBugs().length, committedBugs, 'the committed registry is untouched');
});
