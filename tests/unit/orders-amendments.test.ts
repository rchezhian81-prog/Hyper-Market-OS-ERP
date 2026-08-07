import { describe, it, expect } from 'vitest';
import {
  cancelOrder,
  applySubstitution,
  reconcileChannel,
  type SubstitutionOffer,
  type ChannelOrder,
} from '../../packages/orders/src/amendments';

// M18-FR-04 acceptance: "A CANCELLATION RELEASES RESERVED STOCK; A SUBSTITUTION NEVER
// APPLIES [without customer confirmation]; refunds via the original method; channels
// reconcile."

describe('a cancellation releases the reservation in the same act (M18-FR-04)', () => {
  const base = {
    orderId: 'O-1',
    reservationIds: ['R-1', 'R-2'],
    paidMinor: 92_000,
    cancelledBy: 'c-1',
    reason: 'changed my mind',
    at: '2026-08-05T10:00:00Z',
  };

  it('RETURNS EVERY RESERVATION TO RELEASE — never left to a caller to remember', () => {
    const result = cancelOrder({ ...base, state: 'confirmed' });
    expect(result.cancelled).toBe(true);
    expect(result.releaseReservationIds).toEqual(['R-1', 'R-2']);
    expect(result.refundMinor).toBe(92_000);
    expect(result.detail).toContain('2 reservation(s) released');
  });

  it('refuses a delivered order — that is a return, and the goods have to come back', () => {
    const result = cancelOrder({ ...base, state: 'delivered' });
    expect(result.cancelled).toBe(false);
    expect(result.outcome).toBe('already_delivered');
    expect(result.releaseReservationIds).toEqual([]);
  });

  it('refuses a dispatched order, pointing at the failed-delivery path', () => {
    const result = cancelOrder({ ...base, state: 'dispatched' });
    expect(result.outcome).toBe('too_late');
    expect(result.detail).toContain('so the stock comes back on the van, not on paper');
  });

  it('refuses to cancel twice, and refuses without a reason', () => {
    expect(cancelOrder({ ...base, state: 'cancelled' }).outcome).toBe('already_cancelled');
    expect(cancelOrder({ ...base, state: 'confirmed', reason: '  ' }).outcome).toBe('no_reason');
  });

  it('cancels an unpaid order with nothing to refund', () => {
    const result = cancelOrder({ ...base, state: 'placed', paidMinor: 0 });
    expect(result.cancelled).toBe(true);
    expect(result.refundMinor).toBe(0);
    expect(result.detail).not.toContain('to refund');
  });
});

describe('a substitution is never applied without confirmation (A04 / hard rule #5)', () => {
  const OFFER: SubstitutionOffer = {
    lineId: 'l-1',
    orderedProductId: 'p-milk-full',
    orderedName: 'Full-fat milk 1L',
    orderedUnitPriceMinor: 6_000,
    orderedQuantityMinor: 2,
    substituteProductId: 'p-milk-skim',
    substituteName: 'Skimmed milk 1L',
    substituteUnitPriceMinor: 6_000,
    substituteQuantityMinor: 2,
    offeredAt: '2026-08-05T09:00:00Z',
  };

  it('NO ANSWER IS NOT A YES — the line is short and nothing is charged', () => {
    const result = applySubstitution({ offer: OFFER, decision: 'no_answer' });
    expect(result.outcome).toBe('not_confirmed');
    expect(result.pickProductId).toBeUndefined();
    expect(result.pickQuantityMinor).toBe(0);
    expect(result.chargeMinor).toBe(0);
    expect(result.detail).toContain('silence is not consent');
    expect(result.tellTheCustomer).toContain('left it out rather than guess');
  });

  it('a decline short-picks the line and charges nothing', () => {
    const result = applySubstitution({ offer: OFFER, decision: 'declined' });
    expect(result.outcome).toBe('short_picked');
    expect(result.chargeMinor).toBe(0);
    expect(result.tellTheCustomer).toContain('you have not been charged for it');
  });

  it('substitutes at the same price when the customer agrees', () => {
    const result = applySubstitution({ offer: OFFER, decision: 'confirmed' });
    expect(result.outcome).toBe('substituted');
    expect(result.pickProductId).toBe('p-milk-skim');
    expect(result.chargeMinor).toBe(12_000);
    expect(result.refundMinor).toBe(0);
  });

  it('THE CUSTOMER NEVER PAYS MORE for our failure to have the item', () => {
    const dearer = applySubstitution({
      offer: { ...OFFER, substituteUnitPriceMinor: 9_000 },
      decision: 'confirmed',
    });
    // ₹180 substitute charged at the ₹120 they ordered.
    expect(dearer.chargeMinor).toBe(12_000);
    expect(dearer.refundMinor).toBe(0);
    expect(dearer.detail).toContain("the difference is ours, not the customer's");
    expect(dearer.tellTheCustomer).toContain('you have been charged the original price');
  });

  it('a cheaper substitute is charged cheaper and the difference REFUNDED, not kept', () => {
    const cheaper = applySubstitution({
      offer: { ...OFFER, substituteUnitPriceMinor: 4_500 },
      decision: 'confirmed',
    });
    expect(cheaper.chargeMinor).toBe(9_000);
    expect(cheaper.refundMinor).toBe(3_000);
    expect(cheaper.tellTheCustomer).toContain('refunded the difference');
  });
});

describe('a channel is reconciled in BOTH directions', () => {
  const ours: ChannelOrder[] = [
    { orderId: 'O-1', valueMinor: 92_000, state: 'delivered' },
    { orderId: 'O-2', valueMinor: 50_000, state: 'picking' },
    { orderId: 'O-phantom', valueMinor: 30_000, state: 'confirmed' },
  ];

  it('reports an order the channel has and we do not — a customer is waiting', () => {
    const result = reconcileChannel({
      channel: 'app',
      channelOrders: [...ours.slice(0, 2), { orderId: 'O-missed', valueMinor: 45_000, state: 'confirmed' }],
      ledgerOrders: ours,
    });
    const missed = result.discrepancies.find((d) => d.orderId === 'O-missed');
    expect(missed?.kind).toBe('in_channel_not_in_ledger');
    expect(missed?.detail).toContain('a customer is waiting for something nobody is picking');
  });

  it('reports an order we have and the channel does not — a phantom', () => {
    const result = reconcileChannel({ channel: 'app', channelOrders: ours.slice(0, 2), ledgerOrders: ours });
    const phantom = result.discrepancies.find((d) => d.orderId === 'O-phantom');
    expect(phantom?.kind).toBe('in_ledger_not_in_channel');
    expect(phantom?.detail).toContain('will never be paid for');
    expect(phantom?.varianceMinor).toBe(30_000);
  });

  it('catches a value mismatch and says which one the customer is charged', () => {
    const result = reconcileChannel({
      channel: 'app',
      channelOrders: [{ orderId: 'O-1', valueMinor: 90_000, state: 'delivered' }],
      ledgerOrders: [{ orderId: 'O-1', valueMinor: 92_000, state: 'delivered' }],
    });
    expect(result.discrepancies[0]?.kind).toBe('value_mismatch');
    expect(result.discrepancies[0]?.varianceMinor).toBe(2_000);
    expect(result.discrepancies[0]?.detail).toContain('what the customer is charged');
  });

  it('catches a state mismatch and notes the customer reads the channel', () => {
    const result = reconcileChannel({
      channel: 'app',
      channelOrders: [{ orderId: 'O-1', valueMinor: 92_000, state: 'out_for_delivery' }],
      ledgerOrders: [{ orderId: 'O-1', valueMinor: 92_000, state: 'picking' }],
    });
    expect(result.discrepancies[0]?.kind).toBe('state_mismatch');
    expect(result.discrepancies[0]?.detail).toContain('the customer is reading the channel');
  });

  it('reconciles cleanly when both sides agree', () => {
    const result = reconcileChannel({ channel: 'app', channelOrders: ours, ledgerOrders: ours });
    expect(result.reconciles).toBe(true);
    expect(result.matched).toBe(3);
    expect(result.matchedValueMinor).toBe(172_000);
    expect(result.atRiskValueMinor).toBe(0);
    expect(result.detail).toContain('app reconciles exactly');
  });
});
