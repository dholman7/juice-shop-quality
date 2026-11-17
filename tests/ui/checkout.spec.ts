/** R2 UI: the checkout path a customer clicks through, plus wallet, deluxe, tracking, and accounting. */
import { test, expect, covers } from '../../src/fixtures';
import { addCard } from '../../src/api';
import { checkout, coupon, readyToCheckout } from '../../src/shop';
import { dismissCookieBanner, signIn } from '../../src/ui';
import type { Page } from '@playwright/test';

test.beforeEach(async ({ page }) => dismissCookieBanner(page));

async function clickThroughCheckout(page: Page): Promise<void> {
  await page.goto('/#/basket');
  await page.locator('#checkoutButton').click();
  await page.locator('mat-row, tr').filter({ hasText: '100 Main St' }).first().locator('mat-radio-button').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('mat-row', { hasText: 'Standard Delivery' }).locator('mat-radio-button').click();
  await page.getByRole('button', { name: 'Proceed to delivery method selection' }).click();
  await page.locator('mat-row', { hasText: '************1111' }).first().locator('mat-radio-button').click();
  await page.getByRole('button', { name: 'Proceed to review' }).click();
}

for (const role of ['customer', 'deluxe'] as const) {
  test(`${role} checks out with a saved card and gets a confirmation`, covers('basket.checkout', role), async ({ page, as }) => {
    // Arrange
    const shopper = await as(role);
    await readyToCheckout(shopper, 1, 1);
    await signIn(page, shopper.account!);

    // Act
    await clickThroughCheckout(page);
    await page.getByRole('button', { name: 'Complete your purchase' }).click();

    // Assert
    await expect(page).toHaveURL(/order-completion/);
    await expect(page.getByText('Thank you for your purchase!')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Show the shopping cart' })).toContainText('0');
  });
}

test('deluxe member sees the deluxe price in the basket', covers('basket.get', 'deluxe'), async ({ page, as }) => {
  // Arrange
  const deluxe = await as('deluxe');
  await readyToCheckout(deluxe, 1, 1);
  const { deluxePrice } = (await (await deluxe.get('/api/Products/1')).json()).data;
  await signIn(page, deluxe.account!);

  // Act
  await page.goto('/#/basket');

  // Assert
  await expect(page.locator('mat-row', { hasText: 'Apple Juice' })).toContainText(`${deluxePrice}¤`);
});

test('customer sees an error for an invalid coupon', covers('basket.coupon', 'customer'), async ({ page, customer }) => {
  // Arrange
  await readyToCheckout(customer);
  await signIn(page, customer.account!);
  await page.goto('/#/payment/shop');

  // Act
  await page.getByRole('button', { name: /Add a coupon/ }).click();
  await page.locator('#coupon').fill('NOTVALID00');
  await page.locator('#applyCouponButton').click();

  // Assert
  await expect(page.getByText('Invalid coupon.')).toBeVisible();
});

test('customer redeems this month\'s coupon', covers('basket.coupon', 'customer'), async ({ page, customer }) => {
  // Arrange
  await readyToCheckout(customer);
  await signIn(page, customer.account!);
  await page.goto('/#/payment/shop');

  // Act
  await page.getByRole('button', { name: /Add a coupon/ }).click();
  await page.locator('#coupon').fill(coupon(10));
  await page.locator('#applyCouponButton').click();

  // Assert
  await expect(page.getByText('Your discount of 10% will be applied during checkout.')).toBeVisible();
});

test('customer tops up the wallet from a saved card', covers('wallet.topUp', 'customer'), async ({ page, customer }) => {
  // Arrange
  await addCard(customer);
  await signIn(page, customer.account!);
  await page.goto('/#/wallet');

  // Act
  await page.getByLabel('Enter an amount').fill('20');
  await page.locator('#submitButton').click();
  await page.locator('mat-row', { hasText: '************1111' }).locator('mat-radio-button').click();
  await page.getByRole('button', { name: 'Proceed to review' }).click();

  // Assert
  await expect(page).toHaveURL(/wallet/);
  await expect(page.getByText('20.00')).toBeVisible();
});

test('customer buys deluxe membership with a card', covers('deluxe.buy', 'customer'), async ({ page, customer }) => {
  // Arrange
  await addCard(customer);
  await signIn(page, customer.account!);
  await page.goto('/#/deluxe-membership');

  // Act
  await page.getByRole('button', { name: 'Become deluxe member' }).click();
  await page.locator('mat-row', { hasText: '************1111' }).locator('mat-radio-button').click();
  await page.getByRole('button', { name: 'Proceed to review' }).click();

  // Assert: the app returns to the membership page, which now recognizes the member
  await expect(page).toHaveURL(/deluxe-membership/);
  await expect(page.getByText('You are already a deluxe member!')).toBeVisible();
});

for (const role of ['anonymous', 'customer'] as const) {
  test(`${role} tracks an order by its number`, covers('orders.track', role), async ({ page, customer, as }) => {
    // Arrange
    const { orderConfirmation } = await (await checkout(customer, await readyToCheckout(customer))).json();
    const viewer = await as(role);
    if (viewer.account) await signIn(page, viewer.account);

    // Act
    await page.goto(`/#/track-result?id=${orderConfirmation}`);

    // Assert
    await expect(page.getByText(`Search Results - ${orderConfirmation}`)).toBeVisible();
    await expect(page.getByText('Apple Juice (1000ml)')).toBeVisible();
  });
}

test('accounting marks a new order as delivered', covers('orders.deliveryStatus', 'accounting'), async ({ page, customer, as }) => {
  // Arrange
  const { orderConfirmation } = await (await checkout(customer, await readyToCheckout(customer))).json();
  const accounting = await as('accounting');
  await signIn(page, accounting.account!);
  await page.goto('/#/accounting');
  const row = page.locator('mat-row', { hasText: orderConfirmation });

  // Act
  await row.getByRole('button').click();

  // Assert
  await expect.poll(async () => {
    const [order] = (await (await customer.get(`/rest/track-order/${orderConfirmation}`)).json()).data;
    return order.delivered;
  }).toBe(true);
});

for (const role of ['customer', 'deluxe', 'admin'] as const) {
  test(`${role} has no accounting page`, covers('orders.all', role), async ({ page, as }) => {
    // Arrange
    const user = await as(role);
    await signIn(page, user.account!);

    // Act
    await page.goto('/#/accounting');

    // Assert
    await expect(page.getByRole('heading', { name: 'Accounting' })).toHaveCount(0);
  });
}
