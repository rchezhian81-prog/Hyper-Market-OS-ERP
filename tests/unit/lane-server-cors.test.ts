import { describe, it, expect, afterEach } from 'vitest';
import { isLoopbackOrigin, startLaneServer, type LaneServer } from '../../edge/store-edge/src/lane-server';
import type { EdgeNode } from '../../edge/store-edge/src/index';

/**
 * **The till's screen can post its sale to the till's socket — from a browser.**
 *
 * The screen is served on one loopback port and this write socket is on another, so the browser
 * sees a cross-origin request and, for a JSON POST, sends a preflight `OPTIONS` first and then only
 * sends the real POST if the socket named the origin back. The first version answered neither, so a
 * real browser till could never take a sale. These prove the socket now answers a LOOPBACK origin
 * (another page on this same machine) and stays silent to any other — the bind is the real control,
 * this is the belt to it.
 */

const stubNode = (committed = true): EdgeNode => ({
  pack: () => undefined,
  commit: async (id) => ({ committed, saleId: id, laneMessage: committed ? 'saved' : 'refused' } as never),
  takePack: () => ({ accepted: true, staffMessage: '' }),
});

const SALE = JSON.stringify({ id: 'S-1', number: 'R-1', total: 100, lines: [], tenders: [] });

describe('isLoopbackOrigin', () => {
  it('accepts 127.0.0.1, localhost and [::1] on any port', () => {
    for (const o of ['http://127.0.0.1', 'http://127.0.0.1:8090', 'http://localhost', 'http://localhost:8080', 'http://[::1]:9']) {
      expect(isLoopbackOrigin(o), o).toBe(true);
    }
  });

  it('rejects a LAN address, a remote host, and anything unparseable or absent', () => {
    for (const o of ['http://192.168.1.5:8080', 'https://evil.example', 'http://10.0.0.2', 'not a url', '', undefined]) {
      expect(isLoopbackOrigin(o), String(o)).toBe(false);
    }
  });
});

describe('the lane socket answers a browser on this machine', () => {
  const servers: LaneServer[] = [];
  afterEach(async () => { for (const s of servers.splice(0)) await s.stop(); });
  const start = async (node = stubNode()) => {
    const s = await startLaneServer({ node, port: 0 });
    servers.push(s);
    return `http://127.0.0.1:${s.port}`;
  };

  it('answers the preflight for a loopback origin: 204 and names it back, POST allowed', async () => {
    const base = await start();
    const res = await fetch(`${base}/lane/sales`, {
      method: 'OPTIONS',
      headers: { origin: 'http://127.0.0.1:8080', 'access-control-request-method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:8080');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('refuses the preflight for any other origin — no allow header, so the browser blocks it', async () => {
    const base = await start();
    const res = await fetch(`${base}/lane/sales`, {
      method: 'OPTIONS',
      headers: { origin: 'http://192.168.1.5:8080', 'access-control-request-method': 'POST' },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('commits a loopback-origin POST and echoes the origin, so the browser accepts the answer', async () => {
    const base = await start();
    const res = await fetch(`${base}/lane/sales`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:8080' },
      body: SALE,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:8080');
    expect((await res.json() as { committed: boolean }).committed).toBe(true);
  });

  it('sends NO allow header to a non-loopback origin — a browser would never have reached here', async () => {
    // The bind to 127.0.0.1 is why nothing off this machine can reach the socket at all; this is the
    // second line. `fetch` is not a browser so the request lands, but the missing header is what a
    // real browser reads to refuse the response.
    const base = await start();
    const res = await fetch(`${base}/lane/sales`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: SALE,
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('a same-origin / non-browser call (no Origin) still works and needs no allow header', async () => {
    const base = await start();
    const res = await fetch(`${base}/lane/sales`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: SALE,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});
