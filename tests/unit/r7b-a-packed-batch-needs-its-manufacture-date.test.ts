import { describe, it, expect } from 'vitest';
import {
  captureReceipt, IncompleteCaptureError, MANUFACTURE_DATE_MISSING, MANUFACTURE_DATE_UNREADABLE, isManufactureDate,
  receiveScan, linesMissingManufactureDate, type CapturedLine, type ProductReceiptRules,
} from '../../packages/receiving/src/index';
import { receiptRuleFor, incompleteCode } from '../../services/inventory/src/goods-receipt';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/ledger';
import { createManagerSession, ManufactureDateRequiredError, type ManagerConfig } from '../../apps/web-erp/src/manager-session';
import { WarehouseSession, FEEDBACK_CODES } from '../../apps/warehouse-app/src/warehouse-session';
import { packedProductIdsFor } from '../../edge/store-edge/src/screen-data';
import { readPack } from '../../edge/store-edge/src/store-pack';

/**
 * **B4 · OB-504 (owner, 28 Oct 2026) — a packed product's batch is not received without its month and year of manufacture.**
 * The engine every receiving path runs refuses the line by name; a date it cannot read is refused too; an opening-stock load
 * is the one exception (said by the boundary). The handheld's scan engine and the manager's screen refuse offline from the
 * store pack's list of packed products; a screen the box never told still saves (head office refuses it by name).
 */

const AT = '2026-10-20T06:00:00.000Z';
const inr = (minor: number) => ({ minor, currency: 'INR' as const });
const POLICY = { excessToleranceBp: 0, shortageToleranceBp: 0, nearExpiryDays: 7 };
const PACKED: ProductReceiptRules = { productId: 'p-det', batchTracked: false, packaged: true };
const LOOSE: ProductReceiptRules = { productId: 'p-brm', batchTracked: false };
const line = (over: Partial<CapturedLine> = {}): CapturedLine => ({ lineId: 'L1', productId: 'p-det', orderedMinor: 10, countedMinor: 10, uom: 'ea', unitCost: inr(5_000), condition: 'good', ...over });
const capture = (lines: readonly CapturedLine[], extra: { manufactureDateRequired?: boolean } = {}) =>
  captureReceipt({ receiptId: 'g1', lines, rules: [PACKED, LOOSE], policy: POLICY, receivedOnDate: '2026-10-20', currency: 'INR', ...extra });

describe('the capture engine (packages/receiving)', () => {
  it('refuses a packed line with no manufacture date, or one it cannot read, by its own name; takes it with one', () => {
    let e: unknown;
    try { capture([line()]); } catch (x) { e = x; }
    expect(e).toBeInstanceOf(IncompleteCaptureError);
    expect((e as IncompleteCaptureError).missing).toBe(MANUFACTURE_DATE_MISSING);
    expect(incompleteCode(e as IncompleteCaptureError)).toBe('manufacture_date_required');
    for (const bad of ['09-2026', '2026-13', '2026/09', 'Sept 2026', '2026-09-32']) {
      try { capture([line({ manufacturedOn: bad })]); e = undefined; } catch (x) { e = x; }
      expect((e as IncompleteCaptureError).missing).toBe(MANUFACTURE_DATE_UNREADABLE);
    }
    const ok = capture([line({ manufacturedOn: '2026-09' }), line({ lineId: 'L2', productId: 'p-brm' })]);
    expect(ok.lines.map((l) => [l.productId, l.manufacturedOn])).toEqual([['p-det', '2026-09'], ['p-brm', undefined]]);
    expect(capture([line({ manufacturedOn: '2026-09-14' })]).lines[0]!.manufacturedOn).toBe('2026-09-14');
    // A batch-tracking refusal keeps its own name.
    try { captureReceipt({ receiptId: 'g', lines: [line({ productId: 'p-t' })], rules: [{ productId: 'p-t', batchTracked: true }], policy: POLICY, receivedOnDate: '2026-10-20', currency: 'INR' }); } catch (x) { e = x; }
    expect(incompleteCode(e as IncompleteCaptureError)).toBe('receipt_line_incomplete');
  });

  it('an opening-stock load (not goods received) takes a packed line without one', () => {
    expect(capture([line()], { manufactureDateRequired: false }).lines[0]!.manufacturedOn).toBeUndefined();
  });

  it('the rule is head office\'s: a product whose department is regulated `packed` is packaged; the date is read strictly', () => {
    expect(receiptRuleFor('p-det', { batchTracked: false }, undefined, [], ['packed'])).toMatchObject({ packaged: true });
    expect(receiptRuleFor('p-brm', { batchTracked: false }, undefined, [], ['food'])?.packaged).toBeUndefined();
    expect(receiptRuleFor('p-x', undefined, undefined, [], ['packed'])).toBeUndefined();
    expect([isManufactureDate('2026-09'), isManufactureDate('2026-09-01'), isManufactureDate('2026-9'), isManufactureDate(202609)]).toEqual([true, true, false, false]);
  });
});

describe('offline: the handheld\'s scan engine and the manager\'s screen refuse from the store pack\'s list', () => {
  const PACKS = [{ productId: 'p-det', baseUom: 'ea', levels: [{ level: 'unit', containsMinor: 1, barcode: '890DET' }] }];
  const scan = (manufacturedOn?: string, packaged: readonly string[] | null = ['p-det']) => receiveScan({
    command: { commandId: 'c1', grnId: 'g', storeId: 's', receivedBy: 'u', at: AT, source: 'po', barcode: '890DET', scannedQuantity: 1, ...(manufacturedOn === undefined ? {} : { manufacturedOn }) },
    appliedCommandIds: [], barcodes: [{ barcode: '890DET', productId: 'p-det', level: 'unit' }], packs: PACKS,
    ...(packaged === null ? {} : { packagedProductIds: packaged }),
  });

  it('receiveScan: a packed product with no (or an unreadable) month is refused; with one it is received; untold, it is received', () => {
    expect(scan()).toMatchObject({ accepted: false, outcome: 'manufacture_date_required' });
    expect(scan('26-09')).toMatchObject({ accepted: false, outcome: 'manufacture_date_required' });
    expect(scan('2026-09')).toMatchObject({ accepted: true, outcome: 'received' });
    expect(scan(undefined, null)).toMatchObject({ accepted: true }); // the handheld was not told: head office refuses it instead
    expect(scan(undefined, [])).toMatchObject({ accepted: true }); // told: nothing is packed
    expect(linesMissingManufactureDate(['p-det'], [{ productId: 'p-det' }, { productId: 'p-brm' }, { productId: 'p-det', manufacturedOn: '2026-09' }])).toEqual(['p-det']);
    expect(linesMissingManufactureDate(undefined, [{ productId: 'p-det' }])).toEqual([]);
  });

  it('the warehouse handheld refuses the scan, queues nothing, and its words are bilingual; with the month it queues it', () => {
    const outbox = new SyncOutbox();
    const s = new WarehouseSession({
      assignmentId: 'A-1', workerId: 'u-worker', storeId: 'store-1', bins: [], grnId: 'g-1',
      barcodes: [{ barcode: '890DET', productId: 'p-det', level: 'unit' }], packs: PACKS, packedProductIds: ['p-det'],
    }, outbox, { now: () => AT });
    const refused = s.receive({ commandId: 'c-1', grnId: 'g-1', barcode: '890DET', scannedQuantity: 1, source: 'po' });
    expect([refused.result.accepted, refused.signal.code]).toEqual([false, 'manufacture_date_required']);
    expect(outbox.all()).toEqual([]);
    expect(FEEDBACK_CODES).toContain('manufacture_date_required');
    const ok = s.receive({ commandId: 'c-2', grnId: 'g-1', barcode: '890DET', scannedQuantity: 1, source: 'po', manufacturedOn: '2026-09' });
    expect(ok.result.accepted).toBe(true);
    expect(outbox.all()[0]!.event.payload).toMatchObject({ productId: 'p-det', manufacturedOn: '2026-09' });
  });

  it('the manager\'s Receive form refuses a packed line with no month (nothing saved, no stock moved); with it the line carries it', () => {
    const outbox = new SyncOutbox();
    const config: ManagerConfig = {
      storeId: 'store-1', branchId: 'store-1', tradingDay: '2026-10-20', tradingDayRule: { cutoff: '02:00' } as unknown as ManagerConfig['tradingDayRule'],
      manager: { userId: 'u-mgr', branchScope: ['store-1'], authorityLimit: null }, currency: 'INR', warehouseId: 'wh-1', packedProductIds: ['p-det'],
    };
    const ports = { approvals: () => ({ known: false as const, why: 'x' }), exceptions: () => ({ known: false as const, why: 'x' }), unsent: () => ({ known: false as const, why: 'x' }), tasks: () => ({ known: false as const, why: 'x' }), pendingPayments: () => ({ known: false as const, why: 'x' }) };
    const s = createManagerSession(config, ports as never, new Ledger(new InMemoryLedgerStore()), outbox);
    expect(s.packedAmong(['p-brm', 'p-det'])).toEqual(['p-det']);
    let e: unknown;
    try { s.receive({ grnId: 'g1', number: 'DN-1', poId: null, receivedAt: AT, lines: [{ productId: 'p-det', quantityMinor: 2, uom: 'ea' }] }); } catch (x) { e = x; }
    expect(e).toBeInstanceOf(ManufactureDateRequiredError);
    expect((e as ManufactureDateRequiredError).productIds).toEqual(['p-det']);
    expect(outbox.pending()).toEqual([]);
    s.receive({ grnId: 'g1', number: 'DN-1', poId: null, receivedAt: AT, lines: [{ productId: 'p-det', quantityMinor: 2, uom: 'ea', manufacturedOn: '2026-09' }] });
    expect((outbox.pending()[0]!.event.payload as { lines: unknown[] }).lines).toEqual([expect.objectContaining({ productId: 'p-det', manufacturedOn: '2026-09' })]);
  });

  it('the store computer serves the list it was told (read strictly); absent stays absent', () => {
    expect(packedProductIdsFor({ pack: readPack({ version: 1, packedProductIds: ['p-det', 7, ''] }, AT) } as never)).toEqual({ packedProductIds: ['p-det'] });
    expect(packedProductIdsFor({ pack: readPack({ version: 1 }, AT) } as never)).toEqual({});
  });
});
