import type { APIRequestContext, APIResponse } from '@playwright/test';
import { randomUUID } from 'node:crypto';

export interface Account {
  id: number;
  email: string;
  password: string;
  token: string;
  basketId: number;
}

type Body = Record<string, unknown> | unknown[] | string;

/** Thin wrapper over Playwright's request context that adds the bearer token. */
export class Api {
  constructor(
    readonly request: APIRequestContext,
    readonly account?: Account,
  ) {}

  private headers(): Record<string, string> {
    return this.account ? { Authorization: `Bearer ${this.account.token}` } : {};
  }

  get(path: string): Promise<APIResponse> {
    return this.request.get(path, { headers: this.headers() });
  }
  post(path: string, data?: Body): Promise<APIResponse> {
    return this.request.post(path, { headers: this.headers(), data });
  }
  put(path: string, data?: Body): Promise<APIResponse> {
    return this.request.put(path, { headers: this.headers(), data });
  }
  patch(path: string, data?: Body): Promise<APIResponse> {
    return this.request.patch(path, { headers: this.headers(), data });
  }
  delete(path: string): Promise<APIResponse> {
    return this.request.delete(path, { headers: this.headers() });
  }
  send(method: string, path: string, data?: Body): Promise<APIResponse> {
    return this.request.fetch(path, { method, headers: this.headers(), data });
  }
}

export const uniqueEmail = (prefix = 'qa'): string =>
  `${prefix}.${randomUUID().slice(0, 12)}@test.local`;

export const SECURITY_ANSWER = 'Test answer';

/** Registers a customer through the public API, the same calls the sign-up page makes. */
export async function register(
  request: APIRequestContext,
  email = uniqueEmail(),
  password = 'Valid-Passw0rd!',
): Promise<{ id: number; email: string; password: string }> {
  const res = await request.post('/api/Users', {
    data: {
      email,
      password,
      passwordRepeat: password,
      securityQuestion: { id: 1 },
      securityAnswer: SECURITY_ANSWER,
    },
  });
  if (res.status() !== 201) throw new Error(`register ${email}: ${res.status()} ${await res.text()}`);
  const id = (await res.json()).data.id as number;
  const answer = await request.post('/api/SecurityAnswers', {
    data: { UserId: id, answer: SECURITY_ANSWER, SecurityQuestionId: 1 },
  });
  if (!answer.ok()) throw new Error(`security answer for ${email}: ${answer.status()}`);
  return { id, email, password };
}

export async function login(request: APIRequestContext, email: string, password: string): Promise<Account> {
  const res = await request.post('/rest/user/login', { data: { email, password } });
  if (res.status() !== 200) throw new Error(`login ${email}: ${res.status()} ${await res.text()}`);
  const { token, bid } = (await res.json()).authentication;
  const id = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).data.id as number;
  return { id, email, password, token, basketId: bid };
}

export async function newCustomer(request: APIRequestContext): Promise<Account> {
  const { email, password } = await register(request);
  return login(request, email, password);
}

export const VALID_CARD = {
  fullName: 'Test Customer',
  cardNum: 4111111111111111,
  expMonth: 12,
  expYear: 2085, // the card model only accepts 2080-2099
};

export const VALID_ADDRESS = {
  fullName: 'Test Customer',
  mobileNum: 5555550100,
  zipCode: '53188',
  streetAddress: '100 Main St',
  city: 'Waukesha',
  state: 'WI',
  country: 'United States',
};

export async function addCard(api: Api, card = VALID_CARD): Promise<number> {
  const res = await api.post('/api/Cards', card);
  if (res.status() !== 201) throw new Error(`add card: ${res.status()} ${await res.text()}`);
  return (await res.json()).data.id;
}

export async function addAddress(api: Api, address = VALID_ADDRESS): Promise<number> {
  const res = await api.post('/api/Addresss', address);
  if (res.status() !== 201) throw new Error(`add address: ${res.status()} ${await res.text()}`);
  return (await res.json()).data.id;
}

export async function addToBasket(api: Api, productId = 1, quantity = 1): Promise<number> {
  const res = await api.post('/api/BasketItems', { ProductId: productId, BasketId: api.account!.basketId, quantity });
  if (!res.ok()) throw new Error(`add to basket: ${res.status()} ${await res.text()}`);
  return (await res.json()).data.id;
}

/** Upgrades a fresh customer to deluxe by paying with a card; returns the account with its new token. */
export async function upgradeToDeluxe(api: Api): Promise<Account> {
  const cardId = await addCard(api);
  const res = await api.post('/rest/deluxe-membership', { paymentMode: 'card', paymentId: cardId });
  if (res.status() !== 200) throw new Error(`deluxe upgrade: ${res.status()} ${await res.text()}`);
  return { ...api.account!, token: (await res.json()).data.token };
}
