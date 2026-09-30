import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

/**
 * SP-8 (audit finding F08 · WF-06 · WF-07 · M09-FR-03 · M04-FR-03 · M08-FR-02 · §28 · P-03 · P-08 · hard rule #2): the
 * floor indent chain on the REAL API with REAL RBAC — floor indent → approval → back-store allocation → issue (a
 * transfer, dispatched) → in transit → independent floor receipt → shelf availability → sale, with partial issue, partial
 * receipt, wrong item, cancellation and floor→back-store return; requested / issued / received / outstanding recorded
 * separately; issue and receipt never create stock twice; a dispatch is never a receipt.
 *
 * Until this slice no such chain existed: refill tasks were calculated and never kept, transfers knew nothing of who
 * asked, and the merchandising screen's shelf count only mutated page data.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BACK = 'S1-BACK';
const FLOOR = 'S1';

type Body = Record<string, unknown>;
const post = (h: ApiHarness, u: string, path: string, body: Body, key: string, t = A) => h.request({ method: 'POST', path, userId: u, tenantId: t, idempotencyKey: key, body });
const get = (h: ApiHarness, u: string, path: string, query?: Readonly<Record<string, string>>, t = A) => h.request({ method: 'GET', path, userId: u, tenantId: t, ...(query === undefined ? {} : { query }) });
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const whatHappened = (res: { body: unknown }): string => (res.body as { error: { whatHappened: string } }).error.whatHappened;
const indentOf = (res: { body: unknown }) => (res.body as { indent: Indent }).indent;
interface Totals { requestedMinor: number; allocatedMinor: number; issuedMinor: number; receivedMinor: number; inTransitMinor: number; shortfallMinor: number; returnedMinor: number; outstandingMinor: number; lines: Record<string, unknown>[] }
interface Indent { indentId: string; state: string; requestedBy: string; approvedBy?: string; flags: string[]; totals: Totals; attention: string[]; issues: { issueId: string; transferId: string; state: string; issuedBy: string }[]; returns: unknown[] }

const request = (h: ApiHarness, u: string, id: string, lines: Body[], key?: string) =>
  post(h, u, `/v1/floor/indents/${id}`, { fromLocationId: BACK, toLocationId: FLOOR, lines, reason: 'shelf 4 empty' }, key ?? `ind-${id}`);
const approve = (h: ApiHarness, u: string, id: string, body: Body = {}, key?: string) => post(h, u, `/v1/floor/indents/${id}/approval`, body, key ?? `ind-ap-${id}`);
const issue = (h: ApiHarness, u: string, id: string, issueId: string, lines: Body[], key?: string) => post(h, u, `/v1/floor/indents/${id}/issues/${issueId}`, { lines }, key ?? `ind-is-${id}-${issueId}`);
const receipt = (h: ApiHarness, u: string, id: string, issueId: string, counted: Body[], key?: string) => post(h, u, `/v1/floor/indents/${id}/issues/${issueId}/receipt`, { counted }, key ?? `ind-rc-${id}-${issueId}`);
const availability = async (h: ApiHarness, productId: string, t = A) =>
  (await get(h, 'u-owner', '/v1/inventory/availability', { productId }, t)).body as { rows: { locationId: string; onHandMinor: number }[]; inTransit: { transferId: string; locationId: string; fromLocationId: string; quantityMinor: number }[] };
const exceptions = async (h: ApiHarness) => (await get(h, 'u-owner', '/v1/inventory/exceptions')).body as { transferShortfalls: Record<string, unknown>[] };

/** The places head office knows: the company, the store S1 (the floor — where the till sells from) and its back store. */
async function places(h: ApiHarness, t = A): Promise<void> {
  const node = (id: string, body: Body) => post(h, 'u-owner', `/v1/org/nodes/${id}`, body, `org-${id}`, t);
  expect((await node('C1', { kind: 'company', name: 'SRE Retail' })).status).toBe(201);
  expect((await node(FLOOR, { kind: 'branch', name: 'Store 1', parentId: 'C1', companyId: 'C1' })).status).toBe(201);
  expect((await node(BACK, { kind: 'warehouse', name: 'Store 1 back store', parentId: FLOOR, companyId: 'C1' })).status).toBe(201);
}
/** Head office's own stock at the back store, costed — the position every allocation and issue is judged against. */
const stock = (h: ApiHarness, productId: string, qty: number, unitCostMinor: number, t = A) =>
  post(h, 'u-owner', '/v1/inventory/movements', {
    movementId: `seed-${productId}-${qty}`, productId, locationId: BACK, kind: 'received', quantityMinor: qty, uom: 'EA', occurredAt: '2026-09-01T00:00:00.000Z', enteredBy: 'u-owner', unitCostMinor,
  }, `seed-${productId}-${qty}`, t);

/** The cast: u-floor asks (store manager), u-mgr approves (store manager), u-back issues (store manager, the back store), u-floor2 receives. */
async function seeded(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  for (const u of ['u-floor', 'u-mgr', 'u-back', 'u-floor2']) await h.provisionRole(A, u, 'store_manager');
  await h.provisionRole(A, 'u-cash', 'cashier');
  await h.provisionRole(A, 'u-acct', 'accountant');
  await places(h);
  await stock(h, 'RICE', 50, 5_000);
  await stock(h, 'OIL', 4, 12_000);
  return h;
}
const LINES = [{ productId: 'RICE', quantityMinor: 20, uom: 'EA' }, { productId: 'OIL', quantityMinor: 6, uom: 'EA' }];

describe('the floor indent chain, end to end on the real API (SP-8 · F08)', () => {
  it('request → approve (a different person, against head office\'s back-store stock) → issue (stock off the back store, in transit at the floor) → independent receipt (on the shelf) → sale; the register says requested / issued / received / outstanding separately', async () => {
    const h = await seeded();

    // 1. The floor asks. A cashier (floor staff) may raise one too; an accountant may not.
    const r = await request(h, 'u-floor', 'ind-1', LINES);
    expect(r.status).toBe(201);
    expect(indentOf(r)).toMatchObject({ state: 'requested', requestedBy: 'u-floor', attention: ['awaiting_approval'], totals: expect.objectContaining({ requestedMinor: 26, allocatedMinor: 0, outstandingMinor: 0 }) });
    expect((await request(h, 'u-cash', 'ind-c', [{ productId: 'RICE', quantityMinor: 1, uom: 'EA' }])).status).toBe(201);
    expect(codeOf(await request(h, 'u-acct', 'ind-x', LINES))).toBe('forbidden');
    // Same id again is the same indent (200), not a second ask.
    expect((await request(h, 'u-floor', 'ind-1', LINES, 'ind-ind-1-again')).body).toMatchObject({ alreadyRecorded: true });
    // A place head office does not know is refused by name.
    expect(codeOf(await post(h, 'u-floor', '/v1/floor/indents/ind-bad', { fromLocationId: 'NOWHERE', toLocationId: FLOOR, lines: LINES }, 'ind-bad'))).toBe('unknown_location');

    // 2. The requester cannot approve; a cashier lacks the authority; a manager allocates — OIL is short at the back store (4 of 6) and it is SAID.
    expect(codeOf(await approve(h, 'u-floor', 'ind-1', {}, 'ap-self'))).toBe('self_approval');
    expect(codeOf(await approve(h, 'u-cash', 'ind-1', {}, 'ap-cash'))).toBe('forbidden');
    const ap = await approve(h, 'u-mgr', 'ind-1');
    expect(ap.status).toBe(200);
    const approved = indentOf(ap);
    expect(approved).toMatchObject({ state: 'approved', approvedBy: 'u-mgr', flags: ['short_stock', 'short_allocated'], totals: expect.objectContaining({ allocatedMinor: 24, outstandingMinor: 24 }) });
    expect((approved as unknown as { allocations: unknown[] }).allocations).toEqual([{ productId: 'RICE', allocatedMinor: 20, availableMinor: 50 }, { productId: 'OIL', allocatedMinor: 4, availableMinor: 4 }]);
    expect((await approve(h, 'u-mgr', 'ind-1', {}, 'ap-again')).body).toMatchObject({ alreadyApproved: true });

    // 3. The back store ISSUES 12 RICE: the requester cannot issue to themselves; a wrong item and an over-issue are refused.
    expect(codeOf(await issue(h, 'u-floor', 'ind-1', 'is-0', [{ productId: 'RICE', quantityMinor: 1 }]))).toBe('requester_cannot_issue');
    expect(codeOf(await issue(h, 'u-back', 'ind-1', 'is-w', [{ productId: 'GHEE', quantityMinor: 1 }]))).toBe('not_on_indent');
    expect(codeOf(await issue(h, 'u-back', 'ind-1', 'is-o', [{ productId: 'RICE', quantityMinor: 21 }]))).toBe('over_issue');
    const is1 = await issue(h, 'u-back', 'ind-1', 'is-1', [{ productId: 'RICE', quantityMinor: 12 }]);
    expect(is1.status).toBe(201);
    expect(is1.body).toMatchObject({ transferId: 'ind-1:is-1', posted: ['ind-1:is-1-out-1'], lineCostsMinor: [5_000] });
    expect(indentOf(is1)).toMatchObject({ state: 'issuing', flags: expect.arrayContaining(['partial_issue']), totals: expect.objectContaining({ issuedMinor: 12, inTransitMinor: 12, outstandingMinor: 12, receivedMinor: 0 }), attention: ['owed_by_back_store', 'on_the_trolley'] });
    // Stock: 12 LEFT the back store and are IN TRANSIT at the floor — visible, not on-hand, not sellable (M08-FR-02).
    let rice = await availability(h, 'RICE');
    expect(rice.rows).toEqual([expect.objectContaining({ locationId: BACK, onHandMinor: 38 })]);
    expect(rice.inTransit).toEqual([expect.objectContaining({ transferId: 'ind-1:is-1', locationId: FLOOR, fromLocationId: BACK, quantityMinor: 12 })]);
    // The transfer is readable as any other transfer (one truth).
    expect((await get(h, 'u-owner', '/v1/warehouse/transfers/ind-1:is-1')).body).toMatchObject({ state: 'in_transit', requestedBy: 'u-floor', approvedBy: 'u-back', lineCostsMinor: [5_000] });
    // The same issue again is the same issue — no second dispatch, no second movement.
    expect((await issue(h, 'u-back', 'ind-1', 'is-1', [{ productId: 'RICE', quantityMinor: 12 }], 'is-1-again')).body).toMatchObject({ alreadyIssued: true });
    expect((await availability(h, 'RICE')).rows[0]).toMatchObject({ onHandMinor: 38 });

    // 4. The floor RECEIVES independently: the issuer cannot; a wrong item is not received against it; 12 counted → 12 on the shelf.
    expect(codeOf(await receipt(h, 'u-back', 'ind-1', 'is-1', [{ productId: 'RICE', quantityMinor: 12 }]))).toBe('issuer_cannot_receive');
    expect(codeOf(await receipt(h, 'u-floor2', 'ind-1', 'is-1', [{ productId: 'OIL', quantityMinor: 1 }]))).toBe('not_on_issue');
    const rc1 = await receipt(h, 'u-floor2', 'ind-1', 'is-1', [{ productId: 'RICE', quantityMinor: 12 }]);
    expect(rc1.status).toBe(201);
    expect(rc1.body).toMatchObject({ posted: ['ind-1:is-1-recv-1'], discrepancies: [] });
    expect(indentOf(rc1)).toMatchObject({ state: 'issuing', totals: expect.objectContaining({ issuedMinor: 12, receivedMinor: 12, inTransitMinor: 0, outstandingMinor: 12, shortfallMinor: 0 }) });
    rice = await availability(h, 'RICE');
    expect(rice.rows).toEqual([expect.objectContaining({ locationId: FLOOR, onHandMinor: 12 }), expect.objectContaining({ locationId: BACK, onHandMinor: 38 })]);
    expect(rice.inTransit).toEqual([]);
    // The value followed the stock: 12 × ₹50 on the floor.
    const val = (await get(h, 'u-owner', '/v1/inventory/valuation')).body as { rows: { locationId: string; productId: string; value: { minor: number } }[] };
    expect(val.rows.find((x) => x.locationId === FLOOR && x.productId === 'RICE')).toMatchObject({ value: { minor: 60_000 } });
    expect((await receipt(h, 'u-floor2', 'ind-1', 'is-1', [{ productId: 'RICE', quantityMinor: 12 }], 'rc-again')).body).toMatchObject({ alreadyReceived: true });
    expect((await availability(h, 'RICE')).rows.find((x) => x.locationId === FLOOR)?.onHandMinor).toBe(12);

    // 5. → SALE: the till's sale draws from the floor (the store's location) — shelf availability falls.
    expect((await post(h, 'u-owner', '/v1/inventory/movements', { movementId: 'sale-1', productId: 'RICE', locationId: FLOOR, kind: 'sold', quantityMinor: 2, uom: 'EA', occurredAt: '2026-09-30T12:00:00.000Z', enteredBy: 'u-owner' }, 'sale-1')).status).toBeLessThan(300);
    expect((await availability(h, 'RICE')).rows.find((x) => x.locationId === FLOOR)?.onHandMinor).toBe(10);

    // 6. The second issue closes the allocation (8 RICE + 4 OIL, a batch on the oil); the register reads it all.
    const is2 = await issue(h, 'u-back', 'ind-1', 'is-2', [{ productId: 'RICE', quantityMinor: 8 }, { productId: 'OIL', batchId: null, quantityMinor: 4 }]);
    expect(is2.status).toBe(201);
    expect(indentOf(is2)).toMatchObject({ state: 'issued', totals: expect.objectContaining({ issuedMinor: 24, inTransitMinor: 12, outstandingMinor: 0 }) });
    const reg = (await get(h, 'u-mgr', '/v1/floor/indents', { open: 'true' })).body as { indents: Indent[]; count: number; needingAttentionCount: number; inTransitMinor: number; outstandingMinor: number };
    expect(reg.count).toBe(2); // ind-1 (issued, on the trolley) and the cashier's ind-c (awaiting approval)
    expect(reg.indents.map((i) => i.indentId)).toEqual(['ind-c', 'ind-1']); // needing a person: the undecided ask before the trolley in progress (P-03)
    expect(reg).toMatchObject({ needingAttentionCount: 2, inTransitMinor: 12, outstandingMinor: 0 });
    expect(reg.indents.find((i) => i.indentId === 'ind-1')!.totals.lines).toEqual([
      expect.objectContaining({ productId: 'RICE', requestedMinor: 20, allocatedMinor: 20, issuedMinor: 20, receivedMinor: 12, inTransitMinor: 8, outstandingMinor: 0 }),
      expect.objectContaining({ productId: 'OIL', requestedMinor: 6, allocatedMinor: 4, issuedMinor: 4, receivedMinor: 0, inTransitMinor: 4, outstandingMinor: 0 }),
    ]);
    // A cashier reads the register; an accountant does not.
    expect((await get(h, 'u-cash', '/v1/floor/indents/ind-1')).status).toBe(200);
    expect(codeOf(await get(h, 'u-acct', '/v1/floor/indents/ind-1'))).toBe('forbidden');
  });

  it('a partial receipt raises a VALUED shortfall on the exceptions read — never absorbed; the indent says arrived_short; nothing is posted twice on a re-keyed retry', async () => {
    const h = await seeded();
    await request(h, 'u-floor', 'ind-2', [{ productId: 'RICE', quantityMinor: 10, uom: 'EA' }]);
    await approve(h, 'u-mgr', 'ind-2');
    await issue(h, 'u-back', 'ind-2', 'is-1', [{ productId: 'RICE', quantityMinor: 10 }]);
    const rc = await receipt(h, 'u-floor2', 'ind-2', 'is-1', [{ productId: 'RICE', quantityMinor: 7 }]);
    expect(rc.status).toBe(201);
    expect(rc.body).toMatchObject({ discrepancies: [expect.objectContaining({ productId: 'RICE', dispatchedMinor: 10, receivedMinor: 7, differenceMinor: -3, value: { minor: 15_000, currency: 'INR' } })] });
    const ind = indentOf(rc);
    expect(ind).toMatchObject({ state: 'received', flags: expect.arrayContaining(['partial_receipt']), totals: expect.objectContaining({ issuedMinor: 10, receivedMinor: 7, shortfallMinor: 3, inTransitMinor: 0, outstandingMinor: 0 }), attention: ['arrived_short'] });
    const rice = await availability(h, 'RICE');
    expect(rice.rows).toEqual([expect.objectContaining({ locationId: FLOOR, onHandMinor: 7 }), expect.objectContaining({ locationId: BACK, onHandMinor: 40 })]);
    expect(rice.inTransit).toEqual([]);
    expect((await exceptions(h)).transferShortfalls).toEqual([expect.objectContaining({ transferId: 'ind-2:is-1', productId: 'RICE', fromLocationId: BACK, locationId: FLOOR, dispatchedMinor: 10, receivedMinor: 7, differenceMinor: -3, value: { minor: 15_000, currency: 'INR' } })]);
    // A re-keyed retry of the receipt is the same receipt (already received) and posts nothing — idempotent by STATE, not only by key.
    expect((await receipt(h, 'u-floor2', 'ind-2', 'is-1', [{ productId: 'RICE', quantityMinor: 7 }], 'rc-rekeyed')).body).toMatchObject({ alreadyReceived: true });
    expect((await availability(h, 'RICE')).rows.find((x) => x.locationId === FLOOR)?.onHandMinor).toBe(7);
  });

  it('the transfer engine guards the issue against head office\'s OWN stock — an over-draw, a recalled batch — and nothing moves; cancel withdraws only the remainder', async () => {
    const h = await seeded();
    await request(h, 'u-floor', 'ind-3', [{ productId: 'OIL', quantityMinor: 6, uom: 'EA' }]);
    // The manager allocates all 6 by hand although only 4 are on the shelf — allowed (the ask stands), said as short_stock.
    const ap = await approve(h, 'u-mgr', 'ind-3', { allocations: [{ productId: 'OIL', quantityMinor: 6 }] });
    expect(indentOf(ap)).toMatchObject({ flags: ['short_stock'], totals: expect.objectContaining({ allocatedMinor: 6 }) });
    // Issuing 6 finds only 4: refused by the transfer engine, nothing recorded.
    const over = await issue(h, 'u-back', 'ind-3', 'is-1', [{ productId: 'OIL', quantityMinor: 6 }]);
    expect(codeOf(over)).toBe('issue_refused');
    expect(whatHappened(over)).toMatch(/only 4 of OIL available to send, not 6/);
    expect((await get(h, 'u-mgr', '/v1/floor/indents/ind-3')).body).toMatchObject({ state: 'approved', issues: [] });
    expect((await availability(h, 'OIL')).rows).toEqual([expect.objectContaining({ locationId: BACK, onHandMinor: 4 })]);
    // A recalled batch is never issued to the floor.
    await stock(h, 'OIL', 20, 12_000);
    await post(h, 'u-owner', '/v1/inventory/movements', { movementId: 'seed-oil-bad', productId: 'OIL', locationId: BACK, kind: 'received', quantityMinor: 6, uom: 'EA', occurredAt: '2026-09-01T00:00:00.000Z', enteredBy: 'u-owner', batchId: 'B-BAD' }, 'seed-oil-bad');
    expect((await post(h, 'u-owner', '/v1/quality/recalls/B-BAD', { reason: 'contamination notice' }, 'rc-1')).status).toBeLessThan(300);
    const recalled = await issue(h, 'u-back', 'ind-3', 'is-2', [{ productId: 'OIL', batchId: 'B-BAD', quantityMinor: 6 }]);
    expect(codeOf(recalled)).toBe('issue_refused');
    expect(whatHappened(recalled)).toMatch(/recalled/);
    // Issue 4 of the good stock, then cancel the rest: the remainder is withdrawn, the trolley must still be received.
    expect((await issue(h, 'u-back', 'ind-3', 'is-3', [{ productId: 'OIL', quantityMinor: 4 }])).status).toBe(201);
    const c = await post(h, 'u-mgr', '/v1/floor/indents/ind-3/cancel', { reason: 'a delivery filled the shelf' }, 'cancel-3');
    expect(c.status).toBe(200);
    expect(indentOf(c)).toMatchObject({ state: 'issued', flags: expect.arrayContaining(['cancelled_remainder']), totals: expect.objectContaining({ issuedMinor: 4, inTransitMinor: 4, outstandingMinor: 0 }) });
    expect(codeOf(await issue(h, 'u-back', 'ind-3', 'is-4', [{ productId: 'OIL', quantityMinor: 1 }]))).toBe('indent_not_approved');
    const rc = await receipt(h, 'u-floor2', 'ind-3', 'is-3', [{ productId: 'OIL', quantityMinor: 4 }]);
    expect(indentOf(rc).state).toBe('received');
    expect((await post(h, 'u-mgr', '/v1/floor/indents/ind-3/cancel', { reason: 'again' }, 'cancel-3b')).body).toMatchObject({ alreadyCancelled: true });
    // A fresh indent cancelled before anything went is simply cancelled; a rejection needs a reason and a different person.
    await request(h, 'u-floor', 'ind-4', [{ productId: 'RICE', quantityMinor: 1, uom: 'EA' }]);
    expect(indentOf(await post(h, 'u-floor', '/v1/floor/indents/ind-4/cancel', { reason: 'typed twice' }, 'cancel-4'))).toMatchObject({ state: 'cancelled' });
    await request(h, 'u-floor', 'ind-5', [{ productId: 'RICE', quantityMinor: 1, uom: 'EA' }]);
    expect(codeOf(await post(h, 'u-floor', '/v1/floor/indents/ind-5/rejection', { reason: 'no' }, 'rej-5-self'))).toBe('self_approval');
    expect(indentOf(await post(h, 'u-mgr', '/v1/floor/indents/ind-5/rejection', { reason: 'delisted' }, 'rej-5'))).toMatchObject({ state: 'rejected' });
  });

  it('a floor → back-store return: the floor asks, a DIFFERENT person at the back store accepts — off the floor and on-hand at the back store in one step, valued', async () => {
    const h = await seeded();
    await request(h, 'u-floor', 'ind-6', [{ productId: 'RICE', quantityMinor: 10, uom: 'EA' }]);
    await approve(h, 'u-mgr', 'ind-6');
    await issue(h, 'u-back', 'ind-6', 'is-1', [{ productId: 'RICE', quantityMinor: 10 }]);
    // Nothing received yet → nothing to return.
    expect(codeOf(await post(h, 'u-floor', '/v1/floor/indents/ind-6/returns/rt-0', { lines: [{ productId: 'RICE', quantityMinor: 1 }], reason: 'x' }, 'rt-0'))).toBe('nothing_received');
    await receipt(h, 'u-floor2', 'ind-6', 'is-1', [{ productId: 'RICE', quantityMinor: 10 }]);
    expect(codeOf(await post(h, 'u-floor', '/v1/floor/indents/ind-6/returns/rt-1', { lines: [{ productId: 'RICE', quantityMinor: 11 }], reason: 'x' }, 'rt-1-over'))).toBe('over_return');
    const rt = await post(h, 'u-floor', '/v1/floor/indents/ind-6/returns/rt-1', { lines: [{ productId: 'RICE', quantityMinor: 3 }], reason: 'wrong grade on the shelf' }, 'rt-1');
    expect(rt.status).toBe(201);
    expect(indentOf(rt).attention).toEqual(['return_awaiting_back_store']);
    // Nothing moved yet.
    expect((await availability(h, 'RICE')).rows).toEqual([expect.objectContaining({ locationId: FLOOR, onHandMinor: 10 }), expect.objectContaining({ locationId: BACK, onHandMinor: 40 })]);
    // The returner cannot accept their own return; the back store does — 3 off the floor, 3 on-hand at the back store, one step.
    expect(codeOf(await post(h, 'u-floor', '/v1/floor/indents/ind-6/returns/rt-1/accepted', { counted: [{ productId: 'RICE', quantityMinor: 3 }] }, 'rt-1-self'))).toBe('returner_cannot_accept');
    const acc = await post(h, 'u-back', '/v1/floor/indents/ind-6/returns/rt-1/accepted', { counted: [{ productId: 'RICE', quantityMinor: 3 }] }, 'rt-1-acc');
    expect(acc.status).toBe(201);
    expect(acc.body).toMatchObject({ transferId: 'ind-6:return:rt-1', posted: ['ind-6:return:rt-1-out-1', 'ind-6:return:rt-1-recv-1'], discrepancies: [] });
    expect(indentOf(acc)).toMatchObject({ totals: expect.objectContaining({ receivedMinor: 10, returnedMinor: 3 }), attention: [] });
    expect((await availability(h, 'RICE')).rows).toEqual([expect.objectContaining({ locationId: FLOOR, onHandMinor: 7 }), expect.objectContaining({ locationId: BACK, onHandMinor: 43 })]);
    expect((await availability(h, 'RICE')).inTransit).toEqual([]);
    expect((await get(h, 'u-owner', '/v1/warehouse/transfers/ind-6:return:rt-1')).body).toMatchObject({ state: 'received', fromLocationId: FLOOR, toLocationId: BACK, requestedBy: 'u-floor', approvedBy: 'u-back' });
    expect((await post(h, 'u-back', '/v1/floor/indents/ind-6/returns/rt-1/accepted', { counted: [{ productId: 'RICE', quantityMinor: 3 }] }, 'rt-1-acc-again')).body).toMatchObject({ alreadyAccepted: true });
    expect((await availability(h, 'RICE')).rows.find((x) => x.locationId === BACK)?.onHandMinor).toBe(43);
  });

  it('survives a restart and stays inside its tenant: the chain rebuilds from the log to the same truth and keeps appending; another shop sees nothing', async () => {
    const h = await seeded();
    await request(h, 'u-floor', 'ind-7', [{ productId: 'RICE', quantityMinor: 10, uom: 'EA' }]);
    await approve(h, 'u-mgr', 'ind-7');
    await issue(h, 'u-back', 'ind-7', 'is-1', [{ productId: 'RICE', quantityMinor: 6 }]);
    // Restart: a fresh API over the SAME log.
    const h2 = apiHarness({ store: h.store });
    const after = (await get(h2, 'u-mgr', '/v1/floor/indents/ind-7')).body as Indent;
    expect(after).toMatchObject({ state: 'issuing', totals: expect.objectContaining({ issuedMinor: 6, inTransitMinor: 6, outstandingMinor: 4 }) });
    expect((await availability(h2, 'RICE')).inTransit).toEqual([expect.objectContaining({ transferId: 'ind-7:is-1', quantityMinor: 6 })]);
    expect((await receipt(h2, 'u-floor2', 'ind-7', 'is-1', [{ productId: 'RICE', quantityMinor: 6 }])).status).toBe(201);
    expect((await issue(h2, 'u-back', 'ind-7', 'is-2', [{ productId: 'RICE', quantityMinor: 4 }])).status).toBe(201);
    expect(((await get(h2, 'u-mgr', '/v1/floor/indents/ind-7')).body as Indent)).toMatchObject({ state: 'issued', totals: expect.objectContaining({ issuedMinor: 10, receivedMinor: 6, inTransitMinor: 4, outstandingMinor: 0 }) });
    // Tenant isolation: the other shop has no such indent and no such stock.
    await h2.seedOwner(B, 'u-owner-b');
    expect((await get(h2, 'u-owner-b', '/v1/floor/indents/ind-7', undefined, B)).status).toBe(404);
    expect(((await get(h2, 'u-owner-b', '/v1/floor/indents', undefined, B)).body as { count: number }).count).toBe(0);
  });
});
