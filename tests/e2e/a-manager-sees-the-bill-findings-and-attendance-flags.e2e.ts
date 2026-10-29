import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM } from '../../services/api/src/adapters';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';

/**
 * **OB-608 (owner, 29 Oct 2026) in a real browser: the Bill findings and attendance flags page, served by the store computer,
 * over head office's real routes (OB-380).**
 *
 * The real store computer serves the page as the person the front signed in; head office's API runs in memory and every `/v1`
 * call reaches it as that person on the box's own origin. Through Chromium:
 *   • the store manager sees head office's bill findings, the critical one first, each with head office's own sentence and
 *     what to do, and the informational ones as a count only;
 *   • the attendance section, on the shop's today, lists Ravi's "out" with no "in" under his name, and not Anu's pair;
 *   • the page is in Tamil on the toggle (head office's own sentences stay in English, OB-553);
 *   • a cashier whom the box lets open the page is refused by head office, said in its words; nothing is written.
 * Synthetic data only. Without a browser binary it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['ob608', 'findings', 'box', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = randomUUID();
const OWNER = 'u-owner'; const MANAGER = 'u-mgr'; const CASHIER = 'u-cash'; const ANU = 'u-anu'; const RAVI = 'u-ravi';
const STORE = 'store-1';
// A moment earlier today in the shop: its date is the page's default day.
const EARLIER = new Date(Date.now() - 60_000).toISOString();
const TODAY = shopDateIn(EARLIER);

describe.skipIf(!HAVE_BROWSER)('the Bill findings and attendance flags page through the store computer (OB-608)', () => {
  let browser: Browser;
  let ho: ApiHarness;
  let edge: EdgeProcess;
  let dir: string;
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    ho = apiHarness();
    await ho.seedOwner(TENANT, OWNER);
    await ho.provisionRole(TENANT, MANAGER, 'store_manager', [STORE]);
    for (const who of [CASHIER, ANU, RAVI]) await ho.provisionRole(TENANT, who, 'cashier', [STORE]);
    const post = async (path: string, body: unknown, as: string): Promise<void> => {
      const r = await ho.request({ method: 'POST', path, userId: as, tenantId: TENANT, branchId: STORE, idempotencyKey: `k-${randomUUID()}`, body });
      expect(r.status, `${path}: ${JSON.stringify(r.body)}`).toBeLessThan(300);
    };
    for (const [id, name] of [[ANU, 'Anu'], [RAVI, 'Ravi']] as const) await post(`/v1/hr/workforce/employees/${id}`, { name, branchId: STORE, roles: ['cashier'], active: true }, MANAGER);
    const earlierBy = (ms: number): string => new Date(Date.parse(EARLIER) - ms).toISOString();
    await post('/v1/hr/workforce/attendance-marks/m-anu-in', { employeeId: ANU, kind: 'in', method: 'pin', at: earlierBy(2_000) }, ANU);
    await post('/v1/hr/workforce/attendance-marks/m-anu-out', { employeeId: ANU, kind: 'out', method: 'pin', at: earlierBy(1_000) }, ANU);
    await post('/v1/hr/workforce/attendance-marks/m-ravi-out', { employeeId: RAVI, kind: 'out', method: 'pin', at: EARLIER }, RAVI);
    const raise = async (ex: Record<string, unknown>): Promise<void> => {
      await ho.store.append(TENANT, STREAM.saleExceptions, makeEvent({
        id: `saleex-${String(ex['saleId'])}-${String(ex['kind'])}`, type: 'SaleExceptionRaised', occurredAt: EARLIER,
        idempotencyKey: `saleex-${TENANT}-${String(ex['saleId'])}-${String(ex['kind'])}`, source: 'api/pos', payload: ex,
      }));
    };
    await raise({ kind: 'price_cut_above_approver_limit', severity: 'material', saleId: 'S-101', productId: 'p-ghee', differenceMinor: 6_000, detail: 'p-ghee was lowered at the till by ₹160.00 with u-mgr\'s approval; u-mgr\'s price-cut limit is ₹100.00', ownerAction: 'Ask the manager. The sale stands.' });
    await raise({ kind: 'sold_a_recalled_product', severity: 'critical', saleId: 'S-102', productId: 'p-milk', detail: 'p-milk is under recall and was sold', ownerAction: 'ACT NOW: contact the customer.' });
    await raise({ kind: 'price_differs_from_catalogue', severity: 'informational', saleId: 'S-103', detail: 'the price quotation Q-7 promised', ownerAction: 'Nothing to do.' });

    dir = await mkdtemp(join(tmpdir(), 'sre-ob608-findings-screen-'));
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, JSON.stringify({
      version: 1, lossPreventionRules: [], policies: { tradingDayCutoff: '02:00', storeId: STORE, branchId: STORE },
      roles: [
        { id: 'manager', name: 'Store manager', permissions: ['identity.self.read', 'pos.exception.read', 'workforce.roster.read'] },
        { id: 'cashier', name: 'Cashier', permissions: ['identity.self.read', 'pos.exception.read'] },
      ],
      roleAssignments: [{ userId: MANAGER, roleId: 'manager', branchScope: [STORE] }, { userId: CASHIER, roleId: 'cashier', branchScope: [STORE] }],
    }), 'utf8');
    edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
      EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile, EDGE_SCREEN_TRUST_FORWARDED_USER: '1',
    }, () => {}))!;
  }, 240_000);
  afterAll(async () => { await browser?.close(); await edge?.stop(); if (dir !== undefined) await rm(dir, { recursive: true, force: true }); });
  afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });

  /** A page on the box's origin as `who`; head office's API carried on that origin, as that person. Every write is counted. */
  const open = async (who: string): Promise<{ page: Page; errors: string[]; writes: string[] }> => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', extraHTTPHeaders: { 'x-sre-user': who } });
    stops.push(() => context.close());
    const writes: string[] = [];
    await context.route('**/v1/**', async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (req.method() !== 'GET') writes.push(`${req.method()} ${url.pathname}`);
      const answer = await ho.request({
        method: req.method() as 'GET', path: url.pathname, userId: who, tenantId: TENANT, branchId: STORE,
        ...(url.search === '' ? {} : { query: Object.fromEntries(url.searchParams) }),
      });
      await route.fulfill({ status: answer.status, contentType: 'application/json', body: JSON.stringify(answer.body ?? {}) });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const res = await page.goto(`http://127.0.0.1:${edge.screens!.port}/findings/`, { waitUntil: 'load' });
    expect(res?.status(), 'the page is served by the store computer').toBe(200);
    return { page, errors, writes };
  };
  const says = (page: Page, selector: string, pattern: RegExp): Promise<unknown> => page.waitForFunction(
    ([sel, src]) => new RegExp(src!).test((globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector(sel!)?.textContent ?? ''),
    [selector, pattern.source], { timeout: 15_000 },
  ).catch(async (e: unknown) => {
    const seen = await page.evaluate((sel) => (globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector(sel)?.textContent ?? '(none)', selector);
    throw new Error(`${selector} never said ${pattern.source}; it says: ${JSON.stringify(seen)} (${String(e)})`);
  });

  it('the store manager sees the critical finding first, then the material one, and Ravi\'s unpaired "out"; in Tamil on the toggle; nothing written', async () => {
    const m = await open(MANAGER);
    await m.page.waitForSelector('#s-rows li[data-sale="S-101"]');
    expect(await m.page.$$eval('#s-rows li', (ls) => ls.map((l) => (l as unknown as { dataset: { severity: string; sale: string } }).dataset.severity + ':' + (l as unknown as { dataset: { sale: string } }).dataset.sale)))
      .toEqual(['critical:S-102', 'material:S-101']);
    await says(m.page, '#s-rows li[data-sale="S-102"]', /Critical.*Bill S-102.*p-milk is under recall and was sold.*What to do: ACT NOW: contact the customer\./);
    await says(m.page, '#s-rows li[data-sale="S-101"]', /Material.*Difference: ₹60\.00.*What to do: Ask the manager\. The sale stands\./);
    await says(m.page, '#s-counts', /^1 · 1 · 1 /);

    expect(await m.page.inputValue('#a-day')).toBe(TODAY);
    await m.page.waitForSelector(`#a-rows li[data-person="${RAVI}"]`);
    await says(m.page, `#a-rows li[data-person="${RAVI}"]`, /Ravi \(u-ravi\).*out.*Out, but no in to pair with/);
    expect(await m.page.$$(`#a-rows li[data-person="${ANU}"]`)).toHaveLength(0);
    await says(m.page, '#a-counts', /^3 marks read for this day; with a flag: 1$/);

    await m.page.click('#lang');
    await says(m.page, '#sales-h', /^பில் கண்டறிதல்கள்$/);
    await says(m.page, `#a-rows li[data-person="${RAVI}"]`, /வெளியே பதிவு உண்டு, இணைக்க உள்ளே பதிவு இல்லை/);
    await says(m.page, '#s-rows li[data-sale="S-102"]', /p-milk is under recall and was sold/);
    expect(m.errors).toEqual([]);
    expect(m.writes).toEqual([]);
  });

  it('a cashier the box lets open the page is refused by head office, said in its words', async () => {
    const c = await open(CASHIER);
    await says(c.page, '#s-status', /^Head office refused:/);
    expect(await c.page.$$('#s-rows li')).toHaveLength(0);
    expect(await c.page.isVisible('#attendance')).toBe(false);
    expect(c.errors).toEqual([]);
  });
});
