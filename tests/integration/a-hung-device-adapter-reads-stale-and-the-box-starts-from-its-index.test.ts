import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import type { HttpRequest } from '../../services/kernel/src/index';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { PeripheralReports, INDEX_GENERATION_RECORDS, UNCHANGED_CHECKPOINT_MS, peripheralIndexFile } from '../../edge/store-edge/src/peripheral-health';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { prepareTillBox, signInTill } from '../support/till-operator';

/**
 * **Round 15 (verifier LOWs · D04-FR-05 · M35-FR-03 · P-08) — a hung device adapter reads STALE at head office however
 * faithfully the till re-sends its last answer; and the store computer starts from its compact device index, never by
 * replaying the whole device history.**
 *
 * The REAL till shell (`bootPos`, its real `/lane/peripherals` call and 5-minute re-send), the REAL store computer
 * (`startEdge`: the peripheral log, the box-health reporter) and the REAL head office (production routes through the harness,
 * in memory and on PostgreSQL); only the clock is simulated.
 *   • The adapter keeps its own clock (`lastObservedAt`) and stops observing at minute 0 (it has hung). The till keeps
 *     re-sending every 5 minutes while the cashier is signed in, carrying that time. Head office ages the lane by the
 *     ADAPTER's time: ok until minute 14, STALE at minute 15 — saying the till is still re-sending but its adapter has not
 *     observed the devices since, so check the till — while the till's own report time is fresh.
 *   • An adapter that gives no time keeps the old behaviour (a separate test: a-quiet-healthy-till-stays-fresh…).
 *   • On disk (real files): a changed state is always written; an unchanged re-send only every UNCHANGED_CHECKPOINT_MS; a
 *     restarted box reads only the newest index generation (it reads NO history record), restores every till's latest,
 *     and nothing is ever removed — a full generation rolls over to the next one with a snapshot, the old one kept.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaab915';
const KEY = ['till', 'adapter', 'clock', 'key'].join('-').padEnd(48, '0');
const OWNER = 'u-owner';
const T0 = Date.parse('2026-10-12T04:00:00.000Z');
const at = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();
const travel = (minutes: number): void => { vi.setSystemTime(new Date(T0 + minutes * 60_000)); };
const OK = [{ kind: 'scanner', state: 'ok' }, { kind: 'printer', state: 'ok' }];
interface Component { name: string; status: string; detail: string }

async function aHungAdapterReadsStale(h: ApiHarness, tenant: string): Promise<void> {
  const savedFetch = globalThis.fetch;
  const token = ['box', 'clock', tenant].join('-').padEnd(48, '0');
  const devicePosts: Promise<unknown>[] = [];
  const sentBodies: unknown[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit): Promise<Response> => {
    if (String(url).startsWith('http://127.0.0.1:')) {
      if (String(url).endsWith('/lane/peripherals')) sentBodies.push(JSON.parse(String(init.body)));
      const p = savedFetch(url, init);
      if (String(url).endsWith('/lane/peripherals')) devicePosts.push(p.then((r) => r.clone().json()));
      return p;
    }
    const hdr = (init.headers ?? {}) as Record<string, string>;
    if (hdr['authorization']?.replace(/^Bearer /, '') !== token) return new Response('{}', { status: 401 });
    const res = await h.request({
      method: (init.method ?? 'GET') as HttpRequest['method'], path: new URL(url).pathname, userId: 'u-box1', tenantId: tenant, branchId: 'S1',
      ...(hdr['idempotency-key'] === undefined ? {} : { idempotencyKey: hdr['idempotency-key'] }),
      ...(init.body === undefined ? {} : { body: JSON.parse(String(init.body)) as unknown }),
    });
    return new Response(JSON.stringify(res.body), { status: res.status });
  }) as unknown as typeof globalThis.fetch;
  const dir = await mkdtemp(join(tmpdir(), 'sre-adapter-clock-'));
  let box: EdgeProcess | undefined;
  try {
    travel(0);
    await h.seedOwner(tenant, OWNER);
    await h.provisionRole(tenant, 'u-box1', 'store_computer', ['S1']);
    for (const [id, body] of [['C1', { kind: 'company', name: 'SRE Retail' }], ['S1', { kind: 'branch', name: 'SRE Hyper Market', parentId: 'C1', companyId: 'C1' }]] as const) {
      expect((await h.request({ method: 'POST', path: `/v1/org/nodes/${id}`, userId: OWNER, tenantId: tenant, idempotencyKey: `org-${id}`, body })).status).toBe(201);
    }
    const ready = await prepareTillBox({
      dir, key: KEY, people: [{ userId: 'u-lanecash', displayName: 'Lane Cashier' }, { userId: 'u-mgr', displayName: 'Manager', manager: true }],
      pack: { managerPolicy: { userId: 'u-mgr', approvalLimitMinor: 500_000 }, lossPreventionRules: [], policies: { storeId: 'S1', branchId: 'S1', branchName: 'S1', tradingDayCutoff: '00:00', staleAfterSeconds: 3600, countApprovalThresholdMinor: 1, handoverToleranceMinor: 1, privacySlaDays: 30, warehouseId: 'S1' } },
    });
    box = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: tenant, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
      CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: token, EDGE_STORE_ID: 'S1', ...ready,
    }, () => {}))!;
    const timers: { ms: number; fn: () => void; cancelled: boolean; last: number }[] = [];
    const pos = bootPos({
      laneId: 'lane-1', lanePort: box.lane!.port,
      deviceHeartbeatTimers: {
        every: (ms, fn) => { const t = { ms, fn, cancelled: false, last: Date.now() }; timers.push(t); return () => { t.cancelled = true; }; },
        soon: (fn) => { fn(); },
      },
    });
    const fireDueTimers = async (): Promise<void> => {
      for (const t of timers) if (!t.cancelled && Date.now() - t.last >= t.ms) { t.last += t.ms; t.fn(); }
      await Promise.all(devicePosts.splice(0));
    };
    const till = async (): Promise<Component> => {
      await box!.syncOnce!();
      expect(await box!.reportBoxHealth!()).toBe(true);
      const res = await h.request({ method: 'GET', path: '/v1/platform/operational-health/observed', userId: OWNER, tenantId: tenant });
      return (res.body as { health: { components: Component[] } }).health.components.find((c) => c.name === 'till_devices:S1')!;
    };

    // The adapter keeps its own clock — and stops observing at minute 0 (hung): it answers minute 0 for ever after.
    pos.deviceAdapterClock(() => at(0));
    await signInTill(pos, 'u-lanecash');
    expect(await pos.reportDevices(OK, at(0))).toEqual({ recorded: true });
    for (let m = 1; m <= 14; m += 1) {
      travel(m);
      await fireDueTimers();
      expect((await till()).status, `minute ${m}`).toBe('ok');
    }
    // The till kept re-sending (minutes 5 and 10), each carrying the adapter's own (old) time.
    expect(sentBodies.map((b) => (b as { adapterObservedAt?: string }).adapterObservedAt)).toEqual([at(0), at(0), at(0)]);
    travel(15);
    await fireDueTimers(); // the till re-sends at 15 too — its own report time is fresh
    const stale = await till();
    expect(stale.status).toBe('unknown');
    expect(stale.detail).toContain(`till lane-1 last had its devices observed by its device adapter 15 min ago (${at(0)})`);
    expect(stale.detail).toContain('the till is still re-sending, but its device adapter has not observed the devices since then: the adapter may have hung, check that till');
    // The adapter recovers: its clock moves on, the next re-send carries it, and the lane is fresh again.
    pos.deviceAdapterClock(() => at(16));
    travel(20);
    await fireDueTimers();
    expect((await till()).status).toBe('ok');
  } finally {
    if (box !== undefined) await box.stop();
    globalThis.fetch = savedFetch;
    await rm(dir, { recursive: true, force: true });
  }
}

describe('a hung device adapter reads STALE at head office (in memory)', () => {
  beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); });
  afterAll(() => { vi.useRealTimers(); });
  it('the till keeps re-sending, but the adapter\'s own clock stopped at minute 0: ok to 14, STALE at 15, ok once it observes again', async () => {
    await aHungAdapterReadsStale(apiHarness(), A);
  }, 120_000);
});

const DATABASE_URL = process.env['DATABASE_URL'];
describe.skipIf(!DATABASE_URL)('a hung device adapter reads STALE at head office (real PostgreSQL)', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4, options: '-c app.tenant_id=*' });
    const dir = 'db/migrations';
    await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterAll(async () => { vi.useRealTimers(); await pool.end(); });
  it('the same, on PostgreSQL', async () => {
    const sql = pgPoolClient(pool);
    await aHungAdapterReadsStale(apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }), `f${Date.now().toString(16).slice(-7)}-b915-4bbb-8bbb-${'f'.repeat(12)}`);
  }, 240_000);
});

describe('the box keeps its device history append-only and starts from its compact index (real files)', () => {
  it('writes a change at once and an unchanged re-send only as a checkpoint; a restart reads the index, never the history', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-peripheral-index-'));
    let clock = T0;
    const now = (): string => new Date(clock).toISOString();
    try {
      const first = await PeripheralReports.open({ dataDir: dir, capacityBytes: 10_485_760, now });
      expect(first.startedFrom).toEqual({ generation: 0, historyRecordsRead: 0, indexRecordsRead: 0 });
      expect((await first.report({ laneId: 'lane-1', by: 'u-c', body: { devices: OK } })).written).toBe(true);
      clock += 5 * 60_000;
      expect((await first.report({ laneId: 'lane-1', by: 'u-c', body: { devices: OK } })).written).toBe(false); // unchanged, not due
      expect(first.latest()[0]!.reportedAt).toBe(now()); // ...but the latest is fresh in memory
      clock += 1_000;
      expect((await first.report({ laneId: 'lane-1', by: 'u-c', body: { devices: [{ kind: 'printer', state: 'failed', detail: 'paper out' }] } })).written).toBe(true); // a change
      clock += UNCHANGED_CHECKPOINT_MS;
      expect((await first.report({ laneId: 'lane-1', by: 'u-c', body: { devices: [{ kind: 'printer', state: 'failed', detail: 'paper out' }] } })).written).toBe(true); // the checkpoint
      expect((await first.report({ laneId: 'lane-2', by: 'u-d', body: { devices: OK, adapterObservedAt: at(1) } })).written).toBe(true);
      await first.close();
      expect((await readLog(join(dir, 'peripheral-health.log'))).filter((r) => r.ok)).toHaveLength(4);

      // A restart reads the newest index generation only — not one history record — and has every till's latest.
      const second = await PeripheralReports.open({ dataDir: dir, capacityBytes: 10_485_760, now });
      expect(second.startedFrom).toEqual({ generation: 1, historyRecordsRead: 0, indexRecordsRead: 5 });
      expect(second.latest().map((r) => [r.laneId, r.devices[0]!.state, r.adapterObservedAt ?? null])).toEqual([['lane-1', 'failed', null], ['lane-2', 'ok', at(1)]]);

      // Fill generation 1: it rolls over to generation 2 opening with a snapshot; generation 1 stays on the disk.
      for (let i = 0; i < INDEX_GENERATION_RECORDS; i += 1) {
        clock += 1_000;
        await second.report({ laneId: 'lane-3', by: 'u-e', body: { devices: [{ kind: 'scanner', state: i % 2 === 0 ? 'ok' : 'degraded' }] } });
      }
      await second.close();
      const generations = readdirSync(dir).filter((f) => f.startsWith('peripheral-health-latest-')).sort();
      expect(generations).toEqual([peripheralIndexFile(1), peripheralIndexFile(2)]);
      const third = await PeripheralReports.open({ dataDir: dir, capacityBytes: 10_485_760, now });
      expect(third.startedFrom.generation).toBe(2);
      expect(third.startedFrom.historyRecordsRead).toBe(0);
      expect(third.startedFrom.indexRecordsRead).toBeLessThan(INDEX_GENERATION_RECORDS);
      expect(third.latest().map((r) => r.laneId)).toEqual(['lane-1', 'lane-2', 'lane-3']);
      // The history kept everything written, append-only.
      expect((await readLog(join(dir, 'peripheral-health.log'))).filter((r) => r.ok)).toHaveLength(4 + INDEX_GENERATION_RECORDS);
      await third.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('a box from before the index folds its history once, then starts from the index', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-peripheral-legacy-'));
    try {
      const { openFileLog } = await import('../../edge/store-edge/src/file-log');
      const legacy = await openFileLog({ dataDir: dir, capacityBytes: 10_485_760, fileName: 'peripheral-health.log' });
      for (let i = 0; i < 6; i += 1) await legacy.append(JSON.stringify({ laneId: `lane-${i % 2}`, reportedBy: 'u-c', reportedAt: at(i), devices: OK }));
      await legacy.close();
      const first = await PeripheralReports.open({ dataDir: dir, capacityBytes: 10_485_760 });
      expect(first.startedFrom).toEqual({ generation: 0, historyRecordsRead: 6, indexRecordsRead: 0 });
      expect(first.latest().map((r) => r.reportedAt)).toEqual([at(4), at(5)]);
      await first.close();
      const second = await PeripheralReports.open({ dataDir: dir, capacityBytes: 10_485_760 });
      expect(second.startedFrom).toEqual({ generation: 1, historyRecordsRead: 0, indexRecordsRead: 1 });
      expect(second.latest().map((r) => r.reportedAt)).toEqual([at(4), at(5)]);
      await second.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
