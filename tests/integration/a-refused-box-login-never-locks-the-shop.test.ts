import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { BackoffAuthThrottle } from '../../services/kernel/src/rate-limit';

/**
 * **OB-429 (owner, 28 Oct 2026, option B): a store computer whose own head-office login is refused stops calling head
 * office, so it never locks the shop's address — and the screens say the login needs renewing.**
 *
 * Head office locks a source address after five failed sign-ins (`BackoffAuthThrottle`, the production settings below). The
 * people signing in to head office on the store PC leave the shop from the same address as the store computer's own calls.
 * Before this, a box with an expired or revoked `CLOUD_API_TOKEN` failed about fifteen calls a pass, locked the address, and
 * every person was told "too many sign-in attempts" — the real cause hidden.
 *
 * Here the REAL `startEdge` runs against a fake head office that refuses its login and counts each refusal on a real
 * throttle with the production settings. The box must: be refused ONCE and then make no call at all (however many passes
 * run), leave the address unlocked, keep the sale queued without spending its retry budget (never dead-lettered for this),
 * and say on its status what happened and what to do. Restarted with a renewed login, it sends the sale. Synthetic data;
 * nothing touches production (hard rule #7).
 */

const TENANT = 't-ob429';
const KEY = ['box', 'login', 'gate', 'signing', 'key'].join('-').padEnd(48, '0');
const SHOP_ADDRESS = 'ip:203.0.113.7'; // every call from the shop — the box's own and the people's — leaves from here

let loginGood = false;
let calls: string[];
let throttle: BackoffAuthThrottle;
const headOffice = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
  calls.push(String(url));
  if (throttle.status(SHOP_ADDRESS).locked) {
    return new Response(JSON.stringify({ error: { code: 'too_many_sign_in_attempts' } }), { status: 429 });
  }
  const auth = (init?.headers as Record<string, string> | undefined)?.['authorization'] ?? '';
  if (!loginGood || auth === '') {
    throttle.fail(SHOP_ADDRESS); // what head office's pipeline does with a token it does not believe
    return new Response(JSON.stringify({ error: { code: 'unauthenticated', whatHappened: 'This request carried no valid sign-in.' } }), { status: 401 });
  }
  throttle.succeed(SHOP_ADDRESS);
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
}) as unknown as typeof globalThis.fetch;

let realFetch: typeof globalThis.fetch;
let dir = '';
const edges: EdgeProcess[] = [];

beforeEach(async () => {
  loginGood = false;
  calls = [];
  throttle = new BackoffAuthThrottle({ threshold: 5, baseCooldownSeconds: 5, maxCooldownSeconds: 900 }); // services/api/src/main.ts
  realFetch = globalThis.fetch;
  globalThis.fetch = headOffice;
  dir = await mkdtemp(join(tmpdir(), 'sre-ob429-'));
});
afterEach(async () => {
  for (const e of edges.splice(0)) await e.stop();
  globalThis.fetch = realFetch;
  await rm(dir, { recursive: true, force: true });
});

const start = async (said: string[] = []): Promise<EdgeProcess> => {
  const edge = (await startEdge({
    EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
    CLOUD_API_URL: 'https://head-office.example.test', CLOUD_API_TOKEN: 'x'.repeat(40),
  }, (l) => { said.push(l); }))!;
  edges.push(edge);
  return edge;
};
const sale = (id: string): string => JSON.stringify({ id, total: 12_000, laneId: 'lane-1', lines: [{ productId: 'P1', qty: 1, unitPriceMinor: 12_000 }] });

describe('OB-429 — a refused store-computer login never locks the shop', () => {
  it('refused once, then silent: the address stays unlocked, the sale stays queued, the status says renew the login', async () => {
    const said: string[] = [];
    const edge = await start(said);
    await edge.node.commit('S-1', sale('S-1'));

    // A good many passes' worth of everything the box does with its own login.
    for (let pass = 0; pass < 8; pass += 1) {
      await edge.syncOnce!();
      await edge.refreshPack!().catch(() => undefined);
      await edge.refreshMigrationFeed!().catch(() => undefined);
      await edge.refreshPublishedTemplates!().catch(() => undefined);
      await edge.refreshIndentsFeed!().catch(() => undefined);
      await edge.refreshLoyaltyWallets!().catch(() => undefined);
    }

    expect(calls).toHaveLength(1);                                // head office was asked once…
    expect(throttle.status(SHOP_ADDRESS).locked).toBe(false);     // …so a person signing in from the shop is not locked out
    expect(edge.agent!.health()).toMatchObject({ unsentCount: 1, deadLetterCount: 0 }); // the sale waits, its budget not spent
    const status = edge.syncStatus();
    expect(status.cloud).toBe('login_refused');
    expect(status.staffMessage).toMatch(/refused this store computer's own login.*Selling continues\. 1 item\(s\) are saved.*Renew the store computer's head-office login, then restart/);
    expect(said.filter((l) => l.includes('refused this store computer\'s own login'))).toHaveLength(1); // said once, not every pass
    expect(said.join('\n')).not.toContain('x'.repeat(40));      // the login itself is never written down (hard rule #4)

    // The till still sells: a sale commits on the box's disk whatever head office is doing (hard rule #1).
    await edge.node.commit('S-2', sale('S-2'));
    expect(edge.agent!.health().unsentCount).toBe(2);
  });

  it('without the gate the same box would have locked the shop: five refusals lock the address (the control)', () => {
    for (let i = 0; i < 5; i += 1) throttle.fail(SHOP_ADDRESS);
    expect(throttle.status(SHOP_ADDRESS).locked).toBe(true);
  });

  it('restarted with a renewed login, the box contacts head office again and the queued sale goes', async () => {
    const first = await start();
    await first.node.commit('S-9', sale('S-9'));
    await first.syncOnce!();
    expect(first.syncStatus().cloud).toBe('login_refused');
    await first.stop();
    edges.splice(edges.indexOf(first), 1);

    loginGood = true; // the renewed login is put on the box, which is restarted
    const back = await start();
    const sent = await back.syncOnce!();
    expect(sent.sent).toBe(1);
    expect(back.agent!.health()).toMatchObject({ unsentCount: 0, deadLetterCount: 0 });
    expect(back.syncStatus().cloud).not.toBe('login_refused');
  });
});
