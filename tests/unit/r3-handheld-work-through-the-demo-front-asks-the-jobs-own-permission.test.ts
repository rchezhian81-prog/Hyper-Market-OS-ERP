// Round 3 (screen gap audit, 31 Oct 2026: "handheld writes through the demo front are allowed only for people who may
// sell") — SEC-1's rule for the handhelds. On the hosted copy the picker, driver and warehouse screens hand their work to
// the box through their OWN door (`/store-handheld`, marked `X-Sre-Door: handheld` by the front, naming the person), and
// the box holds each job to its own permission — the right the phone sign-in asks for — never to "may sell", and never
// wider: the door takes handheld work only, the till's door is unchanged, and a store box trusts neither header.

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { startLaneServer, HANDHELD_DOOR, type LaneServer, type LaneDeviceRelayHandler, type LaneOperatorPort } from '../../edge/store-edge/src/lane-server';
import { HANDHELD_AUTHORITY } from '../../edge/store-edge/src/handheld-sign-in';
import type { EdgeNode } from '../../edge/store-edge/src/index';
import { makeEvent } from '../../packages/contracts/src/event';

const stubNode = (): EdgeNode => ({
  pack: () => undefined,
  commit: async (id) => ({ committed: true, saleId: id } as never),
  commitReturn: async (id) => ({ committed: true, returnId: id } as never),
  commitCompletion: async (_kind, id) => ({ committed: true, completionId: id } as never),
  commitConcessionTag: async (id) => ({ committed: true, saleId: id, laneMessage: 'saved' } as never),
  lookupSale: async () => undefined,
  takePack: () => ({ accepted: true, staffMessage: '' }),
});

/** The box's role register, as its pack says: who holds which right. */
const PERMS: Record<string, readonly string[]> = {
  'u-picker': [HANDHELD_AUTHORITY.picker],
  'u-driver': [HANDHELD_AUTHORITY.driver],
  'u-stores': [HANDHELD_AUTHORITY.warehouse],
  'u-cashier': ['pos.sale.sync'],
};
const operators = (trust: boolean): LaneOperatorPort => ({
  laneId: 'lane-1', trustForwardedUser: trust,
  signIn: async () => ({ signedIn: false } as never), signInVerified: async () => ({ signedIn: false } as never),
  check: () => ({ ok: false, refusedBecause: 'not_signed_in', laneMessage: 'no' } as never), signOut: async () => false,
});
const item = (key: string) => ({ key, event: makeEvent({ id: key, type: 'PickLineResolved', occurredAt: '2026-10-31T09:00:00.000Z', idempotencyKey: key, source: 'picker', payload: {} }) });

describe('handheld work through the demo front asks the job\'s own permission (SEC-1\'s rule)', () => {
  const servers: LaneServer[] = [];
  afterEach(async () => { for (const s of servers.splice(0)) await s.stop(); });
  const taken: string[] = [];
  const relay: LaneDeviceRelayHandler = async (batch) => { taken.push(batch.source); return { acks: batch.items.map((r) => ({ key: (r as { key: string }).key, status: 'accepted' as const })) }; };
  const start = async (trust = true): Promise<string> => {
    taken.splice(0);
    const s = await startLaneServer({ node: stubNode(), port: 0, relayDeviceEvents: relay, operators: operators(trust), forwardedPermissionsOf: (u) => PERMS[u] ?? null });
    servers.push(s);
    return `http://127.0.0.1:${s.port}`;
  };
  const post = async (base: string, source: string, headers: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await fetch(`${base}/lane/outbox`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ source, items: [item(`k-${source}-${Math.random()}`)] }) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const door = (user?: string): Record<string, string> => ({ 'x-sre-door': HANDHELD_DOOR, ...(user === undefined ? {} : { 'x-sre-user': user }) });

  it('a picker, a driver and a warehouse person each hand over their OWN job — none of them may sell', async () => {
    const base = await start();
    expect((await post(base, 'picker', door('u-picker'))).status).toBe(200);
    expect((await post(base, 'driver', door('u-driver'))).status).toBe(200);
    expect((await post(base, 'warehouse', door('u-stores'))).status).toBe(200);
    expect(taken).toEqual(['picker', 'driver', 'warehouse']);
  });

  it('never wider: a seller without the job\'s right, another job\'s holder, nobody named, or office work on this door is refused before the box is asked', async () => {
    const base = await start();
    const cashier = await post(base, 'picker', door('u-cashier'));
    expect([cashier.status, cashier.body['refusedBecause']]).toEqual([403, 'lacks_permission']);
    expect(String(cashier.body['reason'])).toContain(HANDHELD_AUTHORITY.picker);
    expect((await post(base, 'warehouse', door('u-picker'))).status).toBe(403);
    expect((await post(base, 'driver', door('u-stranger'))).status).toBe(403);
    const nobody = await post(base, 'picker', door());
    expect([nobody.status, nobody.body['refusedBecause']]).toEqual([401, 'nobody_signed_in']);
    const office = await post(base, 'manager', door('u-picker'));
    expect([office.status, office.body['refusedBecause']]).toEqual([403, 'not_handheld_work']);
    expect(taken).toEqual([]);
  });

  it('the till\'s door is unchanged (the front still asks "may sell" there), and a store box trusts neither header', async () => {
    const hosted = await start();
    expect((await post(hosted, 'manager', { 'x-sre-user': 'u-cashier' })).status).toBe(200);
    const store = await start(false);
    expect((await post(store, 'picker', door('u-cashier'))).status).toBe(200); // a store's own phones go through the device socket's PIN sign-in
  });
});

describe('the demo front and relay route handheld work through the handheld door, and only there', () => {
  const RELAY = readFileSync('infra/compose/nginx.edge-relay.conf', 'utf8');
  for (const conf of ['infra/compose/nginx.pilot.conf', 'infra/compose/nginx.identity.conf']) {
    it(`${conf}: the handheld door asks the sign-in (not "may sell"), names the person, marks the door, and carries the outbox only`, () => {
      const FRONT = readFileSync(conf, 'utf8');
      const block = /location ~ \^\/store-handheld\/lane\/outbox\(\/status\)\?\$ \{([^}]*)\}/.exec(FRONT)?.[1] ?? '';
      expect(block).toMatch(/auth_request \/_auth\/verify;/);
      expect(block).not.toMatch(/verify-sell/);
      expect(block).toMatch(/auth_request_set \$sre_user \$upstream_http_x_sre_user;/);
      expect(block).toMatch(/proxy_set_header X-Sre-User \$sre_user;/);
      expect(block).toMatch(/proxy_set_header X-Sre-Door handheld;/);
      expect(block).toMatch(/rewrite \^\/store-handheld\/\(\.\*\)\$ \/\$1 break;/);
      expect(FRONT.match(/store-handheld/g)?.length).toBe(2); // the one location and its rewrite — nothing else is reachable
      expect(/location \/store-lane\/ \{([^}]*)\}/.exec(FRONT)?.[1]).toMatch(/auth_request \/_auth\/verify-sell;/); // the till's door unchanged
    });
  }
  it('the relay points ONLY the three handheld screens at the handheld door', () => {
    const block = /location ~ \^\/store\/\(picker\|driver\|warehouse\)\/ \{([\s\S]*?)\n {2}\}/.exec(RELAY)?.[1] ?? '';
    expect(block).toMatch(/'window\.laneWriteBase = "\/store-handheld"'/);
    expect(block).toMatch(/limit_except GET \{ deny all; \}/);
    expect(RELAY.match(/"\/store-handheld"/g)?.length).toBe(1);
  });
});
