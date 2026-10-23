import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { useBackings } from '../support/backings';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM } from '../../services/api/src/adapters';
import { lane2ExpirySweep } from '../../services/api/src/lane2-offline-adapters';

// OB-288 lane 2 · P2 (§31 · P-01 · hard rules #2 #6 #10) — head office's half of the store's offline queues, on the REAL API
// with REAL RBAC, in memory and (with DATABASE_URL) on real PostgreSQL. Each relayed record:
//   • only the store computer's hop relays it, only for its own store;
//   • the FACT is the store's (who, when — timed by when it was done there), the JUDGEMENT is head office's own engine;
//   • the person is re-verified from their own grants — flagged on a physical fact (a run, a weigh, a reading), refused on a
//     governance decision (a quality release);
//   • the same record again is 200 (one effect); a DIFFERENT record under the same id, or a slot somebody else already
//     recorded, is refused by name (a visible conflict at the store, never last-write-wins).
// And the daily expiry move (M10-FR-01): a batch past its date moves to the expired state ONCE, append-only, with the
// write-off that bins it beside it. Synthetic data only (hard rule #7).

const backings = useBackings();
const S1 = 'S1'; const KITCHEN = 'S1-KITCHEN'; const SHELF = 'S1-SHELF'; const S2 = 'S2';
type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } } | null)?.error?.code;

async function shop(h: ApiHarness) {
  const T = randomUUID();
  await h.seedOwner(T, 'u-owner');
  await h.provisionRole(T, 'u-box', 'store_computer', [S1]);
  await h.provisionRole(T, 'u-box-2', 'store_computer', [S2]);
  await h.provisionRole(T, 'u-cook', 'store_manager', [S1]);
  await h.provisionRole(T, 'u-qc', 'store_manager', [S1]);
  await h.provisionRole(T, 'u-cash', 'cashier', [S1]);
  const BRANCH: Record<string, string> = { 'u-box': S1, 'u-box-2': S2, 'u-cook': S1, 'u-qc': S1, 'u-cash': S1 };
  const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, key?: string, query?: Record<string, string>): Promise<Res> =>
    h.request({ method, path, userId, tenantId: T, ...(BRANCH[userId] === undefined ? {} : { branchId: BRANCH[userId] }), ...(method === 'GET' ? {} : { idempotencyKey: key ?? `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
  for (const [id, body] of [
    ['C1', { kind: 'company', name: 'SRE Retail' }],
    [S1, { kind: 'branch', name: 'Store 1', parentId: 'C1', companyId: 'C1' }],
    [KITCHEN, { kind: 'department', name: 'Cafe kitchen', parentId: S1, companyId: 'C1' }],
    [SHELF, { kind: 'department', name: 'Dairy shelf', parentId: S1, companyId: 'C1' }],
    [S2, { kind: 'branch', name: 'Store 2', parentId: 'C1', companyId: 'C1' }],
  ] as const) expect((await call('POST', `/v1/org/nodes/${id}`, 'u-owner', body, `org-${id}`)).status).toBe(201);
  return { T, call };
}

const onHand = async (call: Call, productId: string, locationId: string): Promise<number> => {
  const rows = ((await call('GET', '/v1/inventory/availability', 'u-owner')).body as { rows: { productId: string; locationId: string; onHandMinor: number }[] }).rows;
  return rows.find((r) => r.productId === productId && r.locationId === locationId)?.onHandMinor ?? 0;
};
type Call = Awaited<ReturnType<typeof shop>>['call'];

async function kitchen(call: Call): Promise<void> {
  expect((await call('POST', '/v1/production/departments/cafe', 'u-owner', {}, 'dept-cafe')).status).toBeLessThan(300);
  expect((await call('POST', '/v1/production/recipes/r-cake', 'u-owner', {
    departmentId: 'cafe', outputProductId: 'CAKE', outputQuantityMinor: 1, outputUom: 'ea',
    inputs: [{ productId: 'FLOUR', quantityMinor: 100, uom: 'g' }], shelfLifeHours: 48, expectedYieldBp: 10_000, yieldToleranceBp: 500,
  }, 'rc-cake')).status).toBe(201);
  expect((await call('POST', '/v1/inventory/movements', 'u-owner', { movementId: 'seed-flour', productId: 'FLOUR', locationId: KITCHEN, kind: 'received', quantityMinor: 250, uom: 'g', occurredAt: '2026-10-01T00:00:00.000Z', enteredBy: 'u-owner' }, 'seed-flour')).status).toBeLessThan(300);
}

const MADE_AT = '2026-10-20T06:15:00.000Z';
const runBody = (runId: string, over: Record<string, unknown> = {}) => ({
  runId, storeId: S1, recipeId: 'r-cake', batches: 2, actualOutputMinor: 2, outputBatchId: `CAKE-${runId}`, locationId: KITCHEN,
  producedBy: 'u-cook', at: MADE_AT, source: 'production-screen', ...over,
});

describe.each(backings)('M11-FR-01/03 offline: a production run and its release, relayed by the store computer — on $name', ({ harness }) => {
  it('records the run once in the cook\'s name at the time it was made, flags a shortfall and an unauthorised cook, refuses a conflicting run and an unauthorised release', async () => {
    const h = harness();
    const { call } = await shop(h);
    await kitchen(call);

    // Only the box's hop; only its own store's kitchen; a body that is not a run.
    expect(codeOf(await call('POST', '/v1/production/runs/run-a/synced', 'u-cook', runBody('run-a')))).toBe('forbidden');
    expect((await call('POST', '/v1/production/runs/run-a/synced', 'u-box-2', runBody('run-a', { storeId: S2 }))).status).toBe(403);
    expect(codeOf(await call('POST', '/v1/production/runs/run-a/synced', 'u-box', runBody('run-other')))).toBe('not_readable_as_a_relayed_run');

    const made = await call('POST', '/v1/production/runs/run-a/synced', 'u-box', runBody('run-a'), 'run-a');
    expect(made.status).toBe(202);
    // The use-by follows from when it was MADE (48 h after 06:15), not from when the line came back.
    expect(made.body).toMatchObject({ runId: 'run-a', outputBatchId: 'CAKE-run-a', outputQuantityMinor: 2, expiresAt: '2026-10-22T06:15:00Z', flags: [], relayed: { relayedBy: 'u-box', source: 'production-screen', storeId: S1 } });
    expect(await onHand(call, 'FLOUR', KITCHEN)).toBe(50);
    // The same run again (a re-sent queue item, a new key) is ONE run; a different run under the same id is a conflict.
    expect((await call('POST', '/v1/production/runs/run-a/synced', 'u-box', runBody('run-a'), 'run-a-again')).body).toMatchObject({ alreadyRecorded: true });
    expect(codeOf(await call('POST', '/v1/production/runs/run-a/synced', 'u-box', runBody('run-a', { actualOutputMinor: 1 })))).toBe('run_conflicts_with_record');
    expect(await onHand(call, 'FLOUR', KITCHEN)).toBe(50);

    // The kitchen made another two cakes than the books can cover (50 g left, 200 g used): the food exists, so the run is
    // recorded and the shortfall SAID, by ingredient; a cashier named as the cook is flagged, not trusted.
    const short = await call('POST', '/v1/production/runs/run-b/synced', 'u-box', runBody('run-b', { producedBy: 'u-cash' }), 'run-b');
    expect(short.status).toBe(202);
    expect(short.body).toMatchObject({ flags: ['producer_lacks_authority', 'ingredient_short_at_head_office'], shortAtHeadOffice: [{ productId: 'FLOUR', shortMinor: 150, uom: 'g' }] });
    expect(await onHand(call, 'FLOUR', KITCHEN)).toBe(-150);
    const board = ((await call('GET', '/v1/production/runs', 'u-owner', undefined, undefined, { locationId: KITCHEN })).body as { runs: { runId: string; syncFlags?: string[]; producedBy: string; relayed?: unknown }[] }).runs;
    expect(board.find((r) => r.runId === 'run-b')).toMatchObject({ producedBy: 'u-cash', syncFlags: ['producer_lacks_authority', 'ingredient_short_at_head_office'], relayed: { relayedBy: 'u-box' } });

    // RELEASE: a decision — a cashier is refused (the batch stays in quarantine), a QC person releases it once.
    const release = (runId: string, over: Record<string, unknown> = {}) => ({ runId, storeId: S1, qcPassed: true, releasedBy: 'u-qc', at: '2026-10-20T07:00:00.000Z', source: 'production-screen', ...over });
    expect(codeOf(await call('POST', '/v1/production/runs/run-a/release/synced', 'u-box', release('run-a', { releasedBy: 'u-cash' })))).toBe('releaser_lacks_authority');
    expect(await onHand(call, 'CAKE', KITCHEN)).toBe(0);
    // A release of a run head office has not heard yet waits (425) — the run travels first on the same queue.
    const early = await call('POST', '/v1/production/runs/run-z/release/synced', 'u-box', release('run-z'));
    expect([early.status, codeOf(early)]).toEqual([425, 'run_not_known_yet']);
    const ok = await call('POST', '/v1/production/runs/run-a/release/synced', 'u-box', release('run-a'), 'rel-a');
    expect(ok.status).toBe(202);
    expect(ok.body).toMatchObject({ released: true, releasedBy: 'u-qc', releasedAt: '2026-10-20T07:00:00.000Z' });
    expect(await onHand(call, 'CAKE', KITCHEN)).toBe(2);
    expect((await call('POST', '/v1/production/runs/run-a/release/synced', 'u-box', release('run-a'), 'rel-a-again')).body).toMatchObject({ alreadyReleased: true });
    // Another person's "check failed" on a batch already released is a conflict a person must look at — never folded away.
    expect(codeOf(await call('POST', '/v1/production/runs/run-a/release/synced', 'u-box', release('run-a', { releasedBy: 'u-owner', qcPassed: false })))).toBe('batch_released_by_another');
    // A HOLD on a batch not yet released keeps it in quarantine and is kept in the trail.
    expect((await call('POST', '/v1/production/runs/run-b/release/synced', 'u-box', release('run-b', { qcPassed: false, notes: 'underbaked' }))).body).toMatchObject({ released: false, held: true, decidedBy: 'u-qc' });
    expect(await onHand(call, 'CAKE', KITCHEN)).toBe(2);
    // The recipes read the screen and the box keep for offline capture.
    const recipes = (await call('GET', '/v1/production/recipes', 'u-cook')).body as { recipes: { recipeId: string; shelfLifeHours: number }[]; enabledDepartments: string[] };
    expect(recipes).toMatchObject({ recipes: [expect.objectContaining({ recipeId: 'r-cake', shelfLifeHours: 48 })], enabledDepartments: ['cafe'] });
    expect((await call('GET', '/v1/production/recipes', 'u-cash')).status).toBe(403);
  });
});

describe.each(backings)('M11-FR-02 offline: a weigh-in / weigh-out, costed at head office — on $name', ({ harness }) => {
  it('costs the weights at head office\'s own kilo price, says "cost not known" rather than zero, and refuses different weights under the same id', async () => {
    const h = harness();
    const { T, call } = await shop(h);
    // The product master counts the carcass and the cuts in kilograms; head office bought 10 kg of chicken at ₹180/kg.
    await h.store.append(T, STREAM.catalogue, makeEvent({
      id: `pack-${T}-1`, type: 'CataloguePublished', occurredAt: '2026-10-01T00:00:00.000Z', idempotencyKey: `catalogue-${T}-v1`, source: 'test/catalogue',
      payload: { snapshot: { tenantId: T, version: 1, builtAt: '2026-10-01T00:00:00.000Z', scope: { tenantId: T, storeId: S1 }, barcodes: [], products: [
        { productId: 'CHICKEN', sku: 'CHICKEN', name: 'Whole chicken', unitPriceMinor: 0, taxBps: 0, status: 'active', baseUom: 'kg' },
        { productId: 'MUTTON', sku: 'MUTTON', name: 'Mutton', unitPriceMinor: 0, taxBps: 0, status: 'active', baseUom: 'kg' },
      ] } },
    }));
    expect((await call('POST', '/v1/inventory/movements', 'u-owner', { movementId: 'seed-ch', productId: 'CHICKEN', locationId: KITCHEN, kind: 'received', quantityMinor: 10_000, uom: 'kg', occurredAt: '2026-10-01T00:00:00.000Z', enteredBy: 'u-owner', unitCostMinor: 18_000 }, 'seed-ch')).status).toBeLessThan(300);
    const weighed = (runId: string, over: Record<string, unknown> = {}) => ({
      runId, storeId: S1, departmentId: 'meat', inputs: [{ productId: 'CHICKEN', weightGrams: 2_000 }],
      outputs: [{ productId: 'CHICKEN-CUTS', weightGrams: 1_500 }, { productId: 'BONE', weightGrams: 400, isByproduct: true }],
      standardYieldBp: 8_000, toleranceBp: 500, weighedBy: 'u-cook', at: '2026-10-20T05:00:00.000Z', source: 'production-screen', ...over,
    });
    // A cost typed at the counter is not part of an offline capture: head office costs it.
    expect(codeOf(await call('POST', '/v1/production/weighed-runs/w1/synced', 'u-box', weighed('w1', { inputs: [{ productId: 'CHICKEN', weightGrams: 2_000, costPerKg: { minor: 1, currency: 'INR' } }] })))).toBe('not_readable_as_a_relayed_weighed_run');
    const w = await call('POST', '/v1/production/weighed-runs/w1/synced', 'u-box', weighed('w1'), 'w1');
    expect(w.status).toBe(202);
    expect(w.body).toMatchObject({ runId: 'w1', weighedBy: 'u-cook', costKnown: true, uncostedProducts: [], syncFlags: [], result: { inputWeightGrams: 2_000, outputWeightGrams: 1_900, lossGrams: 100, inputCost: { minor: 36_000 } } });
    expect((await call('POST', '/v1/production/weighed-runs/w1/synced', 'u-box', weighed('w1'), 'w1-again')).body).toMatchObject({ alreadyCosted: true });
    expect(codeOf(await call('POST', '/v1/production/weighed-runs/w1/synced', 'u-box', weighed('w1', { inputs: [{ productId: 'CHICKEN', weightGrams: 2_100 }] })))).toBe('weighed_run_conflicts_with_record');
    // Mutton head office has never bought: weighed and recorded, its cost NOT KNOWN — never priced at zero as if free.
    const m = await call('POST', '/v1/production/weighed-runs/w2/synced', 'u-box', weighed('w2', { inputs: [{ productId: 'MUTTON', weightGrams: 1_000 }], outputs: [{ productId: 'MUTTON-CUTS', weightGrams: 800 }], weighedBy: 'u-nobody' }), 'w2');
    expect(m.body).toMatchObject({ costKnown: false, uncostedProducts: ['MUTTON'], syncFlags: ['weigher_unknown'] });
    const boardRuns = ((await call('GET', '/v1/production/weighed-runs', 'u-owner')).body as { runs: { runId: string }[] }).runs;
    expect(boardRuns.map((r) => r.runId).sort()).toEqual(['w1', 'w2']);
    expect((await call('POST', '/v1/production/weighed-runs/w3/synced', 'u-cook', weighed('w3'))).status).toBe(403);
  });
});

describe.each(backings)('M10-FR-02 offline: a food-safety check recorded with the line down — on $name', ({ harness }) => {
  it('files the check at the time it was done (not late because the line was slow), flags an unauthorised person, refuses a slot somebody else recorded', async () => {
    const h = harness();
    const { call } = await shop(h);
    const HOUR = 3_600_000;
    const H = Math.floor(Date.now() / HOUR) * HOUR;
    const at = (hours: number, minutes = 0) => new Date(H + hours * HOUR + minutes * 60_000).toISOString();
    expect((await call('POST', '/v1/facilities/food-safety/checks/chiller', 'u-owner', { branchId: S1, title: 'Dairy chiller', kind: 'temperature', everyMinutes: 60, startsAt: at(-6), graceMinutes: 30, minTenthsC: 0, maxTenthsC: 50, assignedRole: 'store_manager', escalatesTo: 'u-owner' }, 'def')).status).toBe(201);
    const rec = (recordId: string, over: Record<string, unknown> = {}) => ({ recordId, checkId: 'chiller', storeId: S1, performedBy: 'u-cook', at: at(-4, 5), slotDueAt: at(-4), readingTenthsC: 40, source: 'facilities-screen', ...over });
    expect(codeOf(await call('POST', '/v1/facilities/food-safety/checks/chiller/records/fs-1/synced', 'u-cook', rec('fs-1')))).toBe('forbidden');
    expect(codeOf(await call('POST', '/v1/facilities/food-safety/checks/ghost/records/fs-1/synced', 'u-box', rec('fs-1', { checkId: 'ghost' })))).toBe('check_not_known_at_head_office');
    const filed = await call('POST', '/v1/facilities/food-safety/checks/chiller/records/fs-1/synced', 'u-box', rec('fs-1'), 'fs-1');
    expect(filed.status).toBe(202);
    // Done four hours ago, five minutes after its slot: on time, in the cook's name, the relay beside them.
    expect(filed.body).toMatchObject({ record: { recordId: 'fs-1', performedBy: 'u-cook', performedAt: at(-4, 5), outcome: 'pass', late: false, offline: { relayedBy: 'u-box', flags: [] } } });
    expect((await call('POST', '/v1/facilities/food-safety/checks/chiller/records/fs-1/synced', 'u-box', rec('fs-1'), 'fs-1-again')).body).toMatchObject({ alreadyRecorded: true });
    // The same slot recorded under another id (another screen, the same chiller): refused by name — 422, never "on file".
    const twice = await call('POST', '/v1/facilities/food-safety/checks/chiller/records/fs-2/synced', 'u-box', rec('fs-2', { performedBy: 'u-qc' }));
    expect([twice.status, codeOf(twice)]).toEqual([422, 'check_already_recorded']);
    expect(codeOf(await call('POST', '/v1/facilities/food-safety/checks/chiller/records/fs-1/synced', 'u-box', rec('fs-1', { readingTenthsC: 45 })))).toBe('check_record_conflicts_with_record');
    // A breach needs its corrective action; a cashier's reading is filed and FLAGGED (the reading was taken).
    expect(codeOf(await call('POST', '/v1/facilities/food-safety/checks/chiller/records/fs-3/synced', 'u-box', rec('fs-3', { slotDueAt: at(-3), at: at(-3, 2), readingTenthsC: 90 })))).toBe('corrective_action_required');
    const flagged = await call('POST', '/v1/facilities/food-safety/checks/chiller/records/fs-4/synced', 'u-box', rec('fs-4', { slotDueAt: at(-3), at: at(-3, 2), readingTenthsC: 90, correctiveAction: 'moved the curd to chiller 2', performedBy: 'u-cash' }));
    expect(flagged.body).toMatchObject({ record: { outcome: 'fail', correctiveAction: 'moved the curd to chiller 2', offline: { flags: ['performer_lacks_authority'] } } });
    const status = (await call('GET', '/v1/facilities/food-safety/status', 'u-owner', undefined, undefined, { branchId: S1 })).body as { failedCount: number; slots: { slotDueAt: string; state: string }[] };
    expect(status.failedCount).toBe(1);
    expect(status.slots.find((s) => s.slotDueAt === at(-4))?.state).toBe('done');
  });
});

describe.each(backings)('M10-FR-01: a batch past its date moves to the expired state once — on $name', ({ harness }) => {
  it('moves only batches whose date has passed, once (by the worker or a person), lists them with what is left to bin, and survives a restart', async () => {
    const h = harness();
    const { T, call } = await shop(h);
    const receive = (id: string, batchId: string, expiry: string, qty: number) => call('POST', '/v1/inventory/movements', 'u-owner', { movementId: id, productId: 'CURD', locationId: SHELF, kind: 'received', quantityMinor: qty, uom: 'EA', occurredAt: '2026-10-01T00:00:00.000Z', enteredBy: 'u-owner', batchId, expiry, unitCostMinor: 3_000 }, id);
    expect((await receive('r-old', 'B-OLD', '2026-10-05', 12)).status).toBeLessThan(300);
    expect((await receive('r-new', 'B-NEW', '2099-01-01', 20)).status).toBeLessThan(300);
    const sweepAt = new Date().toISOString();
    // A cashier cannot run it; the store manager can — and it moves only the expired batch.
    expect((await call('POST', '/v1/inventory/expiry-sweep', 'u-cash', {})).status).toBe(403);
    const first = await call('POST', '/v1/inventory/expiry-sweep', 'u-qc', {}, 'sweep-1');
    expect(first.body).toMatchObject({ count: 1, moved: [{ productId: 'CURD', locationId: SHELF, batchId: 'B-OLD', expiry: '2026-10-05', onHandMinor: 12, movedBy: 'expiry-sweep' }] });
    // Again (a person, then the worker's daily pass): nothing new — one move per batch, ever.
    expect((await call('POST', '/v1/inventory/expiry-sweep', 'u-qc', {}, 'sweep-2')).body).toMatchObject({ count: 0 });
    expect(await lane2ExpirySweep({ store: h.store, now: () => sweepAt })(T, sweepAt)).toBe(0);
    const register = (await call('GET', '/v1/inventory/expired-batches', 'u-owner')).body as { batches: { batchId: string; remainingMinor: number; toBin: boolean }[]; toBinCount: number };
    expect(register).toMatchObject({ toBinCount: 1, batches: [{ batchId: 'B-OLD', remainingMinor: 12, toBin: true }] });
    // The quantities on the ledger are untouched (the curd is still on the shelf until somebody bins it).
    expect(await onHand(call, 'CURD', SHELF)).toBe(32);
    // Store 2's people see none of store 1's register.
    await h.provisionRole(T, 'u-mgr-2', 'store_manager', [S2]);
    expect(((await h.request({ method: 'GET', path: '/v1/inventory/expired-batches', userId: 'u-mgr-2', tenantId: T, branchId: S2 })).body as { batches: unknown[] }).batches).toEqual([]);
    // A restart rebuilds the register from the stored events, and the worker on a fresh process moves nothing new.
    const again = apiHarness({ store: h.store });
    expect(((await again.request({ method: 'GET', path: '/v1/inventory/expired-batches', userId: 'u-owner', tenantId: T })).body as { count: number }).count).toBe(1);
    expect(await lane2ExpirySweep({ store: h.store, now: () => sweepAt })(T, sweepAt)).toBe(0);
  });

  it('the worker\'s daily pass moves a batch whose date passed, once per shop day', async () => {
    const h = harness();
    const { T, call } = await shop(h);
    expect((await call('POST', '/v1/inventory/movements', 'u-owner', { movementId: 'r-1', productId: 'MILK', locationId: SHELF, kind: 'received', quantityMinor: 5, uom: 'EA', occurredAt: '2026-10-01T00:00:00.000Z', enteredBy: 'u-owner', batchId: 'M-1', expiry: '2026-10-21' }, 'r-1')).status).toBeLessThan(300);
    // On the 21st (shop day, IST) the milk is still good; on the 22nd it has expired.
    const sweep = lane2ExpirySweep({ store: h.store, now: () => '2026-10-21T10:00:00.000Z' });
    expect(await sweep(T, '2026-10-21T10:00:00.000Z')).toBe(0);
    // 19:00 UTC on the 21st is 00:30 on the 22nd in the shop — a new shop day: it moves, once.
    expect(await sweep(T, '2026-10-21T19:00:00.000Z')).toBe(1);
    expect(await sweep(T, '2026-10-21T19:05:00.000Z')).toBe(0);
    const reg = (await call('GET', '/v1/inventory/expired-batches', 'u-owner')).body as { batches: { batchId: string; shopDay: string }[] };
    expect(reg.batches).toEqual([expect.objectContaining({ batchId: 'M-1', shopDay: '2026-10-22' })]);
  });
});
