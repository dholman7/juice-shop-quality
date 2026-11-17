/** Flattens the Playwright JSON report into one row per test. The report, coverage map, and run history read these rows; triage reads the JSON itself (triage/collect.ts). */
import { readFileSync } from 'node:fs';
import { testKey } from '../src/known-bugs';

export interface Row {
  /** Same format as known-bugs.json entries, so a row can be matched to its bug. */
  key: string;
  file: string;
  title: string;
  project: string;
  /** passed | failed | known-bug | flaky | skipped | fixed (expected to fail but passed) */
  result: 'passed' | 'failed' | 'known-bug' | 'flaky' | 'skipped' | 'fixed';
  /** From the test's covers() annotations; empty for tests that aren't tied to one endpoint. */
  endpoint?: string;
  role?: string;
  knownBug?: string;
  /** Includes the retry, if there was one. */
  durationMs: number;
}

/** The parts of Playwright's JSON reporter output this file reads. */
interface Suite {
  title: string;
  suites?: Suite[];
  specs?: { title: string; file: string; tests: { projectName: string; status: string; expectedStatus: string; annotations: { type: string; description?: string }[]; results: { duration: number }[] }[] }[];
}

export function readRows(path = 'reports/results.json'): { rows: Row[]; stats: { startTime: string; duration: number } } {
  const report = JSON.parse(readFileSync(path, 'utf8')) as { suites: Suite[]; stats: { startTime: string; duration: number } };
  const rows: Row[] = [];
  const walk = (suite: Suite, path: string[]) => {
    for (const child of suite.suites ?? []) walk(child, [...path, child.title]);
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests) {
        const note = (type: string) => t.annotations.find((a) => a.type === type)?.description;
        const knownBug = note('known-bug');
        // Playwright's status is relative to the expectation: a known bug marked with testInfo.fail()
        // that fails is "expected", and one that passes is "unexpected". Map both back to plain results.
        let result: Row['result'];
        if (t.status === 'skipped') result = 'skipped';
        else if (t.status === 'flaky') result = 'flaky';
        else if (t.status === 'expected') result = t.expectedStatus === 'failed' ? 'known-bug' : 'passed';
        else result = t.expectedStatus === 'failed' ? 'fixed' : 'failed';
        rows.push({
          key: testKey([...path, spec.title]),
          file: spec.file,
          title: spec.title,
          project: t.projectName,
          result,
          endpoint: note('endpoint'),
          role: note('role'),
          knownBug,
          durationMs: t.results.reduce((n, r) => n + r.duration, 0),
        });
      }
    }
  };
  for (const s of report.suites) walk(s, [s.title]);
  return { rows, stats: report.stats };
}
