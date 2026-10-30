import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { manufactureDateVerdict, batchTrackedVerdict, captureReceipt, IncompleteCaptureError } from '../../packages/receiving/src/capture';
import { receiveScan } from '../../packages/receiving/src/asn';
import { reconcileDsd, dsdScanCaptureRefusal, isDsdExpiryDate, dsdBatchKey } from '../../packages/receiving/src/dsd-checkin';
import { DsdDoorSession, DSD_FEEDBACK_CODES, DSD_CHECK_IN_CLOSED } from '../../apps/warehouse-app/src/dsd-door';
import { WarehouseSession, APP_VERSION_TOO_OLD } from '../../apps/warehouse-app/src/warehouse-session';
import { dsdCheckInRoutes, dsdMovementId, type DsdCheckInDeps, type DsdCheckInRecord, type DsdOrderView } from '../../services/inventory/src/dsd-checkin';
import type { Movement } from '../../services/inventory/src/index';
import { quotationAtTill, type QuotationTillOps, type QuotationsLanePort } from '../../apps/pos/src/quotation-at-till';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { PosSession, NewBillRefusedError } from '../../apps/pos/src/session';
import { judgeClientVersion } from '../../packages/platform-admin/src/client-version';
import { issueQuotation, type QuotationLine, type Quotation } from '../../packages/suspended-sales/src/index';
import { APPROVAL_KINDS, fingerprintOf, actionDetails, type ApprovalPort, type ApprovalState } from '../../services/identity/src/approval-requests';
import { quotationsRoutes } from '../../services/pos/src/quotations';
import { ROLE_CATALOGUE, OWNER_ROLE_ID, STORE_MANAGER_ROLE_ID } from '../../services/api/src/roles';
import { ACCOUNTANT_ROLE_ID } from '../../services/api/src/r10a-devices-accountant-adapters';
import { createQuotationsSession, quotationsOutcomeWords, QUOTATIONS_COPY } from '../../apps/web-erp/src/quotations-session';
import { APPROVALS_COPY, presentRequest } from '../../apps/web-erp/src/approvals-session';
import { AccessControl } from '../../packages/rbac/src/rbac';
import { scrapRoutes } from '../../services/finance/src/scrap';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { batchTrackedProductIdsFor } from '../../edge/store-edge/src/screen-data';
import { emptyPack } from '../../edge/store-edge/src/store-pack';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/index';
import { money } from '../../packages/contracts/src/money';
import { rate } from '../../packages/contracts/src/rate';

/**
 * **Round 11 · R11-A (the independent check of rounds 6–10; owner decisions OB-602, OB-603, 28 Oct 2026).**
 *   • OB-504 (gap) — the direct-delivery (DSD) door takes the batch, its expiry and its month of manufacture, and judges a
 *     PACKED product by the same packed-goods rule as every other receiving path: on the handheld offline and at head office.
 *   • OB-501 (gap) — a till on a barred build refuses a quotation number BEFORE the store computer converts it.
 *   • OB-602 — the owner's own quotation BELOW the margin floor is approved by the store's accountant.
 *   • OB-603 / OB-536 / OB-515 — kept as built, now proved: a barred till recalls a held basket; a barred handheld puts away
 *     goods already received; the real role table gives a store manager no way to record scrap.
 * Synthetic data only.
 */

const AT = '2030-06-01T06:00:00.000Z';
const POLICY = { currentVersion: '2.1.0', previousVersion: '2.0.0', minimumSupportedVersion: '2.0.0', killedVersions: ['2.0.3'] };
const OLD = '1.9.9';

// ── OB-504: one packed-goods rule, now also at the DSD door ───────────────────────────────────────────────────────

describe('OB-504: the one packed-goods rule (capture.ts) — every receiving path reads the same verdict', () => {
  it('a packed product needs a readable month of manufacture; a date given must read; an opening load may go without', () => {
    expect(manufactureDateVerdict(true, undefined)).toBe('missing');
    expect(manufactureDateVerdict(true, '  ')).toBe('missing');
    expect(manufactureDateVerdict(true, '2030-05')).toBe('ok');
    expect(manufactureDateVerdict(true, '2030-05-14')).toBe('ok');
    expect(manufactureDateVerdict(true, '2030-13')).toBe('unreadable');
    expect(manufactureDateVerdict(false, '05/2030')).toBe('unreadable');
    expect(manufactureDateVerdict(false, undefined)).toBe('ok');
    expect(manufactureDateVerdict(true, undefined, false)).toBe('ok'); // OB-529: an opening-stock load before GO
  });

  it('the goods receipt and the handheld scan still refuse exactly as before (now through the shared verdict)', () => {
    const rules = [{ productId: 'p-det', batchTracked: false, packaged: true }];
    const ln = { lineId: 'L1', productId: 'p-det', orderedMinor: 1, countedMinor: 1, uom: 'ea', unitCost: money(100, 'INR'), condition: 'good' as const };
    const capture = (extra: Record<string, unknown>) => captureReceipt({ receiptId: 'g', lines: [{ ...ln, ...extra }], rules, policy: { excessToleranceBp: 0, shortageToleranceBp: 0, nearExpiryDays: 7 }, receivedOnDate: '2030-06-01', currency: 'INR' });
    expect(() => capture({})).toThrow(IncompleteCaptureError);
    expect(() => capture({ manufacturedOn: '2030/05' })).toThrow(/cannot be received without a manufacture date it can read/);
    expect(capture({ manufacturedOn: '2030-05' }).lines[0]!.manufacturedOn).toBe('2030-05');
    const scan = (manufacturedOn?: string) => receiveScan({
      command: { commandId: 'c', grnId: 'g', storeId: 'S1', receivedBy: 'u', at: AT, source: 'po', barcode: '890DET', scannedQuantity: 1, ...(manufacturedOn === undefined ? {} : { manufacturedOn }) },
      appliedCommandIds: [], barcodes: [{ barcode: '890DET', productId: 'p-det', level: 'unit' }], packs: [], packagedProductIds: ['p-det'],
    });
    expect(scan().outcome).toBe('manufacture_date_required');
    expect(scan('2030-13').outcome).toBe('manufacture_date_required');
    expect(scan('2030-05').accepted).toBe(true);
  });
});

describe('OB-504: the DSD door judges each scan by that rule and carries the batch', () => {
  it('a packed scan with no (or an unreadable) month is refused by name; an expiry must be a real date; loose goods need none', () => {
    expect(dsdScanCaptureRefusal({ productId: 'p-det' }, true)?.code).toBe('manufacture_date_required');
    expect(dsdScanCaptureRefusal({ productId: 'p-det', manufacturedOn: '2030-5' }, true)?.code).toBe('manufacture_date_required');
    expect(dsdScanCaptureRefusal({ productId: 'p-det', manufacturedOn: '2030-05' }, true)).toBeUndefined();
    expect(dsdScanCaptureRefusal({ productId: 'p-det', manufacturedOn: '2030-05', expiry: '2031-02-30' }, true)?.code).toBe('expiry_not_readable');
    expect(dsdScanCaptureRefusal({ productId: 'p-brm' }, false)).toBeUndefined();
    expect(isDsdExpiryDate('2031-02-28')).toBe(true);
    expect(isDsdExpiryDate('2031-02-29')).toBe(false);
  });

  it('OB-604 · OB-611: the reconciliation splits a product by batch — hand-backs off the batch they name, receivable from the first, the rest held', () => {
    const scans = [
      { scanId: 's1', productId: 'p-det', quantityMinor: 2, at: AT, batchId: 'B-1', expiry: '2031-01-31', manufacturedOn: '2030-05' },
      { scanId: 's2', productId: 'p-det', quantityMinor: 1, at: AT, batchId: 'B-1', expiry: '2031-01-31', manufacturedOn: '2030-05' },
      { scanId: 's3', productId: 'p-oil', quantityMinor: 3, at: AT, batchId: 'O-1', expiry: '2031-03-31' },
      { scanId: 's4', productId: 'p-oil', quantityMinor: 4, at: AT, batchId: 'O-2', expiry: '2031-04-30' },
      { scanId: 's5', productId: 'p-brm', quantityMinor: 1, at: AT },
    ];
    // OB-611 (owner, 30 Oct 2026): the hand-back names its batch (the handheld asks) — the round-11 "scanned last" rule is gone.
    const handBacks = [{ handBackId: 'h1', productId: 'p-oil', quantityMinor: 1, reason: 'damaged' as const, note: null, at: AT, batch: { batchId: 'O-2', expiry: '2031-04-30', manufacturedOn: null } }];
    const r = reconcileDsd({ against: 'po', expected: [{ productId: 'p-oil', expectedMinor: 5, unitCostMinor: 100 }, { productId: 'p-det', expectedMinor: 3 }, { productId: 'p-brm', expectedMinor: 1 }], scans, handBacks });
    const lineOf = (p: string) => r.lines.find((l) => l.productId === p)!;
    expect(lineOf('p-det').batches).toEqual([{ batchId: 'B-1', expiry: '2031-01-31', manufacturedOn: '2030-05', scannedMinor: 3, handedBackMinor: 0, keptMinor: 3, receivableMinor: 3, heldMinor: 0 }]);
    // Oil: 7 came off the van in two batches; 1 handed back (off O-2, as the hand-back names); 6 kept; the order wants 5 — O-1's 3 and
    // 2 of O-2 are received; O-2's last 1 is held for a second person. The parts add up to the line.
    expect(lineOf('p-oil')).toMatchObject({ scannedMinor: 7, handedBackMinor: 1, keptMinor: 6, receivableMinor: 5, heldMinor: 1 });
    expect(lineOf('p-oil').batches).toEqual([
      { batchId: 'O-1', expiry: '2031-03-31', manufacturedOn: null, scannedMinor: 3, handedBackMinor: 0, keptMinor: 3, receivableMinor: 3, heldMinor: 0 },
      { batchId: 'O-2', expiry: '2031-04-30', manufacturedOn: null, scannedMinor: 4, handedBackMinor: 1, keptMinor: 3, receivableMinor: 2, heldMinor: 1 },
    ]);
    // The excess is against the order (it names products, not batches): one discrepancy per product.
    expect(r.discrepancies.filter((d) => d.productId === 'p-oil')).toEqual([expect.objectContaining({ kind: 'over', differenceMinor: 2 })]);
    expect('batches' in lineOf('p-brm')).toBe(false); // no batch facts: the line is as it always was
    // The batch key is the batch's own facts — never the scan order.
    expect(dsdBatchKey({ batchId: 'O-2', expiry: '2031-04-30', manufacturedOn: null })).toBe('O-2~2031-04-30~');
    const reordered = reconcileDsd({ against: 'po', expected: [], scans: [...scans].reverse(), handBacks: [] });
    expect(reordered.lines.find((l) => l.productId === 'p-oil')!.batches!.map((b) => dsdBatchKey(b)).sort()).toEqual(['O-1~2031-03-31~', 'O-2~2031-04-30~']);
  });

  it('OB-605: a batch-tracked scan needs its batch and expiry — the goods receipt\'s own rule, one verdict for both', () => {
    expect(batchTrackedVerdict(true, undefined, '2031-01-31')).toBe('batch_missing');
    expect(batchTrackedVerdict(true, 'B-1', ' ')).toBe('expiry_missing');
    expect(batchTrackedVerdict(true, 'B-1', '2031-01-31')).toBe('ok');
    expect(batchTrackedVerdict(false, undefined, undefined)).toBe('ok');
    expect(dsdScanCaptureRefusal({ productId: 'p-milk' }, false, true)?.code).toBe('batch_required');
    expect(dsdScanCaptureRefusal({ productId: 'p-milk', batchId: 'M-1' }, false, true)?.code).toBe('expiry_required');
    expect(dsdScanCaptureRefusal({ productId: 'p-milk', batchId: 'M-1', expiry: '2031-01-31' }, false, true)).toBeUndefined();
    expect(dsdScanCaptureRefusal({ productId: 'p-milk', batchId: 'M-1', expiry: '2031-01-31' }, true, true)?.code).toBe('manufacture_date_required');
    // The goods receipt still refuses the same line with the same words.
    const ln = { lineId: 'L1', productId: 'p-milk', orderedMinor: 1, countedMinor: 1, uom: 'ea', unitCost: money(100, 'INR'), condition: 'good' as const };
    const capture = (extra: Record<string, unknown>) => () => captureReceipt({ receiptId: 'g', lines: [{ ...ln, ...extra }], rules: [{ productId: 'p-milk', batchTracked: true }], policy: { excessToleranceBp: 0, shortageToleranceBp: 0, nearExpiryDays: 7 }, receivedOnDate: '2030-06-01', currency: 'INR' });
    expect(capture({})).toThrow(/a batch number \(the item is batch-tracked\)/);
    expect(capture({ batchId: 'M-1' })).toThrow(/an expiry date \(the item is batch-tracked\)/);
  });

  it('OB-605: the store computer tells the handheld which products are batch-tracked, from its catalogue', () => {
    const signed = { snapshot: { tenantId: 't', version: 1, builtAt: AT, barcodes: [], products: [
      { productId: 'p-milk', sku: 'M', name: 'Milk', baseUom: 'ea', unitPriceMinor: 100, taxBps: 0, status: 'active', batchTracked: true },
      { productId: 'p-brm', sku: 'B', name: 'Broom', baseUom: 'ea', unitPriceMinor: 100, taxBps: 0, status: 'active' },
    ] } };
    expect(batchTrackedProductIdsFor({ pack: emptyPack('x'), cataloguePack: signed, now: AT } as never)).toEqual({ batchTrackedProductIds: ['p-milk'] });
    expect(batchTrackedProductIdsFor({ pack: emptyPack('x'), now: AT } as never)).toEqual({});
    expect(readFileSync('edge/store-edge/src/screen-data.ts', 'utf8')).toMatch(/\.\.\.batchTrackedProductIdsFor\(input\)/);
  });

  const door = (packed: readonly string[] | undefined, outbox = new SyncOutbox()) => {
    const s = new DsdDoorSession({
      workerId: 'u-recv', storeId: 'S-A', barcodes: [{ barcode: '890DET', productId: 'p-det', level: 'unit' }, { barcode: '890BRM', productId: 'p-brm', level: 'unit' }] as never,
      openDeliveries: [{ poId: 'po-1', number: 'PO-1', supplierId: 'sup-1', ordered: [{ productId: 'p-det', quantityMinor: 2, unitCost: { minor: 100 } }, { productId: 'p-brm', quantityMinor: 1, unitCost: { minor: 50 } }] }],
      ...(packed === undefined ? {} : { packedProductIds: packed }),
    }, outbox, () => AT);
    s.start({ checkInId: 'D-1', poId: 'po-1', driverName: 'Ravi' });
    return s;
  };

  it('on the handheld, offline: a packed scan without its month is refused and kept off the delivery; with it, scanned', () => {
    const s = door(['p-det']);
    const refused = s.scan('sc-1', '890DET');
    expect(refused).toMatchObject({ feedback: 'reject', code: 'manufacture_date_required' });
    expect(s.view()!.lines.find((l) => l.productId === 'p-det')!.scannedMinor).toBe(0);
    expect(s.scan('sc-2', '890DET', { batchId: 'B-1', expiry: '2031-01-31', manufacturedOn: '2030-13' }).code).toBe('manufacture_date_required');
    expect(s.scan('sc-3', '890DET', { batchId: 'B-1', expiry: '31-01-2031', manufacturedOn: '2030-05' }).code).toBe('expiry_not_readable');
    expect(s.scan('sc-4', '890DET', { batchId: 'B-1', expiry: '2031-01-31', manufacturedOn: '2030-05' }).code).toBe('dsd_scanned');
    expect(s.scan('sc-5', '890BRM').code).toBe('dsd_scanned'); // a loose broom needs no month
    expect(DSD_FEEDBACK_CODES).toEqual(expect.arrayContaining(['manufacture_date_required', 'expiry_not_readable']));
  });

  it('the one record queued at close carries each scan\'s batch, expiry and month of manufacture', () => {
    const outbox = new SyncOutbox();
    const s = door(['p-det'], outbox);
    s.scan('sc-1', '890DET', { batchId: 'B-1', expiry: '2031-01-31', manufacturedOn: '2030-05' });
    expect(s.close({ noteRef: 'N-1', driverSignedName: 'Ravi' }).code).toBe('dsd_closed');
    const [queued] = outbox.all();
    expect(queued!.event.type).toBe(DSD_CHECK_IN_CLOSED);
    expect((queued!.event.payload as { scans: unknown[] }).scans).toEqual([{ scanId: 'sc-1', productId: 'p-det', quantityMinor: 1, at: AT, batchId: 'B-1', expiry: '2031-01-31', manufacturedOn: '2030-05' }]);
  });

  it('OB-605 on the handheld, offline: a batch-tracked scan without its batch or expiry is refused and kept off the delivery', () => {
    const s = new DsdDoorSession({
      workerId: 'u-recv', storeId: 'S-A', barcodes: [{ barcode: '890MILK', productId: 'p-milk', level: 'unit' }] as never, batchTrackedProductIds: ['p-milk'],
      openDeliveries: [{ poId: 'po-1', number: 'PO-1', supplierId: 'sup-1', ordered: [{ productId: 'p-milk', quantityMinor: 2, unitCost: { minor: 100 } }] }],
    }, new SyncOutbox(), () => AT);
    s.start({ checkInId: 'D-1', poId: 'po-1', driverName: 'Ravi' });
    expect(s.scan('a', '890MILK')).toMatchObject({ feedback: 'reject', code: 'batch_required' });
    expect(s.scan('b', '890MILK', { batchId: 'M-1' })).toMatchObject({ feedback: 'reject', code: 'expiry_required' });
    expect(s.view()!.lines[0]!.scannedMinor).toBe(0);
    expect(s.scan('c', '890MILK', { batchId: 'M-1', expiry: '2030-06-05' }).code).toBe('dsd_scanned');
    expect(DSD_FEEDBACK_CODES).toEqual(expect.arrayContaining(['batch_required', 'expiry_required']));
  });

  it('a handheld the store computer has not told which goods are packed takes the scan; head office still judges it', () => {
    expect(door(undefined).scan('sc-1', '890DET').code).toBe('dsd_scanned');
  });

  it('the door sheet has the three buttons with icons, and the words for each refusal in English and Tamil', () => {
    const html = readFileSync('apps/warehouse-app/web/index.html', 'utf8');
    for (const id of ['dsd-batch', 'dsd-expiry', 'dsd-mfg']) expect(html).toContain(`id="${id}"`);
    const js = readFileSync('apps/warehouse-app/web/app.js', 'utf8');
    const words = js.slice(js.indexOf('const DSD_WORDS'), js.indexOf('const dt = '));
    for (const k of ['manufacture_date_required', 'expiry_not_readable', 'batch_required', 'expiry_required', 'dsdBatch', 'dsdExpiry', 'dsdMfg', 'needExpiry']) expect(words.split(new RegExp(`(?<![\\w])${k}:`)).length - 1, k).toBe(2);
    expect(js).toMatch(/say\(el\('dsd-batch'\), .*'barcode'\)/);
    expect(js).toMatch(/say\(el\('dsd-mfg'\), .*'calendar'\)/);
    expect(js).toMatch(/dsd\.scan\(nextId\('dsd-scan'\), code, \{/);
  });
});

describe('OB-504 at head office: the door routes read the product master\'s packed rule', () => {
  const ORDER: DsdOrderView = { poId: 'po-1', supplierId: 'sup-1', deliverToLocationId: 'S-A', status: 'issued', lines: [{ productId: 'p-det', expectedMinor: 5, unitCostMinor: 100, uom: 'ea' }, { productId: 'p-brm', expectedMinor: 5, unitCostMinor: 50, uom: 'ea' }, { productId: 'p-milk', expectedMinor: 5, unitCostMinor: 30, uom: 'ea' }] };
  const make = (withRule = true) => {
    const recs = new Map<string, DsdCheckInRecord>();
    const movements: Movement[] = [];
    const deps: DsdCheckInDeps = {
      now: () => AT, routeSheet: async () => undefined, routeSheets: async () => [], recordRouteSheet: async () => {},
      order: async (_t, id) => (id === 'po-1' ? ORDER : undefined), supplierActive: async () => true,
      checkIn: async (_t, id) => recs.get(id), checkIns: async () => [...recs.values()],
      recordCheckIn: async (_t, r) => { recs.set(r.checkInId, r); }, appendMovement: async (_t, m) => { movements.push(m); },
      permissionsOfUser: async () => ['inventory.dsd.checkin'],
      ...(withRule ? { productRule: (_t: string, p: string) => (p === 'p-det' ? { productId: p, batchTracked: false, packaged: true } : { productId: p, batchTracked: p === 'p-milk' }) } : {}),
    };
    const routes = dsdCheckInRoutes(deps);
    const call = async (path: string, params: Record<string, string>, body: unknown, userId = 'u-recv') => {
      const route = routes.find((r) => r.method === 'POST' && r.path === path)!;
      try {
        const out = await route.handler({ tenantId: 't', userId, params, body, query: {}, scope: 'all' } as never);
        return { status: out.status, body: out.body as Record<string, unknown> };
      } catch (e) {
        return { status: (e as { status?: number }).status, code: (e as { body?: { code?: string } }).body?.code, next: (e as { body?: { nextSafeAction?: string } }).body?.nextSafeAction };
      }
    };
    return { recs, movements, call };
  };
  const open = { supplierId: 'sup-1', storeId: 'S-A', poId: 'po-1', driverName: 'Ravi', arrivedAt: AT };

  it('a direct scan of a packed product with no month is refused 422, nothing saved; with it, the batch reaches the movement', async () => {
    const { recs, movements, call } = make();
    expect((await call('/v1/inventory/dsd-checkins/:checkInId', { checkInId: 'c-1' }, open)).status).toBe(201);
    const refused = await call('/v1/inventory/dsd-checkins/:checkInId/scans/:scanId', { checkInId: 'c-1', scanId: 's1' }, { productId: 'p-det', quantityMinor: 2 });
    expect(refused).toMatchObject({ status: 422, code: 'manufacture_date_required' });
    expect(recs.get('c-1')!.scans).toEqual([]);
    expect((await call('/v1/inventory/dsd-checkins/:checkInId/scans/:scanId', { checkInId: 'c-1', scanId: 's1' }, { productId: 'p-det', quantityMinor: 2, manufacturedOn: '2030-5' })).code).toBe('manufacture_date_required');
    expect((await call('/v1/inventory/dsd-checkins/:checkInId/scans/:scanId', { checkInId: 'c-1', scanId: 's1' }, { productId: 'p-det', quantityMinor: 2, manufacturedOn: 2030 })).status).toBe(400);
    expect((await call('/v1/inventory/dsd-checkins/:checkInId/scans/:scanId', { checkInId: 'c-1', scanId: 's1' }, { productId: 'p-det', quantityMinor: 2, batchId: 'B-1', expiry: '2031-01-31', manufacturedOn: '2030-05' })).status).toBe(201);
    expect((await call('/v1/inventory/dsd-checkins/:checkInId/scans/:scanId', { checkInId: 'c-1', scanId: 's2' }, { productId: 'p-brm', quantityMinor: 1 })).status).toBe(201);
    expect((await call('/v1/inventory/dsd-checkins/:checkInId/close', { checkInId: 'c-1' }, { deliveryNote: { noteRef: 'N', driverSignedName: 'Ravi' } })).status).toBe(200);
    expect(movements.find((m) => m.productId === 'p-det')).toMatchObject({ movementId: 'dsd:c-1:p-det:batch:B-1~2031-01-31~2030-05', batchId: 'B-1', expiry: '2031-01-31', quantityMinor: 2 });
    expect(movements.find((m) => m.productId === 'p-brm')!.movementId).toBe('dsd:c-1:p-brm'); // no batch named: as before
    expect(movements.find((m) => m.productId === 'p-brm')!.batchId).toBeUndefined();
    expect(recs.get('c-1')!.scans[0]).toMatchObject({ manufacturedOn: '2030-05' });
  });

  it('the relayed handheld record is refused 422 (the box keeps it for a person) — nothing recorded, nothing posted', async () => {
    const { recs, movements, call } = make();
    const relayed = { ...open, checkInId: 'c-2', receivedBy: 'u-recv', scans: [{ scanId: 'x1', productId: 'p-det', quantityMinor: 2, at: AT }], handBacks: [], deliveryNote: { noteRef: 'N', driverSignedName: 'Ravi' }, at: AT };
    const refused = await call('/v1/inventory/dsd-checkins/:checkInId/synced', { checkInId: 'c-2' }, relayed, 'u-box');
    expect(refused).toMatchObject({ status: 422, code: 'manufacture_date_required' });
    expect(refused.next).toContain('stays on the store computer');
    expect(recs.size).toBe(0);
    expect(movements).toEqual([]);
    const ok = await call('/v1/inventory/dsd-checkins/:checkInId/synced', { checkInId: 'c-2' }, { ...relayed, scans: [{ scanId: 'x1', productId: 'p-det', quantityMinor: 2, at: AT, batchId: 'B-7', manufacturedOn: '2030-04' }] }, 'u-box');
    expect(ok.status).toBe(201);
    expect(movements[0]).toMatchObject({ productId: 'p-det', batchId: 'B-7' });
  });

  it('OB-604: one product in two batches → one received movement per batch; the held excess is its batch\'s, approved as its own movement; ids never change', async () => {
    const { recs, movements, call } = make();
    const relayed = { ...open, checkInId: 'c-3', receivedBy: 'u-recv', handBacks: [{ handBackId: 'h1', productId: 'p-det', quantityMinor: 1, reason: 'damaged', at: AT, batch: { batchId: 'B-2', expiry: '2032-02-29', manufacturedOn: '2030-05' } }], deliveryNote: { noteRef: 'N', driverSignedName: 'Ravi' }, at: AT,
      scans: [{ scanId: 'x1', productId: 'p-det', quantityMinor: 3, at: AT, batchId: 'B-1', expiry: '2032-01-31', manufacturedOn: '2030-04' }, { scanId: 'x2', productId: 'p-det', quantityMinor: 4, at: AT, batchId: 'B-2', expiry: '2032-02-29', manufacturedOn: '2030-05' }] };
    expect((await call('/v1/inventory/dsd-checkins/:checkInId/synced', { checkInId: 'c-3' }, relayed, 'u-box')).status).toBe(201);
    const rec = recs.get('c-3')!;
    expect(rec.flags as readonly string[]).not.toContain('several_batches');
    const id1 = dsdMovementId('c-3', 'p-det', { batched: true, batchId: 'B-1', expiry: '2032-01-31', manufacturedOn: '2030-04' });
    const id2 = dsdMovementId('c-3', 'p-det', { batched: true, batchId: 'B-2', expiry: '2032-02-29', manufacturedOn: '2030-05' });
    expect(movements.map((m) => [m.movementId, m.batchId, m.expiry, m.quantityMinor])).toEqual([[id1, 'B-1', '2032-01-31', 3], [id2, 'B-2', '2032-02-29', 2]]);
    expect(rec.held).toMatchObject({ state: 'pending', lines: [{ productId: 'p-det', quantityMinor: 1, batchId: 'B-2', expiry: '2032-02-29', manufacturedOn: '2030-05' }] });
    expect((await call('/v1/inventory/dsd-checkins/:checkInId/held/decide', { checkInId: 'c-3' }, { decision: 'approved', reason: 'we stock it' }, 'u-mgr2')).status).toBe(200);
    expect(movements[2]).toMatchObject({ movementId: 'dsd:c-3:p-det:held:batch:B-2~2032-02-29~2030-05', batchId: 'B-2', expiry: '2032-02-29', quantityMinor: 1, approvedBy: 'u-mgr2' });
    // A replay of the same record changes nothing (already recorded); the decision again is the same decision.
    expect((await call('/v1/inventory/dsd-checkins/:checkInId/synced', { checkInId: 'c-3' }, relayed, 'u-box')).body).toMatchObject({ alreadyRecorded: true });
    expect((await call('/v1/inventory/dsd-checkins/:checkInId/held/decide', { checkInId: 'c-3' }, { decision: 'approved', reason: 'we stock it' }, 'u-mgr2')).body).toMatchObject({ alreadyDecided: true });
    expect(movements).toHaveLength(3);
  });

  it('OB-605 at head office: a batch-tracked scan with no batch or no expiry is refused 422 by name — direct and relayed', async () => {
    const { recs, movements, call } = make();
    await call('/v1/inventory/dsd-checkins/:checkInId', { checkInId: 'c-1' }, open);
    const scan = (body: Record<string, unknown>) => call('/v1/inventory/dsd-checkins/:checkInId/scans/:scanId', { checkInId: 'c-1', scanId: 'm1' }, { productId: 'p-milk', quantityMinor: 2, ...body });
    expect(await scan({})).toMatchObject({ status: 422, code: 'batch_required' });
    expect(await scan({ batchId: 'M-1' })).toMatchObject({ status: 422, code: 'expiry_required' });
    expect(recs.get('c-1')!.scans).toEqual([]);
    expect((await scan({ batchId: 'M-1', expiry: '2030-06-05' })).status).toBe(201);
    const relayed = { ...open, checkInId: 'c-9', receivedBy: 'u-recv', handBacks: [], deliveryNote: { noteRef: 'N', driverSignedName: 'Ravi' }, at: AT, scans: [{ scanId: 'y1', productId: 'p-milk', quantityMinor: 1, at: AT, batchId: 'M-2' }] };
    const refused = await call('/v1/inventory/dsd-checkins/:checkInId/synced', { checkInId: 'c-9' }, relayed, 'u-box');
    expect(refused).toMatchObject({ status: 422, code: 'expiry_required' });
    expect(refused.next).toContain('OB-605');
    expect(recs.has('c-9')).toBe(false);
    expect(movements).toEqual([]);
  });

  it('with no product master wired the door is not judged (as before) — the running API wires it (r11a-check-gaps-adapters.ts)', async () => {
    const { call } = make(false);
    await call('/v1/inventory/dsd-checkins/:checkInId', { checkInId: 'c-1' }, open);
    expect((await call('/v1/inventory/dsd-checkins/:checkInId/scans/:scanId', { checkInId: 'c-1', scanId: 's1' }, { productId: 'p-det', quantityMinor: 2 })).status).toBe(201);
    expect(readFileSync('services/api/src/r3-ops-adapters.ts', 'utf8')).toMatch(/\.\.\.r11aDsdHooks\(base\)/);
  });
});

// ── OB-501: a barred till refuses a quotation before the box converts it ─────────────────────────────────────────

describe('OB-501: a till on a barred build refuses a quotation number BEFORE the store computer converts it', () => {
  const words = judgeClientVersion(OLD, POLICY, 'till').words!;
  const ops = (bar: { en: string; ta: string } | null): QuotationTillOps => ({
    signedIn: () => true, basketInProgress: () => false, committed: () => false, hasCatalogue: () => true, newSale: () => {}, billRef: () => 'B-1',
    scanBarcode: () => ({ lineId: 'L1', description: 'Rice', qty: 1 }), setQuantity: () => {}, unitPriceOf: () => 100, lowerPrice: () => {}, raisePrice: () => {}, packOf: () => undefined,
    newBillBar: () => bar,
  });
  const port = (calls: string[]): QuotationsLanePort => ({ convert: async (i) => { calls.push(i.quotationNumber); return { converted: true, quotationId: i.quotationNumber, lines: [], laneMessage: '' }; } });

  it('barred: refused in English and Tamil, the store computer is never asked; lifted: converted as before', async () => {
    const calls: string[] = [];
    const barred = await quotationAtTill({ port: port(calls), ops: ops(words), barcodeOf: () => undefined })('48151623');
    expect(barred).toMatchObject({ ok: false, refusedBecause: 'app_version_too_old' });
    expect(barred.laneMessage).toContain(words.en);
    expect(barred.laneMessage).toContain('The quotation was not used');
    expect(barred.laneMessageTa).toContain(words.ta);
    expect(calls).toEqual([]);
    expect((await quotationAtTill({ port: port(calls), ops: ops(null), barcodeOf: () => undefined })('48151623')).ok).toBe(true);
    expect(calls).toEqual(['48151623']);
  });

  it('the served till passes its own version verdict to the quotation step, at boot and when the policy changes', async () => {
    const calls: string[] = [];
    const till = bootPos({ laneId: 'lane-1', cashierId: 'u-cash', taxPercent: 0, appVersion: OLD, appVersionPolicy: POLICY, quotationsPort: port(calls) });
    const refused = await till.ringQuotationAtTill('48151623');
    expect(refused).toMatchObject({ ok: false, refusedBecause: 'app_version_too_old' });
    expect(calls).toEqual([]);
    till.applyVersionPolicy({ ...POLICY, minimumSupportedVersion: '1.0.0', previousVersion: '1.0.0' });
    expect((await till.ringQuotationAtTill('48151623')).refusedBecause).not.toBe('app_version_too_old');
  });
});

// ── OB-602: the owner's own below-floor quotation — the accountant approves ──────────────────────────────────────

const qline = (over: Partial<QuotationLine> = {}): QuotationLine => ({ lineId: 'l1', productId: 'p-rice', description: 'Ponni rice 25 kg', unitPriceMinor: 1_300_00, quantityMinor: 2, uom: 'ea', taxBps: 500, ...over });
const qbase = { quotationId: 'Q9', tenantId: 't', storeId: 'store-1', customerRef: 'Murugan Stores', currency: 'INR', issuedBy: 'u-owner', issuedAt: AT, validUntil: '2030-06-30', lineFloorsMinor: { 'p-rice': 1_400_00 } };
const acct = { subjectRef: 'Q9', status: 'approved' as const, decidedBy: 'u-acct', reason: 'ok', byAccountant: true };

describe('OB-602: the OWNER\'s own quotation below the margin floor is approved by the ACCOUNTANT', () => {
  it('the owner quoting below the floor: refused without the accountant\'s approval — an owner\'s or a plain approval does not count', () => {
    const r = issueQuotation({ ...qbase, lines: [qline()], quoterIsOwner: true });
    expect(r).toMatchObject({ issued: false, outcome: 'below_floor_owner_quoted_unapproved' });
    expect(r.detail).toContain('only the accountant may approve');
    expect(issueQuotation({ ...qbase, lines: [qline()], quoterIsOwner: true, approval: { subjectRef: 'Q9', status: 'approved', decidedBy: 'u-owner2', reason: 'ok', byOwner: true } }).outcome).toBe('below_floor_owner_quoted_unapproved');
    expect(issueQuotation({ ...qbase, lines: [qline()], quoterIsOwner: true, approval: { ...acct, subjectRef: 'Q-other' } }).outcome).toBe('below_floor_owner_quoted_unapproved');
  });

  it('the accountant\'s approval for exactly it lets it through; the quoter never approves his own', () => {
    expect(issueQuotation({ ...qbase, lines: [qline()], quoterIsOwner: true, approval: acct })).toMatchObject({ issued: true, quotation: { marginApprovedBy: 'u-acct' } });
    expect(issueQuotation({ ...qbase, lines: [qline()], quoterIsOwner: true, approval: { ...acct, decidedBy: 'u-owner' } })).toMatchObject({ issued: false, outcome: 'self_approved' });
  });

  it('anyone else quoting below the floor is unchanged (a second person; the route asks for the owner\'s word)', () => {
    expect(issueQuotation({ ...qbase, issuedBy: 'u-mgr', lines: [qline()] }).outcome).toBe('below_floor_unapproved');
    expect(issueQuotation({ ...qbase, issuedBy: 'u-mgr', lines: [qline()], approval: { subjectRef: 'Q9', status: 'approved', decidedBy: 'u-owner', reason: 'ok' } }).issued).toBe(true);
    // At or above the floor the owner needs nobody.
    expect(issueQuotation({ ...qbase, lines: [qline({ unitPriceMinor: 1_420_00 })], quoterIsOwner: true }).issued).toBe(true);
  });

  it('the engine knows the accountant\'s kind; only the accountant (and the owner, to grant it) hold its checker word', () => {
    expect(APPROVAL_KINDS['quotation_below_floor_owner_quoted']).toMatchObject({ makerPermission: 'pos.quotation.write', checkerPermission: 'pos.quotation.belowfloor.ownerquote.approve' });
    expect(ROLE_CATALOGUE.filter((r) => r.permissions.includes('pos.quotation.belowfloor.ownerquote.approve')).map((r) => r.id).sort()).toEqual([ACCOUNTANT_ROLE_ID, OWNER_ROLE_ID].sort());
    // Anyone else's below-floor quotation still needs `price.change.approve` — the accountant was given none of it.
    expect(APPROVAL_KINDS['quotation_below_floor']!.checkerPermission).toBe('price.change.approve');
    expect(ROLE_CATALOGUE.find((r) => r.id === ACCOUNTANT_ROLE_ID)!.permissions).not.toContain('price.change.approve');
    expect(APPROVALS_COPY.en.kindQuotationBelowFloorOwnerQuoted).toContain('accountant approves');
    expect(APPROVALS_COPY.ta.kindQuotationBelowFloorOwnerQuoted).not.toBe(APPROVALS_COPY.en.kindQuotationBelowFloorOwnerQuoted);
    const view = { requestId: 'areq-8', kind: 'quotation_below_floor_owner_quoted', label: '', subjectRef: 'Q9', valueMinor: null, details: {}, summary: 's', reason: 'r', requestedBy: 'u-owner', requestedAt: AT, status: 'waiting' as const };
    expect(presentRequest('ta', view as never).label).toBe(APPROVALS_COPY.ta.kindQuotationBelowFloorOwnerQuoted);
    expect(presentRequest('en', view as never).label).toBe(APPROVALS_COPY.en.kindQuotationBelowFloorOwnerQuoted);
  });
});

describe('OB-602 at head office\'s issue route: the quoter\'s owner role and the decider\'s accountant role are head office\'s own', () => {
  const body = { storeId: 'store-1', customerRef: 'Murugan Stores', currency: 'INR', validUntil: '2099-12-31', lines: [{ lineId: 'l1', productId: 'p-rice', description: 'Ponni rice 25 kg', unitPriceMinor: 1_300_00, quantityMinor: 2, uom: 'ea', taxBps: 500 }] };
  const run = async (o: { quoter: string; decidedBy: string; kind: string; owners: readonly string[]; accountants: readonly string[] }) => {
    const recorded: Quotation[] = [];
    let spent = 0;
    const state: ApprovalState = {
      request: { requestId: 'areq-1', kind: o.kind, subjectRef: 'Q9', valueMinor: null, fingerprint: fingerprintOf(actionDetails(body, { quotationId: 'Q9' })), details: {}, summary: 's', reason: 'r', requestedBy: o.quoter, requestedAt: '2030-06-01T05:00:00.000Z' },
      decision: { requestId: 'areq-1', decision: 'approved', decidedBy: o.decidedBy, reason: 'ok', decidedAt: '2030-06-01T05:30:00.000Z', expiresAt: '2030-06-02T05:30:00.000Z' },
    };
    const approvals: ApprovalPort = {
      approvalState: () => state, approvalVersion: () => 1, spendApproval: () => { spent += 1; return true; },
      permissionsOfUser: () => ['price.change.approve', 'pos.quotation.belowfloor.ownerquote.approve'],
    };
    const route = quotationsRoutes({
      quotations: () => recorded, record: (_t, q) => { recorded.push(q); }, approvals, now: () => AT,
      floorsAt: async () => ({ floors: { 'p-rice': 1_400_00 }, notKnown: [] }), ownersAt: async () => o.owners, accountantsAt: async () => o.accountants,
    }).find((r) => r.method === 'POST' && r.path === '/v1/pos/quotations/:quotationId')!;
    try {
      const out = await route.handler({ tenantId: 't', userId: o.quoter, params: { quotationId: 'Q9' }, body: { ...body, approvalId: 'areq-1' }, query: {} } as never);
      return { status: out.status, recorded: recorded.length, spent, by: recorded[0]?.marginApprovedBy };
    } catch (e) {
      return { status: (e as { status?: number }).status, code: (e as { body?: { code?: string } }).body?.code, next: (e as { body?: { nextSafeAction?: string } }).body?.nextSafeAction, recorded: recorded.length, spent };
    }
  };
  const OWNER_BELOW = 'quotation_below_floor_owner_quoted';

  it('the owner quotes below the floor; this store\'s accountant approved it under the accountant\'s kind → made, spent once', async () => {
    expect(await run({ quoter: 'u-owner', decidedBy: 'u-acct', kind: OWNER_BELOW, owners: ['u-owner'], accountants: ['u-acct'] })).toEqual({ status: 201, recorded: 1, spent: 1, by: 'u-acct' });
  });

  it('refused, nothing spent: an accountant of another store; another owner under the accountant\'s kind; the plain kind for his own', async () => {
    expect(await run({ quoter: 'u-owner', decidedBy: 'u-acct-s2', kind: OWNER_BELOW, owners: ['u-owner'], accountants: ['u-acct'] }))
      .toMatchObject({ status: 422, code: 'quotation_below_floor_owner_quoted_unapproved', recorded: 0, spent: 0 });
    expect(await run({ quoter: 'u-owner', decidedBy: 'u-owner2', kind: OWNER_BELOW, owners: ['u-owner', 'u-owner2'], accountants: ['u-acct'] }))
      .toMatchObject({ status: 422, code: 'quotation_below_floor_owner_quoted_unapproved', recorded: 0, spent: 0 });
    expect(await run({ quoter: 'u-owner', decidedBy: 'u-owner2', kind: 'quotation_below_floor', owners: ['u-owner', 'u-owner2'], accountants: ['u-acct'] }))
      .toMatchObject({ status: 422, code: 'approval_does_not_match', recorded: 0, spent: 0 });
  });

  it('the refusal tells the owner to ask the ACCOUNTANT, by kind', async () => {
    expect(await run({ quoter: 'u-owner', decidedBy: 'u-acct-s2', kind: OWNER_BELOW, owners: ['u-owner'], accountants: ['u-acct'] })).toMatchObject({ next: expect.stringContaining('kind quotation_below_floor_owner_quoted') });
  });

  it('a store manager quoting below the floor is unchanged: approved under the plain kind; the accountant\'s kind does not match', async () => {
    expect(await run({ quoter: 'u-mgr', decidedBy: 'u-owner', kind: 'quotation_below_floor', owners: ['u-owner'], accountants: ['u-acct'] })).toEqual({ status: 201, recorded: 1, spent: 1, by: 'u-owner' });
    expect(await run({ quoter: 'u-mgr', decidedBy: 'u-acct', kind: OWNER_BELOW, owners: ['u-owner'], accountants: ['u-acct'] })).toMatchObject({ status: 422, code: 'approval_does_not_match', recorded: 0, spent: 0 });
  });
});

describe('OB-602 on the Quotations page: the owner\'s own below-floor quotation offers to ask the ACCOUNTANT', () => {
  it('keeps the number and lines, asks with the accountant\'s below-floor kind, and says so in English and Tamil', async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? 'GET';
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown;
      calls.push({ url, method, body });
      const reply = url === '/v1/approvals/requests'
        ? { status: 201, body: { requestId: 'areq-8', kind: 'quotation_below_floor_owner_quoted', status: 'waiting' } }
        : { status: 422, body: { error: { code: 'quotation_below_floor_owner_quoted_unapproved', whatHappened: 'only the accountant may approve', wasItSaved: 'not_saved', nextSafeAction: 'ask' } } };
      return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
    }) as typeof globalThis.fetch;
    const s = createQuotationsSession({ viewer: { userId: 'u-owner', permissions: ['pos.quotation.read', 'pos.quotation.write'] }, fetch, newNumber: () => '16180339', now: () => AT });
    const lines = [{ productId: 'p-rice', description: 'Ponni rice 25 kg', quantity: 2, unitPriceMinor: 1_300_00, uom: 'ea', taxBps: 500 }];
    expect((await s.make({ storeId: 'store-1', customerRef: 'Murugan Stores', validUntil: '2030-06-30', approvalId: '', lines })).result).toBe('refused');
    expect(s.belowFloor()).toBe('16180339');
    expect(s.needsAccountant()).toBe(true);
    expect(s.needsOwner()).toBe(false);
    const asked = await s.askApproval();
    expect(calls[1]).toMatchObject({ method: 'POST', url: '/v1/approvals/requests', body: { kind: 'quotation_below_floor_owner_quoted', subjectRef: '16180339', valueMinor: null, reason: QUOTATIONS_COPY.en.belowFloorOwnerReason } });
    expect((calls[1]!.body as { details: Record<string, unknown> }).details).toEqual({ ...(calls[0]!.body as Record<string, unknown>), quotationId: '16180339' });
    expect(quotationsOutcomeWords('en', asked)).toBe(`${QUOTATIONS_COPY.en.askedAccountantBelow} areq-8`);
    expect(quotationsOutcomeWords('ta', asked)).toBe(`${QUOTATIONS_COPY.ta.askedAccountantBelow} areq-8`);
    expect(QUOTATIONS_COPY.ta.askedAccountantBelow).not.toBe(QUOTATIONS_COPY.en.askedAccountantBelow);
  });
});

// ── OB-603, OB-536, OB-515: kept as built — now proved ──────────────────────────────────────────────────────────

describe('OB-603 (keep): recalling a held basket on a barred till is finishing a bill in progress — allowed', () => {
  const words = judgeClientVersion(OLD, POLICY, 'till').words!;
  it('the session: a barred till takes the held basket back, rings more onto it, and still refuses a NEW bill', () => {
    const s = new PosSession({ laneId: 'lane-1', cashierId: 'u-cash', currency: 'INR', defaultTaxRate: rate(500), clock: () => AT, appVersion: OLD }, new Ledger(new InMemoryLedgerStore()), new SyncOutbox(),
      async () => ({ committed: true, durable: true, detail: 'ok', laneMessage: 'Saved.' }));
    s.barNewBills(words);
    s.restoreHeld([{ lineId: 'L1', productId: 'p-rice', description: 'Rice', unitPriceMinor: 10_000, quantityMinor: 1, uom: 'ea', taxBps: 500, voided: false }] as never);
    expect(s.basket()).toHaveLength(1);
    s.scan({ productId: 'p-dal', description: 'Dal', unitPrice: money(5_000, 'INR'), quantityMinor: 1, uom: 'ea' });
    expect(s.basket()).toHaveLength(2);
    s.newSale();
    expect(() => s.scan({ productId: 'p-dal', description: 'Dal', unitPrice: money(5_000, 'INR'), quantityMinor: 1, uom: 'ea' })).toThrow(NewBillRefusedError);
  });

  it('the served till: recall through the store computer works on a barred build; the recalled basket can be added to', async () => {
    const held = { billId: 'H-1', laneId: 'lane-1', heldAt: AT, lines: [{ lineId: 'L1', productId: 'p-rice', description: 'Rice', unitPriceMinor: 10_000, quantityMinor: 1, uom: 'ea', taxBps: 0, voided: false }], ageAnswers: [] };
    const till = bootPos({
      laneId: 'lane-1', cashierId: 'u-cash', taxPercent: 0, appVersion: OLD, appVersionPolicy: POLICY,
      heldBillsPort: { hold: async () => ({ held: true }), list: async () => [held as never], recall: async () => ({ recalled: true, bill: held }), abandon: async () => ({ abandoned: true }) },
    });
    expect(() => till.scan({ productId: 'p', description: 'Tea', unitPriceMinor: 1_000, qty: 1 })).toThrow(NewBillRefusedError);
    const recalled = await till.recallAtTill('H-1');
    expect(recalled.ok).toBe(true);
    expect(till.basket()).toHaveLength(1);
    till.scan({ productId: 'p', description: 'Tea', unitPriceMinor: 1_000, qty: 1 });
    expect(till.basket()).toHaveLength(2);
  });
});

describe('OB-536 (keep): put-away of goods already received is accepted on a barred build', () => {
  it('received before the bar → put away after it, accepted and queued; a NEW receipt is still refused', () => {
    const outbox = new SyncOutbox();
    const s = new WarehouseSession({
      assignmentId: 'A-1', workerId: 'u-back', storeId: 'S1', grnId: 'g-1',
      bins: [{ binId: 'BIN-A', storeId: 'S1', capacityMinor: 100, pickable: true, zone: 'ambient' }],
      barcodes: [{ barcode: '890DET', productId: 'p-det', level: 'unit' }], packs: [{ productId: 'p-det', baseUom: 'ea', levels: [{ level: 'unit', containsMinor: 1, barcode: '890DET' }] }] as never,
    }, outbox, { now: () => AT });
    expect(s.receive({ commandId: 'c-1', grnId: 'g-1', barcode: '890DET', scannedQuantity: 1, source: 'po' }).result.accepted).toBe(true);
    s.barNewWork(judgeClientVersion(OLD, POLICY, 'warehouse').words!);
    expect(s.receive({ commandId: 'c-2', grnId: 'g-2', barcode: '890DET', scannedQuantity: 1, source: 'po' }).result.outcome).toBe('app_version_too_old');
    const queued = outbox.all().length;
    const put = s.putAway({ commandId: 'mv-1', scannedProductId: 'p-det', scannedBinId: 'BIN-A', batchId: null, quantityMinor: 1, uom: 'EA', at: AT });
    expect(put.result.accepted).toBe(true);
    expect(put.signal.code).not.toBe(APP_VERSION_TOO_OLD);
    expect(outbox.all().length).toBe(queued + 1);
  });
});

describe('OB-515 (keep): the REAL role table — a store manager cannot record scrap', () => {
  it('the scrap route needs `scrap.sale.record`; the store manager role lacks it (reviews only); the owner and accountant hold it', () => {
    const routes = scrapRoutes({ recordScrapSale: async () => {}, scrapSales: async () => [], now: () => AT } as never);
    const record = routes.filter((r) => r.method === 'POST').map((r) => r.permission);
    expect(record).toEqual(['scrap.sale.record', 'scrap.sale.record']);
    const access = new AccessControl(ROLE_CATALOGUE, [
      { userId: 'u-mgr', roleId: STORE_MANAGER_ROLE_ID, branchScope: ['store-1'] },
      { userId: 'u-owner', roleId: OWNER_ROLE_ID, branchScope: 'all' },
      { userId: 'u-acct', roleId: ACCOUNTANT_ROLE_ID, branchScope: ['store-1'] },
    ]);
    expect(access.can({ userId: 'u-mgr', permission: 'scrap.sale.record', branchId: 'store-1' })).toBe(false);
    expect(access.can({ userId: 'u-mgr', permission: 'scrap.review.read', branchId: 'store-1' })).toBe(true);
    expect(access.can({ userId: 'u-owner', permission: 'scrap.sale.record', branchId: 'store-1' })).toBe(true);
    expect(access.can({ userId: 'u-acct', permission: 'scrap.sale.record', branchId: 'store-1' })).toBe(true);
    // Nothing the store manager role holds is a wildcard that would cover it.
    expect(ROLE_CATALOGUE.find((r) => r.id === STORE_MANAGER_ROLE_ID)!.permissions.filter((p) => p.startsWith('scrap.'))).toEqual(['scrap.review.read']);
  });
});
