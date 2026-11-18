/**
 * Unit tests for the demo seed: it starts from the committed review, undoes only PLAN, and stays in .demo/.
 * They run on a temporary copy of the committed review files, so a real `.demo/` is never touched.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLAN, seedDemo } from './demo-seed';
import { loadKnownBugs, severityMismatches } from '../src/known-bugs';
import { committedPath, resetDemo, statePath } from '../src/review-state';

const REPO = fileURLToPath(new URL('..', import.meta.url));
let tmp: string;
before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'demo-seed-'));
  for (const file of ['known-bugs.json', 'triage/decisions.jsonl', 'security/zap-findings.json']) cpSync(join(REPO, file), join(tmp, file));
  process.env.REVIEW_ROOT = tmp;
});
after(() => {
  delete process.env.REVIEW_ROOT;
  rmSync(tmp, { recursive: true, force: true });
});

const committedBugs = () => loadKnownBugs(committedPath('knownBugs'));
const lines = (path: string) => readFileSync(path, 'utf8').split('\n').filter(Boolean);

test('every test and group the plan undoes is in the committed review', () => {
  // Arrange
  const tests = new Set(committedBugs().flatMap((b) => b.tests));
  const groups = new Set(lines(committedPath('decisions')).map((l) => JSON.parse(l).groupId));

  // Act / Assert: a renamed test or a re-review would otherwise leave the demo with stray failures
  for (const g of PLAN.groups) {
    assert.ok(groups.has(g.id), `${g.id} is not decided in the committed review`);
    for (const t of g.tests) assert.ok(tests.has(t), `${t} is not registered to a bug`);
  }
  for (const id of PLAN.undoRescore) assert.ok(committedBugs().find((b) => b.id === id)?.rerated?.length, `${id} has no re-score to undo`);
});

test('the seed undoes only the plan, and leaves the committed files alone', () => {
  // Arrange
  const before = process.env.DEMO;
  const committed = { bugs: readFileSync(committedPath('knownBugs'), 'utf8'), decisions: readFileSync(committedPath('decisions'), 'utf8') };
  process.env.DEMO = '1';
  try {
    // Act
    seedDemo();
    const bugs = loadKnownBugs();
    const decisions = lines(statePath('decisions'));
    const zap = JSON.parse(readFileSync(statePath('zapFindings'), 'utf8')).findings;

    // Assert
    const undone = new Set<string>(PLAN.groups.flatMap((g) => g.tests));
    assert.ok(bugs.every((b) => b.tests.every((t) => !undone.has(t))), 'no undone test is still registered');
    assert.equal(bugs.find((b) => b.id === 'BUG-020'), undefined, 'a bug left with no tests is removed');
    assert.equal(bugs.length, committedBugs().length - 1);
    assert.equal(decisions.length, lines(committedPath('decisions')).length - PLAN.groups.length);
    assert.deepEqual(severityMismatches(bugs).map((b) => b.id), [...PLAN.undoRescore]);
    assert.ok(zap.every((f: { ref: string }) => !(PLAN.zapRefs as readonly string[]).includes(f.ref)));
    assert.ok(JSON.parse(readFileSync(statePath('history'), 'utf8')).length > 1, 'run history is seeded');
    assert.equal(readFileSync(committedPath('knownBugs'), 'utf8'), committed.bugs);
    assert.equal(readFileSync(committedPath('decisions'), 'utf8'), committed.decisions);
  } finally {
    resetDemo();
    if (before === undefined) delete process.env.DEMO;
    else process.env.DEMO = before;
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
    assert.ok(demo.bugs.startsWith(tmp), 'demo state is in the temporary checkout, never the real one');
    assert.match(demo.bugs, /\/\.demo\/known-bugs\.json$/);
    assert.deepEqual(loadKnownBugs(), [], 'an unseeded demo starts with no bugs');
    assert.equal(readFileSync(demo.decisions, 'utf8'), '');
    assert.deepEqual(JSON.parse(readFileSync(demo.zap, 'utf8')), { findings: [] });
  } finally {
    resetDemo();
    if (before === undefined) delete process.env.DEMO;
    else process.env.DEMO = before;
  }
  assert.equal(loadKnownBugs().length, committedBugs, 'the committed registry is untouched');
});
