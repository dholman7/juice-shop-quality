/** Unit tests for reading ZAP's report and deciding which findings fail the run. No app or Docker needed. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluate, readFindings, type Finding, type FindingDecision } from './zap';

const finding = (over: Partial<Finding> = {}): Finding => ({
  ref: '10038-1',
  name: 'Content Security Policy (CSP) Header Not Set',
  risk: 'medium',
  confidence: 'high',
  count: 5,
  example: 'http://localhost:3000',
  description: '',
  solution: '',
  ...over,
});

const decision = (over: Partial<FindingDecision> = {}): FindingDecision => ({
  ref: '10038-1',
  name: 'Content Security Policy (CSP) Header Not Set',
  risk: 'medium',
  verdict: 'bug',
  reason: '',
  decidedBy: 'Reviewer',
  decidedOn: '2026-11-17',
  ...over,
});

test('reads risk, confidence, count, and an example URL from the ZAP JSON report', () => {
  // Arrange: the shape ZAP 2.17 writes with -J, trimmed to one alert.
  const dir = mkdtempSync(join(tmpdir(), 'zap-'));
  const path = join(dir, 'zap.json');
  writeFileSync(path, JSON.stringify({
    '@version': '2.17.0',
    site: [{ alerts: [{
      alertRef: '10098', name: 'Cross-Domain Misconfiguration', riskcode: '2', confidence: '2', count: '5', cweid: '264',
      desc: '<p>Web browser data loading may be possible.</p>', solution: '<p>Restrict CORS.</p>',
      instances: [{ uri: 'http://localhost:3000/robots.txt' }],
    }] }],
  }));

  // Act
  const { version, findings } = readFindings(path);

  // Assert
  assert.equal(version, '2.17.0');
  assert.deepEqual(findings[0], {
    ref: '10098', name: 'Cross-Domain Misconfiguration', risk: 'medium', confidence: 'medium', count: 5,
    example: 'http://localhost:3000/robots.txt', cwe: '264',
    description: 'Web browser data loading may be possible.', solution: 'Restrict CORS.',
  });
});

test('an undecided medium or high finding is new and fails the run', () => {
  const s = evaluate([finding(), finding({ ref: '40012', risk: 'high' })], []);
  assert.deepEqual(s.newFindings.map((f) => f.ref), ['10038-1', '40012']);
});

test('low and informational findings are reported, never gated', () => {
  const s = evaluate([finding({ risk: 'low' }), finding({ ref: '10109', risk: 'informational' })], []);
  assert.equal(s.newFindings.length, 0);
  assert.equal(s.reported.length, 2);
});

test('a filed bug and a dismissal both stop the finding from failing the run, and stay listed', () => {
  // Arrange
  const decisions = [decision(), decision({ ref: '10098', verdict: 'dismissed', reason: 'public assets only' })];

  // Act
  const s = evaluate([finding(), finding({ ref: '10098' })], decisions);

  // Assert
  assert.equal(s.newFindings.length, 0);
  assert.deepEqual(s.bugs.map((f) => f.ref), ['10038-1']);
  assert.deepEqual(s.dismissed.map((f) => f.ref), ['10098']);
});

test('a decision made at medium does not cover the same rule raised at high', () => {
  const s = evaluate([finding({ risk: 'high' })], [decision()]);
  assert.equal(s.newFindings.length, 1);
  assert.equal(s.notSeen.length, 1);
});

test('a decided finding the scan no longer raises is listed as not seen', () => {
  const s = evaluate([], [decision()]);
  assert.deepEqual(s.notSeen.map((d) => d.ref), ['10038-1']);
});
