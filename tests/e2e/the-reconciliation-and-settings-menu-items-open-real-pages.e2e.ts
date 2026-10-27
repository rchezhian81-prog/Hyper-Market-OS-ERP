import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startScreenServer, SCREEN_HOST, type ScreenServer } from '../../edge/store-edge/src/screen-server';
import type { ScreenInput } from '../../edge/store-edge/src/screen-data';
import { readPack } from '../../edge/store-edge/src/store-pack';
import { SyncOutbox } from '../../packages/sync/src/index';
import { ERP_NAVIGATION } from '../../apps/web-erp/src/navigation';

/**
 * **OB-401 (owner, 27 Oct 2026): the "Reconciliation" and "Settings" menu items open pages that already exist — no dead
 * link (re-audit final, T4).** Until now both were catalogue placeholders the store computer never drew. Now, in real
 * Chromium on the store computer's own screen server, a person who may open them sees both on the rail; Reconciliation
 * opens the Month-end checks on their card-and-UPI section (the payments a day close carried with no answer), and
 * Settings opens Store setup. The rail marks the item that was used — only that one — and the words are read only once
 * the page has said them (never in the same tick as the click).
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const NOW = '2026-10-27T06:00:00.000Z';
const PEOPLE = {
  roles: [{ id: 'owner', name: 'Owner', permissions: [...new Set(ERP_NAVIGATION.map((i) => i.requires))] }],
  roleAssignments: [{ userId: 'u-owner', roleId: 'owner', branchScope: 'all' }],
};
const snapshot = (): ScreenInput => ({
  pack: readPack({ version: 1, lossPreventionRules: [], policies: { tradingDayCutoff: '00:00', storeId: 'S1', branchId: 'S1' }, ...PEOPLE }, NOW),
  sales: [], unreadableRecords: 0, outbox: new SyncOutbox(), now: NOW, tradingDay: '2026-10-27',
}) as unknown as ScreenInput;
/** In the page: the rail has marked the item for the screen being shown (wait for it before reading). */
const MARKED = `document.querySelectorAll('#sre-menu a[aria-current="page"]').length > 0`;

describe.skipIf(!HAVE_BROWSER)('OB-401: Reconciliation and Settings on the rail open real pages on the store computer', () => {
  let browser: Browser;
  let server: ScreenServer;
  let base: string;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    server = await startScreenServer({ port: 0, appsDir: 'apps', snapshot, trustForwardedUser: true });
    base = `http://${SCREEN_HOST}:${server.port}`;
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 60_000);
  afterAll(async () => { await browser?.close(); await server?.stop(); });

  const current = (page: Page) => page.$$eval('#sre-menu a[aria-current="page"]', (as) => as.map((a) => (a.textContent ?? '').trim()));
  const menuLink = (page: Page, words: string) => page.locator('#sre-menu a', { hasText: words }).first();

  it('Reconciliation opens Month-end on its payments section, and is the one item marked; Settings opens Store setup', async () => {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 800 }, extraHTTPHeaders: { 'x-sre-user': 'u-owner' } });
    try {
      const page = await context.newPage();
      await page.goto(`${base}/manager/`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#sre-menu a', { timeout: 15_000 });
      // Both items are on the rail now (the box never drew a placeholder).
      const words = await page.$$eval('#sre-menu a', (as) => as.map((a) => (a.textContent ?? '').trim()));
      expect(words).toEqual(expect.arrayContaining(['Reconciliation', 'Month-end', 'Settings', 'Store setup']));

      await menuLink(page, 'Reconciliation').click();
      await page.waitForURL(/\/finance-close\/\?tab=payments$/, { timeout: 15_000 });
      await page.waitForFunction(`document.title === 'SRE Month-end' && ${MARKED}`, undefined, { timeout: 15_000 });
      expect(await page.getAttribute('#tab-payments', 'aria-current')).toBe('page');
      expect(await page.evaluate('document.getElementById("view-payments").hidden')).toBe(false);
      expect(await current(page)).toEqual(['Reconciliation']);

      await menuLink(page, 'Settings').click();
      await page.waitForURL(/\/setup\/\?tab=settings$/, { timeout: 15_000 });
      await page.waitForFunction(`document.title === 'SRE Store setup' && ${MARKED}`, undefined, { timeout: 15_000 });
      expect(await current(page)).toEqual(['Settings']);

      // Reached by its own item, each page marks only that item.
      await page.goto(`${base}/setup/`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(MARKED, undefined, { timeout: 15_000 });
      expect(await current(page)).toEqual(['Store setup']);
      await page.goto(`${base}/finance-close/`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(MARKED, undefined, { timeout: 15_000 });
      expect(await current(page)).toEqual(['Month-end']);
    } finally {
      await context.close();
    }
  }, 90_000);

  it('in Tamil the two items carry their Tamil words, beside their icons', async () => {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 800 }, extraHTTPHeaders: { 'x-sre-user': 'u-owner' } });
    try {
      const page = await context.newPage();
      await page.goto(`${base}/finance-close/?tab=payments`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#sre-menu a', { timeout: 15_000 });
      await page.click('#lang');
      await page.waitForFunction(`[...document.querySelectorAll('#sre-menu a')].some((a) => (a.textContent || '').includes('சரிக்கட்டல்'))`, undefined, { timeout: 15_000 });
      const ta = await page.$$eval('#sre-menu a', (as) => as.map((a) => ({ words: (a.textContent ?? '').trim(), icon: a.querySelector('svg') !== null })));
      expect(ta.find((x) => x.words === 'சரிக்கட்டல்')).toMatchObject({ icon: true });
      expect(ta.find((x) => x.words === 'அமைப்புகள்')).toMatchObject({ icon: true });
    } finally {
      await context.close();
    }
  }, 60_000);
});
