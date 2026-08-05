import { describe, it, expect } from 'vitest';
import {
  bootShop,
  deviceBasket,
  forgetfulBasket,
  UnknownListError,
  type ShopData,
} from '../../apps/customer-app/src/browser-entry';
import type { StorefrontProduct } from '../../packages/storefront/src/browse';

/**
 * **The composition root the customer's phone binds to.**
 *
 * The one thing this surface must get right is the **inverse of the till**. At the till we commit
 * locally and sync afterwards (hard rule #1), because the money is already in the drawer and the
 * customer has walked away — the event happened. Here nothing has happened at all: no money has
 * moved, no goods have left, and the shop has never heard of this basket.
 *
 * An app that says "order placed" over a request that never left the phone has told somebody
 * something untrue about the world, and they find out when nothing arrives. So `reachedTheShop` is
 * the transport's answer and never the app's guess, and that is asserted from the outside here.
 */

const AT = '2026-08-05T10:00:00.000Z';

const PRODUCTS: StorefrontProduct[] = [
  {
    productId: 'p1', name: 'Toor dal 1kg', categoryId: 'grocery', unitPriceMinor: 145_00,
    uom: 'ea', barcodes: ['8901234567890'], status: 'active', availableMinor: 10,
    availabilityAgeMinutes: 2,
  },
  {
    productId: 'p2', name: 'Idli rice 5kg', categoryId: 'grocery', unitPriceMinor: 385_00,
    uom: 'ea', barcodes: ['8901234500007'], status: 'active', availableMinor: 4,
    availabilityAgeMinutes: 2,
  },
];

const data = (over: Partial<ShopData> = {}): ShopData => ({
  tenantId: 't1', customerRef: 'c1', products: PRODUCTS, packVersion: 7,
  slots: [{
    slotId: 'today-evening', startsAt: '2026-08-05T17:00:00.000Z',
    endsAt: '2026-08-05T19:00:00.000Z', capacity: 5, booked: 0, kind: 'delivery',
  }],
  storeLocation: { lat: 11.0, lon: 77.0 },
  deliveryLocation: { lat: 11.001, lon: 77.001 },
  ...over,
});

const fakeStorage = (initial: Record<string, string> = {}) => {
  const held: Record<string, string> = { ...initial };
  return {
    held,
    getItem: (k: string) => held[k] ?? null,
    setItem: (k: string, v: string) => { held[k] = v; },
  };
};

let counter = 0;
const nextId = () => `DSR-${(counter += 1)}`;

/** A basket taken all the way to the point of sending. */
function readyToSend(over: Partial<ShopData> = {}) {
  const shop = bootShop(data(over), forgetfulBasket(), nextId)!;
  shop.setLine('p1', 2);
  shop.review();
  shop.chooseSlot('today-evening', AT);
  return shop;
}

describe('an app that was told nothing has nothing to sell', () => {
  it('builds no session without a catalogue', () => {
    // Not an empty shop — an app that has not been told anything. The screen says which.
    expect(bootShop(undefined, forgetfulBasket(), nextId)).toBeNull();
    expect(bootShop({ tenantId: 't1' }, forgetfulBasket(), nextId)).toBeNull();
    expect(bootShop({ products: [] }, forgetfulBasket(), nextId)).toBeNull();
  });

  it('builds one as soon as a catalogue arrives', () => {
    expect(bootShop(data(), forgetfulBasket(), nextId)).not.toBeNull();
  });
});

describe('prepared is not placed', () => {
  it('says NOT SENT, and does not become an order, when the request never left the phone', () => {
    const shop = readyToSend();
    const result = shop.send({ orderId: 'ORD-1', providerRef: 'tok_abc', result: 'authorised', reachedTheShop: false });

    expect(result.ok).toBe(true); // preparing succeeded; sending did not happen
    expect(result.state.stage).toBe('waiting_for_signal');
    expect(result.state.order).toBeUndefined();
    expect(result.state.tellTheCustomer).toMatch(/NOT been sent/);
    expect(result.state.tellTheCustomer).toMatch(/nothing has been charged/i);
    // And the order screen has nothing to report, because there is no order.
    expect(shop.statusLine()).toBeNull();
  });

  it('becomes a real order only when the transport says it got there', () => {
    const shop = readyToSend();
    const result = shop.send({ orderId: 'ORD-2', providerRef: 'tok_abc', result: 'authorised', reachedTheShop: true });
    expect(result.state.stage).toBe('sent');
    expect(result.state.order).toBeDefined();
    expect(shop.statusLine()).toMatch(/ORD-2/);
  });

  it('reports an unanswered payment as WAITING, never as confirmed', () => {
    // Telling somebody their order is confirmed against a payment that may not exist is how a
    // shop picks and delivers goods it was never paid for.
    const shop = readyToSend();
    shop.send({ orderId: 'ORD-3', providerRef: 'the bank did not answer', result: 'unknown', reachedTheShop: true });
    expect(String(shop.statusLine())).toMatch(/waiting on your bank/i);
    expect(String(shop.statusLine())).not.toMatch(/confirmed and will be picked/);
  });
});

describe('nothing is paid for that has not been seen', () => {
  it('refuses to send a basket that was never reviewed', () => {
    const shop = bootShop(data(), forgetfulBasket(), nextId)!;
    shop.setLine('p1', 2);
    const result = shop.send({ orderId: 'ORD-4', providerRef: 'tok', result: 'authorised', reachedTheShop: true });
    expect(result).toMatchObject({ ok: false, refusedBecause: 'not_reviewed' });
  });

  it('refuses to send without a delivery time', () => {
    const shop = bootShop(data(), forgetfulBasket(), nextId)!;
    shop.setLine('p1', 2);
    shop.review();
    const result = shop.send({ orderId: 'ORD-5', providerRef: 'tok', result: 'authorised', reachedTheShop: true });
    expect(result).toMatchObject({ ok: false, refusedBecause: 'no_slot_booked' });
  });

  it('refuses to charge against prices the customer never saw', () => {
    // The catalogue was republished while they were deciding. Repricing quietly would bill a
    // figure that was never on screen (P-02), so the review carries the pack it was built on and
    // the send checks it. Driven by handing the SAME basket to a shop on a newer pack.
    const basket = forgetfulBasket();
    const onPack7 = bootShop(data({ packVersion: 7 }), basket, nextId)!;
    onPack7.setLine('p1', 2);
    onPack7.review();
    onPack7.chooseSlot('today-evening', AT);

    const onPack8 = bootShop(data({ packVersion: 8 }), basket, nextId)!;
    const result = onPack8.send({ orderId: 'ORD-6', providerRef: 'tok', result: 'authorised', reachedTheShop: true });

    expect(result).toMatchObject({ ok: false, refusedBecause: 'review_is_out_of_date' });
    expect(result.state.tellTheCustomer).toMatch(/Prices changed/i);
  });

  it('refuses a card number where a provider token belongs (hard rule #3)', () => {
    // Refused, not redacted. Redacting means it was held first, and by then it is in memory, in a
    // crash report, and in whatever the phone wrote to disk.
    const shop = readyToSend();
    const result = shop.send({
      orderId: 'ORD-7', providerRef: '4111111111111111', result: 'authorised', reachedTheShop: true,
    });
    expect(result).toMatchObject({ ok: false, refusedBecause: 'card_number_supplied' });
    expect(result.state.order).toBeUndefined();
  });
});

describe('the basket lives on the device, and nothing else does', () => {
  it('comes back after the app is closed and reopened', () => {
    const storage = fakeStorage();
    const first = bootShop(data(), deviceBasket('k', storage, () => {}), nextId)!;
    first.setLine('p1', 3);

    const second = bootShop(data(), deviceBasket('k', storage, () => {}), nextId)!;
    expect(second.state().lines).toEqual([{ productId: 'p1', quantityMinor: 3 }]);
  });

  it('stores no card data, no token and no order history', () => {
    // Hard rules #3 and #4. A basket is product ids and quantities — nothing worth stealing.
    const storage = fakeStorage();
    const shop = bootShop(data(), deviceBasket('k', storage, () => {}), nextId)!;
    shop.setLine('p1', 1);
    shop.review();
    const written = storage.held['k'] ?? '';
    expect(written).not.toMatch(/tok_|card|cvv|\bpan\b|password|otp/i);
    expect(written).toContain('p1');
  });

  it('opens with an empty basket on unreadable storage, and says so', () => {
    // An app that will not open because of one bad byte is worse than one that opens empty — and
    // the customer can see at a glance which they have.
    const problems: string[] = [];
    const shop = bootShop(data(), deviceBasket('k', fakeStorage({ k: 'not json' }), (why) => problems.push(why)), nextId)!;
    expect(shop.state().lines).toEqual([]);
    expect(problems[0]).toMatch(/could not be read/);
  });

  it('says so when the device will not remember anything at all', () => {
    const problems: string[] = [];
    bootShop(data(), deviceBasket('k', undefined, (why) => problems.push(why)), nextId);
    expect(problems[0]).toMatch(/will not remember your basket/);
  });
});

describe('buying again', () => {
  it('rebuilds a saved list into the basket', () => {
    const shop = bootShop(data({
      savedLists: [{ listId: 'weekly', customerRef: 'c1', name: 'Weekly shop', lines: [{ productId: 'p1', quantityMinor: 2 }] }],
    }), forgetfulBasket(), nextId)!;
    const result = shop.repeat('weekly');
    expect(result.lines).toEqual([{ productId: 'p1', quantityMinor: 2 }]);
    expect(shop.state().lines).toHaveLength(1);
  });

  it('names what it could not add back rather than dropping it quietly', () => {
    // A repeat order that silently loses the milk is why people stop trusting the button.
    const shop = bootShop(data({
      products: [{ ...PRODUCTS[0]!, availableMinor: 0 }],
      savedLists: [{ listId: 'weekly', customerRef: 'c1', name: 'Weekly shop', lines: [{ productId: 'p1', quantityMinor: 2 }] }],
    }), forgetfulBasket(), nextId)!;
    const result = shop.repeat('weekly');
    expect(result.droppedProductIds).toEqual(['p1']);
    expect(result.detail).toMatch(/could not be/i);
  });

  it('refuses a list this device was never given, rather than emptying the basket', () => {
    const shop = bootShop(data(), forgetfulBasket(), nextId)!;
    expect(() => shop.repeat('never-heard-of-it')).toThrow(UnknownListError);
  });
});

describe('the privacy centre, through the assembled app', () => {
  const withConsent = () => bootShop(data({
    consentPurposes: [
      { purpose: 'order_updates', channel: 'sms', required: true },
      { purpose: 'marketing', channel: 'sms' },
    ],
  }), forgetfulBasket(), nextId)!;

  it('starts with nothing granted — consent is never a default yes', () => {
    expect(withConsent().consent().every((c) => c.granted === false)).toBe(true);
  });

  it('turns a consent on and off again through one call each way', () => {
    const shop = withConsent();
    expect(shop.setConsent('marketing', 'sms', true).ok).toBe(true);
    expect(shop.consent().find((c) => c.purpose === 'marketing')?.granted).toBe(true);
    expect(shop.setConsent('marketing', 'sms', false).ok).toBe(true);
    expect(shop.consent().find((c) => c.purpose === 'marketing')?.granted).toBe(false);
  });

  it('will not switch off something the shop cannot deliver without', () => {
    expect(withConsent().setConsent('order_updates', 'sms', false))
      .toEqual({ ok: false, refusal: 'required_for_service' });
  });

  it('raises a data request from the phone, with no staff involved (QG-02)', () => {
    const shop = bootShop(data({ privacySlaDays: 30 }), forgetfulBasket(), nextId)!;
    const raised = shop.raise('export', AT);
    expect(raised.request.state).toBe('raised');
    expect(raised.request.tenantId).toBe('t1');
    expect(raised.request.customerRef).toBe('c1');
    expect(raised.tellTheCustomer).toMatch(/Nobody needs to be contacted/i);
  });

  it('warns on the erasure request that it cannot be complete', () => {
    const raised = bootShop(data(), forgetfulBasket(), nextId)!.raise('erasure', AT);
    expect(raised.tellTheCustomer).toMatch(/invoices and tax records/i);
  });
});
