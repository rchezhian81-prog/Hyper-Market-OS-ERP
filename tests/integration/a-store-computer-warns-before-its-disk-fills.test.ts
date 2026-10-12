import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { SqlConfigVersionStore } from '../../packages/persistence/src/config-store';
import { DurableTenantSettings } from '../../packages/tenant/src/index';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { inMemorySettings } from '../../services/platform/src/index';
import { estimateTradingHoursLeft, type BoxHealthRecord } from '../../services/platform/src/box-health';

/**
 * **OB-78 "A" (owner, 12 Oct 2026, in writing, "Warn at hours of trading left") — an early warning before a store computer's
 * disk fills (M35-FR-03 · M35-FR-04 · §32 · P-08).**
 *
 * On the real head-office API (in memory and, with DATABASE_URL, on real PostgreSQL — reports, alert rules, alerts AND the
 * owner's setting all durable), the store computer reports its disk after each sync pass (`POST /v1/store-computers/
 * health-reports`, its own credential, store-stamped):
 *
 *   • with too little history head office says the hours of trading left are NOT YET KNOWN (never a guess) and the disk is ok;
 *   • from a morning's reports (the sales log growing 2 MB per trading hour, a closed night in between that is NOT counted)
 *     it estimates 15 hours of trading left — under the owner's default line of 48 — so `box_disk:S1` is `degraded`, the
 *     words say how it was worked out, and the owner's existing alert rule raises it to the NAMED owner;
 *   • the owner moves the line to 12 hours in store setup (versioned, who and when kept); the same disk is now `ok` and the
 *     alert clears; a cashier cannot change the line (403) and a nonsense value is refused by name, nothing stored;
 *   • a second head-office instance (a restart) judges the same with the owner's stored line;
 *   • a report re-sent with the same key is one record (the estimate is unchanged);
 *   • when the box goes quiet past the sync-lag line its last report is STALE: the disk is `unknown`, never warned or cleared
 *     on old news;
 *   • a disk the box would refuse a sale on is still `down`, as before.
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
afterEach(() => { vi.useRealTimers(); });

type Factory = (same?: ApiHarness) => ApiHarness;
const memorySettings = inMemorySettings();
const backings: { name: string; harness: Factory }[] = [{ name: 'the in-memory event store', harness: (same) => apiHarness({ settings: memorySettings, ...(same === undefined ? {} : { store: same.store }) }) }];
if (DATABASE_URL !== undefined) {
  backings.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql), settings: new DurableTenantSettings(new SqlConfigVersionStore(sql)) }); } });
}

const MB = 1_048_576;
const T0 = Date.parse('2026-10-12T02:30:00.000Z'); // 08:00 in the shop
const at = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();
interface Component { name: string; status: string; detail: string; evidence?: Record<string, number | string> }
interface Observed {
  observed: { boxes: { storeId: string; stale: boolean; tradingHoursLeft: number | null; tradingHoursLeftSays: string | null }[] };
  health: { components: Component[] };
  wouldRaise: { alertId: string; component: string; status: string; ownerUserId: string; ownerName: string }[];
}

describe.each(backings)('OB-78 — a store computer warns before its disk fills — on $name', ({ harness }) => {
  it('estimates hours of trading left from its own reports, warns the named owner below the owner\'s line, and never guesses or judges old news', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(at(0)));
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-box1', 'store_computer', ['S1']);
    await h.provisionRole(T, 'u-cash', 'cashier');
    let n = 0;
    const call = (hh: ApiHarness, method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown, key?: string) =>
      hh.request({ method, path, userId, tenantId: T, ...(userId === 'u-box1' ? { branchId: 'S1' } : {}), ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: key ?? `k-${n += 1}` }) });
    for (const [id, body] of [['C1', { kind: 'company', name: 'SRE Retail' }], ['S1', { kind: 'branch', name: 'SRE Hyper Market', parentId: 'C1', companyId: 'C1' }]] as const) {
      expect((await call(h, 'POST', `/v1/org/nodes/${id}`, 'u-owner', body)).status).toBe(201);
    }
    // The owner's existing alert rule names who owns the store computer's disk — firing from `degraded` (§32).
    expect((await call(h, 'PUT', '/v1/platform/alert-rules', 'u-owner', { rules: [
      { alertId: 's1-box-disk', component: 'box_disk:S1', firesAt: 'degraded', ownerUserId: 'u-owner', ownerName: 'Owner', ackWithinMinutes: 60, escalatesToUserId: 'u-owner' },
    ] })).status).toBe(200);

    /** The box's report at minute `m`: a 100 MB sales log with a 10 MB reserve, `usedMb` used, plenty of disk free. */
    const report = async (m: number, usedMb: number, key?: string, freeMb = 5_000) => {
      vi.setSystemTime(new Date(at(m)));
      const r = await call(h, 'POST', '/v1/store-computers/health-reports', 'u-box1', {
        storeId: 'S1', observedAt: at(m),
        disk: { freeBytes: freeMb * MB, totalBytes: 10_000 * MB, salesLogUsedBytes: usedMb * MB, salesLogCapacityBytes: 100 * MB, reserveBytes: 10 * MB },
        queue: { unsent: 0, deadLettered: 0 }, tills: [],
      }, key);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    };
    const observed = async (hh: ApiHarness = h): Promise<Observed> => {
      const r = await call(hh, 'GET', '/v1/platform/operational-health/observed', 'u-owner');
      expect(r.status).toBe(200);
      return r.body as Observed;
    };
    const disk = (o: Observed) => o.health.components.find((c) => c.name === 'box_disk:S1')!;

    // ── Too little history: one report, then a single growing gap — NOT YET KNOWN, never a guess, and not a warning ──
    await report(0, 50);
    let o = await observed();
    expect(disk(o).status).toBe('ok');
    expect(o.observed.boxes[0]).toMatchObject({ tradingHoursLeft: null });
    expect(o.observed.boxes[0]!.tradingHoursLeftSays).toMatch(/not yet known/);
    expect(disk(o).evidence).toMatchObject({ tradingHoursLeft: 'not yet known', warnBelowTradingHours: 48 });
    await report(30, 51);
    o = await observed();
    expect([disk(o).status, o.observed.boxes[0]!.tradingHoursLeft]).toEqual(['ok', null]);
    expect(o.wouldRaise).toEqual([]);

    // ── Yesterday evening a closed night (no growth for 12 hours) — then the morning's trading: +1 MB per half hour ──
    // (The night gap does not count: the estimate is in hours of TRADING.)
    await report(30 + 720, 51);
    await report(30 + 750, 52);
    await report(30 + 780, 53);
    await report(30 + 810, 54);
    await report(30 + 840, 55);
    await report(30 + 870, 60); // a busy half hour: +5 MB
    // Counted: 6 growing half-hours = 3 hours of trading, 10 MB grown (the 12-hour night adds nothing and is left out).
    o = await observed();
    const left = o.observed.boxes[0]!.tradingHoursLeft!;
    // Room above the reserve: 100 − 60 − 10 = 30 MB; rate = 10 MB / 3 h; 30 / (10/3) = 9 hours of trading.
    expect(left).toBe(9);
    expect(disk(o).status).toBe('degraded');
    expect(disk(o).detail).toMatch(/^store S1's computer will run out of room for sales soon — about 9 hours of trading left before it would refuse a sale/);
    expect(disk(o).detail).toMatch(/below the owner's warning line of 48 hours/);
    expect(disk(o).evidence).toMatchObject({ tradingHoursLeft: 9, warnBelowTradingHours: 48 });
    // The owner's existing rule raises it to the NAMED owner.
    expect(o.wouldRaise.map((a) => [a.alertId, a.component, a.status, a.ownerUserId])).toEqual([['s1-box-disk', 'box_disk:S1', 'degraded', 'u-owner']]);
    const raised = await call(h, 'POST', '/v1/platform/operational-health/observed/raise', 'u-owner', {});
    expect(raised.status, JSON.stringify(raised.body)).toBe(200);
    expect((raised.body as { alerts: { alertId: string; ownerUserId: string }[] }).alerts.map((a) => [a.alertId, a.ownerUserId])).toEqual([['s1-box-disk', 'u-owner']]);

    // ── A re-sent report (same key) is one record: the estimate does not move ──
    await report(30 + 870, 60, 'resend-key');
    await report(30 + 870, 60, 'resend-key');
    expect((await observed()).observed.boxes[0]!.tradingHoursLeft).toBe(9);

    // ── The owner moves the line in store setup: a cashier cannot; a nonsense value is refused by name ──
    expect((await call(h, 'PUT', '/v1/platform/setup/platform.box_disk_warn_hours', 'u-cash', { value: 4 })).status).toBe(403);
    const bad = await call(h, 'PUT', '/v1/platform/setup/platform.box_disk_warn_hours', 'u-owner', { value: 0 });
    expect([bad.status, (bad.body as { error: { code: string } }).error.code]).toEqual([422, 'setup_answer_refused']);
    expect((await call(h, 'PUT', '/v1/platform/setup/platform.box_disk_warn_hours', 'u-owner', { value: 2.5 })).status).toBe(422);
    const set = await call(h, 'PUT', '/v1/platform/setup/platform.box_disk_warn_hours', 'u-owner', { value: 8 });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const setup = (await call(h, 'GET', '/v1/platform/setup', 'u-owner')).body as { items: { key: string; value: unknown; changedBy?: string; version: number }[] };
    expect(setup.items.find((i) => i.key === 'platform.box_disk_warn_hours')).toMatchObject({ value: 8, changedBy: 'u-owner', version: 1 });
    o = await observed();
    expect([disk(o).status, disk(o).evidence?.['warnBelowTradingHours']]).toEqual(['ok', 8]);
    expect(disk(o).detail).toMatch(/about 9 hours of trading left/);
    expect(o.wouldRaise).toEqual([]);
    // The worker's pass (the same raise, clearing) clears the alert — kept, never deleted.
    const cleared = await call(h, 'POST', '/v1/platform/operational-health/observed/raise', 'u-owner', {});
    expect(cleared.status).toBe(200);

    // ── A restart: a second head-office instance judges the same, on the owner's STORED line ──
    expect(disk(await observed(harness(h))).status).toBe('ok');
    expect(disk(await observed(harness(h))).evidence?.['warnBelowTradingHours']).toBe(8);

    // ── The box goes quiet past the sync-lag line: STALE — `unknown`, never warned or cleared on old news ──
    expect((await call(h, 'PUT', '/v1/platform/setup/platform.box_disk_warn_hours', 'u-owner', { value: 48 })).status).toBe(200);
    vi.setSystemTime(new Date(at(30 + 870 + 20)));
    o = await observed();
    expect(o.observed.boxes[0]!.stale).toBe(true);
    expect(disk(o).status).toBe('unknown');
    expect(disk(o).detail).toMatch(/^STALE/);
    expect(o.wouldRaise).toEqual([]);

    // ── A disk the box would refuse a sale on is still DOWN (its own rule), not merely a warning ──
    await report(30 + 900, 91);
    expect(disk(await observed()).status).toBe('down');
  }, 60_000);
});

describe('OB-78 — the stated method on round numbers (pure)', () => {
  const rec = (m: number, usedMb: number, freeMb = 5_000): BoxHealthRecord => ({
    storeId: 'S1', observedAt: at(m), receivedAt: at(m), reportedBy: 'u-box1', clockAheadCorrected: false, tills: [], queue: { unsent: 0, deadLettered: 0 },
    disk: { freeBytes: freeMb * MB, totalBytes: 10_000 * MB, salesLogUsedBytes: usedMb * MB, salesLogCapacityBytes: 100 * MB, reserveBytes: 10 * MB },
  });
  it('rate = growth ÷ trading hours (idle gaps left out); hours left = room above the reserve ÷ rate, rounded down', () => {
    const rs = [rec(0, 40), rec(60, 42), rec(600, 42) /* closed: no growth, not counted */, rec(660, 44), rec(720, 46)];
    expect(estimateTradingHoursLeft(rs, rs.at(-1)!)).toMatchObject({ known: true, bytesPerTradingHour: 2 * MB, roomLeftBytes: 44 * MB, hoursLeft: 22, tradingMinutesCounted: 180, growingGaps: 3 });
  });
  it('the smaller room wins — a disk short of free space is judged on its free space above the reserve', () => {
    const rs = [rec(0, 40, 30), rec(60, 42, 28), rec(120, 44, 26)];
    expect(estimateTradingHoursLeft(rs, rs.at(-1)!)).toMatchObject({ known: true, roomLeftBytes: 16 * MB, hoursLeft: 8 });
  });
  it('a log that got smaller starts the history again; too little after it is NOT YET KNOWN', () => {
    const rs = [rec(0, 40), rec(60, 60), rec(120, 80), rec(180, 5) /* a new log */, rec(240, 6)];
    const e = estimateTradingHoursLeft(rs, rs.at(-1)!);
    expect(e.known).toBe(false);
    expect(e).toMatchObject({ growingGaps: 1, tradingMinutesCounted: 60 });
  });
  it('a log that never grew is not yet known — never "forever"', () => {
    const rs = [rec(0, 40), rec(60, 40), rec(120, 40)];
    expect(estimateTradingHoursLeft(rs, rs.at(-1)!).known).toBe(false);
  });
});
