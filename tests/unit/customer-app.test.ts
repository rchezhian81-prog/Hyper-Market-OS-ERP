import { describe, it, expect } from 'vitest';
import {
  newSession, setLine, review, acceptWhatIsAvailable, chooseSlot, send, orderStatusLine,
} from '../../apps/customer-app/src/index';
import { bootShop, forgetfulBasket } from '../../apps/customer-app/src/browser-entry';
import type { StorefrontProduct } from '../../packages/storefront/src/browse';
import type { Slot, PaymentAnswer, ServiceabilityPolicy } from '../../packages/storefront/src/checkout';

// M16 / D06 / D08 — the customer's shopping session.
//
// The rules in `packages/storefront` are tested where they live. What is tested here is the thing
// only this layer holds: **the order of events**, and what the customer is truthfully told.

const NOW = '2026-08-05T09:00:00Z';

const product = (over: Partial<StorefrontProduct> = {}): StorefrontProduct => ({
  productId: 'P1', name: 'Amul Ghee Gold 1L', categoryId: 'dairy',
  unitPriceMinor: 64_000, uom: 'each', barcodes: ['8901234567890'],
  status: 'active', availableMinor: 10, availabilityAgeMinutes: 1, ...over,
});

const slots: readonly Slot[] = [
  { slotId: 'S-11', startsAt: '2026-08-05T11:00:00Z', endsAt: '2026-08-05T13:00:00Z', capacity: 4, booked: 1, kind: 'delivery' },
  { slotId: 'S-15', startsAt: '2026-08-05T15:00:00Z', endsAt: '2026-08-05T17:00:00Z', capacity: 4, booked: 4, kind: 'delivery' },
];

const POLICY: ServiceabilityPolicy = { radiusMetres: 10_000, deliveryFeeMinor: 4_000 };
const STORE = { lat: 11.0168, lon: 76.9558 };
const NEARBY = { lat: 11.0200, lon: 76.9600 };

const authorised: PaymentAnswer = { result: 'authorised', providerRef: 'tok_2f9a41ce' };

/** A session taken as far as a booked slot, ready to send. */
function readyToSend(products: readonly StorefrontProduct[] = [product()]) {
  let state = setLine(newSession(), { productId: 'P1', quantityMinor: 2 });
  state = review(state, { products, packVersion: 7 }).state;
  state = chooseSlot(state, { slotId: 'S-11', slots, now: NOW }).state;
  return state;
}

const sendWith = (state: ReturnType<typeof readyToSend>, over: Partial<Parameters<typeof send>[1]> = {}) =>
  send(state, {
    orderId: 'O-1', customerRef: 'c-1', deliveryFeeMinor: 4_000, currentPackVersion: 7,
    policy: POLICY, storeLocation: STORE, deliveryLocation: NEARBY,
    payment: authorised, reachedTheShop: true, ...over,
  });

describe('the customer app — an order is not placed until the shop has it', () => {
  it('does NOT say placed when the request never left the phone', () => {
    // The deliberate inverse of the till. At the till we commit locally first because the money is
    // already in the drawer and the customer has gone. On a phone nothing has happened at all —
    // no money moved, no goods left, and the shop has never heard of this basket.
    const r = sendWith(readyToSend(), { reachedTheShop: false });
    expect(r.ok).toBe(true);
    expect(r.state.stage).toBe('waiting_for_signal');
    expect(r.state.order).toBeUndefined();
    expect(r.state.tellTheCustomer).toContain('has NOT been sent');
    expect(r.state.tellTheCustomer).toContain('Nothing has been charged');
    expect(r.state.tellTheCustomer.toLowerCase()).not.toContain('order placed');
  });

  it('does say confirmed when it reached the shop and the payment went through', () => {
    const r = sendWith(readyToSend());
    expect(r.state.stage).toBe('sent');
    expect(r.state.order?.state).toBe('confirmed');
    expect(r.state.order?.releaseForPicking).toBe(true);
  });

  it('offers no way to mark an unsent basket as placed', async () => {
    // Absence as a control. The moment a "mark as placed" exists, the offline path acquires a
    // shortcut somebody will take to make a screen look tidier.
    const module = await import('../../apps/customer-app/src/index');
    for (const name of Object.keys(module)) {
      expect(name).not.toMatch(/markPlaced|forcePlace|confirmLocally|assumeSent/i);
    }
  });
});

describe('the customer app — nothing is paid for that has not been reviewed', () => {
  it('REFUSES to send a basket that was never reviewed', () => {
    // `reviewCart` exists so a customer is told at review, not at the payment screen and certainly
    // not at the door. A session that lets checkout skip it makes that function optional.
    let state = setLine(newSession(), { productId: 'P1', quantityMinor: 2 });
    state = chooseSlot(state, { slotId: 'S-11', slots, now: NOW }).state;
    const r = sendWith(state);
    expect(r.refusedBecause).toBe('not_reviewed');
    expect(r.detail).toContain('has not been shown what they are paying for');
  });

  it('REFUSES to send while lines are short or unavailable', () => {
    const r = sendWith(readyToSend([product({ availableMinor: 1 })]));
    expect(r.refusedBecause).toBe('problems_not_resolved');
    expect(r.detail).toContain('is how they find out at the door');
  });

  it('tells the customer about a shortfall at review, in those words', () => {
    const state = review(
      setLine(newSession(), { productId: 'P1', quantityMinor: 2 }),
      { products: [product({ availableMinor: 1 })], packVersion: 7 },
    ).state;
    expect(state.tellTheCustomer).toContain('rather than at the door');
  });

  it('reduces a short basket only when the customer says so, and then sends', () => {
    let state = review(
      setLine(newSession(), { productId: 'P1', quantityMinor: 2 }),
      { products: [product({ availableMinor: 1 })], packVersion: 7 },
    ).state;

    const accepted = acceptWhatIsAvailable(state);
    expect(accepted.state.lines).toEqual([{ productId: 'P1', quantityMinor: 1 }]);
    // The subtotal follows the kept lines, not the original basket.
    expect(accepted.state.review?.subtotalMinor).toBe(64_000);

    state = chooseSlot(accepted.state, { slotId: 'S-11', slots, now: NOW }).state;
    expect(sendWith(state).state.order?.state).toBe('confirmed');
  });

  it('drops an unavailable line entirely rather than charging zero for it', () => {
    const state = review(
      setLine(setLine(newSession(), { productId: 'P1', quantityMinor: 1 }), { productId: 'P2', quantityMinor: 1 }),
      { products: [product(), product({ productId: 'P2', name: 'Oil 5L', availableMinor: 0, unitPriceMinor: 30_000 })], packVersion: 7 },
    ).state;
    const kept = acceptWhatIsAvailable(state).state;
    expect(kept.lines.map((l) => l.productId)).toEqual(['P1']);
    expect(kept.review?.subtotalMinor).toBe(64_000);
  });
});

describe('the customer app — a review goes stale', () => {
  it('REFUSES to charge against a review built on an older pack', () => {
    // The shop republished while the customer was deciding. Paying against the older review bills
    // a figure they never saw, which is the same one-price rule the till holds (P-02).
    const r = sendWith(readyToSend(), { currentPackVersion: 8 });
    expect(r.refusedBecause).toBe('review_is_out_of_date');
    expect(r.detail).toContain('bills a figure the customer never saw');
  });

  it('sends them back to look, rather than quietly repricing', () => {
    const r = sendWith(readyToSend(), { currentPackVersion: 8 });
    expect(r.state.stage).toBe('browsing');
    expect(r.state.tellTheCustomer).toContain('Please have another look');
  });

  it('invalidates the review the moment the basket changes', () => {
    const reviewed = readyToSend();
    expect(reviewed.stage).toBe('slot_booked');
    const changed = setLine(reviewed, { productId: 'P1', quantityMinor: 5 });
    expect(changed.stage).toBe('browsing');
    expect(sendWith(changed).refusedBecause).toBe('not_reviewed');
  });
});

describe('the customer app — no card number ever enters it (hard rule #3)', () => {
  it('REFUSES a payment reference that looks like a card number, and sends nothing', () => {
    // Refused, not redacted. Redacting means it was held first, and by then it is in memory, in a
    // crash report and in whatever the phone wrote to disk.
    const r = sendWith(readyToSend(), {
      payment: { result: 'authorised', providerRef: '4111 1111 1111 1111' },
    });
    expect(r.refusedBecause).toBe('card_number_supplied');
    expect(r.state.stage).not.toBe('sent');
    expect(r.state.order).toBeUndefined();
  });

  it('tripwire — a provider token of similar length still goes through', () => {
    const r = sendWith(readyToSend(), {
      payment: { result: 'authorised', providerRef: 'tok_4111111111111111' },
    });
    expect(r.ok).toBe(true);
    expect(r.state.order?.state).toBe('confirmed');
  });
});

describe('the customer app — a slot and a status the customer can act on', () => {
  it('REFUSES to send with no slot chosen', () => {
    const state = review(
      setLine(newSession(), { productId: 'P1', quantityMinor: 2 }),
      { products: [product()], packVersion: 7 },
    ).state;
    expect(sendWith(state).refusedBecause).toBe('no_slot_booked');
  });

  it('offers the alternatives when a slot is full, rather than an error', () => {
    const r = chooseSlot(newSession(), { slotId: 'S-15', slots, now: NOW });
    expect(r.ok).toBe(false);
    expect(r.booking.outcome).toBe('slot_full');
    expect(r.booking.alternatives.map((a) => a.slotId)).toEqual(['S-11']);
    expect(r.state.tellTheCustomer).toContain('other time(s) are free');
  });

  it('reports a pending payment as WAITING, never as done', () => {
    // Telling somebody their order is confirmed against a payment that may not exist is how a shop
    // picks, packs and delivers goods it was never paid for, and finds out at settlement.
    const r = sendWith(readyToSend(), {
      payment: { result: 'unknown', reason: 'the bank did not answer' },
    });
    const order = r.state.order!;
    expect(order.state).toBe('payment_pending');
    expect(order.releaseForPicking).toBe(false);
    const line = orderStatusLine(order);
    expect(line).toContain('waiting on your bank');
    expect(line).toContain('nothing will be picked');
    expect(line).not.toContain('confirmed and will be picked');
  });

  it('says plainly when an order was refused', () => {
    const r = sendWith(readyToSend(), { deliveryLocation: { lat: 12.9716, lon: 77.5946 } });
    expect(r.ok).toBe(false);
    expect(orderStatusLine(r.state.order!)).toContain('was not placed');
  });

  it('REFUSES to review an empty basket', () => {
    expect(review(newSession(), { products: [product()], packVersion: 7 }).refusedBecause)
      .toBe('nothing_in_the_basket');
  });
});

describe('the app captures the customer\'s own location for the 10 km check (M20-FR-03, OA-11)', () => {
  const data = {
    products: [product()], packVersion: 7, slots,
    policy: POLICY, storeLocation: STORE, deliveryFeeMinor: 4_000,
  };
  const readyShop = () => {
    const shop = bootShop(data, forgetfulBasket(), () => 'O-1')!;
    shop.setLine('P1', 2);
    shop.review();
    shop.chooseSlot('S-11', NOW);
    return shop;
  };
  const place = (shop: ReturnType<typeof readyShop>) =>
    shop.send({ orderId: 'O-1', providerRef: 'tok_2f9a41ce', result: 'authorised' as const, reachedTheShop: true });

  it('starts with no location and refuses delivery rather than measuring from {0,0}', () => {
    const shop = readyShop();
    expect(shop.hasLocation()).toBe(false);
    expect(place(shop).state.order?.state).toBe('refused');
  });

  it('captures a nearby location, then confirms the delivery order (test payment)', async () => {
    const shop = readyShop();
    const got = await shop.useMyLocation(() => Promise.resolve(NEARBY));
    expect(got.ok).toBe(true);
    expect(shop.hasLocation()).toBe(true);
    expect(place(shop).state.order?.state).toBe('confirmed');
  });

  it('refuses a location beyond the 10 km radius', async () => {
    const shop = readyShop();
    await shop.useMyLocation(() => Promise.resolve({ lat: 12.9716, lon: 77.5946 })); // Bengaluru, far
    expect(place(shop).state.order?.state).toBe('refused');
  });

  it('tells the customer plainly when the location is denied or unreadable, and never guesses one', async () => {
    const shop = readyShop();
    const denied = await shop.useMyLocation(() => Promise.reject(new Error('permission denied')));
    expect(denied.ok).toBe(false);
    expect(shop.hasLocation()).toBe(false);
    const nonsense = await shop.useMyLocation(() => Promise.resolve({ lat: Number.NaN, lon: Number.NaN }));
    expect(nonsense.ok).toBe(false);
    expect(shop.hasLocation()).toBe(false);
  });
});
