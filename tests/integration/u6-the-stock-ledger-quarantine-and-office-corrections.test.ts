import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { ledgerLines } from '../../services/inventory/src/stock-ledger';
import { quarantinedLinesOf, QUARANTINED_HOLD_STATUSES } from '../../services/inventory/src/quarantine';
import type { Movement } from '../../services/inventory/src/index';

/**
 * **U6 (UI/UX gap audit, 1 Nov 2026 · §27 Inventory "Ledger" / "Quarantine" / "Adjustment"): the three readings and the one
 * write the new inventory screens stand on, on the production API (M08-FR-01 · M08-FR-03 · M07-FR-03 · M10-FR-02 · §28 ·
 * hard rules #2 #10).**
 *
 *   • the stock LEDGER is read one product at a time, in ledger order, each line with its effect and the running balance
 *     at its place; a window narrows the lines but never the balance; a reader without the product is refused by name;
 *     a store manager reads only their own stores' lines;
 *   • the QUARANTINE register is one reading of the batches on quality hold (not yet released) and the receipt lines
 *     still quarantined with no disposition; a released batch moves to the released list; a cashier is refused;
 *   • an OFFICE person asks for a stock correction in their own session: recorded PENDING, valued at head office's own
 *     cost, flagged when the product was never costed; the raiser cannot decide it; a different manager approves it and
 *     ONE compensating movement posts, which the ledger then shows; a malformed body and a cashier are refused.
 * Synthetic data (hard rule #7).
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const key = (): string => `k-${Math.random().toString(36).slice(2)}`;

interface Ledger { productId: string; lines: { movementId: string; kind: string; effect: number; quantityMinor: number; balanceAfterMinor: number; locationId: string; enteredBy: string; approvedBy: string | null; reason: string | null }[]; count: number; inMinor: number; outMinor: number; places: { locationId: string; onHandMinor: number }[]; movementsEver: number }
interface Quarantine { holds: { batchId: string; status: string }[]; released: { batchId: string }[]; lines: { grnId: string; lineId: string; productId: string; quantityMinor: number; condition: string }[]; counts: { batchesHeld: number; batchesFailed: number; receiptLines: number; released: number } }

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager');
  await h.provisionRole(A, 'u-mgr2', 'store_manager');
  await h.provisionRole(A, 'u-cash', 'cashier');
  // Two stores and a back store, so branch scope has something to bite on.
  for (const [id, kind, parent] of [['C1', 'company', null], ['S1', 'branch', 'C1'], ['S2', 'branch', 'C1']] as const) {
    await h.request({ method: 'POST', path: `/v1/org/nodes/${id}`, userId: 'u-owner', tenantId: A, idempotencyKey: `org-${id}`, body: { kind, name: id, parentId: parent, companyId: 'C1' } });
  }
  return h;
}
const move = (h: ApiHarness, m: Partial<Movement> & { movementId: string; productId: string; locationId: string; kind: Movement['kind']; quantityMinor: number }, user = 'u-owner') =>
  h.request({ method: 'POST', path: '/v1/inventory/movements', userId: user, tenantId: A, idempotencyKey: m.movementId, body: { uom: 'EA', occurredAt: '2026-11-01T04:30:00.000Z', enteredBy: user, ...m } });
const ledger = async (h: ApiHarness, query: Record<string, string>, user = 'u-owner', branchId?: string) => h.request({ method: 'GET', path: '/v1/inventory/ledger', userId: user, tenantId: A, query, ...(branchId === undefined ? {} : { branchId }) });

describe('the stock ledger, read one product at a time (M08-FR-01)', () => {
  it('lines in ledger order with the effect and the running balance per place; a window narrows the lines, not the balance', async () => {
    const h = await cast();
    expect((await move(h, { movementId: 'm1', productId: 'RICE', locationId: 'S1', kind: 'received', quantityMinor: 100, unitCostMinor: 5_000, occurredAt: '2026-11-01T04:30:00.000Z' })).status).toBe(202);
    expect((await move(h, { movementId: 'm2', productId: 'RICE', locationId: 'S1', kind: 'transferred_out', quantityMinor: 30, occurredAt: '2026-11-02T04:30:00.000Z' })).status).toBe(202);
    expect((await move(h, { movementId: 'm3', productId: 'RICE', locationId: 'S2', kind: 'received', quantityMinor: 10, unitCostMinor: 5_000, occurredAt: '2026-11-03T04:30:00.000Z' })).status).toBe(202);
    expect((await move(h, { movementId: 'other', productId: 'OIL', locationId: 'S1', kind: 'received', quantityMinor: 7, unitCostMinor: 100 })).status).toBe(202);

    const all = await ledger(h, { productId: 'RICE' });
    expect(all.status).toBe(200);
    const b = all.body as Ledger;
    expect(b.lines.map((l) => [l.movementId, l.kind, l.effect, l.quantityMinor, l.locationId, l.balanceAfterMinor])).toEqual([
      ['m1', 'received', 1, 100, 'S1', 100], ['m2', 'transferred_out', -1, 30, 'S1', 70], ['m3', 'received', 1, 10, 'S2', 10],
    ]);
    expect(b.lines[0]).toMatchObject({ reason: null, approvedBy: null, enteredBy: 'u-owner', batchId: null });
    expect([b.count, b.inMinor, b.outMinor, b.movementsEver]).toEqual([3, 110, 30, 3]);
    expect(b.places).toEqual([{ locationId: 'S1', onHandMinor: 70 }, { locationId: 'S2', onHandMinor: 10 }]);

    // One place, one window: the first line shown still carries the true balance after it.
    const windowed = (await ledger(h, { productId: 'RICE', locationId: 'S1', from: '2026-11-02T00:00:00.000Z', to: '2026-11-04T23:59:59.000Z' })).body as Ledger;
    expect(windowed.lines.map((l) => [l.movementId, l.balanceAfterMinor])).toEqual([['m2', 70]]);
    expect(windowed.places).toEqual([{ locationId: 'S1', onHandMinor: 70 }]);
  });

  it('refuses a read with no product by name, a bad window by name, and keeps a store manager to their own stores', async () => {
    const h = await cast();
    await move(h, { movementId: 'm1', productId: 'RICE', locationId: 'S1', kind: 'received', quantityMinor: 100, unitCostMinor: 5_000 });
    await move(h, { movementId: 'm3', productId: 'RICE', locationId: 'S2', kind: 'received', quantityMinor: 10, unitCostMinor: 5_000 });
    const none = await ledger(h, {});
    expect([none.status, codeOf(none)]).toEqual([400, 'not_readable_as_a_ledger_read']);
    const bad = await ledger(h, { productId: 'RICE', from: 'yesterday' });
    expect([bad.status, codeOf(bad)]).toEqual([400, 'not_readable_as_a_ledger_read']);
    await h.provisionRole(A, 'u-s1', 'store_manager', ['S1']);
    const s1Read = await ledger(h, { productId: 'RICE' }, 'u-s1', 'S1');
    expect(s1Read.status, JSON.stringify(s1Read.body)).toBe(200);
    const s1 = s1Read.body as Ledger;
    expect(s1.lines.map((l) => l.locationId)).toEqual(['S1']);
    expect(s1.places).toEqual([{ locationId: 'S1', onHandMinor: 100 }]);
    expect((await ledger(h, { productId: 'RICE' }, 'u-cash')).status).toBe(403);
  });

  it('the pure fold: the balance is per place and the window keeps it', () => {
    const base = { productId: 'P', uom: 'EA', enteredBy: 'u' };
    const moves: Movement[] = [
      { ...base, movementId: 'a', locationId: 'S1', kind: 'received', quantityMinor: 10, occurredAt: '2026-11-01T00:00:00.000Z' },
      { ...base, movementId: 'b', locationId: 'S2', kind: 'received', quantityMinor: 4, occurredAt: '2026-11-02T00:00:00.000Z' },
      { ...base, movementId: 'c', locationId: 'S1', kind: 'sold', quantityMinor: 3, occurredAt: '2026-11-03T00:00:00.000Z' },
    ];
    expect(ledgerLines(moves).map((l) => l.balanceAfterMinor)).toEqual([10, 4, 7]);
    expect(ledgerLines(moves, { from: '2026-11-03T00:00:00.000Z' }).map((l) => [l.movementId, l.balanceAfterMinor])).toEqual([['c', 7]]);
  });
});

describe('the quarantine register (M07-FR-03 · M10-FR-02)', () => {
  it('lists the batches on hold and the receipt lines still quarantined; a release moves the batch out; a cashier is refused', async () => {
    const h = await cast();
    // A batch on quality hold, and one that failed its sample.
    expect((await h.request({ method: 'POST', path: '/v1/quality/holds/B-1', userId: 'u-owner', tenantId: A, idempotencyKey: 'h1', body: { productId: 'p-milk', reason: 'awaiting listeria result' } })).status).toBe(201);
    expect((await h.request({ method: 'POST', path: '/v1/quality/holds/B-2', userId: 'u-owner', tenantId: A, idempotencyKey: 'h2', body: { productId: 'p-curd', reason: 'routine sampling' } })).status).toBe(201);
    // A delivery with a damaged line: counted, quarantined at the door, no disposition yet.
    const grn = await h.request({ method: 'POST', path: '/v1/inventory/goods-receipt/grn-q', userId: 'u-mgr', tenantId: A, idempotencyKey: 'grn-q', body: {
      warehouseId: 'S1', receivedOnDate: '2026-11-05', currency: 'INR',
      lines: [
        { lineId: 'L1', productId: 'p-oil', orderedMinor: 12, countedMinor: 12, uom: 'EA', unitCost: { minor: 10_000, currency: 'INR' }, condition: 'damaged' },
        { lineId: 'L2', productId: 'p-rice', orderedMinor: 5, countedMinor: 5, uom: 'EA', unitCost: { minor: 5_000, currency: 'INR' }, condition: 'good' },
      ],
    } });
    expect(grn.status, JSON.stringify(grn.body)).toBe(201);

    const read = await h.request({ method: 'GET', path: '/v1/inventory/quarantine', userId: 'u-mgr', tenantId: A });
    expect(read.status).toBe(200);
    const q = read.body as Quarantine;
    expect(q.holds.map((x) => [x.batchId, x.status])).toEqual([['B-1', 'held'], ['B-2', 'held']]);
    expect(q.lines.map((l) => [l.grnId, l.lineId, l.productId, l.quantityMinor])).toEqual([['grn-q', 'L1', 'p-oil', 12]]);
    expect(q.counts).toEqual({ batchesHeld: 2, batchesFailed: 0, receiptLines: 1, released: 0 });

    // A sample is recorded on B-2 (OB-513: a batch head office cannot tell is not food needs one), then the manager releases it: it leaves the held list.
    expect((await h.request({ method: 'POST', path: '/v1/quality/holds/B-2/samples/s-2', userId: 'u-owner', tenantId: A, idempotencyKey: 'smp-2', body: { test: 'listeria', result: 'pass', takenAt: '2026-11-05T09:00:00.000Z' } })).status).toBeLessThan(300);
    const rel = await h.request({ method: 'POST', path: '/v1/quality/holds/B-2/release', userId: 'u-mgr', tenantId: A, idempotencyKey: 'rel-2', body: {} });
    expect(rel.status, JSON.stringify(rel.body)).toBe(200);
    const after = (await h.request({ method: 'GET', path: '/v1/inventory/quarantine', userId: 'u-mgr', tenantId: A })).body as Quarantine;
    expect(after.holds.map((x) => x.batchId)).toEqual(['B-1']);
    expect(after.released.map((x) => x.batchId)).toEqual(['B-2']);
    expect(after.counts).toMatchObject({ batchesHeld: 1, released: 1 });

    expect((await h.request({ method: 'GET', path: '/v1/inventory/quarantine', userId: 'u-cash', tenantId: A })).status).toBe(403);
  });

  it('the pure fold: a disposed line leaves the register; the statuses that count as quarantine are named', () => {
    const line = (lineId: string, quarantinedMinor: number) => ({ lineId, productId: 'p', sellableMinor: 0, quarantinedMinor, rejectedMinor: 0, heldMinor: 0, disposition: 'quarantine', uom: 'EA', batchId: null, expiry: null, unitCost: { minor: 1, currency: 'INR' } });
    const grn = { grnId: 'g', number: 'GRN-1', warehouseId: 'S1', receivedBy: 'u', receivedAt: '2026-11-05T04:30:00.000Z', captured: { lines: [line('L1', 3), line('L2', 0), line('L3', 2)] }, dispositions: [{ lineId: 'L3' }] };
    expect(quarantinedLinesOf([grn as never]).map((l) => l.lineId)).toEqual(['L1']);
    expect([...QUARANTINED_HOLD_STATUSES]).toEqual(['held', 'failed', 'sampling', 'pending']);
  });
});

describe('an office person asks for a stock correction (M08-FR-03 · §28)', () => {
  const ask = (h: ApiHarness, requestId: string, body: Record<string, unknown>, user = 'u-mgr') =>
    h.request({ method: 'POST', path: `/v1/inventory/adjustment-requests/${requestId}`, userId: user, tenantId: A, idempotencyKey: key(), body });
  const decide = (h: ApiHarness, requestId: string, decision: 'approved' | 'rejected', user: string) =>
    h.request({ method: 'POST', path: `/v1/inventory/adjustment-requests/${requestId}/decide`, userId: user, tenantId: A, idempotencyKey: key(), body: { decision, reason: 'checked the shelf' } });

  it('recorded pending at head office\'s own cost; the raiser cannot decide it; another manager approves and ONE movement posts, which the ledger shows', async () => {
    const h = await cast();
    await move(h, { movementId: 'm1', productId: 'RICE', locationId: 'S1', kind: 'received', quantityMinor: 100, unitCostMinor: 2_500 });
    const asked = await ask(h, 'ar-office-1', { productId: 'RICE', locationId: 'S1', deltaMinor: -3, uom: 'EA', reasonCode: 'damaged', note: ' wet sack ' });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expect(asked.body).toEqual({ requestId: 'ar-office-1', recorded: true, status: 'pending', valueMinor: 7_500, flags: [] });
    // The same ask again: one record.
    expect((await ask(h, 'ar-office-1', { productId: 'RICE', locationId: 'S1', deltaMinor: -3, uom: 'EA', reasonCode: 'damaged' })).body).toMatchObject({ alreadyRecorded: true, status: 'pending' });
    // On the register, from the office, in the raiser's name.
    const listed = (await h.request({ method: 'GET', path: '/v1/inventory/adjustment-requests', userId: 'u-owner', tenantId: A })).body as { requests: { requestId: string; source: string; requestedBy: string; note: string | null; status: string }[] };
    expect(listed.requests).toMatchObject([{ requestId: 'ar-office-1', source: 'office', requestedBy: 'u-mgr', note: 'wet sack', status: 'pending' }]);
    // The raiser cannot decide their own.
    const self = await decide(h, 'ar-office-1', 'approved', 'u-mgr');
    expect([self.status, codeOf(self)]).toEqual([422, 'self_approval']);
    // Another manager approves: one compensating movement, on-hand 97, and the ledger shows it with both people on it.
    const ok = await decide(h, 'ar-office-1', 'approved', 'u-mgr2');
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'posted', movementId: 'adj-req:ar-office-1', decidedBy: 'u-mgr2' });
    const led = (await ledger(h, { productId: 'RICE' })).body as Ledger;
    expect(led.lines.map((l) => [l.movementId, l.kind, l.balanceAfterMinor, l.enteredBy, l.approvedBy])).toEqual([['m1', 'received', 100, 'u-owner', null], ['adj-req:ar-office-1', 'wasted', 97, 'u-mgr', 'u-mgr2']]);
    expect(led.lines[1]!.reason).toBe('damaged: wet sack');
  });

  it('a product never costed is flagged value_unknown; a malformed ask, a cashier and another store are refused by name', async () => {
    const h = await cast();
    const asked = await ask(h, 'ar-office-2', { productId: 'NEW', locationId: 'S1', deltaMinor: 2, uom: 'EA', reasonCode: 'found' });
    expect(asked.status).toBe(202);
    expect(asked.body).toMatchObject({ valueMinor: 0, flags: ['value_unknown'] });
    const bad = await ask(h, 'ar-office-3', { productId: 'RICE', locationId: 'S1', deltaMinor: 0, uom: 'EA', reasonCode: 'damaged' });
    expect([bad.status, codeOf(bad)]).toEqual([400, 'not_readable_as_an_adjustment_request']);
    const badReason = await ask(h, 'ar-office-4', { productId: 'RICE', locationId: 'S1', deltaMinor: -1, uom: 'EA', reasonCode: 'because' });
    expect([badReason.status, codeOf(badReason)]).toEqual([400, 'not_readable_as_an_adjustment_request']);
    expect((await ask(h, 'ar-office-5', { productId: 'RICE', locationId: 'S1', deltaMinor: -1, uom: 'EA', reasonCode: 'damaged' }, 'u-cash')).status).toBe(403);
    await h.provisionRole(A, 'u-s1', 'store_manager', ['S1']);
    expect((await ask(h, 'ar-office-6', { productId: 'RICE', locationId: 'S2', deltaMinor: -1, uom: 'EA', reasonCode: 'damaged' }, 'u-s1')).status).toBe(403);
  });
});
