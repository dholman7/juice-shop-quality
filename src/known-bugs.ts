import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { TestInfo } from '@playwright/test';

export interface KnownBug {
  id: string;
  title: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  area: string;
  /** Test keys (see testKey). A trailing `*` matches every test that starts with the prefix. */
  tests: string[];
  approvedBy: string;
  approvedOn: string;
}

export const KNOWN_BUGS_PATH = fileURLToPath(new URL('../known-bugs.json', import.meta.url));

export function loadKnownBugs(path = KNOWN_BUGS_PATH): KnownBug[] {
  return JSON.parse(readFileSync(path, 'utf8')).bugs as KnownBug[];
}

/** Stable test key: file under tests/ plus the describe and test titles. */
export const testKey = (titlePath: string[]): string => titlePath.filter(Boolean).join(' › ');

export function bugFor(key: string, bugs: KnownBug[]): KnownBug | undefined {
  return bugs.find((bug) =>
    bug.tests.some((pattern) => (pattern.endsWith('*') ? key.startsWith(pattern.slice(0, -1)) : key === pattern)),
  );
}

/**
 * Marks a test that hits an approved, open product bug as an expected failure.
 * The assertion stays as written; when the bug is fixed the test passes, Playwright
 * reports "expected to fail but passed", and the registry entry must be removed.
 */
export function applyKnownBug(testInfo: TestInfo, bugs = loadKnownBugs()): void {
  if (process.env.IGNORE_KNOWN_BUGS === '1') return;
  const bug = bugFor(testKey(testInfo.titlePath), bugs);
  if (!bug) return;
  testInfo.annotations.push({ type: 'known-bug', description: `${bug.id}: ${bug.title}` });
  testInfo.fail();
}
