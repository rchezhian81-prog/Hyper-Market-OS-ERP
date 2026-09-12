import { describe, it, expect, afterEach } from 'vitest';
import { startLaneServer, type LaneServer } from '../../edge/store-edge/src/lane-server';
import type { EdgeNode } from '../../edge/store-edge/src/index';
import type { SaleLookupResult } from '../../edge/store-edge/src/receipt-lookup';

/**
 * **The lane's READ route: GET /lane/lookup (M13-FR-01).**
 *
 * The refund screen looks a bill up over this route. It is read-only — it mutates nothing, so the
 * RR-F01 "a text/plain write slipped through" class of bug cannot arise here — but it returns a
 * customer's bill, so it is still restricted to a loopback origin (another page on this same till).
 */

const RESULT: SaleLookupResult = {
  sale: {
    saleId: 'S-1', number: 'B-1', tradingDay: '2026-08-05', committedAt: '2026-08-05T10:00:00Z',
    totalMinor: 20_000, lines: [{ productId: 'P1', uom: 'ea', quantityMinor: 2 }],
  },
  returns: [],
  refunds: [],
};

let lookedUpWith: string | undefined;
const stubNode = (result: SaleLookupResult | undefined): EdgeNode => ({
  pack: () => undefined,
  commit: async (id) => ({ committed: true, saleId: id, laneMessage: 'saved' } as never),
  commitReturn: async (id) => ({ committed: true, returnId: id, laneMessage: 'saved' } as never),
  lookupSale: async (receipt) => { lookedUpWith = receipt; return result; },
  takePack: () => ({ accepted: true, staffMessage: '' }),
});

describe('GET /lane/lookup', () => {
  const servers: LaneServer[] = [];
  afterEach(async () => { for (const s of servers.splice(0)) await s.stop(); lookedUpWith = undefined; });
  const start = async (node = stubNode(RESULT)) => {
    const s = await startLaneServer({ node, port: 0 });
    servers.push(s);
    return `http://127.0.0.1:${s.port}`;
  };
  const loopback = { origin: 'http://127.0.0.1:8080' };

  it('returns the bill for a loopback caller, and names the origin back', async () => {
    const base = await start();
    const res = await fetch(`${base}/lane/lookup?receipt=B-1`, { headers: loopback });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:8080');
    const body = await res.json() as { found: boolean; sale?: { saleId: string } };
    expect(body.found).toBe(true);
    expect(body.sale?.saleId).toBe('S-1');
    expect(lookedUpWith).toBe('B-1');
  });

  it('looks up by receipt number OR sale id — whatever the query carries', async () => {
    const base = await start();
    await fetch(`${base}/lane/lookup?receipt=S-1`, { headers: loopback });
    expect(lookedUpWith).toBe('S-1');
  });

  it('answers found:false for a bill this lane did not ring, still 200', async () => {
    const base = await start(stubNode(undefined));
    const res = await fetch(`${base}/lane/lookup?receipt=B-999`, { headers: loopback });
    expect(res.status).toBe(200);
    expect((await res.json() as { found: boolean }).found).toBe(false);
  });

  it('refuses a request with no receipt (400)', async () => {
    const base = await start();
    const res = await fetch(`${base}/lane/lookup`, { headers: loopback });
    expect(res.status).toBe(400);
  });

  it('refuses a FOREIGN origin outright (403) — a customer bill is not handed across origins', async () => {
    const base = await start();
    const res = await fetch(`${base}/lane/lookup?receipt=B-1`, { headers: { origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(lookedUpWith).toBeUndefined(); // never even asked the node
  });

  it('serves a same-origin/non-browser caller (no Origin header)', async () => {
    const base = await start();
    const res = await fetch(`${base}/lane/lookup?receipt=B-1`);
    expect(res.status).toBe(200);
    expect((await res.json() as { found: boolean }).found).toBe(true);
  });
});
