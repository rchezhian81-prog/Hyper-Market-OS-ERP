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
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM, streamName } from '../../services/api/src/adapters';

/**
 * **Round 15 (verifier GAP A · OB-80 · GAP C · the placement race) — on the real API, in memory and (with DATABASE_URL) on
 * real PostgreSQL.**
 *
 *   • GAP A: a record head office CREATED — a pick wave, a delivery route, a daily task, a count's approval — is judged on the
 *     store head office itself holds it at, never on whichever store computer relays it first. The verifier's probes Q1/Q2:
 *     store-1's box acting on store-2's wave or route is refused (403, `record.waveId` / `record.routeId`), the refusal is
 *     kept and re-sent is refused again; store-2's own box is accepted and its replay is the same answer. Q3: a store-1
 *     person relaying on a store-1 head-office wave is accepted. A head-office record whose store head office cannot tell
 *     (a task, an invoice with no store) is refused by name (`record_store_unresolved`), never placed by the first relayer.
 *   • The placement race: a record that starts at a store (a till action) is CLAIMED before the handler, one key per record
 *     — two stores relaying the same new id at the same moment: exactly one is accepted, the other refused by name.
 *   • OB-80 (owner, 12 Oct 2026, "Keep cash per store + till"): two stores' "lane-1" floats are both accepted and kept apart;
 *     each store's cash office (till read, branch readiness, over/short list) sees only its own; a store-1 manager cannot
 *     read store-2's till; a till kept by its id alone before OB-80 in a single-store business keeps reading the same and a
 *     re-send of an old movement is not counted twice.
 *   • GAP C: a store id with spaces around it is refused 400 (`store_field_not_readable`) for a person and a box — in the
 *     body, the path or the query — and no phantom place " store-1 " is ever booked.
 */

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

const DAY = '2026-10-07';
const S1 = 'store-1'; const S2 = 'store-2';
type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } } | null)?.error?.code;
const whatOf = (r: Res): string => (r.body as { error?: { whatHappened?: string } } | null)?.error?.whatHappened ?? '';
const LINES = [1, 2, 3].map((n) => ({ lineId: `h${n}`, orderRef: 'ORD-1', productId: 'p-rice', description: 'Rice 5kg', bin: 'A-01', requiredQty: 1, uom: 'ea', unitPriceMinor: 100_00 }));
const waveLine = (waveId: string, lineId: string) => ({
  waveId, lineId, orderRef: 'ORD-1', productId: 'p-rice', state: 'picked', pickedQty: 1, uom: 'ea',
  finalPriceMinor: 100_00, currency: 'INR', substituted: false, note: null, pickedBy: 'u-picker', description: 'Rice 5kg', requiredQty: 1,
});
const stop = (routeId: string, stopId: string, orderRef: string) => ({ routeId, stopId, driverId: 'u-driver', orderRef, state: 'attempted', codExpectedMinor: 0, occurredAt: `${DAY}T09:00:00.000Z` });
const mv = (id: string, kind: string, amountMinor: number, custodianId = 'u-cash') => ({ movementId: id, tillId: 'lane-1', kind, amountMinor, custodianId, tradingDay: DAY, at: `${DAY}T04:00:00.000Z` });
const voidAct = (id: string) => ({ activityId: id, kind: 'void', laneId: 'lane-1', cashierId: 'u-cash', reason: 'scanned twice', at: `${DAY}T06:00:00.000Z`, valueMinor: 5_000, billRef: 'B-1', lineId: 'l1', productId: 'P3', description: 'Biscuits' });
const sale = (id: string, over: Record<string, unknown> = {}) => ({
  saleId: id, receiptNumber: `R-${id}`, laneId: 'lane-1', cashierId: 'u-cash', tradingDay: DAY, committedAt: `${DAY}T06:00:00.000Z`,
  totalMinor: 5_000, currency: 'INR', packVersion: 1, lines: [{ productId: 'P3', quantityMinor: 1, uom: 'each', unitPriceMinor: 5_000, lineTotalMinor: 5_000, taxRateBps: 0 }],
  tenders: [{ kind: 'cash', amountMinor: 5_000 }], ...over,
});

async function twoStores(h: ApiHarness) {
  const T = randomUUID();
  await h.seedOwner(T, 'u-owner');
  await h.enableFeature(T, 'delivery');
  await h.provisionRole(T, 'u-box-a', 'store_computer', [S1]);
  await h.provisionRole(T, 'u-box-b', 'store_computer', [S2]);
  await h.provisionRole(T, 'u-cash1', 'cashier', [S1]);
  await h.provisionRole(T, 'u-mgr1', 'store_manager', [S1]);
  await h.provisionRole(T, 'u-cash', 'cashier');
  await h.provisionRole(T, 'u-picker', 'store_manager');
  await h.provisionRole(T, 'u-driver', 'store_manager');
  await h.provisionRole(T, 'u-boss', 'store_manager');
  for (const [id, body] of [['C1', { kind: 'company', name: 'C' }], [S1, { kind: 'branch', name: S1, parentId: 'C1', companyId: 'C1' }], [S2, { kind: 'branch', name: S2, parentId: 'C1', companyId: 'C1' }]] as const) {
    expect((await h.request({ method: 'POST', path: `/v1/org/nodes/${id}`, userId: 'u-owner', tenantId: T, idempotencyKey: `n-${id}`, body })).status).toBeLessThan(300);
  }
  const BRANCH: Record<string, string> = { 'u-box-a': S1, 'u-box-b': S2, 'u-cash1': S1, 'u-mgr1': S1 };
  const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, key?: string, query?: Record<string, string>): Promise<Res> =>
    h.request({ method, path, userId, tenantId: T, ...(BRANCH[userId] === undefined ? {} : { branchId: BRANCH[userId] }), ...(method === 'GET' ? {} : { idempotencyKey: key ?? `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
  const refusals = async () => ((await call('GET', '/v1/store-computers/refusals', 'u-owner')).body as { refusals: { userId: string; reason: string; field?: string; namedStore?: string; path: string }[] }).refusals;
  return { T, call, refusals };
}

describe.each(backings)('Round 15 — head office places its own records; each till is kept per store — on $name', ({ harness }) => {
  it('GAP A (Q1/Q2/Q3): a head-office wave or route is judged on the store head office assigned it at — never the first relayer', async () => {
    const { call, refusals } = await twoStores(harness());
    expect((await call('POST', '/v1/fulfilment/waves/W-S2/assignment', 'u-owner', { storeId: S2, pickerId: 'u-picker', lines: LINES })).status).toBe(201);

    // Q1: store-1's box names store-2's wave FIRST — refused by name; re-sent, refused again; nothing reaches the wave.
    const squat = await call('POST', '/v1/fulfilment/waves/W-S2/lines/h1/synced', 'u-box-a', waveLine('W-S2', 'h1'), 'w-a1');
    expect(squat.status, JSON.stringify(squat.body)).toBe(403);
    expect(codeOf(squat)).toBe('store_computer_record_names_another_store');
    expect(whatOf(squat)).toContain('record.waveId');
    expect((await call('POST', '/v1/fulfilment/waves/W-S2/lines/h1/synced', 'u-box-a', waveLine('W-S2', 'h1'), 'w-a1')).status).toBe(403);
    // Store-2's own box: accepted (no first placement stood in its way); its replay is the same answer.
    const own = await call('POST', '/v1/fulfilment/waves/W-S2/lines/h2/synced', 'u-box-b', waveLine('W-S2', 'h2'), 'w-b2');
    expect(own.status, JSON.stringify(own.body)).toBe(202);
    expect((await call('POST', '/v1/fulfilment/waves/W-S2/lines/h2/synced', 'u-box-b', waveLine('W-S2', 'h2'), 'w-b2')).body).toEqual(own.body);
    const wave = JSON.stringify((await call('GET', '/v1/fulfilment/waves/W-S2', 'u-owner')).body);
    expect(wave).toContain('u-box-b');
    expect(wave).not.toContain('u-box-a');
    // A store-1 PERSON on store-2's wave: refused against their branch scope.
    const person = await call('POST', '/v1/fulfilment/waves/W-S2/lines/h3/synced', 'u-cash1', waveLine('W-S2', 'h3'));
    expect(codeOf(person)).toBe('outside_your_branch_scope');

    // Q2: the same for a delivery route head office assigned at store-2.
    expect((await call('POST', '/v1/delivery/routes/R-S2/assignment', 'u-owner', { storeId: S2, driverId: 'u-driver', stops: [{ stopId: 's1', orderRef: 'ORD-9', area: 'X', codMinor: 0 }, { stopId: 's2', orderRef: 'ORD-8', area: 'X', codMinor: 0 }] })).status).toBe(201);
    const routeSquat = await call('POST', '/v1/delivery/routes/R-S2/stops/s1/synced', 'u-box-a', stop('R-S2', 's1', 'ORD-9'));
    expect(routeSquat.status, JSON.stringify(routeSquat.body)).toBe(403);
    expect(codeOf(routeSquat)).toBe('store_computer_record_names_another_store');
    const routeOwn = await call('POST', '/v1/delivery/routes/R-S2/stops/s2/synced', 'u-box-b', stop('R-S2', 's2', 'ORD-8'));
    expect(routeOwn.status, JSON.stringify(routeOwn.body)).toBe(202);

    // Q3: a store-1 cashier relaying a pick on a store-1 head-office wave — accepted (it was refused as "names no store").
    expect((await call('POST', '/v1/fulfilment/waves/W-S1/assignment', 'u-owner', { storeId: S1, pickerId: 'u-picker', lines: LINES })).status).toBe(201);
    expect((await call('POST', '/v1/fulfilment/waves/W-S1/lines/h1/synced', 'u-cash1', waveLine('W-S1', 'h1'))).status).toBe(202);

    const kept = await refusals();
    expect(kept).toContainEqual(expect.objectContaining({ userId: 'u-box-a', reason: 'record_names_another_store', field: 'record.waveId', namedStore: S2 }));
    expect(kept).toContainEqual(expect.objectContaining({ userId: 'u-box-a', reason: 'record_names_another_store', field: 'record.routeId', namedStore: S2 }));
    expect(kept).toContainEqual(expect.objectContaining({ userId: 'u-cash1', reason: 'outside_your_branch_scope', field: 'record.waveId', namedStore: S2 }));
  }, 90_000);

  it('GAP A: a task, an approval\'s subject and an invoice are judged on head office\'s own record; one naming no store is refused, never first-placed', async () => {
    const { call, refusals } = await twoStores(harness());
    // A daily task head office set at store-2.
    expect((await call('POST', '/v1/hr/workforce/tasks/T-2', 'u-owner', { description: 'Chiller check', forRole: 'cashier', dueAt: `${DAY}T06:00:00Z`, critical: true, branchId: S2 })).status).toBeLessThan(300);
    const taskSquat = await call('POST', '/v1/hr/workforce/tasks/T-2/complete/synced', 'u-box-a', { doneBy: 'Meena' });
    expect(codeOf(taskSquat)).toBe('store_computer_record_names_another_store');
    expect((await call('POST', '/v1/hr/workforce/tasks/T-2/complete/synced', 'u-box-b', { doneBy: 'Meena' })).status).toBeLessThan(300);
    // A task head office set for no store: its store cannot be told — refused by name for a store's computer, not placed.
    expect((await call('POST', '/v1/hr/workforce/tasks/T-any', 'u-owner', { description: 'Read the notice', forRole: 'cashier', dueAt: `${DAY}T06:00:00Z`, critical: false })).status).toBeLessThan(300);
    const unresolved = await call('POST', '/v1/hr/workforce/tasks/T-any/complete/synced', 'u-box-a', { doneBy: 'Meena' });
    expect(unresolved.status).toBe(403);
    expect(codeOf(unresolved)).toBe('store_computer_record_store_unresolved');
    expect(codeOf(await call('POST', '/v1/hr/workforce/tasks/T-any/complete/synced', 'u-box-b', { doneBy: 'Meena' }))).toBe('store_computer_record_store_unresolved');

    // A blind count store-2's box relayed, held for approval; a decision on it relayed by STORE-1's box is judged on the
    // count's store (record.subjectRef) — refused; store-2's own box's decision is accepted.
    const count = { countId: 'CT-2', productId: 'P3', locationId: S2, uom: 'each', countedMinor: 1, reasonCode: 'cycle', counterId: 'u-cash', at: `${DAY}T05:00:00.000Z` };
    expect((await call('POST', '/v1/inventory/counts/CT-2/synced', 'u-box-b', count)).status).toBeLessThan(300);
    const decision = (by: string) => ({ id: 'stock_count:CT-2', subjectType: 'stock_count', subjectRef: 'CT-2', requestedBy: 'u-cash', branchId: null, value: null, status: 'approved', decidedBy: by, reason: 'recounted', decidedAt: `${DAY}T07:00:00.000Z`, storeId: null, source: 'manager-screen' });
    const crossDecision = await call('POST', '/v1/approvals/decisions/stock_count:CT-2/synced', 'u-box-a', decision('u-boss'));
    expect(crossDecision.status, JSON.stringify(crossDecision.body)).toBe(403);
    expect(codeOf(crossDecision)).toBe('store_computer_record_names_another_store');
    expect(whatOf(crossDecision)).toContain('record.subjectRef');
    expect((await call('POST', '/v1/approvals/decisions/stock_count:CT-2/synced', 'u-box-b', decision('u-boss'))).status).toBe(202);

    // An invoice head office captured with no store: a store computer relaying the same invoice id is refused, not placed.
    const captured = await call('POST', '/v1/purchase/invoices/INV-9/capture', 'u-owner', { supplierId: 'SUP-1', declaredTotalMinor: 1_000, lines: [{ productId: 'P3', quantity: 1, unitPriceMinor: 1_000, lineTotalMinor: 1_000 }] });
    expect(captured.status, JSON.stringify(captured.body)).toBeLessThan(300);
    const inv = await call('POST', '/v1/purchase/invoices/INV-9/synced', 'u-box-a', { invoiceId: 'INV-9', supplierId: 'SUP-1', declaredTotalMinor: 1_000, lines: [{ productId: 'P3', quantity: 1, unitPriceMinor: 1_000, lineTotalMinor: 1_000 }], capturedBy: 'u-mgr1', capturedAt: `${DAY}T08:00:00.000Z` });
    expect(codeOf(inv), JSON.stringify(inv.body)).toBe('store_computer_record_store_unresolved');
    expect(await refusals()).toContainEqual(expect.objectContaining({ userId: 'u-box-a', reason: 'record_store_unresolved', field: 'record.taskId' }));
  }, 90_000);

  it('the placement race: two stores relaying the same NEW record id at the same moment — exactly one stands, the other is refused by name', async () => {
    const { call } = await twoStores(harness());
    const [a, b] = await Promise.all([
      call('POST', '/v1/loss-prevention/activity/V-RACE/synced', 'u-box-a', voidAct('V-RACE'), 'race-a'),
      call('POST', '/v1/loss-prevention/activity/V-RACE/synced', 'u-box-b', voidAct('V-RACE'), 'race-b'),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses[0], JSON.stringify([a.body, b.body])).toBeLessThan(300);
    expect(statuses[1]).toBe(403);
    const loser = a.status === 403 ? a : b;
    const winner = a.status === 403 ? 'u-box-b' : 'u-box-a';
    const loserBox = winner === 'u-box-a' ? 'u-box-b' : 'u-box-a';
    expect(codeOf(loser)).toBe('store_computer_record_names_another_store');
    // The loser re-sending is refused again; the winner's own re-send is its own record.
    expect((await call('POST', '/v1/loss-prevention/activity/V-RACE/synced', loserBox, voidAct('V-RACE'))).status).toBe(403);
    expect((await call('POST', '/v1/loss-prevention/activity/V-RACE/synced', winner, voidAct('V-RACE'))).status).toBeLessThan(300);
  }, 90_000);

  it('OB-80 (Q6): both stores\' "lane-1" floats are accepted and kept apart; each store\'s cash office sees its own only', async () => {
    const { call } = await twoStores(harness());
    const a = await call('POST', '/v1/tills/lane-1/cash-movements/synced', 'u-box-a', mv('cm-a1', 'float_issue', 200_000), 'f-a');
    expect(a.status, JSON.stringify(a.body)).toBe(202);
    expect(a.body).toMatchObject({ storeId: S1 });
    const b = await call('POST', '/v1/tills/lane-1/cash-movements/synced', 'u-box-b', mv('cm-b1', 'float_issue', 300_000, 'u-boss'), 'f-b');
    expect(b.status, JSON.stringify(b.body)).toBe(202);
    expect(b.body).toMatchObject({ storeId: S2 });
    // The same movement id at the OTHER store is that store's own record, never a "duplicate" of store-1's.
    expect((await call('POST', '/v1/tills/lane-1/cash-movements/synced', 'u-box-b', mv('cm-a1', 'pickup', 50_000, 'u-boss'), 'p-b')).status).toBe(202);
    // Replays: the same answer; a re-send under a new key is recorded once.
    expect((await call('POST', '/v1/tills/lane-1/cash-movements/synced', 'u-box-a', mv('cm-a1', 'float_issue', 200_000), 'f-a')).body).toEqual(a.body);
    expect((await call('POST', '/v1/tills/lane-1/cash-movements/synced', 'u-box-a', mv('cm-a1', 'float_issue', 200_000))).body).toMatchObject({ alreadyRecorded: true });

    const till = async (storeId: string) => (await call('GET', '/v1/tills/lane-1/cash', 'u-owner', undefined, undefined, { storeId })).body as { storeId: string; custodian: string | null; balanceMinor: number };
    expect(await till(S1)).toMatchObject({ storeId: S1, custodian: 'u-cash', balanceMinor: 200_000 });
    expect(await till(S2)).toMatchObject({ storeId: S2, custodian: 'u-boss', balanceMinor: 250_000 });
    // Store-1's manager reads store-1's lane-1 (their one store) and is refused store-2's.
    expect(((await call('GET', '/v1/tills/lane-1/cash', 'u-mgr1')).body as { storeId: string; balanceMinor: number })).toMatchObject({ storeId: S1, balanceMinor: 200_000 });
    expect(codeOf(await call('GET', '/v1/tills/lane-1/cash', 'u-mgr1', undefined, undefined, { storeId: S2 }))).toBe('outside_your_branch_scope');
    // With two stores and no store named, head office never guesses which lane-1 (it says so, by name).
    expect(codeOf(await call('GET', '/v1/tills/lane-1/cash', 'u-owner'))).toBe('till_store_unknown');

    // The branch readiness (the cash office's measured figure) counts each store's own lane-1 only.
    const cashAt = async (branchId: string) => ((await call('GET', `/v1/platform/branches/${branchId}/readiness`, 'u-owner')).body as { readiness: { cashBalance: { minor: number } } }).readiness.cashBalance.minor;
    expect(await cashAt(S1)).toBe(200_000);
    expect(await cashAt(S2)).toBe(250_000);

    // Shift closes carry their store: the over/short list says whose till; a shift id another store already closed is
    // refused by name, never answered "already closed".
    const close = (shiftId: string) => ({
      shiftId, tillId: 'lane-1', laneId: 'lane-1', cashierId: 'u-cash', tradingDay: DAY, openedAt: `${DAY}T04:00:00.000Z`, closedAt: `${DAY}T20:00:00.000Z`,
      openingFloatMinor: 200_000, cashSalesMinor: 0, pickupsMinor: 0, cashRefundsMinor: 0, countedMinor: 150_000, expectedMinor: 200_000, varianceMinor: -50_000,
      exceptionRaised: true, reasonCode: 'counted_short', toleranceMinor: 10_000, toleranceKnown: true, currency: 'INR',
    });
    expect((await call('POST', '/v1/shifts/sh-a/close/synced', 'u-box-a', close('sh-a'))).status).toBe(202);
    expect((await call('POST', '/v1/shifts/sh-b/close/synced', 'u-box-b', close('sh-b'))).status).toBe(202);
    const clash = await call('POST', '/v1/shifts/sh-a/close/synced', 'u-box-b', close('sh-a'));
    expect(codeOf(clash)).toBe('store_computer_record_names_another_store');
    const rows = ((await call('GET', '/v1/shifts/over-short', 'u-owner')).body as { overShort: { shiftId: string; storeId: string | null }[] }).overShort;
    expect(rows.find((r) => r.shiftId === 'sh-a')?.storeId).toBe(S1);
    expect(rows.find((r) => r.shiftId === 'sh-b')?.storeId).toBe(S2);
    const exceptionsAt = async (branchId: string) => ((await call('GET', `/v1/platform/branches/${branchId}/readiness`, 'u-owner')).body as { readiness: { unresolvedExceptions: number } }).readiness.unresolvedExceptions;
    expect(await exceptionsAt(S1)).toBe(1);
    expect(await exceptionsAt(S2)).toBe(1);
  }, 90_000);

  it('OB-80 migration: a till kept by its id alone before OB-80 (one store) keeps reading the same, and an old movement re-sent is not counted twice', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-box-a', 'store_computer', [S1]);
    await h.provisionRole(T, 'u-cash', 'cashier');
    // A float head office took before OB-80: on the till-alone stream, with no store — written as the old code wrote it.
    const old = { movementId: 'cm-old', tillId: 'lane-1', kind: 'float_issue', deltaMinor: 100_000, currency: 'INR', custodianId: 'u-cash', tradingDay: DAY, at: `${DAY}T03:00:00.000Z`, relayed: true };
    await h.store.append(T, streamName(STREAM.cash, 'lane-1'), makeEvent({ id: 'cash-cm-old', type: 'CashMovement', occurredAt: old.at, idempotencyKey: `cash-${T}-cm-old`, source: 'api/pos', payload: old }));
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, query?: Record<string, string>): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(userId === 'u-box-a' ? { branchId: S1 } : {}), ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
    // The single store's lane-1 reads the old float (the one store head office knows), with no store named.
    expect(((await call('GET', '/v1/tills/lane-1/cash', 'u-owner')).body as { storeId: string; custodian: string; balanceMinor: number })).toMatchObject({ storeId: S1, custodian: 'u-cash', balanceMinor: 100_000 });
    // The old movement re-sent by the box after OB-80: already recorded — the drawer is not raised twice.
    const again = await call('POST', '/v1/tills/lane-1/cash-movements/synced', 'u-box-a', { ...mv('cm-old', 'float_issue', 100_000), at: old.at });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body).toMatchObject({ alreadyRecorded: true, storeId: S1 });
    // The chain carries on: a pickup by the same custodian is judged against the old float.
    expect((await call('POST', '/v1/tills/lane-1/cash-movements/synced', 'u-box-a', mv('cm-new', 'pickup', 40_000))).body).toMatchObject({ flags: expect.not.arrayContaining(['chain_till_not_held_by_this_custodian', 'chain_insufficient_till_cash']) });
    expect(((await call('GET', '/v1/tills/lane-1/cash', 'u-owner')).body as { balanceMinor: number }).balanceMinor).toBe(60_000);
    // History untouched: the old record is still on its own stream, as written.
    expect((await h.store.readStream(T, streamName(STREAM.cash, 'lane-1'))).map((e) => e.event.id)).toEqual(['cash-cm-old']);
  }, 90_000);

  it('GAP C (Q4/Q4b): a store id with spaces around it is refused 400 for a person and a box — body, path or query — and no phantom place is booked', async () => {
    const { call, refusals } = await twoStores(harness());
    const person = await call('POST', '/v1/sales', 'u-cash1', sale('S-sp1', { locationId: ' store-1 ' }));
    expect(person.status, JSON.stringify(person.body)).toBe(400);
    expect(codeOf(person)).toBe('store_field_not_readable');
    const box = await call('POST', '/v1/sales', 'u-box-a', sale('S-sp2', { locationId: ' store-1 ' }));
    expect(box.status).toBe(400);
    expect(codeOf(box)).toBe('store_field_not_readable');
    expect(codeOf(await call('POST', '/v1/sales', 'u-box-a', sale('S-sp3', { locationId: 'store-1\t' })))).toBe('store_field_not_readable');
    expect(codeOf(await call('POST', '/v1/sales', 'u-box-a', sale('S-sp4', { locationId: '   ' })))).toBe('store_field_not_readable');
    // In the query of a box's read: the same refusal (never trimmed into a store).
    expect(codeOf(await call('GET', '/v1/fulfilment/assignments', 'u-box-a', undefined, undefined, { storeId: ' store-1 ' }))).toBe('store_field_not_readable');
    // Nothing was banked and no place " store-1 " exists; the canonical sale books store-1's own stock.
    expect((await call('GET', '/v1/sales/S-sp1', 'u-owner')).status).toBe(404);
    expect((await call('GET', '/v1/sales/S-sp2', 'u-owner')).status).toBe(404);
    expect((await call('POST', '/v1/sales', 'u-cash1', sale('S-ok', { locationId: S1 }))).status).toBe(202);
    const rows = ((await call('GET', '/v1/inventory/availability', 'u-owner', undefined, undefined, { productId: 'P3' })).body as { rows: { locationId: string; onHandMinor: number }[] }).rows;
    expect(rows.map((r) => r.locationId)).toEqual([S1]);
    expect(rows[0]!.onHandMinor).toBe(-1);
    const mgr = ((await call('GET', '/v1/inventory/availability', 'u-mgr1', undefined, undefined, { productId: 'P3' })).body as { rows: { locationId: string; onHandMinor: number }[] }).rows;
    expect(mgr).toEqual([expect.objectContaining({ locationId: S1, onHandMinor: -1 })]);
    expect(await refusals()).toContainEqual(expect.objectContaining({ userId: 'u-cash1', reason: 'store_field_not_readable', field: 'body.locationId' }));
    expect(await refusals()).toContainEqual(expect.objectContaining({ userId: 'u-box-a', reason: 'store_field_not_readable', field: 'query.storeId' }));
  }, 90_000);
});
