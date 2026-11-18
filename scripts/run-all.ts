/**
 * The one command: fresh app, ZAP baseline scan, every test, triage proposals, report.
 *   yarn all                          heuristic triage (offline)
 *   TRIAGE_PROVIDER=claude yarn all   triage with Claude through the local `claude` CLI
 *   SKIP_ZAP=1 yarn all               skip the security scan
 * Exits non-zero on a test failure that is not an approved open bug, an open bug's test that now passes,
 * an undecided medium or high scan finding, a scan that errors, or a bug whose severity isn't its score's band.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { up } from './juice-shop';
import { propose } from '../triage/cli';
import { buildReport } from './report';
import { recordRun, summarize } from './history';
import { coverageMarkdown } from './coverage-map';
import { readRows } from './results';
import { loadKnownBugs, severityMismatches } from '../src/known-bugs';
import { isDemo, statePath } from '../src/review-state';
import { printSummary, scan, type ZapSummary } from '../security/zap';

if (process.env.SKIP_APP !== '1') {
  console.log('Starting a fresh Juice Shop...');
  await up();
}

// On the fresh app, before the tests change its data, so findings are the same from run to run.
let zap: ZapSummary | undefined;
let zapError = false;
// A skipped or failed scan must not leave the last run's findings in the report.
rmSync(statePath('zapSummary'), { force: true });
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
// -s: without it, yarn adds "error Command failed" when tests fail, which is expected here.
spawnSync('yarn', ['-s', 'playwright', 'test'], { stdio: 'inherit' });

// Triage only proposes. Nothing reaches known-bugs.json until a person decides in `yarn review` or `yarn triage:review`.
const run = propose();
mkdirSync('reports', { recursive: true });
// Add this run to reports/history.json, then build the report from the full history (for the trends).
// A demo run records its history in .demo/ and leaves the committed coverage map alone.
writeFileSync('reports/index.html', buildReport(recordRun(summarize())));
if (!isDemo()) writeFileSync('docs/coverage.md', coverageMarkdown(readRows().rows));

const { rows } = readRows();
const n = (r: string) => rows.filter((x) => x.result === r).length;
console.log(`\n${n('passed')} passed · ${n('failed')} new failures · ${n('known-bug')} open bugs · ${n('flaky')} flaky · ${n('skipped')} skipped`);
console.log(`Triage: ${run.groups.length} group(s) proposed (${run.provider}). Review with \`${isDemo() ? 'yarn demo:review' : 'yarn review'}\` (a local page).`);
if (zap) printSummary(zap);
const offScore = severityMismatches(loadKnownBugs());
if (offScore.length) console.log(`Severity not matching impact × likelihood: ${offScore.map((b) => b.id).join(', ')}. Fix on the review page.`);
console.log('Report: reports/index.html');
if (isDemo()) {
  console.log('\nDemo: decide on the page with `yarn demo:review`, then `yarn demo:rerun` runs again with those decisions.');
  // The demo shows the gate; it isn't one.
  process.exit(0);
}
// Red on a new failure, and on a "fixed" known bug, so its registry entry gets removed rather than forgotten.
// Red on an undecided medium or high scan finding, a scan that didn't run, or a severity that isn't its score's band.
process.exit(n('failed') + n('fixed') + (zap?.newFindings.length ?? 0) + offScore.length > 0 || zapError ? 1 : 0);
