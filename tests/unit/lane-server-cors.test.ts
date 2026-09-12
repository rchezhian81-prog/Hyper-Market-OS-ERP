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
  commitReturn: async (id) => ({ committed, returnId: id, laneMessage: committed ? 'saved' : 'refused' } as never),
  lookupSale: async () => undefined,
  takePack: () => ({ accepted: true, staffMessage: '' }),
});

const SALE = JSON.stringify({ id: 'S-1', number: 'R-1', total: 100, lines: [], tenders: [] });
const RETURN = JSON.stringify({ returnId: 'RT-1', originalSaleId: 'S-1', number: 'RT-1', processedBy: 'u-cash', reasonCode: 'x', refundMinor: 100, refundTender: 'cash', lines: [] });

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

  // ── /lane/returns is the exact mirror of /lane/sales (M13-FR-01) ────────────

  it('commits a refund posted to /lane/returns, calling commitReturn (not commit)', async () => {
    const calls: { kind: 'sale' | 'return'; id: string }[] = [];
    const node: EdgeNode = {
      pack: () => undefined,
      commit: async (id) => { calls.push({ kind: 'sale', id }); return { committed: true, laneMessage: 'saved' } as never; },
      commitReturn: async (id) => { calls.push({ kind: 'return', id }); return { committed: true, laneMessage: 'saved' } as never; },
      lookupSale: async () => undefined,
      takePack: () => ({ accepted: true, staffMessage: '' }),
    };
    const base = await start(node);
    const res = await fetch(`${base}/lane/returns`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:8080' }, body: RETURN,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:8080');
    expect((await res.json() as { committed: boolean }).committed).toBe(true);
    // The refund went through the RETURN seam, and nothing touched the sale seam.
    expect(calls).toEqual([{ kind: 'return', id: 'RT-1' }]);
  });

  it('answers the /lane/returns preflight for a loopback origin', async () => {
    const base = await start();
    const res = await fetch(`${base}/lane/returns`, {
      method: 'OPTIONS', headers: { origin: 'http://127.0.0.1:8080', 'access-control-request-method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:8080');
  });

  it('refuses a refund with no return id, before any durable write — a bad minute, not a lost refund', async () => {
    const base = await start();
    const res = await fetch(`${base}/lane/returns`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ originalSaleId: 'S-1', refundMinor: 100 }), // no returnId
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { committed: boolean }).committed).toBe(false);
  });

  it('serves only the two write routes; anything else is 404 naming both', async () => {
    const base = await start();
    const res = await fetch(`${base}/lane/whatever`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('/lane/sales');
    expect(body.error).toContain('/lane/returns');
  });
});
