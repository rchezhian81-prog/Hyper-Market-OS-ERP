import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';

/**
 * **G-1 · M03-FR-01 / -02 / -04 — the Product setup tab on Products and prices**, in a real browser, on the PRODUCTION API
 * over real PostgreSQL. Every click reaches head office's own route and the result is read back from head office:
 *
 *   • M03-FR-01: the owner adds a category (their save is the approval) and reads the variant report; a store manager
 *     cannot save one alone — they ask, the owner approves on head office's engine, and the manager saves it naming that
 *     approval;
 *   • M03-FR-02: the owner defines a bundle; an inexact pack (a case of 2.5) is refused in head office's own words and
 *     nothing is saved; an exact one is saved;
 *   • M03-FR-04: the owner sets a product's approved substitutes (unreachable → nothing saved, never a success); a manager
 *     proposes a merge, the owner approves it; the owner is offered no Approve on a merge they proposed themselves;
 *   • a cashier reads and is offered no way to change anything.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['product', 'setup', 'e2e', 'signing', 'key'].join('-').padEnd(48, '0');
const CASHIER = 'u-cash';
const CATS = [{ categoryId: 'home', name: 'Home care', parentId: null }];

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('product setup on the catalogue page, on the production API (G-1)', () => {
  let browser: Browser;
  let shop: InboxShop;
  const api = async (path: string, userId = OWNER): Promise<Record<string, unknown>> =>
    (await shop.cloud().request({ method: 'GET', path, userId })).body as Record<string, unknown>;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/catalogue', html: 'catalogue.html', dataGlobal: 'catalogueData', extraData: async () => ({ storeId: 'br-1', products: [] }) },
      seed: async (cloud) => {
        await cloud.grant(CASHIER, 'cashier');
        const publish = (productId: string, extra: Record<string, unknown> = {}) => ok(cloud.request({
          method: 'POST', path: `/v1/catalogue/products/${productId}/publish`, userId: OWNER, idempotencyKey: `pub-${productId}`,
          body: { product: { baseUom: 'each', lifecycle: 'active', taxClass: '3305', primaryCategoryId: 'home', sku: `SKU-${productId}`, name: productId, ...extra }, categories: CATS },
        }), `publish ${productId}`);
        await publish('shampoo', { manufacturer: 'Maker A', brand: 'Shine' });
        await publish('shampoo-100', { parentProductId: 'shampoo', attributes: { size: '100ml' } });
        for (const id of ['gift-box', 'tea', 'mug', 'rice', 'tea-dup', 'mug-dup']) await publish(id);
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  const open = async (who: string, branch?: string) => {
    const context = await browser.newContext();
    await shop.signIn(context, who, branch);
    const page = await context.newPage();
    const writes: string[] = []; const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${u.pathname}`); });
    await page.goto(`${shop.base}/catalogue?tab=setup`, { waitUntil: 'load' });
    return { page, writes, errors, close: () => context.close() };
  };
  const says = async (page: Page, selector: string, expected: RegExp): Promise<void> => {
    await page.waitForFunction(([sel, source]) => new RegExp(source!).test((globalThis as unknown as { document: { querySelector(x: string): { textContent: string | null } | null } }).document.querySelector(sel!)?.textContent ?? ''), [selector, expected.source], { timeout: 15_000 });
  };

  it('the owner adds a category, reads the variant report, defines a bundle, a pack (an inexact one refused) and substitutes', async () => {
    const s = await open(OWNER);
    try {
      await says(s.page, '#cat-list [data-category="home"]', /home — Home care/);
      expect(s.writes, 'nothing is written on open').toEqual([]);
      expect(await s.page.locator('#cat-ask').isHidden(), 'the owner\'s save is the approval — no ask button').toBe(true);

      // M03-FR-01: a category, saved by the owner directly.
      await s.page.fill('#cat-id', 'hair');
      await s.page.fill('#cat-name', 'Hair care');
      await s.page.fill('#cat-parent', 'home');
      await s.page.check('#cat-regulated-boxes [data-regulated="packed"]');
      await s.page.click('#cat-save');
      await says(s.page, '#cat-save-status', /^Saved at head office\./);
      await says(s.page, '#cat-list [data-category="hair"]', /hair — Hair care \(under home\) · version 1, saved by u-owner, approved by u-owner/);
      const hair = ((await api('/v1/catalogue/categories')).categories as { categoryId: string; parentId: string; regulated?: string[] }[]).find((c) => c.categoryId === 'hair');
      expect(hair).toMatchObject({ parentId: 'home', regulated: ['packed'] });

      // M03-FR-01: the variant report for "home".
      await s.page.fill('#rep-category', 'home');
      await s.page.click('#rep-show');
      await says(s.page, '#rep-out [data-family="shampoo"]', /shampoo — Shine, made by Maker A: shampoo-100 \(size 100ml\)/);
      await says(s.page, '#rep-out [data-maker="not recorded"]', /not recorded: /);

      // M03-FR-02: a bundle.
      await s.page.fill('#bun-product', 'gift-box');
      await s.page.fill('#bun-components', 'tea 2\nmug 1');
      await s.page.fill('#bun-reason', 'Diwali box');
      await s.page.click('#bun-save');
      await says(s.page, '#bun-status', /^Saved at head office as a new version\./);
      await says(s.page, '#bun-out', /Version 1: tea × 2, mug × 1/);
      expect((await api('/v1/catalogue/bundles/gift-box')).bundle).toMatchObject({ version: 1, definedBy: OWNER });

      // M03-FR-02: an inexact pack is refused in head office's words; nothing saved. Then an exact one.
      await s.page.fill('#pack-product', 'rice');
      await s.page.fill('#pack-base', 'each');
      await s.page.fill('#pack-levels', 'each 1\ncase 2.5');
      await s.page.click('#pack-save');
      await says(s.page, '#pack-status', /^Head office refused: This pack cannot be defined/);
      expect((await shop.cloud().request({ method: 'GET', path: '/v1/catalogue/products/rice/pack', userId: OWNER })).status).toBe(404);
      await s.page.fill('#pack-levels', 'each 1\ncase 24');
      await s.page.click('#pack-save');
      await says(s.page, '#pack-status', /^Saved at head office\./);
      await says(s.page, '#pack-out', /case: holds 24 of the size below/);

      // M03-FR-04: substitutes; unreachable says nothing was saved and nothing was.
      await s.page.fill('#sub-product', 'tea');
      await s.page.click('#sub-read');
      await says(s.page, '#sub-out', /No substitutes have been set for this item\./);
      await s.page.route('**/v1/catalogue/products/tea/substitutes', (route) => (route.request().method() === 'POST' ? route.abort() : route.continue()));
      await s.page.fill('#sub-list', 'mug');
      await s.page.fill('#sub-reason', 'out of tea, offer a mug');
      await s.page.click('#sub-save');
      await says(s.page, '#sub-status', /^Head office cannot be reached — nothing was saved\./);
      await s.page.unroute('**/v1/catalogue/products/tea/substitutes');
      expect((await api('/v1/catalogue/products/tea/substitutes')).set).toBe(false);
      await s.page.fill('#sub-list', 'mug\ngift-box');
      await s.page.click('#sub-save');
      await says(s.page, '#sub-status', /^Saved at head office as a new version\./);
      await says(s.page, '#sub-out', /Version 1: mug, gift-box/);
      expect(((await api('/v1/catalogue/products/tea/substitutes')).list as { substitutes: string[] }).substitutes).toEqual(['mug', 'gift-box']);

      expect(s.writes).toEqual([
        'POST /v1/catalogue/categories/hair', 'POST /v1/catalogue/bundles/gift-box',
        'POST /v1/catalogue/products/rice/pack', 'POST /v1/catalogue/products/rice/pack',
        'POST /v1/catalogue/products/tea/substitutes', 'POST /v1/catalogue/products/tea/substitutes',
      ]);
      // The words switch to Tamil.
      await s.page.click('#lang');
      await says(s.page, '#tab-setup', /^பொருள் அமைப்பு/);
      await says(s.page, '#sub-out', /பதிப்பு 1: mug, gift-box/);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  }, 180_000);

  it('a manager asks for a category and saves it with the owner\'s approval; proposes a merge the owner approves; nobody approves their own', async () => {
    const m = await open(MGR, 'br-1');
    try {
      await says(m.page, '#setup-status', /You can ask the owner for a new category; the owner’s approval is needed before it is saved\./);
      expect(await m.page.locator('#cat-save').isHidden(), 'a manager has no direct save').toBe(true);
      expect(await m.page.locator('#bun-form').isHidden()).toBe(true);
      await m.page.fill('#cat-id', 'baby');
      await m.page.fill('#cat-name', 'Baby care');
      await m.page.click('#cat-ask');
      await says(m.page, '#cat-save-status', /^Write why/);
      expect(m.writes).toEqual([]);
      await m.page.fill('#cat-reason', 'new baby aisle');
      await m.page.click('#cat-ask');
      await says(m.page, '#cat-save-status', /^Asked\. The owner decides it on the Approvals page/);
      await says(m.page, '#cat-mine [data-asked="baby"]', /baby — Baby care: waiting for the owner/);
      expect(((await api('/v1/catalogue/categories')).categories as { categoryId: string }[]).map((c) => c.categoryId)).not.toContain('baby');

      // M03-FR-04: the manager proposes a merge.
      await m.page.fill('#mrg-keep', 'tea');
      await m.page.fill('#mrg-supersede', 'tea-dup');
      await m.page.fill('#mrg-reason', 'same tea entered twice');
      await m.page.click('#mrg-propose');
      await says(m.page, '#mrg-status', /^Proposed\. A different person must approve it\./);
      await says(m.page, '#mrg-list [data-supersede="tea-dup"]', /Keep tea, merge tea-dup into it — proposed by u-mgr-br1: same tea entered twice · waiting for a second person/);
      expect(await m.page.locator('#mrg-list [data-approve-merge]').count(), 'a manager may not approve a merge').toBe(0);
    } finally { await m.close(); }

    // The owner approves the category request on head office's engine, in their own session.
    const inbox = (await api('/v1/approvals/requests')).waitingForMe as { requestId: string; kind: string; subjectRef: string }[];
    const req = inbox.find((r) => r.kind === 'category_define' && r.subjectRef === 'baby')!;
    await ok(shop.cloud().request({ method: 'POST', path: `/v1/approvals/requests/${req.requestId}/decide`, userId: OWNER, idempotencyKey: randomUUID(), body: { decision: 'approved', reason: 'yes, a baby aisle' } }), 'approve category');

    const m2 = await open(MGR, 'br-1');
    try {
      await says(m2.page, '#cat-mine [data-asked="baby"]', /approved/);
      await m2.page.click('#cat-mine [data-use-approval="baby"]');
      await says(m2.page, '#cat-save-status', /^Saved at head office\./);
      await says(m2.page, '#cat-list [data-category="baby"]', /saved by u-mgr-br1, approved by u-owner/);
      expect(m2.writes).toEqual(['POST /v1/catalogue/categories/baby']);
      expect(m2.errors).toEqual([]);
    } finally { await m2.close(); }

    const o = await open(OWNER);
    try {
      // The owner approves the manager's merge.
      await o.page.click('#mrg-list [data-approve-merge]');
      await says(o.page, '#mrg-status', /^Approved at head office\./);
      await says(o.page, '#mrg-list [data-supersede="tea-dup"]', /approved by u-owner/);
      expect((await api('/v1/catalogue/products/tea-dup/canonical')).canonicalProductId).toBe('tea');
      // The owner proposes one; the page offers them no Approve on it, and says why.
      await o.page.fill('#mrg-keep', 'mug');
      await o.page.fill('#mrg-supersede', 'mug-dup');
      await o.page.fill('#mrg-reason', 'same mug twice');
      await o.page.click('#mrg-propose');
      await says(o.page, '#mrg-list [data-supersede="mug-dup"]', /You proposed this merge — a different person must decide it\./);
      expect(await o.page.locator('#mrg-list [data-supersede="mug-dup"] [data-approve-merge]').count()).toBe(0);
      expect(o.writes.filter((w) => w.endsWith('/decision'))).toHaveLength(1);
      expect(o.errors).toEqual([]);
    } finally { await o.close(); }
    const mugMerge = ((await api('/v1/catalogue/merges')).merges as { request: { supersedeProductId: string }; status: string }[]).find((x) => x.request.supersedeProductId === 'mug-dup');
    expect(mugMerge?.status).toBe('pending');
  }, 180_000);

  it('a cashier reads the product setup and is offered no way to change it', async () => {
    const s = await open(CASHIER);
    try {
      await says(s.page, '#setup-status', /You can read the product setup; changing it needs the product role\./);
      await says(s.page, '#cat-list [data-category="home"]', /home — Home care/);
      for (const form of ['#cat-form', '#bun-form', '#pack-form', '#sub-form', '#mrg-form']) expect(await s.page.locator(form).isHidden(), form).toBe(true);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    expect((await shop.cloud().request({ method: 'POST', path: '/v1/catalogue/products/tea/substitutes', userId: CASHIER, idempotencyKey: randomUUID(), body: { substitutes: [], reason: 'x' } })).status).toBe(403);
  }, 60_000);
});
