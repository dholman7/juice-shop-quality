/**
 * One valid request per catalog endpoint, built for a given caller.
 * The access matrix sends it as every role: allowed roles must get a success status,
 * everyone else must be refused. Builders create whatever the request needs (a basket item, an
 * address, a card) on the right account first, so a refusal can't be blamed on a missing record.
 */
import type { APIRequestContext } from '@playwright/test';
import { Api, SECURITY_ANSWER, VALID_ADDRESS, VALID_CARD, addAddress, addCard, addToBasket, login, newCustomer, register, uniqueEmail } from './api';
import type { Role } from './config';
import { qaStaff } from './staff';
import { coupon, customerWith2fa, freshTotp, readyToCheckout } from './shop';
import { registerPasskey, registrationBody, signInBody } from './passkey';

/** The request to send, and which statuses count as success or refusal for this endpoint. */
export interface Probe {
  path: string;
  data?: Record<string, unknown> | string;
  /** Statuses that mean the call succeeded for an allowed caller. */
  ok: number[];
  /** Statuses that count as a refusal for a caller who is not allowed. Defaults to 401 and 403. */
  refused?: number[];
}

/** What a builder gets: the caller under test and a way to create records it should own. */
export interface ProbeContext {
  request: APIRequestContext;
  caller: Api;
  role: Role;
  /** The caller's own records, or a throwaway customer's when the caller is anonymous. */
  owner: () => Promise<Api>;
}

type Builder = (ctx: ProbeContext) => Promise<Probe>;

/** A separate victim account for destructive calls, so they never change the staff accounts later tests reuse. */
const throwaway = (ctx: ProbeContext) => newCustomer(ctx.request).then((a) => new Api(ctx.request, a));

/** Worker 0's QA admin, used only to create probe products; the caller under test is separate. */
const adminApi = async (request: APIRequestContext) => {
  const { email, password } = qaStaff('admin', 0);
  return new Api(request, await login(request, email, password));
};

/** A product not yet in the caller's basket; staff accounts keep their basket between tests. */
async function productNotInBasket(api: Api): Promise<number> {
  const res = await api.get(`/rest/basket/${api.account!.basketId}`);
  const inBasket = new Set<number>(((await res.json()).data?.Products ?? []).map((p: { id: number }) => p.id));
  for (let id = 1; id <= 40; id++) if (!inBasket.has(id)) return id;
  throw new Error('basket already holds every product');
}

/** Adds a fresh basket item and returns its id. */
const addItem = async (api: Api) => addToBasket(api, await productNotInBasket(api));

/** A product created for the probe, so price and delete probes never touch the real catalog. */
async function probeProduct(request: APIRequestContext): Promise<number> {
  const res = await (await adminApi(request)).post('/api/Products', {
    name: `QA probe ${uniqueEmail('p')}`,
    description: 'Created by the access matrix',
    price: 9.99,
    deluxePrice: 8.99,
    image: 'undefined.jpg',
  });
  return (await res.json()).data.id;
}

/** One builder per catalog id. A catalog endpoint without a builder makes its access-matrix tests error out. */
export const PROBES: Record<string, Builder> = {
  // R1
  'basket.get': async (c) => ({ path: `/rest/basket/${(await c.owner()).account!.basketId}`, ok: [200] }),
  'basketItems.list': async () => ({ path: '/api/BasketItems', ok: [200] }),
  'basketItems.create': async (c) => ({
    path: '/api/BasketItems',
    data: { ProductId: c.caller.account ? await productNotInBasket(c.caller) : 1, BasketId: c.caller.account?.basketId ?? 1, quantity: 1 },
    ok: [200],
  }),
  'basketItems.get': async (c) => ({ path: `/api/BasketItems/${await addItem(await c.owner())}`, ok: [200] }),
  'basketItems.update': async (c) => ({ path: `/api/BasketItems/${await addItem(await c.owner())}`, data: { quantity: 2 }, ok: [200] }),
  'basketItems.delete': async (c) => ({ path: `/api/BasketItems/${await addItem(await c.owner())}`, ok: [200] }),
  'addresses.list': async () => ({ path: '/api/Addresss', ok: [200] }),
  'addresses.create': async () => ({ path: '/api/Addresss', data: VALID_ADDRESS, ok: [201] }),
  'addresses.get': async (c) => ({ path: `/api/Addresss/${await addAddress(await c.owner())}`, ok: [200] }),
  'addresses.update': async (c) => ({ path: `/api/Addresss/${await addAddress(await c.owner())}`, data: { city: 'Madison' }, ok: [200] }),
  'addresses.delete': async (c) => ({ path: `/api/Addresss/${await addAddress(await c.owner())}`, ok: [200] }),
  'cards.list': async () => ({ path: '/api/Cards', ok: [200] }),
  'cards.create': async () => ({ path: '/api/Cards', data: VALID_CARD, ok: [201] }),
  'cards.get': async (c) => ({ path: `/api/Cards/${await addCard(await c.owner())}`, ok: [200] }),
  'cards.update': async (c) => ({ path: `/api/Cards/${await addCard(await throwaway(c))}`, data: { fullName: 'Changed' }, ok: [200] }),
  'cards.delete': async (c) => ({ path: `/api/Cards/${await addCard(await c.owner())}`, ok: [200] }),
  'orders.history': async () => ({ path: '/rest/order-history', ok: [200] }),
  'dataExport.captcha': async () => ({ path: '/rest/image-captcha', ok: [200] }),
  'dataExport.create': async (c) => {
    // The export page asks for a CAPTCHA first and sends its answer with the request.
    // Juice Shop only enforces the CAPTCHA if one was requested in the last 5 minutes, and the
    // CAPTCHA response includes the answer. Following the real flow keeps this probe from passing
    // because of that bypass; the bypass has its own failing test in customer-data.spec.ts.
    const captcha = c.caller.account ? await (await c.caller.get('/rest/image-captcha')).json() : {};
    return { path: '/rest/user/data-export', data: { format: '1', answer: captcha.answer }, ok: [200] };
  },
  'users.list': async () => ({ path: '/api/Users', ok: [200] }),
  'users.get': async (c) => ({ path: `/api/Users/${(await c.owner()).account!.id}`, ok: [200] }),
  'users.update': async (c) => ({ path: `/api/Users/${(await throwaway(c)).account!.id}`, data: { username: 'changed' }, ok: [200] }),
  'users.delete': async (c) => ({ path: `/api/Users/${(await throwaway(c)).account!.id}`, ok: [200] }),
  'users.authDetails': async () => ({ path: '/rest/user/authentication-details', ok: [200] }),

  // R2
  'basket.coupon': async (c) => ({ path: `/rest/basket/${(await c.owner()).account!.basketId}/coupon/${encodeURIComponent(coupon(10))}`, ok: [200] }),
  'basket.checkout': async (c) => {
    const owner = await c.owner();
    const ready = await readyToCheckout(owner, await productNotInBasket(owner));
    return {
      path: `/rest/basket/${owner.account!.basketId}/checkout`,
      data: { orderDetails: { paymentId: ready.cardId, addressId: ready.addressId, deliveryMethodId: 1 } },
      ok: [200],
    };
  },
  'deliveries.list': async () => ({ path: '/api/Deliverys', ok: [200] }),
  'deliveries.get': async () => ({ path: '/api/Deliverys/1', ok: [200] }),
  'wallet.get': async () => ({ path: '/rest/wallet/balance', ok: [200] }),
  'wallet.topUp': async (c) => ({
    path: '/rest/wallet/balance',
    data: { balance: 10, paymentId: c.caller.account ? await addCard(c.caller) : 1 },
    ok: [200],
  }),
  // Customers see the price; everyone else gets a business refusal, which is the correct answer.
  'deluxe.status': async (c) => ({ path: '/rest/deluxe-membership', ok: c.role === 'customer' ? [200] : [400] }),
  'deluxe.buy': async (c) => ({
    path: '/rest/deluxe-membership',
    data: { paymentMode: 'card', paymentId: c.caller.account ? await addCard(c.caller) : 1 },
    ok: [200],
    refused: [400, 401, 403],
  }),
  'orders.track': async () => ({ path: '/rest/track-order/0000-0000000000000000', ok: [200] }),
  'orders.all': async () => ({ path: '/rest/order-history/orders', ok: [200] }),
  // A made-up order id. Accounting still gets 200 and other roles are refused, so the call tests access, not data.
  'orders.deliveryStatus': async () => ({ path: '/rest/order-history/000000000000000000000000/delivery-status', data: { deliveryStatus: false }, ok: [200] }),
  'stock.list': async () => ({ path: '/api/Quantitys', ok: [200] }),
  'stock.update': async () => ({ path: '/api/Quantitys/1', data: { quantity: 80 }, ok: [200] }),
  'stock.create': async () => ({ path: '/api/Quantitys', data: { ProductId: 1, quantity: 1 }, ok: [201] }),
  'stock.delete': async () => ({ path: '/api/Quantitys/1', ok: [200] }),
  'products.list': async () => ({ path: '/api/Products', ok: [200] }),
  'products.get': async () => ({ path: '/api/Products/1', ok: [200] }),
  'products.create': async () => ({
    path: '/api/Products',
    data: { name: `QA probe ${uniqueEmail('p')}`, description: 'Access matrix', price: 1, deluxePrice: 1, image: 'undefined.jpg' },
    ok: [201],
  }),
  'products.update': async (c) => ({ path: `/api/Products/${await probeProduct(c.request)}`, data: { price: 0.01 }, ok: [200] }),
  'products.delete': async (c) => ({ path: `/api/Products/${await probeProduct(c.request)}`, ok: [200] }),
  'b2b.order': async () => ({ path: '/b2b/v2/orders', data: { cid: 'QA-1', orderLinesData: '[{"productId": 1,"quantity": 1}]' }, ok: [200] }),

  // R3
  'users.register': async () => {
    const email = uniqueEmail();
    return {
      path: '/api/Users',
      data: { email, password: 'Valid-Passw0rd!', passwordRepeat: 'Valid-Passw0rd!', securityQuestion: { id: 1 }, securityAnswer: SECURITY_ANSWER },
      ok: [201],
    };
  },
  'auth.login': async (c) => {
    const { email, password } = await register(c.request);
    return { path: '/rest/user/login', data: { email, password }, ok: [200] };
  },
  'auth.whoami': async () => ({ path: '/rest/user/whoami', ok: [200] }),
  'auth.saveLoginIp': async () => ({ path: '/rest/saveLoginIp', ok: [200] }),
  'password.change': async (c) => {
    // A GET with the passwords in the query string, as the app sends it. Juice Shop doesn't check
    // `current` (its own failing test). Same password in and out, so staff accounts keep their credentials.
    const pw = encodeURIComponent(c.caller.account?.password ?? 'x');
    return { path: `/rest/user/change-password?current=${pw}&new=${pw}&repeat=${pw}`, ok: [200] };
  },
  'password.reset': async (c) => {
    const { email } = await register(c.request);
    return { path: '/rest/user/reset-password', data: { email, answer: SECURITY_ANSWER, new: 'Newer-Passw0rd!', repeat: 'Newer-Passw0rd!' }, ok: [200] };
  },
  'securityQuestion.forEmail': async () => ({ path: `/rest/user/security-question?email=${encodeURIComponent('admin@juice-sh.op')}`, ok: [200] }),
  'securityQuestions.list': async () => ({ path: '/api/SecurityQuestions', ok: [200] }),
  'securityQuestions.get': async () => ({ path: '/api/SecurityQuestions/1', ok: [200] }),
  'securityQuestions.create': async () => ({ path: '/api/SecurityQuestions', data: { question: 'QA probe?' }, ok: [201] }),
  'securityAnswers.list': async () => ({ path: '/api/SecurityAnswers', ok: [200] }),
  'securityAnswers.create': async (c) => {
    // A just-registered account with no answer yet, as the sign-up page sends it.
    const res = await c.request.post('/api/Users', {
      data: { email: uniqueEmail(), password: 'Valid-Passw0rd!', passwordRepeat: 'Valid-Passw0rd!' },
    });
    const id = (await res.json()).data.id;
    return { path: '/api/SecurityAnswers', data: { UserId: id, answer: SECURITY_ANSWER, SecurityQuestionId: 1 }, ok: [201] };
  },
  'securityAnswers.get': async () => ({ path: '/api/SecurityAnswers/1', ok: [200] }),
  '2fa.status': async () => ({ path: '/rest/2fa/status', ok: [200] }),
  '2fa.setup': async (c) => {
    if (!c.caller.account) return { path: '/rest/2fa/setup', data: {}, ok: [200] };
    const status = await (await c.caller.get('/rest/2fa/status')).json();
    return {
      path: '/rest/2fa/setup',
      data: { password: c.caller.account.password, setupToken: status.setupToken, initialToken: await freshTotp(status.secret) },
      ok: [200],
    };
  },
  '2fa.verify': async (c) => {
    const acct = await customerWith2fa(c.request);
    const first = await c.request.post('/rest/user/login', { data: { email: acct.email, password: acct.password } });
    const tmpToken = (await first.json()).data.tmpToken;
    return { path: '/rest/2fa/verify', data: { tmpToken, totpToken: await freshTotp(acct.secret) }, ok: [200] };
  },
  '2fa.disable': async (c) => ({ path: '/rest/2fa/disable', data: { password: c.caller.account?.password ?? 'x' }, ok: [200] }),
  'passkey.registerOptions': async () => ({ path: '/rest/passkey/register-options', ok: [200] }),
  // A real registration from the software authenticator; anonymous sends a throwaway customer's challenge.
  'passkey.registerVerify': async (c) => ({ path: '/rest/passkey/register-verify', data: await registrationBody(await c.owner()), ok: [200] }),
  'passkey.loginOptions': async () => ({ path: '/rest/passkey/login-options', data: {}, ok: [200] }),
  // Public: a throwaway customer's real passkey signs a fresh challenge, and any caller may submit it.
  'passkey.loginVerify': async (c) => {
    const owner = await throwaway(c);
    return { path: '/rest/passkey/login-verify', data: await signInBody(owner, await registerPasskey(owner)), ok: [200] };
  },
  'passkey.credentials': async () => ({ path: '/rest/passkey/credentials', ok: [200] }),
  // No credential exists; 404 still proves an allowed caller got past the access check.
  'passkey.deleteCredential': async () => ({ path: '/rest/passkey/credentials/qa-missing', ok: [204, 404] }),
};

/**
 * Role checks deliberately not run; each catalog note says why. 2FA on a staff account would lock out
 * the later tests on that worker that sign in with it.
 */
export const SKIP: Record<string, Role[]> = {
  '2fa.setup': ['accounting', 'admin'],
  '2fa.disable': ['accounting', 'admin'],
};
