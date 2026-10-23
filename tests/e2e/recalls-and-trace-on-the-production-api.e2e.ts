import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';

/**
 * **Recalls and trace (P-07 · M10-FR-03 · M10-FR-04 · WF-09 · OB-297 · OB-328 · OB-329) — in a real browser, on the
 * PRODUCTION API over real PostgreSQL.**
 *
 * The page is served in front of the real API; the batch, the tills' catalogue, the bills, the member and the consents
 * are real records. Through Chromium the owner:
 *   • starts a recall on batch B-77 and reads what head office did by itself — the tills' catalogue moved a version and
 *     refuses it, the owners were alerted;
 *   • traces B-77 forward to the bills, and a bill backward to its lot (the gap for a receipt with no supplier is shown);
 *   • opens the call list: "Data-law basis to be confirmed by your CA or lawyer.", the member by the name she gave at
 *     enrolment and the last four digits only, the lot and date, and a customer who said no to promotions — still on the
 *     list, noted "said no to promotions — safety call only";
 *   • switches recall SMS on in writing and tries to send — refused, because no SMS provider is connected (switched off);
 *   • reads the page in Tamil; after a RESTART of the API the recall is still there.
 * A store manager does not see the owner's SMS switch.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['recall', 'trace', 'e2e', 'key'].join('-').padEnd(48, '0');
const STORE = 'br-1';
const TODAY = new Date().toISOString().slice(0, 10);

interface Doc { querySelectorAll(s: string): { length: number } }
const rowsAtLeast = (page: Page, selector: string, n: number) =>
  page.waitForFunction(([s, k]) => (globalThis as unknown as { document: Doc }).document.querySelectorAll(s as string).length >= (k as number), [selector, n] as const, { timeout: 15_000 });

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('Recalls and trace on the production API, in a real browser', () => {
  let browser: Browser;
  let shop: InboxShop;
  let member = '';

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/recall-trace', html: 'recall-trace.html', dataGlobal: 'recallTraceData' },
      seed: async (cloud) => {
        const call = (path: string, body: unknown, key: string) => cloud.request({ method: 'POST', path, userId: OWNER, idempotencyKey: key, body });
        await ok(call('/v1/catalogue/tax-classes/04061000/rates/2017-07-01', { rateBps: 500 }, 'tax'), 'tax');
        await ok(call('/v1/catalogue/products/p-paneer/publish', { product: { sku: 'SKU-PANEER', name: 'Paneer 200g', baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '04061000', lifecycle: 'draft' }, categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }] }, 'prod'), 'product');
        await ok(call('/v1/prices/list/p-paneer/entries/e1', { scope: 'store', scopeRef: STORE, priceMinor: 9_000, mrpMinor: 9_500, costMinor: 1, marginFloorBps: 0, currency: 'INR', effectiveFrom: TODAY }, 'price'), 'price');
        await ok(call('/v1/catalogue/products/p-paneer/barcodes/8901000000011', { kind: 'ean' }, 'bc'), 'barcode');
        await ok(call('/v1/inventory/movements', { movementId: 'rx-B-77', productId: 'p-paneer', locationId: STORE, kind: 'received', quantityMinor: 20, uom: 'EA', occurredAt: '2026-10-01T09:00:00.000Z', enteredBy: OWNER, batchId: 'B-77' }, 'rx'), 'receive');
        await ok(call('/v1/catalogue/pack', { storeId: STORE }, 'pack-1'), 'pack v1');
        // OB-329: the member gives her name at the desk.
        const enrolled = await cloud.request({ method: 'POST', path: '/v1/loyalty/members', userId: OWNER, idempotencyKey: 'enrol', body: { mobile: '9876543210', consent: true, verifiedHow: 'seen_on_phone', name: 'Anitha Raman' } });
        if (enrolled.status !== 201) throw new Error(`enrol: ${enrolled.status} ${JSON.stringify(enrolled.body)}`);
        member = (enrolled.body as { memberRef: string }).memberRef;
        await ok(call(`/v1/customers/${member}/consent`, { purpose: 'transactional', channel: 'sms', given: true, evidence: 'said yes at the service desk' }, 'c1'), 'consent');
        await ok(call('/v1/customers/cust-X/consent', { purpose: 'marketing', channel: 'sms', given: false, evidence: 'asked for no offers at the desk' }, 'c2'), 'no promotions');
        const sale = (saleId: string, customerRef?: string) => ({
          saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', cashierId: OWNER, locationId: STORE, tradingDay: TODAY, committedAt: new Date().toISOString(),
          totalMinor: 9_000, currency: 'INR', packVersion: 1, ...(customerRef === undefined ? {} : { customerRef }),
          lines: [{ productId: 'p-paneer', quantityMinor: 1, uom: 'ea', unitPriceMinor: 9_000, lineTotalMinor: 9_000, batchId: 'B-77' }],
          tenders: [{ kind: 'cash', amountMinor: 9_000 }],
        });
        await ok(call('/v1/sales', sale('S-1', member), 's1'), 'sale S-1');
        await ok(call('/v1/sales', sale('S-2'), 's2'), 'sale S-2');
        await ok(call('/v1/sales', sale('S-3', 'cust-X'), 's3'), 'sale S-3');
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await shop?.stop();
  });

  it('the owner starts a recall, traces both ways, reads the call list, switches SMS — refused with no provider; Tamil; a restart keeps it', async () => {
    const context = await browser.newContext();
    await shop.signIn(context, OWNER);
    const page = await context.newPage();
    try {
      await page.goto(`${shop.base}/recall-trace`, { waitUntil: 'load' });
      await page.locator('#r-none').waitFor({ timeout: 15_000 });
      expect(await page.textContent('#r-none')).toBe('No recall has been started.');

      // ── start the recall ──
      await page.fill('#r-batch', 'B-77');
      await page.fill('#r-reason', 'supplier contamination notice SN-17');
      await page.click('#r-start');
      await page.locator('#result.tone-ok').waitFor({ timeout: 15_000 });
      const said = (await page.textContent('#result')) ?? '';
      expect(said).toMatch(/Recall started: B-77/);
      expect(said).toMatch(/The tills' catalogue v2 now refuses it, offline too\./);
      expect(said).toMatch(/The owners were alerted \(\d\)/);
      await rowsAtLeast(page, '#r-rows li', 1);
      expect(await page.textContent('#r-rows li')).toMatch(/B-77 — Open/);
      const pack = (await shop.cloud().request({ method: 'GET', path: '/v1/catalogue/pack', userId: OWNER })).body as { snapshot: { version: number; products: { productId: string; recallBlock?: boolean }[] } };
      expect(pack.snapshot.version).toBe(2);
      expect(pack.snapshot.products.find((p) => p.productId === 'p-paneer')?.recallBlock).toBe(true);

      // ── trace forward, then backward from a bill ──
      await page.click('#tab-trace');
      await page.selectOption('#t-kind', 'batch');
      await page.fill('#t-ref', 'B-77');
      await page.click('#t-run');
      await rowsAtLeast(page, '#t-rows tr', 4);
      expect(await page.textContent('#t-rows')).toContain('sale S-1');
      await page.selectOption('#t-kind', 'sale');
      await page.fill('#t-ref', 'S-1');
      await page.click('#t-run');
      await page.waitForFunction(() => ((globalThis as unknown as { document: { getElementById(i: string): { textContent: string | null } } }).document.getElementById('t-summary').textContent ?? '').startsWith('1 bill'), undefined, { timeout: 15_000 });
      expect(await page.textContent('#t-rows tr')).toContain('B-77');
      expect(await page.textContent('#t-gaps')).toMatch(/no goods-receipt note/);

      // ── the call list (OB-328 · OB-329) ──
      await page.click('#tab-calls');
      expect(await page.textContent('#c-basis')).toBe('Data-law basis to be confirmed by your CA or lawyer.');
      await page.fill('#c-batch', 'B-77');
      await page.click('#c-load');
      await rowsAtLeast(page, '#c-rows li', 2);
      const anitha = page.locator('#c-rows li', { hasText: 'Anitha Raman' });
      expect(await anitha.locator('.phone').textContent()).toBe('Phone ends: …3210');
      expect(await anitha.locator('.lot').first().textContent()).toBe(`Bought: lot B-77 · ${TODAY}`);
      const noOffers = page.locator('#c-rows li[data-customer="cust-X"]');
      expect(await noOffers.locator('.name').textContent()).toBe('Name not on record — ask at the desk');
      expect(await noOffers.locator('.note').allTextContents()).toContain('said no to promotions — safety call only');
      expect(await page.textContent('#c-summary')).toMatch(/2 customer\(s\) to call; 1 also said yes to service messages by SMS; 1 sale\(s\) named nobody/);
      expect(await page.content()).not.toContain('9876543210');

      // ── SMS: switched off; the owner switches it on in writing; still nothing is sent — no provider ──
      await page.click('#tab-messages');
      await page.waitForFunction(() => ((globalThis as unknown as { document: { getElementById(i: string): { textContent: string | null } } }).document.getElementById('m-state').textContent ?? '') !== '', undefined, { timeout: 15_000 });
      expect(await page.textContent('#m-state')).toBe('Recall SMS is OFF. Call the customers on the list. No SMS provider is connected, so nothing can be sent.');
      expect(await page.isVisible('#m-switch-box')).toBe(true);
      await page.fill('#m-reason', 'drill: switch on for the test');
      await page.click('#m-on');
      await page.waitForFunction(() => ((globalThis as unknown as { document: { getElementById(i: string): { textContent: string | null } } }).document.getElementById('m-state').textContent ?? '').startsWith('Recall SMS is ON'), undefined, { timeout: 15_000 });
      await page.fill('#m-batch', 'B-77');
      await page.fill('#m-text', 'SRE Hyper Market: the paneer you bought (lot B-77) is recalled. Please bring it back.');
      await page.click('#m-send');
      await page.locator('#result.tone-error').waitFor({ timeout: 15_000 });
      expect(await page.textContent('#result')).toMatch(/Not done: No message provider is connected/);

      // ── Tamil ──
      await page.click('#lang');
      expect(await page.textContent('#tab-calls')).toMatch(/^அழைப்புப் பட்டியல்/); // the chrome adds the tile's count after it
      await page.click('#tab-calls');
      expect(await page.textContent('#c-basis')).toBe('தரவுச் சட்ட அடிப்படையை உங்கள் பட்டயக் கணக்காளர் அல்லது வழக்கறிஞர் உறுதிப்படுத்த வேண்டும்.');
      expect(await page.locator('#c-rows li[data-customer="cust-X"] .note').first().textContent()).toBe('விளம்பரங்கள் வேண்டாம் என்றார் — பாதுகாப்பு அழைப்பு மட்டும்');
    } finally { await context.close(); }

    // ── a restart: the recall is what head office kept ──
    await shop.restart();
    const context2 = await browser.newContext();
    await shop.signIn(context2, OWNER);
    const page2 = await context2.newPage();
    try {
      await page2.goto(`${shop.base}/recall-trace`, { waitUntil: 'load' });
      await rowsAtLeast(page2, '#r-rows li', 1);
      expect(await page2.textContent('#r-rows li')).toMatch(/B-77 — Open/);
    } finally { await context2.close(); }
    expect(member).not.toBe('');
  }, 180_000);

  it('a store manager reads the call list but is not offered the owner\'s SMS switch', async () => {
    const context = await browser.newContext();
    await shop.signIn(context, MGR, 'br-1');
    const page = await context.newPage();
    try {
      await page.goto(`${shop.base}/recall-trace`, { waitUntil: 'load' });
      await page.click('#tab-messages');
      expect(await page.isVisible('#m-switch-box')).toBe(false);
      const switched = await shop.cloud().request({ method: 'POST', path: '/v1/quality/recall-notices/switch', userId: MGR, idempotencyKey: 'mgr-switch', body: { on: false, reason: 'not mine to switch' } });
      expect(switched.status).toBe(403);
    } finally { await context.close(); }
  }, 60_000);
});
