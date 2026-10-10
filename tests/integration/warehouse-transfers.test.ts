import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { STREAM } from '../../services/api/src/adapters';

// Warehouse-to-store & inter-store transfers (M09-FR-03, API-04) end to end through the real API. A
// transfer moves through an explicit IN-TRANSIT state held at the destination (the van is a place);
// dispatch needs a SEPARATE approver (§28) — since SP-4 (F07) the AUTHENTICATED dispatcher, never a name in the
// body — over head office's OWN stock at the source (never a claimed quantity); recalled/quarantined stock is never
// sent (moving a problem to another branch launders it); a receipt shortfall is a VALUED exception, never a
// silent adjustment; and allocation proposes by DAYS OF COVER, committing nothing.
//
// SP-5 (audit finding F05): every step now posts ONE effect to the M08 inventory projection every reader folds — dispatch
// takes the stock off the source's on-hand (in transit, visible at the destination, not sellable there); receipt puts what
// arrived on-hand at the destination WITH the value that left the source; a shortfall is listed on the exceptions read;
// a second transfer cannot draw stock the first already took; and both ends must be places head office knows.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const propose = (h: ApiHarness, t: string, u: string, id: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/warehouse/transfers/${id}`, userId: u, tenantId: t, idempotencyKey: key ?? `tr-${id}`, body });
const dispatch = (h: ApiHarness, t: string, u: string, id: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/warehouse/transfers/${id}/dispatch`, userId: u, tenantId: t, idempotencyKey: key ?? `td-${id}`, body });
const receive = (h: ApiHarness, t: string, u: string, id: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/warehouse/transfers/${id}/receive`, userId: u, tenantId: t, idempotencyKey: key ?? `trc-${id}`, body });
const readTransfer = (h: ApiHarness, t: string, u: string, id: string) =>
  h.request({ method: 'GET', path: `/v1/warehouse/transfers/${id}`, userId: u, tenantId: t });
const allocate = (h: ApiHarness, t: string, u: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: `/v1/warehouse/allocation/propose`, userId: u, tenantId: t, idempotencyKey: `al-${String(body.tag ?? '')}`, body });
const availability = async (h: ApiHarness, t = A, u = 'u-owner') =>
  (await h.request({ method: 'GET', path: '/v1/inventory/availability', userId: u, tenantId: t })).body as { rows: Row[]; inTransit: InTransit[] };
const valuation = async (h: ApiHarness) =>
  (await h.request({ method: 'GET', path: '/v1/inventory/valuation', userId: 'u-owner', tenantId: A })).body as { rows: ValRow[]; totalValueMinor: number };
const exceptions = async (h: ApiHarness) =>
  (await h.request({ method: 'GET', path: '/v1/inventory/exceptions', userId: 'u-owner', tenantId: A })).body as { negative: unknown[]; transferShortfalls: Record<string, unknown>[] };

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const whatHappened = (res: { body: unknown }): string => (res.body as { error: { whatHappened: string } }).error.whatHappened;
interface Row { productId: string; locationId: string; onHandMinor: number }
interface InTransit { transferId: string; productId: string; locationId: string; fromLocationId: string; quantityMinor: number }
interface ValRow { productId: string; locationId: string; onHandMinor: number; value: { minor: number }; unitCostMinor: number | 'not_known'; cogs: { minor: number }; transferredOut: { minor: number }; unvaluedMinor: number }
interface Disc { productId: string; differenceMinor: number; value: { minor: number } }

// The proposer's unit cost values the shortfall EXCEPTION only — the value that moves is head office's own (SP-5).
const LINE = { productId: 'P1', batchId: null, quantityMinor: 10, uom: 'EA', unitCost: { minor: 5_000, currency: 'INR' } };
const proposal = (over: Record<string, unknown> = {}) => ({ fromLocationId: 'WH', toLocationId: 'S1', lines: [LINE], ...over });
/** Head office's own stock at WH — the position the dispatch is checked against (SP-4, F07), costed or not. */
const stock = (h: ApiHarness, qty: number, batchId?: string, unitCostMinor?: number) =>
  h.request({ method: 'POST', path: '/v1/inventory/movements', userId: 'u-owner', tenantId: A, idempotencyKey: `seed-${qty}-${batchId ?? ''}`,
    body: { movementId: `seed-${qty}-${batchId ?? ''}`, productId: 'P1', locationId: 'WH', kind: 'received', quantityMinor: qty, uom: 'EA', occurredAt: '2026-08-01T00:00:00.000Z', enteredBy: 'u-owner', ...(batchId === undefined ? {} : { batchId }), ...(unitCostMinor === undefined ? {} : { unitCostMinor }) } });
/** SP-5: the places head office knows — the company, its warehouse WH and the store S1 under it (a draft branch is a place). */
async function places(h: ApiHarness, t = A, u = 'u-owner'): Promise<void> {
  const node = (id: string, body: Record<string, unknown>) => h.request({ method: 'POST', path: `/v1/org/nodes/${id}`, userId: u, tenantId: t, idempotencyKey: `org-${id}`, body });
  expect((await node('C1', { kind: 'company', name: 'SRE Retail' })).status).toBe(201);
  expect((await node('WH', { kind: 'warehouse', name: 'Central warehouse', parentId: 'C1', companyId: 'C1' })).status).toBe(201);
  expect((await node('S1', { kind: 'branch', name: 'Store 1', parentId: 'C1', companyId: 'C1' })).status).toBe(201);
}
/** The cast: the owner proposes, a store manager (a second person) dispatches. */
async function seeded(qty = 20, unitCostMinor?: number): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-boss', 'store_manager');
  await places(h);
  await stock(h, qty, undefined, unitCostMinor);
  return h;
}

describe('warehouse transfers: in-transit at destination, separate approver, valued shortfall, days-of-cover allocation (M09-FR-03)', () => {
  it('proposes, dispatches by a separate authenticated approver over head office\'s own stock, and holds it in transit — off the source, visible at the destination, not on-hand there (F05)', async () => {
    const h = await seeded(20);
    expect((await propose(h, A, 'u-owner', 't1', proposal())).status).toBe(201);

    // §28: the proposer dispatching is the proposer approving their own — refused.
    expect(codeOf(await dispatch(h, A, 'u-owner', 't1', {}, 'td-t1-self'))).toBe('transfer_refused');
    // SP-4 (F07): a body that still names an approver or claims stock is refused by name; nothing moves.
    expect(codeOf(await dispatch(h, A, 'u-boss', 't1', { approvedBy: 'u-boss' }, 'td-t1-claim'))).toBe('dispatch_carries_caller_claims');
    expect(codeOf(await dispatch(h, A, 'u-boss', 't1', { available: [{ productId: 'P1', batchId: null, quantityMinor: 999, state: 'on_hand' }] }, 'td-t1-claim2'))).toBe('dispatch_carries_caller_claims');
    expect((await availability(h)).rows).toEqual([expect.objectContaining({ locationId: 'WH', onHandMinor: 20 })]);

    const d = await dispatch(h, A, 'u-boss', 't1', {});
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({ state: 'in_transit', approvedBy: 'u-boss', posted: ['t1-out-1'], availableChecked: [{ productId: 'P1', quantityMinor: 20, state: 'on_hand', recalled: false }] });
    expect((await readTransfer(h, A, 'u-owner', 't1')).body).toMatchObject({ state: 'in_transit', requestedBy: 'u-owner', approvedBy: 'u-boss' });

    // SP-5 (F05): the 10 have LEFT the warehouse's on-hand and are on the van — in transit AT the store, where they are
    // visible but not on-hand, so nothing can sell them before they arrive (M08-FR-02).
    const after = await availability(h);
    expect(after.rows).toEqual([expect.objectContaining({ productId: 'P1', locationId: 'WH', onHandMinor: 10 })]);
    expect(after.inTransit).toEqual([expect.objectContaining({ transferId: 't1', productId: 'P1', locationId: 'S1', fromLocationId: 'WH', quantityMinor: 10 })]);

    // The over-draw is checked against the STORED position, which just fell: a second transfer of 15 finds only 10.
    await propose(h, A, 'u-owner', 't1b', proposal({ lines: [{ ...LINE, quantityMinor: 15 }] }));
    const twice = await dispatch(h, A, 'u-boss', 't1b', {});
    expect(codeOf(twice)).toBe('transfer_refused');
    expect(whatHappened(twice)).toMatch(/only 10 of P1 available to send, not 15/);
    expect((await availability(h)).rows[0]).toMatchObject({ locationId: 'WH', onHandMinor: 10 });
  });

  it('refuses an over-draw against head office\'s stock, a recalled batch, and a batch under a quality hold', async () => {
    const h = await seeded(5); // only 5 at WH
    await propose(h, A, 'u-owner', 't1', proposal());
    const short = await dispatch(h, A, 'u-boss', 't1', {}, 'td-short');
    expect(codeOf(short)).toBe('transfer_refused');
    expect(whatHappened(short)).toMatch(/only 5 of P1 available to send, not 10/);

    // A batch head office has RECALLED is never sent, however much of it there is.
    await stock(h, 50, 'B-RECALLED');
    expect((await h.request({ method: 'POST', path: '/v1/quality/recalls/B-RECALLED', userId: 'u-owner', tenantId: A, idempotencyKey: 'rc-1', body: { reason: 'contamination notice' } })).status).toBeLessThan(300);
    await propose(h, A, 'u-owner', 't2', proposal({ lines: [{ ...LINE, batchId: 'B-RECALLED' }] }));
    const recalled = await dispatch(h, A, 'u-boss', 't2', {}, 'td-r');
    expect(codeOf(recalled)).toBe('transfer_refused');
    expect(whatHappened(recalled)).toMatch(/recalled/);

    // A batch under a quality HOLD is never sent either.
    await stock(h, 50, 'B-HELD');
    expect((await h.request({ method: 'POST', path: '/v1/quality/holds/B-HELD', userId: 'u-owner', tenantId: A, idempotencyKey: 'qh-1', body: { productId: 'P1', reason: 'temperature excursion' } })).status).toBeLessThan(300);
    await propose(h, A, 'u-owner', 't3', proposal({ lines: [{ ...LINE, batchId: 'B-HELD' }] }));
    const held = await dispatch(h, A, 'u-boss', 't3', {}, 'td-q');
    expect(codeOf(held)).toBe('transfer_refused');
    expect(whatHappened(held)).toMatch(/quarantine/);
    // Nothing moved for any of the three: the warehouse still holds all 105.
    expect((await availability(h)).rows.reduce((s, r) => s + r.onHandMinor, 0)).toBe(105);
    expect((await availability(h)).inTransit).toEqual([]);
  });

  it('receives what arrived and raises a valued shortfall for what did not — on-hand at the destination, the shortfall on the exceptions read (F05)', async () => {
    const h = await seeded(20);
    await propose(h, A, 'u-owner', 't1', proposal());
    await dispatch(h, A, 'u-boss', 't1', {});

    const r = await receive(h, A, 'u-owner', 't1', { counted: [{ productId: 'P1', batchId: null, quantityMinor: 8 }] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ state: 'received', posted: ['t1-recv-1'] });
    const discs = (r.body as { discrepancies: Disc[] }).discrepancies;
    expect(discs).toHaveLength(1);
    expect(discs[0]).toMatchObject({ productId: 'P1', differenceMinor: -2 });
    expect(discs[0]?.value.minor).toBe(10_000);   // 2 missing × ₹50.00

    // SP-5 (F05): 8 are on-hand at the store, 10 left the warehouse, nothing is in transit — and the 2 that vanished are
    // NOT quietly absorbed anywhere: they are a valued exception with an owner, beside negative stock.
    const after = await availability(h);
    expect(after.rows).toEqual([
      expect.objectContaining({ productId: 'P1', locationId: 'S1', onHandMinor: 8 }),
      expect.objectContaining({ productId: 'P1', locationId: 'WH', onHandMinor: 10 }),
    ]);
    expect(after.inTransit).toEqual([]);
    const ex = await exceptions(h);
    expect(ex.negative).toEqual([]);
    expect(ex.transferShortfalls).toEqual([expect.objectContaining({ transferId: 't1', productId: 'P1', fromLocationId: 'WH', locationId: 'S1', dispatchedMinor: 10, receivedMinor: 8, differenceMinor: -2, value: { minor: 10_000, currency: 'INR' } })]);
    expect(ex.transferShortfalls[0]?.['detail']).toMatch(/did not arrive/);

    // A retry with the same key is the same answer; a re-keyed retry is refused by the engine (already received) — and
    // neither posts the 8 a second time.
    expect((await receive(h, A, 'u-owner', 't1', { counted: [{ productId: 'P1', batchId: null, quantityMinor: 8 }] })).status).toBe(200);
    expect(codeOf(await receive(h, A, 'u-owner', 't1', { counted: [{ productId: 'P1', batchId: null, quantityMinor: 8 }] }, 'trc-t1-again'))).toBe('transfer_refused');
    expect((await availability(h)).rows.find((x) => x.locationId === 'S1')?.onHandMinor).toBe(8);
  });

  it('Batch 2 round 2: the person who DISPATCHED a transfer cannot count it in — refused by name, nothing received; a different person can', async () => {
    const h = await seeded(20);
    await propose(h, A, 'u-owner', 't1', proposal());
    await dispatch(h, A, 'u-boss', 't1', {});
    const self = await receive(h, A, 'u-boss', 't1', { counted: [{ productId: 'P1', batchId: null, quantityMinor: 10 }] });
    expect(self.status).toBe(422);
    expect(codeOf(self)).toBe('dispatcher_cannot_receive');
    expect((await availability(h)).inTransit).toEqual([expect.objectContaining({ transferId: 't1', quantityMinor: 10 })]);
    expect((await receive(h, A, 'u-owner', 't1', { counted: [{ productId: 'P1', batchId: null, quantityMinor: 10 }] }, 'trc-t1-other')).status).toBe(200);
  });

  it('Batch 2: a plain transfer\'s shortfall is RESOLVED by a third person, once — 1 found at the store (a two-person adjustment), 1 lost at its value; the exception stays, marked resolved', async () => {
    const h = await seeded(20, 5_000);
    await h.provisionRole(A, 'u-store', 'store_manager');
    await h.provisionRole(A, 'u-area', 'store_manager');
    await propose(h, A, 'u-owner', 't1', proposal());
    await dispatch(h, A, 'u-boss', 't1', {});
    expect((await receive(h, A, 'u-store', 't1', { counted: [{ productId: 'P1', batchId: null, quantityMinor: 8 }] })).status).toBe(200);
    const resolve = (u: string, body: Record<string, unknown>, key: string) =>
      h.request({ method: 'POST', path: '/v1/warehouse/transfers/t1/shortfall/resolution', userId: u, tenantId: A, idempotencyKey: key, body });
    const body = { lines: [{ productId: 'P1', batchId: null, foundMinor: 1 }], reasonCode: 'miscount', note: 'one carton was behind the cold-room door' };
    expect(codeOf(await resolve('u-store', body, 'r-counter'))).toBe('counter_cannot_resolve');
    expect(codeOf(await resolve('u-boss', body, 'r-sender'))).toBe('issuer_cannot_resolve');
    expect(codeOf(await resolve('u-area', { ...body, lines: [{ productId: 'P1', batchId: null, foundMinor: 3 }] }, 'r-over'))).toBe('more_found_than_missing');
    const ok = await resolve('u-area', body, 'r-ok');
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ resolution: { resolvedBy: 'u-area', lines: [{ missingMinor: 2, foundMinor: 1, foundAtLocationId: 'S1', lostMinor: 1, lostValueMinor: 5_000 }] }, posted: [expect.objectContaining({ kind: 'adjusted', quantityMinor: 1, locationId: 'S1', enteredBy: 'u-store', approvedBy: 'u-area' })] });
    // Finance's shape (Batch 3 posts the inventory-loss journal from it): the lost unit at the cost it LEFT the warehouse with.
    const ev = await h.store.readStream(A, [STREAM.warehouse, 'transfers'].join('\u001f'), { type: 'TransferShortfallResolved' });
    expect((ev.at(-1)!.event.payload as { loss: unknown }).loss).toMatchObject({ source: 'transfer', transferId: 't1', indentId: null, fromLocationId: 'WH', toLocationId: 'S1', resolvedBy: 'u-area', reasonCode: 'miscount', lines: [{ productId: 'P1', uom: 'EA', lostMinor: 1, unitCostMinor: 5_000, lostValueMinor: 5_000 }], lostValueMinor: 5_000 });
    expect((await resolve('u-area', body, 'r-ok-again')).body).toMatchObject({ alreadyResolved: true });
    expect(codeOf(await resolve('u-area', { ...body, lines: [] }, 'r-different'))).toBe('shortfall_already_resolved');
    expect((await availability(h)).rows.find((x) => x.locationId === 'S1')?.onHandMinor).toBe(9);
    const ex = await exceptions(h);
    expect(ex.transferShortfalls).toEqual([expect.objectContaining({ transferId: 't1', differenceMinor: -2, resolution: expect.objectContaining({ resolvedBy: 'u-area', foundMinor: 1, lostMinor: 1, lostValueMinor: 5_000 }) })]);
    // A transfer not yet received has nothing to resolve.
    await propose(h, A, 'u-owner', 't2', proposal());
    expect(codeOf(await h.request({ method: 'POST', path: '/v1/warehouse/transfers/t2/shortfall/resolution', userId: 'u-area', tenantId: A, idempotencyKey: 'r-t2', body }))).toBe('transfer_not_received');
  });

  it('the value follows the stock: it leaves the source at head office\'s own average as MOVED (not sold) and arrives at the destination at that cost (F05, M08-FR-04)', async () => {
    const h = await seeded(20, 5_000); // 20 @ ₹50.00 at WH — head office's cost; the proposer's ₹50.00 on the line is NOT what is used
    await propose(h, A, 'u-owner', 't1', proposal({ lines: [{ ...LINE, unitCost: { minor: 1, currency: 'INR' } }] }));
    const d = await dispatch(h, A, 'u-boss', 't1', {});
    expect(d.body).toMatchObject({ lineCostsMinor: [5_000] });
    expect((await readTransfer(h, A, 'u-owner', 't1')).body).toMatchObject({ lineCostsMinor: [5_000] });
    // At dispatch: WH is down ₹500 of stock, booked as transferred out — COGS did not move, nothing was sold.
    let v = await valuation(h);
    expect(v.rows).toEqual([expect.objectContaining({ locationId: 'WH', onHandMinor: 10, value: { minor: 50_000, currency: 'INR' }, unitCostMinor: 5_000, transferredOut: { minor: 50_000, currency: 'INR' }, cogs: { minor: 0, currency: 'INR' } })]);
    expect(v.totalValueMinor).toBe(50_000);

    await receive(h, A, 'u-owner', 't1', { counted: [{ productId: 'P1', batchId: null, quantityMinor: 10 }] });
    // At receipt: S1 holds 10 worth ₹500 at ₹50.00 — the value that left is the value that arrived; the shop's stock is
    // ₹1 000 in all, exactly what it was, and no COGS anywhere.
    v = await valuation(h);
    expect(v.rows).toEqual([
      expect.objectContaining({ locationId: 'S1', onHandMinor: 10, value: { minor: 50_000, currency: 'INR' }, unitCostMinor: 5_000, unvaluedMinor: 0 }),
      expect.objectContaining({ locationId: 'WH', onHandMinor: 10, value: { minor: 50_000, currency: 'INR' }, unitCostMinor: 5_000 }),
    ]);
    expect(v.totalValueMinor).toBe(100_000);
    expect(v.rows.reduce((s, r) => s + r.cogs.minor, 0)).toBe(0);
    // Stock productivity reads the same ledger: the transfer added nothing to the period's cost of goods sold.
    const perf = (await h.request({ method: 'GET', path: '/v1/inventory/performance', userId: 'u-owner', tenantId: A, query: { from: '2026-07-01T00:00:00.000Z', to: '2026-12-31T00:00:00.000Z' } })).body as { cogs: { minor: number } };
    expect(perf.cogs.minor).toBe(0);
  });

  it('stock the source never costed arrives unvalued — said, never priced at the proposer\'s guess (P-08)', async () => {
    const h = await seeded(20); // no cost at WH
    await propose(h, A, 'u-owner', 't1', proposal());
    expect((await dispatch(h, A, 'u-boss', 't1', {})).body).toMatchObject({ lineCostsMinor: [null] });
    await receive(h, A, 'u-owner', 't1', { counted: [{ productId: 'P1', batchId: null, quantityMinor: 10 }] });
    const v = await valuation(h);
    expect(v.rows.find((r) => r.locationId === 'S1')).toMatchObject({ onHandMinor: 10, unvaluedMinor: 10, unitCostMinor: 'not_known', value: { minor: 0, currency: 'INR' } });
  });

  it('both ends must be places head office knows — an org node, a bin\'s location or a location that has held stock; a mistyped destination is refused by name (SP-5)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-boss', 'store_manager');
    await stock(h, 20); // WH is known only because it has held stock
    // S1 is nowhere yet: refused, and nothing recorded.
    const unknown = await propose(h, A, 'u-owner', 't0', proposal());
    expect(unknown.status).toBe(422);
    expect(codeOf(unknown)).toBe('unknown_location');
    expect(whatHappened(unknown)).toMatch(/toLocationId "S1"/);
    expect((await readTransfer(h, A, 'u-owner', 't0')).status).toBe(404);
    expect(codeOf(await propose(h, A, 'u-owner', 't0b', proposal({ fromLocationId: 'WHX' })))).toBe('unknown_location');
    // A bin registered for S1 makes it a place; so would an org node or stock there.
    expect((await h.request({ method: 'POST', path: '/v1/warehouse/bins/S1-A1', userId: 'u-owner', tenantId: A, idempotencyKey: 'bin-s1', body: { storeId: 'S1', capacityMinor: 100, pickable: true } })).status).toBe(201);
    expect((await propose(h, A, 'u-owner', 't1', proposal())).status).toBe(201);
    // A location known through the org structure alone (no stock, no bin) is a place too.
    await places(h);
    expect((await h.request({ method: 'POST', path: '/v1/org/nodes/S2', userId: 'u-owner', tenantId: A, idempotencyKey: 'org-S2', body: { kind: 'branch', name: 'Store 2', parentId: 'C1', companyId: 'C1' } })).status).toBe(201);
    expect((await propose(h, A, 'u-owner', 't2', proposal({ toLocationId: 'S2' }))).status).toBe(201);
  });

  it('proposes allocation by days of cover when stock is scarce', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    // 100 available, 120 needed → scarce; share by rate of sale so each branch gets similar days.
    const out = (await allocate(h, A, 'u-owner', {
      productId: 'P1', fromLocationId: 'WH', availableMinor: 100,
      needs: [{ locationId: 'S1', shortfallMinor: 60, dailyDemandMinor: 5 }, { locationId: 'S2', shortfallMinor: 60, dailyDemandMinor: 50 }],
      tag: 'scarce',
    })).body as { proposals: { toLocationId: string; quantityMinor: number }[] };
    const s2 = out.proposals.find((p) => p.toLocationId === 'S2');
    const s1 = out.proposals.find((p) => p.toLocationId === 'S1');
    expect((s2?.quantityMinor ?? 0) + (s1?.quantityMinor ?? 0)).toBe(100);   // nothing stranded
    expect(s2!.quantityMinor).toBeGreaterThan(s1!.quantityMinor);            // the faster seller gets more
  });

  it('is authorized (move vs read), per-tenant, and refuses duplicate/unknown', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-mgr', 'store_manager');   // proposes/dispatches/reads
    await h.provisionRole(A, 'u-cash', 'cashier');        // neither
    await places(h);
    await propose(h, A, 'u-mgr', 't1', proposal());

    expect((await propose(h, A, 'u-cash', 't2', proposal())).status).toBe(403);
    expect((await dispatch(h, A, 'u-cash', 't1', {}, 'td-cash')).status).toBe(403);
    expect((await readTransfer(h, A, 'u-cash', 't1')).status).toBe(403);
    expect(codeOf(await propose(h, A, 'u-owner', 't1', proposal(), 'tr-t1-again'))).toBe('transfer_already_exists');
    expect((await readTransfer(h, A, 'u-owner', 'ghost')).status).toBe(404);

    // Another tenant sees neither the transfer nor its stock effects.
    await h.seedOwner(B, 'u-owner-b');
    expect((await readTransfer(h, B, 'u-owner-b', 't1')).status).toBe(404);
    expect((await availability(h, B, 'u-owner-b')).rows).toEqual([]);
    expect((await availability(h, B, 'u-owner-b')).inTransit).toEqual([]);
  });
});
