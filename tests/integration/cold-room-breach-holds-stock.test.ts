import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// PA-07 (audit, HIGH): a cold-room breach used to REPORT `holdStock: true` on a GET and do nothing
// else — the stock inside stayed sellable and sendable. M26-FR-02 says "a cold-chain breach raises a
// quality hold (M10)"; M10-FR-02 says "a cold-chain breach quarantines the affected batch and records
// evidence; quality-held stock is not sellable until released". Proved end to end through the real API:
//   • the reading that puts a room in breach places the M10 hold on every batch in it, in the same
//     write, the room / excursion / reading ids kept on the hold as evidence;
//   • a held batch is refused by dispatch until authorised QC releases it;
//   • one excursion holds a batch once (a retried or later reading of the same excursion adds nothing,
//     and a release is not undone by it); a NEW excursion holds it again;
//   • inside the grace nothing is held; a room gone quiet is held by the hold check, as the engine says.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const minutesAgo = (m: number): string => new Date(Date.now() - m * 60_000).toISOString();
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

const setRange = (h: ApiHarness, over: Record<string, unknown> = {}) =>
  h.request({ method: 'POST', path: '/v1/facilities/equipment/cold-1/range', userId: 'u-owner', tenantId: A, idempotencyKey: 'rg-cold-1',
    body: { branchId: 'WH', name: 'Cold room 1', minTenthsC: 0, maxTenthsC: 80, graceMinutes: 30, expectEveryMinutes: 120, ...over } });
const setContents = (h: ApiHarness, contents: unknown) =>
  h.request({ method: 'POST', path: '/v1/facilities/equipment/cold-1/contents', userId: 'u-owner', tenantId: A, idempotencyKey: `ct-${JSON.stringify(contents).length}`, body: { contents } });
const reading = (h: ApiHarness, readingId: string, tenthsC: number, at: string, userId = 'u-owner') =>
  h.request({ method: 'POST', path: `/v1/facilities/equipment/cold-1/readings/${readingId}`, userId, tenantId: A, idempotencyKey: `rd-${readingId}`,
    body: { tenthsC, at, source: 'sensor', recordedBy: 'probe-1' } });
const holdCheck = (h: ApiHarness, key: string, userId = 'u-owner') =>
  h.request({ method: 'POST', path: '/v1/facilities/equipment/cold-1/hold-check', userId, tenantId: A, idempotencyKey: key, body: {} });
const holdOf = async (h: ApiHarness, batchId: string) =>
  (await h.request({ method: 'GET', path: `/v1/quality/holds/${batchId}`, userId: 'u-owner', tenantId: A })) as { status: number; body: { hold: Hold } };
const register = async (h: ApiHarness) =>
  (await h.request({ method: 'GET', path: '/v1/quality/holds', userId: 'u-owner', tenantId: A })).body as { holds: Hold[]; heldCount: number };
const release = (h: ApiHarness, batchId: string, key: string) =>
  h.request({ method: 'POST', path: `/v1/quality/holds/${batchId}/release`, userId: 'u-qc', tenantId: A, idempotencyKey: key, body: {} });

interface Hold {
  batchId: string; productId: string; status: string; reason: string; heldBy: string;
  equipment?: { assetId: string; episodeId: string; state: string; peakTenthsC: number | null; minutesOutOfRange: number; readingIds: string[] };
}
interface ReadingReply { state: string; heldBatches: string[] }

const BATCHES = [
  { batchId: 'b-chicken', productId: 'P1', valueMinor: 100_000 },
  { batchId: 'b-paneer', productId: 'P1', valueMinor: 84_000 },
];

async function room(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-qc', 'store_manager');
  expect((await setRange(h)).status).toBe(201);
  expect((await setContents(h, BATCHES)).status).toBe(201);
  return h;
}

describe('PA-07: a cold-room breach places the stock inside on quality hold', () => {
  it('the breaching reading holds every batch in the room, with the readings as evidence', async () => {
    const h = await room();
    // 12 °C two hours ago, nothing since — out of range for two hours, far past the 30-minute grace.
    const first = await reading(h, 'r1', 120, minutesAgo(120));
    expect(first.status).toBe(201);
    expect((first.body as ReadingReply).state).toBe('breach');
    expect((first.body as ReadingReply).heldBatches.sort()).toEqual(['b-chicken', 'b-paneer']);

    const chicken = await holdOf(h, 'b-chicken');
    expect(chicken.status).toBe(200);
    expect(chicken.body.hold).toMatchObject({ batchId: 'b-chicken', productId: 'P1', status: 'held', heldBy: 'u-owner' });
    expect(chicken.body.hold.reason).toMatch(/Cold room 1/);
    expect(chicken.body.hold.equipment).toMatchObject({ assetId: 'cold-1', episodeId: 'breach:r1', state: 'breach', peakTenthsC: 120, readingIds: ['r1'] });
    expect(chicken.body.hold.equipment!.minutesOutOfRange).toBeGreaterThanOrEqual(119);
    expect((await register(h)).heldCount).toBe(2);
  });

  it('a held batch cannot be dispatched until QC releases it', async () => {
    const h = await room();
    await h.provisionRole(A, 'u-boss', 'store_manager');
    const node = (id: string, body: Record<string, unknown>) => h.request({ method: 'POST', path: `/v1/org/nodes/${id}`, userId: 'u-owner', tenantId: A, idempotencyKey: `org-${id}`, body });
    expect((await node('C1', { kind: 'company', name: 'SRE Retail' })).status).toBe(201);
    expect((await node('WH', { kind: 'warehouse', name: 'Central warehouse', parentId: 'C1', companyId: 'C1' })).status).toBe(201);
    expect((await node('S1', { kind: 'branch', name: 'Store 1', parentId: 'C1', companyId: 'C1' })).status).toBe(201);
    expect((await h.request({ method: 'POST', path: '/v1/inventory/movements', userId: 'u-owner', tenantId: A, idempotencyKey: 'seed-chicken',
      body: { movementId: 'seed-chicken', productId: 'P1', locationId: 'WH', kind: 'received', quantityMinor: 50, uom: 'EA', occurredAt: '2026-08-01T00:00:00.000Z', enteredBy: 'u-owner', batchId: 'b-chicken' } })).status).toBeLessThan(300);

    expect(((await reading(h, 'r1', 120, minutesAgo(120))).body as ReadingReply).heldBatches).toContain('b-chicken');

    const line = { productId: 'P1', batchId: 'b-chicken', quantityMinor: 10, uom: 'EA', unitCost: { minor: 5_000, currency: 'INR' } };
    const propose = (id: string) => h.request({ method: 'POST', path: `/v1/warehouse/transfers/${id}`, userId: 'u-owner', tenantId: A, idempotencyKey: `tr-${id}`, body: { fromLocationId: 'WH', toLocationId: 'S1', lines: [line] } });
    const dispatch = (id: string) => h.request({ method: 'POST', path: `/v1/warehouse/transfers/${id}/dispatch`, userId: 'u-boss', tenantId: A, idempotencyKey: `td-${id}`, body: {} });

    await propose('t1');
    const refused = await dispatch('t1');
    expect(codeOf(refused)).toBe('transfer_refused');
    expect(JSON.stringify(refused.body)).toMatch(/quarantine/);

    // Authorised QC (a second person) releases it; then — and only then — it can be sent.
    expect((await release(h, 'b-chicken', 'rel-1')).status).toBe(200);
    await propose('t2');
    expect((await dispatch('t2')).status).toBeLessThan(300);
  });

  it('one excursion holds a batch once; a release stands; a new excursion holds it again', async () => {
    const h = await room();
    // Readings well inside the 2-hour reporting expectation — this is a breach, not a silence.
    const at1 = minutesAgo(100);
    expect(((await reading(h, 'r1', 120, at1)).body as ReadingReply).heldBatches).toHaveLength(2);
    // The same reading retried, and a later reading of the SAME excursion, add nothing — already held.
    expect((await reading(h, 'r1', 120, at1)).status).toBe(201);
    expect(((await reading(h, 'r2', 130, minutesAgo(80))).body as ReadingReply).heldBatches).toEqual([]);
    expect((await register(h)).holds).toHaveLength(2);

    // QC releases the paneer; the excursion continues — the release is NOT undone by it.
    expect((await release(h, 'b-paneer', 'rel-p')).status).toBe(200);
    expect(((await reading(h, 'r3', 125, minutesAgo(70))).body as ReadingReply).heldBatches).toEqual([]);
    expect((await holdOf(h, 'b-paneer')).body.hold.status).toBe('released');

    // Back in range — nothing new. Then a fresh excursion, long enough to be a breach: held again.
    expect(((await reading(h, 'r4', 40, minutesAgo(60))).body as ReadingReply).heldBatches).toEqual([]);
    const again = (await reading(h, 'r5', 110, minutesAgo(40))).body as ReadingReply;
    expect(again.state).toBe('breach');
    expect(again.heldBatches).toEqual(['b-paneer']); // the chicken was never released — it is still held
    expect((await holdOf(h, 'b-paneer')).body.hold).toMatchObject({ status: 'held', equipment: { episodeId: 'breach:r5', readingIds: ['r5'] } });
  });

  it('an excursion inside the grace holds nothing', async () => {
    const h = await room();
    expect(((await reading(h, 'r1', 40, minutesAgo(30))).body as ReadingReply).heldBatches).toEqual([]);
    const drift = (await reading(h, 'r2', 95, minutesAgo(10))).body as ReadingReply;
    expect(drift.state).toBe('drifting');
    expect(drift.heldBatches).toEqual([]);
    expect((await holdOf(h, 'b-chicken')).status).toBe(404);
    // Still drifting when the round's hold check runs: nothing held.
    expect(((await holdCheck(h, 'hc-1')).body as ReadingReply).heldBatches).toEqual([]);
  });

  it('a room gone quiet is held by the hold check — silence is not a pass — once', async () => {
    const h = await room();
    expect(((await reading(h, 'r1', 40, minutesAgo(240))).body as ReadingReply).state).toBe('stale');
    // The backdated reading itself already shows the probe silent for four hours: held at once.
    expect((await register(h)).heldCount).toBe(2);
    expect((await holdOf(h, 'b-chicken')).body.hold.equipment).toMatchObject({ state: 'stale', episodeId: 'silent:r1', readingIds: ['r1'] });
    // The round's hold check finds nothing more to do — the same silence holds once.
    const check = await holdCheck(h, 'hc-1');
    expect(check.status).toBe(200);
    expect((check.body as ReadingReply).state).toBe('stale');
    expect((check.body as ReadingReply).heldBatches).toEqual([]);
  });

  it('the hold check holds a room that has never reported', async () => {
    const h = await room();
    const check = (await holdCheck(h, 'hc-1')).body as ReadingReply;
    expect(check.state).toBe('no_data');
    expect(check.heldBatches.sort()).toEqual(['b-chicken', 'b-paneer']);
    expect((await holdOf(h, 'b-paneer')).body.hold.equipment).toMatchObject({ state: 'no_data', episodeId: 'silent:never', readingIds: [] });
  });

  it('an empty room or a room in range holds nothing; the check needs the right permission and a known room', async () => {
    const h = await room();
    expect(((await reading(h, 'r1', 40, minutesAgo(5))).body as ReadingReply).heldBatches).toEqual([]);
    expect(((await holdCheck(h, 'hc-1')).body as ReadingReply).state).toBe('within_range');
    expect((await register(h)).holds).toEqual([]);

    await h.provisionRole(A, 'u-till', 'cashier');
    expect((await holdCheck(h, 'hc-2', 'u-till')).status).toBe(403);
    expect((await h.request({ method: 'POST', path: '/v1/facilities/equipment/nowhere/hold-check', userId: 'u-owner', tenantId: A, idempotencyKey: 'hc-3', body: {} })).status).toBe(404);
  });
});
