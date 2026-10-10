import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { STREAM } from '../../services/api/src/adapters';

/**
 * **Supplier to shelf, connected — Batch 2's acceptance (M06 · M07 · M08 · M09 · M10 · WF-03 · WF-06 · WF-07 · §28 · P-08 ·
 * hard rules #2 #6 #10).**
 *
 * ONE journey through the real application routes on the API harness — every step a different, named person with only the
 * role they hold, never the owner for everything — on the in-memory store and, with DATABASE_URL, on REAL PostgreSQL:
 *
 *   1. the buyer proposes a supplier (name + GSTIN); finance approves it — the buyer cannot;
 *   2. the buyer raises an order for 100 chilled curd tubs; the owner issues it — the buyer cannot;
 *   3. the receiver books a PARTIAL delivery of 60 at the back store: 50 probed cold (sellable), 6 too warm (cold-chain
 *      breach → held in quarantine), 4 with no reading (held) — judged against the 100 still open (SF-02); 40 stay open;
 *   4. QC (a second person, never the receiver) RETURNS the 6 too-warm tubs to the supplier and ACCEPTS the 4 after probing;
 *      the held stock never reaches a pickable bin;
 *   5. the back-store worker puts the 54 eligible tubs away into a chilled bin;
 *   6. the floor asks for 30; a floor manager approves against the back store's real stock; the back-store worker issues 30
 *      FROM THE BIN (the bin is lowered in the same write) — in transit, not on hand anywhere;
 *   7. the floor receiver counts INDEPENDENTLY: 28 arrived — a valued shortfall of 2 on the exceptions read;
 *   8. a manager who neither issued nor counted RESOLVES the shortfall accountably: 1 found on the trolley (a compensating,
 *      two-person `adjusted` movement at the floor) and 1 confirmed lost (reason-coded, valued) — the exception is kept,
 *      marked resolved, never deleted;
 *   9. every location's projection equals the expected numbers, and quantity and value are conserved;
 *  10. the supplier's bill for the 60 delivered is captured as the paper says, checked by a second person, MATCHED three-way
 *      (order · receipt · invoice), and the supplier account shows the liability net of the debit note for the returned 6.
 *
 * Synthetic data only (hard rule #7): a fresh random tenant per run.
 */

const COMPANY = 'C1';
const FLOOR = 'S1';
const BACK = 'S1-BACK';
const OWNER = 'u-owner';       // issues the purchase order (the only role holding purchase.order.approve)
const BUYER = 'u-buyer';       // store_manager: proposes the supplier and the order, captures the bill
const FINANCE = 'u-fin';       // accountant: approves the supplier, checks the bill, matches it, issues the debit note
const RECEIVER = 'u-recv';     // store_manager: books the delivery at the back-store dock
const QC = 'u-qc';             // store_manager: the second person who disposes of held stock
const BACKSTORE = 'u-back';    // store_manager: puts away and issues from the bin
const FLOOR_ASK = 'u-floor';   // cashier: floor staff ask for stock
const FLOOR_MGR = 'u-flmgr';   // store_manager: approves the floor's ask; resolves the shortfall (neither issuer nor counter)
const SHELF = 'u-shelf';       // store_manager: counts the delivery in on the floor — never the issuer
const SUPPLIER = 'sup-dairy';
const GSTIN = '33ABCDE1234F1Z7'; // synthetic, checksum-valid
const PRODUCT = 'p-curd';
const PO = 'po-curd-1';
const GRN = 'grn-curd-1';
const BIN = 'BIN-CH-1';
const INDENT = 'ind-curd-1';
const BATCH = 'B-0101';
const ORDERED = 100;
const COST = 3_000;            // ₹30.00 per tub
const GOOD = 50;
const WARM = 6;
const UNREAD = 4;
const DELIVERED = GOOD + WARM + UNREAD; // 60
const ELIGIBLE = GOOD + UNREAD;          // 54
const ASKED = 30;
const ARRIVED = 28;
const FOUND = 1;
const LOST = ASKED - ARRIVED - FOUND;    // 1

type Body = Record<string, unknown>;
interface Reply { readonly status: number; readonly body: unknown }
const codeOf = (r: Reply): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** One step of the journey as the final report states it: step → route → expected → actual. */
export interface JourneyRow { readonly step: string; readonly route: string; readonly expected: string; readonly actual: string }

async function journey(h: ApiHarness, t: string, rows: JourneyRow[]): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, idempotencyKey?: string, query?: Readonly<Record<string, string>>): Promise<Reply> =>
    h.request({ method, path, userId, tenantId: t, ...(body === undefined ? {} : { body }), ...(idempotencyKey === undefined ? {} : { idempotencyKey }), ...(query === undefined ? {} : { query }) });
  const ok = async (p: Promise<Reply>, expected: number): Promise<Body> => {
    const r = await p;
    expect(r.status, JSON.stringify(r.body)).toBe(expected);
    return r.body as Body;
  };
  const row = (step: string, route: string, expected: string, actual: string): void => { rows.push({ step, route, expected, actual }); };

  interface Picture { back: number; floor: number; inTransit: number; backValue: number; floorValue: number }
  const picture = async (): Promise<Picture> => {
    const a = (await ok(call('GET', '/v1/inventory/availability', OWNER, undefined, undefined, { productId: PRODUCT }), 200)) as unknown as { rows: { locationId: string; onHandMinor: number }[]; inTransit: { quantityMinor: number }[] };
    const v = (await ok(call('GET', '/v1/inventory/valuation', OWNER, undefined, undefined, { productId: PRODUCT }), 200)) as unknown as { rows: { locationId: string; value: { minor: number } }[] };
    const on = (loc: string): number => a.rows.filter((r) => r.locationId === loc).reduce((s, r) => s + r.onHandMinor, 0);
    const val = (loc: string): number => v.rows.filter((r) => r.locationId === loc).reduce((s, r) => s + r.value.minor, 0);
    return { back: on(BACK), floor: on(FLOOR), inTransit: a.inTransit.reduce((s, r) => s + r.quantityMinor, 0), backValue: val(BACK), floorValue: val(FLOOR) };
  };
  const binHeld = async (): Promise<Record<string, number>> =>
    Object.fromEntries(((await ok(call('GET', `/v1/warehouse/bins/${BIN}`, OWNER), 200)) as unknown as { held: { key: string; quantityMinor: number }[] }).held.map((x) => [x.key, x.quantityMinor]));
  const fmt = (p: Picture): string => `back ${p.back} · floor ${p.floor} · in transit ${p.inTransit}`;

  // ── 0. The cast, the places, the receiving tolerances and the product master: chilled curd, batch-tracked, 0–5 °C. ──────
  await h.seedOwner(t, OWNER);
  for (const u of [BUYER, RECEIVER, QC, BACKSTORE, FLOOR_MGR, SHELF]) await h.provisionRole(t, u, 'store_manager');
  await h.provisionRole(t, FINANCE, 'accountant');
  await h.provisionRole(t, FLOOR_ASK, 'cashier');
  await ok(call('POST', `/v1/org/nodes/${COMPANY}`, OWNER, { kind: 'company', name: 'SRE Retail' }, `org-${COMPANY}`), 201);
  await ok(call('POST', `/v1/org/nodes/${FLOOR}`, OWNER, { kind: 'branch', name: 'SRE Hyper Market', parentId: COMPANY, companyId: COMPANY }, `org-${FLOOR}`), 201);
  await ok(call('POST', `/v1/org/nodes/${BACK}`, OWNER, { kind: 'warehouse', name: 'Back store', parentId: FLOOR, companyId: COMPANY }, `org-${BACK}`), 201);
  await ok(call('POST', '/v1/inventory/receipt-policy', OWNER, { excessToleranceBp: 0, shortageToleranceBp: 0, nearExpiryDays: 7 }, 'receipt-policy'), 201);
  await ok(call('POST', '/v1/catalogue/tax-classes/0403/rates/2017-07-01', OWNER, { rateBps: 500 }, 'tax-0403'), 201);
  await ok(call('POST', `/v1/catalogue/products/${PRODUCT}/publish`, OWNER, {
    product: { sku: 'CURD-400', name: 'Curd 400g tub', baseUom: 'ea', primaryCategoryId: 'dairy', taxClass: '0403', lifecycle: 'active', handling: 'chilled', coldChain: { minTenthsC: 0, maxTenthsC: 50 }, batchTracked: true },
    categories: [{ categoryId: 'dairy', name: 'Dairy', parentId: null }],
  }, `publish-${PRODUCT}`), 201);
  await ok(call('POST', `/v1/prices/list/${PRODUCT}/entries/e1`, OWNER, { scope: 'store', scopeRef: FLOOR, priceMinor: 4_000, mrpMinor: 4_500, costMinor: COST, marginFloorBps: 0, currency: 'INR', effectiveFrom: today }, `price-${PRODUCT}`), 201);
  await ok(call('POST', '/v1/catalogue/pack', OWNER, { storeId: FLOOR, asOf: today }, 'pack-1'), 201);
  expect(await picture()).toEqual({ back: 0, floor: 0, inTransit: 0, backValue: 0, floorValue: 0 });

  // ── 1. The supplier: proposed by the buyer, approved by finance (M06-FR-01 · §28). ─────────────────────────────────────
  const proposedSupplier = await ok(call('POST', `/v1/purchase/suppliers/${SUPPLIER}`, BUYER, { name: 'Kaveri Dairy', gstin: GSTIN }, `sup-${SUPPLIER}`), 201);
  const selfSupplier = await call('POST', `/v1/purchase/suppliers/${SUPPLIER}/approval`, BUYER, { reason: 'mine' }, 'sup-self');
  expect(codeOf(selfSupplier)).toBe('forbidden');
  await ok(call('POST', `/v1/purchase/suppliers/${SUPPLIER}/approval`, FINANCE, { reason: 'GST certificate and FSSAI licence checked' }, 'sup-approve'), 200);
  const supplier = await ok(call('GET', `/v1/purchase/suppliers/${SUPPLIER}`, BUYER), 200);
  expect(JSON.stringify(supplier)).toContain(GSTIN);
  row('1 supplier proposed / approved', 'POST /v1/purchase/suppliers/:id · …/approval', 'buyer proposes; buyer self-approval forbidden; finance approves; GSTIN kept',
    `proposed ${String((proposedSupplier['supplier'] as Body | undefined)?.['status'] ?? 'yes')}; self-approval ${codeOf(selfSupplier)}; approved by ${FINANCE}; GSTIN on record`);

  // ── 2. The order: 100 tubs, proposed by the buyer, issued by the owner (M06-FR-02). ───────────────────────────────────
  const unitCost = { minor: COST, currency: 'INR' };
  await ok(call('POST', `/v1/purchase/orders/${PO}`, BUYER, { supplierId: SUPPLIER, deliverToLocationId: FLOOR, lines: [{ productId: PRODUCT, orderedQty: ORDERED, unitCost }] }, `po-${PO}`), 201);
  const selfPo = await call('POST', `/v1/purchase/orders/${PO}/approval`, BUYER, { reason: 'mine' }, 'po-self');
  expect(selfPo.status).toBeGreaterThanOrEqual(400);
  const issued = await ok(call('POST', `/v1/purchase/orders/${PO}/approval`, OWNER, { reason: 'within the month budget' }, 'po-approve'), 200);
  expect(issued['order']).toMatchObject({ status: 'issued', approvedBy: OWNER, requisitionedBy: BUYER });
  expect(await ok(call('GET', '/v1/purchase/commitments', OWNER), 200)).toMatchObject({ known: true, valueMinor: ORDERED * COST });
  row('2 order raised / issued', 'POST /v1/purchase/orders/:poId · …/approval', 'buyer proposes 100; buyer cannot issue; owner issues; commitment ₹3,000.00',
    `buyer self-issue ${selfPo.status}; issued by ${OWNER}; commitment ${ORDERED * COST}`);

  // ── 3. The PARTIAL delivery at the back store: 60 of 100. Cold chain judged from the master (SF-07). ─────────────────
  const expiry = addDays(today, 30);
  const delivery = {
    warehouseId: BACK, receivedOnDate: today, currency: 'INR', poId: PO,
    lines: [
      { lineId: 'L1', productId: PRODUCT, orderedMinor: ORDERED, countedMinor: GOOD, uom: 'ea', unitCost, condition: 'good', batchId: BATCH, expiry, temperatureC: 3 },
      { lineId: 'L2', productId: PRODUCT, orderedMinor: ORDERED, countedMinor: WARM, uom: 'ea', unitCost, condition: 'good', batchId: BATCH, expiry, temperatureC: 7.5 },
      { lineId: 'L3', productId: PRODUCT, orderedMinor: ORDERED, countedMinor: UNREAD, uom: 'ea', unitCost, condition: 'good', batchId: BATCH, expiry },
    ],
  };
  const grnBody = await ok(call('POST', `/v1/inventory/goods-receipt/${GRN}`, RECEIVER, delivery, GRN), 201);
  const grn = grnBody['grn'] as {
    availableMinor: number; heldMinor: number; receivedBy: string; governanceFlags: string[];
    orderPosition?: Record<string, { ordered: number; receivedBefore: number; remaining: number }>;
    captured: { lines: { lineId: string; disposition: string; sellableMinor: number; quarantinedMinor: number }[]; discrepancies: { kind: string; lineId: string; quantityMinor: number; requiresApproval: boolean }[] };
    poReceipt?: { receivedByProduct: Record<string, number> } | null;
  };
  expect(grn).toMatchObject({ availableMinor: GOOD, heldMinor: 0, receivedBy: RECEIVER });
  expect(grn.orderPosition?.[PRODUCT]).toMatchObject({ ordered: ORDERED, receivedBefore: 0, remaining: ORDERED });
  expect(grn.captured.lines.map((l) => [l.lineId, l.disposition, l.sellableMinor, l.quarantinedMinor]))
    .toEqual([['L1', 'sellable', GOOD, 0], ['L2', 'quarantine', 0, WARM], ['L3', 'quarantine', 0, UNREAD]]);
  const kinds = grn.captured.discrepancies.map((d) => [d.kind, d.lineId]);
  expect(kinds).toEqual(expect.arrayContaining([['temperature_breach', 'L2'], ['temperature_not_recorded', 'L3']]));
  expect(grn.poReceipt?.receivedByProduct).toEqual({ [PRODUCT]: DELIVERED });
  const order = await ok(call('GET', `/v1/purchase/orders/${PO}`, BUYER), 200) as { order: { receivedByProduct: Record<string, number> }; openCommitment: { fullyReceived: boolean; lines: { productId: string; openQty: number }[] } | null };
  expect(order.order.receivedByProduct).toEqual({ [PRODUCT]: DELIVERED });
  expect(order.openCommitment).toMatchObject({ fullyReceived: false, lines: [expect.objectContaining({ productId: PRODUCT, openQty: ORDERED - DELIVERED })] });
  expect(await ok(call('GET', '/v1/purchase/commitments', OWNER), 200)).toMatchObject({ known: true, valueMinor: (ORDERED - DELIVERED) * COST });
  let p = await picture();
  expect(p).toEqual({ back: GOOD, floor: 0, inTransit: 0, backValue: GOOD * COST, floorValue: 0 });
  row('3 partial receipt 60 of 100', 'POST /v1/inventory/goods-receipt/:grnId', '50 sellable; 6 breach + 4 unread held; order 60 received, 40 open; back 50',
    `sellable ${grn.availableMinor}; held lines ${grn.captured.lines.filter((l) => l.quarantinedMinor > 0).map((l) => `${l.lineId}:${l.quarantinedMinor}`).join(',')}; discrepancies ${kinds.map((k) => k.join('@')).join(',')}; open ${order.openCommitment?.lines[0]?.openQty}; ${fmt(p)}`);

  // ── 4. QC: a second person. The receiver cannot dispose of their own delivery; QC returns L2 and accepts L3. ──────────
  const selfQc = await call('POST', `/v1/inventory/goods-receipt/${GRN}/lines/L2/disposition`, RECEIVER, { disposition: 'return', reason: 'too warm' }, 'qc-self');
  expect(codeOf(selfQc)).toBe('self_approval');
  // Held stock never enters a pickable bin, whatever the worker scans.
  await ok(call('POST', `/v1/warehouse/bins/${BIN}`, BACKSTORE, { storeId: FLOOR, capacityMinor: 200, pickable: true, zone: 'chilled', locationId: BACK }, `bin-${BIN}`), 201);
  const heldIntoBin = await call('POST', '/v1/warehouse/movements/pa-held', BACKSTORE, { kind: 'put_away', storeId: FLOOR, productId: PRODUCT, batchId: BATCH, quantityMinor: WARM, uom: 'ea', fromBinId: null, toBinId: BIN, stockState: 'quarantine' }, 'pa-held');
  expect(heldIntoBin.status).toBe(422);
  const returned = await ok(call('POST', `/v1/inventory/goods-receipt/${GRN}/lines/L2/disposition`, QC, { disposition: 'return', reason: 'probed 7.5 °C — above the 5 °C limit; supplier to collect' }, 'qc-L2'), 200);
  expect(returned).toMatchObject({ disposition: 'return', quantityMinor: WARM, valueMinor: WARM * COST, decidedBy: QC, movementIds: [] });
  const accepted = await ok(call('POST', `/v1/inventory/goods-receipt/${GRN}/lines/L3/disposition`, QC, { disposition: 'accept', reason: 'probed 2.8 °C on the dock; seals intact' }, 'qc-L3'), 200);
  expect(accepted).toMatchObject({ disposition: 'accept', quantityMinor: UNREAD, decidedBy: QC });
  p = await picture();
  expect(p).toEqual({ back: ELIGIBLE, floor: 0, inTransit: 0, backValue: ELIGIBLE * COST, floorValue: 0 });
  row('4 QC hold / reject / release', 'POST /v1/inventory/goods-receipt/:grnId/lines/:lineId/disposition', 'receiver self-QC refused; held stock refused from pickable bin; 6 returned (no stock move); 4 released; back 54',
    `self ${codeOf(selfQc)}; held→pickable ${heldIntoBin.status} ${codeOf(heldIntoBin)}; L2 return value ${String(returned['valueMinor'])}; L3 accept ${String(accepted['quantityMinor'])}; ${fmt(p)}`);

  // ── 5. Put-away: the 54 eligible tubs into the chilled bin. ───────────────────────────────────────────────────────────
  await ok(call('POST', '/v1/warehouse/movements/pa-1', BACKSTORE, { kind: 'put_away', storeId: FLOOR, productId: PRODUCT, batchId: BATCH, quantityMinor: ELIGIBLE, uom: 'ea', fromBinId: null, toBinId: BIN }, 'pa-1'), 201);
  expect(await binHeld()).toEqual({ [`${BIN}|${PRODUCT}|${BATCH}`]: ELIGIBLE });
  // The same scan again is one movement.
  expect((await ok(call('POST', '/v1/warehouse/movements/pa-1', BACKSTORE, { kind: 'put_away', storeId: FLOOR, productId: PRODUCT, batchId: BATCH, quantityMinor: ELIGIBLE, uom: 'ea', fromBinId: null, toBinId: BIN }, 'pa-1-again'), 200))['outcome']).toBe('duplicate_ignored');
  expect(await binHeld()).toEqual({ [`${BIN}|${PRODUCT}|${BATCH}`]: ELIGIBLE });
  expect(await picture()).toMatchObject({ back: ELIGIBLE }); // a bin is a projection under the location, never a second posting
  row('5 put-away to back-store bin', 'POST /v1/warehouse/movements/:commandId', `bin holds 54 of batch ${BATCH}; re-scan is a no-op; back still 54`, `bin ${JSON.stringify(await binHeld())}`);

  // ── 6. The floor asks for 30; a floor manager approves; the back store issues 30 FROM THE BIN. ─────────────────────────
  const asked = await ok(call('POST', `/v1/floor/indents/${INDENT}`, FLOOR_ASK, { fromLocationId: BACK, toLocationId: FLOOR, lines: [{ productId: PRODUCT, quantityMinor: ASKED, uom: 'ea' }], reason: 'dairy chiller low' }, INDENT), 201);
  expect(asked['indent']).toMatchObject({ state: 'requested', requestedBy: FLOOR_ASK });
  expect(codeOf(await call('POST', `/v1/floor/indents/${INDENT}/approval`, FLOOR_ASK, {}, 'ind-self'))).toBe('forbidden');
  const approved = await ok(call('POST', `/v1/floor/indents/${INDENT}/approval`, FLOOR_MGR, {}, 'ind-approve'), 200);
  expect(approved['indent']).toMatchObject({ state: 'approved', approvedBy: FLOOR_MGR, totals: expect.objectContaining({ allocatedMinor: ASKED }) });
  const issue = await ok(call('POST', `/v1/floor/indents/${INDENT}/issues/is-1`, BACKSTORE, { lines: [{ productId: PRODUCT, batchId: BATCH, quantityMinor: ASKED, binId: BIN }] }, 'ind-issue-1'), 201);
  expect(issue).toMatchObject({ transferId: `${INDENT}:is-1`, lineCostsMinor: [COST] });
  p = await picture();
  expect(p).toEqual({ back: ELIGIBLE - ASKED, floor: 0, inTransit: ASKED, backValue: (ELIGIBLE - ASKED) * COST, floorValue: 0 });
  const binAfterIssue = await binHeld();
  expect(binAfterIssue).toEqual({ [`${BIN}|${PRODUCT}|${BATCH}`]: ELIGIBLE - ASKED });
  row('6 indent raised / approved / issued from bin', 'POST /v1/floor/indents/:id · …/approval · …/issues/:issueId', 'floor staff cannot approve; manager allocates 30; 30 issued from the bin: back 24, in transit 30, bin 24',
    `${fmt(p)}; bin ${JSON.stringify(binAfterIssue)}`);

  // ── 7. The floor counts INDEPENDENTLY: 28 arrived of 30 — a valued shortfall. ────────────────────────────────────────
  expect(codeOf(await call('POST', `/v1/floor/indents/${INDENT}/issues/is-1/receipt`, BACKSTORE, { counted: [{ productId: PRODUCT, batchId: BATCH, quantityMinor: ARRIVED }] }, 'rc-self'))).toBe('issuer_cannot_receive');
  const counted = await ok(call('POST', `/v1/floor/indents/${INDENT}/issues/is-1/receipt`, SHELF, { counted: [{ productId: PRODUCT, batchId: BATCH, quantityMinor: ARRIVED }] }, 'rc-1'), 201);
  expect(counted['discrepancies']).toEqual([expect.objectContaining({ productId: PRODUCT, differenceMinor: -(ASKED - ARRIVED), value: { minor: (ASKED - ARRIVED) * COST, currency: 'INR' } })]);
  expect(counted['indent']).toMatchObject({ totals: expect.objectContaining({ issuedMinor: ASKED, receivedMinor: ARRIVED, shortfallMinor: ASKED - ARRIVED, inTransitMinor: 0 }) });
  expect((counted['indent'] as { attention: string[] }).attention).toContain('arrived_short');
  const exceptions = await ok(call('GET', '/v1/inventory/exceptions', OWNER), 200) as { transferShortfalls: { transferId: string; differenceMinor: number; value: { minor: number } }[] };
  expect(exceptions.transferShortfalls).toEqual([expect.objectContaining({ transferId: `${INDENT}:is-1`, differenceMinor: -(ASKED - ARRIVED) })]);
  p = await picture();
  expect(p).toEqual({ back: ELIGIBLE - ASKED, floor: ARRIVED, inTransit: 0, backValue: (ELIGIBLE - ASKED) * COST, floorValue: ARRIVED * COST });
  row('7 independent floor receipt, short', 'POST /v1/floor/indents/:id/issues/:issueId/receipt', 'issuer cannot count; 28 of 30 arrive; shortfall 2 valued ₹60.00 on exceptions; floor 28',
    `shortfall ${ASKED - ARRIVED} value ${exceptions.transferShortfalls[0]?.value.minor}; ${fmt(p)}`);

  // ── 8. The shortfall is RESOLVED accountably: 1 found on the trolley, 1 confirmed lost — by a person who neither issued
  //      nor counted, with a reason; the found unit is a compensating two-person movement; the exception is kept, resolved.
  const resolutionPath = `/v1/floor/indents/${INDENT}/issues/is-1/shortfall/resolution`;
  const resolution = { lines: [{ productId: PRODUCT, batchId: BATCH, foundMinor: FOUND }], reasonCode: 'theft_suspected', note: 'one tub found under the trolley tray; one not found after a search of the route' };
  expect(codeOf(await call('POST', resolutionPath, SHELF, resolution, 'res-counter'))).toBe('counter_cannot_resolve');
  expect(codeOf(await call('POST', resolutionPath, BACKSTORE, resolution, 'res-issuer'))).toBe('issuer_cannot_resolve');
  expect(codeOf(await call('POST', resolutionPath, FLOOR_MGR, { ...resolution, lines: [{ productId: PRODUCT, batchId: BATCH, foundMinor: ASKED - ARRIVED + 1 }] }, 'res-over'))).toBe('more_found_than_missing');
  expect(codeOf(await call('POST', resolutionPath, FLOOR_MGR, { ...resolution, reasonCode: 'because' }, 'res-noreason'))).toBe('not_readable_as_a_resolution');
  const resolved = await ok(call('POST', resolutionPath, FLOOR_MGR, resolution, 'res-1'), 201);
  expect(resolved).toMatchObject({
    alreadyResolved: false,
    resolution: { resolvedBy: FLOOR_MGR, reasonCode: 'theft_suspected', lines: [{ productId: PRODUCT, batchId: BATCH, missingMinor: ASKED - ARRIVED, foundMinor: FOUND, lostMinor: LOST, lostValueMinor: LOST * COST }] },
  });
  // The same resolution again is the same; a different one is a visible conflict, never a second truth.
  expect(await ok(call('POST', resolutionPath, FLOOR_MGR, resolution, 'res-1-again'), 200)).toMatchObject({ alreadyResolved: true });
  expect(codeOf(await call('POST', resolutionPath, FLOOR_MGR, { ...resolution, lines: [{ productId: PRODUCT, batchId: BATCH, foundMinor: 0 }] }, 'res-different'))).toBe('shortfall_already_resolved');
  const found = (resolved['posted'] as { movementId: string; kind: string; quantityMinor: number; enteredBy: string; approvedBy?: string; locationId: string }[]);
  expect(found).toEqual([expect.objectContaining({ movementId: `${INDENT}:is-1-found-1`, kind: 'adjusted', quantityMinor: FOUND, locationId: FLOOR, enteredBy: SHELF, approvedBy: FLOOR_MGR })]);
  // What finance posts the inventory-loss journal from (Batch 3): the event carries a `loss` — where, who, why, the unit, the
  // cost per whole unit the stock left the back store with, how much was lost and what that is worth.
  const resolvedEvents = await h.store.readStream(t, [STREAM.warehouse, 'indents'].join('\u001f'), { type: 'FloorIndentShortfallResolved' });
  expect((resolvedEvents.at(-1)!.event.payload as { loss: unknown }).loss).toEqual({
    source: 'floor_indent', transferId: `${INDENT}:is-1`, indentId: INDENT, issueId: 'is-1', fromLocationId: BACK, toLocationId: FLOOR,
    resolvedBy: FLOOR_MGR, resolvedAt: expect.any(String), reasonCode: 'theft_suspected', note: resolution.note, currency: 'INR',
    lines: [{ productId: PRODUCT, batchId: BATCH, uom: 'ea', lostMinor: LOST, unitCostMinor: COST, lostValueMinor: LOST * COST }],
    lostValueMinor: LOST * COST, foundMovementIds: [`${INDENT}:is-1-found-1`],
  });
  const after = await ok(call('GET', '/v1/inventory/exceptions', OWNER), 200) as { transferShortfalls: { transferId: string; resolution?: { resolvedBy: string } | null }[] };
  expect(after.transferShortfalls).toEqual([expect.objectContaining({ transferId: `${INDENT}:is-1`, resolution: expect.objectContaining({ resolvedBy: FLOOR_MGR }) })]);
  const indentNow = await ok(call('GET', `/v1/floor/indents/${INDENT}`, OWNER), 200) as { attention: string[] };
  expect(indentNow.attention).not.toContain('arrived_short');
  p = await picture();
  expect(p).toEqual({ back: ELIGIBLE - ASKED, floor: ARRIVED + FOUND, inTransit: 0, backValue: (ELIGIBLE - ASKED) * COST, floorValue: (ARRIVED + FOUND) * COST });
  row('8 discrepancy resolved', 'POST /v1/floor/indents/:id/issues/:issueId/shortfall/resolution', 'counter / issuer refused; over-find refused; reason code required; 1 found (adjusted, entered by counter, approved by resolver); 1 lost ₹30.00; exception kept, resolved',
    `found movement ${found.map((m) => `${m.kind} ${m.quantityMinor} by ${m.enteredBy}/${m.approvedBy}`).join(',')}; lost ${LOST}; ${fmt(p)}`);

  // ── 9. The projections: every place equals the expected numbers, and quantity and value are conserved. ───────────────
  expect(await binHeld()).toEqual({ [`${BIN}|${PRODUCT}|${BATCH}`]: ELIGIBLE - ASKED });
  // received sellable (54) = back (24) + floor (29) + lost (1) — quantity; and value the same at cost.
  expect(p.back + p.floor + p.inTransit + LOST).toBe(ELIGIBLE);
  expect(p.backValue + p.floorValue + LOST * COST).toBe(ELIGIBLE * COST);
  row('9 projections reconcile', 'GET /v1/inventory/availability · /valuation · /v1/warehouse/bins/:binId', 'back 24 (bin 24) · floor 29 · in transit 0 · lost 1 = 54 received sellable; value likewise',
    `${fmt(p)}; bin ${ELIGIBLE - ASKED}; value ${p.backValue}+${p.floorValue}+${LOST * COST}=${p.backValue + p.floorValue + LOST * COST}`);

  // ── 10. The supplier's bill for the 60 delivered: captured as the paper says, checked by finance in their own session,
  //       matched three-way against the STORED order and receipts; the returned 6 come off as a debit note. ─────────────
  const paper = { supplierId: SUPPLIER, poId: PO, declaredTotalMinor: DELIVERED * COST, lines: [{ productId: PRODUCT, quantity: DELIVERED, unitPriceMinor: COST, lineTotalMinor: DELIVERED * COST }] };
  const ask = await ok(call('POST', '/v1/approvals/requests', BUYER, { kind: 'supplier_invoice_check', subjectRef: 'inv-curd-1', details: { ...paper, invoiceId: 'inv-curd-1' }, valueMinor: DELIVERED * COST, summary: 'Check bill inv-curd-1', reason: 'paper bill in hand' }, 'ask-inv'), 201);
  await ok(call('POST', `/v1/approvals/requests/${String(ask['requestId'])}/decide`, FINANCE, { decision: 'approved', reason: 'checked against the paper bill' }, 'decide-inv'), 201);
  await ok(call('POST', '/v1/purchase/invoices/inv-curd-1/capture', BUYER, { ...paper, approvalId: ask['requestId'] }, 'cap-inv'), 201);
  const matched = await ok(call('POST', '/v1/purchase/invoices/inv-curd-1/match', FINANCE, {}, 'match-inv'), 200);
  expect(matched).toMatchObject({ invoiceId: 'inv-curd-1', poId: PO, blocked: false, payableMinor: DELIVERED * COST, withheldMinor: 0, matchedBy: FINANCE });
  const note = await ok(call('POST', `/v1/purchase/suppliers/${SUPPLIER}/debit-notes/DN-${GRN}-L2/issue`, FINANCE, {}, 'dn-1'), 201);
  expect(note).toMatchObject({ debitNoteRef: `DN-${GRN}-L2`, valueMinor: WARM * COST, issuedBy: FINANCE });
  const account = await ok(call('GET', `/v1/purchase/suppliers/${SUPPLIER}/account`, FINANCE), 200) as { totals: Record<string, number> };
  expect(account.totals).toMatchObject({ invoicedMinor: DELIVERED * COST, accruedMinor: DELIVERED * COST, withheldMinor: 0, debitNotesMinor: WARM * COST, paidMinor: 0, owedMinor: (DELIVERED - WARM) * COST });
  row('10 invoice three-way match + liability', 'POST /v1/approvals/requests · /v1/purchase/invoices/:id/capture · …/match · …/debit-notes/:ref/issue · GET …/account', 'bill for 60 matches order + receipt: payable ₹1,800.00; debit note ₹180.00 for the 6 returned; owed ₹1,620.00',
    `payable ${String(matched['payableMinor'])}; debit note ${String(note['valueMinor'])}; owed ${account.totals['owedMinor']}`);

  // ── 11. The 6 too-warm tubs physically go back on the supplier's van: recorded once, beside the debit note. Until then the
  //       account shows them waiting for collection; a line that was released (L3) or never decided cannot be "returned". ──
  type LineReturns = { pendingLineReturns: { grnId: string; lineId: string; quantityMinor: number; debitNoteRef: string; returned: boolean; returnedBy: string | null }[] };
  const waiting = await ok(call('GET', `/v1/purchase/suppliers/${SUPPLIER}/account`, FINANCE), 200) as unknown as LineReturns;
  expect(waiting.pendingLineReturns).toEqual([expect.objectContaining({ grnId: GRN, lineId: 'L2', quantityMinor: WARM, debitNoteRef: `DN-${GRN}-L2`, returned: false, returnedBy: null })]);
  const notReturn = await call('POST', `/v1/inventory/goods-receipt/${GRN}/lines/L3/returned`, BACKSTORE, { reason: 'wrong line' }, 'ret-L3');
  expect(notReturn.status).toBe(409);
  expect(codeOf(notReturn)).toBe('line_not_disposed_for_return');
  const handed = await ok(call('POST', `/v1/inventory/goods-receipt/${GRN}/lines/L2/returned`, BACKSTORE, { reason: 'collected by the Kaveri Dairy van driver, gate pass 0417' }, 'ret-L2'), 201);
  expect(handed).toMatchObject({ lineId: 'L2', quantityMinor: WARM, valueMinor: WARM * COST, returnedBy: BACKSTORE, debitNoteRef: `DN-${GRN}-L2`, movementIds: [], alreadyReturned: false });
  expect(await ok(call('POST', `/v1/inventory/goods-receipt/${GRN}/lines/L2/returned`, BACKSTORE, { reason: 'again' }, 'ret-L2-again'), 200)).toMatchObject({ alreadyReturned: true });
  const collected = await ok(call('GET', `/v1/purchase/suppliers/${SUPPLIER}/account`, FINANCE), 200) as unknown as LineReturns & { totals: Record<string, number> };
  expect(collected.pendingLineReturns).toEqual([expect.objectContaining({ lineId: 'L2', returned: true, returnedBy: BACKSTORE })]);
  expect(collected.totals['owedMinor']).toBe((DELIVERED - WARM) * COST); // the hand-over moves no money and no stock
  expect(await picture()).toEqual(p);
  row('11 rejected stock back to the supplier', 'POST /v1/inventory/goods-receipt/:grnId/lines/:lineId/returned · GET …/account', 'L2 waits for collection beside DN; released L3 refused; hand-over recorded once; owed and stock unchanged',
    `waiting ${String(waiting.pendingLineReturns[0]?.returned)}; L3 ${codeOf(notReturn)}; returned by ${String(handed['returnedBy'])}; owed ${collected.totals['owedMinor']}`);
}


/** The cast and places for the race cases: a product with 50 costed at the back store, and a PO of 100 issued. */
async function raceSetup(h: ApiHarness, t: string) {
  const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, idempotencyKey?: string, query?: Readonly<Record<string, string>>): Promise<Reply> =>
    h.request({ method, path, userId, tenantId: t, ...(body === undefined ? {} : { body }), ...(idempotencyKey === undefined ? {} : { idempotencyKey }), ...(query === undefined ? {} : { query }) });
  await h.seedOwner(t, OWNER);
  for (const u of [BUYER, RECEIVER, 'u-recv2', BACKSTORE, 'u-back2', FLOOR_MGR, SHELF, 'u-shelf2']) await h.provisionRole(t, u, 'store_manager');
  await h.provisionRole(t, FINANCE, 'accountant');
  await h.provisionRole(t, FLOOR_ASK, 'cashier');
  expect((await call('POST', `/v1/org/nodes/${COMPANY}`, OWNER, { kind: 'company', name: 'SRE Retail' }, `org-${COMPANY}`)).status).toBe(201);
  expect((await call('POST', `/v1/org/nodes/${FLOOR}`, OWNER, { kind: 'branch', name: 'SRE Hyper Market', parentId: COMPANY, companyId: COMPANY }, `org-${FLOOR}`)).status).toBe(201);
  expect((await call('POST', `/v1/org/nodes/${BACK}`, OWNER, { kind: 'warehouse', name: 'Back store', parentId: FLOOR, companyId: COMPANY }, `org-${BACK}`)).status).toBe(201);
  expect((await call('POST', '/v1/inventory/receipt-policy', OWNER, { excessToleranceBp: 0, shortageToleranceBp: 0, nearExpiryDays: 7 }, 'receipt-policy')).status).toBe(201);
  expect((await call('POST', '/v1/catalogue/products/p-dal/publish', OWNER, {
    product: { sku: 'DAL-1KG', name: 'Toor dal 1kg', baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '0713', lifecycle: 'active', handling: 'ambient' },
    categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }],
  }, 'publish-dal')).status).toBe(201);
  expect((await call('POST', `/v1/purchase/suppliers/${SUPPLIER}`, BUYER, { name: 'Kaveri Dairy', gstin: GSTIN }, 'sup')).status).toBe(201);
  expect((await call('POST', `/v1/purchase/suppliers/${SUPPLIER}/approval`, FINANCE, { reason: 'documents checked' }, 'sup-ok')).status).toBe(200);
  expect((await call('POST', '/v1/purchase/orders/po-race', BUYER, { supplierId: SUPPLIER, deliverToLocationId: FLOOR, lines: [{ productId: 'p-dal', orderedQty: 100, unitCost: { minor: COST, currency: 'INR' } }] }, 'po-race')).status).toBe(201);
  expect((await call('POST', '/v1/purchase/orders/po-race/approval', OWNER, { reason: 'ok' }, 'po-race-ok')).status).toBe(200);
  const onHand = async (loc: string): Promise<number> =>
    ((await call('GET', '/v1/inventory/availability', OWNER, undefined, undefined, { productId: 'p-dal' })).body as { rows: { locationId: string; onHandMinor: number }[] }).rows.filter((r) => r.locationId === loc).reduce((n, r) => n + r.onHandMinor, 0);
  const receive = (grnId: string, userId: string, counted: number, key = grnId) => call('POST', `/v1/inventory/goods-receipt/${grnId}`, userId, {
    warehouseId: BACK, receivedOnDate: new Date().toISOString().slice(0, 10), currency: 'INR', poId: 'po-race',
    lines: [{ lineId: 'L1', productId: 'p-dal', orderedMinor: 100, countedMinor: counted, uom: 'ea', unitCost: { minor: COST, currency: 'INR' }, condition: 'good' }],
  }, key);
  return { call, onHand, receive };
}

// ── the backings: the in-memory store always; real PostgreSQL where DATABASE_URL is set ───────────────────────────────
const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });
const backings: { name: string; harness: () => ApiHarness }[] = [{ name: 'the in-memory event store', harness: () => apiHarness() }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });

describe.each(backings)('supplier to shelf, connected — on $name (Batch 2 acceptance)', ({ name, harness }) => {
  it('supplier → order → partial receipt with cold-chain holds → QC → bin → indent → issue from bin → short floor receipt → resolved → projections → three-way match and liability', async () => {
    const rows: JourneyRow[] = [];
    try {
      await journey(harness(), randomUUID(), rows);
    } finally {
      if (process.env['JOURNEY_TABLE'] !== undefined) {
        console.log(`\n${name}\n${rows.map((r) => `| ${r.step} | ${r.route} | ${r.expected} | ${r.actual} |`).join('\n')}`);
      }
    }
  }, 60_000);

  it('two receivers book 60 against the same order of 100 at the same moment: the order never receives more than 100 — the loser is refused by name (or, if the first had landed, judged on the 40 left)', async () => {
    const h = harness();
    const t = randomUUID();
    const { onHand, receive, call } = await raceSetup(h, t);
    const [a, b] = await Promise.all([receive('grn-a', RECEIVER, 60), receive('grn-b', 'u-recv2', 60)]);
    const statuses = [a.status, b.status].sort();
    if (statuses[0] === 201 && statuses[1] === 201) {
      expect(name).toBe('real PostgreSQL'); // only there can the first commit before the second reads the order
    } else {
      expect(statuses).toEqual([201, 409]);
      const lost = a.status === 409 ? a : b;
      expect(codeOf(lost)).toBe('concurrent_change');
      const again = await receive(lost === a ? 'grn-a' : 'grn-b', lost === a ? RECEIVER : 'u-recv2', 60, 'again');
      expect(again.status).toBe(201);
      expect((again.body as { grn: { availableMinor: number; heldMinor: number } }).grn).toMatchObject({ availableMinor: 40, heldMinor: 20 });
    }
    expect(((await call('GET', '/v1/purchase/orders/po-race', OWNER)).body as { order: { receivedByProduct: Record<string, number> } }).order.receivedByProduct).toEqual({ 'p-dal': 100 });
    expect(await onHand(BACK)).toBe(100);
  }, 60_000);

  it('two back-store workers issue the same back-store stock to two indents at once: never more than the back store holds — the loser is refused by name, nothing moved; and two counts of one issue cannot both land', async () => {
    const h = harness();
    const t = randomUUID();
    const { onHand, receive, call } = await raceSetup(h, t);
    expect((await receive('grn-1', RECEIVER, 50)).status).toBe(201);
    expect(await onHand(BACK)).toBe(50);
    for (const id of ['ind-a', 'ind-b']) {
      expect((await call('POST', `/v1/floor/indents/${id}`, FLOOR_ASK, { fromLocationId: BACK, toLocationId: FLOOR, lines: [{ productId: 'p-dal', quantityMinor: 40, uom: 'ea' }] }, id)).status).toBe(201);
      expect((await call('POST', `/v1/floor/indents/${id}/approval`, FLOOR_MGR, {}, `${id}-ok`)).status).toBe(200);
    }
    const [a, b] = await Promise.all([
      call('POST', '/v1/floor/indents/ind-a/issues/is-1', BACKSTORE, { lines: [{ productId: 'p-dal', quantityMinor: 40 }] }, 'is-a'),
      call('POST', '/v1/floor/indents/ind-b/issues/is-1', 'u-back2', { lines: [{ productId: 'p-dal', quantityMinor: 40 }] }, 'is-b'),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses[0]).toBe(201);
    const lost = a.status === 201 ? b : a;
    // the guard (409 concurrent_change), or — if the first had already landed — the engine on the true figure (422)
    expect(['concurrent_change', 'issue_refused']).toContain(codeOf(lost));
    expect(await onHand(BACK)).toBe(10);
    const inTransit = ((await call('GET', '/v1/inventory/availability', OWNER, undefined, undefined, { productId: 'p-dal' })).body as { inTransit: { quantityMinor: number }[] }).inTransit;
    expect(inTransit.reduce((n, r) => n + r.quantityMinor, 0)).toBe(40);

    // Two people count the same issue in at once, differently: one lands; the other is refused (by the guard) or told it is
    // already received — never a silent second count, never two receipts.
    const won = a.status === 201 ? 'ind-a' : 'ind-b';
    const [c1, c2] = await Promise.all([
      call('POST', `/v1/floor/indents/${won}/issues/is-1/receipt`, SHELF, { counted: [{ productId: 'p-dal', quantityMinor: 40 }] }, 'rc-1'),
      call('POST', `/v1/floor/indents/${won}/issues/is-1/receipt`, 'u-shelf2', { counted: [{ productId: 'p-dal', quantityMinor: 37 }] }, 'rc-2'),
    ]);
    const counts = [c1, c2];
    const landed = counts.filter((c) => c.status === 201);
    expect(landed).toHaveLength(1);
    const other = counts.find((c) => c !== landed[0])!;
    // refused by the guard, or by name because the other count had just landed — or (read after it landed) told it is received
    if (other.status === 409) expect(['concurrent_change', 'issue_already_received']).toContain(codeOf(other));
    else expect(other.body).toMatchObject({ alreadyReceived: true });
    const floor = await onHand(FLOOR);
    const landedCount = (landed[0]!.body as { indent: { totals: { receivedMinor: number } } }).indent.totals.receivedMinor;
    expect(floor).toBe(landedCount);
    const indent = (await call('GET', `/v1/floor/indents/${won}`, OWNER)).body as { totals: { receivedMinor: number; shortfallMinor: number } };
    expect(indent.totals.receivedMinor + indent.totals.shortfallMinor).toBe(40);
  }, 60_000);
});
