/** Domain helpers that need more than one call: coupons, 2FA, and getting a basket to checkout. Used by the behavior specs. */
import { generate } from 'otplib';

/**
 * A TOTP code with at least 5 seconds left in its 30-second window. A code made in the
 * last second can expire before the server checks it, which shows up as a random 401.
 */
export async function freshTotp(secret: string): Promise<string> {
  const left = 30 - (Math.floor(Date.now() / 1000) % 30);
  if (left < 5) await new Promise((r) => setTimeout(r, left * 1000 + 200));
  return generate({ secret });
}
import { Api, addAddress, addCard, addToBasket, login, register, type Account } from './api';
import type { APIRequestContext } from '@playwright/test';

/** The Z85 alphabet (ZeroMQ's base-85). Juice Shop coupon codes are Z85-encoded text. */
const Z85 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-:+=^!/*?&<>()[]{}@%$#';

/** Each 4 bytes become 5 characters, most significant first. */
function z85Encode(text: string): string {
  const bytes = Buffer.from(text);
  if (bytes.length % 4 !== 0) throw new Error('z85 input must be a multiple of 4 bytes');
  let out = '';
  for (let i = 0; i < bytes.length; i += 4) {
    let value = bytes.readUInt32BE(i);
    const chunk: string[] = [];
    for (let j = 0; j < 5; j++) {
      chunk.unshift(Z85[value % 85]);
      value = Math.floor(value / 85);
    }
    out += chunk.join('');
  }
  return out;
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/**
 * A coupon in the format marketing issues: "<MMMYY>-<discount %>", z85-encoded, valid for one month.
 * Anyone who knows the format can build a valid one (a forgery risk); the specs build theirs this way.
 */
export function coupon(discount: number, date = new Date()): string {
  const mmmyy = MONTHS[date.getMonth()] + String(date.getFullYear()).slice(-2);
  return z85Encode(`${mmmyy}-${String(discount).padStart(2, '0')}`);
}

export interface TwoFactorAccount {
  email: string;
  password: string;
  secret: string;
  api: Api;
}

/**
 * Registers a customer and turns on 2FA through the same calls the settings page makes:
 * status issues a secret and a setupToken, then setup needs the password, that setupToken,
 * and a current code. Each status call issues a new secret, so setup must use this call's.
 */
export async function customerWith2fa(request: APIRequestContext): Promise<TwoFactorAccount> {
  const { email, password } = await register(request);
  const api = new Api(request, await login(request, email, password));
  const status = await (await api.get('/rest/2fa/status')).json();
  const res = await api.post('/rest/2fa/setup', {
    password,
    setupToken: status.setupToken,
    initialToken: await freshTotp(status.secret),
  });
  if (res.status() !== 200) throw new Error(`2fa setup: ${res.status()}`);
  return { email, password, secret: status.secret, api };
}

/**
 * Logs in a 2FA account: the password step returns a tmpToken instead of a session,
 * then /rest/2fa/verify trades it plus a TOTP code for the real token.
 * id is 0 because no caller needs it.
 */
export async function loginWith2fa(request: APIRequestContext, acct: TwoFactorAccount): Promise<Account> {
  const first = await request.post('/rest/user/login', { data: { email: acct.email, password: acct.password } });
  const tmpToken = (await first.json()).data.tmpToken;
  const res = await request.post('/rest/2fa/verify', {
    data: { tmpToken, totpToken: await freshTotp(acct.secret) },
  });
  if (res.status() !== 200) throw new Error(`2fa verify: ${res.status()}`);
  const { token, bid } = (await res.json()).authentication;
  return { id: 0, email: acct.email, password: acct.password, token, basketId: bid };
}

export interface ReadyBasket {
  addressId: number;
  cardId: number;
  itemId: number;
}

/** Puts one product in the basket and saves an address and card, ready for checkout. */
export async function readyToCheckout(api: Api, productId = 1, quantity = 1): Promise<ReadyBasket> {
  const itemId = await addToBasket(api, productId, quantity);
  return { itemId, addressId: await addAddress(api), cardId: await addCard(api) };
}

/** Places the order for the account's own basket. Returns the raw response so tests can assert on refusals. */
export async function checkout(api: Api, ready: ReadyBasket, deliveryMethodId = 1, paymentId: number | 'wallet' = ready.cardId) {
  return api.post(`/rest/basket/${api.account!.basketId}/checkout`, {
    orderDetails: { paymentId, addressId: ready.addressId, deliveryMethodId },
  });
}

/** The account's basket contents, with each product's price and the quantity in the basket. */
export async function basket(api: Api): Promise<{ Products: { id: number; price: number; deluxePrice: number; BasketItem: { quantity: number } }[] }> {
  return (await (await api.get(`/rest/basket/${api.account!.basketId}`)).json()).data;
}
