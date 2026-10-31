import { describe, it, expect } from 'vitest';
import { ownerPayload, refundsOn, type ScreenInput } from '../../edge/store-edge/src/screen-data';
import { emptyPack, known, notKnown, type StorePack } from '../../edge/store-edge/src/store-pack';
import type { LoggedSale } from '../../edge/store-edge/src/read-model';
import { SyncOutbox } from '../../packages/sync/src/index';
import { buildBrief } from '../../apps/owner-app/src/brief';
import { refundLegs } from '../../packages/finance/src/day-book';

/**
 * **The owner's takings are counted net of today's refunds, by the day book's own rule (Round B · M29-FR-01 · P-08).**
 * A refund by its tender; an exchange by the credit it applied to the replacement (which the replacement's own
 * `exchange_credit` tender took in) plus any balance given back; a refund from another trading day is not today's.
 */

const NOW = '2026-08-05T14:00:00.000Z'; // 19:30 in the shop
const DAY = '2026-08-05';
const pack = {
  ...emptyPack(),
  receivedAt: NOW, version: 1,
  policies: known({ storeId: 'store-1', branchId: 'b1', branchName: 'SRE Hyper Market', tradingDayCutoff: '02:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 0 }),
  products: known([{ productId: 'p1', name: 'Toor dal 1kg', unitPriceMinor: 145_00, unitCostMinor: 100_00, uom: 'ea', barcodes: ['8901'], availableMinor: 10 }]),
  approvals: known([]), checklist: known([]), wave: known(null), route: known(null), warehouse: notKnown('none'),
} as unknown as StorePack;
const sale = (over: Partial<LoggedSale> = {}): LoggedSale => ({
  id: 'S-1', number: 'R-1', laneId: 'lane-1', cashierId: 'u-meena', tradingDay: DAY, committedAt: NOW, total: 145_00, currency: 'INR',
  lines: [{ productId: 'p1', quantityMinor: 1, uom: 'ea' }], tenders: [{ kind: 'cash', amount: { minor: 145_00 } }], ...over,
} as LoggedSale);
const refund = (over: Record<string, unknown> = {}) => ({
  returnId: 'RT-1', number: 'R-2', originalSaleId: 'S-1', laneId: 'lane-1', processedBy: 'u-meena', processedAt: NOW,
  reasonCode: 'damaged', refundMinor: 35_00, refundTender: 'cash', lines: [{ productId: 'p1', uom: 'ea', quantityMinor: 1, disposition: 'damaged' }], ...over,
});
const input = (over: Partial<ScreenInput> = {}): ScreenInput => ({ pack, sales: [sale()], unreadableRecords: 0, outbox: new SyncOutbox(), now: NOW, tradingDay: DAY, ...over });

describe("today's refunds, counted the day book's way", () => {
  it('a cash refund today is counted; one from yesterday, or an unreadable one, is not', () => {
    const r = refundsOn(input({ returns: [refund(), refund({ returnId: 'RT-0', processedAt: '2026-08-03T10:00:00.000Z' }), 'not a record', { refundMinor: 99 }] }));
    expect(r).toEqual({ count: 1, refundedMinor: 35_00, tenderMix: { cash: 35_00 } });
    // The same legs the day book posts for it.
    expect(refundLegs({ returnId: 'RT-1', originalSaleId: 'S-1', refundMinor: 35_00, refundTender: 'cash', lines: [] })).toEqual([{ kind: 'cash', amountMinor: 35_00 }]);
  });

  it('an exchange takes off the credit applied (the replacement took it in as exchange_credit) and the cash balance given back', () => {
    const r = refundsOn(input({ returns: [refund({
      returnId: 'RT-X', refundMinor: 145_00, refundTender: 'exchange',
      exchange: { exchangeId: 'X-1', replacementSaleId: 'S-2', replacementTotalMinor: 100_00, appliedMinor: 100_00, balance: 'refund', balanceMinor: 45_00, balanceTender: 'cash' },
    })] }));
    expect(r).toEqual({ count: 1, refundedMinor: 145_00, tenderMix: { exchange_credit: 100_00, cash: 45_00 } });
  });

  it('the owner payload carries them, and the brief\'s takings, tender mix and sentence are net of them', () => {
    const payload = ownerPayload(input({ returns: [refund()] }))!;
    const branch = (payload['branches'] as Record<string, unknown>[])[0]!;
    expect(branch['refunds']).toEqual({ count: 1, refundedMinor: 35_00, tenderMix: { cash: 35_00 } });
    const brief = buildBrief({
      asOf: NOW, lastSyncedAt: NOW, staleAfterSeconds: 300, sales: branch['sales'] as never, exceptions: [], approvals: [],
      refunds: branch['refunds'] as never,
    });
    expect(brief.takings).toMatchObject({ bills: 1, takenMinor: 110_00, refunds: 1, refundedMinor: 35_00, tenderMix: { cash: 110_00 } });
    expect(brief.headline).toContain('Refunds today: ₹35.00 — ₹110.00 taken after refunds.');
    // No refunds: the takings and the sentence are as before.
    const plain = buildBrief({ asOf: NOW, lastSyncedAt: NOW, staleAfterSeconds: 300, sales: branch['sales'] as never, exceptions: [], approvals: [] });
    expect(plain.takings).toMatchObject({ takenMinor: 145_00, refunds: 0, refundedMinor: 0 });
    expect(plain.headline).not.toContain('Refunds');
  });
});
