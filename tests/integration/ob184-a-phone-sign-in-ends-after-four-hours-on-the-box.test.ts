import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withTillPeople, issueTillPins, signInOnPhone, signInAtLane, operatorHeader, pinOf, type TillPerson } from '../support/till-operator';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { makeEvent, type DomainEvent } from '../../packages/contracts/src/event';
import { enrolmentCodeHash } from '../../packages/platform-admin/src/device-enrolment';
import { DeviceOutbox, noDeviceStore } from '../../packages/sync/src/device-outbox';
import { WarehouseSession } from '../../apps/warehouse-app/src/warehouse-session';
import { fromHex, hmacSha256Hex, phoneStamper, readPhoneSignIn, stampMessage, type PhoneSignIn, type SignInStamp } from '../../packages/sync/src/sign-in-stamp';
import type { DeviceAck } from '../../packages/sync/src/device-relay';

/**
 * **OB-184 "A" (owner, 17 Oct 2026, "Sign out + 4-hour limit") on the REAL store computer (`startEdge`), no head office.**
 *
 * u-worker (A) signs in on the dock phone at 07:00 on the box's clock. The sign-in the box gives the phone ends at 11:00
 * (the cookie too), and the phone's screen says so. A receives a frozen delivery at 10:59 — the phone stamps it under A's
 * sign-in. At 11:01 the phone's own stamper stamps nothing; a stamp claiming 11:01 under A's sign-in (a kept copy of A's
 * page on a phone whose clock thinks it is still valid) is REFUSED by name. At 11:05 A's sign-in opens nothing and sends
 * nothing; u-other (B) signs in and the queue reaches the box: the 10:59 completion is SEALED for A.
 *
 * OB-185 "A" ("12 hours") unchanged: twelve hours after A's sign-in ENDED (23:00) a record of A's is still taken; after
 * that it is refused by name — nothing silently lost. Synthetic data only; nothing touches production (hard rule #7).
 */

const KEY = ['ob184', 'phone', 'box', 'key'].join('-').padEnd(48, '0');
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0184';
const CODE = 'ABCDE-FGHJK-LMNPQ-RSTUV';
const T0 = Date.parse('2026-10-17T07:00:00.000Z');
const iso = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();
const RECEIVING = {
  checks: [{ checkId: 'dock-receiving', branchId: 'store-1', title: 'Chilled and frozen delivery', kind: 'receiving', graceMinutes: 0, active: true,
    assignedRole: 'store_manager', escalatesTo: 'u-owner', items: [{ itemId: 'temp', label: 'Temperature taken' }, { itemId: 'pack', label: 'Packaging intact' }] }],
  coldChainProductIds: ['p-icecream'],
};
const PEOPLE: readonly TillPerson[] = [
  { userId: 'u-worker', displayName: 'Worker One', permissions: ['inventory.movement.append'] },
  { userId: 'u-other', displayName: 'Other', permissions: ['inventory.movement.append'] },
  { userId: 'u-cashier', displayName: 'Cashier', permissions: ['pos.sale.sync'] },
];

const cleanups: Array<() => Promise<void>> = [];
const savedFetch = globalThis.fetch;
afterEach(async () => {
  globalThis.fetch = savedFetch;
  for (const c of cleanups.splice(0).reverse()) await c();
  vi.useRealTimers();
});

const scan = (grnId: string, receivedBy: string): DomainEvent => makeEvent({
  id: `recv-${grnId}-s1`, type: 'ReceivingScanned', occurredAt: iso(0), idempotencyKey: `recv:${grnId}:s1`, source: 'A-1',
  payload: { grnId, commandId: `${grnId}-s1`, productId: 'p-icecream', batchId: null, quantityMinor: 6, uom: 'EA', source: 'po', poId: null, state: 'on_hand', expiry: null, receivedBy, storeId: 'store-1', at: iso(0), temperatureC: -19 },
});
const stampWith = (signIn: PhoneSignIn, event: DomainEvent, madeAt: string): SignInStamp => {
  const base = { v: 1 as const, ref: signIn.ref, userId: signIn.userId, madeAt };
  return { ...base, mac: hmacSha256Hex(fromHex(signIn.key), stampMessage(base, event)) };
};

describe('OB-184: a phone sign-in ends after four hours on the real box; a till\'s is unchanged', () => {
  it('stamped at 3 h 59 m → sealed for A; at 4 h 01 m → refused by name; OB-185\'s twelve hours run from the four-hour end', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); // the box's clock stands still between the test's moves
    vi.setSystemTime(T0);
    const travel = (minutes: number): void => { vi.setSystemTime(T0 + minutes * 60_000); };
    globalThis.fetch = (async (url: string, init: RequestInit): Promise<Response> => {
      if (url.startsWith('http://127.0.0.1:')) return savedFetch(url, init);
      throw new Error('ENETUNREACH'); // no head office, no internet: the box decides alone (P-01)
    }) as unknown as typeof globalThis.fetch;

    const dir = await mkdtemp(join(tmpdir(), 'sre-ob184-box-'));
    cleanups.push(async () => { await rm(dir, { recursive: true, force: true }); });
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, JSON.stringify(withTillPeople({
      version: 1,
      policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1', branchName: 'Main', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, privacySlaDays: 30, warehouseId: 'wh-1' },
      lossPreventionRules: [],
      receivingChecklist: RECEIVING,
      warehouse: { assignmentId: 'A-1', workerId: 'u-worker', storeId: 'store-1', bins: [{ binId: 'BIN-F', storeId: 'store-1', capacityMinor: 1000, pickable: true, zone: 'frozen' }] },
      devices: [{ deviceId: 'hh-01', kind: 'handheld', status: 'registered', label: 'Dock 1', enrolment: { codeHash: enrolmentCodeHash(CODE), expiresAt: '2099-01-01T00:00:00.000Z' } }],
    }, PEOPLE)), 'utf8');
    await issueTillPins(dir, KEY, PEOPLE.map((p) => p.userId));
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_DEVICE_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile, EDGE_LANE_ID: 'lane-1',
    }, () => {}))!;
    cleanups.push(async () => { await edge.stop(); });
    const device = `http://127.0.0.1:${edge.devices!.port}`;
    const tillWho = async (token: string) => (await savedFetch(`http://127.0.0.1:${edge.lane!.port}/lane/operator`, { headers: operatorHeader(token) })).json() as Promise<{ signedIn: boolean; expiresAt?: string }>;
    const post = async (cookie: string, items: { key: string; event: DomainEvent; stamp?: SignInStamp }[]): Promise<{ status: number; acks: DeviceAck[]; reason?: string }> => {
      const res = await savedFetch(`${device}/lane/outbox`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ source: 'warehouse', items }) });
      const body = (await res.json()) as { acks: DeviceAck[]; reason?: string };
      return { status: res.status, ...body };
    };
    const onDisk = async () => (await readLog(edge.deviceEventsLog.path)).filter((r) => r.ok).map((r) => JSON.parse(r.ok ? r.record : '{}') as DomainEvent<string, Record<string, unknown>>);

    // ── 07:00 A signs in on the phone, and a cashier at the till. ────────────────────────────────────────────────────
    const enrol = await savedFetch(`${device}/device/enrol`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: 'hh-01', code: CODE }) });
    expect(enrol.status).toBe(200);
    const phone = enrol.headers.get('set-cookie')!.split(';')[0]!;
    const signIn = await savedFetch(`${device}/device/sign-in?screen=warehouse`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', cookie: phone }, body: JSON.stringify({ staffId: 'u-worker', pin: pinOf('u-worker') }) });
    const signedIn = (await signIn.json()) as { signedIn: boolean; expiresAt: string };
    expect(signedIn).toMatchObject({ signedIn: true, expiresAt: iso(4 * 60) });
    expect(signIn.headers.get('set-cookie')).toMatch(/; Max-Age=14400$/);
    const cookieA = `${phone}; ${signIn.headers.get('set-cookie')!.split(';')[0]!}`;
    // A till sign-in is unchanged: twelve hours.
    const tillToken = await signInAtLane(edge.lane!.port, 'u-cashier');
    expect(await tillWho(tillToken)).toMatchObject({ signedIn: true, expiresAt: iso(12 * 60) });
    const html = await (await savedFetch(`${device}/warehouse/`, { headers: { accept: 'text/html', cookie: cookieA } })).text();
    expect(html).toContain('Sign-in ends in 4 h 0 min · உள்நுழைவு முடிய 4 மணி 0 நிமிடம்');
    const m = /<script>window\.phoneSignIn = (.*?);<\/script>/.exec(html);
    const signInA = readPhoneSignIn(JSON.parse(m![1]!) as unknown)!;
    expect(signInA).toMatchObject({ userId: 'u-worker', signedInAt: iso(0), expiresAt: iso(4 * 60) });

    // ── 10:59 A works with the phone cut off from the box; the phone stamps each record under A's sign-in. ───────────────
    let phoneNow = iso(4 * 60 - 1);
    const queue = new DeviceOutbox(noDeviceStore(), [], phoneStamper(signInA, signInA.boxNow, () => phoneNow));
    const handheld = new WarehouseSession({ assignmentId: 'A-1', workerId: 'u-worker', storeId: 'store-1', bins: [], receivingChecklist: RECEIVING }, queue, { now: () => phoneNow });
    queue.enqueue(scan('grn-in', 'u-worker'));
    expect(handheld.completeReceiving({ grnId: 'grn-in', checklist: { itemResults: { temp: 'pass', pack: 'pass' } } }).accepted).toBe(true);
    const inTime = queue.pending().map((i) => ({ key: i.key, event: i.event, stamp: i.stamp! }));
    expect(inTime).toHaveLength(2);
    for (const i of inTime) expect(i.stamp).toMatchObject({ userId: 'u-worker', madeAt: iso(4 * 60 - 1) });

    // ── 11:01 the phone's own stamper stamps nothing; a stamp claiming 11:01 is made by hand with A's key. ────────────────
    phoneNow = iso(4 * 60 + 1);
    const lateScan = scan('grn-late', 'u-worker');
    expect(phoneStamper(signInA, signInA.boxNow, () => phoneNow)!(lateScan)).toBeUndefined();
    const late = { key: lateScan.idempotencyKey, event: lateScan, stamp: stampWith(signInA, lateScan, iso(4 * 60 + 1)) };

    // ── 11:05 on the box: A's sign-in has ended. It opens nothing and sends nothing (the phone keeps every item). ─────────
    travel(4 * 60 + 5);
    const shell = await savedFetch(`${device}/warehouse/`, { headers: { accept: 'text/html', cookie: cookieA }, redirect: 'manual' });
    expect(shell.status).toBe(302);
    expect(shell.headers.get('location')).toBe('/device/sign-in?screen=warehouse');
    const refused = await post(cookieA, [...inTime, late]);
    expect(refused.status).toBe(401);
    expect(refused.acks).toEqual([]);
    expect(await onDisk()).toEqual([]);
    // The till's sign-in, made at the same moment, still works.
    expect(await tillWho(tillToken)).toMatchObject({ signedIn: true, expiresAt: iso(12 * 60) });

    // ── B signs in; the queue reaches the box under B: the 10:59 completion is sealed for A, the 11:01 one refused. ───────
    const cookieB = await signInOnPhone(device, phone, 'u-other', 'warehouse');
    const acks = (await post(cookieB, [...inTime, late])).acks;
    expect(acks.slice(0, 2)).toEqual(inTime.map((i) => ({ key: i.key, status: 'accepted' })));
    expect(acks[2]).toEqual({
      key: late.key, status: 'refused',
      reason: `the record was stamped at ${iso(4 * 60 + 1)}, outside u-worker's sign-in on this phone (from ${iso(0)} to ${iso(4 * 60)})`,
    });
    const disk = await onDisk();
    const done = disk.find((e) => e.type === 'ReceivingCompleted' && e.payload['grnId'] === 'grn-in')!;
    expect(done.payload).toMatchObject({ completedBy: 'u-worker', deciderVerified: { userId: 'u-worker', via: 'phone_pin', laneId: 'device:hh-01' } });
    expect(disk.some((e) => e.idempotencyKey === late.key)).toBe(false);

    // ── OB-185: twelve hours after A's sign-in ENDED (23:00) A's work is still taken; a minute later it is refused. ───────
    const keptScan = scan('grn-kept', 'u-worker');
    // Made in the last minute of the sign-in, like the two above: the phone hands records over in the order it made them,
    // and a stamp running backwards against one the box already took from that sign-in is refused (verifier hh NEW-1).
    const kept = { key: keptScan.idempotencyKey, event: keptScan, stamp: stampWith(signInA, keptScan, iso(4 * 60 - 1)) };
    const tooLateScan = scan('grn-too-late', 'u-worker');
    const tooLate = { key: tooLateScan.idempotencyKey, event: tooLateScan, stamp: stampWith(signInA, tooLateScan, iso(4 * 60 - 1)) };
    travel((4 + 12) * 60 - 1);
    const cookieB2 = await signInOnPhone(device, phone, 'u-other', 'warehouse'); // B's first sign-in has ended too
    expect((await post(cookieB2, [kept])).acks).toEqual([{ key: kept.key, status: 'accepted' }]);
    travel((4 + 12) * 60 + 1);
    expect((await post(cookieB2, [tooLate])).acks).toEqual([{ key: tooLate.key, status: 'refused', reason: 'the record names u-worker, who has not been signed in on this phone this shift' }]);
  });
});
