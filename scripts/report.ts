/**
 * Builds reports/index.html: one page a tester or manager can read without the terminal.
 * Inputs: the Playwright JSON report, the triage proposals, decisions, and known-bugs.json.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { AREAS, ENDPOINTS, allows, type Area } from '../src/catalog';
import { ROLES } from '../src/config';
import { loadKnownBugs } from '../src/known-bugs';
import { readRows, type Row } from './results';
import type { TriageRun } from '../triage/cli';
import type { Decision } from '../triage/types';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function areaOf(r: Row): Area | undefined {
  const m = r.key.match(/\b(R[123])\b/);
  return m ? (m[1] as Area) : undefined;
}

export function buildReport(): string {
  const { rows, stats } = readRows();
  const count = (res: Row['result']) => rows.filter((r) => r.result === res).length;
  const bugs = loadKnownBugs();
  const triage: TriageRun | undefined = existsSync('reports/triage/proposals.json')
    ? JSON.parse(readFileSync('reports/triage/proposals.json', 'utf8'))
    : undefined;
  const decided = new Set(
    existsSync('triage/decisions.jsonl')
      ? readFileSync('triage/decisions.jsonl', 'utf8').trim().split('\n').filter(Boolean).map((l) => (JSON.parse(l) as Decision).groupId)
      : [],
  );
  const pending = triage?.proposals.filter((p) => !decided.has(p.groupId)) ?? [];

  const tiles = [
    ['Passed', count('passed'), 'ok'],
    ['New failures', count('failed'), count('failed') ? 'bad' : 'ok'],
    ['Open bugs', count('known-bug'), count('known-bug') ? 'warn' : 'ok'],
    ['Flaky', count('flaky'), count('flaky') ? 'warn' : 'ok'],
    ['Bug fixed?', count('fixed'), count('fixed') ? 'warn' : 'ok'],
    ['Skipped', count('skipped'), 'muted'],
  ] as const;

  const byArea = (Object.keys(AREAS) as Area[]).map((a) => {
    const mine = rows.filter((r) => areaOf(r) === a);
    const n = (res: Row['result']) => mine.filter((r) => r.result === res).length;
    return `<tr><th>${a} ${AREAS[a]}</th><td class="num">${mine.length}</td><td class="num">${n('passed')}</td><td class="num">${n('failed')}</td><td class="num">${n('known-bug')}</td><td class="num">${n('flaky')}</td></tr>`;
  });

  const grid = (Object.keys(AREAS) as Area[]).map((a) => {
    const body = ENDPOINTS.filter((e) => e.area === a).map((ep) => {
      const cells = ROLES.map((role) => {
        const hits = rows.filter((r) => r.endpoint === ep.id && r.role === role);
        if (!hits.length) return '<td class="cell none" title="not covered">·</td>';
        const worst = (['failed', 'fixed', 'flaky', 'known-bug', 'skipped', 'passed'] as const).find((res) => hits.some((h) => h.result === res))!;
        const expect = allows(ep, role) ? 'allowed' : 'refused';
        return `<td class="cell ${worst}" title="${esc(`${role}: should be ${expect}; ${hits.length} test(s); ${worst}`)}">${allows(ep, role) ? '✓' : '✗'}</td>`;
      });
      return `<tr><th><code>${esc(ep.method)} ${esc(ep.path)}</code></th>${cells.join('')}</tr>`;
    });
    return `<h3>${a} ${AREAS[a]}</h3><div class="scroll"><table class="grid"><thead><tr><th></th>${ROLES.map((r) => `<th>${r}</th>`).join('')}</tr></thead><tbody>${body.join('')}</tbody></table></div>`;
  });

  const pendingRows = pending.map((p) => {
    const g = triage!.groups.find((x) => x.id === p.groupId)!;
    return `<tr><td><span class="pill ${p.category}">${p.category}</span></td><td class="num">${g.failures.length}</td><td>${esc(g.failures[0].key)}</td><td><code>${esc(p.evidence.slice(0, 140))}</code></td><td>${p.confidence}${p.downgradedBecause ? ` · ${esc(p.downgradedBecause)}` : ''}</td></tr>`;
  });

  const bugRows = bugs.map((b) => {
    const failing = rows.filter((r) => r.knownBug?.startsWith(`${b.id}:`) && r.result === 'known-bug').length;
    const fixed = rows.filter((r) => r.knownBug?.startsWith(`${b.id}:`) && r.result === 'fixed').length;
    return `<tr><td>${b.id}</td><td><span class="pill sev-${b.severity}">${b.severity}</span></td><td>${b.area}</td><td>${esc(b.title)}</td><td class="num">${failing}${fixed ? ` <span class="pill fixed">${fixed} now pass</span>` : ''}</td><td>${esc(b.approvedBy)} · ${b.approvedOn}</td></tr>`;
  });

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Juice Shop test run</title>
<style>
:root{--ink:#1d2430;--muted:#5d6878;--line:#dde3ea;--bg:#f6f8fa;--card:#fff;--ok:#1f7a4d;--bad:#b42318;--warn:#9a6700;--accent:#2f5d8a}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px max(16px,env(safe-area-inset-left))}
h1{font-size:24px;margin:0 0 4px}h2{font-size:18px;margin:32px 0 8px}h3{font-size:15px;margin:20px 0 6px;color:var(--muted)}
.sub{color:var(--muted);margin:0 0 20px}.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 14px}.tile b{display:block;font-size:28px;font-variant-numeric:tabular-nums}
.tile.ok b{color:var(--ok)}.tile.bad b{color:var(--bad)}.tile.warn b{color:var(--warn)}.tile.muted b{color:var(--muted)}
table{border-collapse:collapse;width:100%;background:var(--card);border:1px solid var(--line);border-radius:8px}
th,td{padding:6px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}thead th{font-size:12px;color:var(--muted);font-weight:600}
.num{text-align:right;font-variant-numeric:tabular-nums}.scroll{overflow-x:auto}code{font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace}
.grid td.cell{text-align:center;width:90px;font-weight:600}.cell.passed{background:#e6f4ec;color:var(--ok)}.cell.known-bug{background:#fdf1d8;color:var(--warn)}
.cell.failed,.cell.fixed{background:#fde8e6;color:var(--bad)}.cell.flaky{background:#efe6fb;color:#6b3fa0}.cell.skipped,.cell.none{color:#9aa5b1}
.pill{display:inline-block;white-space:nowrap;padding:1px 8px;border-radius:99px;font-size:12px;background:#eef1f4}.pill.product-bug,.pill.sev-critical{background:#fde8e6;color:var(--bad)}
.pill.test-bug,.pill.sev-high{background:#fdf1d8;color:var(--warn)}.pill.flaky{background:#efe6fb;color:#6b3fa0}.pill.environment{background:#e3eefa;color:var(--accent)}
.pill.fixed{background:#e6f4ec;color:var(--ok)}.legend{color:var(--muted);font-size:13px}a{color:var(--accent)}
</style></head><body><main>
<h1>Juice Shop test run</h1>
<p class="sub">${esc(new Date(stats.startTime).toLocaleString())} · ${(stats.duration / 1000).toFixed(0)} s · ${rows.length} tests · <a href="playwright/index.html">Playwright report with traces</a> · <a href="../docs/coverage.md">coverage map</a></p>
<section class="tiles">${tiles.map(([label, n, tone]) => `<div class="tile ${tone}"><b>${n}</b>${label}</div>`).join('')}</section>

<h2>Waiting for a person</h2>
<p class="legend">The triage agent (${esc(triage?.provider ?? 'not run')}) grouped new failures and proposed a cause for each group. Nothing is filed until someone runs <code>yarn triage:review</code>.</p>
${pendingRows.length ? `<div class="scroll"><table><thead><tr><th>Proposed</th><th>Tests</th><th>Example</th><th>Evidence (quoted from the failure)</th><th>Confidence</th></tr></thead><tbody>${pendingRows.join('')}</tbody></table></div>` : '<p>Nothing to review.</p>'}

<h2>By risk area</h2>
<table><thead><tr><th>Area</th><th class="num">Tests</th><th class="num">Passed</th><th class="num">New failures</th><th class="num">Open bugs</th><th class="num">Flaky</th></tr></thead><tbody>${byArea.join('')}</tbody></table>

<h2>Open bugs</h2>
${bugRows.length ? `<div class="scroll"><table><thead><tr><th>Bug</th><th>Severity</th><th>Area</th><th>Title</th><th class="num">Failing tests</th><th>Approved</th></tr></thead><tbody>${bugRows.join('')}</tbody></table></div>` : '<p>No approved bugs yet.</p>'}

<h2>Coverage: every endpoint, every role</h2>
<p class="legend">✓ the role may call it · ✗ it must be refused · green as intended · amber open bug · red new failure · grey not run. Hover a cell for detail.</p>
${grid.join('')}
</main></body></html>`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  writeFileSync('reports/index.html', buildReport());
  console.log('wrote reports/index.html');
}
