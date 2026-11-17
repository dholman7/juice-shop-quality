/**
 * Steps 1–2 of triage: read the failures from the Playwright JSON report (redacted), then group
 * the ones that share a cause, so a reviewer makes one decision per defect instead of per test.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { testKey } from '../src/known-bugs';
import { redact } from './redact';
import type { Failure, FailureGroup } from './types';

/** The parts of Playwright's JSON reporter output triage reads. */
interface JsonSuite {
  title: string;
  file?: string;
  suites?: JsonSuite[];
  specs?: { title: string; file: string; tests: JsonTest[] }[];
}
interface JsonTest {
  status: 'expected' | 'unexpected' | 'flaky' | 'skipped';
  annotations: { type: string; description?: string }[];
  results: { status: string; error?: { message?: string; stack?: string } }[];
}

// Terminal color codes in Playwright's error text.
const ANSI = /\x1b\[[0-9;]*m/g;

/** Unexpected failures and flaky passes. Known-bug expected failures are excluded: they are already decided. */
export function collectFailures(reportPath = 'reports/results.json'): Failure[] {
  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as { suites: JsonSuite[] };
  const out: Failure[] = [];
  const walk = (suite: JsonSuite, path: string[]) => {
    for (const child of suite.suites ?? []) walk(child, [...path, child.title]);
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests) {
        if (t.status !== 'unexpected' && t.status !== 'flaky') continue;
        // For a flaky test, the failed attempt holds the error, not the passing retry.
        const failed = t.results.find((r) => r.status !== 'passed' && r.status !== 'skipped') ?? t.results[0];
        const message = (failed.error?.message ?? failed.status).replace(ANSI, '');
        // The first stack line in our own code: which test line failed.
        const frame = (failed.error?.stack ?? '').replace(ANSI, '').split('\n').find((l) => l.includes('.ts:')) ?? '';
        out.push({
          key: testKey([...path, spec.title]),
          title: spec.title,
          file: spec.file,
          outcome: t.status,
          endpoint: t.annotations.find((a) => a.type === 'endpoint')?.description,
          role: t.annotations.find((a) => a.type === 'role')?.description,
          // First 12 message lines plus that frame, redacted and capped: enough to decide, small enough for a prompt.
          error: redact(`${message.split('\n').slice(0, 12).join('\n')}\n${frame.trim()}`).slice(0, 2000),
          retries: t.results.length - 1,
        });
      }
    }
  };
  for (const suite of report.suites) walk(suite, [suite.title]);
  return out;
}

/** First error line with ids, numbers, and roles removed, so the same defect seen by five roles groups once. */
export function signature(f: Failure): string {
  const first = f.error.split('\n').find((l) => l.trim()) ?? '';
  return first
    .replace(/\bas (anonymous|customer|deluxe|accounting|admin)\b/g, 'as <role>')
    .replace(/\/\d+/g, '/<id>')
    .replace(/\b\d+(\.\d+)?\b/g, '<n>')
    .trim();
}

/**
 * Groups by outcome, endpoint (or file), title with the role removed, and error signature.
 * The id is a hash of that key, so the same defect gets the same id on every run and a
 * reviewer's past decision still applies.
 */
export function groupFailures(failures: Failure[]): FailureGroup[] {
  const groups = new Map<string, FailureGroup>();
  for (const f of failures) {
    const sig = `${f.outcome} | ${f.endpoint ?? f.file} | ${f.title.replace(/\b(anonymous|customer|deluxe|accounting|admin)\b/g, '<role>')} | ${signature(f)}`;
    const id = `G-${createHash('sha1').update(sig).digest('hex').slice(0, 8)}`;
    const group = groups.get(id) ?? { id, signature: sig, failures: [] };
    group.failures.push(f);
    groups.set(id, group);
  }
  return [...groups.values()];
}
