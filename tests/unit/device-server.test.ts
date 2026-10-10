import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDeviceServer, DEVICE_HOST, HANDHELD_SCREENS, DEVICE_COOKIE, cookieValue, type DeviceServer, homeAfterEnrol } from '../../edge/store-edge/src/device-server';
import { DeviceEnrolments, type PackDevice } from '../../edge/store-edge/src/device-enrolments';
import { enrolmentCodeHash } from '../../packages/platform-admin/src/device-enrolment';
import { readPack } from '../../edge/store-edge/src/store-pack';
import type { ScreenInput } from '../../edge/store-edge/src/screen-data';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { makeEvent } from '../../packages/contracts/src/event';
import type { RelayReply } from '../../packages/sync/src/device-relay';
import { TillOperators, loadTillCredentials } from '../../edge/store-edge/src/till-operators';
import { phoneOperatorsOf } from '../../edge/store-edge/src/handheld-sign-in';
import { tillPinKey } from '../../packages/identity/src/till-pin';
import { peopleFrom, permissionsOf } from '../../edge/store-edge/src/screen-navigation';
import { withTillPeople, issueTillPins, pinOf } from '../support/till-operator';

/**
 * **The store box's DEVICE socket serves the handheld screens and the device routes to ENROLLED handhelds, and nothing
 * to anyone else (SP-3a · ADR-0019 · S1 · hard rules #4/#10).**
 *
 * The lane socket and the screens server are loopback by design; this is the one door on the shop network, so what it
 * refuses is the proof. A browser with no credential is sent to the enrolment page and gets no shell; a script with no
 * credential gets 403 and no data; the wrong code enrols nothing; the right code sets an HttpOnly SameSite=Strict
 * cookie and the shell is then served with its assignment and `laneWriteBase = ''` (same origin); the till, the manager
 * and the ERP screens are 404 by name; a batch claiming to be the `manager` is refused before the box is asked; a
 * device the pack now blocks is refused at its next request; and the default bind is loopback.
 */

const NOW = '2026-09-30T10:00:00.000Z';
const CODE = 'ABCDE-FGHJK-LMNPQ-RSTUV';
const SIGNING = ['device', 'socket', 'unit', 'key'].join('-').padEnd(48, '0');
const BASE_PACK = {
  version: 1,
  policies: { storeId: 'store-1', branchId: 'store-1', branchName: 'Main', tradingDayCutoff: '02:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, privacySlaDays: 30, warehouseId: 'wh-1' },
  warehouse: {
    assignmentId: 'A-1', workerId: 'u-worker', storeId: 'store-1',
    bins: [{ binId: 'BIN-A', storeId: 'store-1', capacityMinor: 1000, pickable: true, zone: 'ambient' }],
    goodsIn: [{ productId: 'p-good', batchId: null, quantityMinor: 6, uom: 'EA', state: 'on_hand', expiry: null }],
  },
  devices: [
    { deviceId: 'hh-01', kind: 'handheld', status: 'registered', label: 'Racking 1', enrolment: { codeHash: enrolmentCodeHash(CODE), expiresAt: '2026-10-01T10:00:00.000Z' } },
    { deviceId: 'till-1', kind: 'pos_lane', status: 'registered', label: 'Lane 1' },
  ],
};
// DF-3-c (OB-28 "A"): the people who may hold a phone — the warehouse worker, with the job's permission head office re-checks.
const PACK = withTillPeople(BASE_PACK, [
  { userId: 'u-worker', displayName: 'Worker One', permissions: ['inventory.movement.append'] },
]) as typeof BASE_PACK;

describe('the device socket', () => {
  const dirs: string[] = [];
  const servers: DeviceServer[] = [];
  const registers: DeviceEnrolments[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await s.stop();
    for (const r of registers.splice(0)) await r.close();
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  interface Started { base: string; relayed: { source: string; deviceId: string; items: readonly unknown[]; phoneHolder?: string }[]; devices: { current: PackDevice[] | undefined }; server: DeviceServer }
  async function start(opts: { host?: string; devices?: PackDevice[] | undefined } = {}): Promise<Started> {
    const dir = await mkdtemp(join(tmpdir(), 'sre-device-socket-'));
    dirs.push(dir);
    const enrolments = await DeviceEnrolments.open({ dataDir: dir, capacityBytes: 10 * 1024 * 1024 });
    registers.push(enrolments);
    const pack = readPack(PACK, NOW);
    await issueTillPins(dir, SIGNING, ['u-worker']);
    const register = await TillOperators.open({
      dataDir: dir, capacityBytes: 10 * 1024 * 1024, key: tillPinKey(SIGNING),
      credentials: () => loadTillCredentials(join(dir, 'till-credentials.json')),
      pack: { people: () => (pack.people.known ? peopleFrom(pack.people.value) : null), permissionsOf: (u) => permissionsOf(u, pack) },
      now: () => NOW,
    });
    const snapshot = (): ScreenInput => ({ pack, sales: [], unreadableRecords: 0, outbox: new SyncOutbox(), now: NOW, tradingDay: '2026-09-30' });
    const relayed: Started['relayed'] = [];
    const devices = { current: 'devices' in opts ? opts.devices : (PACK.devices as PackDevice[]) };
    const server = await startDeviceServer({
      port: 0, ...(opts.host === undefined ? {} : { host: opts.host }), appsDir: 'apps', snapshot, enrolments,
      devices: () => devices.current,
      relayDeviceEvents: async (batch): Promise<RelayReply> => {
        relayed.push({ source: batch.source, deviceId: batch.deviceId, items: batch.items, ...(batch.phoneHolder === undefined ? {} : { phoneHolder: batch.phoneHolder }) });
        return { acks: batch.items.map((raw) => ({ key: (raw as { key: string }).key, status: 'accepted' as const })) };
      },
      deviceEventStatus: (keys) => keys.map((key) => ({ key, state: 'pending' as const, attempts: 0 })),
      syncStatus: () => ({ cloud: 'not_configured', unsent: 0, deadLettered: 0, lastSentAt: null, lastContactAt: null, now: NOW, staffMessage: '' }),
      operators: phoneOperatorsOf(register),
      now: () => NOW,
    });
    servers.push(server);
    return { base: `http://127.0.0.1:${server.port}`, relayed, devices, server };
  }

  const enrol = async (base: string, deviceId: string, code: string): Promise<{ status: number; body: Record<string, unknown>; cookie: string | undefined }> => {
    const res = await fetch(`${base}/device/enrol`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId, code }), redirect: 'manual' });
    return { status: res.status, body: (await res.json()) as Record<string, unknown>, cookie: res.headers.get('set-cookie') ?? undefined };
  };
  const cookieHeader = (setCookie: string): string => setCookie.split(';')[0]!;
  const event = (id: string, movedBy = 'u-worker') => makeEvent({ id: `wh-move-${id}`, type: 'WarehouseMovementApplied', occurredAt: NOW, idempotencyKey: `wh-move:${id}`, source: 'A-1', payload: { commandId: id, movedBy } });
  /** DF-3-c: the person signs in on the phone with the till PIN; the device cookie and the session cookie together. */
  const signIn = async (base: string, deviceCookie: string, staffId = 'u-worker', screen = 'warehouse'): Promise<string> => {
    const res = await fetch(`${base}/device/sign-in?screen=${screen}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', cookie: deviceCookie }, body: JSON.stringify({ staffId, pin: pinOf(staffId) }) });
    expect(res.status).toBe(200);
    return `${deviceCookie}; ${cookieHeader(res.headers.get('set-cookie')!)}`;
  };

  it('binds to loopback unless told otherwise, and names the handheld screens it serves', async () => {
    const { server } = await start();
    expect(server.host).toBe(DEVICE_HOST);
    expect(DEVICE_HOST).toBe('127.0.0.1');
    expect([...HANDHELD_SCREENS]).toEqual(['warehouse', 'picker', 'driver']);
  });

  it('sends an unenrolled browser to the enrolment page and gives an unenrolled script nothing but 403', async () => {
    const { base } = await start();
    const nav = await fetch(`${base}/warehouse/`, { headers: { accept: 'text/html' }, redirect: 'manual' });
    expect(nav.status).toBe(302);
    expect(nav.headers.get('location')).toBe('/device/enrol?why=no_credential');
    const root = await fetch(`${base}/`, { headers: { accept: 'text/html' }, redirect: 'manual' });
    expect(root.status).toBe(302);
    const script = await fetch(`${base}/lane/sync-status`);
    expect(script.status).toBe(403);
    expect(await script.json()).toMatchObject({ error: 'no_credential' });
    const post = await fetch(`${base}/lane/outbox`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'warehouse', items: [] }) });
    expect(post.status).toBe(403);
    // The enrolment page itself is served, with the reason in words, and never a shell.
    const page = await fetch(`${base}/device/enrol?why=no_credential`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Enrol this handheld');
    expect(html).toContain('not been enrolled');
    expect(html).not.toContain('warehouse-app.bundle.js');
  });

  it('refuses a wrong code, a till, and an unknown device — and sets no cookie', async () => {
    const { base } = await start();
    const wrong = await enrol(base, 'hh-01', 'ABCDE-FGHJK-LMNPQ-RSTUW');
    expect(wrong.status).toBe(403);
    expect(wrong.body).toMatchObject({ enrolled: false, refusal: 'code_wrong' });
    expect(wrong.cookie).toBeUndefined();
    expect((await enrol(base, 'till-1', CODE)).body).toMatchObject({ enrolled: false, refusal: 'device_not_a_handheld' });
    const unknown = await enrol(base, 'hh-77', CODE);
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ enrolled: false, refusal: 'device_unknown' });
    const notJson = await fetch(`${base}/device/enrol`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'deviceId=hh-01' });
    expect(notJson.status).toBe(415);
  });

  it('enrols with the right code: an HttpOnly SameSite=Strict cookie, then the warehouse shell with its assignment and a same-origin write base', async () => {
    const { base } = await start();
    const ok = await enrol(base, 'hh-01', CODE);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ enrolled: true, deviceId: 'hh-01', next: '/warehouse/' });
    expect(ok.cookie).toMatch(new RegExp(`^${DEVICE_COOKIE}=hh-01\\.[0-9a-f]{64}; Path=/; HttpOnly; SameSite=Strict; Max-Age=\\d+$`));
    const deviceCookie = cookieHeader(ok.cookie!);
    expect(cookieValue(deviceCookie, DEVICE_COOKIE)).toMatch(/^hh-01\.[0-9a-f]{64}$/);
    // DF-3-c: an enrolled phone with nobody signed in gets the sign-in page, not the work.
    const away = await fetch(`${base}/warehouse/`, { headers: { accept: 'text/html', cookie: deviceCookie }, redirect: 'manual' });
    expect(away.status).toBe(302);
    expect(away.headers.get('location')).toBe('/device/sign-in?screen=warehouse');
    const cookie = await signIn(base, deviceCookie);

    const shell = await fetch(`${base}/warehouse/`, { headers: { accept: 'text/html', cookie } });
    expect(shell.status).toBe(200);
    expect(shell.headers.get('content-type')).toContain('text/html');
    expect(shell.headers.get('cache-control')).toBe('no-store');
    const html = await shell.text();
    expect(html).toContain('warehouse-app.bundle.js');
    expect(html).toContain('window.warehouseData = ');
    expect(html).toContain('"assignmentId":"A-1"');
    expect(html).toContain('"workerId":"u-worker"');
    expect(html).toContain('window.laneWriteBase = "";');
    expect(html).toContain('window.deviceId = "hh-01";');
    // The shell's own files come from the same folder; a bare route is redirected to its slash form first.
    expect((await fetch(`${base}/warehouse/app.js`, { headers: { cookie } })).status).toBe(200);
    const bare = await fetch(`${base}/warehouse`, { headers: { accept: 'text/html', cookie }, redirect: 'manual' });
    expect(bare.status).toBe(301);
    expect(bare.headers.get('location')).toBe('/warehouse/');
    const root = await fetch(`${base}/`, { headers: { accept: 'text/html', cookie }, redirect: 'manual' });
    expect(root.headers.get('location')).toBe('/warehouse/');
  });

  it('enrolment lands the device on the handheld screen it asked for — the picker\'s, the driver\'s — and never on a page that is not a handheld\'s (SP-3c)', async () => {
    const { base } = await start();
    // Turned away from the picker shell: the redirect carries where it was going, so the enrolment page can send it back there.
    const away = await fetch(`${base}/picker/`, { headers: { accept: 'text/html' }, redirect: 'manual' });
    expect(away.status).toBe(302);
    expect(away.headers.get('location')).toBe('/device/enrol?why=no_credential&next=%2Fpicker%2F');
    const page = await (await fetch(`${base}/device/enrol?why=no_credential&next=%2Fpicker%2F`)).text();
    expect(page).toContain('next: "/picker/"');
    // The warehouse shell is the default — no `next` on its redirect, none on the page.
    expect((await fetch(`${base}/warehouse/`, { headers: { accept: 'text/html' }, redirect: 'manual' })).headers.get('location')).toBe('/device/enrol?why=no_credential');
    expect(await (await fetch(`${base}/device/enrol`)).text()).toContain('next: "/warehouse/"');

    // The one-time code enrols once: the device that asked for the picker shell is sent back to it.
    const res = await fetch(`${base}/device/enrol`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: 'hh-01', code: CODE, next: '/picker/' }) });
    expect(await res.json()).toMatchObject({ enrolled: true, deviceId: 'hh-01', next: '/picker/' });
    // The rule itself: a handheld screen's root, however it was spelled; the till, the manager, a file inside a shell, an
    // absolute URL, garbage → the warehouse shell, never the asked-for page.
    expect(homeAfterEnrol('/driver/')).toBe('/driver/');
    expect(homeAfterEnrol('/picker/?x=1')).toBe('/picker/');
    expect(homeAfterEnrol('/picker')).toBe('/picker/');
    expect(homeAfterEnrol('/pos/')).toBe('/warehouse/');
    expect(homeAfterEnrol('/manager/')).toBe('/warehouse/');
    expect(homeAfterEnrol('/picker/app.js')).toBe('/warehouse/');
    expect(homeAfterEnrol('https://evil.example/picker/')).toBe('/warehouse/');
    expect(homeAfterEnrol(42)).toBe('/warehouse/');
    expect(homeAfterEnrol(undefined)).toBe('/warehouse/');
  });

  it('serves ONLY the handheld screens: the till, the manager, the owner and every ERP page are 404 by name, even to an enrolled device', async () => {
    const { base } = await start();
    const cookie = cookieHeader((await enrol(base, 'hh-01', CODE)).cookie!);
    for (const path of ['/pos/', '/manager/', '/owner/', '/buying/', '/counts/', '/admin/', '/customer/', '/warehouse-supervisor/']) {
      const res = await fetch(`${base}${path}`, { headers: { accept: 'text/html', cookie }, redirect: 'manual' });
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).toContain('not a handheld screen');
    }
    // Nor does a bare ERP path redirect somewhere served.
    expect((await fetch(`${base}/pos`, { headers: { accept: 'text/html', cookie }, redirect: 'manual' })).status).toBe(404);
    expect((await fetch(`${base}/pricing`, { headers: { accept: 'text/html', cookie }, redirect: 'manual' })).status).toBe(404);
    // And a path that tries to climb out is refused.
    expect((await fetch(`${base}/warehouse/..%2F..%2Fpackage.json`, { headers: { cookie } })).status).not.toBe(200);
  });

  it('relays a handheld batch with the device named, answers status and sync-status, and refuses a batch that claims to be the manager', async () => {
    const { base, relayed } = await start();
    const cookie = await signIn(base, cookieHeader((await enrol(base, 'hh-01', CODE)).cookie!));
    const e = event('c1');
    const res = await fetch(`${base}/lane/outbox`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ source: 'warehouse', items: [{ key: e.idempotencyKey, event: e }] }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ acks: [{ key: 'wh-move:c1', status: 'accepted' }] });
    expect(relayed).toHaveLength(1);
    expect(relayed[0]).toMatchObject({ source: 'warehouse', deviceId: 'hh-01', phoneHolder: 'u-worker' });

    const asManager = await fetch(`${base}/lane/outbox`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ source: 'manager', items: [{ key: e.idempotencyKey, event: e }] }) });
    expect(asManager.status).toBe(403);
    expect(await asManager.json()).toMatchObject({ acks: [], reason: expect.stringContaining('manager is not a handheld surface') as string });
    expect(relayed).toHaveLength(1);

    const malformed = await fetch(`${base}/lane/outbox`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{"items": []}' });
    expect(malformed.status).toBe(400);
    const notJson = await fetch(`${base}/lane/outbox`, { method: 'POST', headers: { 'content-type': 'text/plain', cookie }, body: 'x' });
    expect(notJson.status).toBe(415);

    const status = await fetch(`${base}/lane/outbox/status?keys=wh-move:c1,other`, { headers: { cookie } });
    expect(await status.json()).toEqual({ items: [{ key: 'wh-move:c1', state: 'pending', attempts: 0 }, { key: 'other', state: 'pending', attempts: 0 }] });
    const sync = await fetch(`${base}/lane/sync-status`, { headers: { cookie } });
    expect(sync.status).toBe(200);
    expect(await sync.json()).toMatchObject({ cloud: 'not_configured', unsent: 0 });
  });

  it('a device head office blocks — or drops from the fleet — is refused at its next request, shell and routes alike', async () => {
    const { base, devices } = await start();
    const cookie = cookieHeader((await enrol(base, 'hh-01', CODE)).cookie!);
    expect((await fetch(`${base}/lane/sync-status`, { headers: { cookie } })).status).toBe(200);
    devices.current = [{ ...PACK.devices[0]!, status: 'blocked' } as PackDevice];
    const blocked = await fetch(`${base}/lane/sync-status`, { headers: { cookie } });
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({ error: 'device_not_active' });
    const shell = await fetch(`${base}/warehouse/`, { headers: { accept: 'text/html', cookie }, redirect: 'manual' });
    expect(shell.status).toBe(302);
    expect(shell.headers.get('location')).toBe('/device/enrol?why=device_not_active');
    devices.current = undefined;
    expect(await (await fetch(`${base}/lane/sync-status`, { headers: { cookie } })).json()).toMatchObject({ error: 'no_devices_register' });
    // Nothing enrols either while the box has no fleet register.
    expect((await enrol(base, 'hh-01', CODE)).status).toBe(503);
  });

  it('a forged cookie is a stranger: wrong token, other device, garbage — all refused', async () => {
    const { base } = await start();
    await enrol(base, 'hh-01', CODE);
    for (const cookie of [`${DEVICE_COOKIE}=hh-01.${'0'.repeat(64)}`, `${DEVICE_COOKIE}=hh-02.${'a'.repeat(64)}`, `${DEVICE_COOKIE}=garbage`, `other=1`]) {
      const res = await fetch(`${base}/lane/sync-status`, { headers: { cookie } });
      expect(res.status, cookie).toBe(403);
    }
  });

  it('DF-3-c (OB-28 "A"): a person signs in on the phone with the till PIN; a wrong PIN, a person without the job and a missing session are refused; a record naming someone else is refused by name', async () => {
    const { base, relayed } = await start();
    const deviceCookie = cookieHeader((await enrol(base, 'hh-01', CODE)).cookie!);
    // The sign-in page itself: staff ID and PIN, a plain form for the job asked.
    const page = await (await fetch(`${base}/device/sign-in?screen=picker`, { headers: { cookie: deviceCookie } })).text();
    expect(page).toContain('Sign in on this phone');
    expect(page).toContain('action="/device/sign-in?screen=picker"');
    // A wrong PIN — one answer, no session cookie.
    const wrongPin = String((Number(pinOf('u-worker')) + 1) % 1_000_000).padStart(6, '1');
    const wrong = await fetch(`${base}/device/sign-in?screen=warehouse`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', cookie: deviceCookie }, body: JSON.stringify({ staffId: 'u-worker', pin: wrongPin }) });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toMatchObject({ signedIn: false, refusedBecause: 'wrong_staff_id_or_pin' });
    expect(wrong.headers.get('set-cookie')).toBeNull();
    // The worker does not hold the picker's permission: refused for the picker's job, by name.
    const notPicker = await fetch(`${base}/device/sign-in?screen=picker`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', cookie: deviceCookie }, body: JSON.stringify({ staffId: 'u-worker', pin: pinOf('u-worker') }) });
    expect(notPicker.status).toBe(401);
    expect(await notPicker.json()).toMatchObject({ refusedBecause: 'no_handheld_authority' });
    // A plain form post (what the phone's page sends) signs in and goes to the work.
    const form = await fetch(`${base}/device/sign-in?screen=warehouse`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: deviceCookie }, body: new URLSearchParams({ staffId: 'u-worker', pin: pinOf('u-worker') }).toString(), redirect: 'manual' });
    expect(form.status).toBe(303);
    expect(form.headers.get('location')).toBe('/warehouse/');
    expect(form.headers.get('set-cookie')).toMatch(/^sre_operator=[^;]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=43200$/);
    const cookie = `${deviceCookie}; ${cookieHeader(form.headers.get('set-cookie')!)}`;
    // The screen names the signed-in person and shows who is holding the phone.
    const html = await (await fetch(`${base}/warehouse/`, { headers: { accept: 'text/html', cookie } })).text();
    expect(html).toContain('"workerId":"u-worker"');
    expect(html).toContain('Signed in: <strong>Worker One</strong>');
    // The picker's screen needs the picker's sign-in, even with a live warehouse session.
    expect((await fetch(`${base}/picker/`, { headers: { accept: 'text/html', cookie }, redirect: 'manual' })).headers.get('location')).toBe('/device/sign-in?screen=picker');

    // No session → nothing taken, and not a refusal (401: the phone keeps the items).
    const e1 = event('c1');
    const noOne = await fetch(`${base}/lane/outbox`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: deviceCookie }, body: JSON.stringify({ source: 'warehouse', items: [{ key: e1.idempotencyKey, event: e1 }] }) });
    expect(noOne.status).toBe(401);
    expect(relayed).toHaveLength(0);
    // A record naming somebody else is refused by name; the worker's own goes through, in order.
    const other = event('c2', 'u-someone-else');
    const mixed = await fetch(`${base}/lane/outbox`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ source: 'warehouse', items: [{ key: other.idempotencyKey, event: other }, { key: e1.idempotencyKey, event: e1 }] }) });
    expect(await mixed.json()).toEqual({ acks: [
      { key: 'wh-move:c2', status: 'refused', reason: 'the record names u-someone-else, who has not been signed in on this phone this shift' },
      { key: 'wh-move:c1', status: 'accepted' },
    ] });
    expect(relayed).toHaveLength(1);
    expect(relayed[0]!.items).toHaveLength(1);

    // Sign out: the cookie is cleared and the work is gone from the phone until somebody signs in again.
    const out = await fetch(`${base}/device/sign-out?screen=warehouse`, { method: 'POST', headers: { cookie }, redirect: 'manual' });
    expect(out.status).toBe(303);
    expect(out.headers.get('location')).toBe('/device/sign-in?screen=warehouse');
    expect((await fetch(`${base}/warehouse/`, { headers: { accept: 'text/html', cookie }, redirect: 'manual' })).status).toBe(302);
  });
});
