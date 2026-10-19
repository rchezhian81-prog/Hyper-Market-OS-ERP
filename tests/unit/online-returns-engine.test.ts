import { describe, it, expect } from 'vitest';
import {
  lineEligibility, foldOnlineReturn, checkReceivedCount, planReturnRefund, returnStageWords,
  type OnlineReturnStep, type ReturnPolicySettings,
} from '../../packages/storefront/src/online-returns';

/** R4 · WF-16 — the pure rules of an online return: eligibility by category, the count, the refund for what came back. */

const POLICY: ReturnPolicySettings = { version: 1, windowDaysByCategory: { dairy: 2, household: 7 }, nonReturnable: ['BATTERY'], setBy: 'owner', setAt: '2026-10-01T00:00:00.000Z' };
const DELIVERED = '2026-10-10T08:00:00.000Z';

describe('eligibility by category (OB-213)', () => {
  it('within the window → ok; outside → "return window closed"', () => {
    expect(lineEligibility({ productId: 'MILK', categoryId: 'dairy', deliveredAt: DELIVERED, now: '2026-10-12T07:59:59.000Z', policy: POLICY })).toMatchObject({ ok: true, windowDays: 2, closesAt: '2026-10-12T08:00:00.000Z' });
    expect(lineEligibility({ productId: 'MILK', categoryId: 'dairy', deliveredAt: DELIVERED, now: '2026-10-12T08:00:01.000Z', policy: POLICY })).toMatchObject({ ok: false, code: 'return_window_closed', refusal: 'return window closed' });
    // Each category has its own window.
    expect(lineEligibility({ productId: 'BROOM', categoryId: 'household', deliveredAt: DELIVERED, now: '2026-10-16T00:00:00.000Z', policy: POLICY }).ok).toBe(true);
  });
  it('on the non-returnable list → "not returnable"', () => {
    expect(lineEligibility({ productId: 'BATTERY', categoryId: 'household', deliveredAt: DELIVERED, now: DELIVERED, policy: POLICY })).toMatchObject({ ok: false, code: 'not_returnable', refusal: 'not returnable' });
  });
  it('"not set" — no window for the category, or no list at all — cannot be judged, and says so', () => {
    expect(lineEligibility({ productId: 'SAREE', categoryId: 'textiles', deliveredAt: DELIVERED, now: DELIVERED, policy: POLICY })).toMatchObject({ ok: false, code: 'return_window_not_set', refusal: 'return window not set: textiles' });
    expect(lineEligibility({ productId: 'MILK', categoryId: 'dairy', deliveredAt: DELIVERED, now: DELIVERED, policy: undefined })).toMatchObject({ code: 'return_window_not_set' });
    expect(lineEligibility({ productId: 'MILK', categoryId: 'dairy', deliveredAt: DELIVERED, now: DELIVERED, policy: { ...POLICY, nonReturnable: undefined } })).toMatchObject({ code: 'non_returnable_list_not_set', refusal: 'non-returnable list not set' });
  });
});

const steps = (extra: OnlineReturnStep[] = []): OnlineReturnStep[] => [
  { kind: 'requested', returnId: 'R', orderId: 'O', customerRef: 'c', lines: [{ productId: 'MILK', quantityMinor: 2 }, { productId: 'BREAD', quantityMinor: 1 }], reason: 'x', at: '2026-10-11T00:00:00.000Z' },
  ...extra,
];
const price = (id: string) => (id === 'MILK' ? { unitPriceMinor: 60_00, basis: 'pack' } : id === 'BREAD' ? { unitPriceMinor: 40_00, basis: 'pack' } : undefined);

describe('the return\'s steps, the count and the refund', () => {
  it('nothing is refunded before it is received; a count must cover every line and no more than was asked', () => {
    const v = foldOnlineReturn(steps())!;
    expect(v.stage).toBe('requested');
    expect(planReturnRefund(v, price)).toMatchObject({ ok: false, code: 'not_received_yet' });
    expect(checkReceivedCount(v, [{ productId: 'MILK', receivedMinor: 3 }, { productId: 'BREAD', receivedMinor: 0 }]).ok).toBe(false);
    expect(checkReceivedCount(v, [{ productId: 'MILK', receivedMinor: 1 }]).ok).toBe(false);
    expect(checkReceivedCount(v, [{ productId: 'MILK', receivedMinor: 1 }, { productId: 'EGG', receivedMinor: 1 }]).ok).toBe(false);
    expect(checkReceivedCount(v, [{ productId: 'MILK', receivedMinor: 1 }, { productId: 'BREAD', receivedMinor: 0 }]).ok).toBe(true);
  });

  it('refunds only what came back, after a person chose its disposition — at the charged price', () => {
    const received = steps([
      { kind: 'collection_scheduled', returnId: 'R', collectOn: '2026-10-12', by: 'm', at: '2026-10-11T01:00:00.000Z' },
      { kind: 'collected', returnId: 'R', by: 'd', at: '2026-10-12T01:00:00.000Z' },
      { kind: 'received', returnId: 'R', lines: [{ productId: 'MILK', receivedMinor: 1 }, { productId: 'BREAD', receivedMinor: 0 }], by: 'm', at: '2026-10-12T05:00:00.000Z' },
    ]);
    expect(planReturnRefund(foldOnlineReturn(received)!, price)).toMatchObject({ ok: false, code: 'not_disposed_yet' });
    const disposed = [...received, { kind: 'disposed', returnId: 'R', productId: 'MILK', disposition: 'quarantine', by: 'm', at: '2026-10-12T06:00:00.000Z' } as OnlineReturnStep];
    const plan = planReturnRefund(foldOnlineReturn(disposed)!, price);
    expect(plan).toEqual({ ok: true, amountMinor: 60_00, lines: [{ productId: 'MILK', quantityMinor: 1, unitPriceMinor: 60_00, priceBasis: 'pack' }] });
    expect(planReturnRefund(foldOnlineReturn(disposed)!, () => undefined)).toMatchObject({ ok: false, code: 'price_not_known' });

    // Refunded (pending) → a second refund of the same line is "already refunded"; the stage reads "waiting".
    const refunded = [...disposed, { kind: 'refund_recorded', returnId: 'R', refundId: 'rf', lines: [{ productId: 'MILK', quantityMinor: 1, unitPriceMinor: 60_00, priceBasis: 'pack' }], amountMinor: 60_00, state: 'pending', by: 'm', at: '2026-10-12T07:00:00.000Z' } as OnlineReturnStep];
    const waiting = foldOnlineReturn(refunded)!;
    expect(waiting.stage).toBe('refund_waiting');
    expect(planReturnRefund(waiting, price)).toEqual({ ok: false, code: 'already_refunded', detail: 'already refunded: MILK' });
    expect(returnStageWords('refund_waiting')).toMatch(/waiting for the bank/);
    // The provider's later word, folded in: issued.
    expect(foldOnlineReturn(refunded, { rf: 'issued' })!.stage).toBe('refunded');
    // A refused refund frees the line again (the money never moved).
    const refused = foldOnlineReturn(refunded, { rf: 'refused' })!;
    expect(refused.stage).toBe('refund_refused');
    expect(planReturnRefund(refused, price).ok).toBe(true);
  });
});
