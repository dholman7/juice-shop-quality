/**
 * Where the review state lives: the committed files, or with DEMO=1 copies in `.demo/` (git-ignored).
 * Demo mode lets anyone run and review without touching the committed review; `yarn demo` seeds it.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const DEMO_DIR = `${ROOT}.demo`;

// Committed path, and what an empty one holds.
const FILES = {
  knownBugs: ['known-bugs.json', '{\n  "bugs": []\n}\n'],
  decisions: ['triage/decisions.jsonl', ''],
  zapFindings: ['security/zap-findings.json', '{\n  "findings": []\n}\n'],
  // Not committed: CI carries it between runs. Demo mode keeps its own.
  history: ['reports/history.json', '[]\n'],
} as const;

export type StateFile = keyof typeof FILES;

export const isDemo = (): boolean => process.env.DEMO === '1';

/** The non-demo path of a state file, whatever the mode. */
export const committedPath = (name: StateFile): string => `${ROOT}${FILES[name][0]}`;

/** Absolute path of one state file; in demo mode, created empty on first use. */
export function statePath(name: StateFile): string {
  const [committed, empty] = FILES[name];
  if (!isDemo()) return committedPath(name);
  const path = `${DEMO_DIR}/${committed.split('/').pop()}`;
  if (!existsSync(path)) {
    mkdirSync(DEMO_DIR, { recursive: true });
    writeFileSync(path, empty);
  }
  return path;
}

/** Removes the demo state. */
export function resetDemo(): void {
  rmSync(DEMO_DIR, { recursive: true, force: true });
}
