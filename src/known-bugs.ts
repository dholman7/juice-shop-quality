/**
 * Known-bug registry: product bugs a person approved in review (`yarn review` or `yarn triage:review`), stored in known-bugs.json.
 * Tests that hit one are marked as expected failures, so CI goes red only for new failures or a bug
 * that looks fixed, while the bug stays visible in the report.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { TestInfo } from '@playwright/test';

/** One approved bug. Only the reviews (page or terminal) write these, with the reviewer's name and date. */
export interface KnownBug {
  id: string;
  /** The tracker ticket the bug is reported in, e.g. SHOP-214. */
  jira: string;
  title: string;
  /** Always the band of impact × likelihood; see severityFor. */
  severity: 'critical' | 'high' | 'medium' | 'low';
  /** 1–5: harm to customers, money, or the business, and how many customers one failure reaches. */
  impact: number;
  /** 1–5: how easily it is hit. 5 = a plain request by anyone signed in or out; 1 = unlikely. */
  likelihood: number;
  area: string;
  /** Test keys (see testKey). A trailing `*` matches every test that starts with the prefix. */
  tests: string[];
  /** Catalog endpoint ids the bug was seen on; review uses them to suggest duplicates. */
  endpoints?: string[];
  approvedBy: string;
  approvedOn: string;
  /** Score and severity changes after approval, oldest first. Written by review and `yarn triage:rate`. */
  rerated?: Rerating[];
}

export type Severity = KnownBug['severity'];

/** A Jira key in upper case (`shop-12` → `SHOP-12`), or undefined if it isn't one. */
export function jiraKey(raw: string): string | undefined {
  const key = raw.trim().toUpperCase();
  return /^[A-Z][A-Z0-9]+-[1-9]\d*$/.test(key) ? key : undefined;
}

/** The bug with this id or Jira key, any case. */
export function findBug(bugs: KnownBug[], idOrKey: string): KnownBug | undefined {
  const q = idOrKey.trim().toLowerCase();
  return bugs.find((b) => b.id.toLowerCase() === q || b.jira.toLowerCase() === q);
}

export interface Rerating {
  from: Severity;
  to: Severity;
  /** The scores after the change. */
  impact: number;
  likelihood: number;
  reason: string;
  by: string;
  on: string;
}

/** A whole number from 1 to 5. */
export const isScore = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 5;

/** Risk = impact × likelihood, banded: 20–25 critical, 12–19 high, 6–11 medium, 1–5 low. */
export function severityFor(impact: number, likelihood: number): Severity {
  if (!isScore(impact) || !isScore(likelihood)) throw new Error(`scores must be 1–5, got ${impact} and ${likelihood}`);
  const risk = impact * likelihood;
  return risk >= 20 ? 'critical' : risk >= 12 ? 'high' : risk >= 6 ? 'medium' : 'low';
}

/** Bugs whose severity isn't the band of their scores, or that have no valid scores. Each fails the run until reviewed. */
export function severityMismatches(bugs: KnownBug[]): KnownBug[] {
  return bugs.filter((b) => !isScore(b.impact) || !isScore(b.likelihood) || b.severity !== severityFor(b.impact, b.likelihood));
}

/**
 * A bug with new scores, its severity set to their band, and the change recorded.
 * Refuses invalid scores, a change that changes nothing, and a change without a reason.
 */
export function rescore(bug: KnownBug, impact: number, likelihood: number, reason: string, by: string, on: string): KnownBug {
  const to = severityFor(impact, likelihood);
  if (impact === bug.impact && likelihood === bug.likelihood && to === bug.severity) throw new Error(`${bug.id} is already I${impact} × L${likelihood}, ${to}`);
  if (!reason.trim()) throw new Error('a severity change needs a reason');
  const change: Rerating = { from: bug.severity, to, impact, likelihood, reason: reason.trim(), by, on };
  return { ...bug, impact, likelihood, severity: to, rerated: [...(bug.rerated ?? []), change] };
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
