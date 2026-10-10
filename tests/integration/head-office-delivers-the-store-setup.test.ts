import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiHarness, TEST_IDP, TEST_PACK_KEY, type ApiHarness } from '../support/api-harness';
import type { HttpRequest } from '../../services/kernel/src/index';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { hmacSigner } from '../../services/catalogue/src/index';
import { signStorePack, verifyStorePack, type StorePackEnvelope } from '../../services/platform/src/store-packs';
import { STREAM, ROLE_REVOKED, countsAdapter, adjustmentRequestAdapter, goodsReceiptAdapter } from '../../services/api/src/adapters';
import { GLOBAL_FOR } from '../../edge/store-edge/src/screen-data';
import { approvedSuppliers } from '../support/approved-supplier';
import { makeEvent } from '../../packages/contracts/src/event';

/**
 * **PA-06 = DF-3-a — head office builds each store's setup and the store computer takes it, checked (Wave 4 · OB-26 "A" ·
 * M01-FR-03 · M02-FR-01/02 · §31 · P-01 · P-02 · P-08).**
 *
 * The audit found it: a store computer read its setup from a FILE someone carried to it, and nothing checked who made it,
 * for which shop or store, or how old it was. Real head office, a real store computer, the real pull:
 *   • head office builds the setup from its own records — the store's settings, the people granted at this store and
 *     their names, the products it published — signed, numbered, for this store only;
 *   • the store computer takes it only if the signature checks and it is this shop's, this store's and newer; it is
 *     written to disk (the one it replaces kept), it replaces the pack file, and it survives a restart;
 *   • a person granted later reaches the store on the next pull (always current, OB-26 "A"); a person whose grant ends
 *     leaves it; another store's computer cannot read this store's setup; head office unreachable → the store keeps
 *     trading on what it has, and an out-of-date setup is SAID, never thrown away.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6';
const SETTINGS = { tradingDayCutoff: '02:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 5_000, cashVarianceToleranceMinor: 5_000, privacySlaDays: 30, warehouseId: 'WH' };
const signer = hmacSigner(TEST_PACK_KEY);

describe('PA-06 — head office delivers each store its setup', () => {
  let h: ApiHarness;
  let dir: string;
  const edges: EdgeProcess[] = [];
  const savedFetch = globalThis.fetch;
  let cut = false;
  const call = (method: 'GET' | 'POST', path: string, body?: unknown, userId = 'u-owner') =>
    h.request({ method, path, userId, tenantId: A, ...(method === 'POST' ? { idempotencyKey: `k-${Math.random()}` } : {}), ...(body === undefined ? {} : { body }) });
  const boot = async (over: Record<string, string> = {}) => {
    const e = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: A, PACK_SIGNING_KEY: TEST_PACK_KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
      CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box', tenantId: A, branchId: 'S1' }), // this store computer's credential is bound to its store
      EDGE_STORE_PACK_SOURCE: 'head-office', EDGE_STORE_ID: 'S1', ...over,
    }, () => {}))!;
    edges.push(e);
    return e;
  };

  beforeEach(async () => {
    h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-box', 'store_computer', ['S1']);   // this store computer's own identity, at S1 only
    await h.provisionRole(A, 'u-box2', 'store_computer', ['S2']);  // another store's computer
    await h.provisionRole(A, 'u-mgr', 'store_manager', ['S1']);
    cut = false;
    globalThis.fetch = (async (url: string, init: RequestInit): Promise<Response> => {
      if (String(url).startsWith('http://127.0.0.1:')) return savedFetch(url, init);
      if (cut) throw new Error('network down');
      const hdr = (init.headers ?? {}) as Record<string, string>;
      const res = await h.raw({
        method: (init.method ?? 'GET') as HttpRequest['method'], path: new URL(url).pathname,
        token: hdr['authorization']?.replace(/^Bearer /, ''), idempotencyKey: hdr['idempotency-key'],
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
      });
      return new Response(JSON.stringify(res.body), { status: res.status });
    }) as unknown as typeof globalThis.fetch;
    dir = await mkdtemp(join(tmpdir(), 'sre-store-setup-'));
    const node = (id: string, body: Record<string, unknown>) => call('POST', `/v1/org/nodes/${id}`, body);
    expect((await node('C1', { kind: 'company', name: 'SRE Retail' })).status).toBe(201);
    expect((await node('WH', { kind: 'warehouse', name: 'Back store', parentId: 'C1', companyId: 'C1' })).status).toBe(201);
    expect((await node('S1', { kind: 'branch', name: 'SRE Hyper Market', parentId: 'C1', companyId: 'C1' })).status).toBe(201);
    expect((await node('S2', { kind: 'branch', name: 'Second store', parentId: 'C1', companyId: 'C1' })).status).toBe(201);
  });
  afterEach(async () => {
    for (const e of edges.splice(0)) await e.stop();
    globalThis.fetch = savedFetch;
    await rm(dir, { recursive: true, force: true });
  });

  it('THE AUDIT\'S CASE: the store computer takes ITS setup from head office — signed, checked, on disk, replacing the file, and kept across a restart', async () => {
    // A store head office has not set up yet: nothing to send, and the store computer says so.
    expect((await call('GET', '/v1/store-packs/S1')).status).toBe(404);
    expect((await call('POST', '/v1/stores/S1/settings', SETTINGS)).status).toBe(201);
    // A pack FILE on the box (the old way) — the head-office setup must replace it, not mix with it.
    await writeFile(join(dir, 'old-pack.json'), JSON.stringify({ version: 1, policies: { storeId: 'OLD', branchId: 'OLD', branchName: 'From a file', tradingDayCutoff: '00:00', staleAfterSeconds: 1, countApprovalThresholdMinor: 1, handoverToleranceMinor: 1, privacySlaDays: 1, warehouseId: 'OLD' } }));
    const edge = await boot({ EDGE_PACK_FILE: join(dir, 'old-pack.json') });
    expect(edge.storeSetup()).toMatchObject({ source: 'file' });

    const outcome = await edge.refreshStorePack!();
    expect(outcome).toMatchObject({ status: 'updated', expired: false });
    expect(edge.storeSetup()).toMatchObject({ source: 'head-office', expired: false });
    const onDisk = JSON.parse(await readFile(join(dir, 'store-pack.json'), 'utf8')) as StorePackEnvelope;
    expect(verifyStorePack(signer, onDisk, { tenantId: A, storeId: 'S1', heldVersion: null, now: onDisk.issuedAt })).toEqual({ accepted: true });
    expect(onDisk.sections['policies']).toMatchObject({ storeId: 'S1', branchName: 'SRE Hyper Market', tradingDayCutoff: '02:00', warehouseId: 'WH' });
    expect((onDisk.sections['roleAssignments'] as { userId: string }[]).map((g) => g.userId).sort()).toEqual(['u-box', 'u-mgr', 'u-owner']);
    // PA-06 part 3b: the buying screen's tolerances are head office's match policy in force (OC-13 until the owner sets
    // one); no buyer is named — the screen runs as the signed-in person.
    expect(onDisk.sections['buyingPolicy']).toEqual({ approvers: [], quantityToleranceBps: 0, priceToleranceBps: 100, immaterialMinor: 100 });

    // PA-06-r1: the same content signed again (head office builds on request, so each answer is a newer version with a
    // later expiry) is checked and RENEWS the held envelope — on disk too — so the box never runs out of date on a setup
    // head office keeps renewing. A restart comes back on head office's setup, not the file.
    const later = Date.now() + 2;
    await new Promise<void>((resolve) => { const tick = (): void => { if (Date.now() >= later) resolve(); else setImmediate(tick); }; tick(); });
    expect((await edge.refreshStorePack!()).status).toBe('renewed');
    const renewed = JSON.parse(await readFile(join(dir, 'store-pack.json'), 'utf8')) as StorePackEnvelope;
    expect(renewed.contentHash).toBe(onDisk.contentHash);
    expect(renewed.version).toBeGreaterThan(onDisk.version);
    expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.parse(onDisk.expiresAt));
    expect(edge.storeSetup()).toMatchObject({ source: 'head-office', version: renewed.version, expiresAt: renewed.expiresAt, expired: false });
    await edge.stop(); edges.pop();
    const again = await boot({ EDGE_PACK_FILE: join(dir, 'old-pack.json') });
    expect(again.storeSetup()).toMatchObject({ source: 'head-office', version: renewed.version });
  });

  it('PA-04: the store computer tells head office how many records it still holds unsent, with the setup it trades on', async () => {
    expect((await call('POST', '/v1/stores/S1/settings', SETTINGS)).status).toBe(201);
    const edge = await boot();
    await edge.refreshStorePack!();
    expect(await edge.reportHeldVersions!()).toBe(true);
    const held = (await call('GET', '/v1/store-packs/S1/held')).body as { held?: { unsentItems?: number; reportedBy: string } };
    // Nothing waiting on this fresh box: a counted zero, said by the box itself — a branch close can rely on it.
    expect(held.held).toMatchObject({ unsentItems: 0, reportedBy: 'u-box' });
  });

  it('always current: a person granted later reaches the store on the next pull; a person whose grant ends leaves it', async () => {
    await call('POST', '/v1/stores/S1/settings', SETTINGS);
    const edge = await boot();
    await edge.refreshStorePack!();
    await h.provisionRole(A, 'u-new', 'cashier', ['S1']);
    expect((await edge.refreshStorePack!()).status).toBe('updated');
    const held = JSON.parse(await readFile(join(dir, 'store-pack.json'), 'utf8')) as StorePackEnvelope;
    expect((held.sections['people'] as { userId: string }[]).map((p) => p.userId)).toContain('u-new');
    // The one it replaced is kept beside it.
    expect(JSON.parse(await readFile(join(dir, 'store-pack.previous.json'), 'utf8'))).toMatchObject({ storeId: 'S1' });
    // A person granted only at ANOTHER store never reaches this one.
    expect((held.sections['people'] as { userId: string }[]).map((p) => p.userId)).not.toContain('u-box2');

    // The new person's grant ends (a leaver): the next pull carries a setup without them.
    await h.store.append(A, STREAM.identity, makeEvent({
      id: 'revoke-u-new', type: ROLE_REVOKED, occurredAt: new Date().toISOString(), idempotencyKey: `revoke-${A}-u-new`, source: 'test',
      payload: { userId: 'u-new', roleId: 'cashier', branchScope: ['S1'] },
    }));
    expect((await edge.refreshStorePack!()).status).toBe('updated');
    const after = JSON.parse(await readFile(join(dir, 'store-pack.json'), 'utf8')) as StorePackEnvelope;
    expect((after.sections['people'] as { userId: string }[]).map((p) => p.userId)).not.toContain('u-new');
  });

  it('only for that store: another store\'s computer cannot read it; a forged or another store\'s setup is refused and the held one stays', async () => {
    await call('POST', '/v1/stores/S1/settings', SETTINGS);
    const other = await h.request({ method: 'GET', path: '/v1/store-packs/S1', userId: 'u-box2', tenantId: A, branchId: 'S2' });
    expect(other.status).toBe(403);
    expect((other.body as { error: { code: string } }).error.code).toBe('not_this_stores_computer');

    const now = new Date().toISOString();
    const real = signStorePack(signer, { tenantId: A, storeId: 'S1', issuedAt: now, sections: { policies: {} } });
    expect(verifyStorePack(signer, { ...real, sections: { policies: { storeId: 'EVIL' } } }, { tenantId: A, storeId: 'S1', heldVersion: null, now })).toMatchObject({ accepted: false, reason: 'bad_signature' });
    expect(verifyStorePack(signer, real, { tenantId: A, storeId: 'S2', heldVersion: null, now })).toMatchObject({ accepted: false, reason: 'wrong_store' });
    expect(verifyStorePack(signer, real, { tenantId: 'other-shop', storeId: 'S1', heldVersion: null, now })).toMatchObject({ accepted: false, reason: 'wrong_shop' });
    expect(verifyStorePack(signer, real, { tenantId: A, storeId: 'S1', heldVersion: real.version, now })).toMatchObject({ accepted: false, reason: 'not_newer' });
    expect(verifyStorePack(hmacSigner('another-key'.padEnd(48, '0')), real, { tenantId: A, storeId: 'S1', heldVersion: null, now })).toMatchObject({ accepted: false, reason: 'bad_signature' });

    // A tampered file on the store computer's disk is not trusted at restart.
    const edge = await boot();
    await edge.refreshStorePack!();
    const onDisk = JSON.parse(await readFile(join(dir, 'store-pack.json'), 'utf8')) as StorePackEnvelope;
    await edge.stop(); edges.pop();
    await writeFile(join(dir, 'store-pack.json'), JSON.stringify({ ...onDisk, sections: { ...onDisk.sections, policies: { storeId: 'EVIL' } } }));
    expect((await boot()).storeSetup()).toMatchObject({ source: 'none' });
  });

  it('head office unreachable: the store keeps trading on what it has, says so; an out-of-date setup is said, not thrown away', async () => {
    await call('POST', '/v1/stores/S1/settings', SETTINGS);
    const edge = await boot();
    await edge.refreshStorePack!();
    cut = true;
    const offline = await edge.refreshStorePack!();
    expect(offline).toMatchObject({ status: 'offline', expired: false });
    expect(offline.staffMessage).toMatch(/could not be reached.*store setup/);
    expect(edge.storeSetup().source).toBe('head-office');

    // A held setup issued long ago: restored, used, and marked out of date.
    await edge.stop(); edges.pop();
    const old = signStorePack(signer, { tenantId: A, storeId: 'S1', issuedAt: '2026-01-01T00:00:00.000Z', sections: { policies: { storeId: 'S1' } } });
    await writeFile(join(dir, 'store-pack.json'), JSON.stringify(old));
    const restarted = await boot();
    expect(restarted.storeSetup()).toMatchObject({ source: 'head-office', expired: true });
    expect((await restarted.refreshStorePack!()).staffMessage).toMatch(/OUT OF DATE/);
    // Reachable again: the current setup replaces it.
    cut = false;
    expect((await restarted.refreshStorePack!()).status).toBe('updated');
    expect(restarted.storeSetup()).toMatchObject({ expired: false });
  });

  it('PA-06 part 3b: the buying screen takes the match policy the owner set; the store computer serves it with no named buyer', async () => {
    await call('POST', '/v1/stores/S1/settings', SETTINGS);
    expect((await call('POST', '/v1/purchase/match-policy', { quantityToleranceBps: 50, priceToleranceBps: 200, immaterialMinor: 1_000 })).status).toBe(201);
    const edge = await boot();
    expect((await edge.refreshStorePack!()).status).toBe('updated');
    const onDisk = JSON.parse(await readFile(join(dir, 'store-pack.json'), 'utf8')) as StorePackEnvelope;
    expect(onDisk.sections['buyingPolicy']).toEqual({ approvers: [], quantityToleranceBps: 50, priceToleranceBps: 200, immaterialMinor: 1_000 });
  });

  it('OB-37 · PA-06 3b(d)(e): the warehouse phone\'s section is head office\'s — this store\'s bins and stock and the deliveries it is waiting for, kg in grams', async () => {
    await call('POST', '/v1/stores/S1/settings', SETTINGS); // back store WH
    // a published catalogue: rice sold by the kilogram, soap each
    await h.store.append(A, STREAM.catalogue, makeEvent({ id: 'cat-3', type: 'CataloguePublished', occurredAt: new Date().toISOString(), idempotencyKey: `cat-${A}-3`, source: 'test', payload: { snapshot: {
      tenantId: A, version: 3, builtAt: new Date().toISOString(), scope: { tenantId: A, storeId: 'S1' },
      products: [
        { productId: 'rice', sku: 'rice', name: 'Rice loose', unitPriceMinor: 6_000, taxBps: 0, status: 'active', baseUom: 'kg' },
        { productId: 'soap', sku: 'soap', name: 'Soap', unitPriceMinor: 3_000, taxBps: 0, status: 'active', baseUom: 'each' },
      ],
      barcodes: [{ code: '8901', productId: 'soap' }],
    }, signature: 'x', publishedBy: 'u-owner', publishedAt: new Date().toISOString() } }));
    // bins: one in S1's back store, one at S2 (not this store's)
    expect((await call('POST', '/v1/warehouse/bins/B-WH', { storeId: 'WH', capacityMinor: 100_000, pickable: true })).status).toBe(201);
    expect((await call('POST', '/v1/warehouse/bins/B-S2', { storeId: 'S2', capacityMinor: 100_000, pickable: true })).status).toBe(201);
    expect((await call('POST', '/v1/warehouse/movements/put-1', { kind: 'put_away', storeId: 'WH', productId: 'soap', quantityMinor: 12, uom: 'ea', toBinId: 'B-WH' })).status).toBe(201);
    // two issued orders: one delivered to this store's back store, one to S2
    await approvedSuppliers(h, A, 'sup-1');
    await h.provisionRole(A, 'u-buyer', 'owner');
    const order = async (poId: string, to: string) => {
      expect((await call('POST', `/v1/purchase/orders/${poId}`, { supplierId: 'sup-1', deliverToLocationId: to, lines: [{ productId: 'rice', orderedQty: 25_000, unitCost: { minor: 5_000, currency: 'INR' } }, { productId: 'soap', orderedQty: 10, unitCost: { minor: 2_000, currency: 'INR' } }] }, 'u-buyer')).status).toBe(201);
      expect((await call('POST', `/v1/purchase/orders/${poId}/approval`, { reason: 'stock' })).status).toBe(200);
    };
    await order('po-s1', 'WH');
    await order('po-s2', 'S2');
    // the store's phones: head office's fleet register (and a code's fingerprint), never a list copied into a file
    expect((await call('POST', '/v1/platform/devices/hh-1/register', { branchId: 'S1', kind: 'handheld', label: 'Back store phone' })).status).toBe(201);
    expect((await call('POST', '/v1/platform/devices/hh-9/register', { branchId: 'S2', kind: 'handheld', label: 'Other store' })).status).toBe(201);
    expect((await call('POST', '/v1/platform/devices/hh-1/enrolment', {})).status).toBeLessThan(300);
    const edge = await boot();
    expect((await edge.refreshStorePack!()).status).toBe('updated');
    const w = (JSON.parse(await readFile(join(dir, 'store-pack.json'), 'utf8')) as StorePackEnvelope).sections['warehouse'] as Record<string, unknown>;
    expect(w).toMatchObject({ assignmentId: 'warehouse-S1', workerId: '', storeId: 'WH' });
    expect((w['bins'] as { binId: string }[]).map((b) => b.binId)).toEqual(['B-WH']);
    expect(w['contents']).toEqual({ 'B-WH|soap|': 12 });
    expect(w['barcodes']).toEqual([{ barcode: '8901', productId: 'soap', level: 'unit' }]);
    const open = w['openDeliveries'] as { poId: string; grnId: string; ordered: { productId: string; quantityMinor: number; unitCostMinor: number }[] }[];
    expect(open.map((d) => d.poId)).toEqual(['po-s1']); // S2's order is not this store's
    // OB-31: the order holds 25 kg of rice as 25 000 grams — passed to the phone as it is (never scaled twice), costed per kg
    expect(open[0]!.ordered).toEqual([
      { productId: 'rice', quantityMinor: 25_000, unitCostMinor: 5_000, currency: 'INR' },
      { productId: 'soap', quantityMinor: 10, unitCostMinor: 2_000, currency: 'INR' },
    ]);
    // units are the stored codes: 'each' is named 'ea'
    const packProducts = (JSON.parse(await readFile(join(dir, 'store-pack.json'), 'utf8')) as StorePackEnvelope).sections['products'] as { productId: string; uom: string }[];
    expect(packProducts.find((p) => p.productId === 'soap')?.uom).toBe('ea');
    // exactly one waiting: the phone receives against it directly
    expect(w).toMatchObject({ poId: 'po-s1', grnId: open[0]!.grnId });
    const devices = (JSON.parse(await readFile(join(dir, 'store-pack.json'), 'utf8')) as StorePackEnvelope).sections['devices'] as { deviceId: string; enrolment?: { codeHash: string } }[];
    expect(devices.map((d) => d.deviceId)).toEqual(['hh-1']);
    expect(devices[0]!.enrolment?.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(devices)).not.toMatch(/"code"/); // the code itself never travels
    expect(edge.storeSetup()).toMatchObject({ source: 'head-office' });
  });

  it('PA-06-r1: an out-of-date setup whose contents head office still holds is RENEWED by the next pull — not kept expired', async () => {
    await call('POST', '/v1/stores/S1/settings', SETTINGS);
    const edge = await boot();
    expect((await edge.refreshStorePack!()).status).toBe('updated');
    const current = JSON.parse(await readFile(join(dir, 'store-pack.json'), 'utf8')) as StorePackEnvelope;
    await edge.stop(); edges.pop();
    // The box held the SAME contents, signed long ago and now past expiry (as it would after a week of "unchanged").
    const stale = signStorePack(signer, { tenantId: A, storeId: 'S1', issuedAt: '2026-01-01T00:00:00.000Z', sections: current.sections });
    expect(stale.contentHash).toBe(current.contentHash);
    await writeFile(join(dir, 'store-pack.json'), JSON.stringify(stale));
    const restarted = await boot();
    expect(restarted.storeSetup()).toMatchObject({ source: 'head-office', version: stale.version, expired: true });
    const renewed = await restarted.refreshStorePack!();
    expect(renewed).toMatchObject({ status: 'renewed', expired: false });
    expect(restarted.storeSetup()).toMatchObject({ source: 'head-office', expired: false });
    const onDisk = JSON.parse(await readFile(join(dir, 'store-pack.json'), 'utf8')) as StorePackEnvelope;
    expect(onDisk.contentHash).toBe(current.contentHash);
    expect(onDisk.version).toBeGreaterThan(stale.version);
    expect(verifyStorePack(signer, onDisk, { tenantId: A, storeId: 'S1', heldVersion: stale.version, now: new Date().toISOString() })).toEqual({ accepted: true });
    // and it survives a restart
    await restarted.stop(); edges.pop();
    expect((await boot()).storeSetup()).toMatchObject({ source: 'head-office', version: onDisk.version, expired: false });
  });

  it('store settings are head office\'s record: owner sets them (a new version each change), a manager may not, a bad value is refused', async () => {
    expect((await call('POST', '/v1/stores/S1/settings', SETTINGS)).status).toBe(201);
    expect(((await call('POST', '/v1/stores/S1/settings', { ...SETTINGS, handoverToleranceMinor: 7_500 })).body as { settings: { version: number } }).settings.version).toBe(2);
    expect((await call('POST', '/v1/stores/S1/settings', SETTINGS, 'u-mgr')).status).toBe(403);
    expect((await call('POST', '/v1/stores/S1/settings', { ...SETTINGS, tradingDayCutoff: '25:00' })).status).toBe(400);
    expect((await call('POST', '/v1/stores/NOPE/settings', SETTINGS)).status).toBe(404);
    expect((await call('GET', '/v1/stores/S1/settings')).body).toMatchObject({ settings: { handoverToleranceMinor: 7_500, version: 2 } });
  });

  // ── DF-3-b-1: the store's rules and every screen's setup ─────────────────────────────────────────────────────────
  const RULES = {
    approvalLimitMinor: 500_000, marginFloorBps: 2_000, nearExpiryDays: 30,
    reporting: { laggingAfterMinutes: 5, staleAfterMinutes: 60 },
    service: { returnWindowDays: 7, approvalThresholdMinor: 200_000, noReceiptCapMinor: 50_000, agentAuthorityMinor: 5_000, compensationCapMinor: 50_000 },
    journalPrefixes: { takings: 'TK', tax: 'TX', refunds: 'RF' }, dormantAfterDays: 60, aiStaleAfterMinutes: 60,
    merchandising: { refillAtBp: 5_000, countStaleAfterMinutes: 120, refillRole: 'store_manager' },
    writeOffMaterialThresholdMinor: 50_000,
    checklist: [{ itemId: 'close-1', description: 'Count every till blind', blocking: true }, { itemId: 'close-2', description: 'Walk the chiller', blocking: false }],
  };

  it('DF-3-b-1: the store\'s rules are head office\'s record — every value set by the owner, refused by name when missing — and the setup carries them', async () => {
    await call('POST', '/v1/stores/S1/settings', SETTINGS);
    // Nothing is defaulted: a body missing values is refused, naming each one.
    const missing = await call('POST', '/v1/stores/S1/rules', { approvalLimitMinor: 500_000 });
    expect(missing.status).toBe(400);
    expect(JSON.stringify(missing.body)).toMatch(/marginFloorBps.*checklist/);
    expect((await call('POST', '/v1/stores/S1/rules', { ...RULES, merchandising: { ...RULES.merchandising, refillRole: 'nobody' } })).status).toBe(400);
    expect((await call('POST', '/v1/stores/S1/rules', RULES, 'u-mgr')).status).toBe(403);
    expect((await call('POST', '/v1/stores/S1/rules', RULES)).status).toBe(201);
    expect(((await call('POST', '/v1/stores/S1/rules', { ...RULES, nearExpiryDays: 21 })).body as { rules: { version: number } }).rules.version).toBe(2);

    const edge = await boot();
    expect((await edge.refreshStorePack!()).status).toBe('updated');
    const held = JSON.parse(await readFile(join(dir, 'store-pack.json'), 'utf8')) as StorePackEnvelope;
    const sec = held.sections as Record<string, unknown>;
    expect(sec['checklist']).toEqual([
      { itemId: 'close-1', description: 'Count every till blind', done: false, blocking: true },
      { itemId: 'close-2', description: 'Walk the chiller', done: false, blocking: false },
    ]);
    expect(sec['expiryPolicy']).toEqual({ nearExpiryDays: 21 });
    expect(sec['merchandisingPolicy']).toMatchObject({ refillAtBp: 5_000, countStaleAfterMinutes: 120, refillRole: 'store_manager' });
    expect(sec['financePolicy']).toMatchObject({ tradingDayCutoff: '02:00', journalPrefixes: { takings: 'TK' } });
    // The price approvers are the people whose grants AT THIS STORE carry the authority — read from the grants.
    expect(sec['pricingPolicy']).toEqual({ approvers: ['u-owner'], marginFloorBps: 2_000 });
    // Every screen's setup is there, and names NO person: the screen runs as whoever signs in.
    for (const section of ['countsPolicy', 'cashOfficePolicy', 'dayReopenPolicy', 'goodsReceiptPolicy', 'dataIoPolicy']) {
      expect(sec[section], section).toMatchObject({ permissions: [] });
      expect((sec[section] as Record<string, unknown>)['userId'], section).toBeUndefined();
    }
    expect((sec['dataIoPolicy'] as unknown as { importTemplates: { id: string }[] }).importTemplates.map((t) => t.id)).toEqual(['supplier-invoice-v1', 'product-v1']);
  });

  it('DF-3-b-1: a store with no rules yet gets no rules sections — the store says it was not told, never a guessed limit', async () => {
    await call('POST', '/v1/stores/S1/settings', SETTINGS);
    const edge = await boot();
    await edge.refreshStorePack!();
    const held = JSON.parse(await readFile(join(dir, 'store-pack.json'), 'utf8')) as StorePackEnvelope;
    for (const section of ['checklist', 'managerPolicy', 'pricingPolicy', 'servicePolicy', 'merchandisingPolicy', 'writeOffCapturePolicy']) {
      expect(held.sections[section], section).toBeUndefined();
    }
    expect(held.sections['countsPolicy']).toEqual({ permissions: [] });
  });

  it('DF-3-b-1: behind the signed-in front, a screen fed by head office\'s setup runs as the person who signed in — their id, their permissions from head office\'s grants', async () => {
    await call('POST', '/v1/stores/S1/settings', SETTINGS);
    await call('POST', '/v1/stores/S1/rules', RULES);
    const edge = await boot({ EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_SCREEN_TRUST_FORWARDED_USER: '1' });
    await edge.refreshStorePack!();
    const base = `http://127.0.0.1:${edge.screens!.port}`;
    const payloadOf = async (screen: 'counts', who: string): Promise<Record<string, unknown> | null> => {
      const html = await (await savedFetch(`${base}/${screen}`, { headers: { 'x-sre-user': who } })).text();
      const m = new RegExp(`<script>window\\.${GLOBAL_FOR[screen]} = ([\\s\\S]*?);</script>`).exec(html);
      return m === null ? null : JSON.parse(m[1]!) as Record<string, unknown>;
    };
    const asManager = await payloadOf('counts', 'u-mgr');
    expect(asManager).toMatchObject({ userId: 'u-mgr' });
    expect(asManager!['permissions']).toEqual(expect.arrayContaining(['count.view']));
    // Someone head office never granted at this store: their own empty permissions — nothing borrowed from anyone.
    expect((await payloadOf('counts', 'u-box2'))!['permissions']).toEqual([]);
  });

  // ── DF-3-b-2: the work waiting at the store, and what the store computer holds ───────────────────────────────────
  it('DF-3-b-2: the manager\'s approvals list is head office\'s own waiting work AT THIS STORE — a held count, a pending correction, a held excess — and the counts list', async () => {
    await call('POST', '/v1/stores/S1/settings', SETTINGS);
    const now = () => new Date().toISOString();
    const base = { productId: 'p1', currency: 'INR', at: now() };
    const counts = countsAdapter({ store: h.store, now });
    await counts.recordReconciliation(A, { ...base, countId: 'CNT-1', locationId: 'WH', expectedMinor: 10, countedMinor: 4, varianceMinor: -6, valueMinor: -6_000, reasonCode: 'shrink', reconciled: false, adjusted: false, requiredApproval: true, pendingApproval: true, counterId: 'u-counter', approvedBy: null } as never);
    await counts.recordReconciliation(A, { ...base, countId: 'CNT-OTHER', locationId: 'S2', expectedMinor: 10, countedMinor: 4, varianceMinor: -6, valueMinor: -6_000, reasonCode: 'shrink', reconciled: false, adjusted: false, requiredApproval: true, pendingApproval: true, counterId: 'u-counter', approvedBy: null } as never);
    await adjustmentRequestAdapter({ store: h.store, now }).recordRequest(A, { ...base, requestId: 'ADJ-1', locationId: 'S1', binId: null, deltaMinor: -2, uom: 'each', reasonCode: 'damaged', note: null, valueMinor: -2_000, requestedBy: 'u-mgr', storeId: 'S1', source: 'test', relayedBy: 'u-box', recordedAt: now(), governanceFlags: [], status: 'pending', decidedBy: null, decidedAt: null } as never);
    await goodsReceiptAdapter({ store: h.store, now }).commit(A, { grnId: 'GRN-9', number: 'GRN-9', poId: null, warehouseId: 'WH', receivedBy: 'u-mgr', receivedAt: now(), captured: {}, availableMinor: 100, heldMinor: 10 } as never, [], 'grn-9');

    const edge = await boot();
    await edge.refreshStorePack!();
    const held = JSON.parse(await readFile(join(dir, 'store-pack.json'), 'utf8')) as StorePackEnvelope;
    expect((held.sections['approvals'] as { id: string; subjectType: string; valueMinor: number | null }[]).map((a) => [a.id, a.subjectType, a.valueMinor])).toEqual([
      ['stock_count:CNT-1', 'stock_count', 6_000],
      ['stock_adjustment:ADJ-1', 'stock_adjustment', 2_000],
      ['goods_receipt_excess:GRN-9', 'goods_receipt_excess', null],
    ]);
    // Another store's count is not this store's work.
    expect((held.sections['countsQueue'] as { countId: string }[]).map((c) => c.countId)).toEqual(['CNT-1']);
  });

  it('DF-3-b-2 (SF-08 hand-over): the store computer reports what it holds; head office shows the store BEHIND a newer catalogue, and only its own computer may report', async () => {
    await call('POST', '/v1/stores/S1/settings', SETTINGS);
    expect((await call('GET', '/v1/store-packs/S1/held')).body).toMatchObject({ state: 'never_reported' });
    const edge = await boot();
    await edge.refreshStorePack!();
    expect(await edge.reportHeldVersions!()).toBe(true);
    const setup = JSON.parse(await readFile(join(dir, 'store-pack.json'), 'utf8')) as StorePackEnvelope;
    expect((await call('GET', '/v1/store-packs/S1/held')).body).toMatchObject({ state: 'nothing_published', held: { storePackVersion: setup.version, catalogueVersion: null, reportedBy: 'u-box' } });
    // Head office publishes a catalogue (a recall would ride on it): this store has not taken it yet → BEHIND.
    await h.store.append(A, STREAM.catalogue, makeEvent({ id: 'cat-7', type: 'CataloguePublished', occurredAt: new Date().toISOString(), idempotencyKey: `cat-${A}-7`, source: 'test', payload: { snapshot: { tenantId: A, version: 7, products: [], barcodes: [] }, signature: 'x', publishedBy: 'u-owner', publishedAt: new Date().toISOString() } }));
    expect((await call('GET', '/v1/store-packs/S1/held')).body).toMatchObject({ state: 'behind', currentCatalogueVersion: 7 });
    // The setup now tells the store computer which catalogue head office published.
    await edge.refreshStorePack!();
    expect((JSON.parse(await readFile(join(dir, 'store-pack.json'), 'utf8')) as StorePackEnvelope).sections['catalogueVersion']).toBe(7);
    // Only that store's computer reports; a bad body is refused.
    expect((await h.request({ method: 'POST', path: '/v1/store-packs/S1/held', userId: 'u-box2', tenantId: A, branchId: 'S2', idempotencyKey: 'k-x', body: { catalogueVersion: 7, storePackVersion: 1 } })).status).toBe(403);
    expect((await h.request({ method: 'POST', path: '/v1/store-packs/S1/held', userId: 'u-box', tenantId: A, branchId: 'S1', idempotencyKey: 'k-y', body: { catalogueVersion: 'seven' } })).status).toBe(400);
  });
});
