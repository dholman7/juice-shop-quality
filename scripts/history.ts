/**
 * One summary per run, kept across runs, for the report's Progress section.
 * CI downloads the published history before the run and publishes it again after, so the trend survives.
 */
import { statePath } from '../src/review-state';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { ENDPOINTS } from '../src/catalog';
import { ROLES } from '../src/config';
import { loadKnownBugs, type KnownBug } from '../src/known-bugs';
import { readRows } from './results';
import type { TriageRun } from '../triage/cli';
import type { Decision } from '../triage/types';

export const HISTORY = 'reports/history.json';
const KEEP = 200;

export interface RunSummary {
  at: string;
  commit?: string;
  source: 'ci' | 'local';
  durationS: number;
  tests: number;
  passed: number;
  newFailures: number;
  openBugs: number;
  flaky: number;
  fixed: number;
  skipped: number;
  /** Flaky tests plus failures that triage put down to a test bug or the environment. */
  nonProductFailures: number;
  endpoints: { total: number; everyRole: number; checks: number; checksRun: number };
  bugsBySeverity: Record<KnownBug['severity'], number>;
  triage: { decided: number; acceptedUnchanged: number };
}

function commit(): string | undefined {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7);
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

export function summarize(): RunSummary {
  const { rows, stats } = readRows();
  const n = (r: string) => rows.filter((x) => x.result === r).length;

  const triage: TriageRun | undefined = existsSync('reports/triage/proposals.json')
    ? JSON.parse(readFileSync('reports/triage/proposals.json', 'utf8'))
    : undefined;
  const notProduct = new Set(
    (triage?.proposals ?? []).filter((p) => p.category === 'test-bug' || p.category === 'environment').map((p) => p.groupId),
  );
  const nonProductFailed = (triage?.groups ?? [])
    .filter((g) => notProduct.has(g.id))
    .reduce((sum, g) => sum + g.failures.filter((f) => f.outcome === 'unexpected').length, 0);

  let checks = 0;
  let checksRun = 0;
  let everyRole = 0;
  for (const e of ENDPOINTS) {
    const run = ROLES.filter((role) => rows.some((r) => r.endpoint === e.id && r.role === role && r.result !== 'skipped')).length;
    checks += ROLES.length;
    checksRun += run;
    if (run === ROLES.length) everyRole++;
  }

  const bugsBySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const b of loadKnownBugs()) bugsBySeverity[b.severity]++;

  const decisions: Decision[] = existsSync(statePath('decisions'))
    ? readFileSync(statePath('decisions'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];

  return {
    at: stats.startTime,
    commit: commit(),
    source: process.env.CI ? 'ci' : 'local',
    durationS: Math.round(stats.duration / 1000),
    tests: rows.length,
    passed: n('passed'),
    newFailures: n('failed'),
    openBugs: n('known-bug'),
    flaky: n('flaky'),
    fixed: n('fixed'),
    skipped: n('skipped'),
    nonProductFailures: n('flaky') + nonProductFailed,
    endpoints: { total: ENDPOINTS.length, everyRole, checks, checksRun },
    bugsBySeverity,
    triage: { decided: decisions.length, acceptedUnchanged: decisions.filter((d) => d.verdict === 'accepted').length },
  };
}

export function readHistory(path = HISTORY): RunSummary[] {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/** Adds this run (replacing an earlier entry for the same run) and keeps the newest KEEP runs. */
export function recordRun(run: RunSummary, path = HISTORY, keep = KEEP): RunSummary[] {
  const history = [...readHistory(path).filter((r) => r.at !== run.at), run]
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(-keep);
  writeFileSync(path, JSON.stringify(history, null, 2));
  return history;
}
