/**
 * The one command: fresh app, ZAP baseline scan, every test, triage proposals, report.
 *   yarn all                          heuristic triage (offline)
 *   TRIAGE_PROVIDER=claude yarn all   triage with Claude through the local `claude` CLI
 *   SKIP_ZAP=1 yarn all               skip the security scan
 * Exits non-zero when a test fails that is not an approved open bug, or the scan has an undecided medium or high finding.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { up } from './juice-shop';
import { propose } from '../triage/cli';
import { buildReport } from './report';
import { recordRun, summarize } from './history';
import { coverageMarkdown } from './coverage-map';
import { readRows } from './results';
import { SUMMARY as ZAP_SUMMARY, printSummary, scan, type ZapSummary } from '../security/zap';

if (process.env.SKIP_APP !== '1') {
  console.log('Starting a fresh Juice Shop...');
  await up();
}

// On the fresh app, before the tests change its data, so findings are the same from run to run.
let zap: ZapSummary | undefined;
let zapError = false;
// A skipped or failed scan must not leave the last run's findings in the report.
rmSync(ZAP_SUMMARY, { force: true });
if (process.env.SKIP_ZAP !== '1') {
  console.log('Running the OWASP ZAP baseline scan (passive, about a minute)...');
  try {
    zap = scan();
  } catch (error) {
    zapError = true;
    console.error((error as Error).message);
  }
}

console.log('Running the Playwright suite...');
// The suite's exit code is ignored here; the verdict below uses the known-bug registry instead.
spawnSync('yarn', ['playwright', 'test'], { stdio: 'inherit' });

// Triage only proposes. Nothing reaches known-bugs.json until a person runs `yarn triage:review`.
const run = propose();
mkdirSync('reports', { recursive: true });
// Add this run to reports/history.json, then build the report from the full history (for the trends).
writeFileSync('reports/index.html', buildReport(recordRun(summarize())));
writeFileSync('docs/coverage.md', coverageMarkdown(readRows().rows));

const { rows } = readRows();
const n = (r: string) => rows.filter((x) => x.result === r).length;
console.log(`\n${n('passed')} passed · ${n('failed')} new failures · ${n('known-bug')} open bugs · ${n('flaky')} flaky · ${n('skipped')} skipped`);
console.log(`Triage: ${run.groups.length} group(s) proposed (${run.provider}). Review with \`yarn triage:review\`.`);
if (zap) printSummary(zap);
console.log('Report: reports/index.html');
// Red on a new failure, and on a "fixed" known bug, so its registry entry gets removed rather than forgotten.
// Red on an undecided medium or high scan finding, or a scan that didn't run.
process.exit(n('failed') + n('fixed') + (zap?.newFindings.length ?? 0) > 0 || zapError ? 1 : 0);
