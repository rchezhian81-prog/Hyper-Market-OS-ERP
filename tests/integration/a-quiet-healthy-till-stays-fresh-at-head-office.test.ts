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
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { DEVICE_HEARTBEAT_INTERVAL_MS } from '../../apps/pos/src/device-heartbeat';
import { prepareTillBox, signInTill } from '../support/till-operator';

/**
 * **D04-FR-05 · M35-FR-03 · P-08 · §31 — a quiet but healthy till stays "ok" at head office while a cashier is signed in,
 * and goes STALE once nobody is signed in and the threshold passes.**
 *
 * Head office judges each till's device report by the till's OWN report time (15 minutes by default). Before this, a till
 * only reported when its device adapter spoke, so a healthy, quiet till read `unknown`. Now the till shell re-sends its
 * last known device states every 5 minutes while a cashier is signed in.
 *
 * The REAL till shell (`bootPos`, its real lane calls — sign-in and `/lane/peripherals`), the REAL store computer
 * (`startEdge`: till sessions, the peripheral log, the sync loop, the box-health reporter) and the REAL head office
 * (production routes through the harness, in memory and on PostgreSQL). Only the clock is simulated: Date is moved
 * minute by minute, and the till's 5-minute timer is a simulated one fired when its 5 minutes are up.
 *   • minutes 0–40, a cashier signed in, the adapter never speaks again: every minute the box reports, and head office
 *     reads `till_devices:S1` = ok — never stale; the box relays ONE report for the lane (the latest), and keeps every
 *     re-send on its disk (append-only);
 *   • the cashier signs out at 41: nothing more is sent; at 54 (14 minutes after the last re-send) still ok; at 55 it is
 *     STALE — `unknown`, saying nobody is signed in at that till (expected when unattended).
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaab902';
const KEY = ['till', 'heartbeat', 'box', 'key'].join('-').padEnd(48, '0');
const OWNER = 'u-owner';
const T0 = Date.parse('2026-10-12T04:00:00.000Z'); // 09:30 in the shop
const at = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();
const travel = (minutes: number): void => { vi.setSystemTime(new Date(T0 + minutes * 60_000)); };
const OK = [{ kind: 'scanner', state: 'ok' }, { kind: 'printer', state: 'ok' }, { kind: 'cash_drawer', state: 'ok' }];

interface Component { name: string; status: string; detail: string }
interface Observed { observed: { boxes: { storeId: string; stale: boolean; tills: { laneId: string; reportedAt: string; attended?: boolean }[] }[] }; health: { components: Component[] } }

async function aQuietHealthyTillStaysFresh(h: ApiHarness, tenant: string): Promise<void> {
  const savedFetch = globalThis.fetch;
  const token = ['box', 'hb', tenant].join('-').padEnd(48, '0');
  const devicePosts: Promise<unknown>[] = [];
  let devicePostCount = 0;
  globalThis.fetch = (async (url: string, init: RequestInit): Promise<Response> => {
    if (String(url).startsWith('http://127.0.0.1:')) {
      const p = savedFetch(url, init);
      if (String(url).endsWith('/lane/peripherals')) { devicePostCount += 1; devicePosts.push(p.then((r) => r.clone().json())); }
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
  const dir = await mkdtemp(join(tmpdir(), 'sre-till-heartbeat-'));
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

    // The till shell, on its real lane calls; its 5-minute timer is simulated (fired when its 5 minutes are up).
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
    const observe = async (): Promise<{ o: Observed; till: Component }> => {
      const res = await h.request({ method: 'GET', path: '/v1/platform/operational-health/observed', userId: OWNER, tenantId: tenant });
      expect(res.status).toBe(200);
      const o = res.body as Observed;
      return { o, till: o.health.components.find((c) => c.name === 'till_devices:S1')! };
    };
    const boxReports = async (): Promise<void> => {
      await box!.syncOnce!();
      expect(await box!.reportBoxHealth!()).toBe(true);
    };

    // The cashier signs in; the device adapter answers once (all fine) and is never heard from again.
    await signInTill(pos, 'u-lanecash');
    expect(await pos.reportDevices(OK)).toEqual({ recorded: true });
    expect(timers.map((t) => t.ms)).toEqual([DEVICE_HEARTBEAT_INTERVAL_MS]);

    // 40 simulated minutes, signed in, quiet: every minute the box reports and head office reads ok — never stale.
    for (let m = 1; m <= 40; m += 1) {
      travel(m);
      await fireDueTimers();
      await boxReports();
      const { o, till } = await observe();
      expect(till.status, `minute ${m}: ${till.detail}`).toBe('ok');
      expect(till.detail).toBe('every till device at store S1 that reported recently said it was working');
      const s1 = o.observed.boxes.find((b) => b.storeId === 'S1')!;
      // The box keeps only the latest per lane and relays it; the cashier's id never travels.
      expect(s1.tills).toEqual([{ laneId: 'lane-1', reportedAt: at(Math.floor(m / 5) * 5), devices: OK, attended: true }]);
    }
    // One sign-in report plus a re-send every 5 minutes (8). Round 15: the box's disk keeps the history append-only, but an
    // UNCHANGED re-send is written only as a 15-minute "still the same" checkpoint (minutes 0, 15, 30) — the other re-sends
    // refresh the latest in memory (head office still reads them fresh above). The compact latest-per-till index (which the
    // box reads at start instead of the whole history) opens with its snapshot and follows the same writes.
    expect(devicePostCount).toBe(9);
    const kept = (await readLog(join(dir, 'peripheral-health.log'))).filter((r) => r.ok);
    expect(kept.map((r) => (JSON.parse(r.record) as { reportedAt: string }).reportedAt)).toEqual([at(0), at(15), at(30)]);
    expect((await readLog(join(dir, 'peripheral-health-latest-1.log'))).filter((r) => r.ok)).toHaveLength(4);
    expect(JSON.stringify(await observe())).not.toContain('u-lanecash');

    // The cashier signs out: the till stops re-sending.
    travel(41);
    await pos.signOutAtTill();
    expect(pos.deviceHeartbeat.running()).toBe(false);
    for (let m = 42; m <= 54; m += 1) {
      travel(m);
      await fireDueTimers();
      await boxReports();
    }
    expect(devicePostCount).toBe(9); // nothing sent while nobody is signed in
    // 14 minutes after the last re-send: still inside the threshold — ok.
    expect((await observe()).till.status).toBe('ok');
    // 15 minutes: STALE — unknown, never ok on old news, and it says nobody is signed in there.
    travel(55);
    await boxReports();
    const { o, till } = await observe();
    expect(till.status).toBe('unknown');
    expect(till.detail).toBe(`STALE — till lane-1 last reported its devices 15 min ago (${at(40)}) — nobody is signed in at that till, so it has stopped re-sending (expected when it is closed or unattended): not heard from since, so its devices are not known now`);
    expect(o.observed.boxes.find((b) => b.storeId === 'S1')!.tills[0]).toMatchObject({ reportedAt: at(40), attended: false });
  } finally {
    if (box !== undefined) await box.stop();
    globalThis.fetch = savedFetch;
    await rm(dir, { recursive: true, force: true });
  }
}

describe('P-08 — a quiet but healthy till stays fresh at head office while signed in (in memory)', () => {
  beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); });
  afterAll(() => { vi.useRealTimers(); });

  it('40 quiet minutes signed in: ok every minute; after sign-out + 15 minutes: STALE, saying nobody is signed in', async () => {
    await aQuietHealthyTillStaysFresh(apiHarness(), A);
  }, 120_000);
});

const DATABASE_URL = process.env['DATABASE_URL'];
const PG_TENANT = `e${Date.now().toString(16).slice(-7)}-b902-4bbb-8bbb-${'e'.repeat(12)}`;

describe.skipIf(!DATABASE_URL)('P-08 — a quiet but healthy till stays fresh at head office (real PostgreSQL)', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4, options: '-c app.tenant_id=*' });
    const dir = 'db/migrations';
    await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterAll(async () => { vi.useRealTimers(); await pool.end(); });

  it('the same 40 quiet minutes and the stale after sign-out, on PostgreSQL', async () => {
    const sql = pgPoolClient(pool);
    await aQuietHealthyTillStaysFresh(apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }), PG_TENANT);
  }, 240_000);
});
