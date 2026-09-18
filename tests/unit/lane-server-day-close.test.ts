import { describe, it, expect, afterEach } from 'vitest';
import { startLaneServer, type LaneServer, type LaneDayCloseHandler } from '../../edge/store-edge/src/lane-server';
import type { EdgeNode } from '../../edge/store-edge/src/index';

/**
 * **The manager's screen can ask the box to close the day — over the box's loopback socket (M14-FR-04).**
 *
 * POST /lane/day-close relays `{ dayCloseId, closedBy }` to the box's authoritative `closeDay` (which
 * makes the decision from the box's live state). The socket only carries the request, under the same
 * loopback + application/json authorization as the sale and refund routes (RR-F01): a foreign origin or a
 * non-JSON body is refused BEFORE `closeDay` is ever called. It answers 200 either way on a real attempt —
 * the body says whether the day closed or the stated blocker why not (P-08) — and 404 on a box that does
 * not close the day.
 */

const stubNode = (): EdgeNode => ({
  pack: () => undefined,
  commit: async (id) => ({ committed: true, saleId: id } as never),
  commitReturn: async (id) => ({ committed: true, returnId: id } as never),
  commitCompletion: async (_kind, id) => ({ committed: true, completionId: id } as never),
  lookupSale: async () => undefined,
  takePack: () => ({ accepted: true, staffMessage: '' }),
});

interface CloseOutcome { closed: boolean; tradingDay?: string; reason?: string }

describe('the lane socket relays the manager’s day close to the box (M14-FR-04)', () => {
  const servers: LaneServer[] = [];
  afterEach(async () => { for (const s of servers.splice(0)) await s.stop(); });

  const calls: Array<{ dayCloseId: string; closedBy: string }> = [];
  const closeDay: LaneDayCloseHandler = async (req) => {
    calls.push(req);
    if (req.dayCloseId === 'dc-block') return { closed: false, reason: 'a sale is still unsent' };
    return { closed: true, tradingDay: '2026-08-06', locked: true };
  };

  const start = async (opts: { withCloseDay: boolean } = { withCloseDay: true }) => {
    calls.splice(0);
    const s = await startLaneServer({ node: stubNode(), port: 0, ...(opts.withCloseDay ? { closeDay } : {}) });
    servers.push(s);
    return `http://127.0.0.1:${s.port}`;
  };

  const post = (base: string, body: unknown, headers: Record<string, string> = { 'content-type': 'application/json', origin: 'http://localhost:8080' }) =>
    fetch(`${base}/lane/day-close`, { method: 'POST', headers, body: JSON.stringify(body) });

  it('relays a well-formed close to the box and returns the locked outcome', async () => {
    const base = await start();
    const res = await post(base, { dayCloseId: 'dc-1', closedBy: 'u-mgr' });
    expect(res.status).toBe(200);
    expect(await res.json() as CloseOutcome).toMatchObject({ closed: true, tradingDay: '2026-08-06' });
    expect(calls).toEqual([{ dayCloseId: 'dc-1', closedBy: 'u-mgr' }]);
  });

  it('relays the box’s refusal verbatim (a blocker is not an error) — 200 with the reason', async () => {
    const base = await start();
    const res = await post(base, { dayCloseId: 'dc-block', closedBy: 'u-mgr' });
    expect(res.status).toBe(200);
    expect(await res.json() as CloseOutcome).toMatchObject({ closed: false, reason: 'a sale is still unsent' });
  });

  it('refuses a malformed request (no day-close id / no closer) with a 400, without calling the box', async () => {
    const base = await start();
    const res = await post(base, { closedBy: 'u-mgr' });
    expect(res.status).toBe(400);
    expect((await res.json() as CloseOutcome).closed).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('is loopback-only: a foreign origin is refused (403) BEFORE the box is asked', async () => {
    const base = await start();
    const res = await post(base, { dayCloseId: 'dc-1', closedBy: 'u-mgr' }, { 'content-type': 'application/json', origin: 'http://192.168.1.5:8080' });
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('requires application/json: a text/plain body is refused (415) BEFORE the box is asked (RR-F01)', async () => {
    const base = await start();
    const res = await post(base, { dayCloseId: 'dc-1', closedBy: 'u-mgr' }, { 'content-type': 'text/plain', origin: 'http://localhost:8080' });
    expect(res.status).toBe(415);
    expect(calls).toHaveLength(0);
  });

  it('answers the browser preflight for a loopback origin (204, names it back)', async () => {
    const base = await start();
    const res = await fetch(`${base}/lane/day-close`, {
      method: 'OPTIONS',
      headers: { origin: 'http://127.0.0.1:8080', 'access-control-request-method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:8080');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('a box that does not close the day answers 404', async () => {
    const base = await start({ withCloseDay: false });
    const res = await post(base, { dayCloseId: 'dc-1', closedBy: 'u-mgr' });
    expect(res.status).toBe(404);
  });
});
