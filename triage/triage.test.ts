/** Unit tests for the triage pieces that need no app: redaction, the rules, model-answer validation, grouping. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from './redact';
import { classify } from './heuristic';
import { validate } from './model';
import { groupFailures, signature } from './collect';
import type { Failure, FailureGroup } from './types';

const failure = (over: Partial<Failure> = {}): Failure => ({
  key: 'api/x.spec.ts › suite › refuses customer',
  title: 'refuses customer',
  file: 'api/x.spec.ts',
  outcome: 'unexpected',
  endpoint: 'basket.get',
  role: 'customer',
  error: 'Error: GET /rest/basket/:id as customer returned 200\nexpect(received).toContain(expected)',
  retries: 0,
  ...over,
});
const group = (...failures: Failure[]): FailureGroup => ({ id: 'G-1', signature: 's', failures });

test('redact removes tokens, emails, hashes, and card numbers', () => {
  // Arrange
  const raw = 'Bearer eyJhbGc.eyJkYXRh.sig qa.1@test.local 8a9f378cd4ae73dc7cc4432d0f4b0119 4111111111111111 "password":"x"';

  // Act
  const out = redact(raw);

  // Assert
  for (const secret of ['eyJ', 'qa.1@test.local', '8a9f378cd4', '4111111111111111', '"password":"x"']) {
    assert.ok(!out.includes(secret), `${secret} leaked: ${out}`);
  }
});

test('a status mismatch from the product is proposed as a product bug', () => {
  assert.equal(classify(group(failure())).category, 'product-bug');
});

test('a selector problem is proposed as a test bug', () => {
  const f = failure({ error: "Error: locator.click: Error: strict mode violation: getByText('x') resolved to 2 elements" });
  assert.equal(classify(group(f)).category, 'test-bug');
});

test('a refused connection is proposed as an environment problem', () => {
  const f = failure({ error: 'Error: apiRequestContext.get: connect ECONNREFUSED 127.0.0.1:3000' });
  assert.equal(classify(group(f)).category, 'environment');
});

test('a pass on retry is proposed as flaky', () => {
  assert.equal(classify(group(failure({ outcome: 'flaky' }))).category, 'flaky');
});

test('a timeout is left to a person', () => {
  const f = failure({ error: 'Test timeout of 30000ms exceeded.' });
  assert.equal(classify(group(f)).category, 'needs-human');
});

test('model evidence that is not a quote is downgraded to needs-human', () => {
  // Act
  const p = validate(group(failure()), { category: 'product-bug', confidence: 'high', evidence: 'the server crashed with a null pointer', reasoning: 'x' });

  // Assert
  assert.equal(p.category, 'needs-human');
  assert.match(p.downgradedBecause ?? '', /not a quote/);
});

test('model reasoning left as a placeholder is downgraded to needs-human', () => {
  // Arrange: the exact reasoning the model returned on the first real run
  const reasoning = 'Placeholder; to be replaced after reading the test source.';

  // Act
  const p = validate(group(failure()), { category: 'product-bug', confidence: 'high', evidence: 'as customer returned 200', reasoning });

  // Assert
  assert.equal(p.category, 'needs-human');
  assert.match(p.downgradedBecause ?? '', /unfinished/);
});

test('model evidence that is a quote is kept', () => {
  const p = validate(group(failure()), { category: 'product-bug', confidence: 'high', evidence: 'as customer returned 200', reasoning: 'The product returned 200 where the policy refuses customers.' });
  assert.equal(p.category, 'product-bug');
  assert.equal(p.source, 'model');
});

test('the model cannot call a failure flaky unless a retry passed', () => {
  const p = validate(group(failure()), { category: 'flaky', confidence: 'high', evidence: 'as customer returned 200', reasoning: 'x' });
  assert.equal(p.category, 'needs-human');
});

test('the same defect seen by several roles forms one group', () => {
  // Arrange
  const roles = ['customer', 'deluxe', 'admin'].map((role) =>
    failure({ role, title: `refuses ${role}`, error: `Error: GET /rest/basket/:id as ${role} returned 200` }),
  );

  // Act
  const groups = groupFailures(roles);

  // Assert
  assert.equal(groups.length, 1);
  assert.equal(groups[0].failures.length, 3);
  assert.equal(signature(roles[0]), signature(roles[2]));
});

test('a role-matrix bug title names who got through and the rule', () => {
  // Arrange
  const roles = ['customer', 'deluxe'].map((role) =>
    failure({ file: 'api/access-matrix.spec.ts', endpoint: 'basketItems.list', role, title: `refuses ${role}`, error: `Error: GET /api/BasketItems as ${role} returned 200` }),
  );

  // Act
  const title = classify(group(...roles)).suggestedTitle;

  // Assert
  assert.equal(title, 'customer, deluxe can call GET /api/BasketItems (only admin should)');
});

test('a server error is titled as a failure, not as access granted', () => {
  const f = failure({ file: 'api/access-matrix.spec.ts', endpoint: 'basketItems.list', role: 'anonymous', title: 'refuses anonymous', error: 'Error: GET /api/BasketItems as anonymous returned 500' });
  assert.equal(classify(group(f)).suggestedTitle, 'GET /api/BasketItems fails with 500 for anonymous instead of refusing');
});

test('a behavior bug title states the requirement from the test title', () => {
  const f = failure({ key: 'api/checkout.spec.ts › R2 checkout › refuses to check out an empty basket', error: 'Expected: 400\nReceived: 200' });
  assert.equal(classify(group(f)).suggestedTitle, 'Not met: R2 checkout › refuses to check out an empty basket');
});
