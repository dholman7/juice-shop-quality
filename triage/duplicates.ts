/**
 * Finds approved bugs a new failure group may duplicate, so a reviewer picks from a short list
 * instead of remembering bug ids. Deterministic: every suggestion states why it matched.
 * The reviewer still decides; a suggestion is never applied on its own.
 */
import { endpoint as catalogEndpoint } from '../src/catalog';
import type { KnownBug } from '../src/known-bugs';
import type { FailureGroup } from './types';

export interface Candidate {
  bug: KnownBug;
  score: number;
  reasons: string[];
}

const SAME_ENDPOINT_ACCESS = 3;
const SIMILAR_TITLE = 2;
const SAME_ENDPOINT = 1;
const SAME_RESOURCE_ACCESS = 2;
/**
 * Calibrated on the first run's 41 groups. Access failures on one record type (every BasketItems call)
 * usually share one missing ownership check, so that alone is enough to suggest. Behavior rules on one
 * endpoint (empty basket, missing address) are usually separate defects, so they need a similar title too.
 */
const MIN_SCORE = 2;
const MAX_CANDIDATES = 3;

/**
 * The record type an endpoint acts on: the path up to its first id.
 * `/rest/basket/:id/checkout` → `/rest/basket`; `/rest/user/change-password` stays whole, so it
 * doesn't match every other `/rest/user/...` endpoint.
 */
export function resource(path: string): string {
  const id = path.indexOf('/:');
  return (id === -1 ? path : path.slice(0, id)).toLowerCase();
}

// Template words from generated titles and role names: shared by most titles, so they say nothing about the defect.
const STOP = new Set([
  'the', 'and', 'for', 'can', 'not', 'met', 'should', 'only', 'who', 'with', 'instead', 'any', 'call', 'refuses', 'rejects',
  'another', 'record', 'owner', 'isolation', 'api', 'rest', 'get', 'put', 'post', 'patch', 'delete',
  'anonymous', 'customer', 'deluxe', 'accounting', 'admin',
]);
const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)));

/** Role-matrix and isolation tests check who may act; every other spec checks behavior. */
const isAccessCheck = (fileOrKey: string) => /access-matrix|isolation/.test(fileOrKey);

/** Share of words the two titles have in common (Jaccard). */
export function titleSimilarity(a: string, b: string): number {
  const [x, y] = [words(a), words(b)];
  if (!x.size || !y.size) return 0;
  const shared = [...x].filter((w) => y.has(w)).length;
  // One shared word ("basket") links unrelated defects; it takes two.
  return shared < 2 ? 0 : shared / (x.size + y.size - shared);
}

/** Open bugs whose title or Jira key contains every word typed, case-insensitive: the fallback when no suggestion fits. */
export function searchBugs(query: string, bugs: KnownBug[]): KnownBug[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return bugs.filter((b) => terms.every((t) => `${b.jira} ${b.title}`.toLowerCase().includes(t)));
}

/** Up to three approved bugs this group may belong to, best first, each with its reasons. */
export function findCandidates(group: FailureGroup, title: string, bugs: KnownBug[]): Candidate[] {
  const ids = [...new Set(group.failures.map((f) => f.endpoint).filter((e): e is string => Boolean(e)))];
  const resources = new Set(ids.map((id) => resource(catalogEndpoint(id).path)));
  const groupIsAccess = group.failures.some((f) => isAccessCheck(f.file));
  const scored = bugs.map((bug) => {
    const reasons: string[] = [];
    let score = 0;
    const bothAccess = groupIsAccess && bug.tests.some(isAccessCheck);
    const shared = ids.filter((id) => bug.endpoints?.includes(id));
    if (shared.length) {
      score += bothAccess ? SAME_ENDPOINT_ACCESS : SAME_ENDPOINT;
      const names = shared.map((id) => `${catalogEndpoint(id).method} ${catalogEndpoint(id).path}`).join(', ');
      reasons.push(bothAccess ? `same endpoint, both access checks: ${names}` : `same endpoint: ${names}`);
    } else if (bothAccess) {
      // Access defects on one record type (e.g. any BasketItems id) usually share one missing ownership check.
      const sharedResource = (bug.endpoints ?? []).map((id) => resource(catalogEndpoint(id).path)).find((r) => resources.has(r));
      if (sharedResource) {
        score += SAME_RESOURCE_ACCESS;
        reasons.push(`same records, both access checks: ${sharedResource}`);
      }
    }
    const similarity = titleSimilarity(title, bug.title);
    if (similarity >= 0.5) {
      score += SIMILAR_TITLE;
      reasons.push(`similar title (${Math.round(similarity * 100)}% of words shared)`);
    }
    return { bug, score, reasons };
  });
  return scored
    .filter((c) => c.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CANDIDATES);
}
