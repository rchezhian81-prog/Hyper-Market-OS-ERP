import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rawRequest } from '../support/raw-request';
import { trustingFetch } from '../support/box-tls';
import {
  buildRouter, startHttpServer, MemoryIdempotencyStore, type RunningServer,
} from '../../services/kernel/src/index';
import { AccessControl } from '../../packages/rbac/src/rbac';
import { startLaneServer } from '../../edge/store-edge/src/lane-server';
import type { EdgeNode } from '../../edge/store-edge/src/index';
import { startScreenServer, SCREEN_HOST } from '../../edge/store-edge/src/screen-server';
import { startDeviceServer } from '../../edge/store-edge/src/device-server';
import { ensureDeviceTls } from '../../edge/store-edge/src/device-tls';
import { DeviceEnrolments } from '../../edge/store-edge/src/device-enrolments';
import { emptyPack } from '../../edge/store-edge/src/store-pack';
import type { ScreenInput } from '../../edge/store-edge/src/screen-data';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { createSignInHandler } from '../../services/identity/src/sign-in';
import { startCustomerSignIn } from '../../services/identity/src/customer-sign-in-main';
import { createDemoLoginHandler, FailureThrottle } from '../../infra/pilot/demo-login/login';
import { createImportApp } from '../../scripts/lib/import-app';

/**
 * **Audit 27 Nov 2026 · item 4 — an address that cannot be read is answered 400, and never ends the process.**
 *
 * The finding: a request line such as `GET //` makes `new URL(req.url, base)` throw ("//" reads as a host with no name).
 * In the cloud API's socket adapter (services/kernel/src/http-server.ts) that throw was an unhandled rejection, and the
 * API's last resort (services/api/src/main.ts) then drained and exited with code 70 — one stray request from anyone on the
 * internet restarted the API. Every other server that reads `req.url` is held to the same rule here:
 *
 *   • the answer to an unreadable address is **400 with a plain reason**, never a crash, a hang, a 403/500/503 that
 *     blames something else, or a silent fallback to the home page;
 *   • the same server then **answers the next request** normally;
 *   • an error anywhere inside the kernel's request handling is answered (503) instead of escaping the request.
 *
 * `GET //` is written byte for byte over a raw socket, because HTTP clients tidy it to `GET /` before it leaves.
 */

const BAD = 'GET // HTTP/1.1';
const SAYS = /could not be read/i;
const stops: (() => Promise<void>)[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const tempDir = async (): Promise<string> => { const d = await mkdtemp(join(tmpdir(), 'sre-audit27-04-')); dirs.push(d); return d; };

const snapshot = (): ScreenInput => ({ pack: emptyPack(), sales: [], unreadableRecords: 0, outbox: new SyncOutbox(), now: '2026-11-27T10:00:00.000Z', tradingDay: '2026-11-27' });

describe('the cloud API socket (services/kernel/src/http-server.ts)', () => {
  const start = async (dependenciesReachable: () => boolean = () => true): Promise<number> => {
    const built = buildRouter([]);
    expect(built.ok).toBe(true);
    const s: RunningServer = startHttpServer({
      router: built.router!, authenticate: () => undefined, access: new AccessControl([], []),
      idempotency: new MemoryIdempotencyStore(), newTraceId: () => 'trace-a27-4', port: 0, dependenciesReachable,
    });
    stops.push(() => s.stop());
    if (!s.server.listening) await new Promise<void>((r) => { s.server.once('listening', () => { r(); }); });
    return (s.server.address() as AddressInfo).port;
  };

  it('answers GET // with 400 and a plain reason, then answers the next request', async () => {
    const port = await start();
    const bad = await rawRequest(port, BAD);
    expect(bad.timedOut, 'the server answered instead of hanging').toBe(false);
    expect(bad.status).toBe(400);
    expect(bad.text).toMatch(SAYS);
    expect(bad.text).toMatch(/"wasItSaved":"not_saved"/);
    const next = await fetch(`http://127.0.0.1:${port}/livez`);
    expect(next.status).toBe(200);
  });

  it('answers 503 when something inside the request handling throws, and keeps serving', async () => {
    const port = await start(() => { throw new Error('the readiness check itself failed'); });
    const res = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(res.status).toBe(503);
    // Thrown from somewhere unexpected: whether anything was saved is honestly unknown (pipeline.ts's own rule).
    expect(await res.text()).toMatch(/"wasItSaved":"unknown"/);
    expect((await fetch(`http://127.0.0.1:${port}/livez`)).status).toBe(200);
  });
});

describe('the store computer\'s lane socket (edge/store-edge/src/lane-server.ts)', () => {
  const node = {
    pack: () => undefined, commit: async () => ({}), commitReturn: async () => ({}), commitCompletion: async () => ({}),
    commitConcessionTag: async () => ({}), lookupSale: async () => undefined, takePack: () => ({ accepted: true, staffMessage: '' }),
  } as unknown as EdgeNode;

  it('answers 500 in words when something inside the request handling throws, and keeps serving', async () => {
    const lane = await startLaneServer({
      node, port: 0, relayDeviceEvents: async () => ({ acks: [] }),
      deviceEventStatus: () => { throw new Error('the outbox register could not be read'); },
    });
    stops.push(() => lane.stop());
    const res = await fetch(`http://127.0.0.1:${lane.port}/lane/outbox/status?keys=k1`);
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toMatch(/could not be answered/);
    const next = await fetch(`http://127.0.0.1:${lane.port}/lane/lookup?receipt=R-1`);
    expect(next.status).toBe(200);
  });

  it('answers GET // with 400 and a plain reason, then answers the next request', async () => {
    const lane = await startLaneServer({ node, port: 0 });
    stops.push(() => lane.stop());
    const bad = await rawRequest(lane.port, BAD);
    expect(bad.timedOut).toBe(false);
    expect(bad.status).toBe(400);
    expect(bad.text).toMatch(SAYS);
    const next = await fetch(`http://127.0.0.1:${lane.port}/lane/lookup?receipt=R-1`);
    expect(next.status).toBe(200);
    expect(await next.json()).toEqual({ found: false });
  });
});

describe('the store computer\'s screen socket (edge/store-edge/src/screen-server.ts)', () => {
  it('answers GET // with 400 and a plain reason, then answers the next request', async () => {
    const screens = await startScreenServer({ port: 0, appsDir: 'apps', snapshot });
    stops.push(() => screens.stop());
    const bad = await rawRequest(screens.port, BAD, { host: SCREEN_HOST });
    expect(bad.timedOut).toBe(false);
    expect(bad.status).toBe(400);
    expect(bad.text).toMatch(SAYS);
    const next = await fetch(`http://${SCREEN_HOST}:${screens.port}/fonts/not-a-font.woff2`);
    expect(next.status).toBe(404);
    expect(await next.text()).toMatch(/not a font this page uses/);
  });
});

describe('the store computer\'s screen socket — a throw inside', () => {
  it('answers 500 in words when something inside the request handling throws, and keeps serving', async () => {
    let broken = true;
    const screens = await startScreenServer({ port: 0, appsDir: 'apps', snapshot: () => { if (broken) throw new Error('the store pack could not be read'); return snapshot(); } });
    stops.push(() => screens.stop());
    const res = await fetch(`http://${SCREEN_HOST}:${screens.port}/manager/`);
    expect(res.status).toBe(500);
    expect(await res.text()).toMatch(/could not be answered/);
    broken = false;
    const next = await fetch(`http://${SCREEN_HOST}:${screens.port}/fonts/not-a-font.woff2`);
    expect(next.status).toBe(404);
  });
});

describe('the store computer\'s handheld door (edge/store-edge/src/device-server.ts)', () => {
  const startDoor = async (devices: () => readonly never[] = () => []) => {
    const dir = await tempDir();
    const tlsDir = join(dir, 'device-tls');
    const made = ensureDeviceTls({ dir: tlsDir, addresses: ['127.0.0.1'], now: new Date() });
    if (!made.ok) throw new Error(made.problem);
    const enrolments = await DeviceEnrolments.open({ dataDir: dir, capacityBytes: 1024 * 1024 });
    stops.push(() => enrolments.close());
    const door = await startDeviceServer({
      tls: { dir: tlsDir, addresses: ['127.0.0.1'], material: made.tls }, port: 0, appsDir: 'apps', snapshot, enrolments,
      devices, relayDeviceEvents: async () => ({ acks: [] }), deviceEventStatus: () => [],
      syncStatus: () => ({ cloud: 'not_configured', unsent: 0, deadLettered: 0, lastSentAt: null, lastContactAt: null, now: '2026-11-27T10:00:00.000Z', staffMessage: '' }),
      operators: null, now: () => '2026-11-27T10:00:00.000Z', renewEveryMs: 0,
    });
    stops.push(() => door.stop());
    return door;
  };

  it('answers 500 in words when something inside the request handling throws, and keeps serving', async () => {
    let broken = true;
    const door = await startDoor(() => { if (broken) throw new Error('the fleet register could not be read'); return []; });
    const fetchBox = trustingFetch(door.authority().pem);
    const res = await fetchBox(`https://127.0.0.1:${door.port}/device/enrol`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: 'hh-01', code: 'ABCDE-FGHJK-LMNPQ-RSTUV' }) });
    expect(res.status).toBe(500);
    expect(await res.text()).toMatch(/could not be answered/);
    broken = false;
    const next = await fetchBox(`https://127.0.0.1:${door.port}/lane/sync-status`);
    expect(next.status).toBe(403);
  });

  it('answers GET // with 400 and a plain reason (never the home page), then answers the next request', async () => {
    const door = await startDoor();
    const ca = door.authority().pem;
    const bad = await rawRequest(door.port, BAD, { tls: { ca } });
    expect(bad.timedOut).toBe(false);
    expect(bad.status).toBe(400);
    expect(bad.text).toMatch(SAYS);
    const next = await trustingFetch(ca)(`https://127.0.0.1:${door.port}/lane/sync-status`);
    expect(next.status).toBe(403);
    expect(await next.json()).toMatchObject({ error: 'no_credential' });
  });
});

describe('the customer sign-in service (services/identity/src/customer-sign-in-main.ts)', () => {
  it('answers GET // with 400 and a plain reason (not "sign-in is not available"), then answers the next request', async () => {
    const server: Server = startCustomerSignIn({
      env: { CUSTOMER_SIGN_IN_TENANT_ID: 'tenant-a27', CUSTOMER_SIGN_IN_ORIGIN: 'https://shop.example.test' }, port: 0, log: () => undefined,
    });
    stops.push(() => new Promise<void>((r) => { server.close(() => { r(); }); }));
    if (!server.listening) await new Promise<void>((r) => { server.once('listening', () => { r(); }); });
    const port = (server.address() as AddressInfo).port;
    const bad = await rawRequest(port, BAD);
    expect(bad.timedOut).toBe(false);
    expect(bad.status).toBe(400);
    expect(bad.text).toMatch(SAYS);
    const next = await fetch(`http://127.0.0.1:${port}/customer/sign-in/start`);
    expect(next.status).toBe(405);
  });
});

describe('the staff sign-in service (services/identity/src/sign-in.ts — the handler its socket hands every request to)', () => {
  it('answers a request for // with 400 and a plain reason, never the 503 "not available"', async () => {
    const handle = createSignInHandler({
      settings: { issuer: 'https://shop.example.test/auth/realms/sre-store', internalIssuer: 'http://idp:8080/auth/realms/sre-store', clientId: 'sre-web', origin: 'https://shop.example.test' },
      policy: { algorithm: 'RS256', secret: '', keyring: { get: () => undefined }, subjectClaim: 'sre_user_id', issuer: 'https://shop.example.test/auth/realms/sre-store', audience: 'sre-retail-os-api', maxLifetimeSeconds: 3600 },
      fetch: async () => { throw new Error('the identity server is never asked about an unreadable address'); },
      now: () => Date.parse('2026-11-27T10:00:00Z'), audit: () => undefined,
      fetchMe: async () => ({ status: 403, body: undefined }),
    });
    const out = await handle({ method: 'GET', url: '//', headers: {}, body: '' });
    expect(out.status).toBe(400);
    expect(out.body).toMatch(SAYS);
  });
});

describe('the hosted demo sign-in (infra/pilot/demo-login/login.ts — the handler its socket hands every request to)', () => {
  it('answers a request for // with 400 and a plain reason, never a 500', () => {
    const handle = createDemoLoginHandler({
      logins: () => ({ version: 1, logins: [] }),
      idp: { secret: ['demo', 'login', 'a27', 'key'].join('-').padEnd(48, '0'), issuer: 'https://pilot-idp.test', audience: 'sre-retail-os-api' },
      throttle: new FailureThrottle(), now: () => Date.parse('2026-11-27T10:00:00Z'), audit: () => undefined,
    });
    const out = handle({ method: 'GET', url: '//', headers: { host: 'demo.example' }, body: '' });
    expect(out.status).toBe(400);
    expect(String(out.body)).toMatch(SAYS);
  });
});

describe('the store PC\'s import page (scripts/lib/import-app.ts)', () => {
  it('answers GET // with 400 and a plain reason (never "something went wrong"), then answers the next request', async () => {
    const dataDir = await tempDir();
    const app = createImportApp({
      client: (() => { throw new Error('the office API is never asked about an unreadable address'); }) as never,
      verifyPin: () => 'no_pin_issued', tenantId: 'tenant-a27', storeId: 'store-1', targetKind: 'rehearsal', demoTenantIds: [],
      dataDir, pageHtml: '<!doctype html><title>import</title>', now: () => new Date('2026-11-27T10:00:00.000Z'),
    });
    const server = createServer((rq, rs) => { void app(rq, rs); });
    await new Promise<void>((r) => { server.listen(0, '127.0.0.1', () => { r(); }); });
    stops.push(() => new Promise<void>((r) => { server.close(() => { r(); }); }));
    const port = (server.address() as AddressInfo).port;
    const bad = await rawRequest(port, BAD);
    expect(bad.timedOut).toBe(false);
    expect(bad.status).toBe(400);
    expect(bad.text).toMatch(SAYS);
    expect(bad.text).not.toMatch(/Something went wrong/);
    const next = await fetch(`http://127.0.0.1:${port}/`);
    expect(next.status).toBe(200);
  });
});
