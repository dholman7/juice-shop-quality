/**
 * Every REST endpoint in the top 3 risk areas, with who should be able to call it.
 * This is the product's intended access policy, not what Juice Shop does today:
 * where they differ, the generated tests fail and the gap is a bug.
 * Drives tests/api/access-matrix.spec.ts, tests/api/isolation.spec.ts, and the coverage map.
 */
import type { Role } from './config';

/** The top 3 risk areas from the strategy's ranking. */
export type Area = 'R1' | 'R2' | 'R3';

export const AREAS: Record<Area, string> = {
  R1: 'Customer data isolation',
  R2: 'Checkout and payment',
  R3: 'Login and account security',
};

/**
 * public        anyone, including anonymous callers
 * authenticated any signed-in role
 * owner         signed-in callers on their own records only (cross-customer access is tested separately)
 * Role[]        only the listed roles
 * nobody        no caller through the public API
 */
export type Access = 'public' | 'authenticated' | 'owner' | 'nobody' | Role[];

export interface Endpoint {
  /** Stable name used by probes, test annotations, the coverage map, and triage. */
  id: string;
  area: Area;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  access: Access;
  /** Roles besides the owner that may act on another customer's record. */
  crossCustomer?: Role[];
  /** Why some roles are not exercised, when that is the case. */
  note?: string;
}

// Adding an endpoint here adds an access test for every role; it also needs a probe in src/probes.ts.
export const ENDPOINTS: Endpoint[] = [
  // R1 Customer data isolation
  { id: 'basket.get', area: 'R1', method: 'GET', path: '/rest/basket/:id', access: 'owner' },
  { id: 'basketItems.list', area: 'R1', method: 'GET', path: '/api/BasketItems', access: ['admin'] },
  { id: 'basketItems.create', area: 'R1', method: 'POST', path: '/api/BasketItems', access: 'owner' },
  { id: 'basketItems.get', area: 'R1', method: 'GET', path: '/api/BasketItems/:id', access: 'owner' },
  { id: 'basketItems.update', area: 'R1', method: 'PUT', path: '/api/BasketItems/:id', access: 'owner' },
  { id: 'basketItems.delete', area: 'R1', method: 'DELETE', path: '/api/BasketItems/:id', access: 'owner' },
  { id: 'addresses.list', area: 'R1', method: 'GET', path: '/api/Addresss', access: 'authenticated' },
  { id: 'addresses.create', area: 'R1', method: 'POST', path: '/api/Addresss', access: 'authenticated' },
  { id: 'addresses.get', area: 'R1', method: 'GET', path: '/api/Addresss/:id', access: 'owner' },
  { id: 'addresses.update', area: 'R1', method: 'PUT', path: '/api/Addresss/:id', access: 'owner' },
  { id: 'addresses.delete', area: 'R1', method: 'DELETE', path: '/api/Addresss/:id', access: 'owner' },
  { id: 'cards.list', area: 'R1', method: 'GET', path: '/api/Cards', access: 'authenticated' },
  { id: 'cards.create', area: 'R1', method: 'POST', path: '/api/Cards', access: 'authenticated' },
  { id: 'cards.get', area: 'R1', method: 'GET', path: '/api/Cards/:id', access: 'owner' },
  { id: 'cards.update', area: 'R1', method: 'PUT', path: '/api/Cards/:id', access: 'nobody' },
  { id: 'cards.delete', area: 'R1', method: 'DELETE', path: '/api/Cards/:id', access: 'owner' },
  { id: 'orders.history', area: 'R1', method: 'GET', path: '/rest/order-history', access: 'authenticated' },
  { id: 'dataExport.captcha', area: 'R1', method: 'GET', path: '/rest/image-captcha', access: 'authenticated' },
  { id: 'dataExport.create', area: 'R1', method: 'POST', path: '/rest/user/data-export', access: 'authenticated' },
  { id: 'users.list', area: 'R1', method: 'GET', path: '/api/Users', access: ['admin'] },
  { id: 'users.get', area: 'R1', method: 'GET', path: '/api/Users/:id', access: 'owner', crossCustomer: ['admin'] },
  { id: 'users.update', area: 'R1', method: 'PUT', path: '/api/Users/:id', access: 'nobody' },
  { id: 'users.delete', area: 'R1', method: 'DELETE', path: '/api/Users/:id', access: 'nobody' },
  { id: 'users.authDetails', area: 'R1', method: 'GET', path: '/rest/user/authentication-details', access: ['admin'] },

  // R2 Checkout and payment
  { id: 'basket.coupon', area: 'R2', method: 'PUT', path: '/rest/basket/:id/coupon/:coupon', access: 'owner' },
  { id: 'basket.checkout', area: 'R2', method: 'POST', path: '/rest/basket/:id/checkout', access: 'owner' },
  { id: 'deliveries.list', area: 'R2', method: 'GET', path: '/api/Deliverys', access: 'public' },
  { id: 'deliveries.get', area: 'R2', method: 'GET', path: '/api/Deliverys/:id', access: 'public' },
  { id: 'wallet.get', area: 'R2', method: 'GET', path: '/rest/wallet/balance', access: 'authenticated' },
  { id: 'wallet.topUp', area: 'R2', method: 'PUT', path: '/rest/wallet/balance', access: 'authenticated' },
  { id: 'deluxe.status', area: 'R2', method: 'GET', path: '/rest/deluxe-membership', access: 'public' },
  { id: 'deluxe.buy', area: 'R2', method: 'POST', path: '/rest/deluxe-membership', access: ['customer'] },
  { id: 'orders.track', area: 'R2', method: 'GET', path: '/rest/track-order/:id', access: 'public' },
  { id: 'orders.all', area: 'R2', method: 'GET', path: '/rest/order-history/orders', access: ['accounting'] },
  { id: 'orders.deliveryStatus', area: 'R2', method: 'PUT', path: '/rest/order-history/:id/delivery-status', access: ['accounting'] },
  { id: 'stock.list', area: 'R2', method: 'GET', path: '/api/Quantitys', access: 'public' },
  {
    id: 'stock.update', area: 'R2', method: 'PUT', path: '/api/Quantitys/:id', access: [],
    note: 'Accounting may update stock only from the office IP allow-list, so every caller from a test machine is refused.',
  },
  { id: 'stock.create', area: 'R2', method: 'POST', path: '/api/Quantitys', access: 'nobody' },
  { id: 'stock.delete', area: 'R2', method: 'DELETE', path: '/api/Quantitys/:id', access: 'nobody' },
  { id: 'products.list', area: 'R2', method: 'GET', path: '/api/Products', access: 'public' },
  { id: 'products.get', area: 'R2', method: 'GET', path: '/api/Products/:id', access: 'public' },
  { id: 'products.create', area: 'R2', method: 'POST', path: '/api/Products', access: ['admin'] },
  { id: 'products.update', area: 'R2', method: 'PUT', path: '/api/Products/:id', access: ['admin'] },
  { id: 'products.delete', area: 'R2', method: 'DELETE', path: '/api/Products/:id', access: 'nobody' },
  { id: 'b2b.order', area: 'R2', method: 'POST', path: '/b2b/v2/orders', access: 'authenticated' },

  // R3 Login and account security
  { id: 'users.register', area: 'R3', method: 'POST', path: '/api/Users', access: 'public' },
  { id: 'auth.login', area: 'R3', method: 'POST', path: '/rest/user/login', access: 'public' },
  { id: 'auth.whoami', area: 'R3', method: 'GET', path: '/rest/user/whoami', access: 'public' },
  { id: 'auth.saveLoginIp', area: 'R3', method: 'GET', path: '/rest/saveLoginIp', access: 'authenticated' },
  { id: 'password.change', area: 'R3', method: 'GET', path: '/rest/user/change-password', access: 'authenticated' },
  { id: 'password.reset', area: 'R3', method: 'POST', path: '/rest/user/reset-password', access: 'public' },
  { id: 'securityQuestion.forEmail', area: 'R3', method: 'GET', path: '/rest/user/security-question', access: 'public' },
  { id: 'securityQuestions.list', area: 'R3', method: 'GET', path: '/api/SecurityQuestions', access: 'public' },
  { id: 'securityQuestions.get', area: 'R3', method: 'GET', path: '/api/SecurityQuestions/:id', access: 'nobody' },
  { id: 'securityQuestions.create', area: 'R3', method: 'POST', path: '/api/SecurityQuestions', access: 'nobody' },
  { id: 'securityAnswers.list', area: 'R3', method: 'GET', path: '/api/SecurityAnswers', access: 'nobody' },
  { id: 'securityAnswers.create', area: 'R3', method: 'POST', path: '/api/SecurityAnswers', access: 'public',
    note: 'Called once by the sign-up page right after registration.' },
  { id: 'securityAnswers.get', area: 'R3', method: 'GET', path: '/api/SecurityAnswers/:id', access: 'nobody' },
  { id: '2fa.status', area: 'R3', method: 'GET', path: '/rest/2fa/status', access: 'authenticated' },
  { id: '2fa.setup', area: 'R3', method: 'POST', path: '/rest/2fa/setup', access: 'authenticated',
    note: 'Not run as admin or accounting: later tests on the same worker sign in with that QA staff account, and turning on 2FA would lock them out.' },
  { id: '2fa.verify', area: 'R3', method: 'POST', path: '/rest/2fa/verify', access: 'public' },
  { id: '2fa.disable', area: 'R3', method: 'POST', path: '/rest/2fa/disable', access: 'authenticated',
    note: 'Not run as admin or accounting, for the same reason as setup.' },
  { id: 'passkey.registerOptions', area: 'R3', method: 'GET', path: '/rest/passkey/register-options', access: 'authenticated' },
  { id: 'passkey.registerVerify', area: 'R3', method: 'POST', path: '/rest/passkey/register-verify', access: 'authenticated',
    note: 'A successful ceremony needs a real authenticator, and any failed one returns 401, so only the anonymous refusal is checked here.' },
  { id: 'passkey.loginOptions', area: 'R3', method: 'POST', path: '/rest/passkey/login-options', access: 'public' },
  { id: 'passkey.loginVerify', area: 'R3', method: 'POST', path: '/rest/passkey/login-verify', access: 'public',
    note: 'Needs a real authenticator to succeed; tests/api/auth.spec.ts checks that a forged assertion is rejected.' },
  { id: 'passkey.credentials', area: 'R3', method: 'GET', path: '/rest/passkey/credentials', access: 'authenticated' },
  { id: 'passkey.deleteCredential', area: 'R3', method: 'DELETE', path: '/rest/passkey/credentials/:id', access: 'authenticated' },
];

/**
 * Whether the policy lets this role call the endpoint on its own records. "owner" counts as
 * any signed-in role here; access to someone else's record is checked in isolation.spec.ts.
 */
export function allows(endpoint: Endpoint, role: Role): boolean {
  const { access } = endpoint;
  if (access === 'public') return true;
  if (access === 'nobody') return false;
  if (access === 'authenticated' || access === 'owner') return role !== 'anonymous';
  return access.includes(role);
}

/** Looks up an endpoint by id; throws on a typo instead of silently testing nothing. */
export const endpoint = (id: string): Endpoint => {
  const found = ENDPOINTS.find((e) => e.id === id);
  if (!found) throw new Error(`unknown endpoint id ${id}`);
  return found;
};
