/**
 * Failure triage with a person in the loop.
 *
 *   yarn triage                          propose a category for each failure group (heuristic, offline)
 *   TRIAGE_PROVIDER=claude yarn triage   same, classified by Claude through the local `claude` CLI
 *   yarn triage:review                   a person accepts, changes, or rejects each proposal
 *   yarn triage:rate                     a person changes an open bug's severity, with a reason
 *
 * Proposals are only suggestions. Nothing reaches known-bugs.json until a reviewer accepts it.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { KNOWN_BUGS_PATH, findBug, isScore, jiraKey, loadKnownBugs, rescore, severityFor, severityMismatches, type KnownBug } from '../src/known-bugs';
import { endpoint as catalogEndpoint } from '../src/catalog';
import { collectFailures, groupFailures } from './collect';
import { classify } from './heuristic';
import { classifyWithModel } from './model';
import { findCandidates, searchBugs } from './duplicates';
import { CATEGORIES, type Category, type Decision, type FailureGroup, type Proposal } from './types';

// Proposals are per run (regenerated, not committed); decisions are the committed audit trail.
const OUT = 'reports/triage';
const PROPOSALS = `${OUT}/proposals.json`;
const DECISIONS = 'triage/decisions.jsonl';

/** One triage pass: which provider ran, the groups, and one proposal per group. */
export interface TriageRun {
  provider: string;
  createdAt: string;
  groups: FailureGroup[];
  proposals: Proposal[];
}

/** Collects, groups, and classifies the last run's failures, then writes the proposals for review. Applies nothing. */
export function propose(provider = process.env.TRIAGE_PROVIDER ?? 'heuristic', reportPath?: string): TriageRun {
  const groups = groupFailures(collectFailures(reportPath));
  const proposals = groups.map((g) => (provider === 'claude' ? classifyWithModel(g) : classify(g)));
  const run = { provider, createdAt: new Date().toISOString(), groups, proposals };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(PROPOSALS, JSON.stringify(run, null, 2));
  return run;
}

/** The name recorded on every decision and approved bug: REVIEWER, else the git user name. */
function reviewer(): string {
  if (process.env.REVIEWER) return process.env.REVIEWER;
  try {
    return execFileSync('git', ['config', 'user.name'], { encoding: 'utf8' }).trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

function nextBugId(bugs: KnownBug[]): string {
  const max = Math.max(0, ...bugs.map((b) => Number(b.id.replace('BUG-', ''))));
  return `BUG-${String(max + 1).padStart(3, '0')}`;
}

/** The intended access rule in plain words, so a reviewer can judge without opening src/catalog.ts. */
function accessRule(id: string): string {
  const ep = catalogEndpoint(id);
  const who = ep.access === 'public' ? 'anyone, including signed-out visitors, may call it'
    : ep.access === 'authenticated' ? 'any signed-in user may call it'
      : ep.access === 'owner' ? "only the customer who owns the record; others must be refused (401/403)"
        : ep.access === 'nobody' ? 'no one may call it through the API; every caller must be refused (401/403)'
          : `only ${ep.access.join(' and ')} may call it; everyone else must be refused (401/403)`;
  return `${ep.method} ${ep.path}: ${who}${ep.note ? ` (${ep.note})` : ''}`;
}

/**
 * The test's own risk area (named in its describe title), else its endpoint's. An R3 login test that probes
 * a basket endpoint with a forged token is an R3 bug, not R1. Matches the report's by-area table.
 */
function areaOf(f: FailureGroup['failures'][number]): string {
  return f.key.match(/\bR[123]\b/)?.[0] ?? (f.endpoint ? catalogEndpoint(f.endpoint).area : 'unknown');
}

/** What each likely cause means and what happens when it's accepted, shown once at the top of a review. */
const CAUSES: Record<Category, string> = {
  'product-bug': 'the app broke a rule      → becomes a tracked bug (known-bugs.json); developers fix the product',
  'test-bug': 'the test itself is wrong  → recorded for the test owner to fix; no bug filed',
  environment: 'app or network was down   → recorded; re-run, nobody\'s code is at fault',
  flaky: 'passed on retry           → recorded; the test needs fixing, not the product',
  'needs-human': 'not enough evidence       → open the trace and decide',
};

function legend(who: string, count: number): void {
  console.log(`${count} group(s) to review as ${who}. Each group is one defect, seen by one or more tests.`);
  console.log('For each: is the rule right, and does the evidence show it broken? Then decide the likely cause:');
  for (const c of CATEGORIES) console.log(`  ${c.padEnd(12)} ${CAUSES[c]}`);
  console.log('Answers: [a] agree with the likely cause  [c] pick a different cause  [r] reject: not a real requirement, nothing filed');
  console.log('         [s] decide later  [q] quit (every answer so far is saved)');
}

function show(group: FailureGroup, p: Proposal, index: number, total: number): void {
  const f = group.failures[0];
  console.log(`\n[${index + 1}/${total}] ${group.id}  ${group.failures.length} failing test(s), one shared defect`);
  // A role-matrix test checks the catalog's access rule; a behavior test's title states its own rule.
  const matrix = f.file.includes('access-matrix');
  console.log(`  rule:      ${matrix && f.endpoint ? accessRule(f.endpoint) : `${f.title} (the test title is the requirement)`}`);
  console.log(`  tests:     ${group.failures.slice(0, 5).map((x) => x.key).join('\n             ')}${group.failures.length > 5 ? `\n             … and ${group.failures.length - 5} more` : ''}`);
  console.log(`  roles:     ${[...new Set(group.failures.map((x) => x.role ?? '-'))].join(', ')}`);
  const by = p.source === 'model' ? 'Claude' : 'offline rules';
  console.log(`  likely cause: ${p.category} (${p.confidence} confidence, ${by})${p.downgradedBecause ? `  [downgraded: ${p.downgradedBecause}]` : ''}`);
  console.log(`  evidence:  ${p.evidence}`);
  console.log(`  why:       ${p.reasoning}`);
  if (p.suggestedTitle) console.log(`  bug title: ${p.suggestedTitle}`);
  // The risk area's rank is a starting point; the reviewer's impact × likelihood scores set the severity.
  if (p.suggestedSeverity) console.log(`  severity:  ${p.suggestedSeverity} for risk area ${areaOf(f)}; your impact × likelihood scores decide`);
}

/**
 * The human gate. Shows each undecided group with its evidence, and records the reviewer's answer.
 * Groups decided on an earlier run are skipped, so re-running only asks about new defects.
 */
async function review(): Promise<void> {
  if (!existsSync(PROPOSALS)) throw new Error('No proposals yet. Run `yarn triage` first.');
  const run = JSON.parse(readFileSync(PROPOSALS, 'utf8')) as TriageRun;
  const decided = new Set(
    existsSync(DECISIONS) ? readFileSync(DECISIONS, 'utf8').trim().split('\n').filter(Boolean).map((l) => (JSON.parse(l) as Decision).groupId) : [],
  );
  const pending = run.proposals.filter((p) => !decided.has(p.groupId));
  const who = reviewer();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  if (!(await severityCheck(rl, who))) {
    rl.close();
    return;
  }
  if (!pending.length) console.log('No new failure groups to review.');
  else legend(who, pending.length);

  for (const [i, p] of pending.entries()) {
    const group = run.groups.find((g) => g.id === p.groupId)!;
    show(group, p, i, pending.length);
    const answer = await askChoice(rl, ['a', 'c', 'r', 's', 'q']);
    if (answer === 'q') break;
    // Decide later: the group stays undecided and comes back next time.
    if (answer === 's') continue;

    let category: Category = p.category;
    if (answer === 'c') {
      const options = CATEGORIES.map((c, n) => `${n + 1} ${c}`).join('  ');
      const raw = (await rl.question(`  likely cause (${options}): `)).trim();
      const picked = (CATEGORIES[Number(raw) - 1] ?? raw) as Category;
      if (!CATEGORIES.includes(picked)) {
        console.log('  not one of the causes listed; left undecided');
        continue;
      }
      category = picked;
    }
    const decision: Decision = {
      groupId: p.groupId,
      verdict: answer === 'a' ? 'accepted' : answer === 'c' ? 'changed' : 'rejected',
      category,
      reviewer: who,
      decidedAt: new Date().toISOString(),
    };

    // Only an accepted product bug changes test outcomes: its tests become expected failures.
    // Several groups can be one defect, so the reviewer may add them to an existing bug.
    if (decision.verdict !== 'rejected' && category === 'product-bug') {
      const bugs = loadKnownBugs();
      const picked = await pickExisting(rl, group, p.suggestedTitle ?? group.failures[0].title, bugs);
      // A new bug is reported first: its Jira key comes before the title. A key already on file means the same bug.
      const jira = picked ? undefined : await askJira(rl);
      const bug = picked ?? (jira ? findBug(bugs, jira) : undefined);
      if (bug && !picked) console.log(`  ${jira} is ${bug.id}; adding this group to it`);
      const keys = group.failures.map((f) => f.key);
      const endpoints = [...new Set(group.failures.map((f) => f.endpoint).filter((e): e is string => Boolean(e)))];
      if (bug) {
        bug.tests = [...new Set([...bug.tests, ...keys])];
        bug.endpoints = [...new Set([...(bug.endpoints ?? []), ...endpoints])];
        decision.bugId = bug.id;
      } else if (jira) {
        const title = (await rl.question(`  bug title [${p.suggestedTitle ?? group.failures[0].title}]: `)).trim() || p.suggestedTitle || group.failures[0].title;
        const impact = await askScore(rl, 'impact');
        const likelihood = await askScore(rl, 'likelihood');
        const severity = severityFor(impact, likelihood);
        console.log(`  severity:  ${severity} (I${impact} × L${likelihood} = ${impact * likelihood})`);
        const created: KnownBug = {
          id: nextBugId(bugs),
          jira,
          title,
          severity,
          impact,
          likelihood,
          area: areaOf(group.failures[0]),
          tests: keys,
          endpoints,
          approvedBy: who,
          approvedOn: today(),
        };
        bugs.push(created);
        decision.bugId = created.id;
        decision.title = title;
      }
      save(bugs);
      console.log(`  recorded as ${decision.bugId}`);
    }
    appendFileSync(DECISIONS, `${JSON.stringify(decision)}\n`);
  }
  rl.close();
}

/** One of the listed answers; anything else says so and asks again, so a typo never skips an item. */
async function askChoice<T extends string>(rl: ReturnType<typeof createInterface>, allowed: readonly T[]): Promise<T> {
  for (;;) {
    const raw = (await rl.question('  > ')).trim().toLowerCase();
    if ((allowed as readonly string[]).includes(raw)) return raw as T;
    console.log(`  not an answer here; type ${allowed.map((a) => (a ? `[${a}]` : '[Enter]')).join(' ')}`);
  }
}

/**
 * Offers the approved bugs this group most likely duplicates, with the reason for each, so the
 * reviewer picks a number instead of recalling an id. Any other word searches open bug titles.
 * Enter files a new bug; typing an id still works.
 */
async function pickExisting(rl: ReturnType<typeof createInterface>, group: FailureGroup, title: string, bugs: KnownBug[]): Promise<KnownBug | undefined> {
  const candidates = findCandidates(group, title, bugs);
  let choices = candidates.map((c) => c.bug);
  if (candidates.length) {
    console.log('  possibly the same defect as an open bug:');
    candidates.forEach((c, n) => console.log(`    ${n + 1}  ${c.bug.id}  ${c.bug.jira}  ${c.bug.title}\n         ${c.reasons.join(' · ')}`));
  } else if (bugs.length) {
    console.log(`  no open bug looks like this one (${bugs.length} checked by endpoint and title)`);
  }
  for (;;) {
    const pick = choices.length ? `[${choices.length === 1 ? '1' : `1-${choices.length}`}], ` : '';
    const raw = (await rl.question(`  add to ${pick}a bug id or Jira key, or a word to search titles; Enter for a new bug: `)).trim();
    if (!raw) return undefined;
    const picked = (/^\d+$/.test(raw) ? choices[Number(raw) - 1] : undefined) ?? findBug(bugs, raw);
    if (picked) return picked;
    const found = searchBugs(raw, bugs);
    if (!found.length) {
      console.log(`  no open bug title contains "${raw}"`);
      continue;
    }
    choices = found;
    found.forEach((b, n) => console.log(`    ${n + 1}  ${b.id}  ${b.jira}  ${b.title}`));
  }
}

/** The Jira ticket a new bug is reported in. Required: every approved bug has a ticket. */
async function askJira(rl: ReturnType<typeof createInterface>): Promise<string> {
  for (;;) {
    const key = jiraKey(await rl.question('  Jira key it is reported in (e.g. SHOP-240): '));
    if (key) return key;
    console.log('  not a Jira key; expected PROJECT-123');
  }
}

const SCORE_HELP = {
  impact: 'harm to customers, money, or the business; 5 = every customer\'s data or money',
  likelihood: 'how easily it is hit; 5 = a plain request, 3 = needs a specific condition, 1 = unlikely',
} as const;

/** A 1–5 score. Enter keeps `current` when there is one; anything else asks again. */
async function askScore(rl: ReturnType<typeof createInterface>, kind: keyof typeof SCORE_HELP, current?: number): Promise<number> {
  for (;;) {
    const raw = (await rl.question(`  ${kind} 1–5 (${SCORE_HELP[kind]})${current ? ` [${current}]` : ''}: `)).trim();
    if (!raw && current) return current;
    const n = Number(raw);
    if (raw && isScore(n)) return n;
    console.log('  a whole number from 1 to 5');
  }
}

const today = (): string => new Date().toISOString().slice(0, 10);

function save(bugs: KnownBug[]): void {
  writeFileSync(KNOWN_BUGS_PATH, `${JSON.stringify({ bugs }, null, 2)}\n`);
}

/** New scores for one bug, with a reason; the severity follows. Returns false if nothing was changed. */
async function changeScores(rl: ReturnType<typeof createInterface>, bug: KnownBug, who: string): Promise<boolean> {
  const impact = await askScore(rl, 'impact', isScore(bug.impact) ? bug.impact : undefined);
  const likelihood = await askScore(rl, 'likelihood', isScore(bug.likelihood) ? bug.likelihood : undefined);
  const to = severityFor(impact, likelihood);
  if (impact === bug.impact && likelihood === bug.likelihood && to === bug.severity) {
    console.log('  unchanged');
    return false;
  }
  console.log(`  I${impact} × L${likelihood} = ${impact * likelihood} → ${to}`);
  const reason = (await rl.question('  why? ')).trim();
  if (!reason) {
    console.log('  a change needs a reason; left unchanged');
    return false;
  }
  const bugs = loadKnownBugs();
  save(bugs.map((b) => (b.id === bug.id ? rescore(b, impact, likelihood, reason, who, today()) : b)));
  console.log(to === bug.severity ? `  ${bug.id}: scores recorded, still ${to}` : `  ${bug.id}: ${bug.severity} → ${to}`);
  return true;
}

/**
 * Runs before the groups: every bug's severity must be the band of its impact × likelihood.
 * A mismatch fails `yarn all`, so it can't be missed. Returns false if the reviewer quits.
 */
async function severityCheck(rl: ReturnType<typeof createInterface>, who: string): Promise<boolean> {
  const mismatched = severityMismatches(loadKnownBugs());
  if (!mismatched.length) return true;
  console.log(`Severity check: ${mismatched.length} open bug(s) whose severity doesn't match impact × likelihood (20+ critical, 12+ high, 6+ medium).`);
  console.log('Answers: [Enter] set the severity the scores give  [s] change the scores  [l] later (the run stays red)  [q] quit');
  for (const bug of mismatched) {
    const scored = isScore(bug.impact) && isScore(bug.likelihood);
    const band = scored ? severityFor(bug.impact, bug.likelihood) : undefined;
    console.log(`\n  ${bug.id} ${bug.jira}  ${bug.title}`);
    console.log(scored ? `  registered ${bug.severity}; I${bug.impact} × L${bug.likelihood} = ${bug.impact * bug.likelihood} → ${band}` : `  registered ${bug.severity}; no valid scores yet`);
    const answer = await askChoice(rl, ['', 's', 'l', 'q']);
    if (answer === 'q') return false;
    if (answer === 'l') continue;
    if (answer === '' && band) {
      const bugs = loadKnownBugs();
      save(bugs.map((b) => (b.id === bug.id ? rescore(b, bug.impact, bug.likelihood, `matches I${bug.impact} × L${bug.likelihood} = ${bug.impact * bug.likelihood}`, who, today()) : b)));
      console.log(`  ${bug.id}: ${bug.severity} → ${band}`);
    } else await changeScores(rl, bug, who);
  }
  console.log('');
  return true;
}

/**
 * Re-scores open bugs: severity is a review decision, so it gets a name, date, and reason like the others.
 * Recorded on the bug itself, not in decisions.jsonl, so triage agreement measures stay about triage.
 */
async function rate(): Promise<void> {
  const who = reviewer();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(`Re-scoring open bugs as ${who}. Severity follows impact × likelihood. Enter a bug id or Jira key, or Enter alone to finish.`);
  for (;;) {
    const id = (await rl.question('\n  bug id or Jira key: ')).trim();
    if (!id) break;
    const bug = findBug(loadKnownBugs(), id);
    if (!bug) {
      console.log(`  no open bug ${id}`);
      continue;
    }
    console.log(`  ${bug.id} (${bug.jira}) [${bug.severity}, I${bug.impact} × L${bug.likelihood}, ${bug.area}] ${bug.title}`);
    await changeScores(rl, bug, who);
  }
  rl.close();
}

/** Console summary after `yarn triage`: counts per proposed category. */
function summary(run: TriageRun): void {
  const counts = Object.fromEntries(CATEGORIES.map((c) => [c, run.proposals.filter((p) => p.category === c).length]));
  const tests = run.groups.reduce((n, g) => n + g.failures.length, 0);
  console.log(`triage (${run.provider}): ${tests} failing test(s) in ${run.groups.length} group(s)`, counts);
  console.log(`proposals written to ${PROPOSALS}; nothing is applied until someone runs \`yarn triage:review\``);
}

const command = process.argv[2];
if (command === 'propose') summary(propose());
else if (command === 'review') await review();
else if (command === 'rate') await rate();
else if (command) throw new Error(`unknown command ${command}`);
