import { describe, it, expect, afterEach } from 'vitest';
import { startLaneServer, type LaneServer, type LaneDayReopenHandler } from '../../edge/store-edge/src/lane-server';
import type { EdgeNode } from '../../edge/store-edge/src/index';

/**
 * **An accountant/owner's screen can ask the box to REOPEN a locked day — over the box's loopback socket
 * (M14-FR-04 / §28).**
 *
 * POST /lane/day-reopen relays `{ dayCloseId, reopenedBy, reason, approvedBy }` to the box's authoritative
 * `reopenDay` (which enforces the §28 "a different person approved it" gate from the box's own log). The
 * socket only carries the request, under the same loopback + application/json authorization as the sale,
 * refund and day-close routes (RR-F01): a foreign origin or a non-JSON body is refused BEFORE `reopenDay`
 * is ever called. It answers 200 either way on a real attempt — the body says whether it reopened or the
 * stated reason why not (P-08) — and 404 on a box that does not reopen days. A reopen is audited, so a
 * request missing the day, who reopened it, a reason, or who approved it is a 400 before the box is asked.
 */

const stubNode = (): EdgeNode => ({
  pack: () => undefined,
  commit: async (id) => ({ committed: true, saleId: id } as never),
  commitReturn: async (id) => ({ committed: true, returnId: id } as never),
  commitCompletion: async (_kind, id) => ({ committed: true, completionId: id } as never),
  lookupSale: async () => undefined,
  takePack: () => ({ accepted: true, staffMessage: '' }),
});

interface ReopenOutcome { reopened: boolean; tradingDay?: string; reason?: string }

describe('the lane socket relays the reopen to the box (M14-FR-04 / §28)', () => {
  const servers: LaneServer[] = [];
  afterEach(async () => { for (const s of servers.splice(0)) await s.stop(); });

  const calls: Array<{ dayCloseId: string; reopenedBy: string; reason: string; approvedBy: string }> = [];
  const reopenDay: LaneDayReopenHandler = async (req) => {
    calls.push(req);
    // The box refuses a self-approval (§28) — the socket relays that refusal verbatim.
    if (req.approvedBy === req.reopenedBy) return { reopened: false, reason: 'a reopen needs an approval by a different person' };
    return { reopened: true, tradingDay: '2026-08-06' };
  };

  const start = async (opts: { withReopen: boolean } = { withReopen: true }) => {
    calls.splice(0);
    const s = await startLaneServer({ node: stubNode(), port: 0, ...(opts.withReopen ? { reopenDay } : {}) });
    servers.push(s);
    return `http://127.0.0.1:${s.port}`;
  };

  const post = (base: string, body: unknown, headers: Record<string, string> = { 'content-type': 'application/json', origin: 'http://localhost:8080' }) =>
    fetch(`${base}/lane/day-reopen`, { method: 'POST', headers, body: JSON.stringify(body) });

  const good = { dayCloseId: 'dc-1', reopenedBy: 'u-owner', reason: 'wrong float found next morning', approvedBy: 'u-accountant' };

  it('relays a well-formed reopen to the box and returns the reopened outcome', async () => {
    const base = await start();
    const res = await post(base, good);
    expect(res.status).toBe(200);
    expect(await res.json() as ReopenOutcome).toMatchObject({ reopened: true, tradingDay: '2026-08-06' });
    expect(calls).toEqual([good]);
  });

  it('relays the box’s §28 refusal verbatim (a blocker is not an error) — 200 with the reason', async () => {
    const base = await start();
    const res = await post(base, { ...good, approvedBy: 'u-owner' }); // approver === reopener
    expect(res.status).toBe(200);
    expect(await res.json() as ReopenOutcome).toMatchObject({ reopened: false, reason: 'a reopen needs an approval by a different person' });
  });

  it('refuses a request missing any of day/who/why/approver with a 400, without calling the box', async () => {
    const base = await start();
    for (const missing of ['dayCloseId', 'reopenedBy', 'reason', 'approvedBy'] as const) {
      const body: Record<string, unknown> = { ...good };
      delete body[missing];
      const res = await post(base, body);
      expect(res.status, `missing ${missing}`).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  it('is loopback-only: a foreign origin is refused (403) BEFORE the box is asked', async () => {
    const base = await start();
    const res = await post(base, good, { 'content-type': 'application/json', origin: 'http://192.168.1.5:8080' });
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('requires application/json: a text/plain body is refused (415) BEFORE the box is asked (RR-F01)', async () => {
    const base = await start();
    const res = await post(base, good, { 'content-type': 'text/plain', origin: 'http://localhost:8080' });
    expect(res.status).toBe(415);
    expect(calls).toHaveLength(0);
  });

  it('answers the browser preflight for a loopback origin (204, names it back)', async () => {
    const base = await start();
    const res = await fetch(`${base}/lane/day-reopen`, {
      method: 'OPTIONS',
      headers: { origin: 'http://127.0.0.1:8080', 'access-control-request-method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:8080');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('a box that does not reopen days answers 404', async () => {
    const base = await start({ withReopen: false });
    const res = await post(base, good);
    expect(res.status).toBe(404);
  });
});
