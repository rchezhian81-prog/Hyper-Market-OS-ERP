import { describe, it, expect } from 'vitest';
import { bootPos, type LaneLookup, type DurableWrite } from '../../apps/pos/src/browser-entry';
import type { SaleLookupResult } from '../../edge/store-edge/src/receipt-lookup';
import type { CommitReturnInput } from '../../packages/returns/src/returns';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';

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

/** The lane's catalogue: one product the till sells, one it no longer sells (still returnable), and a barcode each. */
const CATALOGUE: CatalogueSnapshot = {
  tenantId: 't-sre', version: 3, builtAt: '2026-08-05T06:00:00Z',
  products: [
    { productId: 'P1', sku: 'GHEE-1L', name: 'Amul Ghee 1L', baseUom: 'ea', unitPriceMinor: 64_000, taxBps: 500, status: 'active' },
    { productId: 'P9', sku: 'OLD-TIN', name: 'Discontinued tin', baseUom: 'ea', unitPriceMinor: 10_000, taxBps: 500, status: 'discontinued' },
  ],
  barcodes: [{ code: '8901234567890', productId: 'P1', kind: 'standard' }, { code: '8901234500009', productId: 'P9', kind: 'standard' }],
};

const boot = (over: {
  laneLookup?: LaneLookup;
  durableReturn?: DurableWrite;
  approvalThresholdMinor?: number;
  noReceiptCapMinor?: number;
  catalogue?: CatalogueSnapshot | null;
  cashierId?: string | null;
} = {}) => bootPos({
  laneId: 'lane-1',
  ...(over.cashierId === null ? {} : { cashierId: over.cashierId ?? 'u-meena' }),
  laneLookup: over.laneLookup ?? (async () => LOOKUP),
  durableReturn: over.durableReturn ?? okReturn,
  refundPolicy: {
    approvalThresholdMinor: over.approvalThresholdMinor ?? 100_000,
    ...(over.noReceiptCapMinor === undefined ? {} : { noReceiptCapMinor: over.noReceiptCapMinor }),
  },
  ...(over.catalogue === null ? {} : { catalogue: over.catalogue ?? CATALOGUE }),
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

  it('carries the customer of a store-credit refund onto the record the edge stores (M13-FR-03/§31)', async () => {
    let posted: { refundTender?: string; customerRef?: string } | undefined;
    const durableReturn: DurableWrite = async (_id, record) => { posted = JSON.parse(record); return { committed: true, durable: true, detail: '', laneMessage: 'ok' }; };
    const found = (await boot({ durableReturn }).lookupRefund('B-1'))!;
    const out = await found.submit({
      returnId: 'R-SC', number: 'RET-SC', reasonCode: 'damaged', lines: [line],
      refundMinor: 5_000, refundTender: 'store_credit', customerRef: 'c-asha',
    });
    expect(out.kind).toBe('settled'); // store credit settles offline, like cash
    // The customer rode to the edge record, so the offline refund can issue the credit on sync.
    expect(posted?.refundTender).toBe('store_credit');
    expect(posted?.customerRef).toBe('c-asha');
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

/**
 * **The return WITHOUT a receipt (SP-9b-i · M13-FR-01 · §28).** There is no bill to look up: the item is named from the
 * lane's catalogue, the refund is bounded by the cap the till was GIVEN, and a manager always approves. The surface
 * is offered only when the till can do that honestly — a cap and a catalogue — and refuses what the engine refuses.
 */
describe('returning without a receipt', () => {
  const draft = (over: Record<string, unknown> = {}) => ({
    returnId: 'RT-NR-1', number: 'RT-0007', reasonCode: 'damaged',
    lines: [{ productId: 'P1', uom: 'ea', quantityMinor: 1, disposition: 'resell' as const }],
    refundMinor: 20_000, refundTender: 'cash' as const,
    approval: { by: 'u-manager', reason: 'checked the goods' },
    ...over,
  });

  it('is NOT offered when the box gave no cap, a cap of zero, or the till has no catalogue to name the item from (fail safe)', () => {
    expect(boot().noReceiptReturn()).toBeNull();                                   // no cap given
    expect(boot({ noReceiptCapMinor: 0 }).noReceiptReturn()).toBeNull();           // 0 = switched off, the cloud's own convention
    expect(boot({ noReceiptCapMinor: 100_000, catalogue: null }).noReceiptReturn()).toBeNull(); // nothing to name the item from
    expect(boot({ noReceiptCapMinor: 100_000 }).noReceiptReturn()).not.toBeNull();
  });

  it('names the item from the lane\'s catalogue by barcode, SKU or id — a delisted item included — and knows no stranger', () => {
    const desk = boot({ noReceiptCapMinor: 100_000 }).noReceiptReturn()!;
    expect(desk.capMinor).toBe(100_000);
    expect(desk.findProduct('8901234567890')).toEqual({ productId: 'P1', name: 'Amul Ghee 1L', uom: 'ea' });
    expect(desk.findProduct('GHEE-1L')?.productId).toBe('P1');
    expect(desk.findProduct('8901234500009')).toEqual({ productId: 'P9', name: 'Discontinued tin', uom: 'ea' });
    expect(desk.findProduct('0000000000000')).toBeNull();
    expect(desk.needsApproval()).toBe(true); // always — every no-receipt return needs a second person
  });

  it('settles a cash return within the cap with a manager, and the record the edge stores says NO RECEIPT against NO bill', async () => {
    let posted: Record<string, unknown> | undefined;
    const durableReturn: DurableWrite = async (_id, record) => { posted = JSON.parse(record) as Record<string, unknown>; return okReturn('', ''); };
    const desk = boot({ noReceiptCapMinor: 100_000, durableReturn }).noReceiptReturn()!;
    const out = await desk.submit(draft());
    expect(out.kind).toBe('settled');
    expect(posted).toMatchObject({
      returnId: 'RT-NR-1', number: 'RT-0007', noReceipt: true, originalSaleId: null,
      processedBy: 'u-meena', approvedBy: 'u-manager', refundMinor: 20_000, refundTender: 'cash',
      lines: [{ productId: 'P1', uom: 'ea', quantityMinor: 1, disposition: 'resell' }],
    });
  });

  it('refuses one with NO manager as approval_required, and one approved by the cashier themself (§28) — nothing is written', async () => {
    let writes = 0;
    const durableReturn: DurableWrite = async () => { writes += 1; return okReturn('', ''); };
    const desk = boot({ noReceiptCapMinor: 100_000, durableReturn }).noReceiptReturn()!;
    expect((await desk.submit(draft({ approval: undefined }))).kind).toBe('approval_required');
    expect((await desk.submit(draft({ approval: { by: 'u-meena', reason: 'mine' } }))).kind).toBe('approval_required');
    expect(writes).toBe(0);
  });

  it('refuses an amount above the cap before anything is written (M13-FR-01)', async () => {
    let writes = 0;
    const durableReturn: DurableWrite = async () => { writes += 1; return okReturn('', ''); };
    const desk = boot({ noReceiptCapMinor: 15_000, durableReturn }).noReceiptReturn()!;
    const out = await desk.submit(draft({ refundMinor: 20_000 }));
    expect(out.kind).toBe('invalid');
    expect(writes).toBe(0);
    expect((await desk.submit(draft({ refundMinor: 15_000 }))).kind).toBe('settled'); // at the cap is allowed
  });

  it('refuses when nobody is signed in — a no-receipt return is asked for by a named cashier (F09)', async () => {
    const till = boot({ noReceiptCapMinor: 100_000, cashierId: null });
    expect((await till.noReceiptReturn()!.submit(draft())).kind).toBe('refused');
    till.signIn('u-meena');
    expect((await till.noReceiptReturn()!.submit(draft())).kind).toBe('settled');
  });

  it('carries the customer of a store-credit no-receipt return, and a card one comes back pending (M13-FR-03/04)', async () => {
    let posted: Record<string, unknown> | undefined;
    const durableReturn: DurableWrite = async (_id, record) => { posted = JSON.parse(record) as Record<string, unknown>; return okReturn('', ''); };
    const desk = boot({ noReceiptCapMinor: 100_000, durableReturn }).noReceiptReturn()!;
    expect((await desk.submit(draft({ refundTender: 'store_credit', customerRef: 'c-asha' }))).kind).toBe('settled');
    expect(posted).toMatchObject({ refundTender: 'store_credit', customerRef: 'c-asha', noReceipt: true });
    expect((await desk.submit(draft({ returnId: 'RT-NR-2', refundTender: 'card' }))).kind).toBe('pending');
  });
});
