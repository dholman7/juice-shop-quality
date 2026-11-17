export const CATEGORIES = ['product-bug', 'test-bug', 'environment', 'flaky', 'needs-human'] as const;
export type Category = (typeof CATEGORIES)[number];

/** One failed (or flaky) test, as read from the Playwright JSON report. */
export interface Failure {
  key: string;
  title: string;
  file: string;
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

export interface Proposal {
  groupId: string;
  category: Category;
  confidence: 'high' | 'medium' | 'low';
  /** Verbatim quote from the group's error text that supports the category. */
  evidence: string;
  reasoning: string;
  suggestedTitle?: string;
  suggestedSeverity?: 'critical' | 'high' | 'medium' | 'low';
  source: 'heuristic' | 'model';
  /** Set when validation overrode the model's answer. */
  downgradedBecause?: string;
}

export interface Decision {
  groupId: string;
  verdict: 'accepted' | 'changed' | 'rejected';
  category: Category;
  bugId?: string;
  title?: string;
  reviewer: string;
  decidedAt: string;
}
