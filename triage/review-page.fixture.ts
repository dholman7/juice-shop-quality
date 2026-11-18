/**
 * A throwaway checkout for review-page tests: three bugs (one with a severity off its score), five
 * undecided failure groups, one undecided ZAP finding, and a bare git remote. The real server runs
 * against it as a child process, so the committed review is never touched.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { KnownBug } from '../src/known-bugs';
import type { Failure, FailureGroup, Proposal } from './types';
import type { Finding } from '../security/zap';

const REPO = fileURLToPath(new URL('..', import.meta.url));

const bug = (over: Partial<KnownBug> & Pick<KnownBug, 'id' | 'jira' | 'title'>): KnownBug => ({
  severity: 'high', impact: 4, likelihood: 3, area: 'R3', tests: [], endpoints: [], approvedBy: 'Earlier Reviewer', approvedOn: '2026-11-16', ...over,
});

export const BUGS: KnownBug[] = [
  bug({
    id: 'BUG-001', jira: 'SHOP-1', title: "Any signed-in user can delete other customers' basket items", severity: 'critical', impact: 5, likelihood: 5, area: 'R1',
    tests: ["api/isolation.spec.ts › R1 isolation › DELETE /api/BasketItems/:id on another customer's record › refuses customer"], endpoints: ['basketItems.delete'],
  }),
  bug({ id: 'BUG-002', jira: 'SHOP-2', title: 'The password hash is in the session token and in API responses', tests: ['api/auth.spec.ts › R3 login › the session token does not carry the password hash'], endpoints: ['auth.login'] }),
  // Registered medium, but I4 × L3 = 12 is high: the severity check's item.
  bug({ id: 'BUG-003', jira: 'SHOP-3', title: 'No rate limit on wrong passwords', severity: 'medium', tests: ['api/auth.spec.ts › R3 login › slows down repeated wrong passwords for one account'], endpoints: ['auth.login'] }),
];

const failure = (key: string, over: Partial<Failure> = {}): Failure => ({
  key, title: key.split(' › ').pop() ?? key, file: key.split(' › ')[0], outcome: 'unexpected', error: `Error: ${key} failed`, retries: 0, ...over,
});
const proposal = (groupId: string, title: string): Proposal => ({
  groupId, source: 'heuristic', category: 'product-bug', confidence: 'high', evidence: 'Expected: 400 / Received: 200',
  reasoning: 'The product answered, and the answer broke a stated expectation.', suggestedTitle: `Not met: ${title}`, suggestedSeverity: 'critical',
});

export const GROUPS: FailureGroup[] = [
  // Same endpoint as BUG-001, both access checks: suggested as a duplicate.
  { id: 'G-dup', signature: 's', failures: [failure("api/isolation.spec.ts › R1 isolation › DELETE /api/BasketItems/:id on another customer's record › refuses deluxe", { endpoint: 'basketItems.delete', role: 'deluxe' })] },
  // A behavior test BUG-002 doesn't match on: found by search or Jira key.
  { id: 'G-hash', signature: 's', failures: [failure('api/auth.spec.ts › R3 passwords › the password change response does not return the password hash', { endpoint: 'password.change', role: 'customer' })] },
  { id: 'G-new', signature: 's', failures: [failure('api/customer-data.spec.ts › R1 addresses › rejects an address with an invalid fullName', { endpoint: 'addresses.create', role: 'customer' })] },
  { id: 'G-change', signature: 's', failures: [failure('api/checkout.spec.ts › R2 checkout › a slow total is recomputed')] },
  { id: 'G-reject', signature: 's', failures: [failure('api/checkout.spec.ts › R2 checkout › a coupon nobody asked for is refused')] },
];

export const FINDING: Finding = {
  ref: '10098', name: 'Cross-Domain Misconfiguration', risk: 'medium', confidence: 'medium', count: 5,
  example: 'http://localhost:3000', cwe: '264', description: 'Wildcard CORS header.', solution: 'Restrict Access-Control-Allow-Origin.',
};

/** Review files only, so a commit's file list can be checked against them. */
export const REVIEW_FILES = ['known-bugs.json', 'triage/decisions.jsonl', 'security/zap-findings.json', 'docs/coverage.md'];

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();

export interface Checkout {
  root: string;
  remote: string;
  git: (...args: string[]) => string;
  cleanup: () => void;
}

/** A committed, pushed checkout with the fixture review state. */
export function makeCheckout(): Checkout {
  const base = mkdtempSync(join(tmpdir(), 'review-page-'));
  const root = join(base, 'repo');
  const remote = join(base, 'remote.git');
  const write = (path: string, text: string) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  write('known-bugs.json', `${JSON.stringify({ bugs: BUGS }, null, 2)}\n`);
  write('triage/decisions.jsonl', '');
  write('security/zap-findings.json', '{\n  "findings": []\n}\n');
  write('docs/coverage.md', '# Coverage\n');
  write('README.md', '# Fixture\n');
  write('.gitignore', 'reports/\n.demo/\n');
  write('reports/triage/proposals.json', JSON.stringify({
    provider: 'heuristic', createdAt: '2026-11-17T00:00:00Z', groups: GROUPS, proposals: GROUPS.map((g) => proposal(g.id, g.failures[0].title)),
  }));
  write('reports/zap/summary.json', JSON.stringify({ scannedAt: '2026-11-17T00:00:00Z', zapVersion: '2.17.0', newFindings: [FINDING], bugs: [], dismissed: [], reported: [], notSeen: [] }));
  const run = (...args: string[]) => git(root, ...args);
  run('init', '-q', '-b', 'main');
  run('config', 'user.name', 'Repo Owner');
  run('config', 'user.email', 'owner@example.com');
  run('add', '-A');
  run('commit', '-qm', 'fixture');
  git(base, 'init', '-q', '--bare', remote);
  run('remote', 'add', 'origin', remote);
  run('push', '-qu', 'origin', 'main');
  return { root, remote, git: run, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

export interface Server {
  url: string;
  port: number;
  stop: () => void;
}

/** Starts the real review page (tsx triage/review-page.ts) on the checkout; resolves once it listens. */
export async function startServer(root: string, port: number, env: Record<string, string> = {}): Promise<Server> {
  const child: ChildProcess = spawn(join(REPO, 'node_modules/.bin/tsx'), [join(REPO, 'triage/review-page.ts')], {
    cwd: root,
    env: { ...process.env, DEMO: '', REVIEW_ROOT: root, REVIEW_PORT: String(port), NO_OPEN: '1', REVIEWER: 'Fixture Reviewer', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`review page did not start: ${out}`)), 20_000);
    const read = (chunk: Buffer) => {
      out += chunk;
      if (out.includes('Review page')) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout?.on('data', read);
    child.stderr?.on('data', read);
    child.on('exit', (code) => reject(new Error(`review page exited (${code}): ${out}`)));
  });
  return { url: `http://127.0.0.1:${port}`, port, stop: () => child.kill() };
}

/** A port unlikely to clash with a running `yarn review` (4321) or another test file. */
export const freePort = (offset: number): number => 43_000 + offset + Math.floor(Math.random() * 1000);
