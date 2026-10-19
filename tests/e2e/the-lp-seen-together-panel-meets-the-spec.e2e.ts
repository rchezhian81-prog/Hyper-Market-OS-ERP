import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';

/**
 * D-21 (R4, OB-217) — the "Seen together" panel on the Investigations page, in a real browser, on the PRODUCTION API over
 * real PostgreSQL. Ghee had a void and a price override at the till (relayed by the store box), a damaged-pack write-off and
 * a count that came up short. The owner looks at ghee for the period: the three kinds of fact are listed side by side and a
 * case is PROPOSED — the open list stays empty until the owner clicks "Open this case", naming the investigator. A CCTV clip
 * is then recorded as camera + time from–to + who collected it; the page has no place for video. Opening the page writes
 * nothing; the only writes are those two clicks.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['lp', 'together', 'e2e', 'key'].join('-').padEnd(48, '0');
const shopDay = (ms: number) => new Date(ms + 330 * 60_000).toISOString().slice(0, 10);

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the "Seen together" panel (D-21) on the production API, in a real browser', () => {
  let browser: Browser;
  let shop: InboxShop;
  const now = Date.now();
  const today = shopDay(now);

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/loss-prevention', html: 'loss-prevention.html', dataGlobal: 'lossPreventionInboxData' },
      seed: async (cloud) => {
        await cloud.grant('u-box', 'store_computer', undefined, ['br-1']);
        const post = (path: string, body: unknown, key: string, userId = OWNER, branchId?: string) => ok(cloud.request({ method: 'POST', path, userId, idempotencyKey: key, body, ...(branchId === undefined ? {} : { branchId }) }), key);
        await post('/v1/inventory/movements', { movementId: 'rx-ghee', productId: 'p-ghee', locationId: 'br-1', kind: 'received', quantityMinor: 10, uom: 'ea', occurredAt: new Date(now - 10 * 86_400_000).toISOString(), enteredBy: OWNER, unitCostMinor: 5_000 }, 'rx');
        const base = { laneId: 'lane-1', cashierId: 'u-ravi', at: new Date(now).toISOString(), tradingDay: today, storeId: 'br-1' };
        await post('/v1/loss-prevention/activity/V-1/synced', { ...base, activityId: 'V-1', kind: 'void', billRef: 'B-1', lineId: 'L1', productId: 'p-ghee', description: 'Ghee 1L', valueMinor: 64_000, reason: 'customer_changed_mind' }, 'void', 'u-box', 'br-1');
        await post('/v1/loss-prevention/activity/O-1/synced', { ...base, activityId: 'O-1', kind: 'price_override', billRef: 'B-2', lineId: 'L1', productId: 'p-ghee', description: 'Ghee 1L', fromUnitMinor: 64_000, toUnitMinor: 50_000, quantityMinor: 1, valueMinor: 14_000, reason: 'damaged_pack', approvedBy: MGR, approvalId: 'apr-O-1' }, 'override', 'u-box', 'br-1');
        await post('/v1/inventory/write-off/W-1', { productId: 'p-ghee', locationId: 'br-1', qty: 1, uom: 'ea', lossType: 'damage', reasonCode: 'damage' }, 'W-1');
        await post('/v1/inventory/counts/C-1', { productId: 'p-ghee', locationId: 'br-1', uom: 'ea', countedMinor: 7, reasonCode: 'cycle_count' }, 'C-1');
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    await shop?.stop();
  });

  it('the facts side by side, a proposed case a person opens, a CCTV reference with no video', async () => {
    const context = await browser.newContext();
    const errors: string[] = [];
    const writes: string[] = [];
    try {
      await shop.signIn(context, OWNER);
      const page = await context.newPage();
      page.on('pageerror', (e) => { errors.push(String(e)); });
      page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${u.pathname}`); });
      await page.goto(`${shop.base}/loss-prevention`, { waitUntil: 'load' });
      await page.locator('#together:not([hidden])').waitFor({ timeout: 15_000 });
      expect(await page.locator('#together input[type="file"]').count()).toBe(0); // no place for video

      await page.selectOption('#together-kind', 'product');
      await page.fill('#together-id', 'p-ghee');
      await page.fill('#together-from', shopDay(now - 3 * 86_400_000));
      await page.fill('#together-to', shopDay(now + 86_400_000));
      await page.click('#together-show');
      await page.locator('#together-result:not([hidden])').waitFor({ timeout: 15_000 });
      expect(await page.locator('#till-rows li[data-kind="void"]').count()).toBe(1);
      expect(await page.locator('#till-rows li[data-kind="price_override"]').count()).toBe(1);
      expect(await page.textContent('#shrink-rows li[data-ref="write-off:W-1"]')).toMatch(/p-ghee · damage \(damage\) · 1 · ₹50\.00/);
      expect(await page.getAttribute('#count-rows li[data-ref="count:C-1"]', 'data-variance')).toBe('-2');
      expect(await page.getAttribute('#proposal', 'data-propose')).toBe('true');
      expect(await page.textContent('#proposal')).toMatch(/^A case is proposed: Seen together: .*no finding about anyone/);
      expect(writes, 'nothing is written by looking').toEqual([]);
      expect(((await shop.cloud().request({ method: 'GET', path: '/v1/loss-prevention/cases', userId: OWNER })).body as { openCount: number }).openCount).toBe(0);

      await page.fill('#open-case-id', 'case-ghee');
      await page.fill('#open-assignee', MGR);
      await page.click('#open-case');
      await expect.poll(() => page.textContent('#together-status')).toMatch(/Case opened/);
      expect(((await shop.cloud().request({ method: 'GET', path: '/v1/loss-prevention/cases', userId: OWNER })).body as { openCount: number }).openCount).toBe(1);

      expect(await page.inputValue('#cctv-case')).toBe('case-ghee');
      await page.fill('#cctv-camera', 'CAM-3');
      await page.fill('#cctv-from', new Date(now - 3_600_000 + 330 * 60_000).toISOString().slice(0, 16));
      await page.fill('#cctv-to', new Date(now - 3_000_000 + 330 * 60_000).toISOString().slice(0, 16));
      await page.fill('#cctv-by', MGR);
      await page.click('#cctv-add');
      await expect.poll(() => page.textContent('#cctv-status')).toMatch(/CCTV reference recorded on the case\. No video is kept\./);
      const c = (await shop.cloud().request({ method: 'GET', path: '/v1/loss-prevention/cases/case-ghee', userId: OWNER })).body as { evidence: { kind: string; ref: string }[] };
      expect(c.evidence).toEqual([expect.objectContaining({ kind: 'cctv_reference', ref: expect.stringMatching(/^cctv:camera=CAM-3;from=.*;to=.*$/) })]);
      expect(writes.map((w) => w.replace(/cctv\/[^/]+$/, 'cctv/:id'))).toEqual(['POST /v1/loss-prevention/cases/case-ghee', 'POST /v1/loss-prevention/cases/case-ghee/cctv/:id']);

      await page.click('#lang');
      expect(await page.textContent('#together-heading')).toBe('ஒன்றாகக் காணப்பட்டவை');
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, 180_000);
});
