import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDeviceServer, DEVICE_HOST, HANDHELD_SCREENS, DEVICE_COOKIE, cookieValue, type DeviceServer } from '../../edge/store-edge/src/device-server';
import { DeviceEnrolments, type PackDevice } from '../../edge/store-edge/src/device-enrolments';
import { enrolmentCodeHash } from '../../packages/platform-admin/src/device-enrolment';
import { readPack } from '../../edge/store-edge/src/store-pack';
import type { ScreenInput } from '../../edge/store-edge/src/screen-data';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { makeEvent } from '../../packages/contracts/src/event';
import type { RelayReply } from '../../packages/sync/src/device-relay';

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
const PACK = {
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

describe('the device socket', () => {
  const dirs: string[] = [];
  const servers: DeviceServer[] = [];
  const registers: DeviceEnrolments[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await s.stop();
    for (const r of registers.splice(0)) await r.close();
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  interface Started { base: string; relayed: { source: string; deviceId: string; items: readonly unknown[] }[]; devices: { current: PackDevice[] | undefined }; server: DeviceServer }
  async function start(opts: { host?: string; devices?: PackDevice[] | undefined } = {}): Promise<Started> {
    const dir = await mkdtemp(join(tmpdir(), 'sre-device-socket-'));
    dirs.push(dir);
    const register = await DeviceEnrolments.open({ dataDir: dir, capacityBytes: 10 * 1024 * 1024 });
    registers.push(register);
    const pack = readPack(PACK, NOW);
    const snapshot = (): ScreenInput => ({ pack, sales: [], unreadableRecords: 0, outbox: new SyncOutbox(), now: NOW, tradingDay: '2026-09-30' });
    const relayed: Started['relayed'] = [];
    const devices = { current: 'devices' in opts ? opts.devices : (PACK.devices as PackDevice[]) };
    const server = await startDeviceServer({
      port: 0, ...(opts.host === undefined ? {} : { host: opts.host }), appsDir: 'apps', snapshot, enrolments: register,
      devices: () => devices.current,
      relayDeviceEvents: async (batch): Promise<RelayReply> => {
        relayed.push({ source: batch.source, deviceId: batch.deviceId, items: batch.items });
        return { acks: batch.items.map((raw) => ({ key: (raw as { key: string }).key, status: 'accepted' as const })) };
      },
      deviceEventStatus: (keys) => keys.map((key) => ({ key, state: 'pending' as const, attempts: 0 })),
      syncStatus: () => ({ cloud: 'not_configured', unsent: 0, deadLettered: 0, lastSentAt: null, lastContactAt: null, now: NOW, staffMessage: '' }),
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
  const event = (id: string) => makeEvent({ id: `wh-move-${id}`, type: 'WarehouseMovementApplied', occurredAt: NOW, idempotencyKey: `wh-move:${id}`, source: 'A-1', payload: { commandId: id } });

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
    const cookie = cookieHeader(ok.cookie!);
    expect(cookieValue(cookie, DEVICE_COOKIE)).toMatch(/^hh-01\.[0-9a-f]{64}$/);

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
    const cookie = cookieHeader((await enrol(base, 'hh-01', CODE)).cookie!);
    const e = event('c1');
    const res = await fetch(`${base}/lane/outbox`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ source: 'warehouse', items: [{ key: e.idempotencyKey, event: e }] }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ acks: [{ key: 'wh-move:c1', status: 'accepted' }] });
    expect(relayed).toHaveLength(1);
    expect(relayed[0]).toMatchObject({ source: 'warehouse', deviceId: 'hh-01' });

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
});
