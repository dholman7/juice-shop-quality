/**
 * The `test` every spec imports: Playwright's test plus a session per role and the known-bug check.
 * Each test makes its own customer, so no test depends on another's data.
 */
import { test as base, expect, type APIRequestContext } from '@playwright/test';
import { Api, login, newCustomer, upgradeToDeluxe } from './api';
import type { Role } from './config';
import { applyKnownBug, loadKnownBugs } from './known-bugs';
import { qaStaff } from './staff';

/**
 * A fresh customer upgraded to deluxe, then signed in again as a returning deluxe member would be.
 * The token the upgrade returns carries no basket id, so basket calls with it fail with 401.
 * Logging in again avoids that; a separate test in checkout.spec.ts keeps the token problem visible as a bug.
 */
export async function newDeluxe(request: APIRequestContext): Promise<Api> {
  const customer = new Api(request, await newCustomer(request));
  await upgradeToDeluxe(customer);
  return new Api(request, await login(request, customer.account!.email, customer.account!.password));
}

/**
 * Signs in as this worker's own QA staff account. Shared seed staff accounts made parallel tests
 * collide (duplicate basket items, one checkout emptying another test's basket).
 */
export async function staff(request: APIRequestContext, role: 'admin' | 'accounting', slot: number): Promise<Api> {
  const { email, password } = qaStaff(role, slot);
  return new Api(request, await login(request, email, password));
}

// Read once per worker, not once per test.
const knownBugs = loadKnownBugs();

interface Fixtures {
  /** A session for the role. Customer and deluxe are fresh accounts; staff are this worker's QA staff accounts. */
  as: (role: Role) => Promise<Api>;
  /** A fresh customer, for tests that need one signed-in shopper. */
  customer: Api;
  anonymous: Api;
  /** Runs before every test (auto) and marks it as an expected failure if it hits an approved bug. */
  knownBug: void;
}

export const test = base.extend<Fixtures>({
  as: async ({ request }, use, testInfo) => {
    await use(async (role) => {
      switch (role) {
        case 'anonymous':
          return new Api(request);
        case 'customer':
          return new Api(request, await newCustomer(request));
        case 'deluxe':
          return newDeluxe(request);
        case 'accounting':
        case 'admin':
          // parallelIndex is unique among workers running at the same time, so it picks a free slot.
          return staff(request, role, testInfo.parallelIndex);
      }
    });
  },
  customer: async ({ request }, use) => use(new Api(request, await newCustomer(request))),
  anonymous: async ({ request }, use) => use(new Api(request)),
  knownBug: [
    async ({}, use, testInfo) => {
      applyKnownBug(testInfo, knownBugs);
      await use();
    },
    { auto: true },
  ],
});

export { expect };

/** Tags a test with the catalog endpoint and role it covers; the coverage map reads these. */
export function covers(endpointId: string, role?: Role): { annotation: { type: string; description: string }[] } {
  const annotation = [{ type: 'endpoint', description: endpointId }];
  if (role) annotation.push({ type: 'role', description: role });
  return { annotation };
}
