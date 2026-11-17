/** Unit tests for run history: ordering, de-duplication, the size cap, and recovery from a bad file. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHistory, recordRun, type RunSummary } from './history';

const run = (at: string, durationS = 60): RunSummary => ({
  at,
  source: 'ci',
  durationS,
  tests: 1,
  passed: 1,
  newFailures: 0,
  openBugs: 0,
  flaky: 0,
  fixed: 0,
  skipped: 0,
  nonProductFailures: 0,
  endpoints: { total: 1, everyRole: 1, checks: 5, checksRun: 5 },
  bugsBySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
  triage: { decided: 0, acceptedUnchanged: 0 },
});
const tempFile = () => join(mkdtempSync(join(tmpdir(), 'history-')), 'history.json');

test('a run is added in time order', () => {
  // Arrange
  const path = tempFile();
  recordRun(run('2026-11-02T00:00:00Z'), path);

  // Act
  const history = recordRun(run('2026-11-01T00:00:00Z'), path);

  // Assert
  assert.deepEqual(history.map((r) => r.at), ['2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z']);
  assert.deepEqual(readHistory(path), history);
});

test('recording the same run twice keeps the latest copy only', () => {
  const path = tempFile();
  recordRun(run('2026-11-01T00:00:00Z', 60), path);
  const history = recordRun(run('2026-11-01T00:00:00Z', 45), path);
  assert.equal(history.length, 1);
  assert.equal(history[0].durationS, 45);
});

test('only the newest runs are kept', () => {
  const path = tempFile();
  for (const day of ['01', '02', '03']) recordRun(run(`2026-11-${day}T00:00:00Z`), path, 2);
  assert.deepEqual(readHistory(path).map((r) => r.at), ['2026-11-02T00:00:00Z', '2026-11-03T00:00:00Z']);
});

test('a missing or corrupt history file starts a new history', () => {
  const path = tempFile();
  assert.deepEqual(readHistory(path), []);
  writeFileSync(path, '<html>404</html>');
  assert.deepEqual(readHistory(path), []);
});
