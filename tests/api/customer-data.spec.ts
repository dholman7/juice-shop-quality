/** R1 behavior: customers manage their own basket, addresses, cards, and data export correctly. */
import { test, expect, covers } from '../../src/fixtures';
import { VALID_ADDRESS, VALID_CARD, addAddress, addCard, addToBasket } from '../../src/api';
import { basket } from '../../src/shop';

test.describe('R1 basket', () => {
  test('shows the products the customer added, with quantities', covers('basket.get', 'customer'), async ({ customer }) => {
    // Arrange
    await addToBasket(customer, 1, 2);
    await addToBasket(customer, 3, 1);

    // Act
    const contents = await basket(customer);

    // Assert
    expect(contents.Products.map((p) => [p.id, p.BasketItem.quantity]).sort()).toEqual([[1, 2], [3, 1]]);
  });

  test('changes the quantity of an item', covers('basketItems.update', 'customer'), async ({ customer }) => {
    // Arrange
    const itemId = await addToBasket(customer, 1, 1);

    // Act
    const res = await customer.put(`/api/BasketItems/${itemId}`, { quantity: 4 });

    // Assert
    expect(res.status()).toBe(200);
    expect((await basket(customer)).Products[0].BasketItem.quantity).toBe(4);
  });

  test('removes an item', covers('basketItems.delete', 'customer'), async ({ customer }) => {
    // Arrange
    const itemId = await addToBasket(customer, 1, 1);

    // Act
    const res = await customer.delete(`/api/BasketItems/${itemId}`);

    // Assert
    expect(res.status()).toBe(200);
    expect((await basket(customer)).Products).toEqual([]);
  });

  for (const quantity of [0, -1]) {
    test(`rejects a quantity of ${quantity}`, covers('basketItems.update', 'customer'), async ({ customer }) => {
      // Arrange
      const itemId = await addToBasket(customer, 1, 1);

      // Act
      const res = await customer.put(`/api/BasketItems/${itemId}`, { quantity });

      // Assert
      expect(res.status()).toBe(400);
      expect((await basket(customer)).Products[0].BasketItem.quantity).toBe(1);
    });
  }

  test('enforces the per-customer limit on limited products', covers('basketItems.update', 'customer'), async ({ customer }) => {
    // Arrange: product 1 is limited to 5 per customer in the seed data
    const itemId = await addToBasket(customer, 1, 1);

    // Act
    const res = await customer.put(`/api/BasketItems/${itemId}`, { quantity: 6 });

    // Assert
    expect(res.status()).toBe(400);
    expect(await res.text()).toContain('You can order only up to 5 items');
  });

  test('lets deluxe members go past the per-customer limit', covers('basketItems.update', 'deluxe'), async ({ as }) => {
    // Arrange
    const deluxe = await as('deluxe');
    const itemId = await addToBasket(deluxe, 1, 1);

    // Act
    const res = await deluxe.put(`/api/BasketItems/${itemId}`, { quantity: 6 });

    // Assert
    expect(res.status()).toBe(200);
  });

  test('rejects more than the stock on hand', covers('basketItems.update', 'deluxe'), async ({ as }) => {
    // Arrange
    const deluxe = await as('deluxe');
    const itemId = await addToBasket(deluxe, 1, 1);

    // Act
    const res = await deluxe.put(`/api/BasketItems/${itemId}`, { quantity: 100_000 });

    // Assert
    expect(res.status()).toBe(400);
    expect(await res.text()).toContain('out of stock');
  });
});

test.describe('R1 addresses', () => {
  test('saves, lists, updates, and deletes an address', covers('addresses.create', 'customer'), async ({ customer }) => {
    // Arrange
    const id = await addAddress(customer);

    // Act
    const listed = await (await customer.get('/api/Addresss')).json();
    const updated = await customer.put(`/api/Addresss/${id}`, { city: 'Madison' });
    const deleted = await customer.delete(`/api/Addresss/${id}`);

    // Assert
    expect(listed.data.map((a: { id: number }) => a.id)).toEqual([id]);
    expect((await updated.json()).data.city).toBe('Madison');
    expect(deleted.status()).toBe(200);
    expect((await (await customer.get('/api/Addresss')).json()).data).toEqual([]);
  });

  for (const [field, value] of [['mobileNum', 12], ['zipCode', '12345678901'], ['fullName', null]] as const) {
    test(`rejects an address with an invalid ${field}`, covers('addresses.create', 'customer'), async ({ customer }) => {
      // Act
      const res = await customer.post('/api/Addresss', { ...VALID_ADDRESS, [field]: value });

      // Assert
      expect(res.status()).toBe(400);
    });
  }
});

test.describe('R1 payment cards', () => {
  test('only ever returns the last four digits of a card', covers('cards.list', 'customer'), async ({ customer }) => {
    // Arrange
    const id = await addCard(customer);

    // Act
    const list = await (await customer.get('/api/Cards')).text();
    const one = await (await customer.get(`/api/Cards/${id}`)).text();

    // Assert
    for (const body of [list, one]) {
      expect(body).not.toContain(String(VALID_CARD.cardNum));
      expect(body).toContain('************1111');
    }
  });

  test('never echoes the full card number when a card is saved', covers('cards.create', 'customer'), async ({ customer }) => {
    // Act
    const res = await customer.post('/api/Cards', VALID_CARD);

    // Assert
    expect(res.status()).toBe(201);
    expect(await res.text()).not.toContain(String(VALID_CARD.cardNum));
  });

  test('rejects a card number that is not 16 digits', covers('cards.create', 'customer'), async ({ customer }) => {
    // Act
    const res = await customer.post('/api/Cards', { ...VALID_CARD, cardNum: 4111 });

    // Assert
    expect(res.status()).toBe(400);
  });

  test('deletes a saved card', covers('cards.delete', 'customer'), async ({ customer }) => {
    // Arrange
    const id = await addCard(customer);

    // Act
    const res = await customer.delete(`/api/Cards/${id}`);

    // Assert
    expect(res.status()).toBe(200);
    expect((await (await customer.get('/api/Cards')).json()).data).toEqual([]);
  });
});

test.describe('R1 account data', () => {
  test('a user record never includes the password hash', covers('users.get', 'customer'), async ({ customer }) => {
    // Act
    const res = await customer.get(`/api/Users/${customer.account!.id}`);

    // Assert
    expect(res.status()).toBe(200);
    expect((await res.json()).data).not.toHaveProperty('password');
  });

  test('the data export CAPTCHA does not include its own answer', covers('dataExport.captcha', 'customer'), async ({ customer }) => {
    // Act
    const res = await customer.get('/rest/image-captcha');

    // Assert
    expect(res.status()).toBe(200);
    expect(await res.json()).not.toHaveProperty('answer');
  });

  test('data export requires a solved CAPTCHA', covers('dataExport.create', 'customer'), async ({ customer }) => {
    // Act: no CAPTCHA requested, no answer sent
    const res = await customer.post('/rest/user/data-export', { format: '1' });

    // Assert
    expect(res.status()).toBe(401);
  });

  test('data export rejects a wrong CAPTCHA answer', covers('dataExport.create', 'customer'), async ({ customer }) => {
    // Arrange
    await customer.get('/rest/image-captcha');

    // Act
    const res = await customer.post('/rest/user/data-export', { format: '1', answer: 'wrong' });

    // Assert
    expect(res.status()).toBe(401);
  });

  test('data export contains the customer\'s own email and no password', covers('dataExport.create', 'customer'), async ({ customer }) => {
    // Arrange: reads the answer the API leaks (see the CAPTCHA test above). Once that is
    // fixed, this needs a test-only way to solve the CAPTCHA.
    const { answer } = await (await customer.get('/rest/image-captcha')).json();

    // Act
    const res = await customer.post('/rest/user/data-export', { format: '1', answer });

    // Assert
    expect(res.status()).toBe(200);
    const exported = JSON.parse((await res.json()).userData);
    expect(exported.email).toBe(customer.account!.email);
    expect(JSON.stringify(exported)).not.toMatch(/password/i);
  });
});
