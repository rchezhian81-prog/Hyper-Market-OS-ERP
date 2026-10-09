import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { withApprovals } from '../support/refund-approval';
import { sealedReturn } from '../support/store-seal';
import { STREAM } from '../../services/api/src/adapters';

/**
 * **PF-14 — a returned item keeps the lot it was sold from, and what cannot be resold is held, not lost (Wave 3 ·
 * M13-FR-02 · M12-FR-01 · M10-FR-03 · P-08).**
 *
 * The audit found the trail broken on the way back: a return carried a batch only if the desk typed one (never checked
 * against the bill), and a quarantined, damaged or scrap line left no trace in stock at all — it was neither on the shelf
 * nor anywhere a person would see it. Now the return takes each unit's batch and use-by date from the BILL (a batch the
 * bill never sold is refused at the desk and flagged on a synced till refund; where the bill sold several batches the
 * desk must say which), a resold unit goes back on the shelf under that batch, and every unit that cannot be resold is
 * HELD where it came back — listed with its lot and the return it came from until a person deals with it.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AT = '2026-10-09T10:00:00.000Z';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

// A bill: 3 × dal from batch D-07 (use by 31 Dec), and 4 × milk from two batches (2 from M-1, 2 from M-2).
const SALE = {
  saleId: 'S1', receiptNumber: 'R-1', laneId: 'lane-1', cashierId: 'u-cash', locationId: 'store-1',
  tradingDay: '2026-10-09', committedAt: AT, totalMinor: 23_000, currency: 'INR', packVersion: 1,
  lines: [
    { productId: 'DAL', quantityMinor: 3, uom: 'each', unitPriceMinor: 5_000, lineTotalMinor: 15_000, batchId: 'D-07', batchExpiry: '2026-12-31' },
    { productId: 'MILK', quantityMinor: 2, uom: 'each', unitPriceMinor: 2_000, lineTotalMinor: 4_000, batchId: 'M-1', batchExpiry: '2026-10-12' },
    { productId: 'MILK', quantityMinor: 2, uom: 'each', unitPriceMinor: 2_000, lineTotalMinor: 4_000, batchId: 'M-2', batchExpiry: '2026-10-15' },
  ],
  tenders: [{ kind: 'cash', amountMinor: 23_000 }],
};

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager');
  expect((await h.request({ method: 'POST', path: '/v1/sales', userId: 'u-owner', tenantId: A, idempotencyKey: 'bank-S1', body: SALE })).status).toBe(202);
  return h;
}
const line = (productId: string, disposition: string, over: Record<string, unknown> = {}) => ({ productId, uom: 'each', quantityMinor: 1, disposition, ...over });
const desk = async (h: ApiHarness, returnId: string, lines: unknown[], refundMinor: number) =>
  h.request({ method: 'POST', path: '/v1/sales/S1/returns', userId: 'u-owner', tenantId: A, idempotencyKey: `ret-${returnId}`,
    body: await withApprovals(h, A, 'u-owner', 'S1', { returnId, reasonCode: 'customer_changed_mind', lines, refundMinor, refundTender: 'cash', approvedBy: 'u-mgr' }) });
const synced = (h: ApiHarness, returnId: string, lines: unknown[], refundMinor: number) =>
  h.request({ method: 'POST', path: '/v1/sales/S1/returns/synced', userId: 'u-owner', tenantId: A, idempotencyKey: `sync-${returnId}`,
    body: sealedReturn(A, { returnId, number: returnId, processedBy: 'u-owner', reasonCode: 'damaged_in_use', refundMinor, refundTender: 'cash', lines, processedAt: AT }) });
const recordedLines = async (h: ApiHarness, returnId: string) =>
  ((await h.store.readStream(A, STREAM.returns, { type: 'ReturnRecorded' })).map((e) => e.event.payload as { returnId: string; lines: Record<string, unknown>[] })
    .find((r) => r.returnId === returnId))?.lines;
const held = async (h: ApiHarness, query: Record<string, string> = {}) =>
  (await h.request({ method: 'GET', path: '/v1/returns/held-stock', userId: 'u-owner', tenantId: A, query })).body as { count: number; held: Record<string, unknown>[] };

describe('PF-14 — a returned unit keeps its lot', () => {
  it('no batch named: the bill\'s batch and use-by date ride on the return, and the resold unit goes back under that batch', async () => {
    const h = await cast();
    const res = await desk(h, 'RT1', [line('DAL', 'resell')], 5_000);
    expect(res.status).toBe(201);
    expect(await recordedLines(h, 'RT1')).toEqual([expect.objectContaining({ productId: 'DAL', batchId: 'D-07', batchExpiry: '2026-12-31' })]);
    const moved = (await h.store.readStream(A, STREAM.inventory, { type: 'InventoryMoved' })).map((e) => e.event.payload as { kind: string; batchId?: string });
    expect(moved.filter((m) => m.kind === 'returned')).toEqual([expect.objectContaining({ batchId: 'D-07' })]);
  });

  it('a batch the bill never sold is refused by name — no money moves', async () => {
    const h = await cast();
    const res = await desk(h, 'RT2', [line('DAL', 'resell', { batchId: 'X-99' })], 5_000);
    expect(res.status).toBe(422);
    expect(codeOf(res)).toBe('return_batch_not_on_the_sale');
    expect((res.body as { error: { whatHappened: string } }).error.whatHappened).toMatch(/DAL batch X-99 was not sold on this bill — it sold D-07/);
    expect(await recordedLines(h, 'RT2')).toBeUndefined();
  });

  it('the bill sold milk from two batches: none named is refused (which one?); naming M-2 carries M-2\'s use-by date', async () => {
    const h = await cast();
    const which = await desk(h, 'RT3', [line('MILK', 'resell')], 2_000);
    expect(codeOf(which)).toBe('return_batch_not_named');
    expect((which.body as { error: { whatHappened: string } }).error.whatHappened).toMatch(/more than one batch \(M-1, M-2\)/);
    const named = await desk(h, 'RT4', [line('MILK', 'resell', { batchId: 'M-2' })], 2_000);
    expect(named.status).toBe(201);
    expect(await recordedLines(h, 'RT4')).toEqual([expect.objectContaining({ batchId: 'M-2', batchExpiry: '2026-10-15' })]);
  });

  it('a till refund (already given) with a batch the bill never sold is recorded and FLAGGED, never refused', async () => {
    const h = await cast();
    const res = await synced(h, 'RT5', [line('DAL', 'resell', { batchId: 'X-99' }), line('MILK', 'resell')], 7_000);
    expect(res.status).toBe(202);
    expect((res.body as { flags: string[] }).flags).toEqual(expect.arrayContaining(['return_batch_not_on_the_sale', 'return_batch_not_named']));
  });
});

describe('PF-14 — what cannot be resold is held, linked to its return, never lost', () => {
  it('damaged, quarantined and scrap lines are held where they came back, with their lot — and none goes on the shelf', async () => {
    const h = await cast();
    const before = (await h.store.readStream(A, STREAM.inventory, { type: 'InventoryMoved' })).length;
    const res = await desk(h, 'RT6', [
      line('DAL', 'damaged', { condition: 'torn pack' }),
      line('MILK', 'quarantine', { batchId: 'M-1', condition: 'smells sour' }),
      line('MILK', 'scrap', { batchId: 'M-2' }),
    ], 9_000);
    expect(res.status).toBe(201);
    // no unit came back onto the shelf
    expect((await h.store.readStream(A, STREAM.inventory, { type: 'InventoryMoved' })).length).toBe(before);
    const list = await held(h);
    expect(list.count).toBe(3);
    expect(list.held).toEqual([
      expect.objectContaining({ returnId: 'RT6', productId: 'DAL', disposition: 'damaged', batchId: 'D-07', batchExpiry: '2026-12-31', condition: 'torn pack', locationId: 'store-1', quantityMinor: 1, heldBy: 'u-owner' }),
      expect.objectContaining({ returnId: 'RT6', productId: 'MILK', disposition: 'quarantine', batchId: 'M-1', batchExpiry: '2026-10-12', condition: 'smells sour', locationId: 'store-1' }),
      expect.objectContaining({ returnId: 'RT6', productId: 'MILK', disposition: 'scrap', batchId: 'M-2', locationId: 'store-1' }),
    ]);
    // a recall of M-1 can find the unit that came back
    expect((await held(h, { batchId: 'M-1' })).held).toEqual([expect.objectContaining({ returnId: 'RT6', disposition: 'quarantine' })]);
  });

  it('a till refund\'s damaged unit is held too; the same refund synced twice is held once', async () => {
    const h = await cast();
    await synced(h, 'RT7', [line('DAL', 'damaged')], 5_000);
    await synced(h, 'RT7', [line('DAL', 'damaged')], 5_000);
    expect((await held(h)).held).toEqual([expect.objectContaining({ returnId: 'RT7', batchId: 'D-07', disposition: 'damaged' })]);
  });

  it('the held list is a stock read: the store manager reads it; a cashier is refused', async () => {
    const h = await cast();
    await h.provisionRole(A, 'u-cash', 'cashier');
    expect((await h.request({ method: 'GET', path: '/v1/returns/held-stock', userId: 'u-mgr', tenantId: A })).status).toBe(200);
    expect((await h.request({ method: 'GET', path: '/v1/returns/held-stock', userId: 'u-cash', tenantId: A })).status).toBe(403);
  });
});
