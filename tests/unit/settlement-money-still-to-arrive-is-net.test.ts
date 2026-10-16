import { describe, it, expect } from 'vitest';
import { reviewSettlement } from '../../packages/settlement/src/settlement';
import { InMemoryEventStore } from '../../packages/persistence/src/event-store';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM } from '../../services/api/src/adapters';
import { settlementRefundsAdapter } from '../../services/api/src/r2-data-adapters';

// C13 (v2.1 addendum), verifier lane-2 NEW-4 and NEW-5. Synthetic references only; no card number anywhere.

describe('NEW-4: "money still to arrive" nets pending refunds against pending captures (C13)', () => {
  it('a 1,000 capture and a 400 refund both pending is 600 to arrive, with both parts shown', () => {
    const r = reviewSettlement({
      tenders: [{ id: 't1', ref: 'TXN-A', amountMinor: 1000, capturedOn: '2026-10-16' }],
      credits: [],
      refunds: [{ id: 'ret1', originalRef: 'TXN-B', amountMinor: 400, refundedOn: '2026-10-16' }],
      settlementCycleDays: 1, asOf: '2026-10-16',
    });
    expect(r.exceptions.map((e) => e.finding).sort()).toEqual(['awaiting_settlement', 'refund_awaiting_settlement']);
    expect(r.awaitingValueMinor).toBe(600);
    expect(r.awaitingCapturesMinor).toBe(1000);
    expect(r.awaitingRefundsMinor).toBe(400);
    expect(r.detail).toContain('600 net not due yet (1000 still to come in, 400 in refunds still to go out)');
    // Neither is a problem yet, so nothing is at risk.
    expect(r.atRiskValueMinor).toBe(0);
  });

  it('only captures pending: the figure and the words are as before', () => {
    const r = reviewSettlement({ tenders: [{ id: 't1', ref: 'TXN-A', amountMinor: 1000, capturedOn: '2026-10-16' }], credits: [], refunds: [], settlementCycleDays: 1, asOf: '2026-10-16' });
    expect([r.awaitingValueMinor, r.awaitingCapturesMinor, r.awaitingRefundsMinor]).toEqual([1000, 1000, 0]);
    expect(r.detail).toContain('1000 not due yet');
  });

  it('more refunds than captures pending: the net is below zero — that much more is still to leave', () => {
    const r = reviewSettlement({ tenders: [], credits: [], refunds: [{ id: 'ret1', originalRef: 'TXN-B', amountMinor: 400, refundedOn: '2026-10-16' }], settlementCycleDays: 1, asOf: '2026-10-16' });
    expect([r.awaitingValueMinor, r.awaitingCapturesMinor, r.awaitingRefundsMinor]).toEqual([-400, 0, 400]);
  });

  it('an overdue refund is at risk and leaves the pipeline', () => {
    const r = reviewSettlement({
      tenders: [{ id: 't1', ref: 'TXN-A', amountMinor: 1000, capturedOn: '2026-10-16' }], credits: [],
      refunds: [{ id: 'ret1', originalRef: 'TXN-B', amountMinor: 400, refundedOn: '2026-10-10' }], settlementCycleDays: 1, asOf: '2026-10-16',
    });
    expect([r.awaitingValueMinor, r.awaitingRefundsMinor, r.atRiskValueMinor]).toEqual([1000, 0, 400]);
  });
});

describe('NEW-5: an exchange balance refunded to a card or UPI is in the refunds feed (C13)', () => {
  const T = 'tenant-unit';
  const ret = (id: string, exchange: Record<string, unknown>, originalSaleId: string | null = 'S1') => makeEvent({
    id: `ret-${id}`, type: 'ReturnRecorded', occurredAt: '2026-10-15T06:00:00.000Z', idempotencyKey: `ret-${id}`, source: 'test',
    payload: {
      returnId: id, originalSaleId, refundMinor: 1000, refundTender: 'exchange', processedAt: '2026-10-15T06:00:00.000Z',
      exchange: { exchangeId: id, replacementSaleId: `${id}-R`, replacementTotalMinor: 600, appliedMinor: 600, ...exchange },
    },
  });
  const feed = (store: InMemoryEventStore) => settlementRefundsAdapter({ store }).electronicRefunds(T, '2026-10-01T00:00:00.000Z', '2026-10-17T00:00:00.000Z');

  async function withBill(): Promise<InMemoryEventStore> {
    const store = new InMemoryEventStore();
    await store.append(T, STREAM.sales, makeEvent({
      id: 'sale-S1', type: 'SaleRecorded', occurredAt: '2026-10-14T06:00:00.000Z', idempotencyKey: `sale-${T}-S1`, source: 'test',
      payload: { saleId: 'S1', tenders: [{ kind: 'cash', amountMinor: 200 }, { kind: 'card', amountMinor: 500, ref: 'TXN-ORIG' }, { kind: 'upi', amountMinor: 300, ref: 'UPI-ORIG' }] },
    }));
    return store;
  }

  it('the balance (not the credited value) is read, keyed to the original bill\'s capture of that kind, and matches the provider\'s refund line', async () => {
    const store = await withBill();
    await store.append(T, STREAM.returns, ret('X1', { balance: 'refund', balanceMinor: 400, balanceTender: 'card' }));
    const refunds = await feed(store);
    expect(refunds).toEqual([{ id: 'X1', originalRef: 'TXN-ORIG', amountMinor: 400, refundedOn: '2026-10-15' }]);
    const r = reviewSettlement({ tenders: [], credits: [{ id: 'L1', ref: 'RF-1', amountMinor: 400, type: 'refund', originalRef: 'TXN-ORIG' }], refunds, settlementCycleDays: 1, asOf: '2026-10-16' });
    expect(r.exceptions).toEqual([]);
    expect(r.matchedRefundCount).toBe(1);
  });

  it('a UPI balance is keyed to the bill\'s UPI capture', async () => {
    const store = await withBill();
    await store.append(T, STREAM.returns, ret('X2', { balance: 'refund', balanceMinor: 300, balanceTender: 'upi' }));
    expect((await feed(store)).map((x) => [x.originalRef, x.amountMinor])).toEqual([['UPI-ORIG', 300]]);
  });

  it('cash, store credit, even, top-up, a zero or malformed balance are not card/UPI refunds', async () => {
    const store = await withBill();
    await store.append(T, STREAM.returns, ret('C', { balance: 'refund', balanceMinor: 400, balanceTender: 'cash' }));
    await store.append(T, STREAM.returns, ret('SC', { balance: 'refund', balanceMinor: 400, balanceTender: 'store_credit' }));
    await store.append(T, STREAM.returns, ret('E', { balance: 'even', balanceMinor: 0 }));
    await store.append(T, STREAM.returns, ret('TU', { balance: 'top_up', balanceMinor: 200, topUpTenders: [{ kind: 'card', amountMinor: 200 }] }));
    await store.append(T, STREAM.returns, ret('Z', { balance: 'refund', balanceMinor: 0, balanceTender: 'card' }));
    await store.append(T, STREAM.returns, ret('M', { balance: 'refund', balanceMinor: '400', balanceTender: 'card' }));
    expect(await feed(store)).toEqual([]);
  });

  it('an exchange balance on a bill head office cannot find is still returned, keyed to the bill, never dropped (P-08)', async () => {
    const store = new InMemoryEventStore();
    await store.append(T, STREAM.returns, ret('X3', { balance: 'refund', balanceMinor: 400, balanceTender: 'card' }, 'S-MISSING'));
    expect(await feed(store)).toEqual([{ id: 'X3', originalRef: 'bill:S-MISSING', amountMinor: 400, refundedOn: '2026-10-15' }]);
  });

  it('a plain card refund is read exactly as before', async () => {
    const store = await withBill();
    await store.append(T, STREAM.returns, makeEvent({
      id: 'ret-R1', type: 'ReturnRecorded', occurredAt: '2026-10-15T06:00:00.000Z', idempotencyKey: 'ret-R1', source: 'test',
      payload: { returnId: 'R1', originalSaleId: 'S1', refundMinor: 300, refundTender: 'card', processedAt: '2026-10-15T06:00:00.000Z' },
    }));
    expect(await feed(store)).toEqual([{ id: 'R1', originalRef: 'TXN-ORIG', amountMinor: 300, refundedOn: '2026-10-15' }]);
  });
});
