import { describe, it, expect } from 'vitest';
import { mayWeSend, recordConsent, customerRoutes, type ConsentRecord, type CustomerDeps } from '../../services/customer/src/index';
import { promise, expired, ordersRoutes, type Reservation, type OrdersDeps } from '../../services/orders/src/index';
import { checkAttempt, reconcileRun, fulfilmentRoutes, type DeliveryAttempt, type FulfilmentDeps } from '../../services/fulfilment/src/index';
import { buildRouter } from '../../services/kernel/src/index';

// API-06 Customer/Loyalty · API-07 OMS · API-08 Fulfilment.

const NOW = '2026-08-07T12:00:00Z';

describe('API-06 — consent is checked when it is used', () => {
  const rec = (over: Partial<ConsentRecord> = {}): ConsentRecord => ({
    customerId: 'C1', purpose: 'marketing', channel: 'whatsapp', given: true,
    recordedAt: '2026-01-01T00:00:00Z', evidence: 'ticked at the till on signup', ...over,
  });

  it('lets a transactional message through without waiting on marketing consent', () => {
    // A customer who bought something is owed the message about the thing they bought.
    const d = mayWeSend({ customerId: 'C1', purpose: 'transactional', channel: 'sms', records: [], now: NOW });
    expect(d.verdict).toBe('may_send');
  });

  it('treats the LATEST record as the answer, so a withdrawal after a grant wins', () => {
    // A system that records consent once and trusts every later send is one where a withdrawal
    // three months ago does not stop tomorrow's campaign.
    const d = mayWeSend({
      customerId: 'C1', purpose: 'marketing', channel: 'whatsapp',
      records: [rec(), rec({ given: false, recordedAt: '2026-05-01T00:00:00Z', evidence: 'replied STOP' })],
      now: NOW,
    });
    expect(d.verdict).toBe('must_not_send');
    expect(d.detail).toContain('a withdrawal after a grant is a withdrawal');
    expect(d.basis?.evidence).toBe('replied STOP');
  });

  it('treats NOTHING on record as not consent', () => {
    const d = mayWeSend({ customerId: 'C1', purpose: 'marketing', channel: 'email', records: [rec()], now: NOW });
    expect(d.verdict).toBe('no_consent_on_record');
    expect(d.detail).toContain('silence has never been agreement');
  });

  it('keeps consent per channel — WhatsApp is not email', () => {
    const records = [rec({ channel: 'whatsapp', given: true }), rec({ channel: 'email', given: false })];
    expect(mayWeSend({ customerId: 'C1', purpose: 'marketing', channel: 'whatsapp', records, now: NOW }).verdict).toBe('may_send');
    expect(mayWeSend({ customerId: 'C1', purpose: 'marketing', channel: 'email', records, now: NOW }).verdict).toBe('must_not_send');
  });

  it('records a withdrawal exactly as it records a grant (PRV-04)', () => {
    const given = recordConsent({ customerId: 'C1', purpose: 'marketing', channel: 'sms', given: true, evidence: 'signup form', now: NOW });
    const taken = recordConsent({ customerId: 'C1', purpose: 'marketing', channel: 'sms', given: false, evidence: 'asked at the counter', now: NOW });
    // One function, one shape, no extra step on the way out.
    expect(Object.keys(given).sort()).toEqual(Object.keys(taken).sort());
  });

  it('carries the record the decision rested on, so it can be defended later', () => {
    const d = mayWeSend({ customerId: 'C1', purpose: 'marketing', channel: 'whatsapp', records: [rec()], now: NOW });
    expect(d.basis?.recordedAt).toBe('2026-01-01T00:00:00Z');
    expect(d.decidedAt).toBe(NOW);
  });
});

describe('API-07 — a promise reserves in the same breath', () => {
  const held = '2026-08-07T13:00:00Z';
  const base = {
    orderId: 'O-1', locationId: 'L1', heldUntil: held,
    reservationIdFor: (o: string, p: string) => `${o}-${p}`,
  };

  it('promises and reserves together', () => {
    const r = promise({
      ...base, lines: [{ productId: 'P1', quantityMinor: 3 }],
      onHand: new Map([['P1', 10]]), outstanding: [],
    });
    expect(r.outcome).toBe('promised');
    expect(r.lines[0]?.reservation?.quantityMinor).toBe(3);
  });

  it('does not promise stock another order is already holding — the oversell', () => {
    // Two customers reading the same free figure and both promised the last bag of rice.
    const outstanding: Reservation[] = [{
      reservationId: 'R-0', orderId: 'O-0', productId: 'P1', quantityMinor: 8,
      locationId: 'L1', heldUntil: held,
    }];
    const r = promise({
      ...base, lines: [{ productId: 'P1', quantityMinor: 5 }],
      onHand: new Map([['P1', 10]]), outstanding,
    });
    expect(r.outcome).toBe('partially_promised');
    expect(r.lines[0]?.promisedMinor).toBe(2);
    expect(r.lines[0]?.detail).toContain('the rest is already promised to other orders');
  });

  it('tells the customer BEFORE they pay, not when the driver arrives', () => {
    const r = promise({
      ...base, lines: [{ productId: 'P1', quantityMinor: 5 }],
      onHand: new Map(), outstanding: [],
    });
    expect(r.outcome).toBe('cannot_promise');
    expect(r.lines[0]?.detail).toContain('none on the shelf');
    expect(r.customerMessage).toContain('before paying');
    expect(r.customerMessage).toContain('we would rather tell you now than when the driver arrives');
  });

  it('offers no way to check availability without holding it', async () => {
    // Check-then-reserve is the oversell. There is nothing to call and act on separately.
    const service = await import('../../services/orders/src/index');
    for (const name of Object.keys(service)) {
      expect(name).not.toMatch(/checkAvailability|isAvailable|peekStock/i);
    }
  });

  it('reports expired holds so stock is not held by orders nobody completed', () => {
    const rs: Reservation[] = [
      { reservationId: 'R-1', orderId: 'O-1', productId: 'P1', quantityMinor: 1, locationId: 'L1', heldUntil: '2026-08-07T11:00:00Z' },
      { reservationId: 'R-2', orderId: 'O-2', productId: 'P1', quantityMinor: 1, locationId: 'L1', heldUntil: '2026-08-07T13:00:00Z' },
    ];
    expect(expired(rs, NOW).map((r) => r.reservationId)).toEqual(['R-1']);
  });
});

describe('API-08 — a failed delivery is a state, not silence', () => {
  const attempt = (over: Partial<DeliveryAttempt> = {}): DeliveryAttempt => ({
    attemptId: 'A-1', orderId: 'O-1', driverId: 'd-ravi', attemptedAt: NOW,
    outcome: 'delivered', proofRef: 'sig-8891', ...over,
  });

  it('accepts a delivery with proof', () => {
    expect(checkAttempt(attempt()).ok).toBe(true);
  });

  it('REFUSES a delivery claimed with no proof', () => {
    const r = checkAttempt(attempt({ proofRef: undefined }));
    expect(r.refusedBecause).toBe('delivered_without_proof');
    expect(r.detail).toContain('two hundred more drops and remembers none of them');
  });

  it('REFUSES a failed attempt with no note', () => {
    // The order otherwise sits at "out for delivery" forever with nobody chasing it.
    const r = checkAttempt(attempt({ outcome: 'nobody_in', proofRef: undefined }));
    expect(r.refusedBecause).toBe('failure_without_a_reason');
  });

  it('REFUSES cash recorded against a drop where nothing was handed over', () => {
    const r = checkAttempt(attempt({
      outcome: 'refused', proofRef: undefined, notes: 'customer refused at the door',
      cashCollectedMinor: 50_000,
    }));
    expect(r.refusedBecause).toBe('cash_without_delivery');
    expect(r.detail).toContain('needs a person to look at it');
  });

  it('settles the run against the driver, by name, on the day', () => {
    const r = reconcileRun({
      driverId: 'd-ravi', runDate: '2026-08-07',
      assignedOrderIds: ['O-1', 'O-2'],
      attempts: [attempt({ cashCollectedMinor: 50_000 }), attempt({ attemptId: 'A-2', orderId: 'O-2', outcome: 'nobody_in', proofRef: undefined, notes: 'no answer' })],
      cashHandedInMinor: 45_000,
    });
    expect(r.delivered).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.differenceMinor).toBe(-5_000);
    expect(r.ownerAction).toContain('tomorrow nobody can say which door it was');
  });

  it('lists an order that went out with no attempt at all, separately from the failures', () => {
    const r = reconcileRun({
      driverId: 'd-ravi', runDate: '2026-08-07',
      assignedOrderIds: ['O-1', 'O-2', 'O-3'],
      attempts: [attempt()], cashHandedInMinor: 0,
    });
    expect(r.outstanding).toEqual(['O-2', 'O-3']);
    expect(r.ownerAction).toContain('orders nobody can account for');
  });

  it('offers no way to delete proof (hard rule #6)', async () => {
    const service = await import('../../services/fulfilment/src/index');
    for (const name of Object.keys(service)) {
      expect(name).not.toMatch(/deleteProof|removeAttempt|clearAttempt/i);
    }
  });
});

describe('all three register cleanly on the kernel', () => {
  it('passes every registration rule', () => {
    const customer: CustomerDeps = {
      consentRecords: () => [], appendConsent: () => {}, pointsBalance: () => undefined, now: () => NOW,
    };
    const orders: OrdersDeps = {
      onHand: () => new Map(), outstanding: () => [], holdReservations: () => {},
      holdMinutes: 60, now: () => NOW,
    };
    const fulfilment: FulfilmentDeps = {
      appendAttempt: () => {}, attempts: () => [], assigned: () => [], now: () => NOW,
    };
    const built = buildRouter([
      ...customerRoutes(customer), ...ordersRoutes(orders), ...fulfilmentRoutes(fulfilment),
    ]);
    expect(built.refusals.map((r) => r.detail)).toEqual([]);
  });
});
