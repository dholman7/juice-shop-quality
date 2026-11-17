/**
 * R1 UI: customers manage their own basket, addresses, and cards; only admins see other customers.
 * Data is set up through the API and the browser starts signed in, so each test drives only the screen under test.
 */
import { test, expect, covers } from '../../src/fixtures';
import { addToBasket } from '../../src/api';
import { checkout, readyToCheckout } from '../../src/shop';
import { dismissCookieBanner, signIn } from '../../src/ui';

// The cookie banner covers buttons at the bottom of the page.
test.beforeEach(async ({ page }) => dismissCookieBanner(page));

for (const role of ['customer', 'deluxe'] as const) {
  test(`${role} changes quantities and removes items in the basket`, covers('basket.get', role), async ({ page, as }) => {
    // Arrange
    const shopper = await as(role);
    await addToBasket(shopper, 1, 1);
    await signIn(page, shopper.account!);
    await page.goto('/#/basket');
    const row = page.locator('mat-row', { hasText: 'Apple Juice (1000ml)' });

    // Act + Assert
    await row.locator('button:has(svg[data-icon="plus-square"])').click();
    await expect(row.locator('.mat-column-quantity')).toContainText('2');
    await row.locator('button:has(svg[data-icon="trash-alt"])').click();
    await expect(page.locator('mat-row')).toHaveCount(0);
  });
}

// Every signed-in role can save addresses and cards, so every one is tested.
for (const role of ['customer', 'deluxe', 'accounting', 'admin'] as const) {
  test(`${role} saves a new address`, covers('addresses.create', role), async ({ page, as }) => {
    // Arrange
    const user = await as(role);
    const name = `UI Address ${Date.now()}`;
    await signIn(page, user.account!);
    // Start from the saved list, as customers do: the form goes "back" after saving.
    await page.goto('/#/address/saved');
    await page.getByRole('button', { name: 'Add New Address' }).click();

    // Act
    await page.getByPlaceholder('Please provide a name.').fill(name);
    await page.getByPlaceholder('Please provide a country.').fill('United States');
    await page.getByPlaceholder('Please provide a mobile number.').fill('5555550100');
    await page.getByPlaceholder('Please provide a ZIP code.').fill('53188');
    await page.getByPlaceholder('Please provide an address.').fill('100 Main St');
    await page.getByPlaceholder('Please provide a city.').fill('Waukesha');
    await page.getByPlaceholder('Please provide a state.').fill('WI');
    await page.locator('#submitButton').click();

    // Assert
    await expect(page).toHaveURL(/address\/saved/);
    await expect(page.getByText(name)).toBeVisible();
  });

  test(`${role} saves a card and only sees the last four digits`, covers('cards.create', role), async ({ page, as }) => {
    // Arrange
    const user = await as(role);
    await signIn(page, user.account!);
    await page.goto('/#/saved-payment-methods');

    // Act
    await page.getByText('Add new card').click();
    const panel = page.locator('mat-expansion-panel');
    await panel.getByRole('textbox').first().fill('UI Card Holder');
    await panel.getByRole('spinbutton').fill('4716190207394368');
    await panel.locator('select').nth(0).selectOption('7');
    // The app only accepts expiry years 2080–2099.
    await panel.locator('select').nth(1).selectOption('2090');
    await panel.locator('#submitButton').click();

    // Assert: the saved card is shown masked, and the full number appears nowhere on the page
    await expect(page.getByText('************4368').first()).toBeVisible();
    await expect(page.getByText('4716190207394368')).toHaveCount(0);
  });
}

test('customer sees a placed order in order history', covers('orders.history', 'customer'), async ({ page, customer }) => {
  // Arrange
  const { orderConfirmation } = await (await checkout(customer, await readyToCheckout(customer))).json();
  await signIn(page, customer.account!);

  // Act
  await page.goto('/#/order-history');

  // Assert
  await expect(page.getByText(orderConfirmation)).toBeVisible();
});

test('admin sees registered customers on the administration page', covers('users.list', 'admin'), async ({ page, as }) => {
  // Arrange
  const admin = await as('admin');
  await signIn(page, admin.account!);

  // The table is built from this response: wait for the data, not just the heading.
  const users = page.waitForResponse((r) => r.url().includes('/rest/user/authentication-details') && r.ok());

  // Act
  await page.goto('/#/administration');
  await users;

  // Assert
  await expect(page.getByRole('heading', { name: 'Administration' })).toBeVisible();
  // jim@juice-sh.op is a seeded customer, so seeing it proves the page lists other customers.
  // The page renders every account in the browser: late in a full CI run that is several hundred
  // (a 208 KB response), and the first CI flake showed the rows appearing after the 5 s default.
  await expect(page.getByText('jim@juice-sh.op').first()).toBeVisible({ timeout: 15_000 });
});

// The screen check only; the API refusal for the same data is in access-matrix.spec.ts.
for (const role of ['customer', 'deluxe', 'accounting'] as const) {
  test(`${role} cannot open the administration page`, covers('users.list', role), async ({ page, as }) => {
    // Arrange
    const user = await as(role);
    await signIn(page, user.account!);

    // Act
    await page.goto('/#/administration');

    // Assert
    await expect(page.getByRole('heading', { name: 'Administration' })).toHaveCount(0);
    await expect(page.getByText('admin@juice-sh.op')).toHaveCount(0);
  });
}
