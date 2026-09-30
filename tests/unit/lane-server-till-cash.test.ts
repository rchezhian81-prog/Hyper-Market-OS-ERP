import { describe, it, expect, afterEach } from 'vitest';
import { startLaneServer, type LaneServer, type LaneCashMovementHandler, type LaneShiftCloseHandler, type LaneTillCashHandler } from '../../edge/store-edge/src/lane-server';
import type { EdgeNode } from '../../edge/store-edge/src/index';

/**
 * **The lane socket carries the till's cash to the box (SP-4c · F10 · M14-FR-01/02 · RR-F01).**
 *
 * `POST /lane/cash-movements`, `POST /lane/shift-close` and `GET /lane/till-cash` under the SAME authorization as every
 * other lane write: a foreign origin is refused (403) and a non-JSON body (415) BEFORE the box is asked; a malformed body
 * is 400 with a reason in the route's own shape and the box is never asked; a box that keeps no till cash answers 404.
 * The socket carries; the box decides — and none of the three ever answers a balance.
 */

const stubNode = (): EdgeNode => ({
  pack: () => undefined,
  commit: async (id) => ({ committed: true, saleId: id } as never),
  commitReturn: async (id) => ({ committed: true, returnId: id } as never),
  commitCompletion: async (_kind, id) => ({ committed: true, completionId: id } as never),
  commitConcessionTag: async (id) => ({ committed: true, saleId: id, laneMessage: 'saved' } as never),
  lookupSale: async () => undefined,
  takePack: () => ({ accepted: true, staffMessage: '' }),
});

const JSON_FROM_TILL = { 'content-type': 'application/json', origin: 'http://127.0.0.1:8080' };

describe('the lane socket carries the till\'s cash to the box (SP-4c)', () => {
  const servers: LaneServer[] = [];
  afterEach(async () => { for (const s of servers.splice(0)) await s.stop(); });

  const seen: { movements: unknown[]; closes: unknown[] } = { movements: [], closes: [] };
  const recordCashMovement: LaneCashMovementHandler = async (req) => {
    seen.movements.push(req);
    return { committed: true, movementId: req.movementId, kind: req.movementKind, custodian: req.custodianId, tradingDay: '2026-09-30', laneMessage: 'Recorded on the store computer.' };
  };
  const closeShift: LaneShiftCloseHandler = async (req) => {
    seen.closes.push(req);
    return { closed: true, shiftId: req.shiftId, tradingDay: '2026-09-30', countedMinor: req.countedMinor, varianceMinor: 0, exceptionRaised: false, reasonCode: req.reasonCode ?? null, laneMessage: 'Closed.' };
  };
  const tillCash: LaneTillCashHandler = async () => ({ tillId: 'lane-1', laneId: 'lane-1', custodian: 'u-meena', openedAt: '2026-09-30T09:00:00.000Z', shiftOpen: true });

  const start = async (withCash = true) => {
    seen.movements.splice(0); seen.closes.splice(0);
    const s = await startLaneServer({ node: stubNode(), port: 0, ...(withCash ? { recordCashMovement, closeShift, tillCash } : {}) });
    servers.push(s);
    return `http://127.0.0.1:${s.port}`;
  };
  const post = (base: string, path: string, body: unknown, headers: Record<string, string> = JSON_FROM_TILL) =>
    fetch(`${base}${path}`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });

  const movement = { movementId: 'cm-1', movementKind: 'float_issue', amountMinor: 200_000, at: '2026-09-30T09:00:00.000Z', custodianId: 'u-meena' };
  const close = { shiftId: 'sh-1', closedAt: '2026-09-30T20:00:00.000Z', cashierId: 'u-meena', countedMinor: 200_000, denominations: [{ denominationMinor: 50_000, count: 4 }] };

  it('carries a movement to the box and returns the box\'s answer; the recorder defaults to the custodian', async () => {
    const base = await start();
    const res = await post(base, '/lane/cash-movements', movement);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ committed: true, movementId: 'cm-1', kind: 'float_issue', custodian: 'u-meena' });
    expect(seen.movements).toEqual([{ ...movement, performedBy: 'u-meena' }]);
  });

  it('carries a close to the box with the count, the denominations and — when given — the reason', async () => {
    const base = await start();
    expect(await (await post(base, '/lane/shift-close', close)).json()).toMatchObject({ closed: true, shiftId: 'sh-1', varianceMinor: 0 });
    expect(await (await post(base, '/lane/shift-close', { ...close, reasonCode: 'miscount' })).json()).toMatchObject({ closed: true, reasonCode: 'miscount' });
    expect(seen.closes).toHaveLength(2);
    expect(seen.closes[0]).toEqual(close);
    expect(seen.closes[1]).toEqual({ ...close, reasonCode: 'miscount' });
  });

  it('answers where the till\'s cash stands — custody only, never cached — and refuses a foreign origin', async () => {
    const base = await start();
    const res = await fetch(`${base}/lane/till-cash`, { headers: { origin: 'http://localhost:8091' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json() as Record<string, unknown>;
    expect(body).toEqual({ tillId: 'lane-1', laneId: 'lane-1', custodian: 'u-meena', openedAt: '2026-09-30T09:00:00.000Z', shiftOpen: true });
    expect(Object.keys(body)).not.toContain('balanceMinor');
    expect((await fetch(`${base}/lane/till-cash`, { headers: { origin: 'https://evil.example' } })).status).toBe(403);
  });

  it('refuses a foreign origin (403) and a non-JSON body (415) BEFORE the box is asked (RR-F01)', async () => {
    const base = await start();
    const foreign = await post(base, '/lane/cash-movements', movement, { 'content-type': 'application/json', origin: 'https://evil.example' });
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toMatchObject({ committed: false, refusedBecause: 'not_readable' });
    const text = await post(base, '/lane/shift-close', close, { 'content-type': 'text/plain', origin: 'http://127.0.0.1:8080' });
    expect(text.status).toBe(415);
    expect(await text.json()).toMatchObject({ closed: false, refusedBecause: 'not_readable' });
    expect(seen.movements).toHaveLength(0);
    expect(seen.closes).toHaveLength(0);
  });

  it('a malformed request is 400 with a reason in the route\'s own shape, and the box is never asked', async () => {
    const base = await start();
    for (const bad of ['{not json', { movementId: 'cm-1' }, { ...movement, amountMinor: 12.5 }, { ...movement, at: 'yesterday' }]) {
      const res = await post(base, '/lane/cash-movements', bad);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ committed: false, refusedBecause: 'not_readable' });
    }
    for (const bad of [{ shiftId: 'sh-1' }, { ...close, countedMinor: '200000' }, { ...close, closedAt: 'tonight' }]) {
      const res = await post(base, '/lane/shift-close', bad);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ closed: false, refusedBecause: 'not_readable' });
    }
    expect(seen.movements).toHaveLength(0);
    expect(seen.closes).toHaveLength(0);
  });

  it('a box that keeps no till cash answers 404 on all three — the till then says it is not connected', async () => {
    const base = await start(false);
    expect((await post(base, '/lane/cash-movements', movement)).status).toBe(404);
    expect(await (await post(base, '/lane/shift-close', close)).json()).toMatchObject({ closed: false, refusedBecause: 'no_store_box' });
    expect((await fetch(`${base}/lane/till-cash`, { headers: { origin: 'http://127.0.0.1:8080' } })).status).toBe(404);
  });

  it('answers the browser\'s preflight for a loopback origin on all three routes', async () => {
    const base = await start();
    for (const path of ['/lane/cash-movements', '/lane/shift-close', '/lane/till-cash']) {
      const ok = await fetch(`${base}${path}`, { method: 'OPTIONS', headers: { origin: 'http://127.0.0.1:8080' } });
      expect(ok.status).toBe(204);
      expect(ok.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:8080');
      expect((await fetch(`${base}${path}`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } })).status).toBe(403);
    }
  });
});
