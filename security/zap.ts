/**
 * OWASP ZAP baseline scan of the local app: spiders it for a minute and runs ZAP's passive rules
 * (security headers, cookies, CORS, information leaks). Passive only: no attack traffic.
 *
 *   yarn security:zap      scan the running app, write reports/zap/
 *   yarn security:review   a person files or dismisses each new medium or high finding
 *
 * Medium and high findings fail the run until a person decides on them in security/zap-findings.json,
 * the same gate as known-bugs.json. Low and informational findings are reported, never fail.
 */
import { statePath } from '../src/review-state';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { NAME as APP_CONTAINER } from '../scripts/juice-shop';

// 2.17.0, pinned by its multi-arch index digest so every run uses the same rules.
export const ZAP_IMAGE =
  process.env.ZAP_IMAGE ??
  'ghcr.io/zaproxy/zaproxy:2.17.0@sha256:9624669db72f54d86c4b46a7064518bd9bf79d8c61a4c31befa9923489f328af';
export const OUT = 'reports/zap';
const REPORT_JSON = `${OUT}/zap.json`;
export const SUMMARY = `${OUT}/summary.json`;

export type Risk = 'high' | 'medium' | 'low' | 'informational';
const RISKS: Risk[] = ['informational', 'low', 'medium', 'high'];

/** One ZAP alert type, with every URL it was seen on collapsed into a count. */
export interface Finding {
  /** ZAP's alertRef (plugin id, plus a variant suffix for rules that raise several alerts). */
  ref: string;
  name: string;
  risk: Risk;
  confidence: string;
  count: number;
  example: string;
  cwe?: string;
  description: string;
  solution: string;
}

/** A person's decision on a medium or high finding. Only the reviews (`yarn review`, `security:review`) write these. */
export interface FindingDecision {
  ref: string;
  name: string;
  risk: Risk;
  /** bug: real and open, tracked like a known bug. dismissed: not a risk here, with the reason. */
  verdict: 'bug' | 'dismissed';
  reason: string;
  decidedBy: string;
  decidedOn: string;
}

export interface ZapSummary {
  scannedAt: string;
  zapVersion: string;
  /** Medium or high, with no decision yet: these fail the run. */
  newFindings: Finding[];
  bugs: (Finding & { decision: FindingDecision })[];
  dismissed: (Finding & { decision: FindingDecision })[];
  /** Low and informational: reported only. */
  reported: Finding[];
  /** Decided findings this scan did not raise: fixed, or not reached by the spider. */
  notSeen: FindingDecision[];
}

const stripHtml = (s = '') => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

/** Reads ZAP's traditional JSON report. */
export function readFindings(path = REPORT_JSON): { version: string; findings: Finding[] } {
  const report = JSON.parse(readFileSync(path, 'utf8')) as {
    '@version': string;
    site: { alerts: { alertRef: string; name: string; riskcode: string; confidence: string; count: string; cweid?: string; desc?: string; solution?: string; instances: { uri: string }[] }[] }[];
  };
  const findings = report.site.flatMap((s) =>
    s.alerts.map((a) => ({
      ref: a.alertRef,
      name: a.name,
      risk: RISKS[Number(a.riskcode)] ?? 'informational',
      confidence: ['false positive', 'low', 'medium', 'high', 'confirmed'][Number(a.confidence)] ?? a.confidence,
      count: Number(a.count),
      example: a.instances[0]?.uri ?? '',
      cwe: a.cweid && a.cweid !== '-1' ? a.cweid : undefined,
      description: stripHtml(a.desc),
      solution: stripHtml(a.solution),
    })),
  );
  return { version: report['@version'], findings };
}

export function loadDecisions(path = statePath('zapFindings')): FindingDecision[] {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')).findings as FindingDecision[]) : [];
}

/** Sorts each finding by whether it gates the run. A decision only covers the risk level it was made at. */
export function evaluate(findings: Finding[], decisions: FindingDecision[]): Omit<ZapSummary, 'scannedAt' | 'zapVersion'> {
  const gated = (f: Finding) => f.risk === 'medium' || f.risk === 'high';
  const decisionFor = (f: Finding) => decisions.find((d) => d.ref === f.ref && d.risk === f.risk);
  const summary: Omit<ZapSummary, 'scannedAt' | 'zapVersion'> = { newFindings: [], bugs: [], dismissed: [], reported: [], notSeen: [] };
  for (const f of findings) {
    if (!gated(f)) {
      summary.reported.push(f);
      continue;
    }
    const decision = decisionFor(f);
    if (!decision) summary.newFindings.push(f);
    else if (decision.verdict === 'bug') summary.bugs.push({ ...f, decision });
    else summary.dismissed.push({ ...f, decision });
  }
  summary.notSeen = decisions.filter((d) => !findings.some((f) => f.ref === d.ref && f.risk === d.risk));
  return summary;
}

/**
 * Runs the baseline scan inside the app container's network namespace, so the only reachable
 * target is the local copy. Throws if ZAP errors or writes no report.
 */
export function scan(): ZapSummary {
  const out = resolve(OUT);
  mkdirSync(out, { recursive: true });
  // ZAP runs as its own user inside the container and must be able to write here (matters on Linux CI).
  chmodSync(out, 0o777);
  const res = spawnSync(
    'docker',
    [
      'run', '--rm', '--network', `container:${APP_CONTAINER}`, '-v', `${out}:/zap/wrk:rw`, ZAP_IMAGE,
      // -m 1: spider for one minute. -I: ZAP's own exit code ignores warnings; evaluate() decides.
      'zap-baseline.py', '-t', 'http://localhost:3000', '-m', '1', '-I', '-J', 'zap.json', '-r', 'zap.html',
    ],
    { encoding: 'utf8' },
  );
  if (res.status !== 0 || !existsSync(REPORT_JSON)) {
    const tail = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim().split('\n').slice(-15).join('\n');
    throw new Error(`ZAP baseline scan failed (exit ${res.status}). Is the ${APP_CONTAINER} container running?\n${tail}`);
  }
  const { version, findings } = readFindings();
  const summary: ZapSummary = { scannedAt: new Date().toISOString(), zapVersion: version, ...evaluate(findings, loadDecisions()) };
  writeFileSync(SUMMARY, JSON.stringify(summary, null, 2));
  return summary;
}

export function readSummary(): ZapSummary | undefined {
  return existsSync(SUMMARY) ? (JSON.parse(readFileSync(SUMMARY, 'utf8')) as ZapSummary) : undefined;
}

export function printSummary(s: ZapSummary): void {
  console.log(
    `ZAP baseline ${s.zapVersion}: ${s.newFindings.length} new medium/high finding(s) · ${s.bugs.length} open security bug(s) · ` +
      `${s.dismissed.length} dismissed · ${s.reported.length} low/informational`,
  );
  for (const f of s.newFindings) console.log(`  NEW ${f.risk.toUpperCase()}: ${f.name} [${f.ref}] x ${f.count}, e.g. ${f.example}`);
  if (s.newFindings.length) console.log('Decide with `yarn review` or `yarn security:review`. Full report: reports/zap/zap.html');
}

function reviewer(): string {
  if (process.env.REVIEWER) return process.env.REVIEWER;
  const res = spawnSync('git', ['config', 'user.name'], { encoding: 'utf8' });
  return res.stdout?.trim() || 'unknown';
}

/** New findings from the last scan with no decision yet; one decided since the scan drops out before the next. */
export function undecided(summary: ZapSummary, decisions = loadDecisions()): Finding[] {
  return summary.newFindings.filter((f) => !decisions.some((d) => d.ref === f.ref && d.risk === f.risk));
}

/** Records a person's decision on a finding. A dismissal needs a reason. */
export function recordDecision(f: Finding, verdict: FindingDecision['verdict'], reason: string, who: string, on: string): FindingDecision {
  if (verdict === 'dismissed' && !reason.trim()) throw new Error('a dismissal needs a reason');
  const decision: FindingDecision = { ref: f.ref, name: f.name, risk: f.risk, verdict, reason: reason.trim(), decidedBy: who, decidedOn: on };
  writeFileSync(statePath('zapFindings'), `${JSON.stringify({ findings: [...loadDecisions(), decision] }, null, 2)}\n`);
  return decision;
}

/** The human gate for scan findings: file each new one as a bug or dismiss it with a reason. */
async function review(): Promise<void> {
  const summary = readSummary();
  if (!summary) throw new Error('No scan yet. Run `yarn security:zap` first.');
  const pending = undecided(summary);
  if (!pending.length) {
    console.log('No new medium or high findings to review.');
    return;
  }
  const who = reviewer();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(`${pending.length} finding(s) to review as ${who}.`);
  console.log('[b] file as a bug (stays visible, stops failing the run)  [d] dismiss: not a risk here, reason required  [s] decide later  [q] quit');
  for (const [i, f] of pending.entries()) {
    console.log(`\n[${i + 1}/${pending.length}] ${f.name}  (${f.risk}, ${f.confidence} confidence, ZAP rule ${f.ref}${f.cwe ? `, CWE-${f.cwe}` : ''})`);
    console.log(`  seen on:   ${f.count} URL(s), e.g. ${f.example}`);
    console.log(`  what:      ${f.description.slice(0, 300)}`);
    console.log(`  fix:       ${f.solution.slice(0, 300)}`);
    const answer = (await rl.question('  > ')).trim().toLowerCase();
    if (answer === 'q') break;
    if (answer !== 'b' && answer !== 'd') continue;
    const reason = (await rl.question(answer === 'b' ? '  note (Enter to skip): ' : '  why is it not a risk here? ')).trim();
    if (answer === 'd' && !reason) {
      console.log('  a dismissal needs a reason; left undecided');
      continue;
    }
    recordDecision(f, answer === 'b' ? 'bug' : 'dismissed', reason, who, new Date().toISOString().slice(0, 10));
    console.log(`  recorded: ${answer === 'b' ? 'open security bug' : 'dismissed'}`);
  }
  rl.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2];
  if (cmd === 'scan') {
    const s = scan();
    printSummary(s);
    process.exit(s.newFindings.length ? 1 : 0);
  } else if (cmd === 'review') await review();
  else throw new Error('usage: zap.ts scan|review');
}
