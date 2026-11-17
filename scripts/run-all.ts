/**
 * The one command: fresh app, every test, triage proposals, report.
 *   yarn all                          heuristic triage (offline)
 *   TRIAGE_PROVIDER=claude yarn all   triage with Claude through the local `claude` CLI
 * Exits non-zero when a test fails that is not an approved open bug.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { up } from './juice-shop';
import { propose } from '../triage/cli';
import { buildReport } from './report';
import { recordRun, summarize } from './history';
import { coverageMarkdown } from './coverage-map';
import { readRows } from './results';

if (process.env.SKIP_APP !== '1') {
  console.log('Starting a fresh Juice Shop...');
  await up();
}

console.log('Running the Playwright suite...');
spawnSync('yarn', ['playwright', 'test'], { stdio: 'inherit' });

const run = propose();
mkdirSync('reports', { recursive: true });
writeFileSync('reports/index.html', buildReport(recordRun(summarize())));
writeFileSync('docs/coverage.md', coverageMarkdown(readRows().rows));

const { rows } = readRows();
const n = (r: string) => rows.filter((x) => x.result === r).length;
console.log(`\n${n('passed')} passed · ${n('failed')} new failures · ${n('known-bug')} open bugs · ${n('flaky')} flaky · ${n('skipped')} skipped`);
console.log(`Triage: ${run.groups.length} group(s) proposed (${run.provider}). Review with \`yarn triage:review\`.`);
console.log('Report: reports/index.html');
process.exit(n('failed') + n('fixed') > 0 ? 1 : 0);
