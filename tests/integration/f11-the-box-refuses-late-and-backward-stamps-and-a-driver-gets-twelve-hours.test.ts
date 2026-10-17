import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withTillPeople, issueTillPins, signInOnPhone, pinOf, type TillPerson } from '../support/till-operator';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { makeEvent, type DomainEvent } from '../../packages/contracts/src/event';
import { enrolmentCodeHash } from '../../packages/platform-admin/src/device-enrolment';
import { DeviceOutbox, noDeviceStore } from '../../packages/sync/src/device-outbox';
import { drainToBox, type FetchLike } from '../../packages/sync/src/device-drain';
import { fromHex, hmacSha256Hex, phoneStamping, readPhoneSignIn, stampMessage, type PhoneSignIn, type SignInStamp } from '../../packages/sync/src/sign-in-stamp';
import type { DeviceAck } from '../../packages/sync/src/device-relay';

/**
 * **Follow-up F11 on the REAL store computer (`startEdge`), no head office: the handheld verifier's findings, closed.**
 *
 *   NEW-2 (OB-185 "A", "12 hours") — u-worker (A) signs in on the dock phone on Monday and counts a shelf; the phone keeps
 *     the record. On Thursday, 68 hours after that sign-in ended, A signs in on the same phone again and the phone hands
 *     the Monday record over: the box REFUSES it with the OB-185 reason, and the phone's own queue holds it as refused with
 *     those words (a person must look) — never sealed, never dropped.
 *   NEW-1 — a record stamped earlier than one the box already took from the same sign-in (the phone's clock turned back
 *     between the two) is refused by name.
 *   NEW-3 / OB-187 "A" ("Driver gets 12 hours") — the driver screen's sign-in lasts twelve hours (the cookie too, and the
 *     strip says so); a stop recorded at 11 h 59 m is taken as the driver's, one stamped at 12 h 01 m is refused by name.
 *     The warehouse and picker screens keep four hours.
 *   L1 — every hand-over reply (taken, or "nobody is signed in") carries the box's clock.
 *
 * Synthetic data only; nothing touches production (hard rule #7).
 */

const KEY = ['f11', 'phone', 'box', 'key'].join('-').padEnd(48, '0');
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0f11';
const CODE = 'ABCDE-FGHJK-LMNPQ-RSTUV';
const T0 = Date.parse('2026-10-12T02:30:00.000Z'); // Monday 08:00 in the shop
const iso = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();
const PEOPLE: readonly TillPerson[] = [
  { userId: 'u-worker', displayName: 'Worker One', permissions: ['inventory.movement.append', 'fulfilment.pack.record'] },
  { userId: 'u-driver', displayName: 'Driver One', permissions: ['delivery.attempt.record'] },
  { userId: 'u-driver2', displayName: 'Driver Two', permissions: ['delivery.attempt.record'] },
];
const OB185 = (who: string, endedAt: string): string => `the record was made under ${who}'s sign-in on this phone, which ended at ${endedAt}, and it reached this store computer more than 12 hours later (OB-185) — too late to be taken; a person must look at it`;

const cleanups: Array<() => Promise<void>> = [];
const savedFetch = globalThis.fetch;
afterEach(async () => {
  globalThis.fetch = savedFetch;
  for (const c of cleanups.splice(0).reverse()) await c();
  vi.useRealTimers();
});

const count = (countId: string, counterId: string): DomainEvent => makeEvent({
  id: `count-${countId}`, type: 'StockCounted', occurredAt: iso(0), idempotencyKey: `count:${countId}`, source: 'A-1',
  payload: { countId, counterId, productId: 'p-rice', binId: 'BIN-A', countedMinor: 12, storeId: 'store-1' },
});
const stop = (stopId: string, driverId: string): DomainEvent => makeEvent({
  id: `R-1:${stopId}:delivered`, type: 'DeliveryStopUpdated', occurredAt: iso(0), idempotencyKey: `stop:R-1:${stopId}:delivered`, source: 'R-1',
  payload: { routeId: 'R-1', driverId, stopId, orderRef: `ORD-${stopId}`, state: 'delivered', codExpectedMinor: 0, codCollectedMinor: 0, codMethod: null, proofKind: 'otp', geofenceMismatch: false, failureReason: null, contributionFlag: null, currency: 'INR' },
});
const stampWith = (signIn: PhoneSignIn, event: DomainEvent, madeAt: string): SignInStamp => {
  const base = { v: 1 as const, ref: signIn.ref, userId: signIn.userId, madeAt };
  return { ...base, mac: hmacSha256Hex(fromHex(signIn.key), stampMessage(base, event)) };
};

describe('F11: the box refuses late and backward stamps, and a driver\'s sign-in lasts twelve hours', () => {
  async function aBox(): Promise<{ edge: EdgeProcess; device: string; phone: string; travel: (minutes: number) => void; onDisk: () => Promise<DomainEvent[]> }> {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const travel = (minutes: number): void => { vi.setSystemTime(T0 + minutes * 60_000); };
    globalThis.fetch = (async (url: string, init: RequestInit): Promise<Response> => {
      if (url.startsWith('http://127.0.0.1:')) return savedFetch(url, init);
      throw new Error('ENETUNREACH'); // no head office: the box decides alone (P-01)
    }) as unknown as typeof globalThis.fetch;
    const dir = await mkdtemp(join(tmpdir(), 'sre-f11-box-'));
    cleanups.push(async () => { await rm(dir, { recursive: true, force: true }); });
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, JSON.stringify(withTillPeople({
      version: 1,
      policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1', branchName: 'Main', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, privacySlaDays: 30, warehouseId: 'wh-1' },
      lossPreventionRules: [],
      warehouse: { assignmentId: 'A-1', workerId: 'u-worker', storeId: 'store-1', bins: [{ binId: 'BIN-A', storeId: 'store-1', capacityMinor: 1000, pickable: true, zone: 'ambient' }] },
      devices: [{ deviceId: 'hh-01', kind: 'handheld', status: 'registered', label: 'Dock 1', enrolment: { codeHash: enrolmentCodeHash(CODE), expiresAt: '2099-01-01T00:00:00.000Z' } }],
    }, PEOPLE)), 'utf8');
    await issueTillPins(dir, KEY, PEOPLE.map((p) => p.userId));
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_DEVICE_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile, EDGE_LANE_ID: 'lane-1',
    }, () => {}))!;
    cleanups.push(async () => { await edge.stop(); });
    const device = `http://127.0.0.1:${edge.devices!.port}`;
    const enrol = await savedFetch(`${device}/device/enrol`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: 'hh-01', code: CODE }) });
    expect(enrol.status).toBe(200);
    const phone = enrol.headers.get('set-cookie')!.split(';')[0]!;
    const onDisk = async (): Promise<DomainEvent[]> => (await readLog(edge.deviceEventsLog.path)).filter((r) => r.ok).map((r) => JSON.parse(r.ok ? r.record : '{}') as DomainEvent);
    return { edge, device, phone, travel, onDisk };
  }
  /** The page the box serves this person on this screen: its sign-in to stamp under. */
  const pageOf = async (device: string, cookie: string, screen: string): Promise<{ html: string; signIn: PhoneSignIn }> => {
    const html = await (await savedFetch(`${device}/${screen}/`, { headers: { accept: 'text/html', cookie } })).text();
    const m = /<script>window\.phoneSignIn = (.*?);<\/script>/.exec(html);
    return { html, signIn: readPhoneSignIn(JSON.parse(m![1]!) as unknown)! };
  };
  /** The phone's own drain, under this cookie. */
  const phoneFetch = (cookie: string): FetchLike => async (url, init) => savedFetch(url, { ...init, headers: { ...init.headers, cookie } });
  const post = async (device: string, cookie: string, source: string, items: { key: string; event: DomainEvent; stamp?: SignInStamp }[]): Promise<{ status: number; acks: DeviceAck[]; boxNow?: string }> => {
    const res = await savedFetch(`${device}/lane/outbox`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ source, items }) });
    return { status: res.status, ...((await res.json()) as { acks: DeviceAck[]; boxNow?: string }) };
  };

  it('NEW-2: a record made under Monday\'s sign-in reaches the box on Thursday under the SAME person\'s new sign-in — refused with the OB-185 words, held on the phone as refused', async () => {
    const { device, phone, travel, onDisk } = await aBox();
    const cookieMon = await signInOnPhone(device, phone, 'u-worker', 'warehouse');
    const { signIn } = await pageOf(device, cookieMon, 'warehouse');
    expect(signIn).toMatchObject({ userId: 'u-worker', signedInAt: iso(0), expiresAt: iso(4 * 60) });
    // Monday 08:30: A counts a shelf with the phone cut off; the phone stamps it under Monday's sign-in and keeps it.
    let phoneNow = iso(30);
    const queue = new DeviceOutbox(noDeviceStore(), [], phoneStamping(signIn, signIn.boxNow, () => phoneNow)!.stamp);
    queue.enqueue(count('mon-1', 'u-worker'));
    expect(queue.pending()[0]!.stamp).toMatchObject({ userId: 'u-worker', ref: signIn.ref, madeAt: iso(30) });

    // Thursday 08:30 — 68.5 hours after Monday's sign-in ended at 12:00 — A signs in on the same phone again.
    travel(72 * 60 + 30);
    phoneNow = iso(72 * 60 + 30);
    const cookieThu = await signInOnPhone(device, phone, 'u-worker', 'warehouse');
    const result = await drainToBox({ outbox: queue, boxBase: device, source: 'warehouse', fetch: phoneFetch(cookieThu) });
    expect(result).toMatchObject({ attempted: 1, handed: 0, refused: 1, offline: false });
    expect(queue.find('count:mon-1')).toMatchObject({ state: 'dead_letter', reason: `refused by the store computer: ${OB185('u-worker', iso(4 * 60))}` });
    expect(await onDisk()).toEqual([]);
    // A's Thursday work is taken as A's, as ever.
    const { signIn: thursday } = await pageOf(device, cookieThu, 'warehouse');
    const fresh = new DeviceOutbox(noDeviceStore(), [], phoneStamping(thursday, thursday.boxNow, () => phoneNow)!.stamp);
    fresh.enqueue(count('thu-1', 'u-worker'));
    expect(await drainToBox({ outbox: fresh, boxBase: device, source: 'warehouse', fetch: phoneFetch(cookieThu) })).toMatchObject({ handed: 1 });
    expect((await onDisk()).map((e) => e.idempotencyKey)).toEqual(['count:thu-1']);
  });

  it('NEW-1: a stamp earlier than one the box already took from that sign-in is refused by name; L1: every reply carries the box\'s clock', async () => {
    const { device, phone, travel, onDisk } = await aBox();
    const nobody = await post(device, phone, 'warehouse', []);
    expect(nobody).toMatchObject({ status: 401, boxNow: iso(0) });
    const cookie = await signInOnPhone(device, phone, 'u-worker', 'warehouse');
    const { signIn } = await pageOf(device, cookie, 'warehouse');
    travel(3 * 60 + 5);
    const later = count('c-later', 'u-worker');
    const earlier = count('c-earlier', 'u-worker');
    const taken = await post(device, cookie, 'warehouse', [{ key: later.idempotencyKey, event: later, stamp: stampWith(signIn, later, iso(3 * 60)) }]);
    expect(taken).toEqual({ status: 200, acks: [{ key: later.idempotencyKey, status: 'accepted' }], boxNow: iso(3 * 60 + 5) });
    const back = await post(device, cookie, 'warehouse', [{ key: earlier.idempotencyKey, event: earlier, stamp: stampWith(signIn, earlier, iso(60)) }]);
    expect(back.acks).toEqual([{
      key: earlier.idempotencyKey, status: 'refused',
      reason: `the record was stamped at ${iso(60)}, earlier than a record made before it under u-worker's sign-in on this phone (${iso(3 * 60)}) — the phone's clock was turned back; a person must look at it`,
    }]);
    // The first one handed over again (its reply lost) is the same fact, not a refusal.
    expect((await post(device, cookie, 'warehouse', [{ key: later.idempotencyKey, event: later, stamp: stampWith(signIn, later, iso(3 * 60)) }])).acks).toEqual([{ key: later.idempotencyKey, status: 'duplicate' }]);
    expect((await onDisk()).map((e) => e.idempotencyKey)).toEqual(['count:c-later']);
  });

  it('NEW-3 / OB-187: the driver\'s sign-in lasts twelve hours — a stop at 11 h 59 m is the driver\'s, one stamped at 12 h 01 m refused; warehouse and picker keep four', async () => {
    const { device, phone, travel, onDisk } = await aBox();
    // Warehouse and picker: four hours, the cookie too (OB-184).
    for (const screen of ['warehouse', 'picker'] as const) {
      const res = await savedFetch(`${device}/device/sign-in?screen=${screen}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', cookie: phone }, body: JSON.stringify({ staffId: 'u-worker', pin: pinOf('u-worker') }) });
      expect(await res.json()).toMatchObject({ signedIn: true, expiresAt: iso(4 * 60) });
      expect(res.headers.get('set-cookie')).toMatch(/; Max-Age=14400$/);
    }
    // The driver: twelve.
    const res = await savedFetch(`${device}/device/sign-in?screen=driver`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', cookie: phone }, body: JSON.stringify({ staffId: 'u-driver', pin: pinOf('u-driver') }) });
    expect(await res.json()).toMatchObject({ signedIn: true, expiresAt: iso(12 * 60), next: '/driver/' });
    expect(res.headers.get('set-cookie')).toMatch(/; Max-Age=43200$/);
    const cookieD = `${phone}; ${res.headers.get('set-cookie')!.split(';')[0]!}`;
    const { html, signIn } = await pageOf(device, cookieD, 'driver');
    expect(html).toContain('Sign-in ends in 12 h 0 min · உள்நுழைவு முடிய 12 மணி 0 நிமிடம்');
    expect(signIn).toMatchObject({ userId: 'u-driver', expiresAt: iso(12 * 60) });

    // On the road, off the shop wifi: at 11 h 59 m the phone still stamps; at 12 h 01 m it stamps nothing.
    let phoneNow = iso(12 * 60 - 1);
    const stamping = phoneStamping(signIn, signIn.boxNow, () => phoneNow)!;
    const queue = new DeviceOutbox(noDeviceStore(), [], stamping.stamp);
    queue.enqueue(stop('s1', 'u-driver'));
    expect(queue.find('stop:R-1:s1:delivered')!.stamp).toMatchObject({ userId: 'u-driver', madeAt: iso(12 * 60 - 1) });
    phoneNow = iso(12 * 60 + 1);
    const lateStop = stop('s2', 'u-driver');
    expect(stamping.stamp(lateStop)).toBeUndefined();
    const forged = { key: lateStop.idempotencyKey, event: lateStop, stamp: stampWith(signIn, lateStop, iso(12 * 60 + 1)) };

    // Back at the shop at 12 h 05 m: the driver's sign-in has ended; the next driver signs in and the queue goes over.
    travel(12 * 60 + 5);
    const cookieD2 = await signInOnPhone(device, phone, 'u-driver2', 'driver');
    const s1 = queue.pending().map((i) => ({ key: i.key, event: i.event, stamp: i.stamp! }));
    const acks = (await post(device, cookieD2, 'driver', [...s1, forged])).acks;
    expect(acks).toEqual([
      { key: 'stop:R-1:s1:delivered', status: 'accepted' },
      { key: lateStop.idempotencyKey, status: 'refused', reason: `the record was stamped at ${iso(12 * 60 + 1)}, outside u-driver's sign-in on this phone (from ${iso(0)} to ${iso(12 * 60)})` },
    ]);
    expect((await onDisk()).map((e) => [e.idempotencyKey, (e.payload as { driverId: string }).driverId])).toEqual([['stop:R-1:s1:delivered', 'u-driver']]);
  });
});
