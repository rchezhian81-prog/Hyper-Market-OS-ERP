import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { Pool } from 'pg';
import { apiHarness, TEST_PACK_KEY, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { startEdge } from '../../edge/store-edge/src/main';
import { hmacSigner, verifyAsLane } from '../../services/catalogue/src/index';
import type { SignedPack } from '../../services/catalogue/src/pack';
import { CatalogueCache, RecalledItemError } from '../../packages/catalogue/src/catalogue';

/**
 * **M10-FR-04 "recall block propagates as priority sync; POS honours cached block" and "owner informed" (Lane 2 · P1) —
 * through the real API and a REAL store computer, in memory and on real PostgreSQL, with a cold restart.**
 *
 * Before this, starting a recall changed nothing at any till until somebody remembered to publish the catalogue, and
 * nobody told the owner. Now starting the recall, by itself:
 *   • publishes the pack the tills already trust with the recalled product blocked — prices, barcodes and build time
 *     byte-for-byte the previous pack's, only the version forward (no buyer's price change rides along);
 *   • the store computer's next pull adopts it; then, with head office unreachable, the till refuses the product by name;
 *   • raises a critical alert into every owner's inbox, acknowledgement due in 15 minutes (roadmap §32);
 * and closing the recall with evidence clears the alert (kept). A cashier cannot start one, and nothing is published.
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
const backings: { name: string; harness: () => ApiHarness; restart: (h: ApiHarness) => ApiHarness }[] = [
  { name: 'the in-memory event store', harness: () => apiHarness(), restart: (h) => apiHarness({ store: h.store }) },
];
if (DATABASE_URL !== undefined) {
  const pg = (): ApiHarness => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); };
  backings.push({ name: 'real PostgreSQL', harness: pg, restart: pg });
}

const STORE = 'store-01';
const AS_OF = '2030-06-01';
const GROCERY = { categoryId: 'grocery', name: 'Grocery', parentId: null };
const PANEER = '8901000000011';
const CURD = '8901000000028';
const signer = hmacSigner(TEST_PACK_KEY);
const TOKEN = ['edge', 'cloud', 'token'].join('-').padEnd(40, 'w');
type Res = { status: number; body: unknown };

interface Started {
  products: string[];
  tillPack: { published: boolean; version: number; newlyBlocked?: string[]; why?: string; detail: string };
  ownerAlert: { raised: boolean; alertId: string; to?: string[]; ackDueBy?: string; why?: string };
}
interface Board { alerts: { alert: { alertId: string; status: string; ownerUserId: string; alsoToUserIds?: string[]; detail: string; raisedAt: string; ackDueBy: string }; state: string }[] }

// A stand-in for the network between the store computer and head office: it forwards the box's catalogue pull to the
// harness, and can be cut, as a cable can.
let cloud: { harness: ApiHarness; tenantId: string; up: boolean } | undefined;
let server: Server;
let baseUrl = '';
beforeAll(async () => {
  server = createServer((req, res) => {
    void (async () => {
      if (cloud === undefined || !cloud.up) { res.writeHead(503); res.end(); return; }
      if (req.method === 'GET' && req.url === '/v1/catalogue/pack') {
        const r = await cloud.harness.request({ method: 'GET', path: '/v1/catalogue/pack', userId: 'u-owner', tenantId: cloud.tenantId });
        res.writeHead(r.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r.body));
        return;
      }
      res.writeHead(404); res.end(); // the box's drains post here; nothing to send in this test
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  baseUrl = typeof addr === 'object' && addr !== null ? `http://127.0.0.1:${addr.port}` : '';
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

describe.each(backings)('M10-FR-04: starting a recall blocks the offline till and tells the owner, by itself — on $name', ({ harness, restart }) => {
  it('recall started → the tills\' pack is published with the block → the box adopts it → cable out, the till refuses; the owners are alerted; closed → alert cleared', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionOwner(T, 'u-owner-2');
    await h.provisionRole(T, 'u-qc', 'store_manager');
    await h.provisionRole(T, 'u-till', 'cashier');
    const req = (method: 'GET' | 'POST', path: string, body?: unknown, userId = 'u-owner'): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    await ok(req('POST', '/v1/catalogue/tax-classes/04061000/rates/2017-07-01', { rateBps: 500 }), 'tax');
    for (const [id, sku, name, code] of [['p-paneer', 'SKU-PANEER', 'Paneer 200g', PANEER], ['p-curd', 'SKU-CURD', 'Curd 400g', CURD]] as const) {
      await ok(req('POST', `/v1/catalogue/products/${id}/publish`, { product: { sku, name, baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '04061000', lifecycle: 'draft' }, categories: [GROCERY] }), `publish ${id}`);
      await ok(req('POST', `/v1/prices/list/${id}/entries/e1`, { scope: 'store', scopeRef: STORE, priceMinor: 9_000, mrpMinor: 9_500, costMinor: 1, marginFloorBps: 0, currency: 'INR', effectiveFrom: '2030-01-01' }), `price ${id}`);
      await ok(req('POST', `/v1/catalogue/products/${id}/barcodes/${code}`, { kind: 'ean' }), `barcode ${id}`);
    }
    for (const [productId, batchId] of [['p-paneer', 'B-0412'], ['p-paneer', 'B-0413'], ['p-curd', 'C-0001']] as const) {
      await ok(req('POST', '/v1/inventory/movements', { movementId: `rx-${batchId}`, productId, locationId: STORE, kind: 'received', quantityMinor: 20, uom: 'EA', occurredAt: '2030-05-01T00:00:00.000Z', enteredBy: 'u-owner', batchId }), `receive ${batchId}`);
    }
    await ok(req('POST', '/v1/catalogue/pack', { storeId: STORE, asOf: AS_OF }), 'publish v1');
    const v1 = (await req('GET', '/v1/catalogue/pack')).body as SignedPack;

    // The store computer, pulling from head office.
    cloud = { harness: h, tenantId: T, up: true };
    const dir = await mkdtemp(join(tmpdir(), 'sre-recall-box-'));
    dirs.push(dir);
    const edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: T, PACK_SIGNING_KEY: TEST_PACK_KEY, EDGE_CAPACITY_BYTES: '10485760', CLOUD_API_URL: baseUrl, CLOUD_API_TOKEN: TOKEN,
    }, () => {}))!;
    try {
      expect((await edge.refreshPack!()).status).toBe('updated');
      expect(new CatalogueCache(edge.node.pack()!.snapshot).scan(PANEER).product.productId).toBe('p-paneer'); // sells before

      // A cashier cannot start a recall — and nothing is published.
      expect((await req('POST', '/v1/quality/recalls/B-0412', { reason: 'x' }, 'u-till')).status).toBe(403);
      expect(((await req('GET', '/v1/catalogue/pack')).body as SignedPack).snapshot.version).toBe(v1.snapshot.version);

      // The quality person starts the recall. Nobody presses publish.
      const started = (await ok(req('POST', '/v1/quality/recalls/B-0412', { reason: 'supplier contamination notice SN-17' }, 'u-qc'), 'recall')).body as Started;
      expect(started.products).toEqual(['p-paneer']);
      expect(started.tillPack).toMatchObject({ published: true, version: v1.snapshot.version + 1, newlyBlocked: ['p-paneer'] });
      const v2 = (await req('GET', '/v1/catalogue/pack')).body as SignedPack;
      expect(v2.snapshot.version).toBe(v1.snapshot.version + 1);
      expect(verifyAsLane(v2, signer)).toBe(true);
      expect(v2.publishedBy).toBe('recall-block:u-qc');
      // Only the block changed: same build time (so the till's "N hours old" stays true), same prices, same barcodes.
      expect(v2.snapshot.builtAt).toBe(v1.snapshot.builtAt);
      expect(v2.snapshot.barcodes).toEqual(v1.snapshot.barcodes);
      expect(v2.snapshot.products.map((p) => [p.productId, p.unitPriceMinor])).toEqual(v1.snapshot.products.map((p) => [p.productId, p.unitPriceMinor]));
      expect(v2.snapshot.products.find((p) => p.productId === 'p-paneer')).toMatchObject({ recallBlock: true, blockedBatches: ['B-0412'] });
      expect(v2.snapshot.products.find((p) => p.productId === 'p-curd')?.recallBlock).not.toBe(true);
      // Head office says the block is on the pack the tills trust.
      const blocks = (await req('GET', '/v1/quality/sale-blocks')).body as { blocks: { state: string }[]; notYetOnPack: number };
      expect(blocks.notYetOnPack).toBe(0);
      expect(blocks.blocks.map((b) => b.state)).toEqual(['on_pack']);

      // The owners are told — every owner, critical, acknowledgement due within 15 minutes.
      expect(started.ownerAlert).toMatchObject({ raised: true, alertId: 'recall:B-0412', to: ['u-owner', 'u-owner-2'] });
      const board = (await ok(req('GET', '/v1/platform/alerts'), 'board')).body as Board;
      const alert = board.alerts.find((a) => a.alert.alertId === 'recall:B-0412')!;
      expect(alert).toMatchObject({ state: 'open', alert: { status: 'down', ownerUserId: 'u-owner', alsoToUserIds: ['u-owner-2'] } });
      expect(Date.parse(alert.alert.ackDueBy) - Date.parse(alert.alert.raisedAt)).toBe(15 * 60_000);
      expect(alert.alert.detail).toMatch(/Batch B-0412 was recalled by u-qc: supplier contamination notice SN-17/);
      expect(alert.alert.detail).toMatch(new RegExp(`catalogue v${v2.snapshot.version} now refuses it`));
      for (const owner of ['u-owner', 'u-owner-2']) {
        const inbox = (await ok(req('GET', '/v1/platform/alerts/inbox', undefined, owner), `inbox ${owner}`)).body as { alerts: { alert: { alertId: string } }[] };
        expect(inbox.alerts.map((a) => a.alert.alertId)).toContain('recall:B-0412');
      }

      // The box's next pull adopts it; then the cable comes out and the till refuses paneer by name — curd still sells.
      expect((await edge.refreshPack!()).status).toBe('updated');
      cloud.up = false;
      expect((await edge.refreshPack!()).status).toBe('offline');
      const lane = new CatalogueCache(edge.node.pack()!.snapshot);
      expect(edge.node.pack()!.snapshot.version).toBe(v2.snapshot.version);
      expect(() => lane.scan(PANEER)).toThrow(RecalledItemError);
      expect(() => lane.scan(PANEER)).toThrow(/Paneer 200g/);
      expect(lane.scan(CURD).product.productId).toBe('p-curd');
    } finally {
      await edge.stop();
    }

    // Started again while open: one effect — no second pack, no second alert.
    const again = (await ok(req('POST', '/v1/quality/recalls/B-0412', { reason: 'again' }, 'u-qc'), 'again')).body as { alreadyOpen: boolean };
    expect(again.alreadyOpen).toBe(true);

    h = restart(h); // ── COLD RESTART: the pack and the alert are what was stored ──
    const v2Stored = (await req('GET', '/v1/catalogue/pack')).body as SignedPack;
    expect(v2Stored.snapshot.version).toBe(v1.snapshot.version + 1);
    let board = (await ok(req('GET', '/v1/platform/alerts'), 'board after restart')).body as Board;
    expect(board.alerts.filter((a) => a.alert.alertId === 'recall:B-0412').map((a) => a.state)).toEqual(['open']);

    // Closed with evidence: the owners' alert clears (kept, with its history).
    const closed = (await ok(req('POST', '/v1/quality/recalls/B-0412/closure', { evidenceRef: 'DOC-recall-B-0412' }, 'u-qc'), 'close')).body as { ownerAlertCleared: boolean };
    expect(closed.ownerAlertCleared).toBe(true);
    board = (await ok(req('GET', '/v1/platform/alerts'), 'board after close')).body as Board;
    expect(board.alerts.find((a) => a.alert.alertId === 'recall:B-0412')?.state ?? 'cleared').toBe('cleared');
  }, 120_000);

  it('says so when it cannot block: no pack published yet, or a batch head office cannot name to a product', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    const req = (method: 'GET' | 'POST', path: string, body?: unknown): Promise<Res> =>
      h.request({ method, path, userId: 'u-owner', tenantId: T, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }) });
    await req('POST', '/v1/inventory/movements', { movementId: 'rx-1', productId: 'p-x', locationId: STORE, kind: 'received', quantityMinor: 5, uom: 'EA', occurredAt: '2030-05-01T00:00:00.000Z', enteredBy: 'u-owner', batchId: 'X-1' });
    const noPack = (await req('POST', '/v1/quality/recalls/X-1', { reason: 'notice' })).body as Started;
    expect(noPack.tillPack).toMatchObject({ published: false, why: 'no_pack_published_yet' });
    expect(noPack.ownerAlert.raised).toBe(true);
    const unknown = (await req('POST', '/v1/quality/recalls/NOBODY-KNOWS', { reason: 'FSSAI notice' })).body as Started;
    expect(unknown.products).toEqual([]);
    expect(unknown.tillPack).toMatchObject({ published: false, why: 'no_pack_published_yet' });
    const board = (await req('GET', '/v1/platform/alerts')).body as Board;
    expect(board.alerts.find((a) => a.alert.alertId === 'recall:NOBODY-KNOWS')!.alert.detail).toMatch(/cannot name its product/);
  });
});
