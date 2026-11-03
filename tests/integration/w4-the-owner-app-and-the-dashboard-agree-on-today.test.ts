import { describe, it, expect, afterEach, afterAll, beforeEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { bootOwner, forgetfulQueueStore } from '../../apps/owner-app/src/browser-entry';
import { prepareTillBox, signInTill } from '../support/till-operator';
import { apiHarness, TEST_IDP, TEST_PACK_KEY, type ApiHarness } from '../support/api-harness';
import { DEFAULT_SHOP_CALENDAR, shopDateIn } from '../../packages/calendar/src/shop-clock';
import { pinTheEveningClock } from '../support/evening-clock';
import type { HttpRequest } from '../../services/kernel/src/index';

// Pinned to an evening UTC moment (tests/support/evening-clock.ts): 01:00 the next morning in the shop, when the UTC date is
// still the shop's yesterday — so this file proves the shop's day every time it runs, not only when CI runs after 18:30 UTC.
const evening = pinTheEveningClock();
afterAll(() => { vi.useRealTimers(); });

/**
 * **W4 · P-02 (one commerce truth) · M29-FR-01 · M01-FR-02: the owner's phone and head office's dashboard say the same
 * "today" and the same takings.** The owner app reads the store computer's figures; the Reports dashboard
 * (`GET /v1/reports/dashboard`) reads head office's. Both decide "today" by the SHOP's trading day — the shop's zone and its
 * day end — never a server's or a phone's own calendar date. At 01:00 in the shop (19:30 UTC, when the UTC date is still the
 * day before) a real till rings two bills on a real store computer, the store computer sends them to head office, and:
 *   • the owner's "today" is the shop's date, and head office holds both bills on that same trading day; the owner's takings,
 *     bill count and the dashboard's "Sales today" are the same figures;
 *   • on a store computer whose pack carries a day end after midnight (02:00 — a pack head office itself will no longer issue:
 *     the owner decided the day ends at midnight, OB-402), 01:00 is still the day before: the box counts the bills on that day,
 *     and the phone calls THAT day "today" — the box's own rule, never a date worked out again from the clock.
 * A real store computer, its real lane socket and disk, the real `bootPos` till, the real owner app boot and head office's real
 * router (in memory). Synthetic data only.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa0w4';
const KEY = TEST_PACK_KEY;
const dirs: string[] = [];
const stops: (() => Promise<void>)[] = [];
let realFetch: typeof globalThis.fetch;
beforeEach(() => { realFetch = globalThis.fetch; });
afterEach(async () => {
  globalThis.fetch = realFetch;
  for (const s of stops.splice(0).reverse()) await s();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const policies = (tradingDayCutoff: string) => ({ storeId: 'store-1', branchId: 'store-1', branchName: 'SRE Hyper Market', warehouseId: 'S1-BACK', tradingDayCutoff, staleAfterSeconds: 900, countApprovalThresholdMinor: 0 });

/** A store computer (pack day end `cutoff`) whose head office is `h`, reached through `fetch` exactly as over the line. */
async function shopWith(h: ApiHarness | undefined, cutoff: string): Promise<EdgeProcess> {
  const dir = await mkdtemp(join(tmpdir(), 'sre-w4-today-')); dirs.push(dir);
  const ready = await prepareTillBox({
    dir, key: KEY, people: [{ userId: 'u-meena', displayName: 'Meena' }],
    pack: { policies: policies(cutoff), lossPreventionRules: [], receiptSeries: [{ laneId: 'lane-1', prefix: 'MS-', padTo: 6, rangeStart: 1, rangeEnd: 999, bankedThrough: 0 }] },
  });
  if (h !== undefined) {
    globalThis.fetch = (async (url: string, init: RequestInit = {}): Promise<Response> => {
      if (String(url).startsWith('http://127.0.0.1:')) return realFetch(url, init);
      const hdr = (init.headers ?? {}) as Record<string, string>;
      const res = await h.raw({
        method: (init.method ?? 'GET') as HttpRequest['method'], path: new URL(url).pathname,
        token: hdr['authorization']?.replace(/^Bearer /, ''), idempotencyKey: hdr['idempotency-key'],
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
      });
      return new Response(JSON.stringify(res.body), { status: res.status });
    }) as unknown as typeof globalThis.fetch;
  }
  const edge = (await startEdge({
    EDGE_DATA_DIR: dir, EDGE_TENANT_ID: A, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
    ...ready,
    ...(h === undefined ? {} : { EDGE_PACK_FILE: join(dir, 'store-pack.json'), CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box', tenantId: A, branchId: 'store-1' }) }),
  }, () => {}))!;
  stops.push(() => edge.stop());
  return edge;
}

async function ringTwoBills(edge: EdgeProcess, cutoff: string): Promise<void> {
  const till = bootPos({ laneId: 'lane-1', taxPercent: 0, lanePort: edge.lane!.port, timeZone: DEFAULT_SHOP_CALENDAR.timeZone, tradingDayCutoff: cutoff });
  await signInTill(till, 'u-meena');
  for (const [i, price] of [14_800, 6_000].entries()) {
    till.scan({ productId: `P${i}`, description: `Item ${i}`, unitPriceMinor: price, qty: 1 });
    await till.tenderCash(`S-${i + 1}`, await till.nextReceipt(), new Date().toISOString());
    till.newSale();
  }
}

async function ownerView(edge: EdgeProcess) {
  // The box re-reads its logs on each request (the first read starts it), so the second read is the day as it stands.
  await (await fetch(`http://127.0.0.1:${edge.screens!.port}/owner/`)).text();
  await new Promise((r) => setTimeout(r, 200));
  const html = await (await fetch(`http://127.0.0.1:${edge.screens!.port}/owner/`)).text();
  if (!html.includes('window.ownerData')) throw new Error(`owner screen: ${html.slice(0, 400)}`);
  const data = JSON.parse(/<script>window\.ownerData = ([\s\S]*?);<\/script>/.exec(html)![1]!) as Parameters<typeof bootOwner>[0];
  const session = bootOwner(data, forgetfulQueueStore())!;
  return { data: data as unknown as { branches: { tradingDay?: string }[] }, brief: session.brief(), trends: session.trends() };
}

describe('the owner app and the Reports dashboard decide "today" the same way (P-02)', () => {
  it('at 01:00 in the shop, with the shop\'s own day end (midnight): the same day, the same bills, the same takings', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-meena', 'cashier');
    await h.provisionRole(A, 'u-box', 'store_computer', ['store-1']);
    // Head office's own calendar for this shop: its zone and the midnight day end the owner decided (OB-402).
    const policy = (await h.request({ method: 'GET', path: '/v1/platform/store-pack/policies', userId: 'u-owner', tenantId: A })).body as { tradingDayCutoff: string };
    expect(policy.tradingDayCutoff).toBe('00:00');

    const edge = await shopWith(h, policy.tradingDayCutoff);
    await ringTwoBills(edge, policy.tradingDayCutoff);
    expect(await edge.syncOnce!()).toMatchObject({ dead: 0, remaining: 0 });

    const owner = await ownerView(edge);
    // The shop's date — the day AFTER the UTC date at this hour — is the owner's "today".
    expect(evening.shopDate).not.toBe(evening.utcDate);
    expect(owner.data.branches[0]!.tradingDay).toBe(evening.shopDate);
    expect(owner.trends.today).toBe(evening.shopDate);
    expect(owner.trends.recentDays?.at(-1)).toEqual({ tradingDay: evening.shopDate, bills: 2, takenMinor: 20_800 });
    expect(owner.brief.takings).toMatchObject({ bills: 2, takenMinor: 20_800 });

    // Head office holds both bills on that same trading day, and its dashboard's "today" counts exactly them.
    const held = (await h.store.readStream(A, 'sales', { type: 'SaleCommitted' })).map((e) => e.event.payload as { saleId: string; tradingDay: string });
    expect(held.map((x) => [x.saleId, x.tradingDay]).sort()).toEqual([['S-1', evening.shopDate], ['S-2', evening.shopDate]]);
    const dash = (await h.request({ method: 'GET', path: '/v1/reports/dashboard', userId: 'u-owner', tenantId: A })).body as { figures: { name: string; valueMinor?: number }[] };
    const fig = (name: string) => dash.figures.find((f) => f.name === name)?.valueMinor;
    expect(fig('Sales today')).toBe(owner.brief.takings.takenMinor);
    expect(fig('Sales today — receipts')).toBe(owner.brief.takings.bills);
    expect(fig('Sales today — cash')).toBe(20_800);
  }, 60_000);

  it('a box whose pack ends the day at 02:00: at 01:00 the box\'s day is the day before, and the phone calls THAT day "today"', async () => {
    const edge = await shopWith(undefined, '02:00');
    await ringTwoBills(edge, '02:00');
    const owner = await ownerView(edge);
    const dayBefore = shopDateIn(new Date(Date.parse(evening.at) - 2 * 3_600_000).toISOString());
    expect(dayBefore).toBe(evening.utcDate); // 23:00 the night before, in the shop
    expect(owner.data.branches[0]!.tradingDay).toBe(dayBefore);
    // Before W4 the phone worked "today" out again from the clock — the shop's CALENDAR date — and marked no day at all,
    // because the box's figures were for the day before. Now it is the box's own day.
    expect(owner.trends.today).toBe(dayBefore);
    expect(owner.trends.recentDays?.at(-1)).toEqual({ tradingDay: dayBefore, bills: 2, takenMinor: 20_800 });
    expect(owner.brief.takings).toMatchObject({ bills: 2, takenMinor: 20_800 });
  }, 60_000);
});
