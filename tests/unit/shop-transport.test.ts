import { describe, it, expect } from 'vitest';
import {
  httpShopTransport, readShopAnswer, orderIdempotencyKey, type ShopOrderRequest,
} from '../../apps/customer-app/src/shop-transport';

// M20-FR-03 / §31 — the customer app's one road to the shop. What is tested here is the shape of the
// ONE request the app makes, and that the shop's answer is read without inventing anything.

const REQUEST: ShopOrderRequest = {
  orderId: 'ORD-7', token: 'tok-session-abc',
  lines: [{ productId: 'P1', quantityMinor: 2 }], locationId: 'L1',
  payment: { providerRef: 'tok_2f9a41ce', amountMinor: 132_000, result: 'authorised' },
};

/** A fetch that answers with one status and body, and records what it was asked. */
function fakeFetch(status: number, body: unknown = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  }) as unknown as typeof globalThis.fetch;
  return { fn, calls };
}

describe('the request the app makes', () => {
  it('POSTs the reviewed basket to the storefront route with the bearer token and an idempotency key tied to the order', async () => {
    const f = fakeFetch(201, { orderId: 'ORD-7', payment: { state: 'authorised' }, tellTheCustomer: 'Your order is placed.' });
    const answer = await httpShopTransport({ fetch: f.fn, baseUrl: 'https://shop.example.test/' }).placeOrder(REQUEST);
    expect(answer).toMatchObject({ reached: true, status: 201 });
    expect(f.calls).toHaveLength(1);
    const call = f.calls[0]!;
    expect(call.url).toBe('https://shop.example.test/v1/storefront/orders/ORD-7');
    expect(call.init.method).toBe('POST');
    const headers = call.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer tok-session-abc');
    expect(headers['idempotency-key']).toBe(orderIdempotencyKey('ORD-7'));
    expect(JSON.parse(String(call.init.body))).toEqual({
      lines: [{ productId: 'P1', quantityMinor: 2 }], locationId: 'L1',
      payment: { providerRef: 'tok_2f9a41ce', amountMinor: 132_000, result: 'authorised' },
    });
  });

  it('is relative by default — the token goes only to the origin that served the page', async () => {
    const f = fakeFetch(201);
    await httpShopTransport({ fetch: f.fn }).placeOrder(REQUEST);
    expect(f.calls[0]!.url).toBe('/v1/storefront/orders/ORD-7');
  });

  it('sends nothing when the device says it has no connection — prepared, not sent', async () => {
    const f = fakeFetch(201);
    const answer = await httpShopTransport({ fetch: f.fn, isOnline: () => false }).placeOrder(REQUEST);
    expect(answer).toMatchObject({ reached: false, why: 'no_connection' });
    expect(f.calls).toHaveLength(0);
  });

  it('reports a network failure as NOT reached, never as a refusal', async () => {
    const failing = (() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof globalThis.fetch;
    const answer = await httpShopTransport({ fetch: failing }).placeOrder(REQUEST);
    expect(answer).toMatchObject({ reached: false, why: 'network_error' });
  });

  it('gives up on a shop that does not answer, and says nothing is confirmed', async () => {
    const hanging = ((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => { reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
    })) as unknown as typeof globalThis.fetch;
    const answer = await httpShopTransport({ fetch: hanging, timeoutMs: 20 }).placeOrder(REQUEST);
    expect(answer).toMatchObject({ reached: false, why: 'timed_out' });
    expect(answer.reached === false && answer.detail).toMatch(/nothing is confirmed/);
  });

  it('still reports REACHED when the shop answers with a body that is not JSON', async () => {
    const notJson = (() => Promise.resolve(new Response('bad gateway', { status: 502 }))) as unknown as typeof globalThis.fetch;
    const answer = await httpShopTransport({ fetch: notJson }).placeOrder(REQUEST);
    expect(answer).toMatchObject({ reached: true, status: 502 });
    expect(answer.reached && answer.body).toBeUndefined();
  });
});

describe('reading the shop\'s answer', () => {
  it('201 and 200 both mean the shop HAS the order; 200 is a retry that changed nothing', () => {
    const fresh = readShopAnswer({ status: 201, body: { orderId: 'ORD-7', payment: { state: 'authorised' }, tellTheCustomer: 'Your order is placed.' } });
    expect(fresh).toEqual({ kind: 'placed', orderId: 'ORD-7', alreadyPlaced: false, paymentState: 'authorised', tellTheCustomer: 'Your order is placed.' });
    const again = readShopAnswer({ status: 200, body: { orderId: 'ORD-7', alreadyPlaced: true, payment: { state: 'pending' }, tellTheCustomer: 'waiting' } });
    expect(again).toMatchObject({ kind: 'placed', alreadyPlaced: true, paymentState: 'pending' });
  });

  it('401 is a session that has ended — sign in again, the basket is kept', () => {
    expect(readShopAnswer({ status: 401, body: { error: { code: 'unauthenticated' } } })).toEqual({ kind: 'signed_out' });
  });

  it('a 4xx is the shop saying no in ITS words, which the screen shows rather than paraphrasing', () => {
    const v = readShopAnswer({ status: 422, body: { error: { code: 'not_a_provider_token', whatHappened: 'The payment reference looks like a card number.' } } });
    expect(v).toEqual({ kind: 'refused', code: 'not_a_provider_token', whatHappened: 'The payment reference looks like a card number.' });
    // No words from the shop → an honest generic sentence, never a made-up reason.
    expect(readShopAnswer({ status: 403, body: 'forbidden' })).toMatchObject({ kind: 'refused', code: 'http_403' });
  });

  it('a 5xx means the shop could not answer — the order MAY exist, so the caller keeps the same id', () => {
    expect(readShopAnswer({ status: 503, body: undefined })).toEqual({ kind: 'shop_could_not_answer', status: 503 });
  });
});
