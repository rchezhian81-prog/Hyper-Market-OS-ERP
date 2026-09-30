import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { COUNT_FLAGS } from '../../services/inventory/src/counts-synced';

/**
 * **A BIN-level blind count relayed from the warehouse handheld is reconciled against head office's own bin contents
 * (SP-3b · W2 · M09-FR-04 · §28 · F07 · hard rules #2/#10, API-04).**
 *
 * The handheld says only what the worker counted in which bin. Head office computes the expected figure from ITS
 * warehouse projection for that bin and product (every batch) plus the corrections of prior bin counts of the same
 * bin; values the variance at its own cost; corrects an immaterial one at once and HOLDS a material one for a
 * separate person. Since SP-5b (F06) a bin correction posts to the bin's occupancy AND, because the bin sits inside the
 * store, to the store's M08 on-hand — one count, one correction, every reader. A bin head office does not have is flagged
 * and held — never reconciled on a guess. Synthetic data (hard rule #7).
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AT = '2026-09-30T11:00:00.000Z';

interface CountBody {
  countId: string; recorded: boolean; alreadyRecorded?: boolean; binId: string | null; expectedMinor: number; countedMinor: number;
  varianceMinor: number; valueMinor: number; adjusted: boolean; pendingApproval: boolean; flags: string[];
}
interface PositionBody {
  systemOnHandMinor: number; countCorrectionMinor: number; postedCorrectionMinor: number; correctedOnHandMinor: number;
  counts: { countId: string; binId?: string | null; adjusted: boolean; pendingApproval?: boolean; governanceFlags?: string[] }[];
}

const binCount = (countId: string, countedMinor: number, over: Record<string, unknown> = {}) => ({
  countId, productId: 'P1', locationId: 'S1', binId: 'BIN-A', uom: 'EA', countedMinor, reasonCode: 'cycle_count', counterId: 'u-worker', at: AT,
  storeId: 'S1', source: 'warehouse-handheld', ...over,
});
const relay = (h: ApiHarness, body: Record<string, unknown>, key: string) =>
  h.request({ method: 'POST', path: `/v1/inventory/counts/${String(body['countId'])}/synced`, userId: 'u-box', tenantId: A, idempotencyKey: key, body });
const position = async (h: ApiHarness): Promise<PositionBody> =>
  (await h.request({ method: 'GET', path: '/v1/inventory/counts', userId: 'u-owner', tenantId: A, query: { productId: 'P1', locationId: 'S1' } })).body as PositionBody;
const binHeld = async (h: ApiHarness, binId = 'BIN-A'): Promise<number> =>
  ((await h.request({ method: 'GET', path: `/v1/warehouse/bins/${binId}`, userId: 'u-owner', tenantId: A })).body as { occupancyMinor: number }).occupancyMinor;
const onHand = async (h: ApiHarness): Promise<number> =>
  ((await h.request({ method: 'GET', path: '/v1/inventory/availability', userId: 'u-owner', tenantId: A, query: { productId: 'P1' } })).body as { rows: { locationId: string; onHandMinor: number }[] })
    .rows.filter((r) => r.locationId === 'S1').reduce((s, r) => s + r.onHandMinor, 0);

/**
 * The cast; 100 of P1 received at S1 at ₹25.00 (the cloud's cost); BIN-A registered and 30 of P1 put away into it in two
 * batches (so the store holds 100 and the bin 30 — two different expected figures).
 */
async function seeded(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-worker', 'store_manager');
  await h.provisionRole(A, 'u-box', 'cashier');
  const seed = await h.request({
    method: 'POST', path: '/v1/inventory/goods-receipt/grn-seed', userId: 'u-worker', tenantId: A, idempotencyKey: 'k-seed',
    body: {
      warehouseId: 'S1', receivedOnDate: '2026-09-01', currency: 'INR',
      lines: [{ lineId: 'L1', productId: 'P1', orderedMinor: 100, countedMinor: 100, uom: 'EA', unitCost: { minor: 2500, currency: 'INR' }, condition: 'good' }],
    },
  });
  expect(seed.status).toBe(201);
  expect((await h.request({ method: 'POST', path: '/v1/warehouse/bins/BIN-A', userId: 'u-owner', tenantId: A, idempotencyKey: 'bin-a', body: { storeId: 'S1', capacityMinor: 1000, pickable: true, zone: 'ambient' } })).status).toBe(201);
  for (const [id, batch, qty] of [['pa-1', 'b-1', 20], ['pa-2', 'b-2', 10]] as const) {
    const res = await h.request({ method: 'POST', path: `/v1/warehouse/movements/${id}`, userId: 'u-worker', tenantId: A, idempotencyKey: id, body: { kind: 'put_away', storeId: 'S1', productId: 'P1', batchId: batch, quantityMinor: qty, uom: 'EA', fromBinId: null, toBinId: 'BIN-A' } });
    expect(res.status).toBe(201);
  }
  expect(await binHeld(h)).toBe(30);
  return h;
}

describe('a bin-level blind count is reconciled against head office\'s bin contents', () => {
  it('expected = the bin\'s contents across batches (30), not the store\'s on-hand (100); a matching count reconciles with nothing applied', async () => {
    const h = await seeded();
    const res = await relay(h, binCount('bc-1', 30), 'k-bc-1');
    expect(res.status).toBe(202);
    expect(res.body as CountBody).toMatchObject({ countId: 'bc-1', binId: 'BIN-A', expectedMinor: 30, countedMinor: 30, varianceMinor: 0, adjusted: false, pendingApproval: false });
    const pos = await position(h);
    expect(pos.counts).toHaveLength(1);
    expect(pos.counts[0]).toMatchObject({ countId: 'bc-1', binId: 'BIN-A', adjusted: false });
    // The store-level position is untouched by a bin count that matched.
    expect(pos).toMatchObject({ systemOnHandMinor: 100, countCorrectionMinor: 0, correctedOnHandMinor: 100 });
  });

  it('an IMMATERIAL bin variance corrects at once — the bin\'s occupancy, the store\'s on-hand and every stock reader (F06, SP-5b)', async () => {
    const h = await seeded();
    expect(await binHeld(h)).toBe(30);
    // 28 counted of 30 → −2 × ₹25.00 = ₹50.00, under the ₹1 000 default.
    const first = await relay(h, binCount('bc-2', 28), 'k-bc-2');
    expect(first.body as CountBody).toMatchObject({ expectedMinor: 30, varianceMinor: -2, valueMinor: 5_000, adjusted: true, pendingApproval: false, movementId: 'count:bc-2' });
    // SP-5b: the bin's occupancy corrected on the warehouse projection (30 → 28) — and, because the bin sits inside the
    // store, the store's on-hand corrected on the M08 ledger too (100 → 98). One count, one correction, every reader.
    expect(await binHeld(h)).toBe(28);
    expect(await onHand(h)).toBe(98);
    // The next bin count is measured against the corrected bin figure (30 − 2).
    const next = await relay(h, binCount('bc-3', 28), 'k-bc-3');
    expect(next.body as CountBody).toMatchObject({ expectedMinor: 28, varianceMinor: 0, adjusted: false });
    // A STORE-level count of the same product reads the corrected store figure, 98 — not a stale 100.
    const store = await relay(h, binCount('sc-1', 98, { binId: null, source: 'manager-screen', counterId: 'u-worker' }), 'k-sc-1');
    expect(store.body as CountBody).toMatchObject({ binId: null, expectedMinor: 98, varianceMinor: 0 });
    // …and the position states what the counts posted, layering nothing twice, while the register lists them all.
    const pos = await position(h);
    expect(pos).toMatchObject({ systemOnHandMinor: 98, countCorrectionMinor: 0, postedCorrectionMinor: -2, correctedOnHandMinor: 98 });
    expect(pos.counts.map((c) => [c.countId, c.binId ?? null])).toEqual([['bc-2', 'BIN-A'], ['bc-3', 'BIN-A'], ['sc-1', null]]);
  });

  it('a MATERIAL bin variance is recorded, valued and HELD for a second person — the bin figure is not corrected (§28, #10)', async () => {
    const h = await seeded();
    // 0 counted of 30 → −30 × ₹25.00 = ₹750.00 (75 000 minor) — under the default ₹1 000? No: set the policy low so it is material.
    expect((await h.request({ method: 'POST', path: '/v1/inventory/count-policy', userId: 'u-owner', tenantId: A, idempotencyKey: 'k-pol', body: { approvalThresholdMinor: 50_000 } })).status).toBe(201);
    const res = await relay(h, binCount('bc-4', 0), 'k-bc-4');
    expect(res.status).toBe(202);
    expect(res.body as CountBody).toMatchObject({ expectedMinor: 30, varianceMinor: -30, valueMinor: 75_000, adjusted: false, pendingApproval: true, flags: [] });
    // Held: the next count of the bin still expects 30 — nothing was applied on the counter's say-so, on the bin or the store.
    const again = await relay(h, binCount('bc-5', 30), 'k-bc-5');
    expect(again.body as CountBody).toMatchObject({ expectedMinor: 30, varianceMinor: 0 });
    expect(await binHeld(h)).toBe(30);
    expect(await onHand(h)).toBe(100);
    expect((await position(h)).counts.find((c) => c.countId === 'bc-4')).toMatchObject({ pendingApproval: true, adjusted: false });
  });

  it('a bin head office does not have is flagged bin_unknown and HELD whatever the figure — never reconciled on a guess', async () => {
    const h = await seeded();
    const res = await relay(h, binCount('bc-6', 4, { binId: 'BIN-Z' }), 'k-bc-6');
    expect(res.status).toBe(202);
    expect(res.body as CountBody).toMatchObject({ binId: 'BIN-Z', expectedMinor: 0, countedMinor: 4, adjusted: false, pendingApproval: true });
    expect((res.body as CountBody).flags).toContain('bin_unknown');
    expect(COUNT_FLAGS).toContain('bin_unknown');
    // Even a count of zero in an unknown bin waits for a person.
    const zero = await relay(h, binCount('bc-7', 0, { binId: 'BIN-Z' }), 'k-bc-7');
    expect(zero.body as CountBody).toMatchObject({ varianceMinor: 0, pendingApproval: true });
  });

  it('the same bin count again is 200 alreadyRecorded with the bin on it, and one record; the counter is re-verified as on any count', async () => {
    const h = await seeded();
    await relay(h, binCount('bc-8', 30), 'k-bc-8');
    const again = await relay(h, binCount('bc-8', 30), 'k-bc-8-again');
    expect(again.status).toBe(200);
    expect(again.body as CountBody).toMatchObject({ alreadyRecorded: true, binId: 'BIN-A' });
    expect((await position(h)).counts.filter((c) => c.countId === 'bc-8')).toHaveLength(1);
    const stranger = await relay(h, binCount('bc-9', 30, { counterId: 'u-nobody' }), 'k-bc-9');
    expect((stranger.body as CountBody).flags).toContain('counter_unknown');
    // A malformed bin is not a count.
    expect((await relay(h, binCount('bc-10', 30, { binId: 42 }), 'k-bc-10')).status).toBe(400);
  });
});
