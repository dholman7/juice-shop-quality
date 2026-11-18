/**
 * Review logic shared by the terminal review (cli.ts) and the review page (review-page.ts),
 * so both record decisions and bugs the same way.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { findBug, isScore, jiraKey, severityFor, type KnownBug } from '../src/known-bugs';
import { endpoint as catalogEndpoint } from '../src/catalog';
import type { Category, Decision, FailureGroup, Proposal } from './types';
import { statePath } from '../src/review-state';

// Proposals are per run (regenerated, not committed); decisions (triage/decisions.jsonl) are the committed audit trail.

/** One triage pass: which provider ran, the groups, and one proposal per group. */
export interface TriageRun {
  provider: string;
  createdAt: string;
  groups: FailureGroup[];
  proposals: Proposal[];
}

/** What each likely cause means and what happens when it's accepted. */
export const CAUSES: Record<Category, string> = {
  'product-bug': 'the app broke a rule      → becomes a tracked bug (known-bugs.json); developers fix the product',
  'test-bug': 'the test itself is wrong  → recorded for the test owner to fix; no bug filed',
  environment: 'app or network was down   → recorded; re-run, nobody\'s code is at fault',
  flaky: 'passed on retry           → recorded; the test needs fixing, not the product',
  'needs-human': 'not enough evidence       → open the trace and decide',
};

export const SCORE_HELP = {
  impact: 'harm to customers, money, or the business; 5 = every customer\'s data or money',
  likelihood: 'how easily it is hit; 5 = a plain request, 3 = needs a specific condition, 1 = unlikely',
} as const;

/** The name recorded on every decision and approved bug: REVIEWER, else the git user name. */
export function reviewer(): string {
  if (process.env.REVIEWER) return process.env.REVIEWER;
  try {
    return execFileSync('git', ['config', 'user.name'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

export const today = (): string => new Date().toISOString().slice(0, 10);

export function saveBugs(bugs: KnownBug[]): void {
  writeFileSync(statePath('knownBugs'), `${JSON.stringify({ bugs }, null, 2)}\n`);
}

export function appendDecision(decision: Decision): void {
  appendFileSync(statePath('decisions'), `${JSON.stringify(decision)}\n`);
}

/** No triage run yet: a normal state, unlike a proposals file that can't be read. */
export class NoProposals extends Error {
  constructor() {
    super('No proposals yet. Run `yarn all` or `yarn triage` first.');
  }
}

export function loadRun(): TriageRun {
  if (!existsSync(statePath('proposals'))) throw new NoProposals();
  return JSON.parse(readFileSync(statePath('proposals'), 'utf8')) as TriageRun;
}

/** Proposals with no decision yet. Groups decided on an earlier run are skipped, so only new defects come back. */
export function pendingProposals(run: TriageRun): Proposal[] {
  const decisions = statePath('decisions');
  const decided = new Set(
    existsSync(decisions) ? readFileSync(decisions, 'utf8').trim().split('\n').filter(Boolean).map((l) => (JSON.parse(l) as Decision).groupId) : [],
  );
  return run.proposals.filter((p) => !decided.has(p.groupId));
}

export function nextBugId(bugs: KnownBug[]): string {
  const max = Math.max(0, ...bugs.map((b) => Number(b.id.replace('BUG-', ''))));
  return `BUG-${String(max + 1).padStart(3, '0')}`;
}

/** The intended access rule in plain words, so a reviewer can judge without opening src/catalog.ts. */
export function accessRule(id: string): string {
  const ep = catalogEndpoint(id);
  const who = ep.access === 'public' ? 'anyone, including signed-out visitors, may call it'
    : ep.access === 'authenticated' ? 'any signed-in user may call it'
      : ep.access === 'owner' ? "only the customer who owns the record; others must be refused (401/403)"
        : ep.access === 'nobody' ? 'no one may call it through the API; every caller must be refused (401/403)'
          : `only ${ep.access.join(' and ')} may call it; everyone else must be refused (401/403)`;
  return `${ep.method} ${ep.path}: ${who}${ep.note ? ` (${ep.note})` : ''}`;
}

/** The rule a group's tests check: the catalog's access rule for role-matrix tests, else the test title. */
export function ruleOf(group: FailureGroup): string {
  const f = group.failures[0];
  return f.file.includes('access-matrix') && f.endpoint ? accessRule(f.endpoint) : `${f.title} (the test title is the requirement)`;
}

/**
 * The test's own risk area (named in its describe title), else its endpoint's. An R3 login test that probes
 * a basket endpoint with a forged token is an R3 bug, not R1. Matches the report's by-area table.
 */
export function areaOf(f: FailureGroup['failures'][number]): string {
  return f.key.match(/\bR[123]\b/)?.[0] ?? (f.endpoint ? catalogEndpoint(f.endpoint).area : 'unknown');
}

/** Where an accepted product bug goes: an open bug (by id or Jira key), or a new bug. */
export type BugTarget = { existing: string } | { jira: string; title: string; impact: number; likelihood: number };

/**
 * Adds a group's tests to an open bug, or files a new one. A new bug's Jira key already on file means the
 * same bug, so the group joins it. Throws on an unknown bug, a bad Jira key, a blank title, or bad scores.
 */
export function fileBug(bugs: KnownBug[], group: FailureGroup, target: BugTarget, who: string, on: string): { bugs: KnownBug[]; bugId: string; created?: KnownBug } {
  const keys = group.failures.map((f) => f.key);
  const endpoints = [...new Set(group.failures.map((f) => f.endpoint).filter((e): e is string => Boolean(e)))];
  const join = (bug: KnownBug) => ({
    bugs: bugs.map((b) => (b.id === bug.id ? { ...b, tests: [...new Set([...b.tests, ...keys])], endpoints: [...new Set([...(b.endpoints ?? []), ...endpoints])] } : b)),
    bugId: bug.id,
  });
  if ('existing' in target) {
    const bug = findBug(bugs, target.existing);
    if (!bug) throw new Error(`no open bug ${target.existing}`);
    return join(bug);
  }
  const jira = jiraKey(target.jira);
  if (!jira) throw new Error('not a Jira key; expected PROJECT-123');
  const onFile = findBug(bugs, jira);
  if (onFile) return join(onFile);
  const title = target.title.trim();
  if (!title) throw new Error('a new bug needs a title');
  if (!isScore(target.impact) || !isScore(target.likelihood)) throw new Error('impact and likelihood must be whole numbers from 1 to 5');
  const created: KnownBug = {
    id: nextBugId(bugs),
    jira,
    title,
    severity: severityFor(target.impact, target.likelihood),
    impact: target.impact,
    likelihood: target.likelihood,
    area: areaOf(group.failures[0]),
    tests: keys,
    endpoints,
    approvedBy: who,
    approvedOn: on,
  };
  return { bugs: [...bugs, created], bugId: created.id, created };
}
