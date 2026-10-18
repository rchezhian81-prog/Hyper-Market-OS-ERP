import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  supplierReturnDispatchStatuses, goodsReceiptRoutes,
  type GoodsReceiptDeps, type GrnRecord, type SupplierReturnDispatch,
} from '../../services/inventory/src/goods-receipt';
import { checkDispatchEwb, type EwbLifecycleState } from '../../packages/e-way-bill/src/index';
import { fetchGoodsReceipt, openGrnLineDispatchPort } from '../../apps/web-erp/src/browser-entry';

/**
 * **OB-204 (owner, 18 Oct 2026, in writing)** — so the goods-receipt page can say where a supplier return stands BEFORE
 * anyone presses Dispatch, head office's GRN list carries, per return still to go (and per one already dispatched), the
 * same verdict the dispatch route would reach (OB-194's gate, read-only): not required · no e-way bill · waiting · not
 * usable · generated with its number · dispatched · not known. And the browser side: the list is carried onto each line
 * as-is, and the Dispatch POST sends exactly `{ reason }` and reads head office's answer — `ewb_required` by name, a
 * resend as "already dispatched", no connection as `lost_link` (never a success).
 */
const AT = '2026-10-18T05:00:00.000Z';
const cost = (minor: number) => ({ minor, currency: 'INR' });
function receipt(grnId: string, lineQty: number, unitMinor: number, over: Partial<GrnRecord> = {}): GrnRecord {
  return {
    grnId, number: grnId, poId: 'po-1', warehouseId: 'WH', receivedBy: 'u-recv', receivedAt: AT, availableMinor: 0, heldMinor: 0,
    captured: {
      receiptId: grnId, discrepancies: [], requiresApproval: false, discrepancyValue: cost(0),
      lines: [{ lineId: 'L1', productId: 'p-rice', orderedMinor: lineQty, countedMinor: lineQty, uom: 'ea', unitCost: cost(unitMinor), sellableMinor: 0, quarantinedMinor: lineQty, rejectedMinor: 0, heldMinor: 0, batchId: null }],
    } as unknown as GrnRecord['captured'],
    dispositions: [{ lineId: 'L1', productId: 'p-rice', quantityMinor: lineQty, disposition: 'return', decidedBy: 'u-boss', decidedAt: AT, reason: 'damaged', valueMinor: lineQty * unitMinor, currency: 'INR', movementIds: [], via: 'direct' }],
    ...over,
  } as GrnRecord;
}
function deps(records: GrnRecord[], ewbOf: Map<string, { state: EwbLifecycleState; ewbNo?: string }>, dispatched: SupplierReturnDispatch[] = [], gateThrows = false): GoodsReceiptDeps {
  return {
    now: () => AT,
    grn: (_t: string, id: string) => records.find((r) => r.grnId === id),
    all: () => records,
    supplierReturnEwb: {
      gate: (_t: string, _r: GrnRecord, movementId: string, valueMinor: number) => {
        if (gateThrows) throw new Error('org read failed');
        return checkDispatchEwb({ movementId, consignmentValueMinor: valueMinor, unvaluedLines: 0, supplyRoute: 'intra_state', ewb: ewbOf.get(movementId) });
      },
      dispatches: (_t: string, grnId: string) => dispatched.filter((x) => x.grnId === grnId),
      recordDispatch: (_t: string, x: SupplierReturnDispatch) => { dispatched.push(x); },
    },
  } as unknown as GoodsReceiptDeps;
}
const MOV = 'supplier-return-g-big-line-L1';

describe('OB-204 · head office says where each supplier return stands on its dispatch', () => {
  it('at or below the threshold: not required; above: no e-way bill → waiting → not usable → generated with its number', async () => {
    const ewbs = new Map<string, { state: EwbLifecycleState; ewbNo?: string }>();
    expect(await supplierReturnDispatchStatuses(deps([], ewbs), 't', receipt('g-small', 1_000, 10_000))).toEqual([
      expect.objectContaining({ target: 'L1', movementId: 'supplier-return-g-small-line-L1', state: 'not_required', valueMinor: 10_000_000, thresholdMinor: 10_000_000, ewbNo: null, dispatch: null }),
    ]);
    const big = receipt('g-big', 1_001, 10_000);
    const one = async () => (await supplierReturnDispatchStatuses(deps([big], ewbs), 't', big))![0]!;
    expect(await one()).toMatchObject({ state: 'no_ewb', ewbState: 'none', ewbNo: null, valueMinor: 10_010_000 });
    expect((await one()).detail).toBe(`movement ${MOV} is worth ₹1,00,100.00, above the ₹1,00,000.00 threshold, and no e-way bill has been generated for it`);
    for (const [state, expected] of [['pending_unknown', 'ewb_waiting'], ['provider_error', 'ewb_waiting'], ['rejected', 'ewb_not_usable'], ['cancelled', 'ewb_not_usable']] as const) {
      ewbs.set(MOV, { state });
      expect(await one(), state).toMatchObject({ state: expected, ewbState: state, ewbNo: null });
    }
    ewbs.set(MOV, { state: 'generated', ewbNo: '391000654321' });
    expect(await one()).toMatchObject({ state: 'ewb_generated', ewbState: 'generated', ewbNo: '391000654321' });
  });

  it('dispatched: says so with its e-way bill, before and after the return; a return gone with no dispatch has nothing to say', async () => {
    const d: SupplierReturnDispatch = { grnId: 'g-big', target: 'L1', movementId: MOV, valueMinor: 10_010_000, outcome: 'covered', ewbNo: '391000654321', thresholdMinor: 10_000_000, dispatchedBy: 'u-recv', dispatchedAt: AT, reason: 'lorry' };
    const big = receipt('g-big', 1_001, 10_000);
    expect(await supplierReturnDispatchStatuses(deps([big], new Map(), [d]), 't', big)).toEqual([expect.objectContaining({ state: 'dispatched', ewbNo: '391000654321', dispatch: d })]);
    const gone = receipt('g-big', 1_001, 10_000, { lineReturns: [{ lineId: 'L1' } as never] });
    expect(await supplierReturnDispatchStatuses(deps([gone], new Map(), [d]), 't', gone)).toEqual([expect.objectContaining({ state: 'dispatched' })]);
    const small = receipt('g-small', 10, 100, { lineReturns: [{ lineId: 'L1' } as never] });
    expect(await supplierReturnDispatchStatuses(deps([small], new Map()), 't', small)).toEqual([]);
    // Not disposed of as a return: nothing to dispatch.
    expect(await supplierReturnDispatchStatuses(deps([], new Map()), 't', receipt('g-u', 1_001, 10_000, { dispositions: [] }))).toEqual([]);
  });

  it('a check that cannot be read is "not known", never a guess; a head office with no check wired says nothing (no dispatch step)', async () => {
    const big = receipt('g-big', 1_001, 10_000);
    expect(await supplierReturnDispatchStatuses(deps([big], new Map(), [], true), 't', big)).toEqual([expect.objectContaining({ state: 'not_known', ewbNo: null, detail: 'the e-way-bill check could not be read just now' })]);
    expect(await supplierReturnDispatchStatuses({} as GoodsReceiptDeps, 't', big)).toBeUndefined();
  });

  it('the GRN list carries it on each receipt — and leaves the receipt as it was when no check is wired', async () => {
    const ewbs = new Map([[MOV, { state: 'generated' as const, ewbNo: '391000654321' }]]);
    const big = receipt('g-big', 1_001, 10_000);
    const route = (dd: GoodsReceiptDeps) => goodsReceiptRoutes(dd).find((r) => r.method === 'GET' && r.path === '/v1/inventory/goods-receipt')!;
    const ctx = { tenantId: 't', userId: 'u-recv', scope: 'all', params: {}, query: {}, body: undefined } as never;
    const out = await route(deps([big], ewbs)).handler(ctx) as { body: { receipts: { returnDispatches?: unknown[] }[] } };
    expect(out.body.receipts[0]!.returnDispatches).toEqual([expect.objectContaining({ target: 'L1', state: 'ewb_generated', ewbNo: '391000654321' })]);
    const bare = { ...deps([big], ewbs) } as Record<string, unknown>;
    delete bare['supplierReturnEwb'];
    const plain = await route(bare as unknown as GoodsReceiptDeps).handler(ctx) as { body: { receipts: Record<string, unknown>[] } };
    expect(plain.body.receipts[0]).toEqual(big);
  });
});

describe('OB-204 · the browser reads it and sends the Dispatch', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('carries head office\'s word onto each return line as-is; an unreadable state is "not known"', async () => {
    const grn = {
      grnId: 'g-big', number: 'GRN-BIG', poId: 'po-1', warehouseId: 'WH', receivedBy: 'u-recv', receivedAt: AT, availableMinor: 0,
      captured: { requiresApproval: false, discrepancyValue: cost(0), discrepancies: [], lines: [
        { lineId: 'L1', productId: 'p-rice', quarantinedMinor: 1_001, uom: 'ea', unitCost: cost(10_000) },
        { lineId: 'L2', productId: 'p-dal', quarantinedMinor: 5, uom: 'ea', unitCost: cost(100) },
      ] },
      dispositions: [
        { lineId: 'L1', productId: 'p-rice', disposition: 'return', decidedBy: 'u-boss', valueMinor: 10_010_000 },
        { lineId: 'L2', productId: 'p-dal', disposition: 'return', decidedBy: 'u-boss', valueMinor: 500 },
      ],
      returnDispatches: [
        { target: 'L1', movementId: MOV, state: 'no_ewb', ewbState: 'none', ewbNo: null, detail: 'no e-way bill has been generated for it' },
        { target: 'L2', movementId: 'supplier-return-g-big-line-L2', state: 'something_new', detail: '' },
      ],
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ receipts: [grn] }), { status: 200 })));
    const data = await fetchGoodsReceipt();
    expect(data!.receipts![0]!.returnLines).toEqual([
      expect.objectContaining({ lineId: 'L1', dispatch: { state: 'no_ewb', movementId: MOV, ewbNo: null, ewbState: 'none', detail: 'no e-way bill has been generated for it' } }),
      expect.objectContaining({ lineId: 'L2', dispatch: expect.objectContaining({ state: 'not_known' }) }),
    ]);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ receipts: [{ ...grn, returnDispatches: undefined }] }), { status: 200 })));
    expect((await fetchGoodsReceipt())!.receipts![0]!.returnLines![0]).not.toHaveProperty('dispatch');
  });

  it('POSTs exactly { reason } to the line\'s dispatch route; reads 201, a resend, ewb_required by name, another refusal, and no connection', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const answer = (status: number, body: unknown) => vi.fn(async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify(body), { status }); });
    const port = openGrnLineDispatchPort();
    const input = { grnId: 'g-big', lineId: 'L1', reason: 'supplier lorry TN-01-AB-1234' };

    vi.stubGlobal('fetch', answer(201, { grnId: 'g-big', target: 'L1', dispatch: { ewbNo: '391000654321' }, alreadyDispatched: false }));
    expect(await port.post(input)).toEqual({ result: 'dispatched', ewbNo: '391000654321' });
    expect(calls[0]!.url).toBe('/v1/inventory/goods-receipt/g-big/lines/L1/dispatch');
    expect(calls[0]!.init).toMatchObject({ method: 'POST', credentials: 'same-origin' });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ reason: 'supplier lorry TN-01-AB-1234' });
    expect((calls[0]!.init.headers as Record<string, string>)['idempotency-key']).toBeTruthy();

    vi.stubGlobal('fetch', answer(200, { dispatch: { ewbNo: null }, alreadyDispatched: true }));
    expect(await port.post(input)).toEqual({ result: 'already_dispatched', ewbNo: null });
    vi.stubGlobal('fetch', answer(409, { error: { code: 'ewb_required', whatHappened: 'This supplier return cannot leave without an e-way bill: …' } }));
    expect(await port.post(input)).toEqual({ result: 'ewb_required', reason: 'This supplier return cannot leave without an e-way bill: …' });
    vi.stubGlobal('fetch', answer(409, { error: { code: 'supplier_return_already_recorded', whatHappened: 'already recorded' } }));
    expect(await port.post(input)).toEqual({ result: 'refused', reason: 'already recorded' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    expect(await port.post(input)).toEqual({ result: 'lost_link' });
  });
});
