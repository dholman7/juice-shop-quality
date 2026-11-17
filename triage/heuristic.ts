/**
 * Offline classifier: deterministic rules over the error text. It is the default provider,
 * the fallback when the model is unavailable, and the baseline the model must beat.
 */
import { endpoint as catalogEndpoint } from '../src/catalog';
import type { FailureGroup, Proposal } from './types';

// Starting severity for a proposed bug, from the strategy's risk ranking. The reviewer can change it.
const SEVERITY_BY_AREA = { R1: 'critical', R2: 'high', R3: 'critical' } as const;

/** The first line matching the pattern, as written: evidence is always a real quote, never a paraphrase. */
function quote(text: string, pattern: RegExp): string | undefined {
  return text.split('\n').find((line) => pattern.test(line))?.trim();
}

/**
 * A bug title a person can read: for a role-matrix group, who got through and what the rule says;
 * for a behavior test, the requirement its title states.
 */
function bugTitle(group: FailureGroup): string {
  const f = group.failures[0];
  const roles = [...new Set(group.failures.map((x) => x.role).filter(Boolean))].join(', ');
  if (!f.file.includes('access-matrix') || !f.endpoint) {
    // The test's title path after the file names the requirement; list every role in the group.
    const path = f.key.split(' › ').slice(1);
    if (roles && group.failures.length > 1) path[path.length - 1] = path[path.length - 1].replace(/\b(anonymous|customer|deluxe|accounting|admin)\b/, roles);
    return `Not met: ${path.join(' › ')}`;
  }
  const ep = catalogEndpoint(f.endpoint);
  const status = Number(f.error.match(/returned (\d{3})/)?.[1]);
  if (f.title.startsWith('allows')) return `${ep.method} ${ep.path} refuses ${roles}, who should be allowed`;
  if (status >= 500) return `${ep.method} ${ep.path} fails with ${status} for ${roles} instead of refusing`;
  const rule = ep.access === 'owner' ? "only the record's owner should"
    : ep.access === 'nobody' ? 'no one should'
      : Array.isArray(ep.access) ? `only ${ep.access.join(' and ')} should`
        : 'only signed-in users should';
  return `${roles} can call ${ep.method} ${ep.path} (${rule})`;
}

/**
 * Rules run in order, and the first match wins. Order matters: an unreachable app or a broken
 * selector must not be mistaken for a product bug, so those checks come before the assertion check.
 */
export function classify(group: FailureGroup): Proposal {
  const f = group.failures[0];
  const text = f.error;
  const base = { groupId: group.id, source: 'heuristic' as const };

  if (group.failures.every((x) => x.outcome === 'flaky')) {
    return { ...base, category: 'flaky', confidence: 'high', evidence: quote(text, /\S/) ?? '', reasoning: `Failed, then passed on retry (${group.failures.length} test(s)).` };
  }

  // Stack and code-frame lines hold file paths and line numbers, where "502" is not a gateway error.
  const message = text.split('\n').filter((line) => !/^\s*at\s|^\s*>?\s*\d+\s*\|/.test(line)).join('\n');
  const env = quote(message, /ECONNREFUSED|ERR_CONNECTION_REFUSED|socket hang up|did not answer|net::ERR_|\b50[234]\b/);
  if (env) return { ...base, category: 'environment', confidence: 'high', evidence: env, reasoning: 'The app or network was unreachable, so the test never exercised product behavior.' };

  const testBug = quote(text, /strict mode violation|TypeError|ReferenceError|is not a function|Cannot read properties|resolved to \d+ elements|SyntaxError/);
  if (testBug) return { ...base, category: 'test-bug', confidence: 'high', evidence: testBug, reasoning: 'The failure comes from the test code or a selector, not from a product response.' };

  // A timeout alone doesn't say whose fault it is, so it goes to a person.
  const timeout = quote(text, /Test timeout of \d+ms exceeded|locator\.\w+: Timeout/);
  if (timeout) return { ...base, category: 'needs-human', confidence: 'low', evidence: timeout, reasoning: 'A timeout can be a slow app, a changed page, or a wrong selector; the trace decides.' };

  // A failed assertion on a real response: quote the Expected/Received pair so the reviewer sees both values.
  const expected = quote(text, /^Expected( path| pattern| substring| value)?:/);
  const received = quote(text, /^Received( value| string| array)?:/);
  const status = quote(text, /returned \d{3}/) ?? (expected && received && /\d{3}/.test(received) ? `${expected} / ${received}` : undefined);
  const assertion = expected && received ? `${expected} / ${received}` : quote(text, /expect\(.*\)\.(not\.)?to\w+/);
  if (status || assertion) {
    const area = f.endpoint ? catalogEndpoint(f.endpoint).area : undefined;
    return {
      ...base,
      category: 'product-bug',
      confidence: status ? 'high' : 'medium',
      evidence: (status ?? assertion)!,
      reasoning: 'The product answered, and the answer broke a stated expectation.',
      suggestedTitle: bugTitle(group),
      suggestedSeverity: area ? SEVERITY_BY_AREA[area] : 'medium',
    };
  }

  return { ...base, category: 'needs-human', confidence: 'low', evidence: quote(text, /\S/) ?? '', reasoning: 'No rule matched.' };
}
