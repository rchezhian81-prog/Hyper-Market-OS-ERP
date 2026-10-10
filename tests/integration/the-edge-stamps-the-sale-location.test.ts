import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiHarness, TEST_IDP, type ApiHarness } from '../support/api-harness';
import type { HttpRequest } from '../../services/kernel/src/index';
import { startEdge } from '../../edge/store-edge/src/main';
import { STREAM } from '../../services/api/src/adapters';

/**
 * **A sale rung on the box leaves stock from THIS store — the edge stamps the sale's location (Stage D slice 2 ·
 * M08-FR-01 · Stage A follow-on (b) · P-08).**
 *
 * Stage A made every banked sale a `sold` movement. But the till's disk record names no location, so the cloud
 * had to fall back: to the store its catalogue pack was published for, or — on a pack with no scope — to the
 * LANE, with a reason on the movement saying it was assumed. On the hosted demo that is why a till sale did not
 * visibly move on-hand at the shop: the movement landed against "lane-1", a location nobody stocks.
 *
 * Now the store box knows which store it is (its store pack's `policies.storeId`) and stamps that as the sale's
 * `locationId` on the way to the cloud — for a sale rung live AND for one re-queued after a restart. The cloud
 * then draws stock from the store the box belongs to, `declared_by_lane`, with no assumption to explain. A box
 * with no store pack changes nothing: the cloud's fallback stands, and still says so.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaad2';
const KEY = ['edge', 'location', 'pack', 'signing', 'key'].join('-').padEnd(48, '0');
const OWNER = 'u-owner'; const SYNC = 'u-sync';
const STORE = 'store-tirunelveli';
const AT = new Date(Date.now() - 60_000).toISOString();

const saleRecord = (saleId: string, qty: number) => JSON.stringify({
  id: saleId, number: `R-${saleId}`, laneId: 'lane-1', cashierId: 'cashier-anita',
  tradingDay: AT.slice(0, 10), committedAt: AT, total: qty * 2500, currency: 'INR',
  lines: [{ productId: 'MILK', quantityMinor: qty, uom: 'each', unitPriceMinor: 2500, lineTotalMinor: qty * 2500 }],
  tenders: [{ kind: 'cash', amount: { minor: qty * 2500, currency: 'INR' } }],
});

interface Movement { movementId: string; kind: string; locationId: string; quantityMinor: number; reason?: string }
const movementsOf = async (h: ApiHarness, saleId: string): Promise<Movement[]> =>
  (await h.store.readStream(A, STREAM.inventory, { type: 'InventoryMoved' }))
    .map((e) => e.event.payload as Movement)
    .filter((m) => m.movementId.startsWith(`sale-${saleId}-`));
const onHand = async (h: ApiHarness, locationId: string): Promise<number | undefined> =>
  ((await h.request({ method: 'GET', path: '/v1/inventory/availability', userId: OWNER, tenantId: A, query: { productId: 'MILK' } })).body as { rows: { locationId: string; onHandMinor: number }[] })
    .rows.find((r) => r.locationId === locationId)?.onHandMinor;

describe('the edge stamps the sale\'s stock location from its store pack (Stage D slice 2, M08-FR-01)', () => {
  let h: ApiHarness;
  let dir: string;
  let packFile: string;
  const savedFetch = globalThis.fetch;

  beforeAll(async () => {
    h = apiHarness();
    await h.seedOwner(A, OWNER);
    await h.provisionRole(A, SYNC, 'store_computer'); // the box's sync identity
    // The shop received 30 MILK at ITS store — the location the till's sales must draw from.
    expect((await h.request({
      method: 'POST', path: '/v1/inventory/movements', userId: OWNER, tenantId: A, idempotencyKey: 'mv-1',
      body: { movementId: 'recv-1', productId: 'MILK', locationId: STORE, kind: 'received', quantityMinor: 30, unitCostMinor: 2000, uom: 'each', occurredAt: AT, enteredBy: OWNER },
    })).status).toBeLessThan(300);

    globalThis.fetch = (async (url: string, init: RequestInit): Promise<Response> => {
      const hdr = (init.headers ?? {}) as Record<string, string>;
      const res = await h.raw({
        method: (init.method ?? 'GET') as HttpRequest['method'],
        path: new URL(url).pathname,
        token: hdr['authorization']?.replace(/^Bearer /, ''),
        idempotencyKey: hdr['idempotency-key'],
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
      });
      return new Response(JSON.stringify(res.body), { status: res.status });
    }) as unknown as typeof globalThis.fetch;

    dir = await mkdtemp(join(tmpdir(), 'sre-edge-location-'));
    packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, JSON.stringify({ version: 3, policies: { storeId: STORE, branchId: null, branchName: 'Tirunelveli', tradingDayCutoff: '02:00' } }), 'utf8');
  });

  afterAll(async () => {
    globalThis.fetch = savedFetch;
    await rm(dir, { recursive: true, force: true });
  });

  const env = (withPack: boolean, dataDir = dir) => ({
    EDGE_DATA_DIR: dataDir, EDGE_TENANT_ID: A, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
    CLOUD_API_URL: 'https://cloud.example.test',
    CLOUD_API_TOKEN: TEST_IDP.issue({ sub: SYNC, tenantId: A }),
    ...(withPack ? { EDGE_PACK_FILE: packFile } : {}),
  });

  it('a sale rung live carries the box\'s store as its location: the cloud draws stock from THAT store, declared, with nothing assumed', async () => {
    const edge = (await startEdge(env(true), () => {}))!;
    try {
      expect((await edge.node.commit('S-1', saleRecord('S-1', 4))).committed).toBe(true);
      const pass = await edge.syncOnce!();
      expect(pass.sent).toBe(1);
      expect(pass.dead).toBe(0);
    } finally {
      await edge.stop();
    }
    const moves = await movementsOf(h, 'S-1');
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ kind: 'sold', locationId: STORE, quantityMinor: 4 });
    expect(moves[0]?.reason).toBeUndefined(); // declared by the lane — no assumption to explain
    expect(await onHand(h, STORE)).toBe(26);
  });

  it('a sale re-queued after a restart is stamped the same way — the restore reads the store pack too', async () => {
    // Ring with NO cloud (nothing sent), then restart WITH the cloud: the re-queue carries the store.
    const offline = (await startEdge({ ...env(true), CLOUD_API_URL: undefined, CLOUD_API_TOKEN: undefined } as Record<string, string | undefined>, () => {}))!;
    try {
      expect((await offline.node.commit('S-2', saleRecord('S-2', 6))).committed).toBe(true);
    } finally {
      await offline.stop();
    }
    const restarted = (await startEdge(env(true), () => {}))!;
    try {
      const pass = await restarted.syncOnce!();
      expect(pass.dead).toBe(0);
    } finally {
      await restarted.stop();
    }
    const moves = await movementsOf(h, 'S-2');
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ locationId: STORE, quantityMinor: 6 });
    expect(moves[0]?.reason).toBeUndefined();
    expect(await onHand(h, STORE)).toBe(20);
  });

  it('a box with NO store pack changes nothing: the cloud still falls back to the lane and SAYS it assumed (P-08)', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'sre-edge-nolocation-'));
    try {
      const edge = (await startEdge(env(false, bare), () => {}))!;
      try {
        expect((await edge.node.commit('S-3', saleRecord('S-3', 1))).committed).toBe(true);
        expect((await edge.syncOnce!()).dead).toBe(0);
      } finally {
        await edge.stop();
      }
      const moves = await movementsOf(h, 'S-3');
      expect(moves).toHaveLength(1);
      expect(moves[0]?.locationId).toBe('lane-1');
      expect(moves[0]?.reason).toContain('assumed from lane');
      expect(await onHand(h, STORE)).toBe(20); // the shop's own count untouched by a sale it could not place
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});
