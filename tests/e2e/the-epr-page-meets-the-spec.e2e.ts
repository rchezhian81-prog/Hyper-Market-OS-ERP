import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';

/**
 * **R4 · B20 · B21 · B22 · OB-212 — the "EPR registers" page, in a real browser, on the PRODUCTION API over real
 * PostgreSQL.**
 *
 * Head office holds two own-brand products with their packaging, one with none, their receipts in 2030-31, a registered
 * and an unregistered recycler. Through Chromium the br-1 store manager: sees the registration and brand-owner answers
 * "Not confirmed"; picks 2030-31 and sees the plastic per category to the gram, the product with no declaration listed as
 * an exception (the totals incomplete) and the note that nothing is filed; downloads the CPCB file; records a used battery
 * brought back, which shows in the take-back location as not saleable; is refused handing it to the unregistered
 * recycler — in head office's words — and hands it to the registered one. The page speaks Tamil. A cashier, who may not
 * read the registers, is told they cannot be read.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['epr', 'page', 'e2e', 'key'].join('-').padEnd(48, '0');
const TILL = 'u-till-epr';

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('EPR registers (B20–B22 · OB-212) on the production API, in a real browser', () => {
  let browser: Browser;
  let shop: InboxShop;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/epr', html: 'epr.html', dataGlobal: 'eprData' },
      seed: async (cloud) => {
        const call = (path: string, body: unknown, who = OWNER) => ok(cloud.request({ method: 'POST', path, userId: who, idempotencyKey: `seed-${randomUUID()}`, body }), path);
        await cloud.grant(TILL, 'cashier');
        await call('/v1/compliance/epr/own-brand/P-JAR', { ownBrand: true, packaging: [{ category: 'I', weightPerUnitMg: 12_500 }, { category: 'II', weightPerUnitMg: 1_200 }] });
        await call('/v1/compliance/epr/own-brand/P-SACHET', { ownBrand: true, packaging: [{ category: 'II', weightPerUnitMg: 2_500 }] });
        await call('/v1/compliance/epr/own-brand/P-NODECL', { ownBrand: true });
        for (const [id, p, qty] of [['rx-1', 'P-JAR', 100], ['rx-2', 'P-SACHET', 1_000], ['rx-3', 'P-NODECL', 40]] as const) {
          await call('/v1/inventory/movements', { movementId: id, productId: p, locationId: 'br-1', kind: 'received', quantityMinor: qty, uom: 'EA', occurredAt: '2030-06-01T05:00:00.000Z', enteredBy: OWNER, unitCostMinor: 100 });
        }
        await call('/v1/compliance/epr/recyclers/r-ok', { name: 'Green Recyclers (test)', registrationNumber: 'TNPCB-EW-TEST-0001' });
        await call('/v1/compliance/epr/recyclers/r-none', { name: 'Street collector (test)' });
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 240_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  it('the manager sees the year\'s plastic per category with its exception, downloads the file, records a take-back and hands it only to a registered recycler', async () => {
    const context = await browser.newContext({ acceptDownloads: true });
    await shop.signIn(context, MGR, 'br-1');
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await page.goto(`${shop.base}/epr?fy=2030-31`, { waitUntil: 'load' });
      await page.locator('.panel[data-panel="I"]').waitFor({ timeout: 15_000 });

      // The answers the CA or consultant has not confirmed say so.
      expect(await page.locator('#settings .row').count()).toBe(4);
      expect(await page.locator('#settings .row[data-status="not_confirmed"]').count()).toBe(4);
      expect(await page.locator('#settings .row[data-key="plasticRegistration"] .state').textContent()).toContain('Not confirmed');

      // The year's plastic per category, to the gram; the missing declaration listed, never counted as zero.
      expect(await page.locator('.panel[data-panel="I"] .v').textContent()).toBe('1,250 g · 100 units');
      expect(await page.locator('.panel[data-panel="II"] .v').textContent()).toBe('2,620 g · 1100 units');
      expect(await page.locator('#plastic-exceptions .row[data-product="P-NODECL"]').count()).toBe(1);
      expect(await page.locator('#plastic-exceptions').textContent()).toContain('packaging declaration missing: P-NODECL');
      expect(await page.locator('#plastic-exceptions').textContent()).toContain('Incomplete');
      expect(await page.textContent('#filing')).toMatch(/^Nothing is filed automatically/);

      // The file for the CPCB portal.
      const [download] = await Promise.all([page.waitForEvent('download'), page.click('#csv')]);
      expect(download.suggestedFilename()).toBe('epr-plastic-2030-31.csv');
      const csv = await readFile((await download.path())!, 'utf8');
      expect(csv.split('\n')[0]).toBe('financial_year,category,product_id,plastic_per_unit_g,units_received,units_produced,units_put_on_market,plastic_g');
      expect(csv).toContain('2030-31,II,P-SACHET,2.500,1000,0,1000,2500.000');

      // Nothing held yet; a used battery is brought back.
      expect(await page.locator('#stock').textContent()).toContain('Nothing is held in the take-back location.');
      await page.selectOption('#tb-kind', 'battery');
      await page.fill('#tb-description', 'used inverter battery');
      await page.fill('#tb-weight', '1500');
      await page.fill('#tb-type', 'lead-acid');
      await page.click('#record-go');
      await page.locator('#stock .row[data-stock="battery:lead-acid"]').waitFor({ timeout: 15_000 });
      expect(await page.textContent('#result')).toBe('Recorded: used inverter battery — 1500 g');
      expect(await page.locator('#stock .row[data-stock="battery:lead-acid"] .state').textContent()).toContain('Not saleable');
      expect(await page.locator('#stock .row[data-stock="battery:lead-acid"]').getAttribute('data-on-hand')).toBe('1500');

      // To the unregistered recycler: refused, in head office's words. Nothing leaves.
      await page.selectOption('#ho-kind', 'battery');
      await page.selectOption('#ho-recycler', 'r-none');
      await page.fill('#ho-weight', '1500');
      await page.fill('#ho-type', 'lead-acid');
      await page.fill('#ho-note', 'HN-001');
      await page.click('#handover-go');
      await page.locator('#result.tone-error').waitFor({ timeout: 15_000 });
      expect(await page.textContent('#result')).toBe('Not recorded: recycler not registered: Street collector (test) has no registration number recorded');
      expect(await page.locator('#stock .row[data-stock="battery:lead-acid"]').getAttribute('data-on-hand')).toBe('1500');

      // To the registered recycler: recorded under its number; the take-back stock goes to nothing.
      await page.selectOption('#ho-recycler', 'r-ok');
      await page.click('#handover-go');
      await page.locator('#stock .row[data-stock="battery:lead-acid"][data-on-hand="0"]').waitFor({ timeout: 15_000 });
      expect(await page.textContent('#result')).toBe('Recorded: 1500 g → TNPCB-EW-TEST-0001');

      // Tamil words for the same page.
      await page.click('#lang');
      expect(await page.textContent('#title')).toBe('EPR பதிவேடுகள்');
      expect(await page.locator('#settings .row[data-key="plasticRegistration"] .state').textContent()).toContain('உறுதிசெய்யப்படவில்லை');
      expect(errors).toEqual([]);
    } finally { await context.close(); }

    // Head office holds the handover under the registered number.
    const view = (await shop.cloud().request({ method: 'GET', path: '/v1/compliance/epr/take-back', userId: OWNER })).body as { handovers: { recyclerId: string; registrationNumber: string }[] };
    expect(view.handovers).toEqual([expect.objectContaining({ recyclerId: 'r-ok', registrationNumber: 'TNPCB-EW-TEST-0001' })]);
  }, 180_000);

  it('a cashier may not read the registers — the page says they cannot be read', async () => {
    const context = await browser.newContext();
    await shop.signIn(context, TILL, 'br-1');
    const page = await context.newPage();
    try {
      await page.goto(`${shop.base}/epr?fy=2030-31`, { waitUntil: 'load' });
      await page.locator('#state:not([hidden])').waitFor({ timeout: 15_000 });
      expect(await page.textContent('#state')).toBe('The EPR registers could not be read from head office. Nothing here is current.');
      expect(await page.locator('#stock .row').count()).toBe(0);
    } finally { await context.close(); }
  }, 60_000);
});
