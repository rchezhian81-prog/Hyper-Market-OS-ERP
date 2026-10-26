import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, TEST_IDP, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore, type HttpRequest } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { WarehouseSession, type WarehouseAssignment } from '../../apps/warehouse-app/src/warehouse-session';
import type { BoxItemStatus, DeviceAck } from '../../packages/sync/src/device-relay';

/**
 * **WF-08 "timeout" on the PHONE-TO-STORE-COMPUTER leg (§26 · §31 · P-01 · hard rule #10).** A planned count is taken on
 * the warehouse phone and handed to the REAL store computer (`startEdge`). The store computer keeps it — but its reply to
 * the phone is LOST (the Wi-Fi drops as it answers), so the phone still holds the count as unsent and sends it again. The
 * store computer recognises it ("duplicate", never a second copy), the phone then marks it done, and head office records
 * ONE count under the plan when the box syncs. In memory and, with DATABASE_URL, on real PostgreSQL.
 */

const KEY = ['planned', 'count', 'phone', 'signing', 'key'].join('-').padEnd(48, '0');
const STORE = 'S1';
const PACK_JSON = JSON.stringify({ version: 1, policies: { tradingDayCutoff: '02:00', storeId: STORE, branchId: STORE }, lossPreventionRules: [] });
type Body = Record<string, unknown>;

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 4, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });
const backings: { name: string; harness: () => ApiHarness }[] = [{ name: 'the in-memory event store', harness: () => apiHarness() }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });

const cleanups: Array<() => Promise<void>> = [];
const savedFetch = globalThis.fetch;
afterEach(async () => {
  globalThis.fetch = savedFetch;
  for (const c of cleanups.splice(0).reverse()) await c();
});

const ASSIGNMENT: WarehouseAssignment = {
  assignmentId: 'A-1', workerId: 'u-worker', storeId: STORE, bins: [],
  barcodes: [{ barcode: '890P1', productId: 'P1', level: 'unit' }, { barcode: '890P2', productId: 'P2', level: 'unit' }, { barcode: '890P3', productId: 'P3', level: 'unit' }],
  packs: ['P1', 'P2', 'P3'].map((p) => ({ productId: p, baseUom: 'EA', levels: [{ level: 'unit' as const, containsMinor: 1, barcode: `890${p}` }] })),
};

describe.each(backings)('a count sent from the phone whose reply is lost is counted once — on $name (WF-08 timeout)', ({ harness }) => {
  it('phone → box, the box\'s reply lost → the phone sends again → "duplicate" on the box → one count at head office', async () => {
    const h = harness();
    const t = randomUUID();
    const post = (u: string, path: string, body: Body, key: string) => h.request({ method: 'POST', path, userId: u, tenantId: t, idempotencyKey: key, body });
    const get = (u: string, path: string, query?: Record<string, string>) => h.request({ method: 'GET', path, userId: u, tenantId: t, ...(query === undefined ? {} : { query }) });
    await h.seedOwner(t, 'u-owner');
    for (const u of ['u-plan', 'u-worker', 'u-appr']) await h.provisionRole(t, u, 'store_manager');
    await h.provisionRole(t, 'u-box', 'store_computer', [STORE]); // OB-54: a store computer's credential names its store
    expect((await post('u-owner', '/v1/org/nodes/C1', { kind: 'company', name: 'SRE Retail' }, 'c1')).status).toBe(201);
    expect((await post('u-owner', `/v1/org/nodes/${STORE}`, { kind: 'branch', name: 'Store 1', parentId: 'C1', companyId: 'C1' }, 's1')).status).toBe(201);
    for (const [p, q] of [['P1', 100], ['P2', 40], ['P3', 10]] as const) {
      expect((await post('u-owner', '/v1/inventory/movements', { movementId: `seed-${p}`, productId: p, locationId: STORE, kind: 'received', quantityMinor: q, uom: 'EA', occurredAt: '2026-08-01T00:00:00.000Z', enteredBy: 'u-owner', unitCostMinor: 100 }, `seed-${p}`)).status).toBe(202);
    }
    expect((await post('u-plan', '/v1/inventory/count-plans/cp-ph', { locationId: STORE, productIds: ['P1', 'P2'], frozenKinds: ['received'], recountThresholdMinor: 10_000 }, 'plan')).status).toBe(201);
    expect((await post('u-plan', '/v1/inventory/count-plans/cp-ph/open', {}, 'open')).status).toBe(200);

    // The real cloud behind a fetch the test can cut, or make lose a reply; a real box pointed at it.
    const dir = await mkdtemp(join(tmpdir(), 'sre-planned-count-'));
    cleanups.push(async () => { await rm(dir, { recursive: true, force: true }); });
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, PACK_JSON, 'utf8');
    let online = true;
    let lose = false;
    globalThis.fetch = (async (url: string, init: RequestInit): Promise<Response> => {
      if (url.startsWith('http://127.0.0.1:')) return savedFetch(url, init);
      if (!online) throw new Error('ENETUNREACH');
      const hdr = (init.headers ?? {}) as Record<string, string>;
      const res = await h.raw({
        method: (init.method ?? 'GET') as HttpRequest['method'], path: new URL(url).pathname,
        token: hdr['authorization']?.replace(/^Bearer /, ''), idempotencyKey: hdr['idempotency-key'],
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
      });
      if (lose) { lose = false; throw new Error('ECONNRESET'); }
      return new Response(JSON.stringify(res.body), { status: res.status });
    }) as unknown as typeof globalThis.fetch;
    const start = async (): Promise<EdgeProcess> => {
      const edge = (await startEdge({
        EDGE_DATA_DIR: dir, EDGE_TENANT_ID: t, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
        CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box', tenantId: t, branchId: STORE }), EDGE_PACK_FILE: packFile,
      }, () => {}))!;
      cleanups.push(async () => { await edge.stop(); });
      return edge;
    };
    const hand = async (edge: EdgeProcess, outbox: SyncOutbox, key: string): Promise<DeviceAck | undefined> => {
      const item = outbox.find(key)!;
      const res = await savedFetch(`http://127.0.0.1:${edge.lane!.port}/lane/outbox`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:8091' },
        body: JSON.stringify({ source: 'warehouse', items: [{ key: item.event.idempotencyKey, event: item.event }] }),
      });
      return ((await res.json()) as { acks: DeviceAck[] }).acks[0];
    };
    const statusOf = async (edge: EdgeProcess, keys: string[]): Promise<BoxItemStatus[]> =>
      ((await (await savedFetch(`http://127.0.0.1:${edge.lane!.port}/lane/outbox/status?keys=${encodeURIComponent(keys.join(','))}`)).json()) as { items: BoxItemStatus[] }).items;
    const plan = async () => (await get('u-plan', '/v1/inventory/count-plans/cp-ph')).body as { lines: { productId: string; state: string; varianceMinor: number; counts: { countId: string; counterId: string; relayedBy?: string; source?: string; expectedMinor: number; countedAt?: string }[] }[] };

    // 1. The phone counts P1 and hands it to the store computer — which KEEPS it, but its reply never reaches the phone.
    const outbox = new SyncOutbox();
    const phone = new WarehouseSession(ASSIGNMENT, outbox, { now: () => '2026-10-10T09:00:00.000Z' });
    expect(phone.countForPlan({ countId: 'ph-1', planId: 'cp-ph', scannedItem: '890P1', countedMinor: 97, at: '2026-10-10T09:00:00.000Z' })).toMatchObject({ accepted: true, productId: 'P1' });
    online = false; // head office is unreachable too, so the box holds it
    const edge = await start();
    await hand(edge, outbox, 'count-ph-1'); // the box answers "accepted" — the answer is lost on the way to the phone
    expect(outbox.find('count-ph-1')?.state).toBe('pending'); // the phone never heard it, so it still holds it unsent
    expect((await statusOf(edge, ['count-ph-1']))[0]).toMatchObject({ state: 'pending' });

    // 2. The phone sends it again: the box says "duplicate" — it already has it — and keeps ONE copy. The phone marks it done.
    const again = await hand(edge, outbox, 'count-ph-1');
    expect(again?.status).toBe('duplicate');
    outbox.acknowledge('count-ph-1');
    expect(outbox.find('count-ph-1')?.state).toBe('acknowledged');
    expect((await statusOf(edge, ['count-ph-1']))).toHaveLength(1);

    // 3. The line returns: the box syncs once, and head office records ONE count under the plan, in the worker's name.
    online = true;
    expect((await edge.syncOnce!()).sent).toBe(1);
    expect((await statusOf(edge, ['count-ph-1']))[0]?.state).toBe('posted');
    const p1 = (await plan()).lines.find((l) => l.productId === 'P1')!;
    expect(p1.counts).toHaveLength(1);
    expect(p1.counts[0]).toMatchObject({ countId: 'ph-1', counterId: 'u-worker', relayedBy: 'u-box', expectedMinor: 100 });
    expect(p1).toMatchObject({ varianceMinor: -3 });
    // A third send (a phone restored from an old copy) is still a duplicate, and nothing more reaches head office.
    expect((await hand(edge, outbox, 'count-ph-1'))?.status).toBe('duplicate');
    expect((await edge.syncOnce!()).sent).toBe(0);
    expect((await plan()).lines.find((l) => l.productId === 'P1')!.counts).toHaveLength(1);
    expect(lose).toBe(false);
  }, 60_000);
});
