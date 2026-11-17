/**
 * Known-bug registry: product bugs a person approved in `yarn triage:review`, stored in known-bugs.json.
 * Tests that hit one are marked as expected failures, so CI stays red only for new failures
 * while the bug stays visible in the report.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { TestInfo } from '@playwright/test';

/** One approved bug. Only the review CLI writes these, with the reviewer's name and date. */
export interface KnownBug {
  id: string;
  title: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  area: string;
  /** Test keys (see testKey). A trailing `*` matches every test that starts with the prefix. */
  tests: string[];
  /** Catalog endpoint ids the bug was seen on; review uses them to suggest duplicates. */
  endpoints?: string[];
  approvedBy: string;
  approvedOn: string;
  /** Severity changes after approval, oldest first. Written by `yarn triage:rate`. */
  rerated?: Rerating[];
}

export type Severity = KnownBug['severity'];

export interface Rerating {
  from: Severity;
  to: Severity;
  reason: string;
  by: string;
  on: string;
}

/** A bug with its severity changed and the change recorded. Refuses a no-op or a change without a reason. */
export function rerate(bug: KnownBug, to: Severity, reason: string, by: string, on: string): KnownBug {
  if (to === bug.severity) throw new Error(`${bug.id} is already ${to}`);
  if (!reason.trim()) throw new Error('a severity change needs a reason');
  return { ...bug, severity: to, rerated: [...(bug.rerated ?? []), { from: bug.severity, to, reason: reason.trim(), by, on }] };
}

export const KNOWN_BUGS_PATH = fileURLToPath(new URL('../known-bugs.json', import.meta.url));

export function loadKnownBugs(path = KNOWN_BUGS_PATH): KnownBug[] {
  return JSON.parse(readFileSync(path, 'utf8')).bugs as KnownBug[];
}

/** Stable test key: file under tests/ plus the describe and test titles. */
export const testKey = (titlePath: string[]): string => titlePath.filter(Boolean).join(' › ');

/** The approved bug a test belongs to, if any: exact key match, or prefix match for patterns ending in `*`. */
export function bugFor(key: string, bugs: KnownBug[]): KnownBug | undefined {
  return bugs.find((bug) =>
    bug.tests.some((pattern) => (pattern.endsWith('*') ? key.startsWith(pattern.slice(0, -1)) : key === pattern)),
  );
}

/**
 * Marks a test that hits an approved, open product bug as an expected failure.
 * The assertion stays as written; when the bug is fixed the test passes, Playwright
 * reports "expected to fail but passed", and the registry entry must be removed.
 * This is the alternative to weakening the assertion or skipping the test, which would hide the bug.
 * IGNORE_KNOWN_BUGS=1 turns the registry off, so every product bug shows as a plain failure.
 */
export function applyKnownBug(testInfo: TestInfo, bugs = loadKnownBugs()): void {
  if (process.env.IGNORE_KNOWN_BUGS === '1') return;
  const bug = bugFor(testKey(testInfo.titlePath), bugs);
  if (!bug) return;
  testInfo.annotations.push({ type: 'known-bug', description: `${bug.id}: ${bug.title}` });
  testInfo.fail();
}
