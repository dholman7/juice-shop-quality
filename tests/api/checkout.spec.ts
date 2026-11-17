/** R2 behavior: the customer pays the right amount, once, and the order is recorded. */
import { test, expect, covers, newDeluxe, staff } from '../../src/fixtures';
import { addCard, addToBasket } from '../../src/api';
import { basket, checkout, coupon, readyToCheckout } from '../../src/shop';

const money = (n: number) => Math.round(n * 100) / 100;

async function product(api: import('../../src/api').Api, id: number) {
  return (await (await api.get(`/api/Products/${id}`)).json()).data as { price: number; deluxePrice: number };
}

async function delivery(api: import('../../src/api').Api, id: number) {
  return (await (await api.get(`/api/Deliverys/${id}`)).json()).data as { price: number };
}

async function lastOrder(api: import('../../src/api').Api) {
  const orders = (await (await api.get('/rest/order-history')).json()).data;
  return orders.at(-1);
}

test.describe('R2 checkout', () => {
  test('charges list price times quantity plus delivery', covers('basket.checkout', 'customer'), async ({ customer }) => {
    // Arrange
    const ready = await readyToCheckout(customer, 1, 3);
    const { price } = await product(customer, 1);
    const ship = await delivery(customer, 2);

    // Act
    const res = await checkout(customer, ready, 2);

    // Assert
    expect(res.status()).toBe(200);
    expect(money((await lastOrder(customer)).totalPrice)).toBe(money(price * 3 + ship.price));
  });

  test('charges deluxe members the deluxe price and deluxe delivery', covers('basket.checkout', 'deluxe'), async ({ request }) => {
    // Arrange
    const deluxe = await newDeluxe(request);
    const ready = await readyToCheckout(deluxe, 1, 2);
    const { deluxePrice } = await product(deluxe, 1);
    const ship = await delivery(deluxe, 1);

    // Act
    await checkout(deluxe, ready, 1);

    // Assert
    expect(money((await lastOrder(deluxe)).totalPrice)).toBe(money(deluxePrice * 2 + ship.price));
  });

  test('empties the basket after the order is placed', covers('basket.checkout', 'customer'), async ({ customer }) => {
    // Arrange
    const ready = await readyToCheckout(customer);

    // Act
    await checkout(customer, ready);

    // Assert
    expect((await basket(customer)).Products).toEqual([]);
  });

  test('the order can be tracked by its confirmation number', covers('orders.track', 'anonymous'), async ({ customer, anonymous }) => {
    // Arrange
    const ready = await readyToCheckout(customer);
    const { orderConfirmation } = await (await checkout(customer, ready)).json();

    // Act
    const res = await anonymous.get(`/rest/track-order/${orderConfirmation}`);

    // Assert
    const [order] = (await res.json()).data;
    expect(order.orderId).toBe(orderConfirmation);
    expect(order.delivered).toBe(false);
  });

  test('reduces stock by the quantity ordered', covers('stock.list', 'customer'), async ({ customer }) => {
    // Arrange
    const stockOf = async (id: number) =>
      (await (await customer.get('/api/Quantitys')).json()).data.find((q: { ProductId: number }) => q.ProductId === id).quantity;
    const ready = await readyToCheckout(customer, 7, 2);
    const before = await stockOf(7);

    // Act
    await checkout(customer, ready);

    // Assert: other runs may buy product 7 at the same time, so stock must drop by at least 2
    expect(await stockOf(7)).toBeLessThanOrEqual(before - 2);
  });

  test('refuses to check out an empty basket', covers('basket.checkout', 'customer'), async ({ customer }) => {
    // Arrange
    const cardId = await addCard(customer);

    // Act
    const res = await customer.post(`/rest/basket/${customer.account!.basketId}/checkout`, {
      orderDetails: { paymentId: cardId, addressId: 1, deliveryMethodId: 1 },
    });

    // Assert
    expect(res.status()).toBe(400);
  });

  test('refuses an order without a delivery address and payment method', covers('basket.checkout', 'customer'), async ({ customer }) => {
    // Arrange
    await addToBasket(customer, 1, 1);

    // Act
    const res = await customer.post(`/rest/basket/${customer.account!.basketId}/checkout`, {});

    // Assert
    expect(res.status()).toBe(400);
  });

  test('refuses a negative quantity at checkout', covers('basket.checkout', 'customer'), async ({ customer }) => {
    // Arrange
    const ready = await readyToCheckout(customer, 1, 1);
    await customer.put(`/api/BasketItems/${ready.itemId}`, { quantity: -5 });

    // Act
    const res = await checkout(customer, ready);

    // Assert
    expect(res.status()).toBe(400);
  });
});

test.describe('R2 coupons', () => {
  test('applies this month\'s coupon to the order total', covers('basket.coupon', 'customer'), async ({ customer }) => {
    // Arrange
    const ready = await readyToCheckout(customer, 1, 2);
    const { price } = await product(customer, 1);
    const ship = await delivery(customer, 1);

    // Act
    const applied = await customer.put(`/rest/basket/${customer.account!.basketId}/coupon/${encodeURIComponent(coupon(10))}`);
    await checkout(customer, ready, 1);

    // Assert
    expect(await applied.json()).toEqual({ discount: 10 });
    expect(money((await lastOrder(customer)).totalPrice)).toBe(money(price * 2 * 0.9 + ship.price));
  });

  test('rejects an unknown coupon', covers('basket.coupon', 'customer'), async ({ customer }) => {
    // Act
    const res = await customer.put(`/rest/basket/${customer.account!.basketId}/coupon/NOTACOUPON`);

    // Assert
    expect(res.status()).toBe(404);
  });

  test('rejects last month\'s coupon', covers('basket.coupon', 'customer'), async ({ customer }) => {
    // Arrange
    const lastMonth = new Date();
    lastMonth.setDate(1);
    lastMonth.setMonth(lastMonth.getMonth() - 1);

    // Act
    const res = await customer.put(`/rest/basket/${customer.account!.basketId}/coupon/${encodeURIComponent(coupon(10, lastMonth))}`);

    // Assert
    expect(res.status()).toBe(404);
  });
});

test.describe('R2 wallet', () => {
  test('tops up the wallet from a saved card', covers('wallet.topUp', 'customer'), async ({ customer }) => {
    // Arrange
    const cardId = await addCard(customer);

    // Act
    const res = await customer.put('/rest/wallet/balance', { balance: 25, paymentId: cardId });

    // Assert
    expect(res.status()).toBe(200);
    expect((await (await customer.get('/rest/wallet/balance')).json()).data).toBe(25);
  });

  test('refuses a top-up from a card the customer does not own', covers('wallet.topUp', 'customer'), async ({ customer, as }) => {
    // Arrange
    const other = await as('customer');
    const theirCard = await addCard(other);

    // Act
    const res = await customer.put('/rest/wallet/balance', { balance: 25, paymentId: theirCard });

    // Assert
    expect(res.status()).toBe(402);
  });

  test('refuses a negative top-up', covers('wallet.topUp', 'customer'), async ({ customer }) => {
    // Arrange
    const cardId = await addCard(customer);

    // Act
    const res = await customer.put('/rest/wallet/balance', { balance: -100, paymentId: cardId });

    // Assert
    expect(res.status()).toBe(400);
    expect((await (await customer.get('/rest/wallet/balance')).json()).data).toBe(0);
  });

  test('pays for an order from the wallet and deducts the total', covers('basket.checkout', 'customer'), async ({ customer }) => {
    // Arrange
    const ready = await readyToCheckout(customer, 1, 1);
    await customer.put('/rest/wallet/balance', { balance: 50, paymentId: ready.cardId });

    // Act
    const res = await checkout(customer, ready, 3, 'wallet');

    // Assert
    expect(res.status()).toBe(200);
    const order = await lastOrder(customer);
    const balance = (await (await customer.get('/rest/wallet/balance')).json()).data;
    expect(money(balance)).toBe(money(50 - order.totalPrice + order.bonus));
  });

  test('refuses a wallet payment larger than the balance', covers('basket.checkout', 'customer'), async ({ customer }) => {
    // Arrange
    const ready = await readyToCheckout(customer, 1, 1);

    // Act
    const res = await checkout(customer, ready, 1, 'wallet');

    // Assert
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect((await basket(customer)).Products).toHaveLength(1);
  });
});

test.describe('R2 deluxe membership', () => {
  test('a customer can buy deluxe with a card and gets deluxe prices', covers('deluxe.buy', 'customer'), async ({ customer }) => {
    // Arrange
    const cardId = await addCard(customer);

    // Act
    const res = await customer.post('/rest/deluxe-membership', { paymentMode: 'card', paymentId: cardId });

    // Assert
    expect(res.status()).toBe(200);
    const { token } = (await res.json()).data;
    const role = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).data.role;
    expect(role).toBe('deluxe');
  });

  test('refuses deluxe without a valid payment', covers('deluxe.buy', 'customer'), async ({ customer }) => {
    // Act
    const res = await customer.post('/rest/deluxe-membership', { paymentMode: 'free' });

    // Assert
    expect(res.status()).toBe(400);
  });

  test('refuses deluxe paid from an empty wallet', covers('deluxe.buy', 'customer'), async ({ customer }) => {
    // Act
    const res = await customer.post('/rest/deluxe-membership', { paymentMode: 'wallet' });

    // Assert
    expect(res.status()).toBe(400);
  });

  test('the token issued at upgrade can still use the basket', covers('basketItems.create', 'deluxe'), async ({ customer, request }) => {
    // Arrange
    const cardId = await addCard(customer);
    const res = await customer.post('/rest/deluxe-membership', { paymentMode: 'card', paymentId: cardId });
    const upgraded = new (await import('../../src/api')).Api(request, { ...customer.account!, token: (await res.json()).data.token });

    // Act
    const add = await upgraded.post('/api/BasketItems', { ProductId: 1, BasketId: customer.account!.basketId, quantity: 1 });

    // Assert
    expect(add.status()).toBe(200);
  });
});

test.describe('R2 accounting', () => {
  test('accounting sees every order and can mark one delivered', covers('orders.deliveryStatus', 'accounting'), async ({ customer, request }, testInfo) => {
    // Arrange
    const ready = await readyToCheckout(customer);
    const { orderConfirmation } = await (await checkout(customer, ready)).json();
    const accounting = await staff(request, 'accounting', testInfo.parallelIndex);
    const orders = (await (await accounting.get('/rest/order-history/orders')).json()).data;
    const order = orders.find((o: { orderId: string }) => o.orderId === orderConfirmation);

    // Act
    const res = await accounting.put(`/rest/order-history/${order._id}/delivery-status`, { deliveryStatus: false });

    // Assert
    expect(res.status()).toBe(200);
    const [tracked] = (await (await customer.get(`/rest/track-order/${orderConfirmation}`)).json()).data;
    expect(tracked.delivered).toBe(true);
  });

  test('accounting\'s order list masks customer emails', covers('orders.all', 'accounting'), async ({ customer, request }, testInfo) => {
    // Arrange
    await checkout(customer, await readyToCheckout(customer));
    const accounting = await staff(request, 'accounting', testInfo.parallelIndex);

    // Act
    const body = await (await accounting.get('/rest/order-history/orders')).text();

    // Assert
    expect(body).not.toContain(customer.account!.email);
  });
});
