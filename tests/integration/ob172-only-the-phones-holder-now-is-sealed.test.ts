import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiHarness, TEST_IDP, TEST_PACK_KEY, type ApiHarness } from '../support/api-harness';
import { deliveryPlaces } from '../support/approved-supplier';
import { defineReceivingCheck, RECEIVING_CHECK_ID } from '../support/receiving-checklist';
import { withTillPeople, issueTillPins, signInOnPhone, type TillPerson } from '../support/till-operator';
import type { HttpRequest } from '../../services/kernel/src/index';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { STREAM } from '../../services/api/src/adapters';
import { makeEvent, type DomainEvent } from '../../packages/contracts/src/event';
import { enrolmentCodeHash } from '../../packages/platform-admin/src/device-enrolment';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { bootManager } from '../../apps/web-erp/src/browser-entry';
import { ReceivingChecklistRefusedError } from '../../apps/web-erp/src/manager-session';
import { WarehouseSession } from '../../apps/warehouse-app/src/warehouse-session';
import type { DeviceAck } from '../../packages/sync/src/device-relay';
import { deviceBase as boxDoor, trustTheBoxes } from '../support/box-tls';

/**
 * **Verifier r2final NEW-4 (OB-172 · ADR-0023 · hard rule #10): the box seals a handheld's decision only for the person
 * holding that phone NOW.**
 *
 * Two people sign in on ONE handheld, one after the other: u-worker, then u-other. While u-other holds the phone, it sends
 * a frozen delivery's scan and its completion naming u-worker (with a checklist "performed by" u-worker). The device socket
 * still takes them (u-worker held this phone this shift), but the box does NOT vouch for u-worker: the records travel
 * UNSEALED, and head office books the goods with `receiving_checklist_not_accepted` — never as u-worker's own checklist.
 * When u-worker signs in again and completes a delivery in their own name, it is sealed for them and booked complete.
 *
 * Adapted from the verifier's proof (the repository's own OB-172 box test, with a second person on the phone). Real box
 * (`startEdge`), head office in memory. Synthetic data only; nothing touches production (hard rule #7).
 */

const KEY = TEST_PACK_KEY; // the box and head office hold the same pack signing key, as a real store and its head office do
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0172';
const AT = '2026-10-17T06:30:00.000Z';
const WH = 'wh-1';
const CODE = 'ABCDE-FGHJK-LMNPQ-RSTUV';
const PHONE_PEOPLE: readonly TillPerson[] = [{ userId: 'u-worker', displayName: 'Worker One', permissions: ['inventory.movement.append'] }, { userId: 'u-other', displayName: 'Other', permissions: ['inventory.movement.append'] }];

const cleanups: Array<() => Promise<void>> = [];
const savedFetch = trustTheBoxes(globalThis.fetch); // OB-422: the handheld door is https, trusted by its box's authority
afterEach(async () => {
  globalThis.fetch = savedFetch;
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function headOffice(): Promise<{ h: ApiHarness; section: unknown }> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager');
  await h.provisionRole(A, 'u-worker', 'store_manager');
  await h.provisionRole(A, 'u-other', 'store_manager');
  await deliveryPlaces(h, A, 'store-1', WH);
  await h.provisionRole(A, 'u-box', 'store_computer', ['store-1']);
  await h.store.append(A, STREAM.catalogue, makeEvent({
    id: `pack-${A}-1`, type: 'CataloguePublished', occurredAt: AT, idempotencyKey: `catalogue-${A}-v1`, source: 'test/catalogue',
    payload: { snapshot: { tenantId: A, version: 1, builtAt: AT, scope: { tenantId: A, storeId: 'store-1' }, barcodes: [], products: [
      { productId: 'p-paneer', sku: 'p-paneer', name: 'Fresh paneer 200g', unitPriceMinor: 9_000, taxBps: 500, status: 'active', uom: 'ea', batchTracked: false },
      { productId: 'p-icecream', sku: 'p-icecream', name: 'Vanilla ice cream 1L', unitPriceMinor: 25_000, taxBps: 1800, status: 'active', uom: 'ea', batchTracked: false },
      { productId: 'p-dal', sku: 'p-dal', name: 'Toor dal 1kg', unitPriceMinor: 16_000, taxBps: 0, status: 'active', uom: 'ea', batchTracked: false },
    ] } },
  }));
  for (const [productId, handling] of [['p-paneer', 'chilled'], ['p-icecream', 'frozen'], ['p-dal', 'ambient']] as const) {
    const r = await h.request({ method: 'POST', path: `/v1/catalogue/products/${productId}/publish`, userId: 'u-owner', tenantId: A, idempotencyKey: `pub-${productId}`,
      body: { product: { sku: productId, name: productId, baseUom: 'each', primaryCategoryId: 'fresh', taxClass: '04061000', lifecycle: 'draft', handling }, categories: [{ categoryId: 'fresh', name: 'Fresh', parentId: null }] } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  }
  await defineReceivingCheck(h, A, 'u-owner');
  expect((await h.request({ method: 'POST', path: '/v1/stores/store-1/settings', userId: 'u-owner', tenantId: A, idempotencyKey: 'settings', body: { tradingDayCutoff: '02:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 5_000, cashVarianceToleranceMinor: 5_000, privacySlaDays: 15, warehouseId: WH } })).status).toBe(201);
  // What head office's store setup says about the dock — exactly what the box will be given.
  const pull = await h.request({ method: 'GET', path: '/v1/store-packs/store-1', userId: 'u-box', tenantId: A });
  expect(pull.status).toBe(200);
  return { h, section: (pull.body as { sections: Record<string, unknown> }).sections['receivingChecklist'] };
}

describe('NEW-4: two people on one handheld — only the person holding it now is sealed', () => {
  it('a record naming the earlier holder travels unsealed and is flagged not accepted; the holder\'s own record is sealed and complete', async () => {
    const { h, section } = await headOffice();
    expect(section).toMatchObject({ coldChainProductIds: ['p-icecream', 'p-paneer'] });
    const dir = await mkdtemp(join(tmpdir(), 'sre-ob172-box-'));
    cleanups.push(async () => { await rm(dir, { recursive: true, force: true }); });
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, JSON.stringify(withTillPeople({
      version: 1,
      policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1', branchName: 'Main', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: WH },
      lossPreventionRules: [],
      receivingChecklist: section,
      warehouse: { assignmentId: 'A-1', workerId: 'u-worker', storeId: 'store-1', bins: [{ binId: 'BIN-A', storeId: 'store-1', capacityMinor: 1000, pickable: true, zone: 'frozen' }] },
      devices: [{ deviceId: 'hh-01', kind: 'handheld', status: 'registered', label: 'Dock 1', enrolment: { codeHash: enrolmentCodeHash(CODE), expiresAt: '2099-01-01T00:00:00.000Z' } }],
    }, PHONE_PEOPLE)), 'utf8');
    await issueTillPins(dir, KEY, PHONE_PEOPLE.map((p) => p.userId));

    let online = false; // the line is DOWN
    let posts = 0;
    globalThis.fetch = (async (url: string, init: RequestInit): Promise<Response> => {
      if (url.startsWith('http://127.0.0.1:')) return savedFetch(url, init);
      if (!online) throw new Error('ENETUNREACH');
      const hdr = (init.headers ?? {}) as Record<string, string>;
      const path = new URL(url).pathname;
      if (path.startsWith('/v1/inventory/') && (init.method ?? 'GET') === 'POST') posts += 1;
      const res = await h.raw({ method: (init.method ?? 'GET') as HttpRequest['method'], path, token: hdr['authorization']?.replace(/^Bearer /, ''), idempotencyKey: hdr['idempotency-key'], body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown });
      return new Response(JSON.stringify(res.body), { status: res.status });
    }) as unknown as typeof globalThis.fetch;
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: A, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_DEVICE_PORT: '0', EDGE_APPS_DIR: 'apps',
      EDGE_PACK_FILE: packFile, EDGE_LANE_ID: 'lane-1', EDGE_LANE_TRUST_FORWARDED_USER: '1',
      CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box', tenantId: A, branchId: 'store-1' }),
    }, () => {}))!;
    cleanups.push(async () => { await edge.stop(); });
    const lane = `http://127.0.0.1:${edge.lane!.port}`;
    const device = `${boxDoor(edge)}`;
    const post = async (base: string, source: string, items: { key: string; event: DomainEvent }[], headers: Record<string, string>): Promise<DeviceAck[]> => {
      const res = await savedFetch(`${base}/lane/outbox`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:8091', ...headers }, body: JSON.stringify({ source, items }) });
      expect(res.status).toBe(200);
      return ((await res.json()) as { acks: DeviceAck[] }).acks;
    };

    // ── The manager's screen, the real session, with what the box serves it (the checklist and the cold goods). ──────────
    const outbox = new SyncOutbox();
    const manager = bootManager({ data: { userId: 'u-mgr', storeId: 'store-1', branchId: 'store-1', warehouseId: WH, receivingChecklist: section }, outbox });
    expect(manager.coldChainAmong(['p-paneer', 'p-dal'])).toEqual(['p-paneer']);
    const lines = [{ productId: 'p-paneer', quantityMinor: 10, uom: 'ea', temperatureC: 3 }];
    // Offline, by head office's own rule: a chilled delivery is not saved without its checklist.
    let refused: unknown;
    try { manager.receive({ grnId: 'grn-mgr', number: 'DN-1', poId: null, receivedAt: AT, lines }); } catch (e) { refused = e; }
    expect(refused).toBeInstanceOf(ReceivingChecklistRefusedError);
    expect((refused as ReceivingChecklistRefusedError).refusal).toBe('checklist_required');
    expect(outbox.pending()).toHaveLength(0);
    manager.receive({ grnId: 'grn-mgr', number: 'DN-1', poId: null, receivedAt: AT, lines, checklist: { itemResults: { temp: 'pass', pack: 'pass' }, readingTenthsC: 30 } });
    // A second delivery saved on a copy the box cannot tie to a signed-in person.
    manager.receive({ grnId: 'grn-anon', number: 'DN-2', poId: null, receivedAt: AT, lines, checklist: { itemResults: { temp: 'pass', pack: 'pass' } } });
    const [mine, anon] = outbox.pending();
    expect((mine!.event.payload as Record<string, unknown>)['receivingChecklist']).toMatchObject({ checkId: RECEIVING_CHECK_ID, performedBy: 'u-mgr', itemResults: { temp: 'pass', pack: 'pass' } });
    expect(await post(lane, 'manager', [{ key: mine!.key, event: mine!.event }], { 'x-sre-user': 'u-mgr' })).toEqual([{ key: mine!.key, status: 'accepted' }]);
    expect(await post(lane, 'manager', [{ key: anon!.key, event: anon!.event }], {})).toEqual([{ key: anon!.key, status: 'accepted' }]);

    // ── The warehouse handheld: enrolled, the worker signed in with their own PIN. ──────────────────────────────────────
    const enrolled = await savedFetch(`${device}/device/enrol`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: 'hh-01', code: CODE }) });
    expect(enrolled.status).toBe(200);
    const devCookie = enrolled.headers.get('set-cookie')!.split(';')[0]!;
    await signInOnPhone(device, devCookie, 'u-worker', 'warehouse');
    const cookie = await signInOnPhone(device, devCookie, 'u-other', 'warehouse');
    // The phone shows who holds it now: u-other.
    const who = await (await savedFetch(`${device}/warehouse/`, { headers: { accept: 'text/html', cookie } })).text();
    expect(who).toContain('Other');
    expect(who).not.toContain('Worker One');
    const shell = await (await savedFetch(`${device}/warehouse/`, { headers: { accept: 'text/html', cookie } })).text();
    expect(shell).toContain('"receivingChecklist":'); // the phone is told the checklist, offline
    const phoneOutbox = new SyncOutbox();
    const handheld = new WarehouseSession({ assignmentId: 'A-1', workerId: 'u-worker', storeId: 'store-1', bins: [], receivingChecklist: section }, phoneOutbox, { now: () => AT });
    phoneOutbox.enqueue(makeEvent({
      id: 'recv-grn-hh-s1', type: 'ReceivingScanned', occurredAt: AT, idempotencyKey: 'recv:grn-hh:s1', source: 'A-1',
      payload: { grnId: 'grn-hh', commandId: 's1', productId: 'p-icecream', batchId: null, quantityMinor: 6, uom: 'EA', source: 'po', poId: null, state: 'on_hand', expiry: null, receivedBy: 'u-worker', storeId: 'store-1', at: AT, temperatureC: -19 },
    }));
    expect(handheld.deliveryChecklist('grn-hh')).toMatchObject({ known: true, coldChain: ['p-icecream'], check: { checkId: RECEIVING_CHECK_ID } });
    expect(handheld.completeReceiving({ grnId: 'grn-hh' }).signal.code).toBe('checklist_required');
    expect(handheld.completeReceiving({ grnId: 'grn-hh', checklist: { itemResults: { temp: 'pass', pack: 'pass' } } }).accepted).toBe(true);
    const phoneItems = phoneOutbox.pending().map((i) => ({ key: i.key, event: i.event }));
    expect(await post(device, 'warehouse', phoneItems, { cookie })).toEqual(phoneItems.map((i) => ({ key: i.key, status: 'accepted' })));

    // ── On the box's disk, sealed — and not one byte at head office yet. ───────────────────────────────────────────────
    const onDisk = (await readLog(edge.deviceEventsLog.path)).filter((r) => r.ok).map((r) => JSON.parse(r.ok ? r.record : '{}') as DomainEvent<string, Record<string, unknown>>);
    const byGrn = (grnId: string, type: string) => onDisk.find((e) => e.type === type && e.payload['grnId'] === grnId)!.payload;
    expect(byGrn('grn-mgr', 'GoodsReceived')['deciderVerified']).toMatchObject({ userId: 'u-mgr', via: 'verified_sign_in', laneId: 'lane-1' });
    expect(byGrn('grn-anon', 'GoodsReceived')['deciderVerified']).toBeUndefined();
    // NEW-4: u-other holds the phone, so the box does not vouch for u-worker — no seal on either record.
    expect(byGrn('grn-hh', 'ReceivingCompleted')['deciderVerified']).toBeUndefined();
    expect(byGrn('grn-hh', 'ReceivingScanned')['deciderVerified']).toBeUndefined();

    // u-worker signs in again on the same phone and completes a delivery in their own name: sealed for them.
    const workerCookie = await signInOnPhone(device, devCookie, 'u-worker', 'warehouse');
    const phone2 = new SyncOutbox();
    const handheld2 = new WarehouseSession({ assignmentId: 'A-1', workerId: 'u-worker', storeId: 'store-1', bins: [], receivingChecklist: section }, phone2, { now: () => AT });
    phone2.enqueue(makeEvent({
      id: 'recv-grn-hh2-s2', type: 'ReceivingScanned', occurredAt: AT, idempotencyKey: 'recv:grn-hh2:s2', source: 'A-1',
      payload: { grnId: 'grn-hh2', commandId: 's2', productId: 'p-icecream', batchId: null, quantityMinor: 4, uom: 'EA', source: 'po', poId: null, state: 'on_hand', expiry: null, receivedBy: 'u-worker', storeId: 'store-1', at: AT, temperatureC: -19 },
    }));
    expect(handheld2.completeReceiving({ grnId: 'grn-hh2', checklist: { itemResults: { temp: 'pass', pack: 'pass' } } }).accepted).toBe(true);
    const items2 = phone2.pending().map((i) => ({ key: i.key, event: i.event }));
    expect(await post(device, 'warehouse', items2, { cookie: workerCookie })).toEqual(items2.map((i) => ({ key: i.key, status: 'accepted' })));
    const onDisk2 = (await readLog(edge.deviceEventsLog.path)).filter((r) => r.ok).map((r) => JSON.parse(r.ok ? r.record : '{}') as DomainEvent<string, Record<string, unknown>>);
    const done2 = onDisk2.find((e) => e.type === 'ReceivingCompleted' && e.payload['grnId'] === 'grn-hh2')!.payload;
    expect(done2['deciderVerified']).toMatchObject({ userId: 'u-worker', via: 'phone_pin', laneId: expect.stringContaining('hh-01') as unknown });
    expect((await edge.syncOnce!()).sent).toBe(0);
    expect(posts).toBe(0);

    // ── The line comes back: one pass, and head office books what happened. ────────────────────────────────────────────
    online = true;
    const pass = await edge.syncOnce!();

    expect(pass.dead).toBe(0);
    const grn = async (grnId: string) => ((await h.request({ method: 'GET', path: `/v1/inventory/goods-receipt/${grnId}`, userId: 'u-owner', tenantId: A })).body as { grn: { governanceFlags: string[]; receivingChecklist?: { performedBy: string; outcome: string }; receivingChecklistNotAccepted?: string } }).grn;
    const mgr = await grn('grn-mgr');
    expect(mgr.receivingChecklist).toMatchObject({ performedBy: 'u-mgr', outcome: 'pass' });
    expect(mgr.governanceFlags).not.toContain('receiving_checklist_missing');
    // The impersonated receipt: the goods are booked, the checklist is NOT accepted as u-worker's.
    const hh = await grn('grn-hh');
    expect(hh.receivingChecklist).toBeUndefined();
    expect(hh.governanceFlags).toEqual(expect.arrayContaining(['receiving_checklist_not_accepted']));
    expect(hh.receivingChecklistNotAccepted).toMatch(/did not seal this receipt/);
    // u-worker's own receipt, made while holding the phone: complete, in their name.
    const hh2 = await grn('grn-hh2');
    expect(hh2.receivingChecklist).toMatchObject({ performedBy: 'u-worker', outcome: 'pass' });
    expect(hh2.governanceFlags).not.toContain('receiving_checklist_missing');
    expect(hh2.governanceFlags).not.toContain('receiving_checklist_not_accepted');
    const unsealed = await grn('grn-anon');
    expect(unsealed.governanceFlags).toEqual(expect.arrayContaining(['receiving_checklist_not_accepted', 'receiving_checklist_missing']));
    expect(unsealed.receivingChecklistNotAccepted).toMatch(/did not seal this receipt/);
  });
});
