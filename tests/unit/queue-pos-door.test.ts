import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  queuePosDoor, handheldTenderRefusal, queuePosOffPage, queuePosSignInPage, QUEUE_POS_LANE_ROUTES, HANDHELD_TENDERS,
  type QueuePosDoorDeps, type QueuePosSwitches,
} from '../../edge/store-edge/src/queue-pos-door';
import { QueueBaskets } from '../../edge/store-edge/src/queue-baskets';
import type { CheckOutcome } from '../../edge/store-edge/src/till-operators';

/**
 * **D04-FR-05 — the queue till's door on the device socket refuses what it must, before anything is written.** Driven
 * over a real HTTP socket with stand-in registers: the switch (OB-316), the person (signed in FOR SELLING on this phone),
 * the routes (a queue till never reaches refunds, cash, approvals, holds or the day close), the tenders (card and UPI
 * only — a handheld takes no cash, OB-372), and every refusal in English and Tamil.
 */

const ON: QueuePosSwitches = { laneId: 'lane-1', known: true, why: null, queueBusting: true, payments: true };
const SELLING: CheckOutcome = { ok: true, userId: 'u-ravi', displayName: 'Ravi', via: 'pin', expiresAt: '2099-01-01T00:00:00.000Z', authority: 'pos.sale.sync' };
const WAREHOUSE: CheckOutcome = { ...SELLING, authority: 'inventory.movement.append' };

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

async function door(options: Partial<Omit<QueuePosDoorDeps, 'switches'>> & { holder?: CheckOutcome; switches?: QueuePosSwitches } = {}) {
  const { holder, switches, ...over } = options;
  // The lane pipeline stand-in: records what reached it and answers like the lane socket.
  const reached: { method: string; url: string; operator: string | undefined; body: string }[] = [];
  const lane: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      reached.push({ method: req.method ?? '', url: req.url ?? '', operator: req.headers['x-sre-operator'] as string | undefined, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ committed: true, from: 'lane' }));
    });
  });
  await new Promise<void>((r) => lane.listen(0, '127.0.0.1', () => r()));
  const lanePort = (lane.address() as { port: number }).port;
  const dir = await mkdtemp(join(tmpdir(), 'sre-queue-door-'));
  const baskets = await QueueBaskets.open({ dataDir: dir, capacityBytes: 1_000_000, codes: () => ['4821'], now: () => '2026-10-24T10:00:00.000Z' });
  const signIns: unknown[] = [];
  const d = queuePosDoor({
    appsDir: 'apps',
    switches: () => switches ?? ON,
    operators: {
      signIn: async (i) => { signIns.push(i); return i.pin === '123456' ? { signedIn: true, token: 'tok-1', userId: i.staffId, displayName: 'Ravi', expiresAt: '2099-01-01T00:00:00.000Z', via: 'pin' } : { signedIn: false, refusedBecause: 'wrong_staff_id_or_pin', laneMessage: 'That staff ID and PIN do not match.' }; },
      check: (token) => (token === 'tok-1' ? holder ?? SELLING : { ok: false, refusedBecause: 'operator_not_signed_in', laneMessage: 'Nobody is signed in.' }),
      signOut: async () => true,
    },
    queueBaskets: baskets,
    laneFor: async () => ({ host: '127.0.0.1', port: lanePort }),
    page: (lane) => ({ posLane: { laneId: lane }, posCatalogue: { products: [] } }),
    shopTimeZone: () => 'Asia/Kolkata',
    now: () => '2026-10-24T10:00:00.000Z',
    ...over,
  });
  const front: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    void d.handle(req, res, { deviceId: 'hh-q1', pathname: url.pathname, search: url.search });
  });
  await new Promise<void>((r) => front.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(front.address() as { port: number }).port}`;
  cleanups.push(async () => {
    await new Promise<void>((r) => front.close(() => r()));
    await new Promise<void>((r) => lane.close(() => r()));
    await baskets.close();
    await rm(dir, { recursive: true, force: true });
  });
  const call = (path: string, init: RequestInit & { signedIn?: boolean } = {}) => fetch(`${base}${path}`, {
    redirect: 'manual', ...init,
    headers: { ...(init.signedIn === false ? {} : { cookie: 'sre_operator=tok-1' }), ...(init.headers as Record<string, string> | undefined) },
  });
  const postJson = (path: string, body: unknown, signedIn = true) => call(path, { method: 'POST', signedIn, headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
  return { call, postJson, reached, signIns, owns: d.owns };
}

const SALE = (kind: string) => ({ id: 'S-1', cashierId: 'u-ravi', total: 12_000, tenders: [{ kind, amount: { minor: 12_000, currency: 'INR' }, status: 'settled' }] });

describe('the door owns only its own paths', () => {
  it('/queue-pos and below — never the warehouse, picker or driver screens', async () => {
    const { owns } = await door();
    expect([owns('/queue-pos'), owns('/queue-pos/'), owns('/queue-pos/lane/sales'), owns('/queue-posx'), owns('/warehouse/'), owns('/lane/sales')]).toEqual([true, true, true, false, false, false]);
  });
});

describe('switched off (OB-316): nothing but the reason', () => {
  const OFF: QueuePosSwitches = { laneId: 'lane-1', known: false, why: 'the store pack carries no rollout switches — every trial feature is off on this lane', queueBusting: false, payments: false };
  it('the page says so in English and Tamil (403); a lane route answers the refusal in its body; a hand-over is refused; sign-out still works', async () => {
    const { call, postJson, reached } = await door({ switches: OFF });
    const page = await call('/queue-pos/', { headers: { accept: 'text/html' } });
    expect(page.status).toBe(403);
    expect(await page.text()).toMatch(/switched off[\s\S]*not told|rollout switches[\s\S]*அணைக்கப்பட்டுள்ளது/);
    const sale = await postJson('/queue-pos/lane/sales', SALE('card'));
    expect([sale.status, await sale.json()]).toEqual([200, expect.objectContaining({ committed: false, refusedBecause: 'queue_busting_off', laneMessageTa: expect.stringMatching(/[஀-௿]/) })]);
    const handOver = await postJson('/queue-pos/handoff', { basketId: 'B-1', lines: [] });
    expect([handOver.status, (await handOver.json() as { refusedBecause: string }).refusedBecause]).toEqual([403, 'queue_busting_off']);
    const out = await call('/queue-pos/sign-out', { method: 'POST' });
    expect([out.status, out.headers.get('location'), out.headers.get('set-cookie')]).toEqual([303, '/queue-pos/sign-in', 'sre_operator=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0']);
    expect(reached).toEqual([]);
  });
});

describe('who: signed in on THIS phone, for SELLING', () => {
  it('signs in with the person\'s own till PIN for pos.sale.sync, as an HttpOnly cookie; a wrong PIN is refused', async () => {
    const { call, signIns } = await door();
    expect((await call('/queue-pos/sign-in', { signedIn: false })).status).toBe(200);
    const bad = await call('/queue-pos/sign-in', { method: 'POST', signedIn: false, headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ staffId: 'u-ravi', pin: '000000' }) });
    expect(bad.status).toBe(401);
    const good = await call('/queue-pos/sign-in', { method: 'POST', signedIn: false, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'staffId=u-ravi&pin=123456' });
    expect([good.status, good.headers.get('location')]).toEqual([303, '/queue-pos/']);
    expect(good.headers.get('set-cookie')).toBe('sre_operator=tok-1; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=14400');
    expect(signIns).toEqual([
      { staffId: 'u-ravi', pin: '000000', deviceId: 'hh-q1', authority: 'pos.sale.sync' },
      { staffId: 'u-ravi', pin: '123456', deviceId: 'hh-q1', authority: 'pos.sale.sync' },
    ]);
  });

  it('nobody signed in → the page sends you to sign in, a lane route is 401; a WAREHOUSE sign-in on this phone opens nothing', async () => {
    const anon = await door();
    expect((await anon.call('/queue-pos/', { signedIn: false, headers: { accept: 'text/html' } })).headers.get('location')).toBe('/queue-pos/sign-in');
    expect((await anon.postJson('/queue-pos/lane/sales', SALE('card'), false)).status).toBe(401);
    const picker = await door({ holder: WAREHOUSE });
    expect((await picker.call('/queue-pos/', { headers: { accept: 'text/html' } })).headers.get('location')).toBe('/queue-pos/sign-in');
    expect((await picker.postJson('/queue-pos/lane/sales', SALE('card'))).status).toBe(401);
    expect((await picker.postJson('/queue-pos/handoff', { basketId: 'B-1', lines: [] })).status).toBe(401);
    expect(picker.reached).toEqual([]);
  });

  it('the signed-in page is served with the pack, the lane `device:<id>` and the switches — and the sign-in strip', async () => {
    const { call } = await door();
    const html = await (await call('/queue-pos/', { headers: { accept: 'text/html' } })).text();
    expect(html).toContain('<script>window.posLane = {"laneId":"device:hh-q1"};</script>');
    expect(html).toMatch(/window\.queuePos = \{"laneId":"device:hh-q1","boxLaneId":"lane-1","payments":true/);
    expect(html).toMatch(/data-phone-holder/);
  });

  it('OB-606/607 (R16-A): the page is served the shop\'s zone the box\'s pack names — read per page, no network call', async () => {
    let zone = 'Asia/Dubai';
    const { call } = await door({ shopTimeZone: () => zone });
    expect(await (await call('/queue-pos/', { headers: { accept: 'text/html' } })).text()).toContain('<script>window.shopTimeZone = "Asia/Dubai";</script>');
    zone = 'Asia/Kolkata'; // a new pack naming another zone reaches the next page served
    expect(await (await call('/queue-pos/', { headers: { accept: 'text/html' } })).text()).toContain('<script>window.shopTimeZone = "Asia/Kolkata";</script>');
  });
});

describe('the routes a queue till reaches — and none it must not', () => {
  it('only the operator status, sync status, sale, receipt numbers, card attempts and void evidence; never a refund, cash, a hold or a close', () => {
    expect(Object.keys(QUEUE_POS_LANE_ROUTES).sort()).toEqual(['/lane/operator', '/lane/payment-attempts', '/lane/payment-attempts/answer', '/lane/payment-attempts/recover', '/lane/receipt-numbers', '/lane/sales', '/lane/sync-status', '/lane/till-activity']);
  });

  it('a card sale reaches the lane pipeline under the phone holder\'s session — the cookie becomes the till\'s session header', async () => {
    const { postJson, reached } = await door();
    const r = await postJson('/queue-pos/lane/sales', SALE('card'));
    expect(await r.json()).toEqual({ committed: true, from: 'lane' });
    expect(reached).toEqual([{ method: 'POST', url: '/lane/sales', operator: 'tok-1', body: JSON.stringify(SALE('card')) }]);
  });

  it('cash, points, store credit and "paid on old system" are refused before anything is written', async () => {
    const { postJson, reached } = await door();
    for (const kind of ['cash', 'loyalty_points', 'store_credit', 'paid_on_old_erp']) {
      expect(await (await postJson('/queue-pos/lane/sales', SALE(kind))).json()).toMatchObject({ committed: false, refusedBecause: 'tender_not_on_handheld', laneMessageTa: expect.stringMatching(/[஀-௿]/) });
    }
    expect(await (await postJson('/queue-pos/lane/sales', { ...SALE('card'), tenders: [] })).json()).toMatchObject({ refusedBecause: 'tender_not_on_handheld' });
    expect(reached).toEqual([]);
    expect(HANDHELD_TENDERS).toEqual(['card', 'upi']);
    expect(handheldTenderRefusal(SALE('upi'))).toBe(false);
    expect(handheldTenderRefusal({ tenders: [{ kind: 'card' }, { kind: 'cash' }] })).toBe(true);
  });

  it('payments.mobile_pos off: a sale, a receipt number and a card attempt are refused in the body; the operator status still answers', async () => {
    const { postJson, call, reached } = await door({ switches: { ...ON, payments: false } });
    for (const path of ['/queue-pos/lane/sales', '/queue-pos/lane/receipt-numbers', '/queue-pos/lane/payment-attempts']) {
      const r = await postJson(path, SALE('card'));
      expect([path, r.status, (await r.json() as { refusedBecause: string }).refusedBecause]).toEqual([path, 200, 'mobile_pos_payment_off']);
    }
    expect((await call('/queue-pos/lane/operator')).status).toBe(200);
    expect(reached.map((x) => x.url)).toEqual(['/lane/operator']);
  });

  it('a refund, cash movement, approval, hold, sign-in at the lane or day close is not served (404), in both languages', async () => {
    const { postJson, reached } = await door();
    for (const path of ['/lane/returns', '/lane/cash-movements', '/lane/shift-close', '/lane/approvals', '/lane/held-bills', '/lane/operator/sign-in', '/lane/day-close', '/lane/outbox', '/lane/peripherals']) {
      const r = await postJson(`/queue-pos${path}`, {});
      expect([path, r.status, (await r.json() as { laneMessageTa: string }).laneMessageTa]).toEqual([path, 404, expect.stringMatching(/[஀-௿]/)]);
    }
    expect(reached).toEqual([]);
  });

  it('only a VOID is recorded as till activity from a handheld (no no-sale, no price change)', async () => {
    const { postJson, reached } = await door();
    expect(await (await postJson('/queue-pos/lane/till-activity', { kind: 'price_override' })).json()).toMatchObject({ recorded: false, refusedBecause: 'not_served_on_the_queue_till' });
    expect(await (await postJson('/queue-pos/lane/till-activity', { kind: 'no_sale' })).json()).toMatchObject({ recorded: false });
    await postJson('/queue-pos/lane/till-activity', { kind: 'void', activityId: 'V-1' });
    expect(reached.map((x) => x.url)).toEqual(['/lane/till-activity']);
  });

  it('a body that is not JSON is refused (415); no lane pipeline here (503); the pipeline gone (502) — said, never a fake success', async () => {
    const { call } = await door();
    expect((await call('/queue-pos/lane/sales', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status).toBe(415);
    const none = await door({ laneFor: async () => null });
    const r = await none.postJson('/queue-pos/lane/sales', SALE('card'));
    expect([r.status, (await r.json() as { refusedBecause: string }).refusedBecause]).toEqual([503, 'no_lane_here']);
    const gone = await door({ laneFor: async () => ({ host: '127.0.0.1', port: 1 }) });
    const g = await gone.postJson('/queue-pos/lane/sales', SALE('card'));
    expect([g.status, (await g.json() as { refusedBecause: string }).refusedBecause]).toEqual([502, 'lane_unreachable']);
  });
});

describe('the hand-over through the door', () => {
  it('parks the basket as the signed-in person on this phone, lists it, and gives it up with a reason', async () => {
    const { postJson, call } = await door();
    const lines = [{ productId: 'P-DAL', name: 'Toor dal 1kg', barcode: '8901234567890', quantityMinor: 1 }];
    expect(await (await postJson('/queue-pos/handoff', { basketId: 'B-1', lines, handheldTotalMinor: 12_000 })).json()).toMatchObject({ handedOver: true, code: '4821', lineCount: 1, laneMessageTa: expect.stringMatching(/4821/) });
    expect(await (await call('/queue-pos/handoff', { headers: { accept: 'application/json' } })).json()).toEqual({ waiting: [{ code: '4821', basketId: 'B-1', handedOverAt: '2026-10-24T10:00:00.000Z', lineCount: 1, handheldTotalMinor: 12_000 }] });
    expect(await (await postJson('/queue-pos/handoff/give-up', { code: '4821', reason: 'Customer left the queue' })).json()).toMatchObject({ givenUp: true });
    expect((await call('/queue-pos/handoff', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status).toBe(415);
  });

  it('a store computer with no queue-basket register says so (404) — never pretends to keep one', async () => {
    const { postJson } = await door({ queueBaskets: null });
    const r = await postJson('/queue-pos/handoff', { basketId: 'B-1', lines: [] });
    expect([r.status, (await r.json() as { refusedBecause: string }).refusedBecause]).toEqual([404, 'not_served']);
  });
});

describe('the pages, in both languages', () => {
  it('the sign-in page and the off page carry English and Tamil, 56 px fields', () => {
    const sign = queuePosSignInPage({ en: 'Your sign-in ended.', ta: 'முடிந்தது.' });
    expect(sign).toMatch(/Sign in on this handheld[\s\S]*உங்கள் பணியாளர் எண்/);
    expect(sign).toMatch(/min-height:56px/);
    expect(sign).toMatch(/Your sign-in ended\.<span lang="ta">முடிந்தது\.<\/span>/);
    expect(queuePosOffPage({ laneId: 'lane-1', known: true, why: null, queueBusting: false, payments: false })).toMatch(/pos\.queue_busting[\s\S]*அணைக்கப்பட்டுள்ளது/);
  });
});
