import { describe, it, expect, afterEach } from 'vitest';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLaneServer } from '../../edge/store-edge/src/lane-server';
import type { EdgeNode } from '../../edge/store-edge/src/index';
import { startScreenServer, SCREEN_HOST, BOX_STATUS_PATH } from '../../edge/store-edge/src/screen-server';
import { startDeviceServer } from '../../edge/store-edge/src/device-server';
import { ensureDeviceTls } from '../../edge/store-edge/src/device-tls';
import { DeviceEnrolments } from '../../edge/store-edge/src/device-enrolments';
import { emptyPack } from '../../edge/store-edge/src/store-pack';
import type { ScreenInput } from '../../edge/store-edge/src/screen-data';
import { SyncOutbox } from '../../packages/sync/src/outbox';

/**
 * **Audit 27 Nov 2026 · item 6 — a page reached under another name cannot read the store computer (DNS rebinding).**
 *
 * The finding: the lane socket's read routes (`/lane/lookup` — a customer's bill — and the others) accept a request that
 * carries no `Origin` header and never look at `Host`. A web page on `evil.example` whose name is re-pointed to 127.0.0.1
 * after it loads ("DNS rebinding") is then, to the browser, the SAME origin as the socket: it sends no Origin on a GET and
 * reads the answer. The bind to 127.0.0.1 does not stop it — the browser making the call is on this computer.
 *
 * The rule proven here, on real sockets, with `Host` set the way a rebinding browser sets it (and no Origin):
 *   • the **lane socket** (loopback only, always: the till's own browser on this PC, the demo relay inside the same
 *     container) answers only `127.0.0.1`, `localhost` and `[::1]` — any port; anything else is refused 403 in words, and
 *     nothing is read or written;
 *   • the **screen socket** answers the loopback names, the address it was told to bind, and the names the deployment
 *     configured (`EDGE_ALLOWED_HOSTS` — the hosted copy's public name, which the public proxy forwards for /customer);
 *   • the **handheld door** answers the loopback names, the shop-network addresses its certificate was made for (the
 *     handhelds reach it by the store PC's address on the wifi), and the configured names; never anything else.
 */

const NOW = '2026-11-27T10:00:00.000Z';
const REFUSED = /not this store computer/i;
const stops: (() => Promise<void>)[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

interface Answer { readonly status: number; readonly text: string }
/**
 * A request with the Host header set by hand (fetch will not), no Origin — what a rebinding browser sends. Over TLS the
 * certificate is still checked against the box's authority, for the address actually dialled (127.0.0.1) — node would
 * otherwise check it against the Host header, which is the very thing under test.
 */
function ask(port: number, path: string, host: string, opts: { method?: string; body?: string; ca?: string } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host, ...(opts.body === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(opts.body)) }) };
    const options = { host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers };
    const done = (res: import('node:http').IncomingMessage): void => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }); });
    };
    const req = opts.ca === undefined ? httpRequest(options, done) : httpsRequest({ ...options, ca: opts.ca, minVersion: 'TLSv1.2', checkServerIdentity: (_name, cert) => checkServerIdentity('127.0.0.1', cert) }, done);
    req.on('error', reject);
    req.end(opts.body);
  });
}

const snapshot = (): ScreenInput => ({ pack: emptyPack(), sales: [], unreadableRecords: 0, outbox: new SyncOutbox(), now: NOW, tradingDay: '2026-11-27' });

describe('the lane socket answers its loopback names only (edge/store-edge/src/lane-server.ts)', () => {
  const asked: string[] = [];
  const node = {
    pack: () => undefined,
    commit: async (id: string) => { asked.push(`commit ${id}`); return { committed: true, saleId: id }; },
    commitReturn: async () => ({}), commitCompletion: async () => ({}), commitConcessionTag: async () => ({}),
    lookupSale: async (id: string) => { asked.push(`lookup ${id}`); return undefined; },
    takePack: () => ({ accepted: true, staffMessage: '' }),
  } as unknown as EdgeNode;
  const start = async (): Promise<number> => {
    asked.splice(0);
    const lane = await startLaneServer({ node, port: 0 });
    stops.push(() => lane.stop());
    return lane.port;
  };

  it('refuses a bill lookup that names another computer (no Origin, Host: evil.example) — 403 in words, nothing read', async () => {
    const port = await start();
    for (const host of ['evil.example', `evil.example:${port}`, '192.168.1.20', 'localhost.evil.example']) {
      const res = await ask(port, '/lane/lookup?receipt=R-1', host);
      expect(res.status, host).toBe(403);
      expect(res.text, host).toMatch(REFUSED);
    }
    expect(asked).toEqual([]);
  });

  it('refuses a write that names another computer before the body is read — nothing is committed', async () => {
    const port = await start();
    const res = await ask(port, '/lane/sales', 'evil.example', { method: 'POST', body: JSON.stringify({ id: 'S-1' }) });
    expect(res.status).toBe(403);
    expect(res.text).toMatch(REFUSED);
    expect(asked).toEqual([]);
  });

  it('still answers 127.0.0.1, localhost and [::1] on any port (the till on this PC, the demo relay in its container)', async () => {
    const port = await start();
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, '127.0.0.1:8095', 'LOCALHOST']) {
      const res = await ask(port, '/lane/lookup?receipt=R-1', host);
      expect(res.status, host).toBe(200);
      expect(JSON.parse(res.text), host).toEqual({ found: false });
    }
  });
});

describe('the screen socket answers its own names only (edge/store-edge/src/screen-server.ts)', () => {
  const start = async (extra: Record<string, unknown> = {}): Promise<number> => {
    const screens = await startScreenServer({ port: 0, appsDir: 'apps', snapshot, syncStatus: () => ({ unsent: 3 }), ...extra } as Parameters<typeof startScreenServer>[0]);
    stops.push(() => screens.stop());
    return screens.port;
  };

  it('refuses a read that names another computer (no Origin, Host: evil.example) — 403 in words, never the day\'s figures', async () => {
    const port = await start();
    for (const path of [BOX_STATUS_PATH, '/manager/', '/pos/']) {
      const res = await ask(port, path, 'evil.example');
      expect(res.status, path).toBe(403);
      expect(res.text, path).toMatch(REFUSED);
      expect(res.text, path).not.toMatch(/unsent/);
    }
  });

  it('still answers 127.0.0.1, localhost and [::1]', async () => {
    const port = await start();
    for (const host of [`${SCREEN_HOST}:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
      const res = await ask(port, BOX_STATUS_PATH, host);
      expect(res.status, host).toBe(200);
      expect(JSON.parse(res.text), host).toEqual({ unsent: 3 });
    }
  });

  it('answers a name the deployment configured (the hosted copy\'s public name) and still refuses every other', async () => {
    const port = await start({ allowedHosts: ['shop.example.test'] });
    expect((await ask(port, '/fonts/not-a-font.woff2', 'shop.example.test')).status).toBe(404); // reached the server itself
    expect((await ask(port, '/fonts/not-a-font.woff2', 'SHOP.example.test:443')).status).toBe(404);
    const evil = await ask(port, '/fonts/not-a-font.woff2', 'evil.example');
    expect(evil.status).toBe(403);
    expect(evil.text).toMatch(REFUSED);
  });
});

describe('the handheld door answers its own addresses only (edge/store-edge/src/device-server.ts)', () => {
  const start = async (addresses: readonly string[], extra: Record<string, unknown> = {}) => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-audit27-06-'));
    dirs.push(dir);
    const tlsDir = join(dir, 'device-tls');
    const made = ensureDeviceTls({ dir: tlsDir, addresses, now: new Date() });
    if (!made.ok) throw new Error(made.problem);
    const enrolments = await DeviceEnrolments.open({ dataDir: dir, capacityBytes: 1024 * 1024 });
    stops.push(() => enrolments.close());
    const door = await startDeviceServer({
      tls: { dir: tlsDir, addresses, material: made.tls }, port: 0, appsDir: 'apps', snapshot, enrolments,
      devices: () => [], relayDeviceEvents: async () => ({ acks: [] }), deviceEventStatus: () => [],
      syncStatus: () => ({ cloud: 'not_configured', unsent: 0, deadLettered: 0, lastSentAt: null, lastContactAt: null, now: NOW, staffMessage: '' }),
      operators: null, now: () => NOW, renewEveryMs: 0, ...extra,
    } as Parameters<typeof startDeviceServer>[0]);
    stops.push(() => door.stop());
    return { port: door.port, ca: door.authority().pem };
  };

  it('refuses a request that names another computer — 403 in words, before the enrolment check', async () => {
    const { port, ca } = await start(['127.0.0.1', '192.168.1.20']);
    for (const path of ['/lane/sync-status', '/device/enrol']) {
      const res = await ask(port, path, 'evil.example', { ca });
      expect(res.status, path).toBe(403);
      expect(res.text, path).toMatch(REFUSED);
    }
  });

  it('still answers the loopback names and the shop-network address its certificate was made for', async () => {
    const { port, ca } = await start(['127.0.0.1', '192.168.1.20']);
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, `192.168.1.20:${port}`]) {
      const res = await ask(port, '/lane/sync-status', host, { ca });
      expect(res.status, host).toBe(403);
      expect(res.text, host).toMatch(/no_credential/); // reached the door's own enrolment check
    }
    const other = await ask(port, '/lane/sync-status', `192.168.1.21:${port}`, { ca });
    expect(other.text).toMatch(REFUSED);
  });

  it('answers a name the deployment configured (the hosted demo\'s public name through its relay)', async () => {
    const { port, ca } = await start(['127.0.0.1'], { allowedHosts: ['demo.example.test'] });
    const res = await ask(port, '/lane/sync-status', 'demo.example.test', { ca });
    expect(res.text).toMatch(/no_credential/);
    expect((await ask(port, '/lane/sync-status', 'evil.example', { ca })).text).toMatch(REFUSED);
  });
});
