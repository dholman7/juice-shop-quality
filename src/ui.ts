import type { Page } from '@playwright/test';
import type { Account } from './api';
import { BASE_URL } from './config';

/** Starts the browser already signed in, as the app does after a successful login. */
export async function signIn(page: Page, account: Account): Promise<void> {
  await page.context().addCookies([{ name: 'token', value: account.token, url: BASE_URL }]);
  await page.addInitScript(
    ([token, bid]) => {
      localStorage.setItem('token', token);
      sessionStorage.setItem('bid', bid);
    },
    [account.token, String(account.basketId)],
  );
}

/** Pre-dismisses the cookie banner, which otherwise covers buttons at the bottom of the page. */
export async function dismissCookieBanner(page: Page): Promise<void> {
  await page.context().addCookies([{ name: 'cookieconsent_status', value: 'dismiss', url: BASE_URL }]);
}

export async function openAccountMenu(page: Page): Promise<void> {
  await page.locator('#navbarAccount').click();
}

export async function fillLogin(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/#/login');
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await page.locator('#loginButton').click();
}
