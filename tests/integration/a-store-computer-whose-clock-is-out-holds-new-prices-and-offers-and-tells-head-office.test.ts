import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import type { HttpRequest } from '../../services/kernel/src/index';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { writeSignedPack } from '../../edge/store-edge/src/signed-pack-file';
import { packTradingDay } from '../../edge/store-edge/src/shop-zone';
import { hmacSigner, publishPack } from '../../services/catalogue/src/index';
import { bootPos } from '../../apps/pos/src/browser-entry';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import { prepareTillBox, signInAtLane, receiptNumberAt, operatorHeader } from '../support/till-operator';

/**
 * **§31.1 · OB-403 "A" (owner, 27 Oct 2026, in writing) · OB-327 · P-01 · P-08 · hard rule #1 — a REAL store computer whose
 * clock is 5+ minutes out keeps the prices and offers already running, starts no new price, offer or bill-number year, keeps
 * selling, and TELLS HEAD OFFICE and the owner's alerts; back in step, the held changes take effect.**
 *
 * The box's own fsync'd clock log says its clock was found 26 hours AHEAD of head office ten minutes ago. Its signed
 * catalogue carries an offer running for a month and one that started an hour ago by the box's clock (after the clock went
 * out); its store pack carries a price dated today by the box's clock.
 *   1 · OFFLINE (no head office): the box holds the new offer and the new price, by name, and says so in words on the
 *       manager's screen; the till is told the cut-off (on its page and on the badge it re-reads every 10 s) and does not
 *       apply the new offer, while the running one stays; the Products and prices screen decides today's price by the day
 *       the clock was last trusted; nothing is removed from the signed catalogue; a bill still COMMITS.
 *   2 · A cold restart, still offline: exactly the same hold, from the clock log.
 *   3 · Head office answers (its clock still 26 hours behind the box's): the box's health report carries the clock check
 *       and the held ids; head office shows `box_clock:S1` degraded — "price change held" — and the owner's alert rule on it
 *       puts the alert in his inbox; a second head-office instance reads the same.
 *   4 · The clock is set right (head office's answers agree with the box): the hold lifts by itself — the till is told,
 *       the new offer and price apply (nothing lost) — and head office's line reads ok.
 * Synthetic data only (hard rule #7).
 */

const KEY = ['ob403', 'clock', 'hold', 'key'].join('-').padEnd(48, '0');
const OWNER = 'u-owner';
const BOX = 'u-box1';
const AHEAD_SECONDS = 26 * 3_600; // the box's clock runs 26 hours ahead of head office's

interface Component { name: string; status: string; detail: string; evidence?: Record<string, number | string> }
interface Observed { observed: { boxes: { storeId: string; clockCheck?: { verdict: string; hold: { held: boolean; heldPromotions: string[] } } | null }[] }; health: { components: Component[] } }

const served = async (edge: EdgeProcess, screen: string, name: string): Promise<Record<string, unknown>> => {
  const html = await (await fetch(`http://127.0.0.1:${edge.screens!.port}/${screen}/`)).text();
  const m = new RegExp(`<script>window\\.${name} = ([\\s\\S]*?);</script>`).exec(html);
  expect(m, `the ${screen} screen was served no ${name}`).not.toBeNull();
  return JSON.parse(m![1]!) as Record<string, unknown>;
};
const syncStatus = async (edge: EdgeProcess): Promise<{ offerHold?: { held: boolean; cutoffAt: string | null } }> =>
  (await fetch(`http://127.0.0.1:${edge.lane!.port}/lane/sync-status`)).json() as Promise<{ offerHold?: { held: boolean; cutoffAt: string | null } }>;

describe('§31.1 · OB-403 — a store computer whose clock is out holds new prices and offers, keeps selling, and tells head office', () => {
  const dirs: string[] = [];
  const edges: EdgeProcess[] = [];
  const savedFetch = globalThis.fetch;
  afterEach(async () => {
    for (const e of edges.splice(0)) await e.stop();
    globalThis.fetch = savedFetch;
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  it('holds by name offline and across a restart, sells on, reaches head office and the owner\'s inbox, and lifts back in step', async () => {
    const tenant = randomUUID();
    const now = Date.now();
    const iso = (ms: number): string => new Date(ms).toISOString();
    const dir = await mkdtemp(join(tmpdir(), 'sre-ob403-')); dirs.push(dir);
    const policies = { storeId: 'S1', branchId: 'S1', branchName: 'S1', timeZone: 'Asia/Kolkata', tradingDayCutoff: '00:00', staleAfterSeconds: 3600, countApprovalThresholdMinor: 1, handoverToleranceMinor: 1, privacySlaDays: 15, warehouseId: 'S1' };
    const today = packTradingDay({ policies: { known: true, value: policies } }, iso(now));
    const ready = await prepareTillBox({
      dir, key: KEY, people: [{ userId: 'u-lanecash', displayName: 'Lane Cashier' }, { userId: 'u-mgr', displayName: 'Manager', manager: true }],
      pack: {
        managerPolicy: { userId: 'u-mgr', approvalLimitMinor: 500_000 }, lossPreventionRules: [], policies,
        pricingPolicy: { userId: 'u-pricing', approvers: ['u-owner'], marginFloorBps: 0 },
        priceEntries: [
          { id: 'pe-old', productId: 'p-oil', scope: 'store', scopeRef: 'S1', priceMinor: 20_000, effectiveFrom: '2026-01-01', status: 'active', version: 1 },
          { id: 'pe-today', productId: 'p-oil', scope: 'store', scopeRef: 'S1', priceMinor: 19_000, effectiveFrom: today, status: 'active', version: 2 },
        ],
      },
    });
    const snapshot: CatalogueSnapshot = {
      tenantId: tenant, version: 2, builtAt: iso(now - 86_400_000),
      products: [
        { productId: 'p-oil', sku: 'OIL', name: 'Oil 1L', baseUom: 'ea', unitPriceMinor: 20_000, taxBps: 500, status: 'active' },
        { productId: 'p-dal', sku: 'DAL', name: 'Toor dal 1kg', baseUom: 'ea', unitPriceMinor: 10_000, taxBps: 500, status: 'active' },
      ],
      barcodes: [{ code: '8901234567890', productId: 'p-oil', kind: 'standard' }, { code: '8901234567883', productId: 'p-dal', kind: 'standard' }],
      promotions: [
        { id: 'dal-5-running', kind: 'percent_off', startsAt: iso(now - 30 * 86_400_000), endsAt: iso(now + 30 * 86_400_000), status: 'active', productIds: ['p-dal'], percentBps: 500 },
        { id: 'oil-10-new', kind: 'percent_off', startsAt: iso(now - 3_600_000), endsAt: iso(now + 30 * 86_400_000), status: 'active', productIds: ['p-oil'], percentBps: 1000 },
      ],
    };
    const signed = publishPack({ snapshot, approvals: [], signer: hmacSigner(KEY), publishedBy: 'u-hq', publishedAt: iso(now - 86_400_000) });
    if (!signed.ok || signed.pack === undefined) throw new Error(signed.detail);
    await writeSignedPack(dir, signed.pack);
    // The box's own clock log from before: 26 hours AHEAD of head office, found ten minutes ago (by the box's clock).
    const flaggedAt = now - 600_000;
    await writeFile(join(dir, 'clock-checks.log'), `${JSON.stringify({ at: iso(flaggedAt), verdict: 'flag_bills', offsetSeconds: -AHEAD_SECONDS })}\n`, 'utf8');
    const cutoffAt = iso(flaggedAt - AHEAD_SECONDS * 1000);
    const cutoffDay = packTradingDay({ policies: { known: true, value: policies } }, cutoffAt);

    const boot = async (cloud?: Record<string, string>): Promise<EdgeProcess> => {
      const e = (await startEdge({
        EDGE_DATA_DIR: dir, EDGE_TENANT_ID: tenant, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
        ...(cloud ?? {}), ...ready,
      }, () => {}))!;
      edges.push(e);
      return e;
    };
    const stop = async (e: EdgeProcess): Promise<void> => { await e.stop(); edges.splice(edges.indexOf(e), 1); };

    const offline = async (edge: EdgeProcess): Promise<void> => {
      const hold = edge.activationHold();
      expect(hold).toMatchObject({ held: true, since: iso(flaggedAt), cutoffAt, offsetSeconds: -AHEAD_SECONDS, priceDay: cutoffDay });
      expect(hold.heldPromotions.map((p) => p.id)).toEqual(['oil-10-new']);       // the running offer stays
      expect(hold.heldPrices.map((p) => p.id)).toEqual(['pe-today']);             // the price already in force stays
      expect(hold.staffMessage).toContain('Price change held: store clock is');
      // The till: told on the badge it re-reads, and on its page; the signed catalogue keeps both offers (nothing removed).
      expect((await syncStatus(edge)).offerHold).toEqual({ held: true, cutoffAt });
      expect((await served(edge, 'pos', 'posLane'))['offerHold']).toEqual({ held: true, cutoffAt });
      expect(((await served(edge, 'pos', 'posCatalogue'))['promotions'] as { id: string }[]).map((p) => p.id).sort()).toEqual(['dal-5-running', 'oil-10-new']);
      // The Products and prices screen decides today's price by the day the clock was last trusted.
      const catalogue = await served(edge, 'catalogue', 'catalogueData');
      expect(catalogue['today']).toBe(cutoffDay);
      expect(catalogue['activationHold']).toMatchObject({ held: true, heldPrices: [{ id: 'pe-today' }] });
      // The manager's screen says it in words.
      const manager = await served(edge, 'manager', 'managerData');
      expect((manager['activationHold'] as { staffMessage: string }).staffMessage).toContain('offer oil-10-new');
    };

    // ── 1 · Offline.
    let edge = await boot();
    await offline(edge);
    // The till as the served page boots it: the new offer is not applied; the running one is.
    const lane = await served(edge, 'pos', 'posLane') as { offerHold: { cutoffAt: string } };
    const till = bootPos({ laneId: 'lane-1', catalogue: signed.pack.snapshot, offerHoldCutoff: lane.offerHold.cutoffAt, lanePort: edge.lane!.port });
    expect(till.heldOffers()).toEqual(['oil-10-new']);
    // A bill still commits — a clock never blocks a sale (hard rule #1).
    const token = await signInAtLane(edge.lane!.port, 'u-lanecash');
    const number = await receiptNumberAt(edge.lane!.port, token);
    const sale = await (await fetch(`http://127.0.0.1:${edge.lane!.port}/lane/sales`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...operatorHeader(token) },
      body: JSON.stringify({
        id: `S-${number}`, number, laneId: 'lane-1', cashierId: 'u-lanecash', committedAt: iso(Date.now()),
        lines: [{ productId: 'p-oil', quantityMinor: 1, uom: 'ea', unitPriceMinor: 20_000, lineTotalMinor: 20_000, taxRateBps: 500 }],
        tenders: [{ kind: 'cash', amount: { minor: 20_000, currency: 'INR' }, status: 'settled' }],
        total: 20_000, netMinor: 19_048, taxMinor: 952, currency: 'INR',
      }),
    })).json() as { committed: boolean };
    expect(sale.committed, JSON.stringify(sale)).toBe(true);

    // ── 2 · A cold restart, still offline: the same hold, from the clock log.
    await stop(edge);
    edge = await boot();
    await offline(edge);

    // ── 3 · Head office answers — its clock 26 hours behind the box's. The box's report reaches it; the owner is told.
    await stop(edge);
    let h: ApiHarness = apiHarness();
    await h.seedOwner(tenant, OWNER);
    await h.provisionRole(tenant, BOX, 'store_computer', ['S1']);
    const headOfficeClock = { aheadOfBoxMs: -AHEAD_SECONDS * 1000 };
    const cloudToken = ['box', 'token', 'ob403', 'clock', 'hold'].join('-');
    globalThis.fetch = (async (url: string, init: RequestInit = {}): Promise<Response> => {
      if (String(url).startsWith('http://127.0.0.1:')) return savedFetch(url, init);
      const hdr = (init.headers ?? {}) as Record<string, string>;
      if (hdr['authorization']?.replace(/^Bearer /, '') !== cloudToken) return new Response('{}', { status: 401 });
      const res = await h.request({
        method: (init.method ?? 'GET') as HttpRequest['method'], path: new URL(url).pathname, userId: BOX, tenantId: tenant, branchId: 'S1',
        ...(hdr['idempotency-key'] === undefined ? {} : { idempotencyKey: hdr['idempotency-key'] }),
        ...(init.body === undefined ? {} : { body: JSON.parse(String(init.body)) as unknown }),
      });
      // Head office's own clock, as every real answer carries it (the box measures its clock by it).
      return new Response(JSON.stringify(res.body), { status: res.status, headers: { date: new Date(Date.now() + headOfficeClock.aheadOfBoxMs).toUTCString() } });
    }) as unknown as typeof globalThis.fetch;
    const owner = (hh: ApiHarness, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown) =>
      hh.request({ method, path, userId: OWNER, tenantId: tenant, ...(method === 'GET' ? {} : { idempotencyKey: `k-${Math.random()}` }), ...(body === undefined ? {} : { body }) });
    const clockLine = async (hh: ApiHarness): Promise<Component | undefined> =>
      ((await owner(hh, 'GET', '/v1/platform/operational-health/observed')).body as Observed).health.components.find((c) => c.name === 'box_clock:S1');
    // The owner's alert rule for the store computer's clock (the same alert rules every other box line uses).
    expect((await owner(h, 'PUT', '/v1/platform/alert-rules', { basedOnVersion: 0, rules: [
      { alertId: 's1-box-clock', component: 'box_clock:S1', firesAt: 'degraded', ownerUserId: OWNER, ownerName: 'Owner', ackWithinMinutes: 60 },
    ] })).status).toBe(200);

    edge = await boot({ CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: cloudToken, EDGE_STORE_ID: 'S1' });
    await edge.syncOnce!();
    expect(edge.clockCheck().verdict).toBe('flag_bills');
    expect(edge.activationHold().held).toBe(true);
    expect(await edge.reportBoxHealth!()).toBe(true);
    let line = await clockLine(h);
    expect(line).toMatchObject({ status: 'degraded', evidence: { verdict: 'flag_bills', held: 'true', heldPromotions: 'oil-10-new', heldPrices: 'pe-today', computer: BOX } });
    expect(line!.detail).toMatch(/price change held — its clock is \d+ min AHEAD of head office/);
    expect(line!.detail).toContain('Selling goes on');
    expect(line!.detail).toContain('offer oil-10-new');
    const raised = await owner(h, 'POST', '/v1/platform/operational-health/observed/raise');
    expect(raised.status, JSON.stringify(raised.body)).toBe(200);
    const inbox = ((await owner(h, 'GET', '/v1/platform/alerts/inbox')).body as { alerts: { alert: { alertId: string; detail: string; status: string } }[] }).alerts;
    expect(inbox.find((a) => a.alert.alertId === 's1-box-clock')?.alert).toMatchObject({ status: 'degraded' });
    expect(inbox.find((a) => a.alert.alertId === 's1-box-clock')!.alert.detail).toContain('price change held');
    // A second head-office instance reads the same from the kept report.
    h = apiHarness({ store: h.store });
    expect((await clockLine(h))?.status).toBe('degraded');
    expect(((await owner(h, 'GET', '/v1/platform/operational-health/observed')).body as Observed).observed.boxes.find((b) => b.storeId === 'S1')?.clockCheck)
      .toMatchObject({ verdict: 'flag_bills', hold: { held: true, heldPromotions: ['oil-10-new'] } });

    // ── 4 · IT sets the clock right: head office's answers now agree with the box. The hold lifts; nothing was lost.
    headOfficeClock.aheadOfBoxMs = 0;
    expect(await edge.reportBoxHealth!()).toBe(true); // head office's answer to it is measured by the box
    expect(edge.clockCheck().verdict).toBe('in_step');
    expect(edge.activationHold()).toMatchObject({ held: false, heldPromotions: [], heldPrices: [] });
    expect((await syncStatus(edge)).offerHold).toEqual({ held: false, cutoffAt: null });
    expect((await served(edge, 'pos', 'posLane'))['offerHold']).toEqual({ held: false, cutoffAt: null });
    expect((await served(edge, 'catalogue', 'catalogueData'))['today']).toBe(today);
    till.holdOffersStartingAfter(null); // what the till does on its next badge read
    expect(till.heldOffers()).toEqual([]);
    expect(await edge.reportBoxHealth!()).toBe(true);
    line = await clockLine(h);
    expect(line).toMatchObject({ status: 'ok', evidence: { verdict: 'in_step', held: 'false' } });
  }, 60_000);
});
