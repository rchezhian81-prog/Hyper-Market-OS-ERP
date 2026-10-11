import { describe, it, expect } from 'vitest';
import { bootShop, forgetfulBasket, type ShopData } from '../../apps/customer-app/src/browser-entry';
import type { ShopTransport, ShopOrderRequest, ShopAnswer } from '../../apps/customer-app/src/shop-transport';
import type { StorefrontProduct } from '../../packages/storefront/src/browse';

// M20-FR-03 / §31 customer row — the app places its order THROUGH THE SHOP (M20 slice 2).
//
// `tests/unit/customer-app.test.ts` proves the session's rules with `reachedTheShop` handed in. What is
// proved here is the hop itself: what leaves the phone, when nothing leaves it, and that what the
// customer is told afterwards is exactly what the shop answered — never the app's own guess.

const AT = '2026-08-05T10:00:00.000Z';
const PRODUCTS: StorefrontProduct[] = [{
  productId: 'p1', name: 'Toor dal 1kg', categoryId: 'grocery', unitPriceMinor: 145_00,
  uom: 'ea', barcodes: ['8901234567890'], status: 'active', availableMinor: 10, availabilityAgeMinutes: 2,
}];
const data = (over: Partial<ShopData> = {}): ShopData => ({
  tenantId: 't1', customerRef: 'c1', products: PRODUCTS, packVersion: 7, locationId: 'L1',
  slots: [{ slotId: 'today-evening', startsAt: '2026-08-05T17:00:00.000Z', endsAt: '2026-08-05T19:00:00.000Z', capacity: 5, booked: 0, kind: 'delivery' }],
  storeLocation: { lat: 11.0, lon: 77.0 }, deliveryLocation: { lat: 11.001, lon: 77.001 }, deliveryFeeMinor: 40_00,
  ...over,
});

/** A shop that answers as scripted and remembers every request it was sent. */
function fakeShop(...answers: ShopAnswer[]) {
  const sent: ShopOrderRequest[] = [];
  const queue = [...answers];
  const transport: ShopTransport = {
    placeOrder: (request) => {
      sent.push(request);
      const next = queue.length > 1 ? queue.shift()! : queue[0]!;
      return Promise.resolve(next);
    },
  };
  return { transport, sent };
}
const placed = (orderId: string, alreadyPlaced = false): ShopAnswer =>
  ({ reached: true, status: alreadyPlaced ? 200 : 201, body: { orderId, alreadyPlaced, payment: { state: 'authorised' }, tellTheCustomer: 'Your order is placed.' } });
const unreachable: ShopAnswer = { reached: false, why: 'network_error', detail: 'the request could not reach the shop — nothing is confirmed' };

let ids = 0;
const nextOrderId = () => `ORD-${(ids += 1)}`;
function readyShop(shop: ShopTransport | undefined, over: Partial<ShopData> = {}, signedIn = true) {
  const s = bootShop(data(over), forgetfulBasket(), () => 'DSR-1', shop, nextOrderId)!;
  s.setLine('p1', 2);
  s.review();
  s.chooseSlot('today-evening', AT);
  if (signedIn) s.signedIn('tok-session-1');
  return s;
}
const PAY = { providerRef: 'tok_2f9a41ce', result: 'authorised' as const };

describe('what leaves the phone', () => {
  it('POSTs the reviewed basket with the session token, the store the box named, and the session\'s own payable as the amount', async () => {
    const shop = fakeShop(placed('ORD-1'));
    const s = readyShop(shop.transport);
    const out = await s.place(PAY);
    expect(out).toMatchObject({ ok: true, shopHasIt: true });
    expect(shop.sent).toHaveLength(1);
    expect(shop.sent[0]).toEqual({
      orderId: out.ok ? out.orderId : '', token: 'tok-session-1', locationId: 'L1',
      lines: [{ productId: 'p1', quantityMinor: 2 }],
      payment: { providerRef: 'tok_2f9a41ce', amountMinor: 2 * 145_00 + 40_00, result: 'authorised' },
      // The chosen slot is a delivery, so the shop quotes its own delivery fee (FUL-03)…
      fulfilment: 'delivery',
      // …and checks the slot and the address against its own record (FUL-03): the app sends what it chose, not a verdict.
      deliverySlot: { startsAt: '2026-08-05T17:00:00.000Z', endsAt: '2026-08-05T19:00:00.000Z' },
      deliveryLocation: { lat: 11.001, lon: 77.001 },
    });
    // And the customer sees a real, confirmed order — the session's tested sentence.
    expect(s.state().stage).toBe('sent');
    expect(s.statusLine()).toMatch(/confirmed and will be picked/);
  });

  it('sends NOTHING while the session\'s own checks refuse — an unreviewed basket, a card number — and keeps the session\'s words', async () => {
    const shop = fakeShop(placed('x'));
    const fresh = bootShop(data(), forgetfulBasket(), () => 'DSR-1', shop.transport, nextOrderId)!;
    fresh.setLine('p1', 1);
    fresh.signedIn('tok');
    expect(await fresh.place(PAY)).toMatchObject({ ok: false, refusedBecause: 'not_reviewed' });
    const card = readyShop(shop.transport);
    expect(await card.place({ providerRef: '4111 1111 1111 1111', result: 'authorised' })).toMatchObject({ ok: false, refusedBecause: 'card_number_supplied' });
    expect(shop.sent).toHaveLength(0); // hard rule #3: the card number never left the phone
  });

  it('sends NOTHING without a sign-in, a named store, or a road to the shop — and says which, keeping the basket', async () => {
    const shop = fakeShop(placed('x'));
    const anonymous = readyShop(shop.transport, {}, false);
    expect(await anonymous.place(PAY)).toMatchObject({ ok: false, refusedBecause: 'not_signed_in' });
    expect(anonymous.state().stage).toBe('slot_booked');
    const noStore = readyShop(shop.transport, { locationId: undefined });
    expect(await noStore.place(PAY)).toMatchObject({ ok: false, refusedBecause: 'no_store_named' });
    expect(shop.sent).toHaveLength(0);
    const noRoad = readyShop(undefined);
    expect(await noRoad.place(PAY)).toMatchObject({ ok: false, refusedBecause: 'no_road_to_the_shop' });
  });

  it('refuses delivery out of range locally — the shop is never asked for an order the session already refused', async () => {
    const shop = fakeShop(placed('x'));
    const far = readyShop(shop.transport, { deliveryLocation: { lat: 12.9716, lon: 77.5946 } }); // Bengaluru
    const out = await far.place(PAY);
    expect(out).toMatchObject({ ok: false, refusedBecause: 'order_refused' });
    expect(far.state().order?.state).toBe('refused');
    expect(shop.sent).toHaveLength(0);
  });
});

describe('when the request never reaches the shop', () => {
  it('is prepared, not sent — in the session\'s own words — and a retry sends the SAME order once it gets through', async () => {
    const shop = fakeShop(unreachable, placed('ORD-x'));
    const s = readyShop(shop.transport);
    const first = await s.place(PAY);
    expect(first).toMatchObject({ ok: true, shopHasIt: false });
    expect(s.state().stage).toBe('waiting_for_signal');
    expect(s.state().tellTheCustomer).toMatch(/NOT been sent/);
    expect(s.state().tellTheCustomer).toMatch(/nothing has been charged/i);
    expect(s.statusLine()).toBeNull();

    const again = await s.retry();
    expect(again).toMatchObject({ ok: true, shopHasIt: true });
    expect(shop.sent).toHaveLength(2);
    expect(shop.sent[1]!.orderId).toBe(shop.sent[0]!.orderId); // the same order, never a second one
    expect(shop.sent[1]!.payment).toEqual(shop.sent[0]!.payment);
    expect(s.state().stage).toBe('sent');
  });

  it('has nothing to retry when nothing is waiting, and a changed basket gets a FRESH order id', async () => {
    const shop = fakeShop(unreachable, placed('y'));
    const s = readyShop(shop.transport);
    expect(await s.retry()).toBeNull();
    await s.place(PAY); // prepared, not sent
    s.setLine('p1', 3); // the customer changed their mind — the review is gone, the old id with it
    expect(await s.retry()).toBeNull();
    s.review();
    s.chooseSlot('today-evening', AT);
    await s.place(PAY);
    expect(shop.sent).toHaveLength(2);
    expect(shop.sent[1]!.orderId).not.toBe(shop.sent[0]!.orderId);
  });
});

describe('what the shop answered is what the customer is told', () => {
  it('a retry the shop already holds is reported as placed, not as placed twice', async () => {
    const shop = fakeShop(placed('ORD-z', true));
    const s = readyShop(shop.transport);
    const out = await s.place(PAY);
    expect(out).toMatchObject({ ok: true, shopHasIt: true });
    expect(out.ok && out.detail).toMatch(/nothing was placed twice/);
  });

  it('401 — the sign-in has ended: the token is dropped, the basket is kept, and the same order goes after signing in again', async () => {
    const shop = fakeShop({ reached: true, status: 401, body: { error: { code: 'unauthenticated' } } }, placed('ORD-w'));
    const s = readyShop(shop.transport);
    const out = await s.place(PAY);
    expect(out).toMatchObject({ ok: false, refusedBecause: 'signed_out' });
    expect(s.isSignedIn()).toBe(false);
    expect(s.state().stage).toBe('slot_booked');
    expect(s.state().order).toBeUndefined();
    s.signedIn('tok-session-2');
    expect(await s.place(PAY)).toMatchObject({ ok: true, shopHasIt: true });
    expect(shop.sent[1]!.orderId).toBe(shop.sent[0]!.orderId);
    expect(shop.sent[1]!.token).toBe('tok-session-2');
  });

  it('a refusal is shown in the SHOP\'s words, the basket is kept, and the next attempt is a new order', async () => {
    const shop = fakeShop(
      { reached: true, status: 422, body: { error: { code: 'not_a_provider_token', whatHappened: 'The payment reference looks like a card number. Only a provider token may be recorded (hard rule #3).' } } },
      placed('ORD-v'),
    );
    const s = readyShop(shop.transport);
    const out = await s.place(PAY);
    expect(out).toMatchObject({ ok: false, refusedBecause: 'the_shop_refused', tellTheCustomer: /looks like a card number/ });
    expect(s.state().stage).toBe('slot_booked');
    await s.place(PAY);
    expect(shop.sent[1]!.orderId).not.toBe(shop.sent[0]!.orderId);
  });

  it('a 5xx confirms nothing — and the retry keeps the SAME id, so an order the shop did save cannot be doubled', async () => {
    const shop = fakeShop({ reached: true, status: 503, body: undefined }, placed('ORD-u', true));
    const s = readyShop(shop.transport);
    const out = await s.place(PAY);
    expect(out).toMatchObject({ ok: false, refusedBecause: 'the_shop_could_not_answer' });
    expect(out.ok === false && out.tellTheCustomer).toMatch(/Nothing is confirmed/);
    expect(s.state().stage).toBe('slot_booked');
    const again = await s.place(PAY);
    expect(again).toMatchObject({ ok: true, shopHasIt: true });
    expect(shop.sent[1]!.orderId).toBe(shop.sent[0]!.orderId);
  });

  it('a payment the bank has not answered is reported as WAITING by the session, even though the shop has the order', async () => {
    const shop = fakeShop({ reached: true, status: 201, body: { orderId: 'ORD-t', payment: { state: 'pending' }, tellTheCustomer: 'We are waiting for your bank.' } });
    const s = readyShop(shop.transport);
    await s.place({ providerRef: 'the bank did not answer', result: 'unknown' });
    expect(shop.sent[0]!.payment?.result).toBe('unknown');
    expect(String(s.statusLine())).toMatch(/waiting on your bank/i);
    expect(String(s.statusLine())).not.toMatch(/confirmed and will be picked/);
  });

  it('does not send the same basket twice on a second tap of Pay — the shop already has it', async () => {
    const shop = fakeShop(placed('ORD-r'));
    const s = readyShop(shop.transport);
    await s.place(PAY);
    expect(await s.place(PAY)).toMatchObject({ ok: false, refusedBecause: 'already_sent' });
    expect(shop.sent).toHaveLength(1);
    expect(s.statusLine()).toMatch(/ORD-/);
  });

  it('holds the token in memory only — sign-out forgets it and the next placement is refused as not signed in', async () => {
    const shop = fakeShop(placed('ORD-s'));
    const s = readyShop(shop.transport);
    expect(s.isSignedIn()).toBe(true);
    s.signOut();
    expect(await s.place(PAY)).toMatchObject({ ok: false, refusedBecause: 'not_signed_in' });
    expect(shop.sent).toHaveLength(0);
  });
});
