import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { auditPage } from './lib/a11y-audit';
import { confirmIt } from './lib/confirm-sheet';
import { newHeadOffice, startPricingHeadOffice, decideAsSomeoneElse, posts, CALLER, type PricingHeadOffice } from './lib/pricing-head-office';

/**
 * **D-019 · D-020 — the store manager's "Change price", in a real browser (daily-work walkthrough, M05-FR-02).**
 *
 * D-020: the form read the MRP from the store computer's till-pack copy, so an MRP the owner had just added at head office
 * still said "No MRP" until the pack was sent again. Now it reads head office's own MRP, live, and says where it came from.
 *
 * D-019: an item with no MRP at head office could not be repriced at all, and the page offered no way forward. Now the MRP
 * printed on the pack is typed in the same form. The law does not move — above that MRP is refused and nothing can
 * approve it — and no approval is loosened: such a price goes to a second person, who approves exactly the change WITH
 * that MRP in it, and is asked to check the MRP on the pack.
 *
 * Driven in headless Chromium against the stub head office (real `checkPrice`, the approval engine's own
 * `actionDetails` / `takeApproval`). The browser is the environment's pre-installed Chromium; without one the suite SKIPS.
 */

const ddmm = (iso: string): string => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const TODAY = '2026-10-07';

interface BrowserGlobals {
  readonly catalogueSession?: { readonly canChangePriceInCloud: boolean; readonly canAskForApproval: boolean };
  readonly document: { getElementById(id: string): { hidden: boolean; textContent: string | null } | null };
}

/** Biscuits whose store-computer copy carries NO MRP (the pack was sent before the owner added it). */
const context = (): Record<string, unknown> => ({
  userId: CALLER, storeId: 'store-1', today: TODAY, marginFloorBps: 1000,
  categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }],
  products: [{
    productId: 'prod-biscuit', tenantId: 't1', sku: 'BISC-1', name: 'Marie biscuits', primaryCategoryId: 'grocery', baseUom: 'ea',
    taxClass: '1905', attributes: {}, mrpHistory: [], lifecycle: 'active',
  }],
  costsMinor: { 'prod-biscuit': 25_00 },
});

describe.skipIf(!HAVE_BROWSER)('D-019 · D-020: Change price reads head office’s MRP, or the MRP printed on the pack with a second person', () => {
  let browser: Browser;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 60_000);
  afterAll(async () => { await browser?.close(); });

  const open = async (ho: PricingHeadOffice) => {
    const srv = await startPricingHeadOffice(ho);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${srv.base}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => {
      const s = (globalThis as unknown as BrowserGlobals).catalogueSession;
      return s?.canChangePriceInCloud === true && s.canAskForApproval === true;
    }, undefined, { timeout: 10_000 });
    await page.click('#tab-price');
    return { page, errors, teardown: async () => { await ctx.close(); await srv.stop(); } };
  };

  const hidden = (page: Page, id: string) => page.evaluate((i) => (globalThis as unknown as BrowserGlobals).document.getElementById(i)?.hidden ?? true, id);

  const clickFor = async (page: Page, button: string, expected: RegExp, between?: (page: Page) => Promise<void>) => {
    await page.click(button);
    if (between) await between(page);
    await page.waitForFunction((source) => {
      const doc = (globalThis as unknown as BrowserGlobals).document;
      const banner = doc.getElementById('banner');
      return banner !== null && !banner.hidden && new RegExp(source).test(doc.getElementById('banner-text')?.textContent ?? '');
    }, expected.source, { timeout: 10_000 });
    const said = { title: ((await page.textContent('#banner-title')) ?? '').trim(), text: ((await page.textContent('#banner-text')) ?? '').trim() };
    await page.click('#banner-ok');
    return said;
  };

  it('D-020: the MRP the owner just added at head office is used at once — the pack copy has none', async () => {
    const ho = newHeadOffice(context());
    ho.mrpAtHeadOffice = { 'prod-biscuit': { mrpMinor: 35_00, from: '2026-10-06' } };
    const { page, errors, teardown } = await open(ho);
    try {
      await page.fill('#price-from', ddmm(TODAY));
      await page.fill('#price-item', 'BISC-1');
      await page.waitForFunction(() => (globalThis as unknown as BrowserGlobals).document.getElementById('mrp-value')?.textContent === '₹35.00', undefined, { timeout: 10_000 });
      expect(await page.textContent('#mrp-source')).toBe('Head office’s MRP for this item — from 2026-10-06');
      expect(await hidden(page, 'mrp-given'), 'no box for the pack MRP when head office has one').toBe(true);
      const read = ho.requests.filter((r) => r.method === 'GET' && r.path === '/v1/prices/list/prod-biscuit/basis');
      expect(read.length, 'head office was asked for the MRP').toBeGreaterThanOrEqual(1);

      await page.fill('#new-price', '32');
      await page.waitForSelector('#save-price:not([hidden])', { timeout: 10_000 });
      expect(await hidden(page, 'price-approval'), 'a clean price at or under head office’s MRP needs nobody else').toBe(true);
      const saved = await clickFor(page, '#save-price', /the tills will have it within 5 minutes/, confirmIt); // OB-806 A
      expect(saved.title).toBe('Price saved');
      const change = posts(ho, '/v1/prices/changes');
      expect(change).toHaveLength(1);
      expect(change[0]!.body).toEqual({ productId: 'prod-biscuit', priceMinor: 32_00, mrpMinor: 35_00, costMinor: 25_00, currency: 'INR', marginFloorBps: 1000 });
      expect(errors).toEqual([]);
    } finally { await teardown(); }
  });

  it('D-020: above head office’s MRP is refused, with no Save', async () => {
    const ho = newHeadOffice(context());
    ho.mrpAtHeadOffice = { 'prod-biscuit': { mrpMinor: 35_00, from: '2026-10-06' } };
    const { page, teardown } = await open(ho);
    try {
      await page.fill('#price-from', ddmm(TODAY));
      await page.fill('#price-item', 'BISC-1');
      await page.waitForFunction(() => (globalThis as unknown as BrowserGlobals).document.getElementById('mrp-value')?.textContent === '₹35.00', undefined, { timeout: 10_000 });
      await page.fill('#new-price', '36');
      await page.waitForSelector('#price-verdict:not([hidden])');
      expect(await page.textContent('#price-verdict')).toContain('more than the MRP printed on the pack');
      expect(await hidden(page, 'save-price')).toBe(true);
      expect(posts(ho, '/v1/prices/changes')).toHaveLength(0);
    } finally { await teardown(); }
  });

  it('D-019: head office has no MRP — type the one on the pack; a second person checks it; the change carries it', async () => {
    const ho = newHeadOffice(context());
    ho.mrpAtHeadOffice = { 'prod-biscuit': { mrpMinor: null, from: null } };
    const { page, errors, teardown } = await open(ho);
    try {
      await page.fill('#price-from', ddmm(TODAY));
      await page.fill('#price-item', 'BISC-1');
      await page.waitForSelector('#mrp-given:not([hidden])', { timeout: 10_000 });
      expect(await page.textContent('#mrp-given-lead')).toContain('Head office has no MRP for this item');
      // The new box passes the same accessibility audit as every page.
      expect(await auditPage(page, { minTarget: 48 }), 'the form with the pack-MRP box').toEqual([]);

      // A price with no MRP typed: nothing to check against — no Save, and pressing Check says what is missing.
      await page.fill('#new-price', '32');
      expect(await hidden(page, 'save-price')).toBe(true);
      expect((await clickFor(page, '#check-price', /Type the MRP printed on the pack/)).text).toContain('Head office has no MRP for this item');

      // Above the pack's MRP: refused outright, no ask, no Save.
      await page.fill('#mrp-given-value', '35');
      await page.fill('#new-price', '36');
      await page.waitForSelector('#price-verdict:not([hidden])');
      expect(await page.textContent('#price-verdict')).toContain('more than the MRP printed on the pack');
      expect(await hidden(page, 'save-price')).toBe(true);
      expect(await hidden(page, 'price-approval')).toBe(true);

      // At or under it: never one person's word — the second-person step shows.
      await page.fill('#new-price', '32');
      await page.waitForSelector('#price-approval:not([hidden])', { timeout: 10_000 });
      expect(await page.textContent('#price-verdict')).toContain('Somebody else has to check it against the pack');
      expect(await page.textContent('#save-price')).toBe('Save it');

      // Save before asking: refused on the screen, nothing sent.
      expect((await clickFor(page, '#save-price', /nobody has been asked/, confirmIt)).text).toMatch(/^Not saved — nobody has been asked/);
      expect(posts(ho, '/v1/prices/changes')).toHaveLength(0);

      // Ask — the approval is for exactly the change WITH the pack's MRP, and says to check it on the pack.
      await page.fill('#price-why', 'new stock arrived; MRP 35 printed on the pack');
      await clickFor(page, '#ask-price', /Waiting for a second person/);
      const ask = posts(ho, '/v1/approvals/requests');
      expect(ask).toHaveLength(1);
      const figures = { productId: 'prod-biscuit', priceMinor: 32_00, mrpMinor: 35_00, costMinor: 25_00, currency: 'INR', marginFloorBps: 1000 };
      expect(ask[0]!.body).toMatchObject({ kind: 'price_change', subjectRef: 'prod-biscuit', details: figures, valueMinor: 32_00 });
      expect((ask[0]!.body as { summary: string }).summary).toBe('Price of Marie biscuits to ₹32.00 — head office has no MRP, so ₹35.00 was typed from the pack: check the MRP on the pack before approving (cost ₹25.00)');

      // The approver checks the pack and approves, in their own session; Save sends exactly that change naming it.
      decideAsSomeoneElse(ho, 'areq-1', 'approved', 'checked the pack: MRP ₹35');
      const saved = await clickFor(page, '#save-price', /^Price saved/, confirmIt);
      expect(saved.text).toBe('Price saved: ₹32.00. The approval has now been used — another change needs a new approval. Saved — the tills will have it within 5 minutes.'); // OB-806 A
      const change = posts(ho, '/v1/prices/changes');
      expect(change).toHaveLength(1);
      expect(change[0]!.body).toEqual({ ...figures, approvalId: 'areq-1' });
      expect(ho.approvals.get('areq-1')?.usedBy).toBe('price_change:prod-biscuit');
      expect(errors).toEqual([]);
    } finally { await teardown(); }
  });

  it('D-019: a pack MRP changed after asking is not what was approved — nothing is sent', async () => {
    const ho = newHeadOffice(context());
    ho.mrpAtHeadOffice = { 'prod-biscuit': { mrpMinor: null, from: null } };
    const { page, teardown } = await open(ho);
    try {
      await page.fill('#price-from', ddmm(TODAY));
      await page.fill('#price-item', 'BISC-1');
      await page.waitForSelector('#mrp-given:not([hidden])', { timeout: 10_000 });
      await page.fill('#mrp-given-value', '35');
      await page.fill('#new-price', '32');
      await page.waitForSelector('#price-approval:not([hidden])', { timeout: 10_000 });
      await page.fill('#price-why', 'new stock arrived; MRP 35 printed on the pack');
      await clickFor(page, '#ask-price', /Waiting for a second person/);
      decideAsSomeoneElse(ho, 'areq-1', 'approved', 'checked the pack: MRP ₹35');
      // The MRP is changed after the approval: the approval was for ₹35, so it does not cover ₹40.
      await page.fill('#mrp-given-value', '40');
      await page.waitForSelector('#price-approval:not([hidden])', { timeout: 10_000 });
      const said = await clickFor(page, '#save-price', /^Not saved/, confirmIt);
      expect(said.text).toMatch(/nobody has been asked|not exactly what was approved/);
      expect(posts(ho, '/v1/prices/changes')).toHaveLength(0);
    } finally { await teardown(); }
  });
});
