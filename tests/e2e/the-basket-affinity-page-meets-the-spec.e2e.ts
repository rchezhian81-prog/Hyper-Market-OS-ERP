import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startInboxShop, ok, OWNER, type InboxShop } from './lib/ai-inbox-shop';

/**
 * D-23 (R4, signed OB-227) — the Bought together page, in a real browser, on the PRODUCTION API over real PostgreSQL:
 * "From banked sales for a period and department, the system lists product pairs bought together more often than chance,
 * each with its basket count, support, confidence and lift. Pairs seen in fewer than the minimum number of baskets are not
 * shown. Returns are taken out of the baskets they came from. Suggestions (place side by side, bundle, promotion) are
 * drafts; a promotion made from one goes through the existing promotion approval."
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['affinity', 'e2e', 'key'].join('-').padEnd(48, '0');
const DAY = '2026-09-10';

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the Bought together page (D-23) on the production API, in a real browser', () => {
  let browser: Browser;
  let shop: InboxShop;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/basket-affinity', html: 'basket-affinity.html', dataGlobal: 'basketAffinityData' },
      seed: async (cloud) => {
        const post = (path: string, body: unknown, key: string) => ok(cloud.request({ method: 'POST', path, userId: OWNER, idempotencyKey: key, body }), key);
        let n = 0;
        const bill = async (products: readonly string[]) => {
          n += 1;
          await post('/v1/sales', {
            saleId: `S-${n}`, receiptNumber: `R-${n}`, laneId: 'lane-1', locationId: 'br-1', cashierId: OWNER, tradingDay: DAY, committedAt: `${DAY}T06:${String(n).padStart(2, '0')}:00.000Z`,
            totalMinor: products.length * 1_000, currency: 'INR', packVersion: 1,
            lines: products.map((p) => ({ productId: p, quantityMinor: 1, uom: 'ea', unitPriceMinor: 1_000, lineTotalMinor: 1_000 })), tenders: [{ kind: 'cash', amountMinor: products.length * 1_000 }],
          }, `sale-${n}`);
        };
        for (let i = 0; i < 4; i += 1) await bill(['p-tea', 'p-biscuit']);
        await bill(['p-tea', 'p-milk']);
        for (let i = 0; i < 2; i += 1) await bill(['p-tea', 'p-soap']);
        for (let i = 0; i < 3; i += 1) await bill(['p-milk']);
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    await shop?.stop();
  });

  it('no minimum is invented → the pairs with their figures → below the minimum is counted, not shown → a draft promotion that is not live', async () => {
    const context = await browser.newContext();
    const errors: string[] = [];
    try {
      await shop.signIn(context, OWNER);
      const page = await context.newPage();
      page.on('pageerror', (e) => { errors.push(String(e)); });
      await page.goto(`${shop.base}/basket-affinity`, { waitUntil: 'load' });
      await page.waitForFunction(() => (globalThis as unknown as { basketAffinity?: unknown }).basketAffinity !== undefined);
      expect(await page.isHidden('#pairs-section')).toBe(true); // nothing read or written on open

      await page.fill('#from', DAY);
      await page.fill('#to', DAY);
      await page.click('#show');
      await expect.poll(() => page.textContent('#page-status')).toMatch(/There is no default/);

      await page.fill('#min', '3');
      await page.click('#show');
      await page.locator('#pairs li[data-pair="p-biscuit+p-tea"]').waitFor({ timeout: 15_000 });
      // 10 bills; tea in 7, biscuit in 4, both in 4 → support 40%, confidence 100% / 57.1%, lift 4·10/(4·7) = 1.4286.
      const facts = await page.textContent('#pairs li[data-pair="p-biscuit+p-tea"] .facts');
      expect(facts).toMatch(/4 baskets · support 40\.0% · confidence p-biscuit→p-tea 100\.0%, p-tea→p-biscuit 57\.1% · lift 1\.4286/);
      expect(await page.locator('#pairs li[data-pair]').count()).toBe(1);
      expect(await page.textContent('#totals .panel[data-total="belowMinimum"] .v')).toBe('1'); // tea+soap: 2 baskets
      expect(await page.textContent('#totals .panel[data-total="counted"] .v')).toBe('10');
      expect(await page.textContent('#suggestions-note')).toMatch(/Draft suggestions: place side by side · bundle · promotion/);

      // A draft promotion: on the existing route, NOT live until the launch approval.
      await page.fill('#pairs li[data-pair="p-biscuit+p-tea"] input.percent', '5');
      await page.fill('#pairs li[data-pair="p-biscuit+p-tea"] input.starts', '2026-11-01');
      await page.fill('#pairs li[data-pair="p-biscuit+p-tea"] input.ends', '2026-11-30');
      await page.click('#pairs li[data-pair="p-biscuit+p-tea"] button.draft-promo');
      await expect.poll(() => page.textContent('#promo-status')).toMatch(/it is NOT live/);
      const id = /\((aff-[A-Za-z0-9]+)\)/.exec((await page.textContent('#promo-status')) ?? '')![1]!;
      const promo = (await shop.cloud().request({ method: 'GET', path: `/v1/promotions/${id}/definition`, userId: OWNER })).body as { status: string; productIds: string[]; percentBps: number };
      expect([promo.status, promo.productIds, promo.percentBps]).toEqual(['draft', ['p-biscuit', 'p-tea'], 500]);
      expect(((await shop.cloud().request({ method: 'POST', path: `/v1/promotions/${id}/activate`, userId: OWNER, idempotencyKey: 'act', body: {} })).body as { error: { code: string } }).error.code).toBe('promotion_not_launched');

      await page.click('#lang');
      expect(await page.textContent('#page-h')).toBe('சேர்ந்து வாங்கப்பட்டவை');
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, 180_000);
});
