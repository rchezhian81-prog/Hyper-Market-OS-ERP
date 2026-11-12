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
import { STREAM, posAdapter } from '../../services/api/src/adapters';
import type { IncomingSale } from '../../services/pos/src/sale-intake';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';
import { auditPage } from './lib/a11y-audit';

/**
 * **U5 (UI/UX gap audit, 1 Nov 2026, lane 3 HARD): the Bill findings page shows 48 findings as counts and grouped registers,
 * not 48 identical cards in one 9,000-pixel column — in a real browser, served by the real store computer over head
 * office's real routes.**
 *
 * Head office raised 48 findings on this store's bills (four kinds; two kinds carry critical findings). Through Chromium:
 *   • the top of the page counts them: critical · material · informational, and one card PER KIND with its count;
 *   • each kind is its own register of at most 10 rows a page — "Showing 1–10 of 14", a next page, a search that narrows
 *     the register to one bill; the kinds with a critical finding come first; no ⚠/✕ characters — the shared chip;
 *   • each row names what head office found and what to do (its sentences, in English) and links to the product;
 *   • in Tamil on the toggle the kind's name and every page word are Tamil; head office's sentences stay English, said once;
 *   • one primary action on the page; the rendered WCAG audit is clean at desk width; at 360px nothing reaches past the
 *     viewport; nothing is written.
 * Synthetic data only. Without a browser binary it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['u5', 'findings', 'box', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = randomUUID();
const OWNER = 'u-owner'; const MANAGER = 'u-mgr'; const CASHIER = 'u-cash';
const STORE = 'store-1';
const EARLIER = new Date(Date.now() - 60_000).toISOString();
const TODAY = shopDateIn(EARLIER);
/** 48 findings: 14 price cuts below the floor (2 critical), 14 above the approver's limit, 12 recalled products (all critical), 8 above MRP. */
const SEED: { kind: string; severity: 'critical' | 'material'; n: number; criticalFirst: number }[] = [
  { kind: 'price_cut_below_floor', severity: 'material', n: 14, criticalFirst: 2 },
  { kind: 'price_cut_above_approver_limit', severity: 'material', n: 14, criticalFirst: 0 },
  { kind: 'sold_a_recalled_product', severity: 'critical', n: 12, criticalFirst: 12 },
  { kind: 'sold_above_mrp', severity: 'material', n: 8, criticalFirst: 0 },
];

/** What reaches past a 360px viewport. A register's own scroll box (`.sre-scroll-x`) is contained, so its cells are not the page scrolling sideways. */
const widest = (page: Page): Promise<string[]> => page.evaluate(`(() => {
  const w = document.documentElement.clientWidth;
  if (document.documentElement.scrollWidth > w + 1) return ['document scrollWidth=' + document.documentElement.scrollWidth];
  return Array.from(document.querySelectorAll('body *'))
    .filter((el) => !el.closest('.sre-scroll-x'))
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ r }) => r.right > w + 1 && r.width > 0)
    .filter(({ el }) => !Array.from(el.children).some((c) => c.getBoundingClientRect().right > w + 1))
    .slice(0, 8)
    .map(({ el, r }) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + ' right=' + Math.round(r.right));
})()`) as Promise<string[]>;

describe.skipIf(!HAVE_BROWSER)('U5: the Bill findings page groups and counts 48 findings', () => {
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
    await ho.provisionRole(TENANT, CASHIER, 'cashier', [STORE]);
    const pos = posAdapter({ store: ho.store, now: () => EARLIER });
    let i = 0;
    for (const s of SEED) {
      for (let k = 0; k < s.n; k += 1) {
        i += 1;
        const saleId = `S-${String(i).padStart(3, '0')}`;
        const severity = k < s.criticalFirst ? 'critical' : s.severity;
        const productId = `p-item-${(i % 5) + 1}`;
        await ho.store.append(TENANT, STREAM.saleExceptions, makeEvent({
          id: `saleex-${saleId}-${s.kind}`, type: 'SaleExceptionRaised', occurredAt: EARLIER,
          idempotencyKey: `saleex-${TENANT}-${saleId}-${s.kind}`, source: 'api/pos',
          payload: { kind: s.kind, severity, saleId, productId, differenceMinor: 100 * i, detail: `${productId} on bill ${saleId}: ${s.kind.replaceAll('_', ' ')}`, ownerAction: severity === 'critical' ? 'ACT NOW: contact the customer.' : 'Ask the manager. The sale stands.' },
        }));
        await pos.bankSale(TENANT, { saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', cashierId: CASHIER, tradingDay: TODAY, committedAt: EARLIER, totalMinor: 100, currency: 'INR', packVersion: 999, locationId: STORE,
          lines: [{ productId, quantityMinor: 1, uom: 'ea', unitPriceMinor: 100 }], tenders: [{ kind: 'cash', amountMinor: 100 }] } as unknown as IncomingSale);
      }
    }
    dir = await mkdtemp(join(tmpdir(), 'sre-u5-findings-'));
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, JSON.stringify({
      version: 1, lossPreventionRules: [], policies: { tradingDayCutoff: '02:00', storeId: STORE, branchId: STORE },
      roles: [{ id: 'manager', name: 'Store manager', permissions: ['identity.self.read', 'pos.exception.read', 'workforce.roster.read'] }],
      roleAssignments: [{ userId: MANAGER, roleId: 'manager', branchScope: [STORE] }],
    }), 'utf8');
    edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
      EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile, EDGE_SCREEN_TRUST_FORWARDED_USER: '1',
    }, () => {}))!;
  }, 300_000);
  afterAll(async () => { await browser?.close(); await edge?.stop(); if (dir !== undefined) await rm(dir, { recursive: true, force: true }); });
  afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });

  const open = async (who: string, viewport: { width: number; height: number }): Promise<{ page: Page; errors: string[]; writes: string[] }> => {
    const context = await browser.newContext({ viewport, serviceWorkers: 'block', extraHTTPHeaders: { 'x-sre-user': who }, ...(viewport.width < 600 ? { hasTouch: true, isMobile: true } : {}) });
    stops.push(() => context.close());
    const writes: string[] = [];
    await context.route('**/v1/**', async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (req.method() !== 'GET') writes.push(`${req.method()} ${url.pathname}`);
      const answer = await ho.request({ method: req.method() as 'GET', path: url.pathname, userId: who, tenantId: TENANT, branchId: STORE, ...(url.search === '' ? {} : { query: Object.fromEntries(url.searchParams) }) });
      await route.fulfill({ status: answer.status, contentType: 'application/json', body: JSON.stringify(answer.body ?? {}) });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const res = await page.goto(`http://127.0.0.1:${edge.screens!.port}/findings/`, { waitUntil: 'load' });
    expect(res?.status()).toBe(200);
    return { page, errors, writes };
  };
  const says = (page: Page, selector: string, pattern: RegExp): Promise<unknown> => page.waitForFunction(
    ([sel, src]) => new RegExp(src!).test((globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector(sel!)?.textContent ?? ''),
    [selector, pattern.source], { timeout: 15_000 },
  ).catch(async (e: unknown) => {
    const seen = await page.evaluate((sel) => (globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector(sel)?.textContent ?? '(none)', selector);
    throw new Error(`${selector} never said ${pattern.source}; it says: ${JSON.stringify(seen)} (${String(e)})`);
  });

  it('counts by kind, one register per kind with paging and search, critical kinds first, chips not characters; Tamil; one primary; audit clean', async () => {
    const m = await open(MANAGER, { width: 1280, height: 900 });
    await says(m.page, '#s-counts', /^14 · 34 · 0 /);
    // one card per kind, with its count, the kinds with a critical finding first
    await m.page.waitForSelector('#s-kinds .sre-summary-card');
    const kinds = await m.page.$$eval('#s-kinds .sre-summary-card', (cs) => cs.map((c) => `${(c as unknown as { dataset: Record<string, string> }).dataset['kind']}:${c.querySelector('.sre-summary-value')?.textContent}`));
    expect(kinds).toEqual(['sold_a_recalled_product:12', 'price_cut_below_floor:14', 'price_cut_above_approver_limit:14', 'sold_above_mrp:8']);
    // each kind is a register: the first group's heading, its count line, its next page
    const groups = await m.page.$$eval('#s-groups section.group', (gs) => gs.map((g) => (g as unknown as { dataset: Record<string, string> }).dataset['kind']));
    expect(groups).toEqual(['sold_a_recalled_product', 'price_cut_below_floor', 'price_cut_above_approver_limit', 'sold_above_mrp']);
    await says(m.page, '#s-groups section.group[data-kind="sold_a_recalled_product"] h4', /^A recalled product was sold · 12 findings/);
    await says(m.page, '#f-price_cut_below_floor-count', /^Showing 1–10 of 14$/);
    expect(await m.page.$$eval('#f-price_cut_below_floor-grid tbody tr', (rs) => rs.length)).toBe(10);
    // critical first inside the group — the two critical price cuts (S-001, S-002) head it
    expect(await m.page.$$eval('#f-price_cut_below_floor-grid tbody tr', (rs) => rs.slice(0, 3).map((r) => `${(r as unknown as { dataset: Record<string, string> }).dataset['severity']}:${(r as unknown as { dataset: Record<string, string> }).dataset['sale']}`))).toEqual(['critical:S-001', 'critical:S-002', 'material:S-003']);
    await m.page.click('#f-price_cut_below_floor-next');
    await says(m.page, '#f-price_cut_below_floor-count', /^Showing 11–14 of 14$/);
    // search narrows the register to one bill
    await m.page.fill('#f-price_cut_above_approver_limit-search', 'S-020');
    await says(m.page, '#f-price_cut_above_approver_limit-count', /^Showing 1–1 of 1$/);
    // the chip, not a character; the product link; head office's sentences
    const row = m.page.locator('#f-sold_a_recalled_product-grid tbody tr').first();
    expect(await row.locator('.sre-chip[data-tone="error"]').count()).toBe(1);
    expect(await row.locator('a[href*="product-details"]').count()).toBe(1);
    await says(m.page, '#f-sold_a_recalled_product-grid tbody tr:first-child', /ACT NOW: contact the customer\./);
    expect(await m.page.evaluate(`document.body.innerText.includes('⚠') || document.body.innerText.includes('✕')`)).toBe(false);
    // one primary on the page
    expect(await m.page.$$eval('.sre-btn-primary:not([hidden])', (bs) => bs.filter((b) => (b as unknown as { offsetParent: unknown }).offsetParent !== null).length)).toBe(1);
    expect(await auditPage(m.page, { expectLang: 'en' })).toEqual([]);
    // Tamil: the kind's name and the page's words; head office's sentence stays English, said once
    await m.page.click('#lang');
    await says(m.page, '#s-groups section.group[data-kind="sold_a_recalled_product"] h4', /^திரும்பப் பெறப்பட்ட பொருள் விற்கப்பட்டது · 12 கண்டறிதல்கள்/);
    await says(m.page, '#s-note', /தலைமை அலுவலகத்தின் சொந்த வாக்கியங்கள் ஆங்கிலத்தில்/);
    await says(m.page, '#f-sold_a_recalled_product-grid tbody tr:first-child', /ACT NOW: contact the customer\./);
    expect(await auditPage(m.page, { expectLang: 'ta' })).toEqual([]);
    expect(m.errors).toEqual([]);
    expect(m.writes).toEqual([]);
  });

  it('fits a 360px phone: nothing reaches past the viewport; the counts and the first group are there', async () => {
    const p = await open(MANAGER, { width: 360, height: 640 });
    await says(p.page, '#s-counts', /^14 · 34 · 0 /);
    await p.page.waitForSelector('#f-sold_a_recalled_product-grid');
    expect(await widest(p.page)).toEqual([]);
    expect(p.errors).toEqual([]);
  });
});
