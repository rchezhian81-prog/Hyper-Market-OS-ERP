import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startInboxShop, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';

/**
 * U7 (OB-725) · the long lists are paged by head office. Twelve requisitions are on record; the Requisitions page's worklist
 * (the chrome's register, fed by a loader) asks head office for ONE page of ten at a time — "Showing 1–10 of 12" — turns to
 * the second page (two rows), and a search goes to head office, which answers the one match. On the PRODUCTION API over
 * real PostgreSQL, in a real browser. Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['u7', 'paged', 'e2e', 'key'].join('-').padEnd(48, '0');
const IDS = Array.from({ length: 12 }, (_, i) => `rq-${String(i + 1).padStart(2, '0')}`);

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the Requisitions worklist is paged by head office (U7), in a real browser', () => {
  let browser: Browser;
  let shop: InboxShop;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/requisitions', html: 'requisitions.html', dataGlobal: 'requisitionsData' },
      seed: async (cloud) => {
        for (const id of IDS) {
          const res = await cloud.request({ method: 'POST', path: `/v1/purchase/requisitions/${id}`, userId: OWNER, idempotencyKey: `raise-${id}`, body: { currency: 'INR', lines: [{ productId: 'dal', quantity: 2 }] } });
          if (res.status >= 300) throw new Error(`raise ${id}: ${res.status} ${JSON.stringify(res.body)}`);
        }
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    await shop?.stop();
  });

  it('shows one page of ten of head office\'s twelve, turns the page, and searches at head office', async () => {
    const context = await browser.newContext();
    const errors: string[] = [];
    const asked: string[] = [];
    try {
      await shop.signIn(context, MGR, 'br-1');
      const page = await context.newPage();
      page.on('pageerror', (e) => { errors.push(String(e)); });
      page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname === '/v1/purchase/requisitions') asked.push(u.search); });
      await page.goto(`${shop.base}/requisitions`, { waitUntil: 'load' });
      await expect.poll(() => page.textContent('#requisitions-count')).toBe('Showing 1–10 of 12');
      expect(await page.locator('#list tr[data-requisition]').count()).toBe(10);
      // Head office was asked for one page — never the whole list.
      expect(asked.every((q) => /[?&]page=\d+/.test(q) && /[?&]size=10\b/.test(q))).toBe(true);

      await page.click('#requisitions-next');
      await expect.poll(() => page.textContent('#requisitions-count')).toBe('Showing 11–12 of 12');
      expect(await page.locator('#list tr[data-requisition]').count()).toBe(2);
      expect(asked.some((q) => /[?&]page=2\b/.test(q))).toBe(true);

      await page.fill('#requisitions-search', 'rq-07');
      await expect.poll(() => page.textContent('#requisitions-count')).toBe('Showing 1–1 of 1');
      expect(await page.locator('#list tr[data-requisition]').evaluateAll((rs) => rs.map((r) => (r as unknown as { dataset: Record<string, string> }).dataset['requisition']))).toEqual(['rq-07']);
      expect(asked.some((q) => /[?&]search=rq-07\b/.test(q))).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
