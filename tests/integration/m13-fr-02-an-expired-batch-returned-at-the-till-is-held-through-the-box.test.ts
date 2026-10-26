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
 * **M13-FR-02 — a unit of an EXPIRED batch returned AT THE TILL is held, never put back for sale: from the signed pack's
 * expired-batch set (the M10-FR-01 expiry move's facts), through a REAL store computer, offline, across a COLD RESTART of
 * the box, and on to head office over REAL PostgreSQL.**
 *
 *   • the box holds a signed pack whose curd has batch B-OLD expired; the till (the real `bootPos`) takes no-receipt
 *     returns of B-OLD and of the fresh B-NEW, both "resell": B-OLD is on the box's disk as `quarantine` + `expiredHeld`,
 *     the cashier is told to put it in the held bin; B-NEW is resold;
 *   • a record posted straight to the box's socket still saying "resell" for B-OLD is held by the box itself;
 *   • the box is stopped and started again on the same disk: the records still say so, and what it sends says quarantine;
 *   • on the real stack: head office receives two batches, its expiry move puts B-OLD on the tills' pack, the box takes
 *     that pack, the till holds B-OLD, the box restarts cold and syncs — head office's on-hand rises by ONE (B-NEW only).
 * Synthetic data only. The PostgreSQL half needs DATABASE_URL; without it that half SKIPS.
 */

const KEY = ['expired', 'held', 'at', 'the', 'till', 'key'].join('-').padEnd(48, '0');
const LANE = 'lane-1';
const STORE = 'S1';
const CASHIER = 'u-meena';
const MANAGER = 'u-manager';
const CURD = 'p-curd';
const day = (offsetDays: number): string => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

const packFor = (): Record<string, unknown> => ({
  version: 1,
  policies: { timeZone: 'UTC', storeId: STORE, branchId: STORE, branchName: 'SRE Hyper Market', warehouseId: 'S1-BACK', tradingDayCutoff: '00:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 0 },
  servicePolicy: { returnWindowDays: 30, approvalThresholdMinor: 0, noReceiptCapMinor: 150_000, agentAuthorityMinor: 0, compensationCapMinor: 0 },
  lossPreventionRules: [],
});

const lineOf = (record: Record<string, unknown>): Record<string, unknown> => (record['lines'] as Record<string, unknown>[])[0]!;
const recordsOn = async (edge: EdgeProcess): Promise<Record<string, unknown>[]> =>
  (await readLog(edge.returnsLog.path)).flatMap((r) => (r.ok ? [JSON.parse(r.record) as Record<string, unknown>] : []));

/** No-receipt returns of one unit each at the real till, through its own desk (manager approves at the lane). */
const returnsAt = async (till: ReturnType<typeof bootPos>, items: readonly (readonly [string, string])[]) => {
  const desk = till.noReceiptReturn()!;
  const out = [];
  for (const [returnId, batchId] of items) {
    const approval = await managerApprovesOn(till, MANAGER, { kind: 'no_receipt_return', valueMinor: 6_000, reason: 'changed_mind' });
    out.push(await desk.submit({
      returnId, number: await till.nextReceipt(), reasonCode: 'changed_mind', refundMinor: 6_000, refundTender: 'cash', approval,
      lines: [{ productId: CURD, uom: 'ea', quantityMinor: 1, disposition: 'resell', batchId }],
    }));
  }
  return out;
};

describe('M13-FR-02 — the till and the box hold an expired batch coming back (offline, cold restart)', () => {
  const dirs: string[] = [];
  const edges: EdgeProcess[] = [];
  afterEach(async () => {
    for (const e of edges.splice(0)) await e.stop();
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  const snapshot = (): CatalogueSnapshot => ({
    tenantId: 't-sre', version: 2, builtAt: new Date().toISOString(),
    products: [{ productId: CURD, sku: 'CURD', name: 'Curd 400g', baseUom: 'ea', unitPriceMinor: 6_000, taxBps: 500, status: 'active', expiredBatches: [{ batchId: 'B-OLD', expiry: day(-2) }] }],
    barcodes: [{ code: '8901000000026', productId: CURD, kind: 'standard' }],
  });
  const startBox = async (dir: string): Promise<EdgeProcess> => {
    const edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_LANE_ID: LANE, EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: join(dir, 'store-pack.json'),
    }, () => {}))!;
    edges.push(edge);
    return edge;
  };

  it('till → box disk: B-OLD quarantine + expiredHeld, B-NEW resell; a socket "resell" is held by the box; all survives a cold restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-expired-held-'));
    dirs.push(dir);
    const signed = publishPack({ snapshot: snapshot(), approvals: [], signer: hmacSigner(KEY), publishedBy: 'u-hq', publishedAt: new Date().toISOString() });
    if (!signed.ok || signed.pack === undefined) throw new Error(signed.detail);
    await writeSignedPack(dir, signed.pack);
    await writeFile(join(dir, 'store-pack.json'), JSON.stringify(packFor()), 'utf8');
    await addTillPeople(join(dir, 'store-pack.json'), dir, KEY, [{ userId: CASHIER, displayName: 'Meena' }, { userId: MANAGER, displayName: 'Manager', manager: true }]);
    const edge = await startBox(dir);

    // The till, booted as the served page boots it — no head office anywhere.
    const till = bootPos({ laneId: LANE, catalogue: signed.pack.snapshot, lanePort: edge.lane!.port, refundPolicy: { approvalThresholdMinor: 0, noReceiptCapMinor: 150_000 } });
    await signInTill(till, CASHIER);
    const [old, fresh] = await returnsAt(till, [['RT-OLD', 'B-OLD'], ['RT-NEW', 'B-NEW']]);
    expect(old).toMatchObject({ kind: 'settled', held: { recall: 0, expired: 1 } }); // paid, and the cashier is told
    expect(fresh?.kind).toBe('settled');
    expect(fresh && 'held' in fresh ? fresh.held : undefined).toBeUndefined();

    // An older till (or a hand-made request) posts "resell" for B-OLD straight to the socket.
    const token = await signInAtLane(edge.lane!.port, CASHIER);
    const approvalId = await approvalFromLane(edge.lane!.port, token, MANAGER, { kind: 'no_receipt_return', valueMinor: 6_000, reason: 'changed_mind' });
    const res = await fetch(`http://127.0.0.1:${edge.lane!.port}/lane/returns`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...operatorHeader(token) },
      body: JSON.stringify({
        returnId: 'RT-SOCKET', number: await receiptNumberAt(edge.lane!.port, token), originalSaleId: null, noReceipt: true, laneId: LANE,
        processedBy: CASHIER, approvedBy: MANAGER, approvalId, reasonCode: 'changed_mind', refundMinor: 6_000, currency: 'INR', refundTender: 'cash',
        processedAt: new Date().toISOString(), lines: [{ productId: CURD, uom: 'ea', quantityMinor: 1, disposition: 'resell', batchId: 'B-OLD' }],
      }),
    });
    expect(await res.json()).toMatchObject({ committed: true });

    const check = (records: Record<string, unknown>[]): void => {
      const by = new Map(records.map((r) => [r['returnId'] as string, r] as const));
      expect(lineOf(by.get('RT-OLD')!)).toMatchObject({ batchId: 'B-OLD', disposition: 'quarantine', expiredHeld: true, chosenDisposition: 'resell' });
      expect(lineOf(by.get('RT-SOCKET')!)).toMatchObject({ batchId: 'B-OLD', disposition: 'quarantine', expiredHeld: true, chosenDisposition: 'resell' });
      expect(lineOf(by.get('RT-NEW')!)).toEqual({ productId: CURD, uom: 'ea', quantityMinor: 1, disposition: 'resell', batchId: 'B-NEW' });
      expect(toCloudReturn(by.get('RT-OLD')).lines[0]?.disposition).toBe('quarantine');
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

describe.skipIf(!DATABASE_URL)('M13-FR-02 — on the REAL stack: head office\'s expiry move reaches the till, and the expired unit stays off the shelf (PostgreSQL)', () => {
  let cloud: RealCloud;
  const edges: EdgeProcess[] = [];
  const dirs: string[] = [];
  const OWNER = 'u-owner';
  const BOX = 'u-box';
  const call = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown, idempotencyKey?: string) =>
    cloud.request({ method, path, userId, ...(body === undefined ? {} : { body }), ...(idempotencyKey === undefined ? {} : { idempotencyKey }) });
  const ok = async (p: Promise<{ status: number; body: unknown }>, expected: number): Promise<Record<string, unknown>> => {
    const r = await p;
    expect(r.status, JSON.stringify(r.body)).toBe(expected);
    return r.body as Record<string, unknown>;
  };
  const onHandAt = async (locationId: string): Promise<number> =>
    ((await ok(call('GET', `/v1/inventory/availability?productId=${CURD}`, OWNER), 200)) as { rows: { locationId: string; onHandMinor: number }[] })
      .rows.filter((r) => r.locationId === locationId).reduce((n, r) => n + r.onHandMinor, 0);

  beforeAll(async () => {
    cloud = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId: randomUUID(), owner: OWNER, packSigningKey: KEY });
    await cloud.grant(MANAGER, 'store_manager');
    await cloud.grant(CASHIER, 'cashier');
    await cloud.grant(BOX, 'store_computer', undefined, [STORE]);
    expect((await ownerApprovedSettingOn(cloud, 'locale.time_zone', { value: 'UTC' }, OWNER)).status).toBe(200); // OB-336
    await ok(call('POST', '/v1/org/nodes/C1', OWNER, { kind: 'company', name: 'SRE Retail' }, 'org-c1'), 201);
    await ok(call('POST', `/v1/org/nodes/${STORE}`, OWNER, { kind: 'branch', name: 'SRE Hyper Market', parentId: 'C1', companyId: 'C1' }, 'org-s1'), 201);
    await ok(call('POST', '/v1/catalogue/tax-classes/04031000/rates/2017-07-01', OWNER, { rateBps: 500 }, 'tax-curd'), 201);
    await ok(call('POST', `/v1/catalogue/products/${CURD}/publish`, OWNER, {
      product: { sku: 'CURD', name: 'Curd 400g', baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '04031000', lifecycle: 'active' },
      categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }],
    }, 'publish-curd'), 201);
    await ok(call('POST', `/v1/prices/list/${CURD}/entries/e1`, OWNER, {
      scope: 'store', scopeRef: STORE, priceMinor: 6_000, mrpMinor: 6_500, costMinor: 3_000, marginFloorBps: 0, currency: 'INR', effectiveFrom: day(0),
    }, 'price-curd'), 201);
    await ok(call('POST', `/v1/catalogue/products/${CURD}/barcodes/8901000000026`, OWNER, { kind: 'ean' }, 'barcode-curd'), 201);
    // Two batches on the shelf: B-OLD past its date two days ago, B-NEW good for a week.
    for (const [b, expiry] of [['B-OLD', day(-2)], ['B-NEW', day(7)]] as const) {
      await ok(call('POST', '/v1/inventory/movements', OWNER, {
        movementId: `rx-${b}`, productId: CURD, locationId: STORE, kind: 'received', quantityMinor: 12, uom: 'EA',
        occurredAt: new Date(Date.now() - 10 * 86_400_000).toISOString(), enteredBy: OWNER, batchId: b, expiry,
      }, `rx-${b}`), 202);
    }
    await ok(call('POST', '/v1/catalogue/pack', OWNER, { storeId: STORE, asOf: day(0) }, 'pack-1'), 201);
    // Head office's daily expiry move, run by hand: B-OLD goes EXPIRED and onto the tills' pack, re-signed.
    const moved = await ok(call('POST', '/v1/inventory/expiry-sweep', MANAGER, {}, 'sweep-1'), 200);
    expect(moved).toMatchObject({ count: 1, tillsPack: { published: true } });
  }, 60_000);
  afterAll(async () => { await cloud?.stop(); });
  afterEach(async () => {
    for (const e of edges.splice(0)) await e.stop();
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  it('the box takes the re-signed pack; the till holds B-OLD offline; after a cold restart the box syncs; head office re-shelves only B-NEW', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-expired-held-pg-'));
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
    expect(catalogue.products.find((p) => p.productId === CURD)?.expiredBatches).toEqual([{ batchId: 'B-OLD', expiry: day(-2) }]);
    const before = await onHandAt(STORE);

    // The line goes down: the till and the box decide alone.
    const till = bootPos({ laneId: LANE, catalogue, lanePort: edge.lane!.port, refundPolicy: { approvalThresholdMinor: 0, noReceiptCapMinor: 150_000 } });
    await signInTill(till, CASHIER);
    const [old, fresh] = await returnsAt(till, [['RT-PG-OLD', 'B-OLD'], ['RT-PG-NEW', 'B-NEW']]);
    expect(old).toMatchObject({ kind: 'settled', held: { expired: 1 } });
    expect(fresh?.kind).toBe('settled');

    // The box goes down before it syncs, and comes back on the same disk (a cold restart), then the line is up.
    await edge.stop();
    edges.splice(0);
    const back = (await startEdge(env, () => {}))!;
    edges.push(back);
    expect(await back.syncOnce!()).toMatchObject({ dead: 0, remaining: 0 });
    expect(await onHandAt(STORE)).toBe(before + 1); // B-NEW back on the shelf; B-OLD held, never sellable
  }, 90_000);
});
