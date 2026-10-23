import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { writeSignedPack } from '../../edge/store-edge/src/signed-pack-file';
import { toCloudReturn } from '../../edge/store-edge/src/cloud-return';
import { hmacSigner, publishPack } from '../../services/catalogue/src/index';
import { bootPos } from '../../apps/pos/src/browser-entry';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import { addTillPeople, signInTill, managerApprovesOn, signInAtLane, receiptNumberAt, approvalFromLane, operatorHeader } from '../support/till-operator';
import { startRealCloud, type RealCloud } from '../support/real-store';
import { ownerApprovedSettingOn } from '../support/owner-approved-setting';

/**
 * **M13-FR-02 — a recalled unit returned AT THE TILL is held, never put back for sale: through a REAL store computer, offline
 * (no head office at all), across a COLD RESTART of the box, and on to head office over REAL PostgreSQL.**
 *
 *   • the box holds a signed catalogue whose product is recall-blocked; the till (the real `bootPos`) takes a no-receipt
 *     return of it with "resell": the record on the box's disk says `quarantine` with `recallHeld` — the till's own rule;
 *   • a record posted straight to the box's socket still saying "resell" (an older till) is held by the box itself;
 *   • a product that is NOT recalled is resold as before;
 *   • the box is stopped and started again on the same disk: both records still say quarantine, and what it sends head
 *     office says quarantine;
 *   • on the real stack, head office receives them: the recalled unit is NOT back on the store's shelf (0 on hand), the
 *     fine one is (1).
 * Synthetic data only. The PostgreSQL half needs DATABASE_URL; without it that half SKIPS.
 */

const KEY = ['recall', 'held', 'at', 'the', 'till', 'key'].join('-').padEnd(48, '0');
const LANE = 'lane-1';
const STORE = 'S1';
const CASHIER = 'u-meena';
const MANAGER = 'u-manager';
const RECALLED = 'p-ghee';
const FINE = 'p-dal';

const packFor = (): Record<string, unknown> => ({
  version: 1,
  policies: { storeId: STORE, branchId: STORE, branchName: 'SRE Hyper Market', warehouseId: 'S1-BACK', tradingDayCutoff: '00:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 0 },
  servicePolicy: { returnWindowDays: 30, approvalThresholdMinor: 0, noReceiptCapMinor: 150_000, agentAuthorityMinor: 0, compensationCapMinor: 0 },
  lossPreventionRules: [],
});

const lineOf = (record: Record<string, unknown>): Record<string, unknown> => (record['lines'] as Record<string, unknown>[])[0]!;
const recordsOn = async (edge: EdgeProcess): Promise<Record<string, unknown>[]> =>
  (await readLog(edge.returnsLog.path)).flatMap((r) => (r.ok ? [JSON.parse(r.record) as Record<string, unknown>] : []));

describe('M13-FR-02 — the till and the box hold a recalled unit coming back (offline, cold restart)', () => {
  const dirs: string[] = [];
  const edges: EdgeProcess[] = [];
  afterEach(async () => {
    for (const e of edges.splice(0)) await e.stop();
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  const snapshot = (): CatalogueSnapshot => ({
    tenantId: 't-sre', version: 2, builtAt: new Date().toISOString(),
    products: [
      { productId: RECALLED, sku: 'GHEE', name: 'Ghee 1L', baseUom: 'ea', unitPriceMinor: 64_000, taxBps: 1_200, status: 'active', recallBlock: true },
      { productId: FINE, sku: 'DAL', name: 'Toor dal 1kg', baseUom: 'ea', unitPriceMinor: 10_500, taxBps: 500, status: 'active' },
    ],
    barcodes: [{ code: '8901234567890', productId: RECALLED, kind: 'standard' }, { code: '8901234567891', productId: FINE, kind: 'standard' }],
  });

  const startBox = async (dir: string): Promise<EdgeProcess> => {
    const edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_LANE_ID: LANE, EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: join(dir, 'store-pack.json'),
    }, () => {}))!;
    edges.push(edge);
    return edge;
  };

  it('till → box disk says quarantine for the recalled product, resell for the fine one; a socket "resell" is held by the box; all survives a cold restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-recall-held-'));
    dirs.push(dir);
    const signed = publishPack({ snapshot: snapshot(), approvals: [], signer: hmacSigner(KEY), publishedBy: 'u-hq', publishedAt: new Date().toISOString() });
    if (!signed.ok || signed.pack === undefined) throw new Error(signed.detail);
    await writeSignedPack(dir, signed.pack);
    await writeFile(join(dir, 'store-pack.json'), JSON.stringify(packFor()), 'utf8');
    await addTillPeople(join(dir, 'store-pack.json'), dir, KEY, [{ userId: CASHIER, displayName: 'Meena' }, { userId: MANAGER, displayName: 'Manager', manager: true }]);
    const edge = await startBox(dir);

    // The till, booted exactly as the served page boots it — no head office anywhere.
    const till = bootPos({ laneId: LANE, catalogue: signed.pack.snapshot, lanePort: edge.lane!.port, refundPolicy: { approvalThresholdMinor: 0, noReceiptCapMinor: 150_000 } });
    await signInTill(till, CASHIER);
    const desk = till.noReceiptReturn()!;
    const take = async (returnId: string, productId: string, valueMinor: number) => {
      const approval = await managerApprovesOn(till, MANAGER, { kind: 'no_receipt_return', valueMinor, reason: 'faulty' });
      return desk.submit({
        returnId, number: await till.nextReceipt(), reasonCode: 'faulty', refundMinor: valueMinor, refundTender: 'cash', approval,
        lines: [{ productId, uom: 'ea', quantityMinor: 1, disposition: 'resell' }],
      });
    };
    expect((await take('RT-RECALL', RECALLED, 64_000)).kind).toBe('settled');
    expect((await take('RT-FINE', FINE, 10_500)).kind).toBe('settled');

    // An older till (or a hand-made request) posts "resell" for the recalled product straight to the socket.
    const token = await signInAtLane(edge.lane!.port, CASHIER);
    const approvalId = await approvalFromLane(edge.lane!.port, token, MANAGER, { kind: 'no_receipt_return', valueMinor: 64_000, reason: 'faulty' });
    const res = await fetch(`http://127.0.0.1:${edge.lane!.port}/lane/returns`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...operatorHeader(token) },
      body: JSON.stringify({
        returnId: 'RT-SOCKET', number: await receiptNumberAt(edge.lane!.port, token), originalSaleId: null, noReceipt: true, laneId: LANE,
        processedBy: CASHIER, approvedBy: MANAGER, approvalId, reasonCode: 'faulty', refundMinor: 64_000, currency: 'INR', refundTender: 'cash',
        processedAt: new Date().toISOString(), lines: [{ productId: RECALLED, uom: 'ea', quantityMinor: 1, disposition: 'resell' }],
      }),
    });
    expect(await res.json()).toMatchObject({ committed: true });

    const check = (records: Record<string, unknown>[]): void => {
      const by = new Map(records.map((r) => [r['returnId'] as string, r] as const));
      expect(lineOf(by.get('RT-RECALL')!)).toMatchObject({ productId: RECALLED, disposition: 'quarantine', recallHeld: true, chosenDisposition: 'resell' });
      expect(lineOf(by.get('RT-SOCKET')!)).toMatchObject({ productId: RECALLED, disposition: 'quarantine', recallHeld: true, chosenDisposition: 'resell' });
      expect(lineOf(by.get('RT-FINE')!)).toEqual({ productId: FINE, uom: 'ea', quantityMinor: 1, disposition: 'resell' });
      // What the box sends head office says the same.
      expect(toCloudReturn(by.get('RT-RECALL')).lines[0]?.disposition).toBe('quarantine');
      expect(toCloudReturn(by.get('RT-SOCKET')).lines[0]?.disposition).toBe('quarantine');
    };
    check(await recordsOn(edge));

    // A COLD RESTART of the store computer: the same disk, a new process.
    await edge.stop();
    edges.splice(edges.indexOf(edge), 1);
    const back = await startBox(dir);
    check(await recordsOn(back));
    expect(back.returnsOutbox.unsentCount()).toBe(3);
  }, 60_000);
});

const DATABASE_URL = process.env['DATABASE_URL'];

describe.skipIf(!DATABASE_URL)('M13-FR-02 — on the REAL stack: head office keeps the recalled unit off the shelf (PostgreSQL)', () => {
  let cloud: RealCloud;
  const edges: EdgeProcess[] = [];
  const dirs: string[] = [];
  const OWNER = 'u-owner';
  const BOX = 'u-box';
  const today = new Date().toISOString().slice(0, 10);
  const call = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown, idempotencyKey?: string) =>
    cloud.request({ method, path, userId, ...(body === undefined ? {} : { body }), ...(idempotencyKey === undefined ? {} : { idempotencyKey }) });
  const ok = async (p: Promise<{ status: number; body: unknown }>, expected: number): Promise<Record<string, unknown>> => {
    const r = await p;
    expect(r.status, JSON.stringify(r.body)).toBe(expected);
    return r.body as Record<string, unknown>;
  };
  const onHandAt = async (productId: string, locationId: string): Promise<number> =>
    ((await ok(call('GET', `/v1/inventory/availability?productId=${productId}`, OWNER), 200)) as { rows: { locationId: string; onHandMinor: number }[] })
      .rows.find((r) => r.locationId === locationId)?.onHandMinor ?? 0;

  beforeAll(async () => {
    cloud = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId: randomUUID(), owner: OWNER, packSigningKey: KEY });
    await cloud.grant(MANAGER, 'store_manager');
    await cloud.grant(CASHIER, 'cashier');
    await cloud.grant(BOX, 'store_computer', undefined, [STORE]);
    expect((await ownerApprovedSettingOn(cloud, 'locale.time_zone', { value: 'UTC' }, OWNER)).status).toBe(200); // OB-336
    await ok(call('POST', '/v1/org/nodes/C1', OWNER, { kind: 'company', name: 'SRE Retail' }, 'org-c1'), 201);
    await ok(call('POST', `/v1/org/nodes/${STORE}`, OWNER, { kind: 'branch', name: 'SRE Hyper Market', parentId: 'C1', companyId: 'C1' }, 'org-s1'), 201);
    await ok(call('POST', '/v1/catalogue/tax-classes/0405/rates/2017-07-01', OWNER, { rateBps: 1200 }, 'tax-0405'), 201);
    await ok(call('POST', '/v1/catalogue/tax-classes/0713/rates/2017-07-01', OWNER, { rateBps: 500 }, 'tax-0713'), 201);
    const product = async (id: string, sku: string, name: string, taxClass: string, price: number, code: string, recallBlocked: boolean) => {
      await ok(call('POST', `/v1/catalogue/products/${id}/publish`, OWNER, {
        product: { sku, name, baseUom: 'ea', primaryCategoryId: 'grocery', taxClass, lifecycle: 'active', ...(recallBlocked ? { recallBlocked: true } : {}) },
        categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }],
      }, `publish-${id}`), 201);
      await ok(call('POST', `/v1/prices/list/${id}/entries/e1`, OWNER, {
        scope: 'store', scopeRef: STORE, priceMinor: price, mrpMinor: price, costMinor: Math.floor(price / 2), marginFloorBps: 0, currency: 'INR', effectiveFrom: today,
      }, `price-${id}`), 201);
      await ok(call('POST', `/v1/catalogue/products/${id}/barcodes/${code}`, OWNER, { kind: 'ean' }, `barcode-${id}`), 201);
    };
    await product(RECALLED, 'GHEE', 'Ghee 1L', '0405', 64_000, '8901234567890', true);
    await product(FINE, 'DAL', 'Toor dal 1kg', '0713', 10_500, '8901234567891', false);
    await ok(call('POST', '/v1/catalogue/pack', OWNER, { storeId: STORE, asOf: today }, 'pack-1'), 201);
  }, 60_000);
  afterAll(async () => { await cloud?.stop(); });
  afterEach(async () => {
    for (const e of edges.splice(0)) await e.stop();
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  it('the till holds the recalled unit; after a cold restart the box sends it; head office keeps it off the shelf and re-shelves the fine one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-recall-held-pg-'));
    dirs.push(dir);
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, JSON.stringify(packFor()), 'utf8');
    await addTillPeople(packFile, dir, KEY, [{ userId: CASHIER, displayName: 'Meena' }, { userId: MANAGER, displayName: 'Manager', manager: true }]);
    const env = {
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: cloud.tenantId, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_LANE_ID: LANE, EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile,
      CLOUD_API_URL: cloud.baseUrl, CLOUD_API_TOKEN: cloud.token(BOX),
    };
    const edge = (await startEdge(env, () => {}))!;
    edges.push(edge);
    expect(await edge.refreshPack!()).toMatchObject({ status: 'updated' });
    const html = await (await fetch(`http://127.0.0.1:${edge.screens!.port}/pos/`)).text();
    const catalogue = JSON.parse(/<script>window\.posCatalogue = ([\s\S]*?);<\/script>/.exec(html)![1]!) as CatalogueSnapshot;
    expect(catalogue.products.find((p) => p.productId === RECALLED)?.recallBlock).toBe(true);

    const till = bootPos({ laneId: LANE, catalogue, lanePort: edge.lane!.port, refundPolicy: { approvalThresholdMinor: 0, noReceiptCapMinor: 150_000 } });
    await signInTill(till, CASHIER);
    const desk = till.noReceiptReturn()!;
    for (const [returnId, productId, valueMinor] of [['RT-PG-RECALL', RECALLED, 64_000], ['RT-PG-FINE', FINE, 10_500]] as const) {
      const approval = await managerApprovesOn(till, MANAGER, { kind: 'no_receipt_return', valueMinor, reason: 'faulty' });
      expect((await desk.submit({
        returnId, number: await till.nextReceipt(), reasonCode: 'faulty', refundMinor: valueMinor, refundTender: 'cash', approval,
        lines: [{ productId, uom: 'ea', quantityMinor: 1, disposition: 'resell' }],
      })).kind).toBe('settled');
    }

    // The box goes down before it syncs, and comes back on the same disk (a cold restart), then the line is up.
    await edge.stop();
    edges.splice(0);
    const back = (await startEdge(env, () => {}))!;
    edges.push(back);
    expect(await back.syncOnce!()).toMatchObject({ dead: 0, remaining: 0 });

    expect(await onHandAt(RECALLED, STORE)).toBe(0); // held — never back on the shelf
    expect(await onHandAt(FINE, STORE)).toBe(1);     // resold as before
  }, 90_000);
});
