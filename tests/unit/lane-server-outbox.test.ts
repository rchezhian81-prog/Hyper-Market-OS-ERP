import { describe, it, expect, afterEach } from 'vitest';
import { startLaneServer, type LaneServer, type LaneDeviceRelayHandler, type LaneDeviceStatusHandler, type LaneOperatorPort } from '../../edge/store-edge/src/lane-server';
import type { EdgeNode } from '../../edge/store-edge/src/index';
import { makeEvent } from '../../packages/contracts/src/event';

/**
 * **A screen or handheld hands its saved work to the box over the lane socket (SP-2a · F11 · §31 · RR-F01).**
 *
 * `POST /lane/outbox` carries a device's batch to the box's `relayDeviceEvents` decision and returns its per-item
 * acks; `GET /lane/outbox/status?keys=` returns where the items it took have got to. Both under the SAME
 * authorization as every other lane write: a foreign origin is refused (403) and a non-JSON body (415) BEFORE the
 * box is asked; a malformed envelope is 400 with a reason and the box is never asked; a box that relays no device
 * work answers 404. The socket carries; the box decides.
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

const AT = '2026-09-30T10:00:00.000Z';
const decided = (id: string) => makeEvent({
  id: `approval-decision-${id}`, type: 'ApprovalDecided', occurredAt: AT, idempotencyKey: `approval-decision-${id}`,
  source: 'web-erp/manager', payload: { id, status: 'approved' },
});

describe('the lane socket carries device work to the box (SP-2a)', () => {
  const servers: LaneServer[] = [];
  afterEach(async () => { for (const s of servers.splice(0)) await s.stop(); });

  const seen: { source: string; items: readonly unknown[] }[] = [];
  const relay: LaneDeviceRelayHandler = async (batch) => {
    seen.push(batch);
    return { acks: batch.items.map((raw) => ({ key: (raw as { key: string }).key, status: 'accepted' as const })) };
  };
  const status: LaneDeviceStatusHandler = (keys) => keys.map((key) => ({ key, state: key === 'gone' ? 'posted' as const : 'pending' as const, attempts: 0 }));

  const start = async (opts: { withRelay: boolean } = { withRelay: true }) => {
    seen.splice(0);
    const s = await startLaneServer({ node: stubNode(), port: 0, ...(opts.withRelay ? { relayDeviceEvents: relay, deviceEventStatus: status } : {}) });
    servers.push(s);
    return `http://127.0.0.1:${s.port}`;
  };
  const post = (base: string, body: unknown, headers: Record<string, string> = { 'content-type': 'application/json', origin: 'http://localhost:8080' }) =>
    fetch(`${base}/lane/outbox`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });

  it('relays a well-formed batch and returns the box\'s per-item acks', async () => {
    const base = await start();
    const e = decided('a1');
    const res = await post(base, { source: 'manager', items: [{ key: e.idempotencyKey, event: e }] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ acks: [{ key: 'approval-decision-a1', status: 'accepted' }] });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.source).toBe('manager');
    expect(seen[0]?.items).toHaveLength(1);
  });

  it('answers where handed items have got to, never cached', async () => {
    const base = await start();
    const res = await fetch(`${base}/lane/outbox/status?keys=${encodeURIComponent('k1,gone')}`, { headers: { origin: 'http://127.0.0.1:8091' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ items: [{ key: 'k1', state: 'pending', attempts: 0 }, { key: 'gone', state: 'posted', attempts: 0 }] });
  });

  it('refuses a malformed envelope with a reason (400) WITHOUT asking the box', async () => {
    const base = await start();
    const noSource = await post(base, { items: [] });
    expect(noSource.status).toBe(400);
    expect(((await noSource.json()) as { reason: string }).reason).toMatch(/source/);
    const notJson = await post(base, '{not json');
    expect(notJson.status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it('is loopback-only: a foreign origin is refused (403) BEFORE the box is asked, on both routes', async () => {
    const base = await start();
    const write = await post(base, { source: 'manager', items: [] }, { 'content-type': 'application/json', origin: 'http://192.168.1.5:8080' });
    expect(write.status).toBe(403);
    const read = await fetch(`${base}/lane/outbox/status?keys=k1`, { headers: { origin: 'https://untrusted.invalid' } });
    expect(read.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it('requires application/json: a text/plain body is refused (415) BEFORE the box is asked (RR-F01)', async () => {
    const base = await start();
    const res = await post(base, { source: 'manager', items: [] }, { 'content-type': 'text/plain', origin: 'http://localhost:8080' });
    expect(res.status).toBe(415);
    expect(seen).toHaveLength(0);
  });

  it('a box that relays no device work says so (404) on both routes, and lists the routes on the socket\'s 404', async () => {
    const base = await start({ withRelay: false });
    expect((await post(base, { source: 'manager', items: [] })).status).toBe(404);
    expect((await fetch(`${base}/lane/outbox/status?keys=k1`)).status).toBe(404);
    const unknown = await fetch(`${base}/lane/nothing`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: string }).error).toContain('POST /lane/outbox');
    expect(((await unknown.json().catch(() => ({ error: '' }))) as { error: string }).error ?? '').toBeDefined();
  });

  it('answers the browser\'s preflight for a loopback origin on both routes, and refuses it for a foreign one', async () => {
    const base = await start();
    for (const path of ['/lane/outbox', '/lane/outbox/status']) {
      const ok = await fetch(`${base}${path}`, { method: 'OPTIONS', headers: { origin: 'http://127.0.0.1:8091' } });
      expect(ok.status).toBe(204);
      expect(ok.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:8091');
      const no = await fetch(`${base}${path}`, { method: 'OPTIONS', headers: { origin: 'http://192.168.1.5:8080' } });
      expect(no.status).toBe(403);
    }
  });

  it('a box that throws mid-batch is a 500 with no verdict on any item — the device keeps them all', async () => {
    seen.splice(0);
    const s = await startLaneServer({ node: stubNode(), port: 0, relayDeviceEvents: async () => { throw new Error('disk went away'); } });
    servers.push(s);
    const res = await post(`http://127.0.0.1:${s.port}`, { source: 'manager', items: [] });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ acks: [], reason: 'disk went away' });
  });
});

describe('the lane socket tells the box who it verified for a batch — never from the body (2b-vi-c-3)', () => {
  const servers: LaneServer[] = [];
  afterEach(async () => { for (const s of servers.splice(0)) await s.stop(); });
  type Seen = Parameters<LaneDeviceRelayHandler>[0];
  const seen: Seen[] = [];
  const relay: LaneDeviceRelayHandler = async (batch) => { seen.push(batch); return { acks: [] }; };
  const operators = (trustForwardedUser: boolean): LaneOperatorPort => ({
    laneId: 'lane-7', trustForwardedUser,
    signIn: async () => ({ signedIn: false } as never),
    signInVerified: async () => ({ signedIn: false } as never),
    // One live session: the token `t-meena` is Meena, signed in with her PIN at lane-7.
    check: (token) => token === 't-meena'
      ? { ok: true, userId: 'u-meena', displayName: 'Meena', via: 'pin', expiresAt: '2026-09-30T20:00:00.000Z' } as never
      : { ok: false, refusedBecause: 'not_signed_in', laneMessage: 'sign in' } as never,
    signOut: async () => false,
  });
  const start = async (trust: boolean) => {
    seen.splice(0);
    const s = await startLaneServer({ node: stubNode(), port: 0, relayDeviceEvents: relay, operators: operators(trust) });
    servers.push(s);
    return `http://127.0.0.1:${s.port}`;
  };
  const send = (base: string, headers: Record<string, string>) => fetch(`${base}/lane/outbox`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:8080', ...headers },
    body: JSON.stringify({ source: 'manager', items: [], verifiedPerson: { userId: 'u-owner', via: 'pin', laneId: 'lane-7' } }),
  });

  it('the till session it carries names the person; a body claiming somebody is ignored', async () => {
    const base = await start(false);
    await send(base, { 'x-sre-operator': 't-meena' });
    expect(seen[0]?.verifiedPerson).toEqual({ userId: 'u-meena', via: 'pin', laneId: 'lane-7' });
    await send(base, {});
    expect(seen[1]?.verifiedPerson).toBeUndefined();
  });

  it('the forwarded sign-in counts only on the hosted copy', async () => {
    const store = await start(false);
    await send(store, { 'x-sre-user': 'u-owner' });
    expect(seen[0]?.verifiedPerson).toBeUndefined();
    const hosted = await start(true);
    await send(hosted, { 'x-sre-user': 'u-owner' });
    expect(seen[0]?.verifiedPerson).toEqual({ userId: 'u-owner', via: 'verified_sign_in', laneId: 'lane-7' });
  });
});

