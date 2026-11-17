/**
 * Failure triage with a person in the loop.
 *
 *   yarn triage                          propose a category for each failure group (heuristic, offline)
 *   TRIAGE_PROVIDER=claude yarn triage   same, classified by Claude through the local `claude` CLI
 *   yarn triage:review                   a person accepts, changes, or rejects each proposal
 *   yarn triage:rate                     a person re-scores an open bug's impact and likelihood, with a reason
 *   yarn review                          the same reviews on a local web page (review-page.ts)
 *
 * Proposals are only suggestions. Nothing reaches known-bugs.json until a reviewer accepts it.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBug, isScore, jiraKey, loadKnownBugs, rescore, severityFor, severityMismatches, type KnownBug } from '../src/known-bugs';
import { collectFailures, groupFailures } from './collect';
import { classify } from './heuristic';
import { classifyWithModel } from './model';
import { findCandidates, searchBugs } from './duplicates';
import { CATEGORIES, type Category, type Decision, type FailureGroup, type Proposal } from './types';
import {
  CAUSES, OUT, PROPOSALS, SCORE_HELP, appendDecision, areaOf, fileBug, loadRun, pendingProposals, reviewer, ruleOf, saveBugs, today,
  type BugTarget, type TriageRun,
} from './review-core';

export type { TriageRun } from './review-core';

/** Collects, groups, and classifies the last run's failures, then writes the proposals for review. Applies nothing. */
export function propose(provider = process.env.TRIAGE_PROVIDER ?? 'heuristic', reportPath?: string): TriageRun {
  const groups = groupFailures(collectFailures(reportPath));
  const proposals = groups.map((g) => (provider === 'claude' ? classifyWithModel(g) : classify(g)));
  const run = { provider, createdAt: new Date().toISOString(), groups, proposals };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(PROPOSALS, JSON.stringify(run, null, 2));
  return run;
}

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
  console.log(`  rule:      ${ruleOf(group)}`);
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
  const run = loadRun();
  const pending = pendingProposals(run);
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
      let target: BugTarget;
      if (picked) target = { existing: picked.id };
      else {
        // A new bug is reported first: its Jira key comes before the title. A key already on file means the same bug.
        const jira = await askJira(rl);
        const onFile = findBug(bugs, jira);
        if (onFile) {
          console.log(`  ${jira} is ${onFile.id}; adding this group to it`);
          target = { existing: onFile.id };
        } else {
          const title = (await rl.question(`  bug title [${p.suggestedTitle ?? group.failures[0].title}]: `)).trim() || p.suggestedTitle || group.failures[0].title;
          const impact = await askScore(rl, 'impact');
          const likelihood = await askScore(rl, 'likelihood');
          console.log(`  severity:  ${severityFor(impact, likelihood)} (I${impact} × L${likelihood} = ${impact * likelihood})`);
          target = { jira, title, impact, likelihood };
        }
      }
      const filed = fileBug(bugs, group, target, who, today());
      saveBugs(filed.bugs);
      decision.bugId = filed.bugId;
      if (filed.created) decision.title = filed.created.title;
      console.log(`  recorded as ${decision.bugId}`);
    }
    appendDecision(decision);
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
  saveBugs(bugs.map((b) => (b.id === bug.id ? rescore(b, impact, likelihood, reason, who, today()) : b)));
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
      saveBugs(bugs.map((b) => (b.id === bug.id ? rescore(b, bug.impact, bug.likelihood, `matches I${bug.impact} × L${bug.likelihood} = ${bug.impact * bug.likelihood}`, who, today()) : b)));
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

// Only as the entry script: run-all imports propose() and passes its own arguments.
const command = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) ? process.argv[2] : undefined;
if (command === 'propose') summary(propose());
else if (command === 'review') await review();
else if (command === 'rate') await rate();
else if (command) throw new Error(`unknown command ${command}`);
