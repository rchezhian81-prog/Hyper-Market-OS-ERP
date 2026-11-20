import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ApiHarness } from '../support/api-harness';
import { useBackings } from '../support/backings';
import { makeEvent } from '../../packages/contracts/src/event';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';
import { STREAM, streamName } from '../../services/api/src/adapters';

/**
 * **Batch 20b — the stock pages' history reads, on the in-memory event store and, with DATABASE_URL, on real PostgreSQL.**
 *
 *   • S2 (M28-FR-01 · M08-FR-03): earlier write-offs by date range and item, with the total and the totals by kind of loss;
 *     an unreadable range is refused in plain words.
 *   • S3 (M09-FR-04): earlier counts by date range — each by its number (its own `CNT…`, or its plan's) — and the count
 *     accuracy; a recounted count is not counted twice; a store manager sees only their own branch.
 *   • S4 (M08-FR-04): what the empty shelves cost — the days empty, the normal sales, the estimated sales and margin lost;
 *     "not known" with the reason where it cannot be worked out; an estimate, and nothing is written.
 *   • S5 (M09-FR-03): suggested transfers, structured, both ends in the reader's branches; nothing moves.
 *   • A2: each item's GST rate from the published catalogue, for typing a paper bill (null when none is held).
 *   • Count review: an applied held write-off on a count plan says its WOF number.
 */

type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
/** A moment `n` shop days before the shop's today, at `hour` o'clock India time — so the shop dates never drift with the UTC hour. */
const daysAgo = (n: number, hour = 11): string => {
  const d = new Date(`${shopDateIn(new Date().toISOString())}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return new Date(`${d.toISOString().slice(0, 10)}T${String(hour).padStart(2, '0')}:00:00.000+05:30`).toISOString();
};

describe.each(useBackings())('Batch 20b: stock history reads — on $name', ({ harness }) => {
  it('earlier write-offs, earlier counts and accuracy, the empty shelves\' cost, suggested transfers, item GST rates', async () => {
    const h: ApiHarness = harness();
    const T = randomUUID();
    const today = shopDateIn(new Date().toISOString());
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-till', 'cashier');
    await h.provisionRole(T, 'u-mgr', 'store_manager', ['S1']);
    const req = (method: 'GET' | 'POST', path: string, body?: unknown, userId = 'u-owner', query?: Record<string, string>): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(userId === 'u-mgr' ? { branchId: 'S1' } : {}), ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
    for (const [id, body] of [
      ['C1', { kind: 'company', name: 'SRE Retail' }],
      ['S1', { kind: 'branch', name: 'Store 1', parentId: 'C1', companyId: 'C1' }],
      ['S1-BACK', { kind: 'warehouse', name: 'Store 1 back store', parentId: 'S1', companyId: 'C1' }],
      ['WH', { kind: 'warehouse', name: 'Head office warehouse', parentId: 'C1', companyId: 'C1' }],
      ['S2', { kind: 'branch', name: 'Store 2', parentId: 'C1', companyId: 'C1' }],
    ] as const) expect((await req('POST', `/v1/org/nodes/${id}`, body)).status).toBe(201);
    // The published catalogue: OIL at 5% GST, RICE at 0%; SALT has no rate held.
    await h.store.append(T, STREAM.catalogue, makeEvent({
      id: `pack-${T}-b20b`, type: 'CataloguePublished', occurredAt: daysAgo(40), idempotencyKey: `catalogue-${T}-b20b`, source: 'test/catalogue',
      payload: { snapshot: { tenantId: T, version: 1, builtAt: daysAgo(40), scope: { tenantId: T, storeId: 'S1' }, barcodes: [], products: [
        { productId: 'OIL', sku: 'OIL', name: 'Sunflower oil 1L', unitPriceMinor: 2_000, taxBps: 500, status: 'active', baseUom: 'ea' },
        { productId: 'RICE', sku: 'RICE', name: 'Ponni rice 1kg', unitPriceMinor: 6_000, taxBps: 0, status: 'active', baseUom: 'ea' },
      ] } },
    }));
    const move = async (id: string, productId: string, locationId: string, kind: string, qty: number, at: string, cost?: number) => {
      const r = await req('POST', '/v1/inventory/movements', { movementId: id, productId, locationId, kind, quantityMinor: qty, uom: 'ea', occurredAt: at, enteredBy: 'u-owner', ...(cost === undefined ? {} : { unitCostMinor: cost }) });
      expect(r.status, JSON.stringify(r.body)).toBe(202);
    };
    const sell = async (saleId: string, loc: string, p: string, q: number, at: string, price = 2_000) => {
      const r = await req('POST', '/v1/sales', {
        saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', locationId: loc, cashierId: 'u-till', tradingDay: shopDateIn(at), committedAt: at,
        totalMinor: q * price, currency: 'INR', packVersion: 1, lines: [{ productId: p, quantityMinor: q, uom: 'ea', unitPriceMinor: price, lineTotalMinor: q * price }], tenders: [{ kind: 'cash', amountMinor: q * price }],
      }, 'u-till');
      expect(r.status, JSON.stringify(r.body)).toBe(202);
    };

    // ── S4: OIL at S1 — 10 in 20 days ago, 2 sold on each of five days, then empty; 10 more in 10 days ago, none sold since.
    await move('rx-oil-1', 'OIL', 'S1', 'received', 10, daysAgo(20, 2), 1_000);
    for (const n of [20, 19, 18, 17, 16]) await sell(`s-oil-${n}`, 'S1', 'OIL', 2, daysAgo(n, 8));
    await move('rx-oil-2', 'OIL', 'S1', 'received', 10, daysAgo(10, 8), 1_000);
    // SALT at S1: in and sold out 40 days ago — empty every day of the period (its normal sales are not known).
    await move('rx-salt', 'SALT', 'S1', 'received', 1, daysAgo(40, 2), 500);
    await move('sd-salt', 'SALT', 'S1', 'sold', 1, daysAgo(40, 3));
    // DAL at S1: no GST rate held, sold out 5 days ago — its margin is not known.
    await move('rx-dal', 'DAL', 'S1', 'received', 1, daysAgo(5, 2), 500);
    await sell('s-dal', 'S1', 'DAL', 1, daysAgo(5, 9), 900);
    const onHandNow = async () => ((await req('GET', '/v1/inventory/availability')).body as { rows: { productId: string; locationId: string; onHandMinor: number }[] }).rows.map((r) => `${r.productId}@${r.locationId}=${r.onHandMinor}`).sort();
    const before = await onHandNow();
    const so = await req('GET', '/v1/inventory/stockout-estimate', undefined, 'u-owner', { days: '28' });
    expect(so.status, JSON.stringify(so.body)).toBe(200);
    const est = so.body as { isEstimate: boolean; days: number; from: string; to: string; rows: { productId: string; locationId: string; daysCarried: number; daysEmpty: number; normalDailyMinor: number | null; lostUnitsMinor: number | null; lostMarginMinor: number | null; notKnownBecause: string | null }[]; knownLostMarginMinor: number; notKnownCount: number; basis: Record<string, string> };
    expect([est.isEstimate, est.days, est.to]).toEqual([true, 28, today]);
    const oil = est.rows.find((r) => r.productId === 'OIL')!;
    // 21 days carried; empty from the day after the last sale until (and including) the day the new stock came in: 6 days.
    expect([oil.daysCarried, oil.daysEmpty, oil.normalDailyMinor, oil.lostUnitsMinor, oil.notKnownBecause]).toEqual([21, 6, 1, 4, null]);
    // Margin each is head office's GMROI margin over the same days ÷ what sold: 4 lost × that.
    const perf = (await req('GET', '/v1/inventory/performance', undefined, 'u-owner', { from: new Date(`${est.from}T00:00:00.000+05:30`).toISOString(), to: new Date().toISOString() })).body as { byProduct: { productId: string; grossMargin: { minor: number } | null }[] };
    const gm = perf.byProduct.find((p) => p.productId === 'OIL')!.grossMargin!.minor;
    expect(gm).toBeGreaterThan(0);
    expect(oil.lostMarginMinor).toBe(Math.round((4 * gm) / 10));
    const salt = est.rows.find((r) => r.productId === 'SALT')!;
    expect([salt.daysCarried, salt.daysEmpty, salt.normalDailyMinor, salt.lostMarginMinor, salt.notKnownBecause]).toEqual([28, 28, null, null, 'empty_every_day']);
    const dal = est.rows.find((r) => r.productId === 'DAL')!;
    expect([dal.daysCarried, dal.daysEmpty, dal.lostUnitsMinor, dal.lostMarginMinor, dal.notKnownBecause]).toEqual([6, 5, 5, null, 'margin_not_held']);
    // The worked-out figure first; the two not worked out are counted beside the total, never summed as zero.
    expect(est.rows.map((r) => r.productId)).toEqual(['OIL', 'SALT', 'DAL']);
    expect(est.knownLostMarginMinor).toBe(oil.lostMarginMinor);
    expect(est.notKnownCount).toBe(2);
    expect(est.basis['emptyDay']).toMatch(/none at the start of the day and nothing of it was sold that day/);
    expect(await onHandNow(), 'an estimate writes nothing').toEqual(before);
    expect(codeOf(await req('GET', '/v1/inventory/stockout-estimate', undefined, 'u-owner', { days: '3' }))).toBe('not_readable_as_a_period');

    // ── S5: OIL out at S2 (sold there), held at store 1 (10) and its back store (6); RICE out at S1, held only at WH.
    await move('rx-oil-s2', 'OIL', 'S2', 'received', 1, daysAgo(2, 2), 1_000);
    await sell('s-oil-s2', 'S2', 'OIL', 1, daysAgo(1, 8));
    await move('rx-oil-back', 'OIL', 'S1-BACK', 'received', 6, daysAgo(2, 2), 1_000);
    await move('rx-rice-s1', 'RICE', 'S1', 'received', 1, daysAgo(2, 2), 4_000);
    await sell('s-rice', 'S1', 'RICE', 1, daysAgo(1, 9), 6_000);
    await move('rx-rice-wh', 'RICE', 'WH', 'received', 12, daysAgo(2, 2), 4_000);
    const ts = (await req('GET', '/v1/inventory/transfer-suggestions')).body as { suggestionOnly: boolean; suggestions: { productId: string; fromLocationId: string; toLocationId: string; fromKind: string; heldAtSourceMinor: number; soldHereLast7DaysMinor: number }[] };
    expect(ts.suggestionOnly).toBe(true);
    expect(ts.suggestions.map((s) => [s.productId, s.fromLocationId, s.toLocationId, s.fromKind, s.heldAtSourceMinor, s.soldHereLast7DaysMinor])).toEqual([
      ['OIL', 'S1', 'S2', 'another_store', 10, 1], // store 1 holds the most of the other stores' stock
      ['RICE', 'WH', 'S1', 'head_office_warehouse', 12, 1],
    ]);
    // The store-1 manager is told neither: each has an end outside store 1's branch (least privilege).
    const mine = (await req('GET', '/v1/inventory/transfer-suggestions', undefined, 'u-mgr')).body as { suggestions: unknown[] };
    expect(mine.suggestions, JSON.stringify(mine)).toEqual([]);
    expect(await h.store.readStream(T, 'warehouse\u001ftransfers'), 'a suggestion moves nothing').toHaveLength(0);

    // ── S2: write-offs — two from earlier days (on the register as saved then), one saved today through the route.
    const woStream = streamName(STREAM.inventory, 'write-offs');
    for (const [id, n, num, loss, value] of [['wo-old-1', 12, 'WOF1/26-27/00001', 'expiry', 30_000], ['wo-old-2', 3, 'WOF1/26-27/00002', 'damage', 4_000]] as const) {
      await h.store.append(T, woStream, makeEvent({ id: `wo-${id}`, type: 'WriteOffCommitted', occurredAt: daysAgo(n), idempotencyKey: `wo-${T}-${id}`, source: 'test',
        payload: { id, documentNumber: num, productId: 'OIL', locationId: 'S1', lossType: loss, qtyRemoved: 1, uom: 'ea', valueMinor: value, currency: 'INR', reasonCode: loss, requiredApproval: false, evidenceRef: null, raisedBy: 'u-mgr', approvedBy: null, at: daysAgo(n), valueSource: 'stock_cost' } }));
    }
    const wNow = await req('POST', '/v1/inventory/write-off/wo-today', { productId: 'OIL', locationId: 'S1', qty: 1, uom: 'ea', lossType: 'damage', reasonCode: 'damage' }, 'u-mgr');
    expect(wNow.status, JSON.stringify(wNow.body)).toBe(201);
    const woRange = async (from: string, to: string, productId?: string) => (await req('GET', '/v1/inventory/write-offs', undefined, 'u-mgr', { from, to, ...(productId === undefined ? {} : { productId }) })).body as { count: number; totalLossMinor: number; byLossType: Record<string, { count: number; valueMinor: number }>; writeOffs: { id: string; documentNumber?: string }[] };
    const all = await woRange(shopDateIn(daysAgo(30)), today);
    expect(all.writeOffs.map((w) => w.id).sort()).toEqual(['wo-old-1', 'wo-old-2', 'wo-today']);
    const earlier = await woRange(shopDateIn(daysAgo(14)), shopDateIn(daysAgo(2)));
    expect(earlier.writeOffs.map((w) => [w.id, w.documentNumber])).toEqual([['wo-old-1', 'WOF1/26-27/00001'], ['wo-old-2', 'WOF1/26-27/00002']]);
    expect([earlier.count, earlier.totalLossMinor, earlier.byLossType]).toEqual([2, 34_000, { expiry: { count: 1, valueMinor: 30_000 }, damage: { count: 1, valueMinor: 4_000 } }]);
    expect((await woRange(shopDateIn(daysAgo(14)), today, 'RICE')).count).toBe(0);
    const backwards = await req('GET', '/v1/inventory/write-offs', undefined, 'u-mgr', { from: today, to: shopDateIn(daysAgo(3)) });
    expect([backwards.status, codeOf(backwards)]).toEqual([400, 'not_readable_as_a_date_range']);

    // ── S3: counts — an earlier planned count (its plan's number; recounted once), an earlier unnumbered one, one today.
    const countsStream = streamName(STREAM.inventory, 'counts');
    await h.store.append(T, streamName(STREAM.inventory, 'count-plans'), makeEvent({ id: 'count-plan-p1-created', type: 'CountPlanRecorded', occurredAt: daysAgo(6), idempotencyKey: `cp-${T}-p1`, source: 'test',
      payload: { step: 'created', plan: { planId: 'p1', documentNumber: 'CNT1/26-27/00007', locationId: 'S1', productIds: ['RICE'], frozenKinds: ['adjusted'], recountThresholdMinor: 0, note: null, plannedBy: 'u-owner', plannedAt: daysAgo(6), state: 'counting' } } }));
    const rec = (countId: string, n: number, extra: Record<string, unknown>) => h.store.append(T, countsStream, makeEvent({ id: `count-${countId}`, type: 'CountReconciled', occurredAt: daysAgo(n), idempotencyKey: `count-${T}-${countId}`, source: 'test',
      payload: { countId, productId: 'RICE', locationId: 'S1', expectedMinor: 10, countedMinor: 10, varianceMinor: 0, valueMinor: 0, currency: 'INR', reasonCode: 'cycle_count', reconciled: true, adjusted: false, requiredApproval: false, counterId: 'u-mgr', approvedBy: null, at: daysAgo(n), ...extra } }));
    await rec('c-p1-a', 6, { planId: 'p1', expectedMinor: 10, countedMinor: 7, varianceMinor: -3, valueMinor: 12_000 });
    await rec('c-p1-b', 6, { planId: 'p1', recountOf: 'c-p1-a', expectedMinor: 10, countedMinor: 8, varianceMinor: -2, valueMinor: 8_000, requiredApproval: true });
    await rec('c-old', 9, {});
    await rec('c-s2', 4, { locationId: 'S2' });
    const cNow = await req('POST', '/v1/inventory/counts/c-today', { productId: 'OIL', locationId: 'S1', uom: 'ea', countedMinor: 6, reasonCode: 'cycle_count' }, 'u-mgr');
    expect(cNow.status, JSON.stringify(cNow.body)).toBeLessThan(300);
    const hist = await req('GET', '/v1/inventory/count-history', undefined, 'u-owner', { from: shopDateIn(daysAgo(29)), to: today });
    expect(hist.status, JSON.stringify(hist.body)).toBe(200);
    const hb = hist.body as { counts: { countId: string; documentNumber: string | null; varianceMinor: number; valueMinor: number | null }[]; accuracy: Record<string, number | null> };
    expect(hb.counts.map((c) => [c.countId, c.documentNumber])).toEqual([
      ['c-today', (cNow.body as { documentNumber: string }).documentNumber], ['c-s2', null], ['c-p1-b', 'CNT1/26-27/00007'], ['c-old', null],
    ]);
    expect((cNow.body as { documentNumber: string }).documentNumber).toMatch(/^CNT\d\/\d\d-\d\d\/\d{5}$/);
    // Four counts stand (the recounted one is not counted twice): c-s2 and c-old matched; c-p1-b short 2 (₹80); today's per head office.
    const today1 = hb.counts[0]!;
    expect(hb.accuracy['counts']).toBe(4);
    expect(hb.accuracy['matched']).toBe(2 + (today1.varianceMinor === 0 ? 1 : 0));
    expect(hb.accuracy['exactBp']).toBe(Math.round(((hb.accuracy['matched'] as number) * 10_000) / 4));
    // The store-1 manager sees only store 1's counts (c-s2 is store 2's).
    const mgr = (await req('GET', '/v1/inventory/count-history', undefined, 'u-mgr', { from: shopDateIn(daysAgo(29)), to: today })).body as { counts: { countId: string }[] };
    expect(mgr.counts.map((c) => c.countId)).toEqual(['c-today', 'c-p1-b', 'c-old']);
    const narrow = (await req('GET', '/v1/inventory/count-history', undefined, 'u-owner', { from: shopDateIn(daysAgo(7)), to: shopDateIn(daysAgo(5)) })).body as { counts: { countId: string }[] };
    expect(narrow.counts.map((c) => c.countId)).toEqual(['c-p1-b']);
    expect(codeOf(await req('GET', '/v1/inventory/count-history', undefined, 'u-owner', { from: 'last week', to: today }))).toBe('not_readable_as_a_date_range');
    // A cashier holds neither read.
    expect((await req('GET', '/v1/inventory/count-history', undefined, 'u-till')).status).toBe(403);

    // ── A2: each item's GST rate from the published catalogue; an item with none held is null.
    const rates = await req('GET', '/v1/catalogue/item-gst-rates', undefined, 'u-mgr', { productIds: 'OIL,RICE,SALT' });
    expect(rates.status, JSON.stringify(rates.body)).toBe(200);
    expect((rates.body as { rates: Record<string, number | null> }).rates).toEqual({ OIL: 500, RICE: 0, SALT: null });
    expect(codeOf(await req('GET', '/v1/catalogue/item-gst-rates', undefined, 'u-mgr', { productIds: '' }))).toBe('not_readable_as_an_item_list');
    expect((await req('GET', '/v1/catalogue/item-gst-rates', undefined, 'u-till', { productIds: 'OIL' })).status).toBe(403);

    // ── Count review: an applied held write-off says its WOF number.
    const plansStream = streamName(STREAM.inventory, 'count-plans');
    await h.store.append(T, plansStream, makeEvent({ id: 'held-1', type: 'CountWriteOffHeld', occurredAt: daysAgo(6), idempotencyKey: `held-${T}-1`, source: 'test',
      payload: { heldId: 'h-1', planId: 'p1', productId: 'RICE', locationId: 'S1', batchId: null, quantityMinor: 1, uom: 'ea', valueMinor: 4_000, unitCostMinor: 4_000, source: { kind: 'floor_indent', indentId: 'i1', issueId: 'is1', transferId: 't1' }, recordedBy: 'u-mgr', recordedAt: daysAgo(6), relayed: false } }));
    await h.store.append(T, plansStream, makeEvent({ id: 'held-1-applied', type: 'CountHeldWriteOffApplied', occurredAt: daysAgo(5), idempotencyKey: `held-applied-${T}-1`, source: 'test',
      payload: { heldId: 'h-1', planId: 'p1', outcome: 'approved', appliedBy: 'u-owner', appliedAt: daysAgo(5), writeOffId: 'wo-old-2', movementIds: [] } }));
    const plan = (await req('GET', '/v1/inventory/count-plans/p1')).body as { heldWriteOffs: { applied: { writeOffId: string; writeOffDocumentNumber?: string } | null }[] };
    expect(plan.heldWriteOffs.map((x) => [x.applied?.writeOffId, x.applied?.writeOffDocumentNumber])).toEqual([['wo-old-2', 'WOF1/26-27/00002']]);
  }, 180_000);
});
