import { describe, it, expect } from 'vitest';
import { bootPos, type LaneLookup, type DurableWrite } from '../../apps/pos/src/browser-entry';
import type { SaleLookupResult } from '../../edge/store-edge/src/receipt-lookup';
import type { CommitReturnInput } from '../../packages/returns/src/returns';

/**
 * **The shell's refund surface (M13, §27) — the seam that binds the refund screen to the engine.**
 *
 * bootPos.lookupRefund fetches a bill over the lane read route, then hands the screen a small object
 * that shows what is returnable and completes the refund through the tested refund view + till. This
 * proves the wiring without a DOM or a socket: a fake lane lookup and a fake durable-return write
 * stand in for the edge. Synthetic data only (hard rule #7).
 */

const LOOKUP: SaleLookupResult = {
  sale: {
    saleId: 'S-1', number: 'B-1', tradingDay: '2026-08-05', committedAt: '2026-08-05T10:00:00Z',
    totalMinor: 20_000, lines: [{ productId: 'P1', uom: 'ea', quantityMinor: 2 }],
  },
  returns: [],
  refunds: [],
};

const okReturn: DurableWrite = async () => ({ committed: true, durable: true, detail: 'on disk', laneMessage: 'ok' });

const boot = (over: {
  laneLookup?: LaneLookup;
  durableReturn?: DurableWrite;
  approvalThresholdMinor?: number;
} = {}) => bootPos({
  cashierId: 'u-meena',
  laneLookup: over.laneLookup ?? (async () => LOOKUP),
  durableReturn: over.durableReturn ?? okReturn,
  refundPolicy: { approvalThresholdMinor: over.approvalThresholdMinor ?? 100_000 },
});

const line = { productId: 'P1', uom: 'ea', quantityMinor: 1, disposition: 'resell' as const };

describe('looking a bill up for a refund', () => {
  it('shows what is returnable and the money ceiling', async () => {
    const found = (await boot().lookupRefund('B-1'))!;
    expect(found.sale).toEqual({ saleId: 'S-1', number: 'B-1', totalMinor: 20_000 });
    expect(found.returnable.find((l) => l.productId === 'P1')).toMatchObject({ soldMinor: 2, returnableMinor: 2 });
    expect(found.maxRefundMinor).toBe(20_000);
  });

  it('resolves null for a bill this lane did not ring', async () => {
    expect(await boot({ laneLookup: async () => null }).lookupRefund('B-999')).toBeNull();
  });

  it('needsApproval follows the injected threshold', async () => {
    const found = (await boot({ approvalThresholdMinor: 20_000 }).lookupRefund('B-1'))!;
    expect(found.needsApproval(19_999)).toBe(false);
    expect(found.needsApproval(20_000)).toBe(true);
  });
});

describe('completing a refund through the surface', () => {
  it('settles a cash refund below the approval threshold', async () => {
    const found = (await boot().lookupRefund('B-1'))!;
    const out = await found.submit({
      returnId: 'R-1', number: 'RET-1', reasonCode: 'damaged', lines: [line],
      refundMinor: 5_000, refundTender: 'cash',
    });
    expect(out.kind).toBe('settled');
  });

  it('maps a manager approval into the §28 DecidedRequest the engine checks', async () => {
    let posted: string | undefined;
    const durableReturn: DurableWrite = async (_id, record) => { posted = record; return { committed: true, durable: true, detail: '', laneMessage: 'ok' }; };
    // Threshold 0 → this refund needs an approver; supply a manager (not the cashier).
    const found = (await boot({ durableReturn, approvalThresholdMinor: 0 }).lookupRefund('B-1'))!;
    const out = await found.submit({
      returnId: 'R-2', number: 'RET-2', reasonCode: 'damaged', lines: [line],
      refundMinor: 5_000, refundTender: 'cash', approval: { by: 'u-manager', reason: 'checked the goods' },
    });
    expect(out.kind).toBe('settled');
    const record = JSON.parse(posted!) as { approvedBy?: string; processedBy?: string };
    expect(record.approvedBy).toBe('u-manager');       // the §28 approver rode to the edge
    expect(record.processedBy).toBe('u-meena');        // the cashier, ≠ approver (separation of duties)
  });

  it('refuses a material refund with NO approver as approval_required (§28, default threshold 0)', async () => {
    const found = (await boot({ approvalThresholdMinor: 0 }).lookupRefund('B-1'))!;
    const out = await found.submit({
      returnId: 'R-3', number: 'RET-3', reasonCode: 'damaged', lines: [line],
      refundMinor: 5_000, refundTender: 'cash', // no approval
    });
    expect(out.kind).toBe('approval_required');
  });

  it('a card refund comes back pending — money has not moved (M13-FR-04)', async () => {
    const found = (await boot().lookupRefund('B-1'))!;
    const out = await found.submit({
      returnId: 'R-4', number: 'RET-4', reasonCode: 'damaged', lines: [line],
      refundMinor: 5_000, refundTender: 'card',
    });
    expect(out.kind).toBe('pending');
  });

  it('the surface passes the engine trusted line facts from the looked-up bill', async () => {
    let posted: Partial<CommitReturnInput> & { lines?: { originalQtyMinor?: number }[] } | undefined;
    const durableReturn: DurableWrite = async (_id, record) => { posted = JSON.parse(record); return { committed: true, durable: true, detail: '', laneMessage: 'ok' }; };
    const found = (await boot({ durableReturn }).lookupRefund('B-1'))!;
    await found.submit({
      returnId: 'R-5', number: 'RET-5', reasonCode: 'damaged', lines: [line],
      refundMinor: 5_000, refundTender: 'cash',
    });
    // The refund record the edge stores carries the bill it is against.
    expect(posted?.originalSaleId).toBe('S-1');
  });
});
