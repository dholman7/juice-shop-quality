/**
 * R1: one customer must never read or change another customer's records.
 * Last quarter a customer saw another customer's basket; these tests reproduce that class
 * of bug for every owner-only endpoint, as every role.
 */
import { randomUUID } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import { test, expect, covers } from '../../src/fixtures';
import { Api, VALID_ADDRESS, VALID_CARD, addAddress, addCard, addToBasket, newCustomer } from '../../src/api';
import { ROLES, type Role } from '../../src/config';
import { endpoint } from '../../src/catalog';
import { coupon, checkout, basket } from '../../src/shop';

/** Another customer's records, each tagged with a unique marker so a leak is easy to spot in any response. */
interface Victim {
  api: Api;
  marker: string;
  itemId: number;
  addressId: number;
  cardId: number;
}

async function victim(request: APIRequestContext): Promise<Victim> {
  const api = new Api(request, await newCustomer(request));
  const marker = `Victim ${randomUUID().slice(0, 8)}`;
  return {
    api,
    marker,
    itemId: await addToBasket(api, 1, 1),
    addressId: await addAddress(api, { ...VALID_ADDRESS, fullName: marker }),
    cardId: await addCard(api, { ...VALID_CARD, fullName: marker }),
  };
}

// 404 counts as a refusal: hiding that the record exists is as good as refusing it.
const REFUSED = [400, 401, 403, 404];
const refused = (status: number, label: string) => expect(REFUSED, `${label} returned ${status}`).toContain(status);

/** One owner-only endpoint: the attack, and how to check nothing changed for the victim. */
interface Case {
  id: string;
  /** What the attacker tries. */
  act: (attacker: Api, v: Victim) => Promise<{ status: number; body: string }>;
  /** Proof the victim's data is intact, checked as the victim. */
  intact?: (v: Victim) => Promise<void>;
}

const send = async (p: Promise<import('@playwright/test').APIResponse>) => {
  const res = await p;
  return { status: res.status(), body: await res.text() };
};

const itemQuantity = async (v: Victim) =>
  (await basket(v.api)).Products.find((p) => p.id === 1)?.BasketItem.quantity;

// Every owner-only endpoint in the catalog that takes a record id or basket id.
const CASES: Case[] = [
  { id: 'basket.get', act: (a, v) => send(a.get(`/rest/basket/${v.api.account!.basketId}`)) },
  {
    id: 'basketItems.create',
    act: (a, v) => send(a.post('/api/BasketItems', { ProductId: 2, BasketId: v.api.account!.basketId, quantity: 1 })),
    intact: async (v) => expect((await basket(v.api)).Products.map((p) => p.id)).toEqual([1]),
  },
  { id: 'basketItems.get', act: (a, v) => send(a.get(`/api/BasketItems/${v.itemId}`)) },
  {
    id: 'basketItems.update',
    act: (a, v) => send(a.put(`/api/BasketItems/${v.itemId}`, { quantity: 3 })),
    intact: async (v) => expect(await itemQuantity(v)).toBe(1),
  },
  {
    id: 'basketItems.delete',
    act: (a, v) => send(a.delete(`/api/BasketItems/${v.itemId}`)),
    intact: async (v) => expect(await itemQuantity(v)).toBe(1),
  },
  { id: 'addresses.get', act: (a, v) => send(a.get(`/api/Addresss/${v.addressId}`)) },
  {
    id: 'addresses.update',
    act: (a, v) => send(a.put(`/api/Addresss/${v.addressId}`, { city: 'Changed by someone else' })),
    intact: async (v) => {
      const res = await v.api.get(`/api/Addresss/${v.addressId}`);
      expect(res.status(), 'victim can still read their address').toBe(200);
      expect((await res.json()).data.city).toBe(VALID_ADDRESS.city);
    },
  },
  {
    id: 'addresses.delete',
    act: (a, v) => send(a.delete(`/api/Addresss/${v.addressId}`)),
    intact: async (v) => expect((await v.api.get(`/api/Addresss/${v.addressId}`)).status()).toBe(200),
  },
  { id: 'cards.get', act: (a, v) => send(a.get(`/api/Cards/${v.cardId}`)) },
  {
    id: 'cards.delete',
    act: (a, v) => send(a.delete(`/api/Cards/${v.cardId}`)),
    intact: async (v) => expect((await v.api.get(`/api/Cards/${v.cardId}`)).status()).toBe(200),
  },
  { id: 'users.get', act: (a, v) => send(a.get(`/api/Users/${v.api.account!.id}`)) },
  {
    id: 'basket.coupon',
    act: (a, v) => send(a.put(`/rest/basket/${v.api.account!.basketId}/coupon/${encodeURIComponent(coupon(10))}`)),
    intact: async (v) => {
      const res = await v.api.get(`/rest/basket/${v.api.account!.basketId}`);
      expect((await res.json()).data.coupon).toBeNull();
    },
  },
  {
    id: 'basket.checkout',
    act: (a, v) => send(a.post(`/rest/basket/${v.api.account!.basketId}/checkout`, {
      orderDetails: { paymentId: v.cardId, addressId: v.addressId, deliveryMethodId: 1 },
    })),
    intact: async (v) => expect(await itemQuantity(v)).toBe(1),
  },
];

for (const c of CASES) {
  const ep = endpoint(c.id);
  test.describe(`${ep.area} isolation › ${ep.method} ${ep.path} on another customer's record`, () => {
    for (const role of ROLES) {
      const allowed = ep.crossCustomer?.includes(role) ?? false;
      test(`${allowed ? 'allows' : 'refuses'} ${role}`, covers(ep.id, role), async ({ request, as }) => {
        // Arrange
        const v = await victim(request);
        const attacker = await as(role);

        // Act
        const { status, body } = await c.act(attacker, v);

        // Assert
        if (allowed) {
          expect(status).toBe(200);
          return;
        }
        // A refusal isn't enough: the body must not leak the victim's data, and a write must not have landed.
        refused(status, `${ep.method} ${ep.path} as ${role}`);
        expect(body, 'response must not contain the other customer\'s data').not.toContain(v.marker);
        expect(body).not.toContain(v.api.account!.email);
        await c.intact?.(v);
      });
    }
  });
}

// List endpoints take no id, so the risk is returning everyone's records instead of the caller's.
test.describe('R1 isolation › lists only show the caller\'s own records', () => {
  const lists: [string, string][] = [
    ['addresses.list', '/api/Addresss'],
    ['cards.list', '/api/Cards'],
    ['orders.history', '/rest/order-history'],
  ];
  for (const [id, path] of lists) {
    for (const role of ROLES.filter((r): r is Exclude<Role, 'anonymous'> => r !== 'anonymous')) {
      test(`GET ${path} as ${role} excludes another customer's records`, covers(id, role), async ({ request, as }) => {
        // Arrange
        const v = await victim(request);
        await checkout(v.api, { itemId: v.itemId, addressId: v.addressId, cardId: v.cardId });
        const caller = await as(role);

        // Act
        const res = await caller.get(path);

        // Assert
        expect(res.status()).toBe(200);
        const body = await res.text();
        expect(body).not.toContain(v.marker);
        // Order history shows emails with vowels masked, so check for that form too.
        expect(body).not.toContain(v.api.account!.email.replace(/[aeiou]/gi, '*'));
      });
    }
  }
});

test('R1 isolation › a duplicate BasketId key cannot add items to another customer\'s basket',
  covers('basketItems.create', 'customer'), async ({ request, customer }) => {
    // Arrange: a body with BasketId twice, the caller's then the victim's. Sent as raw text because
    // a JS object can't hold a duplicate key. Checks that ownership and the write use the same value.
    const v = await victim(request);
    const raw = `{"ProductId": 2, "BasketId": "${customer.account!.basketId}", "quantity": 1, "BasketId": "${v.api.account!.basketId}"}`;

    // Act
    const res = await request.post('/api/BasketItems', {
      headers: { Authorization: `Bearer ${customer.account!.token}`, 'Content-Type': 'application/json' },
      data: raw,
    });

    // Assert
    refused(res.status(), 'POST /api/BasketItems with two BasketId keys');
    expect((await basket(v.api)).Products.map((p) => p.id)).toEqual([1]);
  });
