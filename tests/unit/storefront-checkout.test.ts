import { describe, it, expect } from 'vitest';
import {
  distanceMetres,
  checkServiceability,
  availableSlots,
  bookSlot,
  generateDeliverySlots,
  placeOrder,
  trackOrder,
  privacyCentre,
  changeConsent,
  CardDataError,
  type Slot,
} from '../../packages/storefront/src/checkout';

// M20-FR-03 acceptance: "a customer pays via a provider token (NO CARD NUMBER STORED); an
// out-of-area order is REFUSED CLEARLY; tracking and the digital receipt work." And:
// "payment uncertain → ORDER NOT CONFIRMED (no fake approval, §31/§4.3)."

const STORE = { lat: 11.0168, lon: 76.9558 }; // Coimbatore
const NEARBY = { lat: 11.0268, lon: 76.9658 }; // ~1.5 km
const FAR = { lat: 11.2, lon: 77.2 }; // ~35 km

describe('serviceability is decided before the basket is filled (D08)', () => {
  it('measures distance in whole metres', () => {
    expect(distanceMetres(STORE, STORE)).toBe(0);
    expect(distanceMetres(STORE, NEARBY)).toBeGreaterThan(1_000);
    expect(distanceMetres(STORE, NEARBY)).toBeLessThan(2_000);
  });

  it('REFUSES an out-of-area address clearly, naming the distance and the limit', () => {
    const result = checkServiceability({
      storeLocation: STORE, deliveryLocation: FAR, basketMinor: 200_000,
      policy: { radiusMetres: 10_000 },
    });
    expect(result.serviceable).toBe(false);
    expect(result.outcome).toBe('out_of_area');
    expect(result.detail).toContain('we deliver up to 10 km');
    expect(result.detail).toContain('you can still collect from the store');
  });

  it('refuses below the minimum order, stating both numbers', () => {
    const result = checkServiceability({
      storeLocation: STORE, deliveryLocation: NEARBY, basketMinor: 20_000,
      policy: { minimumOrderMinor: 50_000 },
    });
    expect(result.outcome).toBe('below_minimum');
    expect(result.detail).toContain('minimum order for delivery is 50000');
  });

  it('STATES THE FEE UP FRONT, and waives it above the threshold', () => {
    const charged = checkServiceability({
      storeLocation: STORE, deliveryLocation: NEARBY, basketMinor: 60_000,
      policy: { deliveryFeeMinor: 4_000, freeDeliveryAboveMinor: 100_000 },
    });
    expect(charged.serviceable).toBe(true);
    expect(charged.deliveryFeeMinor).toBe(4_000);
    expect(charged.detail).toContain('free above 100000');

    const free = checkServiceability({
      storeLocation: STORE, deliveryLocation: NEARBY, basketMinor: 150_000,
      policy: { deliveryFeeMinor: 4_000, freeDeliveryAboveMinor: 100_000 },
    });
    expect(free.deliveryFeeMinor).toBe(0);
    expect(free.detail).toContain('free delivery');
  });

  it('uses the tenant\'s own radius, not a hard-coded one', () => {
    const wide = checkServiceability({
      storeLocation: STORE, deliveryLocation: FAR, basketMinor: 200_000,
      policy: { radiusMetres: 50_000 },
    });
    expect(wide.serviceable).toBe(true);
  });
});

describe('a full slot is not sold twice', () => {
  const slots: Slot[] = [
    { slotId: 's-full', startsAt: '2026-08-05T10:00:00Z', endsAt: '2026-08-05T12:00:00Z', capacity: 8, booked: 8, kind: 'delivery' },
    { slotId: 's-open', startsAt: '2026-08-05T14:00:00Z', endsAt: '2026-08-05T16:00:00Z', capacity: 8, booked: 3, kind: 'delivery' },
    { slotId: 's-past', startsAt: '2026-08-04T08:00:00Z', endsAt: '2026-08-04T10:00:00Z', capacity: 8, booked: 0, kind: 'delivery' },
    { slotId: 's-soon', startsAt: '2026-08-05T09:10:00Z', endsAt: '2026-08-05T09:40:00Z', capacity: 8, booked: 0, kind: 'pickup' },
  ];
  const now = '2026-08-05T09:00:00Z';

  it('offers only future slots with room and enough notice', () => {
    const offers = availableSlots({ slots, now, leadMinutes: 60 });
    expect(offers.map((o) => o.slotId)).toEqual(['s-open']);
    expect(offers[0]?.remaining).toBe(5);
  });

  it('REFUSES A FULL SLOT AND OFFERS THE ALTERNATIVES, never a bare error', () => {
    const result = bookSlot({ slotId: 's-full', slots, now, leadMinutes: 60 });
    expect(result.booked).toBe(false);
    expect(result.outcome).toBe('slot_full');
    expect(result.alternatives.map((a) => a.slotId)).toEqual(['s-open']);
    expect(result.detail).toContain('1 other slot(s) are available');
  });

  it('refuses a slot with too little notice to pick the order', () => {
    const result = bookSlot({ slotId: 's-soon', slots, now, leadMinutes: 60 });
    expect(result.outcome).toBe('too_soon');
    expect(result.detail).toContain('at least 60 minutes to pick');
  });

  it('books an open slot, and refuses one that does not exist', () => {
    expect(bookSlot({ slotId: 's-open', slots, now }).booked).toBe(true);
    expect(bookSlot({ slotId: 's-nope', slots, now }).outcome).toBe('unknown_slot');
  });
});

describe('an uncertain payment does NOT confirm an order (§4.3)', () => {
  const serviceable = checkServiceability({ storeLocation: STORE, deliveryLocation: NEARBY, basketMinor: 200_000 });
  const base = {
    orderId: 'O-1', customerRef: 'c-1', slotId: 's-open',
    itemsMinor: 200_000, deliveryFeeMinor: 4_000, serviceability: serviceable,
  };

  it('confirms and releases for picking on a real authorisation', () => {
    const order = placeOrder({ ...base, payment: { result: 'authorised', providerRef: 'tok_88ff21' } });
    expect(order.state).toBe('confirmed');
    expect(order.releaseForPicking).toBe(true);
    expect(order.payableMinor).toBe(204_000);
    expect(order.tellTheCustomer).toContain('confirmed');
  });

  it('LEAVES AN UNKNOWN PAYMENT PENDING and picks nothing', () => {
    const order = placeOrder({ ...base, payment: { result: 'unknown', reason: 'gateway timeout' } });
    expect(order.state).toBe('payment_pending');
    expect(order.releaseForPicking).toBe(false);
    expect(order.detail).toContain('NOT confirmed and nothing will be picked');
    // And the customer is told the truth, including not to pay again.
    expect(order.tellTheCustomer).toContain('do not pay again');
    expect(order.tellTheCustomer).not.toContain('confirmed and we will pick');
  });

  it('refuses a declined payment and says nothing was charged', () => {
    const order = placeOrder({ ...base, payment: { result: 'declined', reason: 'insufficient funds' } });
    expect(order.state).toBe('refused');
    expect(order.releaseForPicking).toBe(false);
    expect(order.tellTheCustomer).toContain('Nothing has been charged');
  });

  it('refuses an out-of-area order before payment matters', () => {
    const outOfArea = checkServiceability({
      storeLocation: STORE, deliveryLocation: FAR, basketMinor: 200_000, policy: { radiusMetres: 10_000 },
    });
    const order = placeOrder({
      ...base, serviceability: outOfArea, payment: { result: 'authorised', providerRef: 'tok_1' },
    });
    expect(order.state).toBe('refused');
    expect(order.releaseForPicking).toBe(false);
  });

  it('REFUSES A CARD NUMBER as a payment reference (hard rule #3)', () => {
    expect(() =>
      placeOrder({ ...base, payment: { result: 'authorised', providerRef: '4111111111111111' } }),
    ).toThrow(CardDataError);
  });
});

describe('tracking states its own age (P-08)', () => {
  it('reads plainly when fresh', () => {
    const view = trackOrder({ orderId: 'O-1', stage: 'out_for_delivery', asOfMinutesAgo: 3 });
    expect(view.stale).toBe(false);
    expect(view.detail).toBe('Your order is on its way');
  });

  it('warns when the tracking data may have moved on', () => {
    const view = trackOrder({ orderId: 'O-1', stage: 'picking', asOfMinutesAgo: 55, staleAfterMinutes: 15 });
    expect(view.stale).toBe(true);
    expect(view.detail).toContain('last updated 55 minutes ago');
  });
});

describe('the privacy centre shows everything, including what cannot be erased', () => {
  it('lists retained categories rather than hiding them', () => {
    const view = privacyCentre({
      customerRef: 'c-1',
      categories: [
        { category: 'Marketing preferences', recordCount: 1 },
        { category: 'Sales invoices', recordCount: 38, retained: true },
      ],
      consents: ['service'],
    });
    expect(view.held[1]?.summary).toContain('kept because the law requires it');
    expect(view.held[1]?.summary).toContain('shown here so you know it exists');
    expect(view.detail).toBe('39 record(s) across 2 categor(y/ies)');
  });

  it('reports every consent, granted or not, and the rights that can be exercised', () => {
    const view = privacyCentre({ customerRef: 'c-1', categories: [], consents: ['service'] });
    expect(view.consents).toEqual([
      { purpose: 'marketing', granted: false },
      { purpose: 'profiling', granted: false },
      { purpose: 'service', granted: true },
    ]);
    expect(view.canRequest).toEqual(['access', 'correction', 'export', 'erasure']);
  });

  it('A WITHDRAWAL APPLIES TO THE NEXT MESSAGE, not the next batch', () => {
    const off = changeConsent({ customerRef: 'c-1', purpose: 'marketing', granted: false, at: '2026-08-05T09:00:00Z' });
    expect(off.effectiveImmediately).toBe(true);
    expect(off.effectiveAt).toBe('2026-08-05T09:00:00Z');
    expect(off.detail).toContain('applies to the very next message, not to the next batch');

    const on = changeConsent({ customerRef: 'c-1', purpose: 'marketing', granted: true, at: '2026-08-05T09:05:00Z' });
    expect(on.granted).toBe(true);
    expect(on.detail).toContain('switched on');
  });
});

describe('generateDeliverySlots turns a delivery policy into bookable windows (M20-FR-03)', () => {
  const WINDOW = { windowStartIso: '2026-08-10T03:30:00.000Z', windowEndIso: '2026-08-10T15:30:00.000Z' }; // 09:00–21:00 IST

  it('divides the window into N equal contiguous slots that cover it exactly', () => {
    const slots = generateDeliverySlots({ ...WINDOW, slotsPerDay: 8, capacityPerSlot: 10 });
    expect(slots).toHaveLength(8);
    // First starts at the window open, last ends at the window close — no uncovered tail.
    expect(slots[0]!.startsAt).toBe('2026-08-10T03:30:00.000Z');
    expect(slots[7]!.endsAt).toBe('2026-08-10T15:30:00.000Z');
    // Contiguous: each slot begins where the previous ended.
    for (let i = 1; i < slots.length; i += 1) {
      expect(slots[i]!.startsAt).toBe(slots[i - 1]!.endsAt);
    }
    // 12 hours / 8 = 90-minute windows; every slot carries the configured capacity and starts empty.
    expect(Date.parse(slots[0]!.endsAt) - Date.parse(slots[0]!.startsAt)).toBe(90 * 60_000);
    expect(slots.every((s) => s.capacity === 10 && s.booked === 0 && s.kind === 'delivery')).toBe(true);
    // The generated slots feed straight into the booking engine.
    expect(bookSlot({ slotId: slots[2]!.slotId, slots, now: '2026-08-10T03:00:00.000Z' }).booked).toBe(true);
  });

  it('invents nothing — no slots, a backwards window, or no capacity yields an empty list, never a guess', () => {
    expect(generateDeliverySlots({ ...WINDOW, slotsPerDay: 0, capacityPerSlot: 10 })).toEqual([]);
    expect(generateDeliverySlots({ ...WINDOW, slotsPerDay: 8, capacityPerSlot: 0 })).toEqual([]);
    expect(generateDeliverySlots({ windowStartIso: WINDOW.windowEndIso, windowEndIso: WINDOW.windowStartIso, slotsPerDay: 8, capacityPerSlot: 10 })).toEqual([]);
    // A window smaller than the slot count itself (here 3 ms for 8 slots) → none, not zero-length slivers.
    expect(generateDeliverySlots({ windowStartIso: '2026-08-10T03:30:00.000Z', windowEndIso: '2026-08-10T03:30:00.003Z', slotsPerDay: 8, capacityPerSlot: 10 })).toEqual([]);
  });

  it('is deterministic and pickup-capable', () => {
    const a = generateDeliverySlots({ ...WINDOW, slotsPerDay: 4, capacityPerSlot: 5, kind: 'pickup', slotIdPrefix: 'pick' });
    const b = generateDeliverySlots({ ...WINDOW, slotsPerDay: 4, capacityPerSlot: 5, kind: 'pickup', slotIdPrefix: 'pick' });
    expect(a).toEqual(b);
    expect(a[0]!.slotId).toBe('pick-1');
    expect(a.every((s) => s.kind === 'pickup')).toBe(true);
  });
});
