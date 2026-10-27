import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiHarness, TEST_IDP, TEST_PACK_KEY, type ApiHarness } from '../support/api-harness';
import { deliveryPlaces } from '../support/approved-supplier';
import { defineReceivingCheck } from '../support/receiving-checklist';
import { withTillPeople, issueTillPins, signInOnPhone, type TillPerson } from '../support/till-operator';
import type { HttpRequest } from '../../services/kernel/src/index';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { STREAM } from '../../services/api/src/adapters';
import { makeEvent, type DomainEvent } from '../../packages/contracts/src/event';
import { enrolmentCodeHash } from '../../packages/platform-admin/src/device-enrolment';
import { DeviceOutbox, noDeviceStore } from '../../packages/sync/src/device-outbox';
import { WarehouseSession } from '../../apps/warehouse-app/src/warehouse-session';
import { fromHex, hmacSha256Hex, phoneStamper, readPhoneSignIn, stampMessage, type PhoneSignIn, type SignInStamp } from '../../packages/sync/src/sign-in-stamp';
import type { DeviceAck } from '../../packages/sync/src/device-relay';
import { deviceBase as boxDoor, trustTheBoxes } from '../support/box-tls';

/**
 * **OB-180 "A" (owner, 17 Oct 2026, "Stamp each record") on the REAL store computer (`startEdge`), head office in memory.**
 *
 * The verifier r2final NEW-4 case, now decided: u-worker (A) signs in on the dock phone and receives a frozen delivery,
 * with its checklist, while the phone cannot reach the box. u-other (B) then signs in on the same phone — A's sign-in
 * ends there — and the phone's queue reaches the box under B's sign-in. Each record carries the sign-in it was made
 * under, so the box seals A's receipt for A, and head office books it COMPLETE in A's name.
 *
 * And what must never pass: B making a record that seals as A (with B's own stamp, or a stamp borrowed from A's sign-in
 * but not made with its key); A's stamp replayed from another phone; a stamp naming a person who never signed in on that
 * phone; a stamp made outside A's sign-in; a stamped record altered after the fact. Each is refused by name — never sealed,
 * never quietly re-stamped (hard rule #10).
 *
 * Synthetic data only; nothing touches production (hard rule #7).
 */

const KEY = TEST_PACK_KEY;
const A_TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0180';
const AT = '2026-10-17T06:30:00.000Z';
const WH = 'wh-1';
const CODE_1 = 'ABCDE-FGHJK-LMNPQ-RSTUV';
const CODE_2 = 'BCDEF-GHJKL-MNPQR-STUVW';
const PEOPLE: readonly TillPerson[] = [
  { userId: 'u-worker', displayName: 'Worker One', permissions: ['inventory.movement.append'] },
  { userId: 'u-other', displayName: 'Other', permissions: ['inventory.movement.append'] },
  { userId: 'u-ghost', displayName: 'Never On This Phone', permissions: ['inventory.movement.append'] },
];

const cleanups: Array<() => Promise<void>> = [];
const savedFetch = trustTheBoxes(globalThis.fetch); // OB-422: the handheld door is https, trusted by its box's authority
afterEach(async () => {
  globalThis.fetch = savedFetch;
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function headOffice(): Promise<{ h: ApiHarness; section: unknown }> {
  const h = apiHarness();
  await h.seedOwner(A_TENANT, 'u-owner');
  for (const u of ['u-worker', 'u-other', 'u-ghost']) await h.provisionRole(A_TENANT, u, 'store_manager');
  await deliveryPlaces(h, A_TENANT, 'store-1', WH);
  await h.provisionRole(A_TENANT, 'u-box', 'store_computer', ['store-1']);
  await h.store.append(A_TENANT, STREAM.catalogue, makeEvent({
    id: `pack-${A_TENANT}-1`, type: 'CataloguePublished', occurredAt: AT, idempotencyKey: `catalogue-${A_TENANT}-v1`, source: 'test/catalogue',
    payload: { snapshot: { tenantId: A_TENANT, version: 1, builtAt: AT, scope: { tenantId: A_TENANT, storeId: 'store-1' }, barcodes: [], products: [
      { productId: 'p-icecream', sku: 'p-icecream', name: 'Vanilla ice cream 1L', unitPriceMinor: 25_000, taxBps: 1800, status: 'active', uom: 'ea', batchTracked: false },
    ] } },
  }));
  const r = await h.request({ method: 'POST', path: '/v1/catalogue/products/p-icecream/publish', userId: 'u-owner', tenantId: A_TENANT, idempotencyKey: 'pub-p-icecream',
    body: { product: { sku: 'p-icecream', name: 'p-icecream', baseUom: 'each', primaryCategoryId: 'fresh', taxClass: '04061000', lifecycle: 'draft', handling: 'frozen' }, categories: [{ categoryId: 'fresh', name: 'Fresh', parentId: null }] } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  await defineReceivingCheck(h, A_TENANT, 'u-owner');
  expect((await h.request({ method: 'POST', path: '/v1/stores/store-1/settings', userId: 'u-owner', tenantId: A_TENANT, idempotencyKey: 'settings', body: { tradingDayCutoff: '02:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 5_000, cashVarianceToleranceMinor: 5_000, privacySlaDays: 15, warehouseId: WH } })).status).toBe(201);
  const pull = await h.request({ method: 'GET', path: '/v1/store-packs/store-1', userId: 'u-box', tenantId: A_TENANT });
  expect(pull.status).toBe(200);
  return { h, section: (pull.body as { sections: Record<string, unknown> }).sections['receivingChecklist'] };
}

/** What the served phone page carries (`window.phoneSignIn`), read exactly as the page's own script would see it. */
async function servedSignIn(device: string, cookie: string): Promise<PhoneSignIn> {
  const html = await (await savedFetch(`${device}/warehouse/`, { headers: { accept: 'text/html', cookie } })).text();
  const m = /<script>window\.phoneSignIn = (.*?);<\/script>/.exec(html);
  expect(m, 'the served page carries the sign-in it stamps under').not.toBeNull();
  const signIn = readPhoneSignIn(JSON.parse(m![1]!) as unknown);
  expect(signIn).toBeDefined();
  return signIn!;
}

const scan = (grnId: string, commandId: string, receivedBy: string): DomainEvent => makeEvent({
  id: `recv-${grnId}-${commandId}`, type: 'ReceivingScanned', occurredAt: AT, idempotencyKey: `recv:${grnId}:${commandId}`, source: 'A-1',
  payload: { grnId, commandId, productId: 'p-icecream', batchId: null, quantityMinor: 6, uom: 'EA', source: 'po', poId: null, state: 'on_hand', expiry: null, receivedBy, storeId: 'store-1', at: AT, temperatureC: -19 },
});
/** A stamp made with a sign-in's key (only that sign-in's page holds it), at a chosen time. */
const stampWith = (signIn: PhoneSignIn, event: DomainEvent, madeAt: string, userId = signIn.userId): SignInStamp => {
  const base = { v: 1 as const, ref: signIn.ref, userId, madeAt };
  return { ...base, mac: hmacSha256Hex(fromHex(signIn.key), stampMessage(base, event)) };
};

describe('OB-180: a handheld record is sealed for the sign-in it was made under', () => {
  it('A records offline, B signs in, the queue syncs: A\'s receipt is sealed for A and booked complete; B cannot seal as A; forged and replayed stamps are refused', async () => {
    const { h, section } = await headOffice();
    const dir = await mkdtemp(join(tmpdir(), 'sre-ob180-box-'));
    cleanups.push(async () => { await rm(dir, { recursive: true, force: true }); });
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, JSON.stringify(withTillPeople({
      version: 1,
      policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1', branchName: 'Main', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: WH },
      lossPreventionRules: [],
      receivingChecklist: section,
      warehouse: { assignmentId: 'A-1', workerId: 'u-worker', storeId: 'store-1', bins: [{ binId: 'BIN-A', storeId: 'store-1', capacityMinor: 1000, pickable: true, zone: 'frozen' }] },
      devices: [
        { deviceId: 'hh-01', kind: 'handheld', status: 'registered', label: 'Dock 1', enrolment: { codeHash: enrolmentCodeHash(CODE_1), expiresAt: '2099-01-01T00:00:00.000Z' } },
        { deviceId: 'hh-02', kind: 'handheld', status: 'registered', label: 'Dock 2', enrolment: { codeHash: enrolmentCodeHash(CODE_2), expiresAt: '2099-01-01T00:00:00.000Z' } },
      ],
    }, PEOPLE)), 'utf8');
    await issueTillPins(dir, KEY, PEOPLE.map((p) => p.userId));

    let online = false; // head office is unreachable until the end
    globalThis.fetch = (async (url: string, init: RequestInit): Promise<Response> => {
      if (url.startsWith('http://127.0.0.1:')) return savedFetch(url, init);
      if (!online) throw new Error('ENETUNREACH');
      const hdr = (init.headers ?? {}) as Record<string, string>;
      const res = await h.raw({ method: (init.method ?? 'GET') as HttpRequest['method'], path: new URL(url).pathname, token: hdr['authorization']?.replace(/^Bearer /, ''), idempotencyKey: hdr['idempotency-key'], body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown });
      return new Response(JSON.stringify(res.body), { status: res.status });
    }) as unknown as typeof globalThis.fetch;
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: A_TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_DEVICE_PORT: '0', EDGE_APPS_DIR: 'apps',
      EDGE_PACK_FILE: packFile, EDGE_LANE_ID: 'lane-1',
      CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box', tenantId: A_TENANT, branchId: 'store-1' }),
    }, () => {}))!;
    cleanups.push(async () => { await edge.stop(); });
    const device = `${boxDoor(edge)}`;
    const post = async (cookie: string, items: { key: string; event: DomainEvent; stamp?: SignInStamp }[]): Promise<DeviceAck[]> => {
      const res = await savedFetch(`${device}/lane/outbox`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ source: 'warehouse', items }) });
      expect(res.status).toBe(200);
      return ((await res.json()) as { acks: DeviceAck[] }).acks;
    };
    const enrol = async (deviceId: string, code: string): Promise<string> => {
      const r = await savedFetch(`${device}/device/enrol`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId, code }) });
      expect(r.status).toBe(200);
      return r.headers.get('set-cookie')!.split(';')[0]!;
    };
    const onDisk = async () => (await readLog(edge.deviceEventsLog.path)).filter((r) => r.ok).map((r) => JSON.parse(r.ok ? r.record : '{}') as DomainEvent<string, Record<string, unknown>>);

    // ── A signs in on the dock phone; the page the box serves carries A's sign-in to stamp under. ─────────────────────────
    const phone1 = await enrol('hh-01', CODE_1);
    const cookieA = await signInOnPhone(device, phone1, 'u-worker', 'warehouse');
    const signInA = await servedSignIn(device, cookieA);
    expect(signInA).toMatchObject({ userId: 'u-worker' });
    expect(JSON.stringify(signInA)).not.toContain(cookieA.split('sre_operator=')[1]!); // the session token is never in the page

    // ── A works with the phone cut off from the box: a frozen scan and "delivery complete" with its checklist. ─────────────
    const phoneQueue = new DeviceOutbox(noDeviceStore(), [], phoneStamper(signInA, new Date().toISOString()));
    const handheld = new WarehouseSession({ assignmentId: 'A-1', workerId: 'u-worker', storeId: 'store-1', bins: [], receivingChecklist: section }, phoneQueue, { now: () => AT });
    phoneQueue.enqueue(scan('grn-a', 's1', 'u-worker'));
    expect(handheld.completeReceiving({ grnId: 'grn-a', checklist: { itemResults: { temp: 'pass', pack: 'pass' } } }).accepted).toBe(true);
    const queued = phoneQueue.pending();
    expect(queued).toHaveLength(2);
    for (const item of queued) expect(item.stamp).toMatchObject({ v: 1, ref: signInA.ref, userId: 'u-worker' });

    // ── B signs in on the same phone: A's sign-in ends there. Then the wifi comes back and the queue drains under B. ──────
    const cookieB = await signInOnPhone(device, phone1, 'u-other', 'warehouse');
    const signInB = await servedSignIn(device, cookieB);
    expect(signInB.ref).not.toBe(signInA.ref);
    expect(signInB.key).not.toBe(signInA.key);
    const items = queued.map((i) => ({ key: i.key, event: i.event, stamp: i.stamp! }));
    expect(await post(cookieB, items)).toEqual(items.map((i) => ({ key: i.key, status: 'accepted' })));
    const disk = await onDisk();
    const done = disk.find((e) => e.type === 'ReceivingCompleted' && e.payload['grnId'] === 'grn-a')!;
    expect(done.payload['deciderVerified']).toMatchObject({ userId: 'u-worker', via: 'phone_pin', laneId: expect.stringContaining('hh-01') as unknown });
    expect(JSON.stringify(disk)).not.toContain(signInA.key); // the stamp key never reaches the box's disk or head office
    // A later sign-in cannot unseal it or take it: the same record again is the same one (duplicate), still A's.
    expect(await post(cookieB, [items[1]!])).toEqual([{ key: items[1]!.key, status: 'duplicate' }]);

    // ── B cannot make a record that seals as A. ─────────────────────────────────────────────────────────────────────────
    const now = new Date().toISOString();
    // (1) B's page stamps with B's own sign-in; the record names A.
    const asA1 = scan('grn-b1', 's1', 'u-worker');
    const ack1 = await post(cookieB, [{ key: asA1.idempotencyKey, event: asA1, stamp: phoneStamper(signInB, now)!(asA1)! }]);
    expect(ack1[0]).toMatchObject({ status: 'refused', reason: 'the record names u-worker, but it was made under u-other\'s sign-in' });
    // (2) B borrows A's sign-in reference but has only B's key.
    const asA2 = scan('grn-b2', 's1', 'u-worker');
    const borrowed = { ...stampWith(signInB, asA2, now, 'u-worker'), ref: signInA.ref };
    const ack2 = await post(cookieB, [{ key: asA2.idempotencyKey, event: asA2, stamp: { ...borrowed, mac: hmacSha256Hex(fromHex(signInB.key), stampMessage(borrowed, asA2)) } }]);
    expect(ack2[0]).toMatchObject({ status: 'refused', reason: expect.stringContaining('does not match the record') as unknown });
    // (3) B names A on B's own sign-in reference.
    const asA3 = scan('grn-b3', 's1', 'u-worker');
    const ack3 = await post(cookieB, [{ key: asA3.idempotencyKey, event: asA3, stamp: stampWith(signInB, asA3, now, 'u-worker') }]);
    expect(ack3[0]).toMatchObject({ status: 'refused', reason: 'the record\'s sign-in stamp names u-worker, but that sign-in was somebody else\'s' });
    // (4) A real stamp of A's, lifted onto a changed record (more ice cream than A received).
    const altered = { ...items[0]!.event, idempotencyKey: 'recv:grn-a:s1x', id: 'recv-grn-a-s1x', payload: { ...(items[0]!.event.payload as Record<string, unknown>), commandId: 's1x', quantityMinor: 60 } };
    const ack4 = await post(cookieB, [{ key: altered.idempotencyKey, event: altered, stamp: items[0]!.stamp }]);
    expect(ack4[0]).toMatchObject({ status: 'refused', reason: expect.stringContaining('does not match the record') as unknown });

    // ── Forged stamps. ────────────────────────────────────────────────────────────────────────────────────────────────
    // (5) Naming a person who never signed in on this phone.
    const ghost = scan('grn-g', 's1', 'u-ghost');
    const ack5 = await post(cookieB, [{ key: ghost.idempotencyKey, event: ghost, stamp: stampWith(signInB, ghost, now, 'u-ghost') }]);
    expect(ack5[0]).toMatchObject({ status: 'refused', reason: 'the record names u-ghost, who has not been signed in on this phone this shift' });
    // (6) A reference this box never issued.
    const nowhere = scan('grn-n', 's1', 'u-worker');
    const ack6 = await post(cookieB, [{ key: nowhere.idempotencyKey, event: nowhere, stamp: stampWith({ ...signInA, ref: 'f'.repeat(32) }, nowhere, now) }]);
    expect(ack6[0]).toMatchObject({ status: 'refused', reason: 'the record\'s sign-in stamp names a sign-in this store computer never made' });
    // (7) Outside A's sign-in: made with A's own key (as if a copy of A's page were kept), but after A's sign-in ended,
    //     and before it began.
    const late = scan('grn-late', 's1', 'u-worker');
    const lateAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const ack7 = await post(cookieB, [{ key: late.idempotencyKey, event: late, stamp: stampWith(signInA, late, lateAt) }]);
    expect(ack7[0]).toMatchObject({ status: 'refused', reason: expect.stringContaining('outside u-worker\'s sign-in on this phone') as unknown });
    const early = scan('grn-early', 's1', 'u-worker');
    const earlyAt = new Date(Date.parse(signInA.signedInAt) - 60 * 60_000).toISOString();
    const ack8 = await post(cookieB, [{ key: early.idempotencyKey, event: early, stamp: stampWith(signInA, early, earlyAt) }]);
    expect(ack8[0]).toMatchObject({ status: 'refused', reason: expect.stringContaining('outside u-worker\'s sign-in on this phone') as unknown });
    // (9) Replayed from another phone: A signs in on Dock 2 too, and a record A made on Dock 1 is sent from Dock 2.
    const phone2 = await enrol('hh-02', CODE_2);
    const cookieA2 = await signInOnPhone(device, phone2, 'u-worker', 'warehouse');
    const replay = scan('grn-r', 's1', 'u-worker');
    const ack9 = await post(cookieA2, [{ key: replay.idempotencyKey, event: replay, stamp: stampWith(signInA, replay, signInA.signedInAt) }]);
    expect(ack9[0]).toMatchObject({ status: 'refused', reason: 'the record\'s sign-in stamp was made on another phone' });
    // (10) A stamp that is not whole is refused, never read as "no stamp".
    const broken = scan('grn-x', 's1', 'u-other');
    const ack10 = await post(cookieB, [{ key: broken.idempotencyKey, event: broken, stamp: { v: 1, ref: signInB.ref, userId: 'u-other', madeAt: now, mac: 'zz' } as SignInStamp }]);
    expect(ack10[0]).toMatchObject({ status: 'refused', reason: 'the record\'s sign-in stamp could not be read' });
    // None of the refused records reached the box's disk.
    const keysOnDisk = new Set((await onDisk()).map((e) => e.idempotencyKey));
    for (const e of [asA1, asA2, asA3, altered, ghost, nowhere, late, early, replay, broken]) expect(keysOnDisk.has(e.idempotencyKey)).toBe(false);

    // B's own delivery, stamped under B's sign-in, is sealed for B.
    const queueB = new DeviceOutbox(noDeviceStore(), [], phoneStamper(signInB, new Date().toISOString()));
    const handheldB = new WarehouseSession({ assignmentId: 'A-1', workerId: 'u-other', storeId: 'store-1', bins: [], receivingChecklist: section }, queueB, { now: () => AT });
    queueB.enqueue(scan('grn-own', 's-own', 'u-other')); // a scan command id of its own: head office dedupes by it
    expect(handheldB.completeReceiving({ grnId: 'grn-own', checklist: { itemResults: { temp: 'pass', pack: 'pass' } } }).accepted).toBe(true);
    const itemsB = queueB.pending().map((i) => ({ key: i.key, event: i.event, stamp: i.stamp! }));
    expect(await post(cookieB, itemsB)).toEqual(itemsB.map((i) => ({ key: i.key, status: 'accepted' })));
    expect((await onDisk()).find((e) => e.type === 'ReceivingCompleted' && e.payload['grnId'] === 'grn-own')!.payload['deciderVerified']).toMatchObject({ userId: 'u-other', via: 'phone_pin' });

    // ── Head office: A's receipt is booked complete, in A's name. ──────────────────────────────────────────────────────────
    online = true;
    const pass = await edge.syncOnce!();
    expect(pass.dead).toBe(0);
    const grn = ((await h.request({ method: 'GET', path: '/v1/inventory/goods-receipt/grn-a', userId: 'u-owner', tenantId: A_TENANT })).body as { grn: { governanceFlags: string[]; receivingChecklist?: { performedBy: string; outcome: string } } }).grn;
    expect(grn.receivingChecklist).toMatchObject({ performedBy: 'u-worker', outcome: 'pass' });
    expect(grn.governanceFlags).not.toContain('receiving_checklist_not_accepted');
    expect(grn.governanceFlags).not.toContain('receiving_checklist_missing');
  });
});
