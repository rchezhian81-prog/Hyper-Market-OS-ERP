import { describe, it, expect } from 'vitest';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/ledger';
import { commitReceipt, datedBatchId, isCalendarDate, receiptLineProblems } from '../../packages/receiving/src/receiving';
import { createManagerSession, ReceiptLinesRefusedError, type ManagerConfig } from '../../apps/web-erp/src/manager-session';
import { readReceivingAids } from '../../apps/web-erp/src/browser-entry';
import { receivingAidsFor } from '../../edge/store-edge/src/screen-data';
import { readPack } from '../../edge/store-edge/src/store-pack';

/**
 * Fix batch 4b · D-029 (M07-FR-01/02/03 · M10 · P-01 · P-08): the manager's Receive form, DOM-free. The order is chosen from the
 * ones the store computer was told of and its lines start with what is still due, by name; each line takes the batch, the
 * expiry date and how many arrived damaged; an expiry with no batch printed is its own dated batch; a wrong line is refused
 * offline with nothing saved and no stock moved; the screen's own ledger raises only the good units; and the whole line
 * travels to head office. Synthetic data only.
 */

const AT = '2026-11-16T10:00:00.000Z';

function session(extra: Partial<ManagerConfig> = {}) {
  const outbox = new SyncOutbox();
  const ledger = new Ledger(new InMemoryLedgerStore());
  const config: ManagerConfig = {
    storeId: 'store-1', branchId: 'store-1', tradingDay: '2026-11-16', tradingDayRule: { cutoff: '02:00' } as unknown as ManagerConfig['tradingDayRule'],
    manager: { userId: 'u-mgr', branchScope: ['store-1'], authorityLimit: null }, currency: 'INR', warehouseId: 'wh-1',
    openDeliveries: [
      { poId: 'po-7', number: 'PO-0007', supplierId: 'sup-1', due: [{ productId: 'p-rice', dueMinor: 12 }, { productId: 'p-oil', dueMinor: 0 }, { productId: 'p-new', dueMinor: 4 }] },
    ],
    deliveriesAsAt: AT,
    productNames: { 'p-rice': 'Ponni rice 5 kg', 'p-oil': 'Groundnut oil 1 L' },
    batchTrackedProductIds: ['p-curd'],
    ...extra,
  };
  const ports = { approvals: () => ({ known: false as const, why: 'x' }), exceptions: () => ({ known: false as const, why: 'x' }), unsent: () => ({ known: false as const, why: 'x' }), tasks: () => ({ known: false as const, why: 'x' }), pendingPayments: () => ({ known: false as const, why: 'x' }) };
  return { s: createManagerSession(config, ports as never, ledger, outbox), outbox, ledger };
}

describe('D-029: the pure rules for a delivery line', () => {
  it('an expiry must be a real calendar date', () => {
    expect(isCalendarDate('2027-05-31')).toBe(true);
    expect(isCalendarDate('2027-02-29')).toBe(false);
    expect(isCalendarDate('2028-02-29')).toBe(true);
    expect(isCalendarDate('31/05/2027')).toBe(false);
    expect(isCalendarDate('2027-5-31')).toBe(false);
  });

  it('a batch with no number printed is named by its expiry date; a typed batch is kept; neither is none', () => {
    expect(datedBatchId('RB-1', '2027-05-31')).toBe('RB-1');
    expect(datedBatchId('  ', '2027-05-31')).toBe('EXP-2027-05-31');
    expect(datedBatchId(undefined, undefined)).toBeNull();
    expect(datedBatchId(null, '')).toBeNull();
  });

  it('names every wrong line: a bad date, damaged not whole or more than arrived, a batch-tracked item without batch and expiry', () => {
    expect(receiptLineProblems([
      { productId: 'a', quantityMinor: 5, expiry: '2027-13-01' },
      { productId: 'b', quantityMinor: 5, damagedMinor: 1.5 },
      { productId: 'c', quantityMinor: 5, damagedMinor: 6 },
      { productId: 'd', quantityMinor: 5, expiry: '2027-01-01' },
      { productId: 'e', quantityMinor: 5, batchId: 'X', expiry: '2027-01-01', damagedMinor: 5 },
    ], ['d', 'e'])).toEqual([
      { kind: 'expiry_not_a_date', productId: 'a' },
      { kind: 'damaged_not_whole', productId: 'b' },
      { kind: 'damaged_more_than_arrived', productId: 'c' },
      { kind: 'batch_and_expiry_needed', productId: 'd' },
    ]);
  });

  it('the screen\'s ledger raises only the good units (none for a wholly damaged line); the queued line carries expiry and damaged', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    commitReceipt({
      id: 'g1', number: 'DN-1', poId: 'po-7', warehouseId: 'wh-1', receivedBy: 'u-mgr', receivedAt: AT,
      lines: [
        { productId: 'p-rice', quantityMinor: 11, uom: 'ea', batchId: 'RB-1', expiry: '2027-05-31', damagedMinor: 2 },
        { productId: 'p-dal', quantityMinor: 3, uom: 'ea', damagedMinor: 3 },
      ],
    }, ledger, outbox);
    const moves = ledger.entries().map((r) => r.event.payload as { productId: string; deltaMinor: number });
    expect(moves).toEqual([expect.objectContaining({ productId: 'p-rice', deltaMinor: 9 })]);
    expect((outbox.pending()[0]!.event.payload as { lines: unknown[] }).lines).toEqual([
      { productId: 'p-rice', quantityMinor: 11, uom: 'ea', batchId: 'RB-1', expiry: '2027-05-31', damagedMinor: 2 },
      { productId: 'p-dal', quantityMinor: 3, uom: 'ea', batchId: null, damagedMinor: 3 },
    ]);
  });
});

describe('D-029: the manager session — the chosen order, the lines and the checks, offline', () => {
  it('offers the orders it was told of, and an order\'s lines by name with what is still due (nothing already received in full)', () => {
    const { s } = session();
    expect(s.openDeliveries()).toEqual({ known: true, orders: [expect.objectContaining({ poId: 'po-7', number: 'PO-0007' })], asAt: AT });
    expect(s.dueLinesOf('po-7')).toEqual([
      { productId: 'p-rice', name: 'Ponni rice 5 kg', dueMinor: 12 },
      { productId: 'p-new', name: 'p-new', dueMinor: 4 }, // a name the store computer does not hold is shown by its code, never guessed
    ]);
    expect(s.dueLinesOf('po-unknown')).toEqual([]);
    expect(s.productName('p-oil')).toBe('Groundnut oil 1 L');
    expect(s.batchTrackedAmong(['p-rice', 'p-curd'])).toEqual(['p-curd']);
    expect(session({ openDeliveries: undefined }).s.openDeliveries()).toEqual({ known: false });
  });

  it('refuses a wrong line with nothing saved and no stock moved; a right one is queued with a dated batch where none was printed', () => {
    const { s, outbox, ledger } = session();
    let e: unknown;
    try {
      s.receive({ grnId: 'g1', number: 'DN-1', poId: 'po-7', receivedAt: AT, lines: [
        { productId: 'p-rice', quantityMinor: 2, uom: 'ea', damagedMinor: 3 },
        { productId: 'p-curd', quantityMinor: 4, uom: 'ea', expiry: '2026-12-01' },
      ] });
    } catch (x) { e = x; }
    expect(e).toBeInstanceOf(ReceiptLinesRefusedError);
    expect((e as ReceiptLinesRefusedError).problems.map((p) => p.kind)).toEqual(['damaged_more_than_arrived', 'batch_and_expiry_needed']);
    expect(outbox.pending()).toEqual([]);
    expect(ledger.entries()).toEqual([]);

    s.receive({ grnId: 'g2', number: 'DN-2', poId: 'po-7', receivedAt: AT, lines: [
      { productId: 'p-rice', quantityMinor: 11, uom: 'ea', expiry: ' 2027-05-31 ', damagedMinor: 2 },
      { productId: 'p-curd', quantityMinor: 4, uom: 'ea', batchId: 'C-9', expiry: '2026-12-01' },
    ] });
    expect((outbox.pending()[0]!.event.payload as { poId: string; lines: unknown[] })).toMatchObject({
      poId: 'po-7',
      lines: [
        { productId: 'p-rice', quantityMinor: 11, batchId: 'EXP-2027-05-31', expiry: '2027-05-31', damagedMinor: 2 },
        { productId: 'p-curd', quantityMinor: 4, batchId: 'C-9', expiry: '2026-12-01' },
      ],
    });
  });
});

describe('D-029: the store computer serves the Receive form its aids; the page reads them strictly', () => {
  it('serves the open deliveries with what is due, when it took them, the names — absent stays absent', () => {
    const pack = readPack({
      version: 1,
      products: [{ productId: 'p-rice', name: 'Ponni rice 5 kg', categoryId: 'g', unitPriceMinor: 1, uom: 'ea', barcodes: [], availableMinor: 0 }],
      warehouse: {
        assignmentId: 'A-1', workerId: 'u-mgr', storeId: 'store-1', bins: [],
        openDeliveries: [{ poId: 'po-7', number: 'PO-0007', supplierId: 'sup-1', deliverToLocationId: 'wh-1', grnId: 'grn-7', ordered: [{ productId: 'p-rice', quantityMinor: 12, unitCostMinor: 5_000, currency: 'INR' }] }],
      },
    }, AT);
    const aids = receivingAidsFor({ pack, now: AT } as never);
    expect(aids).toMatchObject({
      openDeliveries: [{ poId: 'po-7', number: 'PO-0007', supplierId: 'sup-1', due: [{ productId: 'p-rice', dueMinor: 12 }] }],
      deliveriesAsAt: AT,
      productNames: { 'p-rice': 'Ponni rice 5 kg' },
    });
    // The served order carries no cost: the Receive form has no use for what the store pays.
    expect(JSON.stringify(aids['openDeliveries'])).not.toContain('unitCost');
    expect(receivingAidsFor({ pack: readPack({ version: 1 }, AT), now: AT } as never)).toEqual({});
  });

  it('serves the batch-tracked products from the catalogue head office signed — never from the pack file, which carries no such mark', () => {
    const signed = { snapshot: { tenantId: 't', version: 1, builtAt: AT, barcodes: [], products: [
      { productId: 'p-curd', sku: 'C', name: 'Curd', baseUom: 'ea', unitPriceMinor: 100, taxBps: 0, status: 'active', batchTracked: true },
      { productId: 'p-rice', sku: 'R', name: 'Rice', baseUom: 'ea', unitPriceMinor: 100, taxBps: 0, status: 'active' },
    ] } };
    expect(receivingAidsFor({ pack: readPack({ version: 1 }, AT), cataloguePack: signed, now: AT } as never)).toEqual({ batchTrackedProductIds: ['p-curd'] });
    // A pack file whose products carry no barcodes list (a hand-made pack) still serves the manager's page (no catalogue read).
    const bare = readPack({ version: 1, products: [{ productId: 'p-rice', name: 'Rice', categoryId: 'g', unitPriceMinor: 1, uom: 'ea', availableMinor: 0 }] }, AT);
    expect(() => receivingAidsFor({ pack: bare, now: AT } as never)).not.toThrow();
  });

  it('the page keeps only whole deliveries, names and ids', () => {
    expect(readReceivingAids({
      openDeliveries: [
        { poId: 'po-7', number: 'PO-0007', supplierId: 'sup-1', due: [{ productId: 'p-rice', dueMinor: 12 }, { productId: 'x', dueMinor: -1 }, { productId: 7 }] },
        { poId: '', number: 'PO-bad', due: [] },
        'nonsense',
      ],
      deliveriesAsAt: AT,
      productNames: { 'p-rice': 'Ponni rice 5 kg', bad: 7 },
      batchTrackedProductIds: ['p-curd', 3, ''],
    } as never)).toEqual({
      openDeliveries: [{ poId: 'po-7', number: 'PO-0007', supplierId: 'sup-1', due: [{ productId: 'p-rice', dueMinor: 12 }] }],
      deliveriesAsAt: AT,
      productNames: { 'p-rice': 'Ponni rice 5 kg' },
      batchTrackedProductIds: ['p-curd'],
    });
    expect(readReceivingAids(undefined)).toEqual({});
  });
});
