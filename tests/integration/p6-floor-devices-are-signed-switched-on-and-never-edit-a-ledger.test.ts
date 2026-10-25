import { describe, it, expect } from 'vitest';
import { randomUUID, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { storeRules } from '../support/store-rules';
import { deviceBatchMessage } from '../../packages/integration/src/floor-devices';

/**
 * **R8-4 ESL · R8-5 RFID · R8-6 IoT · R8-7 CCTV events (D14-FR-05 · OB-217 · OB-316)** — through the real API, on the
 * in-memory store AND (with DATABASE_URL) real PostgreSQL, head office restarted cold between the writes and the reads.
 *
 * A floor device is registered at a branch, bound to what it watches, with its own Ed25519 key (made at run time — no key
 * is written in the repo). Its batches are believed only from the gateway's machine identity, only when the device's own
 * signature verifies, and only once its kind's rollout switch is on for the branch. An ESL echo becomes a price
 * observation and the confirmation a price push waits for; an RFID count is compared with the book and NEVER moves stock;
 * a sensor reading is a facilities reading; a camera event is metadata linked to the till exceptions at its lanes.
 * Every refusal is kept on the device exceptions list. All hardware is a stand-in.
 */

const backings = useRestartableBackings();
type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;

interface Device { readonly id: string; readonly publicKey: string; readonly privateKey: KeyObject }
const device = (id: string): Device => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { id, publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKey };
};
const signed = (d: Device, events: unknown[]): { events: unknown[]; signature: string } =>
  ({ events, signature: sign(null, Buffer.from(deviceBatchMessage(d.id, events)), d.privateKey).toString('base64') });

describe.each(backings)('floor devices: registered, signed, switched on, never a ledger edit — on $name', ({ harness }) => {
  it('register → refused while off → switched on → ESL echo confirms the push, RFID variance, sensor reading, camera links', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-it', 'platform_admin');
    await h.provisionRole(T, 'u-cash', 'cashier', ['B1']);
    await h.provisionRole(T, 'u-gw', 'floor_device_gateway', ['B1']);
    await h.provisionRole(T, 'u-box', 'store_computer', ['B1']);
    const scoped = new Set(['u-cash', 'u-gw', 'u-box']);
    const call = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown, query?: Record<string, string>): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(scoped.has(userId) ? { branchId: 'B1' } : {}), ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Record<string, unknown>> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r.body as Record<string, unknown>; };

    // The shop: a company, branch B1 with its rules and a till lane, a product sold by the each and one by weight.
    await ok(call('POST', '/v1/org/nodes/C1', 'u-it', { kind: 'company', name: 'SRE Retail' }), 'company');
    await ok(call('POST', '/v1/org/nodes/B1', 'u-it', { kind: 'branch', name: 'Main store', parentId: 'C1', companyId: 'C1' }), 'branch');
    await storeRules(h, T, 'u-owner', 'B1', 0);
    await ok(call('POST', '/v1/platform/devices/lane-1/register', 'u-owner', { branchId: 'B1', kind: 'pos_lane', label: 'Lane 1' }), 'lane');
    await ok(call('POST', '/v1/catalogue/tax-classes/34011190/rates/2017-07-01', 'u-owner', { rateBps: 1_800 }), 'tax');
    await ok(call('POST', '/v1/catalogue/products/p-soap/publish', 'u-owner', { product: { sku: 'SKU-SOAP', name: 'Soap 100g', baseUom: 'ea', primaryCategoryId: 'home', taxClass: '34011190', lifecycle: 'draft' }, categories: [{ categoryId: 'home', name: 'Home', parentId: null }] }), 'soap');
    await ok(call('POST', '/v1/catalogue/products/p-rice/publish', 'u-owner', { product: { sku: 'SKU-RICE', name: 'Loose rice', baseUom: 'kg', primaryCategoryId: 'home', taxClass: '34011190', lifecycle: 'draft' }, categories: [{ categoryId: 'home', name: 'Home', parentId: null }] }), 'rice');
    await ok(call('POST', '/v1/inventory/movements', 'u-owner', { movementId: 'soap-in', productId: 'p-soap', locationId: 'B1', kind: 'received', quantityMinor: 40, uom: 'ea', occurredAt: new Date().toISOString(), enteredBy: 'u-owner' }), 'stock');
    await ok(call('POST', '/v1/facilities/equipment/COLD-1/range', 'u-owner', { branchId: 'B1', name: 'Dairy chiller', minTenthsC: 0, maxTenthsC: 50, graceMinutes: 30 }), 'chiller');

    const esl1 = device('esl-1'); const esl2 = device('esl-2'); const rfid = device('rfid-1'); const iot = device('iot-1'); const cam = device('cam-1');
    const reg = (d: Device, body: Record<string, unknown>, who = 'u-it') => call('POST', `/v1/devices/floor/${d.id}`, who, { branchId: 'B1', vendor: 'stand-in', publicKey: d.publicKey, ...body });

    // ── Registration refusals, each by name; nothing registered ──
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(codeOf(await call('POST', '/v1/devices/floor/esl-x', 'u-it', { kind: 'esl_label', branchId: 'B1', label: 'x', vendor: 'stand-in', publicKey: rsa, productId: 'p-soap', shelfAddress: 'A1-01' }))).toBe('device_key_not_ed25519');
    expect(codeOf(await reg(esl1, { kind: 'esl_label', label: 'Soap label', productId: 'p-soap' }))).toBe('device_binding_not_given');
    expect(codeOf(await call('POST', '/v1/devices/floor/esl-y', 'u-it', { kind: 'esl_label', branchId: 'B9', label: 'y', vendor: 'stand-in', publicKey: esl1.publicKey, productId: 'p-soap', shelfAddress: 'A1-01' }))).toBe('unknown_branch');
    expect(codeOf(await reg(esl1, { kind: 'smart_shelf', label: 'x' }))).toBe('not_a_floor_device_kind');
    expect((await reg(esl1, { kind: 'esl_label', label: 'Soap label', productId: 'p-soap', shelfAddress: 'A1-01' }, 'u-cash')).status).toBe(403);

    const first = await ok(reg(esl1, { kind: 'esl_label', label: 'Soap label 1', productId: 'p-soap', shelfAddress: 'A1-01' }), 'esl-1');
    expect(first).toMatchObject({ switchKey: 'esl', switchOn: false, hardware: 'built with a stand-in, not verified on hardware' });
    expect(codeOf(await reg(esl1, { kind: 'esl_label', label: 'again', productId: 'p-soap', shelfAddress: 'A1-01' }))).toBe('device_already_registered');
    await ok(reg(esl2, { kind: 'esl_label', label: 'Soap label 2', productId: 'p-soap', shelfAddress: 'A1-02' }), 'esl-2');
    await ok(reg(rfid, { kind: 'rfid_reader', label: 'Back store reader', locationId: 'B1' }), 'rfid');
    await ok(reg(iot, { kind: 'iot_sensor', label: 'Chiller probe', assetId: 'COLD-1' }), 'iot');
    await ok(reg(cam, { kind: 'cctv_source', label: 'Lane camera', cameraId: 'CAM-1', laneIds: ['lane-1'] }), 'cam');

    const now = new Date();
    const at = (minutesAgo: number): string => new Date(now.getTime() - minutesAgo * 60_000).toISOString();
    const send = (d: Device, events: unknown[], who = 'u-gw') => call('POST', `/v1/devices/floor/${d.id}/events`, who, signed(d, events));

    // ── Every kind is OFF until the owner switches it on for the branch (OB-316): heard, refused, kept ──
    const echo = { eventId: 'e1', type: 'esl.echo', at: at(1), productId: 'p-soap', displayedPriceMinor: 4_500, batteryPercent: 80 };
    expect(codeOf(await send(esl1, [echo]))).toBe('feature_switched_off');
    // Only the gateway's machine identity carries events — the owner holds the permission (to approve the grant) but is refused.
    expect(codeOf(await send(esl1, [echo], 'u-owner'))).toBe('not_the_device_gateway');
    expect((await send(esl1, [echo], 'u-cash')).status).toBe(403);
    for (const key of ['esl', 'rfid', 'iot', 'cctv']) await ok(call('PUT', `/v1/platform/rollout/${key}`, 'u-it', { branchId: 'B1', enabled: true, reason: `${key} trial in B1` }), `switch ${key}`);

    // ── A batch is believed only when THAT device signed exactly these bytes ──
    const forged = signed(esl2, [echo]);
    expect(codeOf(await call('POST', '/v1/devices/floor/esl-1/events', 'u-gw', forged))).toBe('device_signature_not_verified');
    const tampered = signed(esl1, [echo]);
    expect(codeOf(await call('POST', '/v1/devices/floor/esl-1/events', 'u-gw', { ...tampered, events: [{ ...echo, displayedPriceMinor: 1 }] }))).toBe('device_signature_not_verified');
    expect(codeOf(await send(device('ghost'), [echo]))).toBe('device_not_registered');

    // ── R8-4: a price change pushes the new price to both labels (stand-in vendor); only an echo of it confirms ──
    const change = await ok(call('POST', '/v1/prices/changes', 'u-owner', { productId: 'p-soap', priceMinor: 4_500, mrpMinor: 6_000, costMinor: 2_000, currency: 'INR', marginFloorBps: 0 }), 'price change');
    expect(change['electronicLabels']).toEqual([expect.objectContaining({ branchId: 'B1', pushed: true })]);
    const echoNow = { ...echo, at: new Date(Date.now() + 1_000).toISOString() };
    const one = await ok(send(esl1, [echoNow, { ...echoNow, eventId: 'e2', productId: 'p-rice' }]), 'echo');
    expect(one).toMatchObject({ accepted: 1, refused: [{ eventId: 'e2', code: 'label_shows_another_product' }] });
    // A re-sent batch is the same facts, once.
    expect(await ok(send(esl1, [echoNow]), 'again')).toMatchObject({ accepted: 0, duplicates: ['e1'] });

    // ── R8-5: an RFID count against the book — a variance for a person, the stock untouched ──
    const rf = await ok(send(rfid, [{ eventId: 'r1', type: 'rfid.read', at: at(2), productId: 'p-soap', countedUnits: 37 }, { eventId: 'r2', type: 'rfid.read', at: at(2), productId: 'p-rice', countedUnits: 5 }]), 'rfid');
    expect(rf['accepted']).toBe(2);
    // ── R8-6: a sensor reading is a facilities reading (source sensor); one above range puts the chiller out of range ──
    const t1 = await ok(send(iot, [{ eventId: 'i1', type: 'iot.reading', at: at(3), tenthsC: 42 }, { eventId: 'i2', type: 'iot.reading', at: at(3), tenthsC: 42, humidity: 70 }]), 'iot');
    expect(t1).toMatchObject({ accepted: 1, refused: [{ eventId: 'i2', code: 'field_not_allowed' }] });
    // ── R8-7: camera metadata only — footage or a face is refused by name; an event links the void inside its period ──
    await ok(call('POST', '/v1/loss-prevention/activity/act-1/synced', 'u-box', { activityId: 'act-1', kind: 'void', laneId: 'lane-1', cashierId: 'u-cash', billRef: 'bill-1', lineId: 'l1', productId: 'p-soap', description: 'Soap 100g', valueMinor: 4_500, reason: 'customer changed mind', at: at(5), storeId: 'B1' }), 'void');
    const camRes = await ok(send(cam, [
      { eventId: 'c1', type: 'cctv.event', at: at(4), from: at(6), to: at(4), eventKind: 'lane_activity' },
      { eventId: 'c2', type: 'cctv.event', at: at(4), from: at(6), to: at(4), eventKind: 'lane_activity', image: 'data:…' },
      { eventId: 'c3', type: 'cctv.event', at: at(4), from: at(6), to: at(4), eventKind: 'person', faceId: 'f-9' },
    ]), 'camera');
    expect(camRes).toMatchObject({ accepted: 1 });
    expect((camRes['refused'] as { code: string }[]).map((r) => r.code)).toEqual(['footage_or_identity_not_kept', 'footage_or_identity_not_kept']);

    h = harness(h); // ── head office COLD ──

    const pushes = await ok(call('GET', '/v1/devices/esl/pushes', 'u-owner', undefined, { branchId: 'B1' }), 'pushes') as { pushes: { productId: string; confirmed: string[]; unconfirmed: string[]; safeToChangeAtTill: boolean; push: { pushId: string; commands: { accepted: boolean }[] } }[] };
    expect(pushes.pushes).toHaveLength(1);
    expect(pushes.pushes[0]).toMatchObject({ productId: 'p-soap', confirmed: ['esl-1'], unconfirmed: ['esl-2'], safeToChangeAtTill: false });
    expect(pushes.pushes[0]!.push.commands.every((c) => c.accepted)).toBe(true);
    // A retry sends the SAME price to the label that has not confirmed — never a new one.
    const retry = await ok(call('POST', `/v1/devices/esl/pushes/${pushes.pushes[0]!.push.pushId}/retry`, 'u-owner', {}), 'retry');
    expect(retry).toMatchObject({ retried: true, sentTo: ['esl-2'], priceMinor: 4_500 });
    expect((await call('POST', `/v1/devices/esl/pushes/${pushes.pushes[0]!.push.pushId}/retry`, 'u-cash', {})).status).toBe(403);
    // The echo is a price observation on the ESL surface (D-7): agreeing, it raises nothing for the ESL surface…
    type Ageing = { exceptions: { productId: string; surface: string; kind: string; evidence: string }[] };
    const eslExceptions = async (): Promise<Ageing['exceptions']> => ((await ok(call('GET', '/v1/pricing/integrity/ageing', 'u-owner', undefined, { branchId: 'B1' }), 'ageing')) as unknown as Ageing).exceptions.filter((x) => x.surface === 'esl');
    expect(await eslExceptions()).toEqual([]);
    // …and a label that later shows LESS than the till is an exception for a person, and no longer confirms the push.
    await ok(send(esl1, [{ ...echo, eventId: 'e3', at: new Date(Date.now() + 2_000).toISOString(), displayedPriceMinor: 4_000 }]), 'mismatch');
    expect(await eslExceptions()).toEqual([expect.objectContaining({ productId: 'p-soap', surface: 'esl', evidence: expect.stringContaining('esl-1') })]);
    const after = await ok(call('GET', '/v1/devices/esl/pushes', 'u-owner', undefined, { branchId: 'B1' }), 'pushes after') as { pushes: { confirmed: string[]; push: { retryOf?: string } }[] };
    expect(after.pushes.find((p) => p.push.retryOf === undefined)!.confirmed).toEqual([]);

    const rfidView = await ok(call('GET', '/v1/devices/rfid/variances', 'u-owner', undefined, { branchId: 'B1' }), 'variances') as { variances: Record<string, unknown>[]; notComparable: Record<string, unknown>[] };
    expect(rfidView.variances).toEqual([expect.objectContaining({ productId: 'p-soap', locationId: 'B1', countedUnits: 37, bookUnits: 40, differenceUnits: -3, state: 'variance' })]);
    expect(rfidView.notComparable).toEqual([expect.objectContaining({ productId: 'p-rice', state: 'not_comparable' })]);
    // Hard rule #2: the reader changed nothing — the book still says 40.
    const avail = await ok(call('GET', '/v1/inventory/availability', 'u-owner', undefined, { productId: 'p-soap' }), 'availability') as { rows: { locationId: string; onHandMinor: number }[] };
    expect(avail.rows.filter((r) => r.locationId === 'B1').map((r) => r.onHandMinor)).toEqual([40]);

    const chiller = await ok(call('GET', '/v1/facilities/equipment/COLD-1', 'u-owner', undefined, { asOf: new Date().toISOString() }), 'chiller');
    expect(JSON.stringify(chiller)).toMatch(/42/);

    const links = await ok(call('GET', '/v1/devices/cctv/links', 'u-owner', undefined, { branchId: 'B1', day: at(4).slice(0, 10) }), 'links') as { links: { eventId: string; exceptions: { ref: string }[]; cctvReference: Record<string, string> }[] };
    expect(links.links).toEqual([expect.objectContaining({ eventId: 'c1', exceptions: [expect.objectContaining({ ref: 'till-activity:act-1' })], cctvReference: expect.objectContaining({ cameraId: 'CAM-1' }) })]);
    expect((await call('GET', '/v1/devices/cctv/links', 'u-cash', undefined, { branchId: 'B1', day: at(4).slice(0, 10) })).status).toBe(403);

    // The list says each device's switch, when it was last heard, and that it is a stand-in; nothing is hidden.
    const fleet = await ok(call('GET', '/v1/devices/floor', 'u-owner', undefined, { branchId: 'B1' }), 'fleet') as { devices: { deviceId: string; switchOn: boolean; lastHeardAt: string | null; hardware: string }[] };
    expect(fleet.devices.map((d) => [d.deviceId, d.switchOn, d.lastHeardAt !== null])).toEqual([['cam-1', true, true], ['esl-1', true, true], ['esl-2', true, false], ['iot-1', true, true], ['rfid-1', true, true]]);
    const exceptions = await ok(call('GET', '/v1/devices/floor/exceptions', 'u-owner', undefined, { branchId: 'B1' }), 'exceptions') as { refusedBatches: { code: string }[]; refusedEvents: { code: string }[] };
    expect(exceptions.refusedBatches.map((r) => r.code).sort()).toEqual(['device_signature_not_verified', 'device_signature_not_verified', 'feature_switched_off']);
    expect(exceptions.refusedEvents.map((r) => r.code).sort()).toEqual(['field_not_allowed', 'footage_or_identity_not_kept', 'footage_or_identity_not_kept', 'label_shows_another_product']);

    // A blocked device is refused (and kept); retired is final.
    await ok(call('POST', '/v1/devices/floor/esl-2/status', 'u-it', { status: 'blocked', reason: 'battery door broken' }), 'block');
    expect(codeOf(await send(esl2, [{ ...echo, eventId: 'e9' }]))).toBe('device_blocked');
    await ok(call('POST', '/v1/devices/floor/esl-2/status', 'u-it', { status: 'retired', reason: 'replaced' }), 'retire');
    expect(codeOf(await call('POST', '/v1/devices/floor/esl-2/status', 'u-it', { status: 'active', reason: 'oops' }))).toBe('device_retired');

    // Switched off again: the next batch is refused, the earlier facts stay.
    await ok(call('PUT', '/v1/platform/rollout/rfid', 'u-it', { branchId: 'B1', enabled: false, reason: 'reader trial paused' }), 'rfid off');
    expect(codeOf(await send(rfid, [{ eventId: 'r9', type: 'rfid.read', at: at(1), productId: 'p-soap', countedUnits: 40 }]))).toBe('feature_switched_off');
    expect(((await ok(call('GET', '/v1/devices/rfid/variances', 'u-owner', undefined, { branchId: 'B1' }), 'still')) as { variances: unknown[] }).variances).toHaveLength(1);
  }, 120_000);
});
