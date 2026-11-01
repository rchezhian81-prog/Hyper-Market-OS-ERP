// A whole office, for the office-shell browser tests (W1 · P-07 · P-08): the REAL head office (the API harness, every
// route as it runs in production, in memory), a fresh synthetic tenant with the four people the owner named — owner,
// store manager, accountant, cashier — each holding the product's own role (services/api/src/roles.ts), and the REAL
// store computer (`startEdge`) that pulled its setup and role register from that head office. A browser opens pages as
// one of those people the way the hosted front does: it names them to the store computer and carries the page's `/v1`
// reads to head office in their own session. Nothing here is a stand-in for a figure: every row a page shows came
// through a real route from data posted through a real route.
//
// The seed is deliberately enough to exercise a register — 24 customers (paging is at 10), two approvals waiting for
// the owner — and nothing else: an empty register on these pages must say "nothing yet", never "all clear".

import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, BrowserContext, BrowserContextOptions, Page } from 'playwright-core';
import { apiHarness, TEST_IDP, TEST_PACK_KEY, type ApiHarness } from '../../support/api-harness';
import { STORE_RULES } from '../../support/store-rules';
import type { HttpRequest } from '../../../services/kernel/src/index';
import { startEdge, type EdgeProcess } from '../../../edge/store-edge/src/main';

export const S1 = 'S1';
export const PEOPLE = { owner: 'u-owner', manager: 'u-mgr', accountant: 'u-acct', cashier: 'u-cash', maker: 'u-maker' } as const;
const SETTINGS = { tradingDayCutoff: '02:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 5_000, cashVarianceToleranceMinor: 5_000, privacySlaDays: 15, warehouseId: 'S1-BACK' };

/** Customer codes the seed sells to — 24, so a register of 10 a page has three pages. */
export const CUSTOMER_REFS = Array.from({ length: 24 }, (_, i) => `M-${String(i + 1).padStart(3, '0')}`);

export interface OfficeShop {
  readonly base: string;
  readonly h: ApiHarness;
  readonly tenantId: string;
  /** A browser context signed in as `user`; `/v1` reads go to head office in their own session. */
  asPerson(user: string, device?: BrowserContextOptions): Promise<{ context: BrowserContext; page: Page; errors: string[] }>;
  stop(): Promise<void>;
}

export async function startOfficeShop(browser: Browser): Promise<OfficeShop> {
  const h = apiHarness();
  const T = randomUUID();
  let n = 0;
  const ok = async (path: string, userId: string, body: unknown): Promise<unknown> => {
    const r = await h.request({ method: 'POST', path, userId, tenantId: T, idempotencyKey: `office-${n++}`, body });
    if (r.status >= 300) throw new Error(`${path}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  await h.seedOwner(T, PEOPLE.owner);
  await h.provisionRole(T, 'u-box', 'store_computer', [S1]);
  await h.provisionRole(T, PEOPLE.manager, 'store_manager', [S1]);
  await h.provisionRole(T, PEOPLE.accountant, 'accountant', 'all');
  await h.provisionRole(T, PEOPLE.cashier, 'cashier', [S1]);
  await h.provisionRole(T, PEOPLE.maker, 'owner', 'all');
  await ok('/v1/org/nodes/C1', PEOPLE.owner, { kind: 'company', name: 'SRE Retail' });
  await ok(`/v1/org/nodes/${S1}`, PEOPLE.owner, { kind: 'branch', name: 'SRE Hyper Market', parentId: 'C1', companyId: 'C1' });
  await ok(`/v1/stores/${S1}/settings`, PEOPLE.owner, SETTINGS);
  await ok(`/v1/stores/${S1}/rules`, PEOPLE.owner, STORE_RULES);
  await ok('/v1/catalogue/tax-classes/0401/rates/2017-07-01', PEOPLE.owner, { rateBps: 0 });
  await ok('/v1/catalogue/products/p-milk/publish', PEOPLE.owner, {
    product: { sku: 'MILK-500', name: 'Toned milk 500 ml', baseUom: 'ea', primaryCategoryId: 'dairy', taxClass: '0401', lifecycle: 'active' },
    categories: [{ categoryId: 'dairy', name: 'Dairy', parentId: null }],
  });
  // 24 customers who bought, through the real sales route; the first ten gave profiling consent at the desk.
  for (const [i, ref] of CUSTOMER_REFS.entries()) {
    const total = 1_000 * (i + 1);
    await ok('/v1/sales', PEOPLE.owner, {
      saleId: `S-${i + 1}`, receiptNumber: `R-${i + 1}`, laneId: 'lane-1', locationId: S1, cashierId: PEOPLE.owner, tradingDay: '2026-10-01', committedAt: '2026-10-01T06:00:00.000Z',
      totalMinor: total, currency: 'INR', packVersion: 1, customerRef: ref,
      lines: [{ productId: 'p-milk', quantityMinor: 1, uom: 'ea', unitPriceMinor: total, lineTotalMinor: total }], tenders: [{ kind: 'cash', amountMinor: total }],
    });
    if (i < 10) await ok(`/v1/customers/${ref}/consent`, PEOPLE.owner, { purpose: 'profiling', channel: 'sms', given: true, evidence: 'synthetic desk consent' });
  }
  // Two requests another owner asked for — they wait for the owner (never for the person who asked).
  for (const who of ['u-new-anita', 'u-new-ravi']) {
    await ok('/v1/approvals/requests', PEOPLE.maker, {
      kind: 'access_change', subjectRef: who, valueMinor: null, details: { userId: who, event: 'joiner', roleId: 'cashier' },
      summary: `Give ${who} the cashier role`, reason: `${who} starts on the tills on Monday`,
    });
  }

  // The store computer's line to head office (its machine credential).
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit = {}): Promise<Response> => {
    if (url.startsWith('http://127.0.0.1:')) return savedFetch(url, init);
    const hdr = (init.headers ?? {}) as Record<string, string>;
    const u = new URL(url);
    const res = await h.raw({
      method: (init.method ?? 'GET') as HttpRequest['method'], path: u.pathname, query: Object.fromEntries(u.searchParams),
      token: hdr['authorization']?.replace(/^Bearer /, ''), idempotencyKey: hdr['idempotency-key'],
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
    });
    return new Response(JSON.stringify(res.body), { status: res.status, headers: { date: new Date().toUTCString() } });
  }) as unknown as typeof globalThis.fetch;
  const dir = await mkdtemp(join(tmpdir(), 'sre-office-shop-'));
  const edge: EdgeProcess = (await startEdge({
    EDGE_DATA_DIR: dir, EDGE_TENANT_ID: T, PACK_SIGNING_KEY: TEST_PACK_KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
    EDGE_SCREEN_TRUST_FORWARDED_USER: '1', EDGE_STORE_PACK_SOURCE: 'head-office', EDGE_STORE_ID: S1,
    CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box', tenantId: T, branchId: S1 }),
  }, () => {}))!;
  const pulled = await edge.refreshStorePack!();
  if ((pulled as { status?: string }).status !== 'updated') throw new Error(`the store computer did not pull its setup: ${JSON.stringify(pulled)}`);
  const base = `http://127.0.0.1:${edge.screens!.port}`;

  return {
    base, h, tenantId: T,
    async asPerson(user, device = {}) {
      const context = await browser.newContext({ ...device, serviceWorkers: 'block', extraHTTPHeaders: { 'x-sre-user': user } });
      await context.route('**/v1/**', async (route) => {
        const u = new URL(route.request().url());
        const body = route.request().postData();
        const res = await h.raw({
          method: route.request().method() as HttpRequest['method'], path: u.pathname, query: Object.fromEntries(u.searchParams),
          token: TEST_IDP.issue({ sub: user, tenantId: T, branchId: S1 }), idempotencyKey: route.request().headers()['idempotency-key'],
          body: body === null || body === '' ? undefined : JSON.parse(body) as unknown,
        });
        await route.fulfill({ status: res.status, contentType: 'application/json', body: JSON.stringify(res.body) });
      });
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      return { context, page, errors };
    },
    async stop() {
      globalThis.fetch = savedFetch;
      await edge.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
