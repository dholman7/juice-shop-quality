/** Shapes shared by the triage pipeline: collect → group → classify → validate → human review. */

/**
 * The causes triage can propose. needs-human is the safe answer when the evidence doesn't decide;
 * only product-bug, once a person accepts it, becomes a known-bugs.json entry.
 */
export const CATEGORIES = ['product-bug', 'test-bug', 'environment', 'flaky', 'needs-human'] as const;
export type Category = (typeof CATEGORIES)[number];

/** One failed (or flaky) test, as read from the Playwright JSON report. */
export interface Failure {
  key: string;
  title: string;
  file: string;
  /** unexpected: failed every attempt. flaky: failed, then passed on retry. */
  outcome: 'unexpected' | 'flaky';
  endpoint?: string;
  role?: string;
  /** Redacted error text: the only thing a model ever sees. */
  error: string;
  retries: number;
}

/** Failures that share an endpoint and an error signature; reviewed as one decision. */
export interface FailureGroup {
  id: string;
  signature: string;
  failures: Failure[];
}

/** What triage suggests for one group. A suggestion only; a person decides. */
export interface Proposal {
  groupId: string;
  category: Category;
  confidence: 'high' | 'medium' | 'low';
  /** Verbatim quote from the group's error text that supports the category. */
  evidence: string;
  reasoning: string;
  suggestedTitle?: string;
  suggestedSeverity?: 'critical' | 'high' | 'medium' | 'low';
  /** heuristic: the offline rules. model: Claude, after its answer passed validation. */
  source: 'heuristic' | 'model';
  /** Set when validation overrode the model's answer. */
  downgradedBecause?: string;
}

/** A reviewer's answer to one proposal, appended to triage/decisions.jsonl as an audit trail. */
export interface Decision {
  groupId: string;
  /** accepted as proposed, accepted with a different category, or rejected. */
  verdict: 'accepted' | 'changed' | 'rejected';
  category: Category;
  bugId?: string;
  title?: string;
  reviewer: string;
  decidedAt: string;
}
