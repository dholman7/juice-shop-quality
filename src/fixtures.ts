import { test as base, expect, type APIRequestContext } from '@playwright/test';
import { Api, login, newCustomer, upgradeToDeluxe } from './api';
import type { Role } from './config';
import { applyKnownBug, loadKnownBugs } from './known-bugs';
import { qaStaff } from './staff';

/** A fresh customer upgraded to deluxe, then signed in again as a returning deluxe member would be. */
export async function newDeluxe(request: APIRequestContext): Promise<Api> {
  const customer = new Api(request, await newCustomer(request));
  await upgradeToDeluxe(customer);
  return new Api(request, await login(request, customer.account!.email, customer.account!.password));
}

export async function staff(request: APIRequestContext, role: 'admin' | 'accounting', slot: number): Promise<Api> {
  const { email, password } = qaStaff(role, slot);
  return new Api(request, await login(request, email, password));
}

const knownBugs = loadKnownBugs();

interface Fixtures {
  /** A session for the role. Customer and deluxe are fresh accounts; staff are the seed accounts. */
  as: (role: Role) => Promise<Api>;
  /** A fresh customer, for tests that need one signed-in shopper. */
  customer: Api;
  anonymous: Api;
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
