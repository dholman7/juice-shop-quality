/**
 * Where the review state lives: the committed files, or with DEMO=1 empty copies in `.demo/` (git-ignored).
 * Demo mode lets anyone run and review from scratch without touching the committed review.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEMO_DIR = `${ROOT}.demo`;

// Committed path, and what an empty one holds.
const FILES = {
  knownBugs: ['known-bugs.json', '{\n  "bugs": []\n}\n'],
  decisions: ['triage/decisions.jsonl', ''],
  zapFindings: ['security/zap-findings.json', '{\n  "findings": []\n}\n'],
} as const;

export const isDemo = (): boolean => process.env.DEMO === '1';

/** Absolute path of one state file; in demo mode, created empty on first use. */
export function statePath(name: keyof typeof FILES): string {
  const [committed, empty] = FILES[name];
  if (!isDemo()) return `${ROOT}${committed}`;
  const path = `${DEMO_DIR}/${committed.split('/').pop()}`;
  if (!existsSync(path)) {
    mkdirSync(DEMO_DIR, { recursive: true });
    writeFileSync(path, empty);
  }
  return path;
}

/** Empties the demo state, so the next demo run starts with nothing decided. */
export function resetDemo(): void {
  rmSync(DEMO_DIR, { recursive: true, force: true });
}
