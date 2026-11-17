/** R3 UI: sign-up, login, logout, password change and reset, and 2FA, through the real forms. */
import { test, expect, covers } from '../../src/fixtures';
import { SECURITY_ANSWER, login, register, uniqueEmail } from '../../src/api';
import { customerWith2fa, freshTotp } from '../../src/shop';
import { qaStaff } from '../../src/staff';
import { dismissCookieBanner, fillLogin, openAccountMenu, signIn } from '../../src/ui';

// The cookie banner covers buttons at the bottom of the page.
test.beforeEach(async ({ page }) => dismissCookieBanner(page));

test('a visitor registers and can then log in', covers('users.register', 'anonymous'), async ({ page, request }) => {
  // Arrange
  const email = uniqueEmail('ui');
  const password = 'Valid-Passw0rd!';
  // Filling before the form has its security questions lets Angular reset the fields.
  const questions = page.waitForResponse('**/api/SecurityQuestions/');
  await page.goto('/#/register');
  await questions;

  // Act
  await page.locator('#emailControl').fill(email);
  await page.locator('#passwordControl').fill(password);
  await page.locator('#repeatPasswordControl').fill(password);
  // Angular Material select: open it from its trigger, then pick the option.
  await page.locator('#securityQuestionControl .mat-mdc-select-trigger').click();
  await page.getByRole('option', { name: 'Your eldest siblings middle name?' }).click();
  await page.locator('#securityAnswerControl').fill(SECURITY_ANSWER);
  await page.locator('#registerButton').click();

  // Assert
  await expect(page).toHaveURL(/login/);
  await expect(login(request, email, password)).resolves.toMatchObject({ email });
});

for (const role of ['customer', 'deluxe', 'accounting', 'admin'] as const) {
  test(`${role} logs in through the form`, covers('auth.login', role), async ({ page, as }, testInfo) => {
    // Arrange
    const user = await as(role);
    // Staff sign in with this worker's own QA account, the same one the `as` fixture used.
    const { email, password } =
      role === 'accounting' || role === 'admin' ? qaStaff(role, testInfo.parallelIndex) : user.account!;

    // Act
    await fillLogin(page, email, password);

    // Assert
    await expect(page).toHaveURL(/search/);
    await openAccountMenu(page);
    await expect(page.getByRole('menuitem', { name: 'Go to user profile' })).toContainText(email);
  });
}

test('a wrong password shows a generic error', covers('auth.login', 'anonymous'), async ({ page, request }) => {
  // Arrange
  const { email } = await register(request);

  // Act
  await fillLogin(page, email, 'not-the-password');

  // Assert: the same message for any wrong login, so it doesn't reveal which emails are registered
  await expect(page.getByText('Invalid email or password.')).toBeVisible();
  await expect(page).toHaveURL(/login/);
});

test('customer logs out', covers('auth.whoami', 'customer'), async ({ page, customer }) => {
  // Arrange
  await signIn(page, customer.account!);
  await page.goto('/#/search');

  // Act
  await openAccountMenu(page);
  await page.locator('#navbarLogoutButton').click();

  // Assert
  await openAccountMenu(page);
  await expect(page.getByRole('menuitem', { name: 'Go to login page' })).toBeVisible();
  // The session token must be gone from the browser, not just hidden in the menu.
  expect(await page.evaluate(() => localStorage.getItem('token'))).toBeNull();
});

for (const role of ['customer', 'deluxe'] as const) {
  test(`${role} changes their password`, covers('password.change', role), async ({ page, as, request }) => {
    // Arrange
    const user = await as(role);
    const next = 'Changed-Passw0rd!';
    await signIn(page, user.account!);
    await page.goto('/#/privacy-security/change-password');

    // Act
    await page.locator('#currentPassword').fill(user.account!.password);
    await page.locator('#newPassword').fill(next);
    await page.locator('#newPasswordRepeat').fill(next);
    await page.locator('#changeButton').click();

    // Assert
    await expect(page.getByText('Your password was successfully changed.')).toBeVisible();
    await expect(login(request, user.account!.email, next)).resolves.toBeTruthy();
  });
}

test('a customer resets a forgotten password with the security answer', covers('password.reset', 'anonymous'), async ({ page, request }) => {
  // Arrange
  const { email } = await register(request);
  const next = 'Reset-Passw0rd!';
  await page.goto('/#/forgot-password');

  // Act
  await page.locator('#email').fill(email);
  await page.locator('#securityAnswer').fill(SECURITY_ANSWER);
  await page.locator('#newPassword').fill(next);
  await page.locator('#newPasswordRepeat').fill(next);
  await page.locator('#resetButton').click();

  // Assert
  await expect(page.getByText('Your password was successfully changed.')).toBeVisible();
  await expect(login(request, email, next)).resolves.toBeTruthy();
});

test('customer turns on 2FA, and the next login asks for a code', covers('2fa.setup', 'customer'), async ({ page, request, customer }) => {
  // Arrange: each status call issues a new secret, so keep the last one this page was given
  await signIn(page, customer.account!);
  let secret = '';
  page.on('response', async (res) => {
    if (res.url().endsWith('/rest/2fa/status')) secret = (await res.json()).secret ?? secret;
  });
  await page.goto('/#/privacy-security/two-factor-authentication');
  // Wait for the QR code, as a person scanning it would. Saving earlier sends the request
  // without its setup token and fails (a real race in the page, logged as a bug).
  await expect(page.locator('qrcode canvas, qrcode img').first()).toBeVisible();
  await expect.poll(() => secret).not.toBe('');

  // Act
  await page.locator('#currentPasswordSetup').fill(customer.account!.password);
  await page.locator('#initialToken').fill(await freshTotp(secret));
  // Confirms the field kept its value before saving; a reset field sends an empty password.
  await expect(page.locator('#currentPasswordSetup')).toHaveValue(customer.account!.password);
  await page.locator('#setupTwoFactorAuth').click();

  // Assert
  await expect(page.getByText('You have enabled 2FA for your account.')).toBeVisible();
  // Proven through the API: the password alone now gets a 2FA challenge, not a session.
  const res = await request.post('/rest/user/login', { data: { email: customer.account!.email, password: customer.account!.password } });
  expect((await res.json()).status).toBe('totp_token_required');
});

test('a 2FA customer logs in with password and code', covers('2fa.verify', 'anonymous'), async ({ page, request }) => {
  // Arrange
  const acct = await customerWith2fa(request);

  // Act
  await fillLogin(page, acct.email, acct.password);
  await expect(page).toHaveURL(/2fa\/enter/);
  await page.locator('#totpToken').fill(await freshTotp(acct.secret));
  await page.locator('#totpSubmitButton').click();

  // Assert
  await expect(page).toHaveURL(/search/);
});
