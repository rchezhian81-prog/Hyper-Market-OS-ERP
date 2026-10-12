import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { estimateTradingHoursLeft, judgeBoxes, DISK_ESTIMATE_MAX_GAP_MINUTES, type BoxHealthRecord } from '../../services/platform/src/box-health';

/**
 * **Round 14 (verifier G8 · OB-78 · P-08): an overnight gap never stretches the hours of trading left.**
 *
 * The verifier's probes: E1 — 12-hour trading days, reports every 15 minutes, the box off overnight; each night gap ended
 * with the first quarter-hour of sales, so 12h15m per night was counted as trading time: 27 real hours left read as 49.5
 * and the disk read "ok" against the 48-hour line. E2 — one byte of growth over a 24-hour gap turned ~14 hours into 345.8.
 * Now a gap longer than DISK_ESTIMATE_MAX_GAP_MINUTES (the box reports on every sync pass, well under that while it runs)
 * is left out whole: E1 estimates AT MOST the true hours and the disk warns; E2 is unmoved by the lone byte. "Not yet
 * known" reads `unknown` with its reason — never a plain ok, never the warning. Proven on the pure method and through the
 * real report route and the observed-health read (in memory, and with DATABASE_URL on real PostgreSQL).
 */

const MB = 1_048_576;
const H = 3_600_000;
const rec = (at: number, used: number, capacityMb = 11_000): BoxHealthRecord => ({
  storeId: 'S1', observedAt: new Date(at).toISOString(), receivedAt: new Date(at).toISOString(), reportedBy: 'u-box',
  disk: { freeBytes: 50_000 * MB, totalBytes: 100_000 * MB, salesLogUsedBytes: used, salesLogCapacityBytes: capacityMb * MB, reserveBytes: 100 * MB },
  queue: { unsent: 0, deadLettered: 0 }, tills: [], clockAheadCorrected: false,
} as unknown as BoxHealthRecord);
const BASE = Date.parse('2026-10-01T03:30:00Z'); // 09:00 in the shop
/** E1: `days` trading days 09:00–21:00 at 100 MB per trading hour, a report every 15 minutes, the box off overnight. */
function tradingDays(days: number): { records: BoxHealthRecord[]; realHoursLeft: number } {
  let used = 1_000 * MB;
  const records: BoxHealthRecord[] = [];
  for (let day = 0; day < days; day++) for (let q = 1; q <= 48; q++) { used += 25 * MB; records.push(rec(BASE + day * 24 * H + q * 15 * 60_000, used)); }
  return { records, realHoursLeft: (11_000 * MB - used - 100 * MB) / (100 * MB) };
}

describe('the method: a gap longer than the cap is left out whole', () => {
  it('E1: six trading days with overnight gaps estimate at most the true hours, and warn under the 48-hour line', () => {
    const { records, realHoursLeft } = tradingDays(6);
    expect(realHoursLeft).toBe(27);
    const e = estimateTradingHoursLeft(records, records[records.length - 1]!);
    expect(e.known).toBe(true);
    if (!e.known) return;
    expect(e.hoursLeft).toBeLessThanOrEqual(realHoursLeft);
    expect(e.hoursLeft).toBeGreaterThanOrEqual(realHoursLeft - 1); // never a large under-estimate either
    const j = judgeBoxes({ records, at: records[records.length - 1]!.observedAt, thresholds: { syncLagWarnSeconds: 900 } as never, diskWarnHours: 48 });
    expect(j.components.find((c) => c.name === 'box_disk:S1')?.status).toBe('degraded');
  });

  it('E2: one byte over a 24-hour gap does not move the estimate', () => {
    const base = Date.parse('2026-10-01T03:30:00Z');
    const before = [rec(base, 1000 * MB), rec(base + 30 * 60_000, 1300 * MB), rec(base + 60 * 60_000, 1600 * MB)];
    const after = [...before, rec(base + 25 * H, 1600 * MB + 1)];
    const a = estimateTradingHoursLeft(before, before[2]!);
    const b = estimateTradingHoursLeft(after, after[3]!);
    expect(a.known && b.known).toBe(true);
    if (!a.known || !b.known) return;
    expect(b.hoursLeft).toBeLessThanOrEqual(a.hoursLeft);
    expect(b.tradingMinutesCounted).toBe(60);
  });

  it('a gap exactly at the cap still counts; one minute over does not', () => {
    const base = Date.parse('2026-10-01T03:30:00Z');
    const cap = DISK_ESTIMATE_MAX_GAP_MINUTES * 60_000;
    const atCap = [rec(base, 1000 * MB), rec(base + cap, 1100 * MB), rec(base + 2 * cap, 1200 * MB)];
    expect(estimateTradingHoursLeft(atCap, atCap[2]!)).toMatchObject({ known: true, growingGaps: 2 });
    const over = [rec(base, 1000 * MB), rec(base + cap + 60_000, 1100 * MB), rec(base + 2 * cap + 120_000, 1200 * MB)];
    expect(estimateTradingHoursLeft(over, over[2]!)).toMatchObject({ known: false, growingGaps: 0 });
  });
});

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
const backings: { name: string; harness: () => ApiHarness }[] = [{ name: 'the in-memory event store', harness: () => apiHarness() }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });

interface Observed { observed: { boxes: { tradingHoursLeft: number | null; tradingHoursLeftSays: string | null }[] }; health: { components: { name: string; status: string; detail: string }[] } }

describe.each(backings)('Round 14 — overnight gaps through the real report route — on $name', ({ harness }) => {
  it('two trading days of reports with the box off overnight: the disk warns (degraded), and before enough history it reads unknown with the reason', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-box1', 'store_computer', ['S1']);
    for (const [id, body] of [['C1', { kind: 'company', name: 'SRE Retail' }], ['S1', { kind: 'branch', name: 'SRE Hyper Market', parentId: 'C1', companyId: 'C1' }]] as const) {
      expect((await h.request({ method: 'POST', path: `/v1/org/nodes/${id}`, userId: 'u-owner', tenantId: T, idempotencyKey: `n-${id}`, body })).status).toBe(201);
    }
    const post = async (r: BoxHealthRecord) => {
      vi.setSystemTime(new Date(r.observedAt));
      const res = await h.request({ method: 'POST', path: '/v1/store-computers/health-reports', userId: 'u-box1', tenantId: T, branchId: 'S1', idempotencyKey: `bh-${r.observedAt}`,
        body: { storeId: 'S1', observedAt: r.observedAt, disk: { ...r.disk, salesLogCapacityBytes: 6_000 * MB }, queue: r.queue, tills: [] } });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    };
    const observed = async (): Promise<Observed> => (await h.request({ method: 'GET', path: '/v1/platform/operational-health/observed', userId: 'u-owner', tenantId: T })).body as Observed;
    const disk = (o: Observed) => o.health.components.find((c) => c.name === 'box_disk:S1')!;
    const { records } = tradingDays(2); // used: 1000 MB + 2 × 1200 MB = 3400 MB of a 6000 MB log → (6000−3400−100)/100 = 25 hours

    await post(records[0]!);
    let o = await observed();
    expect(disk(o).status).toBe('unknown');
    expect(disk(o).detail).toMatch(/not yet known/);
    for (const r of records.slice(1)) await post(r);
    o = await observed();
    const left = o.observed.boxes[0]!.tradingHoursLeft!;
    expect(left).toBeLessThanOrEqual(25);
    expect(left).toBeGreaterThanOrEqual(24);
    expect(disk(o).status).toBe('degraded');
    expect(disk(o).detail).toMatch(/below the owner's warning line of 48 hours/);
  }, 120_000);
});
