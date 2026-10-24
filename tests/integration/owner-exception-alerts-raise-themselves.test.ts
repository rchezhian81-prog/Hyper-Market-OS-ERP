import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { tradingDayIn } from '../../packages/calendar/src/index';
import { assessShiftClose } from '../../packages/till/src/index';
import { ownerReportingSweep } from '../../services/api/src/owner-reporting-adapters';

/**
 * **OB-288 P2 · M29-FR-03 — the owner's exception alerts are raised by head office itself, even when he is away.**
 *
 * Through the production route table (in memory, and on PostgreSQL with a cold restart): the store computer relays two
 * voided bills, a price override that took ₹140 off a bill, and a till close ₹20 short. With NO threshold set, nothing
 * fires and every read says "Not set" — never "no alerts". The owner (only the owner) enters the thresholds; the sweep —
 * the same pass the ops-alert worker runs on its timer — raises each breach into every owner's alert inbox, once: run
 * again, it raises nothing more. The after-hours sign-in is set but cannot fire, and the read says why (head office does
 * not receive till sign-ins). A manager cannot set a threshold; a value that is not one is refused; clearing one needs a
 * reason and switches it off again.
 */

const OWNER = 'u-owner'; const OWNER2 = 'u-owner-2'; const MGR = 'u-mgr'; const BOX = 'u-box';
const today = (): string => tradingDayIn(new Date().toISOString(), { timeZone: 'Asia/Kolkata', tradingDayCutoff: '00:00' });

type Board = { thresholds: { kind: string; state: string; canFire: boolean; whyNot?: string; value: unknown }[]; notSet: string[] };
type Exceptions = { tradingDay: string; kinds: { kind: string; threshold: string; events: number | null; alerts: number; say: string }[]; alerts: { kind: string; inboxId: string; inOwnersInbox: boolean; count: number; valueMinor: number }[] };

const call = (h: ApiHarness, T: string, method: 'GET' | 'POST', path: string, userId: string, body?: unknown, branchId?: string) =>
  h.request({ method, path, userId, tenantId: T, ...(branchId === undefined ? {} : { branchId }), ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }) });

async function seed(h: ApiHarness, T: string): Promise<void> {
  await h.seedOwner(T, OWNER);
  await h.provisionOwner(T, OWNER2);
  await h.provisionRole(T, BOX, 'store_computer', ['S1']);
  await h.provisionRole(T, MGR, 'store_manager');
  const at = new Date().toISOString();
  const day = today();
  const voidOf = (id: string, bill: string, value: number) => ({ activityId: id, kind: 'void', laneId: 'lane-1', cashierId: 'c-1', billRef: bill, lineId: 'L1', productId: 'P1', description: 'Rice 5kg', valueMinor: value, reason: 'customer_changed_mind', at, tradingDay: day });
  for (const [id, bill, v] of [['V-1', 'B-1', 30_000], ['V-2', 'B-2', 12_000]] as const) {
    expect((await call(h, T, 'POST', `/v1/loss-prevention/activity/${id}/synced`, BOX, voidOf(id, bill, v))).status).toBe(201);
  }
  expect((await call(h, T, 'POST', '/v1/loss-prevention/activity/O-1/synced', BOX, {
    activityId: 'O-1', kind: 'price_override', laneId: 'lane-1', cashierId: 'c-1', billRef: 'B-3', lineId: 'L1', productId: 'P2', description: 'Ghee 1L',
    fromUnitMinor: 64_000, toUnitMinor: 50_000, quantityMinor: 1, valueMinor: 14_000, reason: 'damaged_pack', approvedBy: MGR, approvalId: 'apr-O-1', at, tradingDay: day,
  })).status).toBe(201);
  // A till close ₹20 short (expected 1,15,000 paise, counted 1,13,000), as the store computer relays it.
  const b = { openingFloatMinor: 50_000, cashSalesMinor: 100_000, pickupsMinor: 30_000, cashRefundsMinor: 5_000, countedCashMinor: 113_000, toleranceMinor: 500, reasonCode: 'note_miscounted' };
  const decided = assessShiftClose(b);
  expect((await call(h, T, 'POST', '/v1/shifts/SH-1/close/synced', BOX, {
    tillId: 'lane-1', cashierId: 'c-1', tradingDay: day, openingFloatMinor: 50_000, cashSalesMinor: 100_000, pickupsMinor: 30_000, cashRefundsMinor: 5_000,
    toleranceMinor: 500, reasonCode: 'note_miscounted', laneId: 'lane-1', openedAt: at, closedAt: at,
    countedMinor: 113_000, expectedMinor: decided.expectedMinor, varianceMinor: decided.varianceMinor, exceptionRaised: decided.exceptionRaised,
  }, 'S1')).status).toBe(202);
}

async function nothingSetNothingFires(h: ApiHarness, T: string): Promise<void> {
  const board = (await call(h, T, 'GET', '/v1/reporting/owner-alert-thresholds', OWNER)).body as Board;
  expect(board.notSet.sort()).toEqual(['after_hours_login', 'cash_short', 'large_discount', 'price_override', 'voided_bill']);
  expect(board.thresholds.every((t) => t.state === 'not_set' && !t.canFire && t.whyNot === 'Not set. This alert does not fire until you enter it.')).toBe(true);
  const ex = (await call(h, T, 'GET', '/v1/reporting/owner-exceptions', OWNER)).body as Exceptions;
  expect(ex.tradingDay).toBe(today());
  const kind = (k: string) => ex.kinds.find((x) => x.kind === k)!;
  // The records are there — counted — and NOTHING is raised from them, because no threshold is set.
  expect(kind('voided_bill')).toMatchObject({ threshold: 'not_set', events: 2, alerts: 0 });
  expect(kind('price_override')).toMatchObject({ events: 1, alerts: 0 });
  expect(kind('cash_short')).toMatchObject({ events: 1, alerts: 0 });
  // P-08: a kind head office does not receive has no count — never nought.
  expect(kind('after_hours_login').events).toBeNull();
  expect(ex.alerts).toEqual([]);
  expect(((await call(h, T, 'POST', '/v1/reporting/owner-exceptions/raise', OWNER)).body as { raised: number }).raised).toBe(0);
}

async function ownerSetsThresholdsAndTheyFire(h: ApiHarness, T: string): Promise<void> {
  // Only the owner sets a threshold; a manager is refused, and a value that is not one is refused by name.
  expect((await call(h, T, 'POST', '/v1/reporting/owner-alert-thresholds/voided_bill', MGR, { value: 2 })).status).toBe(403);
  const bad = await call(h, T, 'POST', '/v1/reporting/owner-alert-thresholds/large_discount', OWNER, { value: -5 });
  expect(bad.status).toBe(400);
  expect((bad.body as { error: { code: string } }).error.code).toBe('not_readable_as_a_threshold');
  expect((await call(h, T, 'POST', '/v1/reporting/owner-alert-thresholds/no_such_alert', OWNER, { value: 1 })).status).toBe(404);
  expect((await call(h, T, 'POST', '/v1/reporting/owner-alert-thresholds/after_hours_login', OWNER, { value: { opensAtHour: 22, closesAtHour: 9 } })).status).toBe(400);
  for (const [kind, value] of [['voided_bill', 2], ['large_discount', 10_000], ['price_override', 1], ['cash_short', 1_000], ['after_hours_login', { opensAtHour: 8, closesAtHour: 23 }]] as const) {
    const r = await call(h, T, 'POST', `/v1/reporting/owner-alert-thresholds/${kind}`, OWNER, { value });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  }
  const board = (await call(h, T, 'GET', '/v1/reporting/owner-alert-thresholds', OWNER)).body as Board;
  expect(board.notSet).toEqual([]);
  const ah = board.thresholds.find((t) => t.kind === 'after_hours_login')!;
  expect(ah).toMatchObject({ state: 'set', canFire: false });
  expect(ah.whyNot).toContain('does not reach head office');

  const ex = (await call(h, T, 'GET', '/v1/reporting/owner-exceptions', OWNER)).body as Exceptions;
  expect(ex.alerts.map((a) => a.kind).sort()).toEqual(['cash_short', 'large_discount', 'price_override', 'voided_bill']);
  expect(ex.alerts.find((a) => a.kind === 'voided_bill')).toMatchObject({ count: 2, valueMinor: 42_000, inOwnersInbox: false });
  expect(ex.alerts.find((a) => a.kind === 'cash_short')).toMatchObject({ count: 1, valueMinor: 2_000 });

  // The sweep raises each into the owners' inbox — and run again, raises nothing more.
  expect((await call(h, T, 'POST', '/v1/reporting/owner-exceptions/raise', MGR)).status).toBe(403);
  const first = (await call(h, T, 'POST', '/v1/reporting/owner-exceptions/raise', OWNER)).body as { raised: number };
  expect(first.raised).toBe(4);
  expect(((await call(h, T, 'POST', '/v1/reporting/owner-exceptions/raise', OWNER)).body as { raised: number }).raised).toBe(0);
  for (const who of [OWNER, OWNER2]) {
    const inbox = (await call(h, T, 'GET', '/v1/platform/alerts/inbox', who)).body as { alerts: { alert: { alertId: string; detail: string } }[] };
    const mine = inbox.alerts.filter((a) => a.alert.alertId.startsWith(`owner-exception:${today()}:`));
    expect(mine.map((a) => a.alert.alertId.split(':')[2]).sort(), who).toEqual(['cash_short|S1|c-1', 'large_discount|S1|c-1', 'price_override|S1|c-1', 'voided_bill|S1|c-1']);
    expect(mine.find((a) => a.alert.alertId.includes('voided_bill'))!.alert.detail).toContain('B-1');
  }
  const after = (await call(h, T, 'GET', '/v1/reporting/owner-exceptions', OWNER)).body as Exceptions;
  expect(after.alerts.every((a) => a.inOwnersInbox)).toBe(true);
}

async function clearing(h: ApiHarness, T: string): Promise<void> {
  expect((await call(h, T, 'POST', '/v1/reporting/owner-alert-thresholds/price_override', OWNER, { clear: true })).status).toBe(400);
  expect((await call(h, T, 'POST', '/v1/reporting/owner-alert-thresholds/price_override', OWNER, { clear: true, reason: 'too noisy this week' })).status).toBe(201);
  const board = (await call(h, T, 'GET', '/v1/reporting/owner-alert-thresholds', OWNER)).body as Board;
  expect(board.notSet).toEqual(['price_override']);
  const ex = (await call(h, T, 'GET', '/v1/reporting/owner-exceptions', OWNER)).body as Exceptions;
  expect(ex.kinds.find((k) => k.kind === 'price_override')!.say).toBe('Not set. This alert does not fire until you enter it.');
}

describe('M29-FR-03 — the owner\'s exception alerts raise themselves (OB-288 P2)', () => {
  it('in memory: nothing set fires nothing; the owner sets them; each breach reaches every owner once; the worker\'s pass does the same', async () => {
    const T = 'ab000000-0000-4000-8000-00000000a29f';
    const h = apiHarness();
    await seed(h, T);
    await nothingSetNothingFires(h, T);
    await ownerSetsThresholdsAndTheyFire(h, T);
    await clearing(h, T);
    // The worker's own hook (the ops-alert pass) over the same records raises nothing more — it is the same sweep.
    const sweep = ownerReportingSweep({ store: h.store, now: () => new Date().toISOString(), settings: { value: async (_t, s) => s.defaultValue } });
    expect(await sweep(T, new Date().toISOString())).toBe(0);
  }, 120_000);
});

const DATABASE_URL = process.env['DATABASE_URL'];
describe.skipIf(!DATABASE_URL)('M29-FR-03 — owner exception alerts on PostgreSQL, through a cold restart', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4, options: '-c app.tenant_id=*' });
    const dir = 'db/migrations';
    await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(`${dir}/${name}`, 'utf8') })));
  }, 120_000);
  afterAll(async () => { await pool.end(); });

  it('the thresholds and the raised alerts survive a restart; the sweep after it raises nothing twice', async () => {
    const sql = pgPoolClient(pool);
    const T = randomUUID();
    const h = apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) });
    await seed(h, T);
    await nothingSetNothingFires(h, T);
    await ownerSetsThresholdsAndTheyFire(h, T);
    // Cold restart: a new head office over the same database.
    const again = apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) });
    const board = (await call(again, T, 'GET', '/v1/reporting/owner-alert-thresholds', OWNER)).body as Board;
    expect(board.notSet).toEqual([]);
    expect(((await call(again, T, 'POST', '/v1/reporting/owner-exceptions/raise', OWNER)).body as { raised: number }).raised).toBe(0);
    await clearing(again, T);
  }, 120_000);
});
