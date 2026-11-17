/**
 * Failure triage with a person in the loop.
 *
 *   npm run triage                       propose a category for each failure group (heuristic, offline)
 *   TRIAGE_PROVIDER=claude npm run triage   same, classified by Claude through the local `claude` CLI
 *   npm run triage:review                a person accepts, changes, or rejects each proposal
 *
 * Proposals are only suggestions. Nothing reaches known-bugs.json until a reviewer accepts it.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { KNOWN_BUGS_PATH, loadKnownBugs, type KnownBug } from '../src/known-bugs';
import { endpoint as catalogEndpoint } from '../src/catalog';
import { collectFailures, groupFailures } from './collect';
import { classify } from './heuristic';
import { classifyWithModel } from './model';
import { CATEGORIES, type Category, type Decision, type FailureGroup, type Proposal } from './types';

const OUT = 'reports/triage';
const PROPOSALS = `${OUT}/proposals.json`;
const DECISIONS = 'triage/decisions.jsonl';

export interface TriageRun {
  provider: string;
  createdAt: string;
  groups: FailureGroup[];
  proposals: Proposal[];
}

export function propose(provider = process.env.TRIAGE_PROVIDER ?? 'heuristic', reportPath?: string): TriageRun {
  const groups = groupFailures(collectFailures(reportPath));
  const proposals = groups.map((g) => (provider === 'claude' ? classifyWithModel(g) : classify(g)));
  const run = { provider, createdAt: new Date().toISOString(), groups, proposals };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(PROPOSALS, JSON.stringify(run, null, 2));
  return run;
}

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

function show(group: FailureGroup, p: Proposal, index: number, total: number): void {
  const f = group.failures[0];
  console.log(`\n[${index + 1}/${total}] ${group.id}  ${group.failures.length} test(s)`);
  console.log(`  example:   ${f.key}`);
  console.log(`  roles:     ${[...new Set(group.failures.map((x) => x.role ?? '-'))].join(', ')}`);
  console.log(`  proposal:  ${p.category} (${p.confidence}, ${p.source})${p.downgradedBecause ? `  [downgraded: ${p.downgradedBecause}]` : ''}`);
  console.log(`  evidence:  ${p.evidence}`);
  console.log(`  why:       ${p.reasoning}`);
  if (p.suggestedTitle) console.log(`  bug title: ${p.suggestedTitle} [${p.suggestedSeverity}]`);
}

async function review(): Promise<void> {
  if (!existsSync(PROPOSALS)) throw new Error('No proposals yet. Run `npm run triage` first.');
  const run = JSON.parse(readFileSync(PROPOSALS, 'utf8')) as TriageRun;
  const decided = new Set(
    existsSync(DECISIONS) ? readFileSync(DECISIONS, 'utf8').trim().split('\n').filter(Boolean).map((l) => (JSON.parse(l) as Decision).groupId) : [],
  );
  const pending = run.proposals.filter((p) => !decided.has(p.groupId));
  const who = reviewer();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(`${pending.length} group(s) to review as ${who}. Answers: [a]ccept  [c]hange category  [r]eject  [s]kip  [q]uit`);

  for (const [i, p] of pending.entries()) {
    const group = run.groups.find((g) => g.id === p.groupId)!;
    show(group, p, i, pending.length);
    const answer = (await rl.question('  > ')).trim().toLowerCase();
    if (answer === 'q') break;
    if (answer !== 'a' && answer !== 'c' && answer !== 'r') continue;

    let category: Category = p.category;
    if (answer === 'c') {
      const picked = (await rl.question(`  category (${CATEGORIES.join(' / ')}): `)).trim() as Category;
      if (!CATEGORIES.includes(picked)) {
        console.log('  unknown category; skipped');
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

    if (decision.verdict !== 'rejected' && category === 'product-bug') {
      const bugs = loadKnownBugs();
      const existing = (await rl.question(`  add to an existing bug id, or Enter for a new one: `)).trim();
      const bug = bugs.find((b) => b.id === existing);
      const keys = group.failures.map((f) => f.key);
      if (bug) {
        bug.tests = [...new Set([...bug.tests, ...keys])];
        decision.bugId = bug.id;
      } else {
        const title = (await rl.question(`  bug title [${p.suggestedTitle ?? group.failures[0].title}]: `)).trim() || p.suggestedTitle || group.failures[0].title;
        const ep = group.failures[0].endpoint;
        const created: KnownBug = {
          id: nextBugId(bugs),
          title,
          severity: p.suggestedSeverity ?? 'medium',
          area: ep ? catalogEndpoint(ep).area : 'unknown',
          tests: keys,
          approvedBy: who,
          approvedOn: new Date().toISOString().slice(0, 10),
        };
        bugs.push(created);
        decision.bugId = created.id;
        decision.title = title;
      }
      writeFileSync(KNOWN_BUGS_PATH, `${JSON.stringify({ bugs }, null, 2)}\n`);
      console.log(`  recorded as ${decision.bugId}`);
    }
    appendFileSync(DECISIONS, `${JSON.stringify(decision)}\n`);
  }
  rl.close();
}

function summary(run: TriageRun): void {
  const counts = Object.fromEntries(CATEGORIES.map((c) => [c, run.proposals.filter((p) => p.category === c).length]));
  const tests = run.groups.reduce((n, g) => n + g.failures.length, 0);
  console.log(`triage (${run.provider}): ${tests} failing test(s) in ${run.groups.length} group(s)`, counts);
  console.log(`proposals written to ${PROPOSALS}; nothing is applied until someone runs \`npm run triage:review\``);
}

const command = process.argv[2];
if (command === 'propose') summary(propose());
else if (command === 'review') await review();
else if (command) throw new Error(`unknown command ${command}`);
