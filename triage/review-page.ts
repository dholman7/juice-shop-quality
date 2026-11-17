/**
 * The review on a local web page, for testers who'd rather click than answer terminal prompts.
 *
 *   yarn review     starts on http://127.0.0.1:4321 and opens the browser; Ctrl+C stops it
 *
 * Same decisions and files as the terminal reviews: severity check, failure groups, ZAP findings.
 * Listens on this machine only, and accepts changes only from its own page.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadKnownBugs, rescore, severityFor, severityMismatches, isScore } from '../src/known-bugs';
import { findCandidates, searchBugs } from './duplicates';
import { CATEGORIES, type Category, type Decision } from './types';
import {
  CAUSES, SCORE_HELP, appendDecision, areaOf, fileBug, loadRun, pendingProposals, reviewer, ruleOf, saveBugs, today, type BugTarget,
} from './review-core';
import { readSummary, recordDecision, undecided } from '../security/zap';
import { isDemo } from '../src/review-state';

const PORT = Number(process.env.REVIEW_PORT ?? 4321);
const PAGE = fileURLToPath(new URL('./review-page.html', import.meta.url));

class BadRequest extends Error {}

/** Everything the page shows: what still needs a decision, and the open bugs to search. */
function state() {
  const bugs = loadKnownBugs();
  let run;
  try {
    run = loadRun();
  } catch {
    run = undefined;
  }
  const groups = (run ? pendingProposals(run) : []).map((p) => {
    const group = run!.groups.find((g) => g.id === p.groupId)!;
    return {
      groupId: p.groupId,
      rule: ruleOf(group),
      tests: group.failures.map((f) => f.key),
      roles: [...new Set(group.failures.map((f) => f.role ?? '-'))],
      cause: p.category,
      confidence: p.confidence,
      by: p.source === 'model' ? 'Claude' : 'offline rules',
      downgradedBecause: p.downgradedBecause,
      evidence: p.evidence,
      why: p.reasoning,
      suggestedTitle: p.suggestedTitle ?? group.failures[0].title,
      area: areaOf(group.failures[0]),
      candidates: findCandidates(group, p.suggestedTitle ?? group.failures[0].title, bugs).map((c) => ({
        id: c.bug.id, jira: c.bug.jira, title: c.bug.title, severity: c.bug.severity, reasons: c.reasons,
      })),
    };
  });
  const severity = severityMismatches(bugs).map((b) => ({
    id: b.id, jira: b.jira, title: b.title, severity: b.severity, impact: b.impact, likelihood: b.likelihood,
    band: isScore(b.impact) && isScore(b.likelihood) ? severityFor(b.impact, b.likelihood) : undefined,
  }));
  const summary = readSummary();
  return {
    reviewer: reviewer(),
    hasProposals: Boolean(run),
    severity,
    groups,
    zap: summary ? undecided(summary) : null,
    causes: CAUSES,
    categories: CATEGORIES,
    scoreHelp: SCORE_HELP,
    openBugs: bugs.length,
    demo: isDemo(),
  };
}

function who(body: Record<string, unknown>): string {
  const name = typeof body.reviewer === 'string' ? body.reviewer.trim() : '';
  if (!name || name.length > 80) throw new BadRequest('enter your name as the reviewer');
  return name;
}

/** One failure group: agree, change the cause, or reject. An accepted product bug joins or creates a bug. */
function decide(body: Record<string, unknown>): string {
  const reviewerName = who(body);
  const run = loadRun();
  const proposal = pendingProposals(run).find((p) => p.groupId === body.groupId);
  if (!proposal) throw new BadRequest('that group is already decided; reload the page');
  const group = run.groups.find((g) => g.id === proposal.groupId)!;
  const rejected = body.verdict === 'reject';
  const category = (rejected ? proposal.category : body.category) as Category;
  if (!CATEGORIES.includes(category)) throw new BadRequest('pick a likely cause');
  const decision: Decision = {
    groupId: proposal.groupId,
    verdict: rejected ? 'rejected' : category === proposal.category ? 'accepted' : 'changed',
    category,
    reviewer: reviewerName,
    decidedAt: new Date().toISOString(),
  };
  let message = rejected ? 'rejected: nothing filed' : `recorded as ${category}`;
  if (!rejected && category === 'product-bug') {
    const target = body.target as BugTarget | undefined;
    if (!target || typeof target !== 'object') throw new BadRequest('choose an open bug or file a new one');
    const filed = fileBug(loadKnownBugs(), group, target, reviewerName, today());
    saveBugs(filed.bugs);
    decision.bugId = filed.bugId;
    if (filed.created) decision.title = filed.created.title;
    message = filed.created ? `filed as new bug ${filed.bugId}` : `added to ${filed.bugId}`;
  }
  appendDecision(decision);
  return message;
}

/** New scores for a bug; its severity follows. Same rules as `yarn triage:rate`. */
function rescoreBug(body: Record<string, unknown>): string {
  const reviewerName = who(body);
  const bugs = loadKnownBugs();
  const bug = bugs.find((b) => b.id === body.bugId);
  if (!bug) throw new BadRequest(`no open bug ${String(body.bugId)}`);
  const updated = rescore(bug, Number(body.impact), Number(body.likelihood), String(body.reason ?? ''), reviewerName, today());
  saveBugs(bugs.map((b) => (b.id === bug.id ? updated : b)));
  return `${bug.id}: ${bug.severity} → ${updated.severity}`;
}

/** A ZAP finding: file it as a bug, or dismiss it with a reason. */
function decideFinding(body: Record<string, unknown>): string {
  const reviewerName = who(body);
  const summary = readSummary();
  const finding = summary && undecided(summary).find((f) => f.ref === body.ref && f.risk === body.risk);
  if (!finding) throw new BadRequest('that finding is already decided; reload the page');
  if (body.verdict !== 'bug' && body.verdict !== 'dismissed') throw new BadRequest('file it as a bug or dismiss it');
  recordDecision(finding, body.verdict, String(body.reason ?? ''), reviewerName, today());
  return body.verdict === 'bug' ? 'filed as an open security bug' : 'dismissed';
}

const ACTIONS: Record<string, (body: Record<string, unknown>) => string> = {
  '/api/decide': decide,
  '/api/rescore': rescoreBug,
  '/api/zap': decideFinding,
};

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json'): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : String(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 100_000) throw new BadRequest('request too large');
  }
  try {
    const body = JSON.parse(raw);
    if (body && typeof body === 'object') return body;
  } catch {
    // fall through
  }
  throw new BadRequest('expected a JSON object');
}

const origin = `http://127.0.0.1:${PORT}`;
const hosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

const server = createServer(async (req, res) => {
  try {
    // Another site in the browser can't reach this server by name (DNS rebinding) or send it changes.
    if (!hosts.has(req.headers.host ?? '')) return send(res, 403, { error: 'wrong host' });
    const url = new URL(req.url ?? '/', origin);
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, readFileSync(PAGE, 'utf8'), 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, state());
    if (req.method === 'GET' && url.pathname === '/api/search') {
      const found = searchBugs(url.searchParams.get('q') ?? '', loadKnownBugs()).slice(0, 10);
      return send(res, 200, found.map((b) => ({ id: b.id, jira: b.jira, title: b.title, severity: b.severity })));
    }
    const action = ACTIONS[url.pathname];
    if (req.method === 'POST' && action) {
      const from = req.headers.origin;
      if (!from || !hosts.has(from.replace(/^http:\/\//, ''))) return send(res, 403, { error: 'changes are accepted only from the review page' });
      if (!req.headers['content-type']?.startsWith('application/json')) return send(res, 415, { error: 'expected JSON' });
      return send(res, 200, { message: action(await readBody(req)) });
    }
    send(res, 404, { error: 'not found' });
  } catch (error) {
    // Shown to the reviewer as is: the shared rules' messages (bad Jira key, scores, missing reason) say what to fix.
    send(res, 400, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.on('error', (error: NodeJS.ErrnoException) => {
  console.error(error.code === 'EADDRINUSE' ? `Port ${PORT} is in use. Is the review page already open? Or set REVIEW_PORT.` : error.message);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Review page${isDemo() ? ' (demo: decisions go to .demo/, not the committed files)' : ''}: ${origin}  (Ctrl+C to stop)`);
  if (process.env.NO_OPEN === '1') return;
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  spawn(opener, [origin], { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
});
