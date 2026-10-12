import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, TEST_PACK_KEY, type ApiHarness } from '../support/api-harness';
import { approvedSuppliers } from '../support/approved-supplier';
import { storeSealer } from '../support/store-seal';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM, streamName } from '../../services/api/src/adapters';

/**
 * **Round 16 — the verifier's r16 findings, on the real API, in memory and (with DATABASE_URL) on real PostgreSQL.**
 *
 *   • OB80-1 · OB-82 "A" ("Fix it once, for good"): a till's cash kept before OB-80 by the till's id alone belongs to ONE
 *     store, recorded once as an append-only placement — automatically the first time head office reads or writes it while
 *     it knows exactly one store, else by a named head-office person. The verifier's probe: a ₹1,000 float reads ₹1,000 at
 *     store-1 after store-2 is created (never ₹0), its re-send is `alreadyRecorded` (never written again), registering lane-1
 *     at store-1 never doubles it (never ₹2,000), registering lane-1 at store-2 never moves it. Old shift closes follow the
 *     same placement. The old stream is never rewritten (hard rule #2).
 *   • OB80-2 · OB-83 "A" ("Own store's manager only"): the over/short list and its sign-off are limited to the person's own
 *     server-derived branches; the owner sees all. Store-1's manager signing off store-2's shortage → 403, nothing saved.
 *   • A-1 · OB-84 "A" ("Head office's record decides"): a goods-receipt id `grn-<po>-<n>` is placed by head office's order; an
 *     approval by head office's record of its subject. A store computer that took such an id first never locks the rightful
 *     store out: the rightful store's relays are accepted, the earlier claim is refused from then on and listed for head
 *     office (`overruledClaims`), nothing lost or merged; the store pack never hands out an id another store took.
 *   • C-1: every write, head office's company-wide writes included, refuses a store / location id that is not canonical
 *     (spaces around it, an invisible or control character) with 400 `store_field_not_readable` — one shared edge.
 *   • LOW: a till is (store, till) in the device register too — both stores' "lane-1" are registered side by side; a
 *     store-2 manager reads and works their own lane-1; an ambiguous status change is refused by name, never applied to both.
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
const mv = (id: string, kind: string, amountMinor: number, custodianId = 'u-cash') => ({ movementId: id, tillId: 'lane-1', kind, amountMinor, custodianId, tradingDay: DAY, at: `${DAY}T04:00:00.000Z` });
const BRANCH: Record<string, string> = { 'u-box-a': S1, 'u-box-b': S2, 'u-mgr1': S1, 'u-mgr2': S2 };
const OLD_FLOAT = { movementId: 'cm-old', tillId: 'lane-1', kind: 'float_issue', deltaMinor: 100_000, currency: 'INR', custodianId: 'u-cash', tradingDay: DAY, at: `${DAY}T03:00:00.000Z`, relayed: true };
const close = (shiftId: string, varianceMinor = -50_000) => ({
  shiftId, tillId: 'lane-1', laneId: 'lane-1', cashierId: 'u-cash', tradingDay: DAY, openedAt: `${DAY}T04:00:00.000Z`, closedAt: `${DAY}T20:00:00.000Z`,
  openingFloatMinor: 200_000, cashSalesMinor: 0, pickupsMinor: 0, cashRefundsMinor: 0, countedMinor: 200_000 + varianceMinor, expectedMinor: 200_000, varianceMinor,
  exceptionRaised: true, reasonCode: 'counted_short', toleranceMinor: 10_000, toleranceKnown: true, currency: 'INR',
});

async function business(h: ApiHarness, stores: readonly string[]) {
  const T = randomUUID();
  await h.seedOwner(T, 'u-owner');
  await h.provisionRole(T, 'u-box-a', 'store_computer', [S1]);
  await h.provisionRole(T, 'u-mgr1', 'store_manager', [S1]);
  await h.provisionRole(T, 'u-cash', 'cashier');
  const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, query?: Record<string, string>, key?: string): Promise<Res> =>
    h.request({ method, path, userId, tenantId: T, ...(BRANCH[userId] === undefined ? {} : { branchId: BRANCH[userId] }), ...(method === 'GET' ? {} : { idempotencyKey: key ?? `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
  expect((await call('POST', '/v1/org/nodes/C1', 'u-owner', { kind: 'company', name: 'C' }, undefined, 'n-C1')).status).toBe(201);
  const addStore = async (id: string): Promise<void> => {
    expect((await call('POST', `/v1/org/nodes/${id}`, 'u-owner', { kind: 'branch', name: id, parentId: 'C1', companyId: 'C1' }, undefined, `n-${id}`)).status).toBe(201);
  };
  for (const s of stores) await addStore(s);
  const secondStore = async (): Promise<void> => {
    await addStore(S2);
    await h.provisionRole(T, 'u-box-b', 'store_computer', [S2]);
    await h.provisionRole(T, 'u-mgr2', 'store_manager', [S2]);
  };
  const till = async (store: string, as = 'u-owner') => (await call('GET', '/v1/tills/lane-1/cash', as, undefined, as === 'u-owner' ? { storeId: store } : undefined)).body as {
    storeId: string; custodian: string | null; balanceMinor: number; legacyPlacement?: { storeId: string; how: string; placedBy: string; countedHere: boolean }; unplacedLegacy?: { balanceMinor: number; movements: number };
  };
  const readinessCash = async (store: string): Promise<number> => ((await call('GET', `/v1/platform/branches/${store}/readiness`, 'u-owner')).body as { readiness: { cashBalance: { minor: number } } }).readiness.cashBalance.minor;
  const oldFloat = async (): Promise<void> => {
    // A float head office took before OB-80: on the till-alone stream, with no store — written exactly as the old code did.
    await h.store.append(T, streamName(STREAM.cash, 'lane-1'), makeEvent({ id: 'cash-cm-old', type: 'CashMovement', occurredAt: OLD_FLOAT.at, idempotencyKey: `cash-${T}-cm-old`, source: 'api/pos', payload: OLD_FLOAT }));
  };
  const placements = async () => (await h.store.readStream(T, streamName(STREAM.cash, 'legacy-till-placements', 'v1'))).map((e) => e.event.payload as { tillId: string; storeId: string; how: string; placedBy: string; storesKnown: string[] });
  const refusals = async () => (await call('GET', '/v1/store-computers/refusals', 'u-owner')).body as { refusals: { userId: string; reason: string; field?: string; namedStore?: string }[]; overruledClaims: { family: string; recordId: string; claimedStore: string; decidingStore: string; decidedBy: string }[] };
  return { T, call, secondStore, till, readinessCash, oldFloat, placements, refusals };
}

describe.each(backings)('Round 16 — old till cash placed once; over/short by own store; head office\'s record decides; canonical store ids — on $name', ({ harness }) => {
  it('OB80-1 · OB-82: a ₹1,000 float kept before OB-80 stays ₹1,000 at store-1 — never ₹0 when store-2 arrives, never ₹2,000 on re-send or registration, never moved to store-2', async () => {
    const h = harness();
    const b = await business(h, [S1]);
    await b.oldFloat();
    // One store: the first look places the old chain at store-1, once, recorded with the evidence (the one store known).
    expect(await b.till(S1)).toMatchObject({ storeId: S1, custodian: 'u-cash', balanceMinor: 100_000, legacyPlacement: { storeId: S1, how: 'single_store_rule', placedBy: 'system', countedHere: true } });
    expect(await b.placements()).toEqual([expect.objectContaining({ tillId: 'lane-1', storeId: S1, how: 'single_store_rule', storesKnown: [S1] })]);
    expect(await b.readinessCash(S1)).toBe(100_000);

    // The business opens store-2 (its branch, its computer, its manager): store-1's old float does not vanish.
    await b.secondStore();
    expect(await b.till(S1)).toMatchObject({ storeId: S1, custodian: 'u-cash', balanceMinor: 100_000 });
    expect(await b.till(S1, 'u-mgr1')).toMatchObject({ storeId: S1, balanceMinor: 100_000 });

    // Store-1's computer re-sends the old float (a lost reply): already recorded — never written a second time.
    const resend = await b.call('POST', '/v1/tills/lane-1/cash-movements/synced', 'u-box-a', { ...mv('cm-old', 'float_issue', 100_000), at: OLD_FLOAT.at });
    expect(resend.status, JSON.stringify(resend.body)).toBe(200);
    expect(resend.body).toMatchObject({ alreadyRecorded: true, storeId: S1 });
    expect(await h.store.readStream(b.T, streamName(STREAM.cash, 'at', S1, 'lane-1'))).toHaveLength(0);
    // The round-15 code DID write such a re-send a second time on store-1's own stream (the verifier's probe). Reads merge
    // the two histories de-duplicated by movement id, so that copy is counted once.
    await h.store.append(b.T, streamName(STREAM.cash, 'at', S1, 'lane-1'), makeEvent({ id: `cash-${S1}-lane-1-cm-old`, type: 'CashMovement', occurredAt: OLD_FLOAT.at, idempotencyKey: `cash-${b.T}-${S1}-lane-1-cm-old`, source: 'api/pos', payload: { ...OLD_FLOAT, storeId: S1 } }));
    expect((await b.till(S1)).balanceMinor).toBe(100_000);

    // Head office registers lane-1 at store-1 (the runbook step): still ₹1,000, never ₹2,000.
    expect((await b.call('POST', '/v1/platform/devices/lane-1/register', 'u-owner', { branchId: S1, kind: 'pos_lane', label: 'S1 lane 1' })).status).toBe(201);
    expect((await b.till(S1)).balanceMinor).toBe(100_000);
    // ...and later lane-1 at store-2: store-1's old float stays at store-1; store-2's lane-1 is its own, empty.
    expect((await b.call('POST', '/v1/platform/devices/lane-1/register', 'u-owner', { branchId: S2, kind: 'pos_lane', label: 'S2 lane 1' })).status).toBe(201);
    expect(await b.till(S1)).toMatchObject({ balanceMinor: 100_000, custodian: 'u-cash' });
    expect(await b.till(S2)).toMatchObject({ storeId: S2, balanceMinor: 0, custodian: null, legacyPlacement: { storeId: S1, countedHere: false } });
    expect(await b.readinessCash(S1)).toBe(100_000);
    expect(await b.readinessCash(S2)).toBe(0);

    // The placement stands for ever: a person cannot re-decide it (409), the same store is answered as already placed.
    const moveIt = await b.call('POST', '/v1/tills/lane-1/legacy-placement', 'u-owner', { storeId: S2, reason: 'try to move it' });
    expect(moveIt.status).toBe(409);
    expect(codeOf(moveIt)).toBe('legacy_till_already_placed');
    expect((await b.call('POST', '/v1/tills/lane-1/legacy-placement', 'u-owner', { storeId: S1, reason: 'confirm' })).body).toMatchObject({ alreadyPlaced: true, storeId: S1, how: 'single_store_rule' });
    expect(await b.placements()).toHaveLength(1);
    // Hard rule #2: the old record is exactly as written, on its own stream.
    expect((await h.store.readStream(b.T, streamName(STREAM.cash, 'lane-1'))).map((e) => e.event.id)).toEqual(['cash-cm-old']);
  }, 120_000);

  it('OB-82: two stores known before anyone looked — the old float is SHOWN unplaced (never silently ₹0), its re-send is not written, a named head-office person places it once', async () => {
    const h = harness();
    const b = await business(h, [S1]);
    await b.secondStore();
    await b.oldFloat();
    const before = await b.till(S1);
    expect(before).toMatchObject({ storeId: S1, balanceMinor: 0, unplacedLegacy: { balanceMinor: 100_000, movements: 1 } });
    expect(await b.placements()).toHaveLength(0); // never decided from "how many stores exist today"
    // The re-send of the very movement on the unplaced old chain: already recorded, NOT written at store-1.
    const resend = await b.call('POST', '/v1/tills/lane-1/cash-movements/synced', 'u-box-a', { ...mv('cm-old', 'float_issue', 100_000), at: OLD_FLOAT.at });
    expect(resend.status).toBe(200);
    expect(resend.body).toMatchObject({ alreadyRecorded: true, onUnplacedLegacyChain: true });
    expect(await h.store.readStream(b.T, streamName(STREAM.cash, 'at', S1, 'lane-1'))).toHaveLength(0);
    // A store manager cannot place history (company-wide only); an unknown store is refused; nothing recorded.
    expect(codeOf(await b.call('POST', '/v1/tills/lane-1/legacy-placement', 'u-mgr1', { storeId: S1, reason: 'mine' }))).toBe('shop_wide_record_needs_company_scope');
    expect(codeOf(await b.call('POST', '/v1/tills/lane-1/legacy-placement', 'u-owner', { storeId: 'store-9', reason: 'x' }))).toBe('store_not_known');
    expect(codeOf(await b.call('POST', '/v1/tills/lane-1/legacy-placement', 'u-owner', { storeId: S1 }))).toBe('not_readable_as_a_legacy_placement');
    expect(await b.placements()).toHaveLength(0);
    // The owner places it — a named person, a reason, the stores known kept as evidence; a replay is the same answer.
    const key = `place-${randomUUID()}`;
    const placed = await b.call('POST', '/v1/tills/lane-1/legacy-placement', 'u-owner', { storeId: S1, reason: 'lane-1 was store-1\'s only till before OB-80' }, undefined, key);
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    expect(placed.body).toMatchObject({ tillId: 'lane-1', storeId: S1, placedBy: 'u-owner', how: 'head_office', oldMovements: 1, balanceMinor: 100_000 });
    expect((await b.call('POST', '/v1/tills/lane-1/legacy-placement', 'u-owner', { storeId: S1, reason: 'lane-1 was store-1\'s only till before OB-80' }, undefined, key)).status).toBe(201);
    expect(await b.placements()).toEqual([expect.objectContaining({ storeId: S1, how: 'head_office', placedBy: 'u-owner', storesKnown: [S1, S2] })]);
    expect(await b.till(S1)).toMatchObject({ balanceMinor: 100_000, custodian: 'u-cash', legacyPlacement: { storeId: S1, how: 'head_office', placedBy: 'u-owner' } });
    // The audit trail names who placed it.
    const audit = JSON.stringify((await b.call('GET', '/v1/audit/trail', 'u-owner')).body);
    expect(audit).toContain('till.legacy.place');
    expect(audit.split('till.legacy.place').length - 1).toBe(1); // once — the replay wrote no second entry
    // Registering lane-1 at store-2 later never moves it.
    expect((await b.call('POST', '/v1/platform/devices/lane-1/register', 'u-owner', { branchId: S2, kind: 'pos_lane', label: 'S2 lane 1' })).status).toBe(201);
    expect((await b.till(S1)).balanceMinor).toBe(100_000);
    expect((await b.till(S2)).balanceMinor).toBe(0);
  }, 120_000);

  it('OB80-2 · OB-83: store-1\'s manager sees and signs off only store-1\'s over/short; store-2\'s shortage is refused by name; the owner sees all; an old close follows its till\'s placement', async () => {
    const h = harness();
    const b = await business(h, [S1]);
    // An over/short close kept before OB-80 (no store) on lane-1, placed with the till's old records at store-1.
    await h.store.append(b.T, streamName(STREAM.cash, 'shifts'), makeEvent({ id: 'shift-closed-sh-old', type: 'TillClosed', occurredAt: `${DAY}T21:00:00.000Z`, idempotencyKey: `shift-${b.T}-sh-old`, source: 'api/pos', payload: { ...close('sh-old', -20_000), closedAt: `${DAY}T21:00:00.000Z` } }));
    expect(((await b.call('GET', '/v1/shifts/over-short', 'u-owner')).body as { overShort: { shiftId: string; storeId: string | null }[] }).overShort).toEqual([expect.objectContaining({ shiftId: 'sh-old', storeId: S1, legacyPlaced: true })]);
    await b.secondStore();
    expect((await b.call('POST', '/v1/shifts/sh-b2/close/synced', 'u-box-b', close('sh-b2'))).status).toBe(202);
    expect((await b.call('POST', '/v1/shifts/sh-a1/close/synced', 'u-box-a', close('sh-a1', -30_000))).status).toBe(202);
    const list = async (as: string, query?: Record<string, string>) => (await b.call('GET', '/v1/shifts/over-short', as, undefined, query));
    const ids = (r: Res): string[] => (r.body as { overShort: { shiftId: string }[] }).overShort.map((x) => x.shiftId).sort();
    expect(ids(await list('u-mgr1'))).toEqual(['sh-a1', 'sh-old']);
    expect(ids(await list('u-mgr2'))).toEqual(['sh-b2']);
    expect(ids(await list('u-owner'))).toEqual(['sh-a1', 'sh-b2', 'sh-old']);
    expect(ids(await list('u-owner', { storeId: S2 }))).toEqual(['sh-b2']);
    expect(codeOf(await list('u-mgr1', { storeId: S2 }))).toBe('scope_not_held');
    expect(((await list('u-mgr1')).body as { totalVarianceMinor: number }).totalVarianceMinor).toBe(-50_000);
    // The verifier's B3: store-1's manager signing off store-2's shortage — 403, nothing recorded.
    const theirs = await b.call('POST', '/v1/shifts/sh-b2/over-short/review', 'u-mgr1', { disposition: 'counting_error', note: 'x' });
    expect(theirs.status).toBe(403);
    expect(codeOf(theirs)).toBe('outside_your_branch_scope');
    expect(((await list('u-owner')).body as { overShort: { shiftId: string; reviewed: boolean }[] }).overShort.find((r) => r.shiftId === 'sh-b2')!.reviewed).toBe(false);
    // Store-2's own manager signs it off; a replay is the same sign-off; store-1's manager signs off store-1's own (old) close.
    const key = `rv-${randomUUID()}`;
    expect((await b.call('POST', '/v1/shifts/sh-b2/over-short/review', 'u-mgr2', { disposition: 'counting_error', note: 'recount' }, undefined, key)).status).toBe(201);
    expect((await b.call('POST', '/v1/shifts/sh-b2/over-short/review', 'u-mgr2', { disposition: 'counting_error', note: 'recount' }, undefined, key)).status).toBe(201);
    expect((await b.call('POST', '/v1/shifts/sh-old/over-short/review', 'u-mgr1', { disposition: 'counting_error' })).status).toBe(201);
    expect(((await list('u-owner')).body as { openCount: number }).openCount).toBe(1);
  }, 120_000);

  it('A-1 · OB-84 (goods receipt): head office\'s order decides the store of grn-<po>-<n>; a store that took the id first never locks the rightful store out; the pack skips a taken id', async () => {
    const h = harness();
    const b = await business(h, [S1]);
    await b.secondStore();
    await approvedSuppliers(h, b.T, 'sup-1');
    await h.provisionRole(b.T, 'u-recv', 'store_manager');
    await h.provisionRole(b.T, 'u-buyer', 'owner');
    expect((await b.call('POST', `/v1/stores/${S2}/settings`, 'u-owner', { tradingDayCutoff: '02:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 5_000, cashVarianceToleranceMinor: 5_000, privacySlaDays: 30, warehouseId: S2 })).status).toBe(201);
    const order = async (poId: string, to: string): Promise<void> => {
      expect((await b.call('POST', `/v1/purchase/orders/${poId}`, 'u-buyer', { supplierId: 'sup-1', deliverToLocationId: to, lines: [{ productId: 'P3', orderedQty: 5, unitCost: { minor: 1_000, currency: 'INR' } }] })).status).toBe(201);
      expect((await b.call('POST', `/v1/purchase/orders/${poId}/approval`, 'u-owner', { reason: 'stock' })).status).toBe(200);
    };
    const grn = (grnId: string, wh: string, poId?: string) => ({ grnId, warehouseId: wh, receivedBy: 'u-recv', receivedAt: `${DAY}T07:00:00.000Z`, ...(poId === undefined ? {} : { poId }), lines: [{ productId: 'P3', quantityMinor: 1, uom: 'each', batchId: null }], source: 'manager-screen' });
    const issued = async (poId: string): Promise<string | undefined> => {
      const pack = (await b.call('GET', `/v1/store-packs/${S2}`, 'u-box-b')).body as { sections?: { warehouse?: { openDeliveries?: { poId: string; grnId: string }[] } } };
      return pack.sections?.warehouse?.openDeliveries?.find((d) => d.poId === poId)?.grnId;
    };

    // The verifier's A4, with the order head office issued to store-2 (the only way grn-PO-0002-1 is ever handed out).
    await order('PO-0002', S2);
    expect(await issued('PO-0002')).toBe('grn-PO-0002-1');
    const squat = await b.call('POST', '/v1/inventory/goods-receipt/grn-PO-0002-1/synced', 'u-box-a', grn('grn-PO-0002-1', S1));
    expect(squat.status).toBe(403);
    expect(codeOf(squat)).toBe('store_computer_record_names_another_store');
    expect((await b.refusals()).refusals).toContainEqual(expect.objectContaining({ userId: 'u-box-a', field: 'record.grnId', namedStore: S2 }));
    const key = `grn-${randomUUID()}`;
    const real = await b.call('POST', '/v1/inventory/goods-receipt/grn-PO-0002-1/synced', 'u-box-b', grn('grn-PO-0002-1', S2, 'PO-0002'), undefined, key);
    expect(real.status, JSON.stringify(real.body)).toBe(202);
    expect((await b.call('POST', '/v1/inventory/goods-receipt/grn-PO-0002-1/synced', 'u-box-b', grn('grn-PO-0002-1', S2, 'PO-0002'))).body).toMatchObject({ alreadyReceived: true });

    // The id taken BEFORE head office's order existed: store-1's receipt is kept (nothing lost) …
    expect((await b.call('POST', '/v1/inventory/goods-receipt/grn-PO-0003-1/synced', 'u-box-a', grn('grn-PO-0003-1', S1))).status).toBe(202);
    await order('PO-0003', S2);
    // … head office's order now decides: the earlier claim is listed for head office, the pack hands store-2 a fresh id …
    expect((await b.refusals()).overruledClaims).toContainEqual(expect.objectContaining({ family: 'goods-receipt', recordId: 'grn-PO-0003-1', claimedStore: S1, decidingStore: S2, decidedBy: 'purchase order PO-0003' }));
    expect(await issued('PO-0003')).toBe('grn-PO-0003-2');
    expect((await b.call('POST', '/v1/inventory/goods-receipt/grn-PO-0003-2/synced', 'u-box-b', grn('grn-PO-0003-2', S2, 'PO-0003'))).status).toBe(202);
    // … store-1's computer can no longer act on the id, and store-2's stale use of it is never merged into store-1's receipt.
    expect(codeOf(await b.call('POST', '/v1/inventory/goods-receipt/grn-PO-0003-1/synced', 'u-box-a', grn('grn-PO-0003-1', S1)))).toBe('store_computer_record_names_another_store');
    const stale = await b.call('POST', '/v1/inventory/goods-receipt/grn-PO-0003-1/synced', 'u-box-b', grn('grn-PO-0003-1', S2, 'PO-0003'));
    expect(stale.status).toBe(409);
    expect(codeOf(stale)).toBe('receipt_id_held_by_another_store');
    const held = (await b.call('GET', '/v1/inventory/goods-receipt/grn-PO-0003-1', 'u-owner')).body as { grn?: { warehouseId: string }; warehouseId?: string };
    expect(held.grn?.warehouseId ?? held.warehouseId).toBe(S1);
  }, 120_000);

  it('A-1 · OB-84 (approval): a decision on a count relayed by another store before the count existed never locks out the count\'s own store; both are kept, the foreign one listed', async () => {
    const h = harness();
    const b = await business(h, [S1]);
    await b.secondStore();
    await h.provisionRole(b.T, 'u-boss', 'store_manager');
    const seal = storeSealer(TEST_PACK_KEY);
    const decision = (by: string, status: string) => seal.decision(b.T, 'ApprovalDecided', { id: 'stock_count:CT-F', subjectType: 'stock_count', subjectRef: 'CT-F', requestedBy: 'u-cash', branchId: null, value: null, status, decidedBy: by, reason: 'x', decidedAt: `${DAY}T07:00:00.000Z`, storeId: null, source: 'manager-screen' });
    // The verifier's probe: store-1's computer relays a REJECTION of a count that does not exist yet.
    const early = await b.call('POST', '/v1/approvals/decisions/stock_count:CT-F/synced', 'u-box-a', decision('u-boss', 'rejected'));
    expect(early.status).toBe(202);
    // Store-2 counts CT-F at store-2: held for approval.
    const count = { countId: 'CT-F', productId: 'P3', locationId: S2, uom: 'each', countedMinor: 1, reasonCode: 'cycle', counterId: 'u-cash', at: `${DAY}T05:00:00.000Z` };
    expect((await b.call('POST', '/v1/inventory/counts/CT-F/synced', 'u-box-b', count)).body).toMatchObject({ pendingApproval: true });
    // Head office's record of the count decides: store-2's manager's decision is accepted and applied.
    const key = `dec-${randomUUID()}`;
    const real = await b.call('POST', '/v1/approvals/decisions/stock_count:CT-F/synced', 'u-box-b', decision('u-mgr2', 'approved'), undefined, key);
    expect(real.status, JSON.stringify(real.body)).toBe(202);
    expect(real.body).toMatchObject({ status: 'approved', decidedBy: 'u-mgr2', applied: true });
    expect((await b.call('POST', '/v1/approvals/decisions/stock_count:CT-F/synced', 'u-box-b', decision('u-mgr2', 'approved'))).body).toMatchObject({ alreadyRecorded: true, status: 'approved' });
    // Store-1's computer can no longer act on it; its early rejection is kept and listed for head office — nothing lost.
    expect(codeOf(await b.call('POST', '/v1/approvals/decisions/stock_count:CT-F/synced', 'u-box-a', decision('u-boss', 'rejected')))).toBe('store_computer_record_names_another_store');
    const all = ((await b.call('GET', '/v1/approvals/decisions', 'u-owner')).body as { decisions: { requestId: string; status: string; relayedBy: string }[] }).decisions.filter((d) => d.requestId === 'stock_count:CT-F');
    expect(all.map((d) => [d.status, d.relayedBy]).sort()).toEqual([['approved', 'u-box-b'], ['rejected', 'u-box-a']]);
    expect((await b.refusals()).overruledClaims).toContainEqual(expect.objectContaining({ family: 'approval', recordId: 'stock_count:CT-F', claimedStore: S1, decidingStore: S2, decidedBy: 'stock_count CT-F' }));
  }, 120_000);

  it('C-1: head office\'s own writes refuse a store id that is not canonical — no phantom stock place, no padded lane, no stranded wave', async () => {
    const h = harness();
    const b = await business(h, [S1]);
    await h.enableFeature(b.T, 'delivery');
    for (const [kind, locationId] of [['received', ' store-1 '], ['transferred_in', 'store-1 '], ['received', 'store\t1'], ['received', 'store-1​']] as const) {
      const r = await b.call('POST', '/v1/inventory/movements', 'u-owner', { movementId: `mv-${randomUUID()}`, productId: 'P3', locationId, kind, quantityMinor: 5, uom: 'each', occurredAt: `${DAY}T05:00:00.000Z`, enteredBy: 'u-owner' });
      expect(r.status, `${kind} ${JSON.stringify(locationId)}`).toBe(400);
      expect(codeOf(r)).toBe('store_field_not_readable');
    }
    const lane = await b.call('POST', '/v1/platform/devices/lane-9/register', 'u-owner', { branchId: ' store-1 ', kind: 'pos_lane', label: 'x' });
    expect(codeOf(lane)).toBe('store_field_not_readable');
    const wave = await b.call('POST', '/v1/fulfilment/waves/W-P/assignment', 'u-owner', { storeId: ' store-1 ', pickerId: 'u-owner', lines: [{ lineId: 'h1', orderRef: 'O', productId: 'p', description: 'd', bin: 'A', requiredQty: 1, uom: 'ea', unitPriceMinor: 1 }] });
    expect(codeOf(wave)).toBe('store_field_not_readable');
    const node = await b.call('POST', '/v1/org/nodes/%20store-3', 'u-owner', { kind: 'branch', name: 's3', parentId: 'C1', companyId: 'C1' });
    expect(node.status).toBe(400);
    // Nothing reached the ledger, the register or the waves: no phantom " store-1 " anywhere.
    expect(((await b.call('GET', '/v1/inventory/availability', 'u-owner', undefined, { productId: 'P3' })).body as { rows: unknown[] }).rows).toEqual([]);
    expect(JSON.stringify((await b.call('GET', '/v1/platform/devices', 'u-owner')).body)).not.toContain('lane-9');
    // Each refusal is on head office's list, by the person who sent it; the canonical write goes through.
    expect((await b.refusals()).refusals.filter((r) => r.userId === 'u-owner' && r.reason === 'store_field_not_readable').length).toBeGreaterThanOrEqual(6);
    expect((await b.call('POST', '/v1/inventory/movements', 'u-owner', { movementId: 'mv-ok', productId: 'P3', locationId: S1, kind: 'received', quantityMinor: 5, uom: 'each', occurredAt: `${DAY}T05:00:00.000Z`, enteredBy: 'u-owner' })).status).toBe(202);
  }, 120_000);

  it('LOW: both stores\' "lane-1" are registered side by side; store-2\'s manager reads and works their own lane-1; an ambiguous status change is refused by name', async () => {
    const h = harness();
    const b = await business(h, [S1]);
    await b.secondStore();
    // lane-1 registered at store-1 only: store-2's manager still reads THEIR OWN lane-1 (their one store comes first).
    expect((await b.call('POST', '/v1/platform/devices/lane-1/register', 'u-owner', { branchId: S1, kind: 'pos_lane', label: `${S1} lane 1` })).status).toBe(201);
    expect((await b.call('GET', '/v1/tills/lane-1/cash', 'u-mgr2')).body).toMatchObject({ storeId: S2, balanceMinor: 0 });
    expect((await b.call('POST', '/v1/platform/devices/lane-1/register', 'u-owner', { branchId: S2, kind: 'pos_lane', label: `${S2} lane 1` })).status).toBe(201);
    const fleet = ((await b.call('GET', '/v1/platform/devices', 'u-owner')).body as { devices: { deviceId: string; branchId: string; status: string }[] }).devices.filter((d) => d.deviceId === 'lane-1');
    expect(fleet.map((d) => d.branchId).sort()).toEqual([S1, S2]);
    // Store-2's manager: their own lane-1, with no store named — read, and a float put on it.
    expect((await b.call('GET', '/v1/tills/lane-1/cash', 'u-mgr2')).body).toMatchObject({ storeId: S2, balanceMinor: 0 });
    const float = await b.call('POST', '/v1/tills/lane-1/cash-movements', 'u-mgr2', { movementId: 'f-2', kind: 'float_issue', amountMinor: 50_000, custodianId: 'u-cash', tradingDay: DAY });
    expect(float.status, JSON.stringify(float.body)).toBe(201);
    expect(float.body).toMatchObject({ storeId: S2, balanceMinor: 50_000 });
    expect((await b.call('GET', '/v1/tills/lane-1/cash', 'u-mgr1')).body).toMatchObject({ storeId: S1, balanceMinor: 0 });
    // The same movement id again is the same movement; a different one under it is refused by name.
    expect((await b.call('POST', '/v1/tills/lane-1/cash-movements', 'u-mgr2', { movementId: 'f-2', kind: 'float_issue', amountMinor: 50_000, custodianId: 'u-cash', tradingDay: DAY })).body).toMatchObject({ alreadyRecorded: true, balanceMinor: 50_000 });
    expect(codeOf(await b.call('POST', '/v1/tills/lane-1/cash-movements', 'u-mgr2', { movementId: 'f-2', kind: 'loan', amountMinor: 1_000, custodianId: 'u-cash', tradingDay: DAY }))).toBe('movement_id_already_used');
    // The owner (all stores) must say which lane-1: refused by name, nothing changed; named, only that one changes.
    expect(codeOf(await b.call('POST', '/v1/platform/devices/lane-1/status', 'u-owner', { status: 'blocked', reason: 'test' }))).toBe('device_at_more_than_one_store');
    expect((await b.call('POST', '/v1/platform/devices/lane-1/status', 'u-owner', { status: 'blocked', reason: 'test', branchId: S2 })).status).toBe(200);
    const after = ((await b.call('GET', '/v1/platform/devices', 'u-owner')).body as { devices: { deviceId: string; branchId: string; status: string }[] }).devices.filter((d) => d.deviceId === 'lane-1');
    expect(after.map((d) => [d.branchId, d.status]).sort()).toEqual([[S1, 'registered'], [S2, 'blocked']]);
    // With two stores' lane-1 the till's name alone places it nowhere for a company-wide reader: named, never guessed.
    expect(codeOf(await b.call('GET', '/v1/tills/lane-1/cash', 'u-owner'))).toBe('till_store_unknown');
  }, 120_000);
});
