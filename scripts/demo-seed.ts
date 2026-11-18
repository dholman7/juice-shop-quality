/**
 * The demo's starting point: the committed review with a few decisions undone, so the review page
 * shows each of its features in about five items instead of 41 groups. Real run history comes from
 * demo/history.json, a snapshot of CI's published runs.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { KnownBug } from '../src/known-bugs';
import type { FindingDecision } from '../security/zap';
import { committedPath, demoDir, resetDemo } from '../src/review-state';

/** What `yarn demo` undoes, and the review-page feature each one shows. */
export const PLAN = {
  groups: [
    {
      id: 'G-0d53bffa',
      shows: 'a suggested duplicate: same endpoint as BUG-001, both access checks',
      tests: ['customer', 'deluxe', 'accounting', 'admin'].map(
        (role) => `api/isolation.spec.ts › R1 isolation › DELETE /api/BasketItems/:id on another customer's record › refuses ${role}`,
      ),
    },
    {
      id: 'G-c9b93114',
      shows: 'search: no suggestion, but "hash" finds BUG-008',
      tests: ['api/auth.spec.ts › R3 passwords › the password change response does not return the password hash'],
    },
    {
      id: 'G-01a13b42',
      shows: 'a new bug: Jira key, title, impact and likelihood (BUG-020 is removed)',
      tests: ['api/customer-data.spec.ts › R1 addresses › rejects an address with an invalid fullName'],
    },
  ],
  /** Bugs whose last re-score is undone, so the severity check has something to show. */
  undoRescore: ['BUG-010'],
  /** ZAP findings left undecided. */
  zapRefs: ['10098'],
} as const;

const HISTORY_SNAPSHOT = fileURLToPath(new URL('../demo/history.json', import.meta.url));

/** Replaces `.demo/` with the committed review minus PLAN. */
export function seedDemo(): void {
  resetDemo();
  mkdirSync(demoDir(), { recursive: true });
  const undoTests = new Set<string>(PLAN.groups.flatMap((g) => g.tests));
  const undoGroups = new Set<string>(PLAN.groups.map((g) => g.id));

  const bugs = (JSON.parse(readFileSync(committedPath('knownBugs'), 'utf8')).bugs as KnownBug[])
    .map((b) => ({ ...b, tests: b.tests.filter((t) => !undoTests.has(t)) }))
    .filter((b) => b.tests.length)
    .map((b) => {
      if (!(PLAN.undoRescore as readonly string[]).includes(b.id) || !b.rerated?.length) return b;
      const last = b.rerated[b.rerated.length - 1];
      return { ...b, severity: last.from, rerated: b.rerated.slice(0, -1) };
    });
  writeFileSync(`${demoDir()}/known-bugs.json`, `${JSON.stringify({ bugs }, null, 2)}\n`);

  const decisions = readFileSync(committedPath('decisions'), 'utf8').split('\n').filter((l) => l.trim() && !undoGroups.has(JSON.parse(l).groupId));
  writeFileSync(`${demoDir()}/decisions.jsonl`, decisions.map((l) => `${l}\n`).join(''));

  const findings = (JSON.parse(readFileSync(committedPath('zapFindings'), 'utf8')).findings as FindingDecision[])
    .filter((f) => !(PLAN.zapRefs as readonly string[]).includes(f.ref));
  writeFileSync(`${demoDir()}/zap-findings.json`, `${JSON.stringify({ findings }, null, 2)}\n`);

  if (existsSync(HISTORY_SNAPSHOT)) copyFileSync(HISTORY_SNAPSHOT, `${demoDir()}/history.json`);
}
