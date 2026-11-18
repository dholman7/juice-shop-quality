/**
 * Where the review state lives: the committed files, or with DEMO=1 copies in `.demo/` (git-ignored).
 * Demo mode lets anyone run and review without touching the committed review; `yarn demo` seeds it.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));

/** The checkout the review reads and writes. REVIEW_ROOT points it elsewhere (tests); read on each call. */
export const root = (): string => process.env.REVIEW_ROOT ?? REPO;
export const demoDir = (): string => join(root(), '.demo');

// Path in the checkout, and what an empty one holds (null: absent means "no run yet", so never created).
const FILES = {
  knownBugs: ['known-bugs.json', '{\n  "bugs": []\n}\n'],
  decisions: ['triage/decisions.jsonl', ''],
  zapFindings: ['security/zap-findings.json', '{\n  "findings": []\n}\n'],
  // Not committed: CI carries it between runs. Demo mode keeps its own.
  history: ['reports/history.json', '[]\n'],
  // Per run, not committed. Demo mode keeps its own, so a real run doesn't change what the demo shows.
  proposals: ['reports/triage/proposals.json', null],
  zapSummary: ['reports/zap/summary.json', null],
} as const;

export type StateFile = keyof typeof FILES;

export const isDemo = (): boolean => process.env.DEMO === '1';

/** The non-demo path of a state file, whatever the mode. */
export const committedPath = (name: StateFile): string => join(root(), FILES[name][0]);

/** Absolute path of one state file; in demo mode, created empty on first use where it has an empty form. */
export function statePath(name: StateFile): string {
  const [committed, empty] = FILES[name];
  if (!isDemo()) return committedPath(name);
  const path = join(demoDir(), committed.split('/').pop() ?? committed);
  if (empty !== null && !existsSync(path)) {
    mkdirSync(demoDir(), { recursive: true });
    writeFileSync(path, empty);
  }
  return path;
}

/** Removes the demo state. */
export function resetDemo(): void {
  rmSync(demoDir(), { recursive: true, force: true });
}
