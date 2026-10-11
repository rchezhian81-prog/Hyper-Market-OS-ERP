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
 * **WF-08 on the warehouse phone (round 8 · M09-FR-04 · §31 · P-01 · hard rules #6 #10).** A count under a head-office count
 * plan is taken on the phone (`WarehouseSession.countForPlan`), handed to the REAL store computer (`startEdge`), kept there
 * while head office is unreachable and across a box restart, and relayed under the store's own sync credential on the
 * EXISTING count route (`StockCounted` → `/v1/inventory/counts/:countId/synced`) — which records it under its plan with
 * head office's expected figure AS OF the moment counted and holds the variance for the plan. A reply lost on the way back
 * settles to ONE record; a re-sent count is `duplicate`; a count of a product not on the plan is a visible refusal on the box.
 * The count then completes the plan like any other line. In memory and, with DATABASE_URL, on real PostgreSQL.
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

describe.each(backings)('a planned count on the warehouse phone reaches head office through the box — on $name (WF-08 · §31)', ({ harness }) => {
  it('phone → box (kept offline, across a restart) → head office once, held for the plan → approved and on the ledger', async () => {
    const h = harness();
    const t = randomUUID();
    const post = (u: string, path: string, body: Body, key: string) => h.request({ method: 'POST', path, userId: u, tenantId: t, idempotencyKey: key, body });
    const get = (u: string, path: string, query?: Record<string, string>) => h.request({ method: 'GET', path, userId: u, tenantId: t, ...(query === undefined ? {} : { query }) });
    await h.seedOwner(t, 'u-owner');
    for (const u of ['u-plan', 'u-worker', 'u-appr']) await h.provisionRole(t, u, 'store_manager');
    await h.provisionRole(t, 'u-box', 'store_computer');
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
        CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box', tenantId: t }), EDGE_PACK_FILE: packFile,
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

    // 1. The phone counts P1 BLIND; head office is unreachable. The box keeps it — before the phone hears accepted.
    const outbox = new SyncOutbox();
    const phone = new WarehouseSession(ASSIGNMENT, outbox, { now: () => '2026-10-10T09:00:00.000Z' });
    const counted = phone.countForPlan({ countId: 'ph-1', planId: 'cp-ph', scannedItem: '890P1', countedMinor: 96, at: '2026-10-10T09:00:00.000Z' });
    expect(counted).toMatchObject({ accepted: true, productId: 'P1' });
    expect(JSON.stringify(counted)).not.toMatch(/100|expected|variance/i);
    expect(phone.countForPlan({ countId: 'ph-x', planId: '', scannedItem: '890P1', countedMinor: 1, at: '2026-10-10T09:00:00.000Z' }).signal.code).toBe('no_plan');
    online = false;
    let edge = await start();
    expect((await hand(edge, outbox, 'count-ph-1'))?.status).toBe('accepted');
    expect((await edge.syncOnce!()).sent).toBe(0);
    expect((await statusOf(edge, ['count-ph-1']))[0]).toMatchObject({ state: 'pending' });
    expect((await plan()).lines.find((l) => l.productId === 'P1')?.state).toBe('not_counted');
    // The box restarts while still offline: the count is still on it.
    await edge.stop();
    cleanups.pop();
    edge = await start();
    expect((await statusOf(edge, ['count-ph-1']))[0]).toMatchObject({ state: 'pending' });

    // 2. The line returns; the reply is lost on the way back — head office DID record it, once, under the plan.
    online = true;
    lose = true;
    expect((await edge.syncOnce!()).sent).toBe(0);
    let p1 = (await plan()).lines.find((l) => l.productId === 'P1')!;
    expect(p1).toMatchObject({ state: 'cause_required', varianceMinor: -4 });
    expect(p1.counts).toHaveLength(1);
    expect(p1.counts[0]).toMatchObject({ countId: 'ph-1', counterId: 'u-worker', relayedBy: 'u-box', source: 'warehouse-handheld', expectedMinor: 100, countedAt: '2026-10-10T09:00:00.000Z' });
    // The retry hears "already recorded": posted, one record. A re-sent count is a duplicate on the box.
    expect((await edge.syncOnce!()).sent).toBe(1);
    expect((await statusOf(edge, ['count-ph-1']))[0]?.state).toBe('posted');
    expect((await hand(edge, outbox, 'count-ph-1'))?.status).toBe('duplicate');
    p1 = (await plan()).lines.find((l) => l.productId === 'P1')!;
    expect(p1.counts).toHaveLength(1);
    // Nothing moved on the ledger: the variance waits for the plan.
    const onHand = async (p: string) => ((await get('u-owner', '/v1/inventory/availability', { productId: p })).body as { rows: { onHandMinor: number }[] }).rows.reduce((s, r) => s + r.onHandMinor, 0);
    expect(await onHand('P1')).toBe(100);

    // 3. A count of a product NOT on the plan is head office's refusal → a visible refusal on the box, kept, moving nothing.
    phone.countForPlan({ countId: 'ph-3', planId: 'cp-ph', scannedItem: '890P3', countedMinor: 9, at: '2026-10-10T09:05:00.000Z' });
    await hand(edge, outbox, 'count-ph-3');
    await edge.syncOnce!();
    const refused = (await statusOf(edge, ['count-ph-3']))[0];
    expect(refused?.state).toBe('refused');
    expect(refused?.reason).toMatch(/not_in_this_plan/);
    expect(await onHand('P3')).toBe(10);

    // 4. P2 matches; the plan completes like any other: a cause, one approval by someone who counted nothing, one movement.
    phone.countForPlan({ countId: 'ph-2', planId: 'cp-ph', scannedItem: '890P2', countedMinor: 40, at: '2026-10-10T09:10:00.000Z' });
    await hand(edge, outbox, 'count-ph-2');
    expect((await edge.syncOnce!()).sent).toBe(1);
    expect((await post('u-plan', '/v1/inventory/count-plans/cp-ph/counts/ph-1/cause', { causeCode: 'theft_suspected', note: 'four packs short on the end cap' }, 'cause')).status).toBe(201);
    expect((await post('u-worker', '/v1/inventory/count-plans/cp-ph/approve', { reason: 'mine' }, 'self')).status).toBe(422);
    const approved = await post('u-appr', '/v1/inventory/count-plans/cp-ph/approve', { reason: 'accepted' }, 'appr');
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ lossMinor: 400, gainMinor: 0, posted: [{ countId: 'ph-1', movementId: 'count:ph-1' }] });
    expect([await onHand('P1'), await onHand('P2')]).toEqual([96, 40]);
  }, 60_000);
});
