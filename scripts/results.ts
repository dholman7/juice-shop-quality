/** Flattens the Playwright JSON report into one row per test, for the report and coverage map. */
import { readFileSync } from 'node:fs';
import { testKey } from '../src/known-bugs';

export interface Row {
  key: string;
  file: string;
  title: string;
  project: string;
  /** passed | failed | known-bug | flaky | skipped | fixed (expected to fail but passed) */
  result: 'passed' | 'failed' | 'known-bug' | 'flaky' | 'skipped' | 'fixed';
  endpoint?: string;
  role?: string;
  knownBug?: string;
  durationMs: number;
}

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
