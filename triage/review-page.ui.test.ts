/**
 * The review page in a real browser (Chromium via Playwright), on a throwaway checkout. Covers what only
 * a browser shows: rendering, live severity, kept input across decisions, errors in place, and saving.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from '@playwright/test';
import { freePort, makeCheckout, startServer, type Checkout, type Server } from './review-page.fixture';

let repo: Checkout;
let server: Server;
let browser: Browser;
let page: Page;

before(async () => {
  repo = makeCheckout();
  server = await startServer(repo.root, freePort(2000));
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.goto(server.url);
  await page.getByText('items to decide').waitFor();
});
after(async () => {
  await browser?.close();
  server?.stop();
  repo?.cleanup();
});

const card = (text: string) => page.locator('.card', { hasText: text });
const gone = (text: string) => card(text).waitFor({ state: 'detached' });

test('renders every section, with no raw element text', async () => {
  // Assert
  for (const heading of ['Severity check', 'Failure groups', 'Security scan findings', 'Save the review']) {
    assert.equal(await page.getByRole('heading', { name: heading }).count(), 1, heading);
  }
  assert.equal(await page.getByText('[object').count(), 0);
  assert.equal(await page.locator('.card.demo').count(), 0, 'no demo banner outside demo mode');
  assert.equal(await page.getByText('7 items to decide.').count(), 1, '1 severity check + 5 groups + 1 scan finding');
});

test('a suggested duplicate shows the bug and the reason', async () => {
  const suggestion = card('DELETE /api/BasketItems').locator('label.choice', { hasText: 'BUG-001' });
  assert.match(await suggestion.innerText(), /same endpoint, both access checks: DELETE \/api\/BasketItems\/:id/);
});

test('text typed in one card survives a decision in another', async () => {
  // Arrange
  const hash = card('password change response');
  await hash.getByPlaceholder(/Search open bugs/).fill('hash');
  await hash.getByText('BUG-002 · SHOP-2').waitFor();

  // Act: decide two other items
  await page.getByRole('button', { name: 'Set to high' }).click();
  await gone('No rate limit on wrong passwords');
  const dup = card('DELETE /api/BasketItems');
  await dup.getByText('BUG-001 · SHOP-1').click();
  await dup.getByRole('button', { name: 'Record decision' }).click();
  await gone('DELETE /api/BasketItems');

  // Assert
  assert.equal(await hash.getByPlaceholder(/Search open bugs/).inputValue(), 'hash');
  await hash.getByText('BUG-002 · SHOP-2').click();
  await hash.getByRole('button', { name: 'Record decision' }).click();
  await gone('password change response');
  assert.match(await card('invalid fullName').locator('.gtitle').innerText(), /^Group 1 of 3/, 'headings renumber');
});

test('a new bug shows its severity live and its errors in place', async () => {
  // Arrange
  const c = card('invalid fullName');
  await c.getByText('A new bug').click();

  // Act / Assert: missing key, then a bad one
  await c.getByRole('button', { name: 'Record decision' }).click();
  assert.equal(await c.locator('.msg').innerText(), 'Enter the Jira key the bug is reported in.');
  await c.getByPlaceholder('e.g. SHOP-240').fill('JIRA');
  await c.locator('[data-score=impact]').selectOption('3');
  await c.locator('[data-score=likelihood]').selectOption('4');
  assert.equal(await c.locator('.result').innerText(), 'I3 × L4 = 12 → high');
  await c.getByRole('button', { name: 'Record decision' }).click();
  await c.getByText('not a Jira key; expected PROJECT-123').waitFor();

  // Act: a good key files it
  await c.getByPlaceholder('e.g. SHOP-240').fill('shop-40');
  await c.getByRole('button', { name: 'Record decision' }).click();
  await gone('invalid fullName');
  await page.getByText(/filed as new bug BUG-004/).waitFor();
});

test('reject files no bug; "decide later" sets a group aside', async () => {
  await card('coupon nobody asked for').getByRole('button', { name: /Reject/ }).click();
  await gone('coupon nobody asked for');
  await card('slow total').getByRole('button', { name: 'Decide later' }).click();
  await gone('slow total');
  assert.equal(await page.getByText('1 item to decide. 1 left for later.').count(), 1);
});

test('a dismissal without a reason is refused on the page', async () => {
  const c = card('Cross-Domain');
  await c.getByRole('button', { name: /Dismiss/ }).click();
  await c.getByText('a dismissal needs a reason').waitFor();
  await c.locator('textarea').fill('Bearer tokens only');
  await c.getByRole('button', { name: /Dismiss/ }).click();
  await gone('Cross-Domain');
});

test('a group left for later is never reported as all decided', async () => {
  // Assert: the deferred group still blocks "All decided"
  await page.getByText('Only the 1 group you left for later remains').waitFor();
  assert.equal(await page.getByText('All decided.').count(), 0);

  // Act: bring it back and change its cause
  await page.getByRole('button', { name: 'Show them again' }).click();
  const c = card('slow total');
  await c.locator('label.choice', { hasText: 'test-bug' }).click();
  assert.ok(await c.locator('fieldset', { hasText: 'Which bug?' }).isHidden(), 'the bug chooser hides for other causes');
  await c.getByRole('button', { name: 'Record decision' }).click();
  await page.getByText('All decided.').waitFor();
});

test('saving commits and pushes, then has nothing left', async () => {
  // Arrange: a typed message survives the page refreshing
  const save = page.locator('.card', { hasText: 'Commit message' });
  await save.locator('input[type=text]').fill('chore: review by the fixture');
  await page.evaluate(() => (window as unknown as { load: () => Promise<void> }).load());
  assert.deepEqual(await save.locator('li').allInnerTexts(), ['known-bugs.json', 'triage/decisions.jsonl', 'security/zap-findings.json']);

  // Act
  await save.getByRole('button', { name: 'Commit and push' }).click();
  await page.getByText(/Nothing to save/).waitFor();

  // Assert
  assert.equal(repo.git('rev-parse', 'HEAD'), repo.git('--git-dir', repo.remote, 'rev-parse', 'main'));
  assert.match(repo.git('log', '-1', '--format=%B'), /^chore: review by the fixture\n\nReviewed-by: Fixture Reviewer/);
});

test('demo mode shows its banner and explains that nothing is committed', async () => {
  const demo = await startServer(repo.root, freePort(3000), { DEMO: '1' });
  const p = await browser.newPage();
  try {
    await p.goto(demo.url);
    await p.locator('.card.demo').waitFor();
    assert.match(await p.locator('.card.demo').innerText(), /The committed review is untouched/);
    assert.match(await p.getByText(/In demo mode, decisions stay in \.demo\//).innerText(), /nothing is committed/);
    assert.equal(await p.getByRole('button', { name: /Commit/ }).count(), 0);
  } finally {
    await p.close();
    demo.stop();
  }
});
