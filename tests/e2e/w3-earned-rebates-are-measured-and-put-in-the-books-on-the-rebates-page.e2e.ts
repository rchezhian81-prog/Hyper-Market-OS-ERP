import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { P3, p3Shop, caller, issuedOrder, received, capturedAndMatched } from '../support/p3-purchase';
import { sentWithApproval } from '../support/approval-request';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/index';
import { theEvening, pinTheEveningClock, pinThePageClock } from '../support/evening-clock';

/**
 * **W3 · D03-FR-03 / D10-FR-04 (M06-FR-03 "a rebate accrues and reconciles to finance"): on the Supplier rebates page,
 * served by the store computer, a buyer measures what a scheme earned and the accountant puts it in the books — and the
 * register then agrees with the ledger.**
 *
 * Through Chromium:
 *   • the page no longer points at a "supplier screen" that does not exist: with nothing measured it says to measure below;
 *   • the buyer measures the scheme for a period — only the period is sent; head office folds ₹24 from the ₹800 of matched
 *     bills; measuring the same period again replaces it (one accrual, not two);
 *   • the accountant reads the books: earned on the register ₹24, in the books ₹0, "does not agree"; posting before the
 *     accountant's rule exists is refused in head office's words; with the rule set, one press posts it, and the register
 *     and the books agree to the paisa; a second press posts nothing;
 *   • the buyer is not offered the post; Tamil labels.
 * Synthetic data only. The clock is pinned to an evening (the shop's day is the next UTC day).
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['rebate', 'accrual', 'box', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = randomUUID();
const EVENING = theEvening();
const TODAY = EVENING.shopDate;
const YEAR = TODAY.slice(0, 4);
const leg = (account: string, side: 'debit' | 'credit') => ({ account, side, component: 'amount' });
const MAP = {
  rules: [
    ...DEFAULT_RETAIL_POSTING_MAP.rules.filter((r) => r.kind !== 'supplier_rebate' && r.kind !== 'supplier_rebate_accrual'),
    { kind: 'supplier_rebate', legs: [leg('bank_clearing', 'debit'), leg('rebate_receivable', 'credit')] },
    { kind: 'supplier_rebate_accrual', legs: [leg('rebate_receivable', 'debit'), leg('supplier_rebate_income', 'credit')] },
  ],
};

describe.skipIf(!HAVE_BROWSER)('earned rebates are measured and put in the books on the Rebates page (W3 · D03-FR-03 · D10-FR-04)', () => {
  let browser: Browser;
  let ho: ApiHarness;
  let edge: EdgeProcess;
  let dir: string;
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    pinTheEveningClock(EVENING);
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    ho = apiHarness();
    await p3Shop(ho, TENANT, 'sup-1');
    const call = caller(ho, TENANT);
    const lines = [{ productId: 'rice', qty: 16, unitMinor: 5_000 }];
    await issuedOrder(call, 'po-a', lines);
    await received(call, 'grn-a', 'po-a', lines);
    await capturedAndMatched(call, 'inv-a', 'po-a', lines, undefined, 'sup-1', TODAY);
    const scheme = { supplierId: 'sup-1', basis: 'purchase_value', rateBp: 300, startsOn: `${YEAR}-01-01`, endsOn: `${YEAR}-12-31` };
    const sch = await sentWithApproval(ho, TENANT, P3.OWNER, P3.MATCHER, { kind: 'rebate_scheme', subjectRef: 'rb-1', pathIds: { schemeId: 'rb-1' } }, scheme,
      (body) => ho.request({ method: 'POST', path: '/v1/purchase/rebate-schemes/rb-1', userId: P3.OWNER, tenantId: TENANT, idempotencyKey: 'scheme-rb-1', body }));
    if (sch.status !== 201) throw new Error(`scheme: ${JSON.stringify(sch.body)}`);

    dir = await mkdtemp(join(tmpdir(), 'sre-rebate-accruals-'));
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, JSON.stringify({
      version: 1, lossPreventionRules: [], policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1' },
      roles: [
        { id: 'buyer', name: 'Buyer', permissions: ['identity.self.read', 'purchase.commitment.read', 'purchase.contract.manage'] },
        { id: 'acct', name: 'Accountant', permissions: ['identity.self.read', 'purchase.commitment.read', 'finance.period.read', 'finance.journal.post'] },
      ],
      roleAssignments: [{ userId: P3.BUYER, roleId: 'buyer', branchScope: 'all' }, { userId: P3.MATCHER, roleId: 'acct', branchScope: 'all' }],
    }), 'utf8');
    edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
      EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile, EDGE_SCREEN_TRUST_FORWARDED_USER: '1',
    }, () => {}))!;
  }, 240_000);
  afterAll(async () => { await browser?.close(); await edge?.stop(); if (dir !== undefined) await rm(dir, { recursive: true, force: true }); vi.useRealTimers(); });
  afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });

  const open = async (who: string): Promise<{ page: Page; errors: string[]; writes: string[] }> => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', extraHTTPHeaders: { 'x-sre-user': who } });
    await pinThePageClock(context);
    stops.push(() => context.close());
    const writes: string[] = [];
    await context.route('**/v1/**', async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (req.method() !== 'GET') writes.push(`${req.method()} ${url.pathname}`);
      const raw = req.postData();
      const answer = await ho.request({
        method: req.method() as 'GET', path: url.pathname, userId: who, tenantId: TENANT,
        ...(raw === null ? {} : { body: JSON.parse(raw) as unknown }),
        ...(req.headers()['idempotency-key'] === undefined ? {} : { idempotencyKey: req.headers()['idempotency-key'] }),
        ...(url.search === '' ? {} : { query: Object.fromEntries(url.searchParams) }),
      });
      await route.fulfill({ status: answer.status, contentType: 'application/json', body: JSON.stringify(answer.body ?? {}) });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const res = await page.goto(`http://127.0.0.1:${edge.screens!.port}/rebates`, { waitUntil: 'load' });
    expect(res?.status(), '/rebates is served by the store computer').toBe(200);
    return { page, errors, writes };
  };
  const says = (page: Page, selector: string, pattern: RegExp): Promise<unknown> => page.waitForFunction(
    ([sel, src]) => new RegExp(src!).test((globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector(sel!)?.textContent ?? ''),
    [selector, pattern.source], { timeout: 15_000 },
  ).catch(async (e: unknown) => {
    const seen = await page.evaluate((sel) => (globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector(sel)?.textContent ?? '(none)', selector);
    throw new Error(`${selector} never said ${pattern.source}; it says: ${JSON.stringify(seen)} (${String(e)})`);
  });

  it('the buyer measures, the accountant posts, and the register agrees with the ledger', async () => {
    const b = await open(P3.BUYER);
    await b.page.click('#r-show');
    await says(b.page, '#scheme-rows li[data-scheme="rb-1"]', /Earned by period: Nothing earned yet — measure a period below, under "Measure what a scheme earned"\./);
    expect(await b.page.textContent('body')).not.toMatch(/supplier screen/);
    expect(await b.page.isHidden('#books'), 'the buyer is not offered the books').toBe(true);
    await b.page.waitForSelector('#measure:not([hidden])');
    await b.page.fill('#a-scheme', 'rb-1');
    await b.page.click('#a-measure');
    await says(b.page, '#a-status', /^Write the scheme code and both days/);
    await b.page.fill('#a-from', `${YEAR}-01-01`);
    await b.page.fill('#a-to', TODAY);
    expect(b.writes, 'nothing sent while the form does not read').toEqual([]);
    await b.page.click('#a-measure');
    await says(b.page, '#a-status', /^Measured: ₹24\.00 earned on 1 matched bill\(s\)\.$/);
    await says(b.page, '#scheme-rows li[data-scheme="rb-1"]', /Earned ₹24\.00/);
    await b.page.click('#a-measure'); // the same period again replaces it — never a second accrual
    await says(b.page, '#a-status', /^Measured: ₹24\.00/);
    const accruals = (await ho.request({ method: 'GET', path: '/v1/purchase/rebate-schemes/rb-1/accruals', userId: P3.BUYER, tenantId: TENANT })).body as { totalAccruedMinor: number };
    expect(accruals.totalAccruedMinor).toBe(2_400);
    await b.page.click('#lang');
    await says(b.page, '#measure-h', /^ஒரு திட்டம் ஈட்டியதைக் கணக்கிடு$/);
    expect(b.errors).toEqual([]);

    const a = await open(P3.MATCHER);
    await a.page.waitForSelector('#books:not([hidden])');
    expect(await a.page.isHidden('#measure'), 'the accountant does not measure').toBe(true);
    await a.page.click('#b-show');
    await says(a.page, '#book-rows li[data-scheme="rb-1"]', /Earned \(register\) ₹24\.00 · Earned \(books\) ₹0\.00 .* To post ₹24\.00 · Agrees NO/);
    await says(a.page, '#b-accounts', /has not set the posting rule for earned rebates/);
    await a.page.click('#b-post');
    await says(a.page, '#b-status', /^Head office refused: The ledger mapping has no "supplier_rebate_accrual" rule/);
    const mapped = await ho.request({ method: 'PUT', path: '/v1/finance/posting-map', userId: P3.MATCHER, tenantId: TENANT, idempotencyKey: 'map-1', body: MAP });
    expect(mapped.status, JSON.stringify(mapped.body)).toBeLessThan(300);
    await a.page.click('#b-post');
    await says(a.page, '#b-status', /^1 entr\(ies\) put in the books\.$/);
    await says(a.page, '#book-rows li[data-scheme="rb-1"]', /Earned \(register\) ₹24\.00 · Earned \(books\) ₹24\.00 · Received ₹0\.00 · Still to come \(books\) ₹24\.00 · To post ₹0\.00 · Agrees yes/);
    await says(a.page, '#book-rows', /The books agree with the register for every scheme\./);
    await says(a.page, '#b-accounts', /Posts to: rebate_receivable \(receivable\) and supplier_rebate_income \(income\)/);
    await a.page.click('#b-post');
    await says(a.page, '#b-status', /^Nothing to post — the books already hold what the register earned\.$/);
    const books = (await ho.request({ method: 'GET', path: '/v1/finance/rebate-accruals', userId: P3.MATCHER, tenantId: TENANT })).body as { agrees: boolean; registerAccruedMinor: number; ledgerAccruedMinor: number };
    expect(books).toMatchObject({ agrees: true, registerAccruedMinor: 2_400, ledgerAccruedMinor: 2_400 });
    expect(a.writes.filter((w) => w === 'POST /v1/finance/rebate-accruals/post')).toHaveLength(3);
    expect(a.errors).toEqual([]);
  }, 120_000);
});
