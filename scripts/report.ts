/**
 * Builds reports/index.html: one page a tester or manager can read without the terminal.
 * Inputs: the Playwright JSON report, the triage proposals, decisions, known-bugs.json, and the ZAP scan summary.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { AREAS, ENDPOINTS, allows, type Area } from '../src/catalog';
import { ROLES } from '../src/config';
import { loadKnownBugs, severityMismatches } from '../src/known-bugs';
import { readRows, type Row } from './results';
import { readHistory, summarize, type RunSummary } from './history';
import type { TriageRun } from '../triage/cli';
import type { Decision } from '../triage/types';
import { readSummary, type ZapSummary } from '../security/zap';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** The risk area for the by-area table: named in the test's titles, or else (UI tests) the area of the endpoint it covers. */
function areaOf(r: Row): Area | undefined {
  const m = r.key.match(/\b(R[123])\b/);
  if (m) return m[1] as Area;
  return r.endpoint ? ENDPOINTS.find((e) => e.id === r.endpoint)?.area : undefined;
}

function sparkline(values: number[], label: string): string {
  const v = values.slice(-30);
  if (v.length < 2) return '<span class="legend">first run</span>';
  const [w, h, pad] = [120, 28, 4];
  const min = Math.min(...v);
  const span = Math.max(...v) - min;
  const x = (i: number) => pad + (i * (w - 2 * pad)) / (v.length - 1);
  const y = (val: number) => (span ? h - pad - ((val - min) * (h - 2 * pad)) / span : h / 2);
  const points = v.map((val, i) => `${x(i).toFixed(1)},${y(val).toFixed(1)}`).join(' ');
  const last = v.length - 1;
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(label)}, last ${v.length} runs: ${v.join(', ')}"><title>${esc(label)}: ${v.join(' → ')}</title><polyline points="${points}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="${x(last).toFixed(1)}" cy="${y(v[last]).toFixed(1)}" r="2.5" fill="currentColor"/></svg>`;
}

const RESULT_WORDS: Record<Row['result'], string> = {
  passed: 'Passed',
  failed: 'New failure',
  'known-bug': 'Open bug',
  flaky: 'Flaky',
  skipped: 'Not run',
  fixed: 'Bug fixed?',
};

const status = (tone: 'ok' | 'warn' | 'muted', text: string) => `<span class="pill st-${tone}">${esc(text)}</span>`;

/** The strategy's day-90 measures that a test run can show, with the trend across recorded runs. */
function progress(history: RunSummary[]): string {
  const now = history[history.length - 1];
  const runsWithNoise = history.filter((r) => r.nonProductFailures > 0).length;
  const noiseShare = runsWithNoise / history.length;
  const ep = now.endpoints;
  const sev = (['critical', 'high', 'medium', 'low'] as const).filter((s) => now.bugsBySeverity[s]).map((s) => `${now.bugsBySeverity[s]} ${s}`);
  const rows: [string, string, string, string, string][] = [
    ['Test runs failing for reasons other than a product bug', `${runsWithNoise} of ${history.length} runs (${now.nonProductFailures} test(s) this run)`,
      sparkline(history.map((r) => r.nonProductFailures), 'Tests'), 'Under 2% of runs',
      noiseShare < 0.02 ? status('ok', 'on track') : status('warn', `${Math.round(noiseShare * 100)}% of runs`)],
    ['Top-3 endpoints tested for every role', `${ep.everyRole} of ${ep.total} (${ep.checksRun} of ${ep.checks} role checks)`,
      sparkline(history.map((r) => r.endpoints.everyRole), 'Endpoints'), '100%',
      ep.everyRole === ep.total ? status('ok', 'met') : status('warn', `${ep.total - ep.everyRole} to go`)],
    ['Open bugs, by severity', sev.length ? sev.join(' · ') : 'none approved yet', sparkline(history.map((r) => r.openBugs), 'Failing tests on open bugs'),
      'Tracked', status('muted', 'tracked')],
    // Supporting number, not a day-90 measure: the old suite took 38 minutes.
    ['Suite duration (supporting)', `${now.durationS} s`, sparkline(history.map((r) => r.durationS), 'Seconds'), 'Old suite: 38 min', status('muted', 'tracked')],
    ['Triage proposals accepted unchanged', now.triage.decided ? `${now.triage.acceptedUnchanged} of ${now.triage.decided}` : 'no reviews yet', '',
      'Tracked weekly', status('muted', 'tracked')],
  ];
  return `<h2>Progress</h2>
<p class="legend">Day-90 measures from the test strategy that a test run can show, over the last ${history.length} recorded run(s).</p>
<div class="scroll"><table><thead><tr><th>Measure</th><th>Now</th><th>Trend</th><th>Day-90 target</th><th>Status</th></tr></thead><tbody>
${rows.map((r) => `<tr><th>${r[0]}</th><td>${r[1]}</td><td class="trend">${r[2]}</td><td>${r[3]}</td><td>${r[4]}</td></tr>`).join('')}
</tbody></table></div>
<p class="legend">Not shown, because a test run can't measure them: production bugs per release (bug tracker), releases late because of testing (release calendar), and tester time on exploratory, security, and performance work (sprint records). Skipped role checks have a stated reason in the README.</p>`;
}

function runHistory(history: RunSummary[]): string {
  const recent = history.slice(-10).reverse();
  return `<h2>Recent runs</h2><div class="scroll"><table><thead><tr><th>Started</th><th>Commit</th><th>Where</th><th class="num">Duration</th><th class="num">Passed</th><th class="num">New failures</th><th class="num">Failing on open bugs</th><th class="num">Flaky</th></tr></thead><tbody>${recent
    .map((r) => `<tr><td>${esc(new Date(r.at).toLocaleString('en-US', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' }))} UTC</td><td><code>${esc(r.commit ?? '-')}</code></td><td>${r.source}</td><td class="num">${r.durationS} s</td><td class="num">${r.passed}</td><td class="num">${r.newFailures}</td><td class="num">${r.openBugs}</td><td class="num">${r.flaky}</td></tr>`)
    .join('')}</tbody></table></div>`;
}

/** The ZAP baseline scan: undecided findings first, then open security bugs, dismissals, and low or informational. */
function security(zap: ZapSummary | undefined): string {
  if (!zap) return '<h2>Security scan (OWASP ZAP baseline)</h2><p>Not run this time (<code>SKIP_ZAP=1</code>, or the scan failed: see the run log).</p>';
  const row = (f: ZapSummary['reported'][number], state: string, note = '') =>
    `<tr><td>${state}</td><td><span class="pill sev-${f.risk === 'informational' ? 'low' : f.risk}">${f.risk}</span></td><td>${esc(f.name)}${f.cwe ? ` <span class="legend">CWE-${f.cwe}</span>` : ''}</td><td class="num">${f.count}</td><td><code>${esc(f.example)}</code></td><td>${state.includes('needs a person') ? '<code>yarn review</code>' : esc(note)}</td></tr>`;
  const rows = [
    ...zap.newFindings.map((f) => row(f, status('warn', 'needs a person'))),
    ...zap.bugs.map((f) => row(f, status('warn', 'open bug'), `${f.decision.decidedBy} · ${f.decision.decidedOn}${f.decision.reason ? ` · ${f.decision.reason}` : ''}`)),
    ...zap.dismissed.map((f) => row(f, status('muted', 'dismissed'), `${f.decision.reason} (${f.decision.decidedBy} · ${f.decision.decidedOn})`)),
    ...zap.reported.map((f) => row(f, status('muted', 'reported'))),
  ];
  const notSeen = zap.notSeen.length
    ? `<p class="legend">Decided earlier but not raised this scan (fixed, or the spider didn't reach it): ${zap.notSeen.map((d) => esc(d.name)).join(', ')}.</p>`
    : '';
  return `<h2>Security scan (OWASP ZAP baseline)</h2>
<p class="legend">ZAP ${esc(zap.zapVersion)}, passive rules only, against the local app. Medium and high findings fail the run until a person files or dismisses them. <a href="zap/zap.html">Full ZAP report</a></p>
<div class="scroll"><table><thead><tr><th>Status</th><th>Risk</th><th>Finding</th><th class="num">URLs</th><th>Example</th><th>Decision</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>${notSeen}`;
}

/** Recorded runs plus this one, without writing anything. */
function historyWithCurrent(): RunSummary[] {
  const now = summarize();
  return [...readHistory().filter((r) => r.at !== now.at), now].sort((a, b) => a.at.localeCompare(b.at));
}

/** The whole page as one HTML string: no framework, no external assets, so it opens from disk or Pages. */
export function buildReport(history: RunSummary[] = historyWithCurrent()): string {
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

  const zap = readSummary();
  const zapNew = zap?.newFindings.length ?? 0;
  const mismatched = new Set(severityMismatches(bugs).map((b) => b.id));
  const tiles = [
    ['Passed', count('passed'), 'ok'],
    ['New failures', count('failed'), count('failed') ? 'bad' : 'ok'],
    ['Open bugs', count('known-bug'), count('known-bug') ? 'warn' : 'ok'],
    ['Flaky', count('flaky'), count('flaky') ? 'warn' : 'ok'],
    ['Bug fixed?', count('fixed'), count('fixed') ? 'warn' : 'ok'],
    ['Skipped', count('skipped'), 'muted'],
    ['New scan findings', zap ? zapNew : '–', !zap ? 'muted' : zapNew ? 'bad' : 'ok'],
    ['Severity off score', mismatched.size, mismatched.size ? 'bad' : 'ok'],
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
        const head = `${role} · ${ep.method} ${ep.path}`;
        if (!hits.length) return `<td class="cell none" tabindex="0" data-tip="${esc(`${head}\nNo test covers this role yet`)}">·</td>`;
        const worst = (['failed', 'fixed', 'flaky', 'known-bug', 'skipped', 'passed'] as const).find((res) => hits.some((h) => h.result === res))!;
        const expect = allows(ep, role) ? 'allowed' : 'refused';
        // Worst results first, so the test that colored the cell is the first one listed.
        const order = ['failed', 'fixed', 'flaky', 'known-bug', 'skipped', 'passed'];
        const listed = [...hits].sort((x, y) => order.indexOf(x.result) - order.indexOf(y.result));
        // The spec file names the kind of check (access-matrix, isolation, auth) and separates same-named tests.
        const lines = listed.slice(0, 5).map((h) => `${RESULT_WORDS[h.result]}: ${h.file.replace(/^.*\/|\.spec\.ts$/g, '')} › ${h.title}`);
        if (listed.length > 5) lines.push(`and ${listed.length - 5} more`);
        const tip = [head, `Should be ${expect}`, ...lines].join('\n');
        return `<td class="cell ${worst}" tabindex="0" data-tip="${esc(tip)}">${allows(ep, role) ? '✓' : '✗'}</td>`;
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
    return `<tr><td>${b.id}<br><span class="legend">${esc(b.jira)}</span></td><td><span class="pill sev-${b.severity}">${b.severity}</span><br><span class="legend">I${b.impact} × L${b.likelihood} = ${b.impact * b.likelihood}</span>${mismatched.has(b.id) ? '<br><span class="pill bad">not the score\'s band</span>' : ''}</td><td>${b.area}</td><td>${esc(b.title)}</td><td class="num">${failing}${fixed ? ` <span class="pill fixed">${fixed} now pass</span>` : ''}</td><td>${esc(b.approvedBy)} · ${b.approvedOn}${b.rerated?.length ? ((r) => `<br><span class="legend">re-scored I${r.impact} × L${r.likelihood}, ${r.from} → ${r.to} by ${esc(r.by)} · ${r.on}: ${esc(r.reason)}</span>`)(b.rerated[b.rerated.length - 1]) : ''}</td></tr>`;
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
.pill{display:inline-block;white-space:nowrap;padding:1px 8px;border-radius:99px;font-size:12px;background:#eef1f4}.pill.product-bug,.pill.sev-critical,.pill.bad{background:#fde8e6;color:var(--bad)}
.pill.test-bug,.pill.sev-high,.pill.sev-medium{background:#fdf1d8;color:var(--warn)}.pill.flaky{background:#efe6fb;color:#6b3fa0}.pill.environment{background:#e3eefa;color:var(--accent)}
.pill.fixed,.pill.st-ok{background:#e6f4ec;color:var(--ok)}.pill.st-warn{background:#fdf1d8;color:var(--warn)}.pill.st-muted{color:var(--muted)}
.cell[data-tip]{cursor:help}.cell:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
#tip{position:fixed;z-index:10;max-width:min(380px,calc(100vw - 16px));white-space:pre-line;background:var(--ink);color:#fff;font-size:12.5px;line-height:1.45;padding:8px 10px;border-radius:6px;box-shadow:0 4px 14px rgba(0,0,0,.18);pointer-events:none}
.trend{color:var(--accent);width:140px}.spark{display:block}tbody th{font-weight:600}.legend{color:var(--muted);font-size:13px}a{color:var(--accent)}
</style></head><body><main>
<h1>Juice Shop test run</h1>
<p class="sub">${esc(new Date(stats.startTime).toLocaleString())} · ${(stats.duration / 1000).toFixed(0)} s · ${rows.length} tests · <a href="playwright/index.html">Playwright report with traces</a> · <a href="${process.env.GITHUB_REPOSITORY ? `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${process.env.GITHUB_REPOSITORY}/blob/main/docs/coverage.md` : '../docs/coverage.md'}">coverage map</a></p>
<section class="tiles">${tiles.map(([label, n, tone]) => `<div class="tile ${tone}"><b>${n}</b>${label}</div>`).join('')}</section>

${progress(history)}

<h2>Waiting for a person</h2>
<p class="legend">The triage agent (${esc(triage?.provider ?? 'not run')}) grouped new failures and proposed a cause for each group. Nothing is filed until someone decides it in <code>yarn review</code>.</p>
${pendingRows.length ? `<div class="scroll"><table><thead><tr><th>Likely cause</th><th>Tests</th><th>Example</th><th>Evidence (quoted from the failure)</th><th>Confidence</th></tr></thead><tbody>${pendingRows.join('')}</tbody></table></div>` : '<p>Nothing to review.</p>'}

<h2>By risk area</h2>
<table><thead><tr><th>Area</th><th class="num">Tests</th><th class="num">Passed</th><th class="num">New failures</th><th class="num">Open bugs</th><th class="num">Flaky</th></tr></thead><tbody>${byArea.join('')}</tbody></table>

<h2>Open bugs</h2>
<p class="legend">Severity is impact × likelihood, each 1–5: 20+ critical, 12+ high, 6+ medium, else low.${mismatched.size ? ` ${mismatched.size} bug(s) don't match their score; <code>yarn review</code> starts with them.` : ''}</p>
${bugRows.length ? `<div class="scroll"><table><thead><tr><th>Bug</th><th>Severity</th><th>Area</th><th>Title</th><th class="num">Failing tests</th><th>Approved</th></tr></thead><tbody>${bugRows.join('')}</tbody></table></div>` : '<p>No approved bugs yet.</p>'}

${security(zap)}

<h2>Coverage: every endpoint, every role</h2>
<p class="legend">✓ the role may call it · ✗ it must be refused · green as intended · amber open bug · red new failure · purple flaky · grey not run. Hover or tap a cell to see its tests.</p>
${grid.join('')}

${runHistory(history)}
</main>
<div id="tip" role="tooltip" hidden></div>
<script>
// Fixed position, so the tip isn't clipped by the scrolling table wrappers.
const tip = document.getElementById('tip');
function show(cell) {
  tip.textContent = cell.dataset.tip;
  tip.hidden = false;
  const c = cell.getBoundingClientRect(), t = tip.getBoundingClientRect();
  const x = Math.min(Math.max(8, c.left + c.width / 2 - t.width / 2), innerWidth - t.width - 8);
  const y = c.top - t.height - 6 < 8 ? c.bottom + 6 : c.top - t.height - 6;
  tip.style.left = x + 'px';
  tip.style.top = y + 'px';
}
const hide = () => { tip.hidden = true; };
document.addEventListener('mouseover', (e) => { const c = e.target.closest('[data-tip]'); c ? show(c) : hide(); });
document.addEventListener('focusin', (e) => { const c = e.target.closest('[data-tip]'); if (c) show(c); });
document.addEventListener('focusout', hide);
addEventListener('scroll', hide, true);
</script>
</body></html>`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  writeFileSync('reports/index.html', buildReport());
  console.log('wrote reports/index.html');
}
