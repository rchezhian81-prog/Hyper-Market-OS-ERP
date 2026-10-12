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
import { RELAY_RECORD_KEY } from '../../services/platform/src/store-computer-identity';

/**
 * **Round 14 (verifier G1 · G2 · G3 — PA-01 · OB-54 · hard rule #10): a relay is judged on the store of the RECORD it
 * names, as head office holds it — for a person against their branches, for a store computer against its own store.**
 *
 * The verifier's probes R1/R2: a store-1 manager — and store-1's own store computer — reopened store-2's locked day by
 * naming its day-close id (202); a store-1 cashier relayed a refund on store-2's sale, and a sale with no location whose
 * lane was CALLED "store-2" (it landed on store-2's stock); a location sent as a list was never read. Now, on the real API
 * (in memory, and with DATABASE_URL on real PostgreSQL):
 *
 *   • G1: every keyed relay route resolves its record's store (`RELAY_RECORD_KEY`): the reopen of store-2's day by a
 *     store-1 person or box is refused by name (field `record.dayCloseId`), re-sent under the same key it is refused
 *     again, and the day stays locked; store-2's own box reopens it, its replay is the same answer. A store-1 box naming
 *     store-2's close id for "its" close is refused, not silently answered "already closed". A record with no store field
 *     of its own (a pick wave) is judged against the store head office recorded it at when it first accepted it; a till
 *     against the store it is registered at.
 *   • G2: a sale naming no location is placed by the store its LANE is registered at (judged: a store-1 cashier on a
 *     store-2 lane is refused) and never by the free-text lane id (a lane called "store-2" that nothing places is refused
 *     for a store-scoped person, and held at an unplaced location for a company-wide one); a location sent as a list or a
 *     number is refused 400.
 *   • G3: a return relayed on store-2's sale is judged on the SALE's store — refused for a store-1 cashier and store-1's
 *     box, accepted for store-2's cashier; a held sale nothing places is refused as unresolved, never passed.
 *   • Every refusal — a person's as well as a box's — is kept on head office's refusal list (P-08), never lost.
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
const sale = (id: string, over: Record<string, unknown> = {}) => ({
  saleId: id, receiptNumber: `R-${id}`, laneId: 'lane-1', cashierId: 'u-cash', tradingDay: DAY, committedAt: `${DAY}T06:00:00.000Z`,
  totalMinor: 5_000, currency: 'INR', packVersion: 1, lines: [{ productId: 'P3', quantityMinor: 1, uom: 'each', unitPriceMinor: 5_000, lineTotalMinor: 5_000, taxRateBps: 0 }],
  tenders: [{ kind: 'cash', amountMinor: 5_000 }], ...over,
});
const ret = (id: string) => ({ returnId: id, processedBy: 'u-cash', reasonCode: 'damaged', refundMinor: 5_000, refundTender: 'cash', refundStatus: 'settled', lines: [{ productId: 'P3', quantityMinor: 1, uom: 'each' }] });
const waveLine = (lineId: string) => ({
  waveId: 'W-2', lineId, orderRef: 'ORD-1', productId: 'p-rice', state: 'picked', pickedQty: 2, uom: 'ea',
  finalPriceMinor: 200_00, currency: 'INR', substituted: false, note: null, pickedBy: 'u-picker', description: 'Rice 5kg', requiredQty: 2,
});
const movement = (id: string, tillId: string) => ({ movementId: id, tillId, kind: 'float_issue', amountMinor: 200_000, custodianId: 'u-cash', tradingDay: DAY, at: `${DAY}T04:00:00.000Z` });

async function shop(h: ApiHarness) {
  const T = randomUUID();
  await h.seedOwner(T, 'u-owner');
  await h.provisionRole(T, 'u-box-a', 'store_computer', [S1]);
  await h.provisionRole(T, 'u-box-b', 'store_computer', [S2]);
  await h.provisionRole(T, 'u-mgr1', 'store_manager', [S1]);
  await h.provisionRole(T, 'u-cash1', 'cashier', [S1]);
  await h.provisionRole(T, 'u-cash2', 'cashier', [S2]);
  for (const [id, body] of [['C1', { kind: 'company', name: 'C' }], [S1, { kind: 'branch', name: S1, parentId: 'C1', companyId: 'C1' }], [S2, { kind: 'branch', name: S2, parentId: 'C1', companyId: 'C1' }]] as const) {
    expect((await h.request({ method: 'POST', path: `/v1/org/nodes/${id}`, userId: 'u-owner', tenantId: T, idempotencyKey: `n-${id}`, body })).status).toBeLessThan(300);
  }
  const BRANCH: Record<string, string> = { 'u-box-a': S1, 'u-box-b': S2, 'u-mgr1': S1, 'u-cash1': S1, 'u-cash2': S2 };
  const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, key?: string, query?: Record<string, string>): Promise<Res> =>
    h.request({ method, path, userId, tenantId: T, ...(BRANCH[userId] === undefined ? {} : { branchId: BRANCH[userId] }), ...(method === 'GET' ? {} : { idempotencyKey: key ?? `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
  const refusals = async () => ((await call('GET', '/v1/store-computers/refusals', 'u-owner')).body as { refusals: { userId: string; reason: string; field?: string; namedStore?: string; path: string; by?: string }[] }).refusals;
  return { T, call, refusals };
}

describe('every keyed relay route has a record key', () => {
  it('the table names the day close reopen, the sale return, tills, waves, delivery routes and the rest', () => {
    for (const route of ['/v1/pos/day-close/:dayCloseId/reopen/synced', '/v1/sales/:saleId/returns/synced', '/v1/tills/:tillId/cash-movements/synced',
      '/v1/fulfilment/waves/:waveId/lines/:lineId/synced', '/v1/delivery/routes/:routeId/handover/synced', '/v1/floor/indents/:indentId/issues/:issueId/synced']) {
      expect(RELAY_RECORD_KEY[route], route).toBeDefined();
    }
  });
});

describe.each(backings)('Round 14 — a relay is judged on the store of the record it names — on $name', ({ harness }) => {
  it('G1: another store\'s locked day cannot be reopened by a store-1 person or store-1\'s computer; its own computer can', async () => {
    const h = harness();
    const { call, refusals } = await shop(h);
    expect((await call('POST', '/v1/pos/day-close/dc-2/synced', 'u-box-b', { storeId: S2, tradingDay: DAY, closedBy: 'u-m2', closedAt: `${DAY}T21:00:00Z` })).status).toBe(202);
    const reopen = { reopenedBy: 'u-mgr1', reason: 'recount', approvedBy: 'u-owner' };

    const byManager = await call('POST', '/v1/pos/day-close/dc-2/reopen/synced', 'u-mgr1', reopen, 'ro-m');
    expect(byManager.status, JSON.stringify(byManager.body)).toBe(403);
    expect(codeOf(byManager)).toBe('outside_your_branch_scope');
    expect(whatOf(byManager)).toContain(`"${S2}"`);
    expect(whatOf(byManager)).toContain('record.dayCloseId');
    expect((await call('POST', '/v1/pos/day-close/dc-2/reopen/synced', 'u-mgr1', reopen, 'ro-m')).status).toBe(403); // re-sent: judged again

    const byBox = await call('POST', '/v1/pos/day-close/dc-2/reopen/synced', 'u-box-a', reopen, 'ro-a');
    expect(byBox.status, JSON.stringify(byBox.body)).toBe(403);
    expect(codeOf(byBox)).toBe('store_computer_record_names_another_store');
    expect((await call('POST', '/v1/pos/day-close/dc-2/reopen/synced', 'u-box-a', reopen, 'ro-a')).status).toBe(403);

    // A store-1 box naming store-2's close id for "its own" close is refused — never silently answered "already closed".
    const squat = await call('POST', '/v1/pos/day-close/dc-2/synced', 'u-box-a', { storeId: S1, tradingDay: DAY, closedBy: 'u-m1', closedAt: `${DAY}T21:00:00Z` });
    expect(squat.status, JSON.stringify(squat.body)).toBe(403);
    expect(codeOf(squat)).toBe('store_computer_record_names_another_store');

    const days = ((await call('GET', '/v1/pos/day-close', 'u-owner')).body as { dayCloses: { dayCloseId: string; storeId: string; locked: boolean }[] }).dayCloses;
    expect(days.find((d) => d.dayCloseId === 'dc-2')).toMatchObject({ storeId: S2, locked: true });

    const kept = await refusals();
    expect(kept).toContainEqual(expect.objectContaining({ userId: 'u-mgr1', reason: 'outside_your_branch_scope', field: 'record.dayCloseId', namedStore: S2, by: 'person' }));
    expect(kept).toContainEqual(expect.objectContaining({ userId: 'u-box-a', reason: 'record_names_another_store', field: 'record.dayCloseId', namedStore: S2, by: 'store_computer' }));
    expect(kept.filter((r) => r.userId === 'u-mgr1' && r.path === '/v1/pos/day-close/:dayCloseId/reopen/synced')).toHaveLength(1); // the re-send collapses

    // Store-2's own computer reopens its own day; its replay is the same answer.
    const own = await call('POST', '/v1/pos/day-close/dc-2/reopen/synced', 'u-box-b', { reopenedBy: 'u-m2', reason: 'recount', approvedBy: 'u-owner' }, 'ro-b');
    expect(own.status, JSON.stringify(own.body)).toBe(202);
    expect((await call('POST', '/v1/pos/day-close/dc-2/reopen/synced', 'u-box-b', { reopenedBy: 'u-m2', reason: 'recount', approvedBy: 'u-owner' }, 'ro-b')).body).toEqual(own.body);
    const after = ((await call('GET', '/v1/pos/day-close', 'u-owner')).body as { dayCloses: { dayCloseId: string; locked: boolean; reopenedBy?: string }[] }).dayCloses;
    expect(after.find((d) => d.dayCloseId === 'dc-2')).toMatchObject({ locked: false, reopenedBy: 'u-m2' });
  }, 60_000);

  it('G1: a store-originated record head office does not hold (a box-made pick wave) is held at the store that first sent it; OB-80: a till is (store, till)', async () => {
    const h = harness();
    const { call, refusals } = await shop(h);
    expect((await call('POST', '/v1/fulfilment/waves/W-2/lines/l1/synced', 'u-box-b', waveLine('l1'), 'w-b1')).status).toBeLessThan(300);
    const cross = await call('POST', '/v1/fulfilment/waves/W-2/lines/l2/synced', 'u-box-a', waveLine('l2'), 'w-a2');
    expect(cross.status, JSON.stringify(cross.body)).toBe(403);
    expect(codeOf(cross)).toBe('store_computer_record_names_another_store');
    expect((await call('POST', '/v1/fulfilment/waves/W-2/lines/l2/synced', 'u-box-a', waveLine('l2'), 'w-a2')).status).toBe(403);
    expect((await call('POST', '/v1/fulfilment/waves/W-2/lines/l2/synced', 'u-box-b', waveLine('l2'), 'w-b2')).status).toBeLessThan(300);
    const wave = (await call('GET', '/v1/fulfilment/waves/W-2', 'u-owner')).body as { lines: { lineId: string; relayedBy?: string }[] };
    expect(JSON.stringify(wave)).not.toContain('u-box-a');

    // OB-80 (owner, 12 Oct 2026): a till is (store, till). Store-1's computer moving cash on a till it calls "till-s2" moves
    // STORE-1's till of that name — never store-2's registered till-s2, whose drawer stays untouched; store-2's own float
    // on its till-s2 is its own record (the same movement id included).
    expect((await call('POST', '/v1/platform/devices/till-s2/register', 'u-owner', { branchId: S2, kind: 'pos_lane', label: 'Lane 1' })).status).toBe(201);
    const cash = await call('POST', '/v1/tills/till-s2/cash-movements/synced', 'u-box-a', movement('cm-1', 'till-s2'), 'cm-a');
    expect(cash.status, JSON.stringify(cash.body)).toBe(202);
    expect(cash.body).toMatchObject({ storeId: S1 });
    expect(((await call('GET', '/v1/tills/till-s2/cash', 'u-owner')).body as { storeId: string; balanceMinor: number })).toMatchObject({ storeId: S2, balanceMinor: 0 });
    expect((await call('POST', '/v1/tills/till-s2/cash-movements/synced', 'u-box-b', movement('cm-1', 'till-s2'), 'cm-b')).status).toBe(202);
    expect(((await call('GET', '/v1/tills/till-s2/cash', 'u-owner', undefined, undefined, { storeId: S2 })).body as { balanceMinor: number }).balanceMinor).toBe(200_000);
    expect(((await call('GET', '/v1/tills/till-s2/cash', 'u-owner', undefined, undefined, { storeId: S1 })).body as { balanceMinor: number }).balanceMinor).toBe(200_000);

    expect(await refusals()).toContainEqual(expect.objectContaining({ userId: 'u-box-a', field: 'record.waveId', namedStore: S2 }));
  }, 60_000);

  it('G2: a sale naming no location is placed by its lane\'s REGISTERED store and judged; never by the free-text lane id; a list or number is refused 400', async () => {
    const h = harness();
    const { call, refusals } = await shop(h);
    // The probe: a store-1 cashier, no location, a lane CALLED "store-2" that nothing places — refused, nothing banked.
    const named = await call('POST', '/v1/sales', 'u-cash1', sale('S-L', { laneId: S2 }), 'sl');
    expect(named.status, JSON.stringify(named.body)).toBe(403);
    expect(codeOf(named)).toBe('relay_names_no_store');
    expect((await call('POST', '/v1/sales', 'u-cash1', sale('S-L', { laneId: S2 }), 'sl')).status).toBe(403);
    expect((await call('GET', '/v1/sales/S-L', 'u-owner')).status).toBe(404);

    // A lane registered at store-2: the store-1 cashier's sale on it is refused by name (record.laneId).
    expect((await call('POST', '/v1/platform/devices/lane-s2/register', 'u-owner', { branchId: S2, kind: 'pos_lane', label: 'Lane 1' })).status).toBe(201);
    expect((await call('POST', '/v1/platform/devices/lane-s1/register', 'u-owner', { branchId: S1, kind: 'pos_lane', label: 'Lane 1' })).status).toBe(201);
    const away = await call('POST', '/v1/sales', 'u-cash1', sale('S-away', { laneId: 'lane-s2' }));
    expect(away.status, JSON.stringify(away.body)).toBe(403);
    expect(codeOf(away)).toBe('outside_your_branch_scope');
    expect(whatOf(away)).toContain('record.laneId');
    // OB-80: store-1's computer relaying a sale from ITS lane called "lane-s2" sells from store-1 — a lane id names a till
    // within the box's own store, never another store's registered device; naming store-2 as the location is refused.
    const boxAway = await call('POST', '/v1/sales', 'u-box-a', sale('S-away2', { laneId: 'lane-s2', locationId: S2 }));
    expect(codeOf(boxAway)).toBe('store_computer_record_names_another_store');
    expect((await call('POST', '/v1/sales', 'u-box-a', sale('S-own-lane', { laneId: 'lane-s2' }))).status).toBe(202);

    // Its own registered lane: accepted, and the stock leaves store-1 (store_of_lane), not a guess.
    const home = await call('POST', '/v1/sales', 'u-cash1', sale('S-home', { laneId: 'lane-s1' }), 'sh');
    expect(home.status, JSON.stringify(home.body)).toBe(202);
    expect((await call('POST', '/v1/sales', 'u-cash1', sale('S-home', { laneId: 'lane-s1' }), 'sh')).body).toEqual(home.body);
    const av = ((await call('GET', '/v1/inventory/availability', 'u-owner', undefined, undefined, { productId: 'P3' })).body as { rows?: { locationId: string; onHandMinor: number }[] } | { locationId: string; onHandMinor: number }[]);
    const rows = Array.isArray(av) ? av : (av.rows ?? (av as unknown as { availability: { locationId: string; onHandMinor: number }[] }).availability ?? []);
    expect(rows.find((r) => r.locationId === S1)?.onHandMinor).toBe(-2); // the box's own-lane sale and this one — both store-1's
    expect(rows.find((r) => r.locationId === S2)).toBeUndefined();

    // A company-wide person (the owner) relaying a sale nothing places: banked, held at the lane's UNPLACED location.
    expect((await call('POST', '/v1/sales', 'u-owner', sale('S-own', { laneId: S2 }))).status).toBe(202);
    const av2 = (await call('GET', '/v1/inventory/availability', 'u-owner', undefined, undefined, { productId: 'P3' })).body;
    expect(JSON.stringify(av2)).toContain('unplaced-lane:store-2');
    expect(JSON.stringify(av2)).not.toMatch(/"locationId":"store-2"/);

    // Unreadable store fields: refused 400 for anybody — a person, a box, the owner.
    for (const [who, body] of [['u-cash1', sale('S-a', { locationId: [S2] })], ['u-box-a', sale('S-n', { locationId: 2 })], ['u-owner', sale('S-o', { locationId: { id: S2 } })]] as const) {
      const r = await call('POST', '/v1/sales', who, body);
      expect(r.status, `${who} ${JSON.stringify(r.body)}`).toBe(400);
      expect(codeOf(r)).toBe('store_field_not_readable');
    }
    expect((await call('GET', '/v1/sales/S-a', 'u-owner')).status).toBe(404);

    const kept = await refusals();
    expect(kept).toContainEqual(expect.objectContaining({ userId: 'u-cash1', reason: 'relay_names_no_store', by: 'person' }));
    expect(kept).toContainEqual(expect.objectContaining({ userId: 'u-cash1', reason: 'outside_your_branch_scope', field: 'record.laneId', namedStore: S2 }));
    expect(kept).toContainEqual(expect.objectContaining({ userId: 'u-cash1', reason: 'store_field_not_readable', field: 'body.locationId' }));
  }, 60_000);

  it('G3: a return relayed on another store\'s sale is judged on the sale\'s store; a held sale nothing places is refused as unresolved', async () => {
    const h = harness();
    const { call, refusals } = await shop(h);
    expect((await call('POST', '/v1/sales', 'u-cash2', sale('S-2', { locationId: S2 }))).status).toBe(202);

    const byCashier = await call('POST', '/v1/sales/S-2/returns/synced', 'u-cash1', ret('RT-1'), 'rt-1');
    expect(byCashier.status, JSON.stringify(byCashier.body)).toBe(403);
    expect(codeOf(byCashier)).toBe('outside_your_branch_scope');
    expect(whatOf(byCashier)).toContain('record.saleId');
    expect((await call('POST', '/v1/sales/S-2/returns/synced', 'u-cash1', ret('RT-1'), 'rt-1')).status).toBe(403);
    const byBox = await call('POST', '/v1/sales/S-2/returns/synced', 'u-box-a', ret('RT-1b'));
    expect(codeOf(byBox)).toBe('store_computer_record_names_another_store');
    // Nothing refunded on store-2's bill by either refused relay.
    expect(((await call('GET', '/v1/sales/S-2/returnable', 'u-owner')).body as { refundedMinor: number }).refundedMinor).toBe(0);

    // Store-2's own cashier: accepted; the replay is the same answer.
    const own = await call('POST', '/v1/sales/S-2/returns/synced', 'u-cash2', ret('RT-2'), 'rt-2');
    expect(own.status, JSON.stringify(own.body)).toBe(202);
    expect((await call('POST', '/v1/sales/S-2/returns/synced', 'u-cash2', ret('RT-2'), 'rt-2')).body).toEqual(own.body);

    // A sale the owner banked that nothing places (no location, an unregistered lane, a pack naming no store): a return on
    // it relayed by a store-scoped person or a box is refused as unresolved — never passed.
    expect((await call('POST', '/v1/sales', 'u-owner', sale('S-x', { laneId: 'lane-x' }))).status).toBe(202);
    const unresolvedPerson = await call('POST', '/v1/sales/S-x/returns/synced', 'u-cash1', ret('RT-x1'));
    expect(unresolvedPerson.status, JSON.stringify(unresolvedPerson.body)).toBe(403);
    expect(codeOf(unresolvedPerson)).toBe('record_store_unresolved');
    const unresolvedBox = await call('POST', '/v1/sales/S-x/returns/synced', 'u-box-a', ret('RT-x2'));
    expect(codeOf(unresolvedBox)).toBe('store_computer_record_store_unresolved');
    expect((await call('POST', '/v1/sales/S-x/returns/synced', 'u-owner', ret('RT-x3'))).status).toBe(202);

    const kept = await refusals();
    expect(kept).toContainEqual(expect.objectContaining({ userId: 'u-cash1', reason: 'outside_your_branch_scope', field: 'record.saleId', namedStore: S2, by: 'person' }));
    expect(kept).toContainEqual(expect.objectContaining({ userId: 'u-box-a', reason: 'record_store_unresolved', field: 'record.saleId', by: 'store_computer' }));
  }, 60_000);
});
