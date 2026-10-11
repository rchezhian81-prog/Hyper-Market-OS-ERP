import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, OWNER, type InboxShop } from './lib/ai-inbox-shop';

/**
 * **Store setup (configuration), in a real browser, on the PRODUCTION API over real PostgreSQL (M01-FR-02/03 · EA-10's
 * M01 proof gap: "the org/config/branch FRs … in a browser").**
 *
 * The setup page is served in front of the real API; the setup status it is given is head office's own
 * `GET /v1/platform/setup` under the viewer's token, and every save goes to the real `PUT /v1/platform/setup/:key`
 * (durable settings table, versioned). Through Chromium:
 *
 *   • the owner changes the default GST rate and saves: the page says saved, and head office — read back directly, then
 *     after an API RESTART — holds the new value at version 1, no longer the default;
 *   • two owners' pages open at the same version: the second save is refused as a conflict (409) and the page says so
 *     and offers a reload — never a silent overwrite (hard rule #10); after reload the save goes through;
 *   • a cashier, who may not read setup, is given no setup status and sees no editable field.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const SIGN = ['setup', 'e2e', 'production', 'signing', 'key'].join('-').padEnd(48, '0');
const KEY = 'tax.default_bps';
const OWNER2 = 'u-owner-2'; const CASHIER = 'u-cash-setup';

interface Item { key: string; value: unknown; version: number; isDefault: boolean }

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('store setup on the production API, in a real browser (M01-FR-02/03)', () => {
  let browser: Browser;
  let shop: InboxShop;
  const itemOf = async (): Promise<Item> => ((await shop.cloud().request({ method: 'GET', path: '/v1/platform/setup', userId: OWNER })).body as { items: Item[] }).items.find((i) => i.key === KEY)!;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: SIGN,
      page: {
        path: '/setup', html: 'setup.html', dataGlobal: 'setupData',
        // What the store computer gives the setup screen: head office's setup status for THIS viewer (none if refused).
        extraData: async (api) => { const s = await api('/v1/platform/setup') as { items?: unknown }; return Array.isArray(s.items) ? { status: s } : {}; },
      },
      seed: async (cloud) => { await cloud.grant(OWNER2, 'owner'); await cloud.grant(CASHIER, 'cashier'); },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await shop?.stop();
  });

  const open = async (who: string) => {
    const context = await browser.newContext();
    await shop.signIn(context, who);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${shop.base}/setup`, { waitUntil: 'load' });
    return { page, errors, close: () => context.close() };
  };
  const field = (page: Page) => page.locator(`[id="f-${KEY}"]`);
  const message = (page: Page) => page.locator(`[id="m-${KEY}"]`);
  const save = (page: Page) => page.locator(`[id="s-${KEY}"]`);

  it('the owner saves a new default GST rate; head office holds it, versioned, and still holds it after a restart', async () => {
    const before = await itemOf();
    expect(before).toMatchObject({ isDefault: true, version: 0 });
    const { page, errors, close } = await open(OWNER);
    try {
      await field(page).waitFor({ timeout: 15_000 });
      expect(await page.locator('#sample').isHidden()).toBe(true);
      await field(page).fill('1800');
      await save(page).click();
      await page.waitForFunction((k) => /saved/i.test((globalThis as unknown as { document: { getElementById(i: string): { textContent: string | null } | null } }).document.getElementById(`m-${k}`)?.textContent ?? ''), KEY, { timeout: 15_000 });
      expect(errors).toEqual([]);
    } finally { await close(); }
    expect(await itemOf()).toMatchObject({ value: 1800, version: 1, isDefault: false });
    await shop.restart();
    expect(await itemOf()).toMatchObject({ value: 1800, version: 1, isDefault: false });
  }, 90_000);

  it('two pages at the same version: the second save is a conflict the page says, never a silent overwrite; after reload it goes', async () => {
    const a = await open(OWNER);
    const b = await open(OWNER2);
    try {
      await field(a.page).waitFor({ timeout: 15_000 });
      await field(b.page).waitFor({ timeout: 15_000 });
      await field(a.page).fill('1200');
      await save(a.page).click();
      await a.page.waitForFunction((k) => /saved/i.test((globalThis as unknown as { document: { getElementById(i: string): { textContent: string | null } | null } }).document.getElementById(`m-${k}`)?.textContent ?? ''), KEY, { timeout: 15_000 });
      expect(await itemOf()).toMatchObject({ value: 1200, version: 2 });

      // The second page still holds version 1: its save is refused as a conflict, and head office keeps the first.
      // (Round 8 found the page sending NO version — `{"value":500}` — so the server could not check it and this save
      // silently overwrote the first. The save must carry the version the page was shown.)
      const puts: { body: string | null; status?: number }[] = [];
      b.page.on('request', (r) => { if (r.method() === 'PUT') puts.push({ body: r.postData() }); });
      b.page.on('response', (r) => { if (r.request().method() === 'PUT') puts[puts.length - 1]!.status = r.status(); });
      await field(b.page).fill('500');
      await save(b.page).click();
      await b.page.locator(`[id="r-${KEY}"]:not([hidden])`).waitFor({ timeout: 15_000 });
      expect(puts).toEqual([{ body: JSON.stringify({ value: 500, ifVersion: 1 }), status: 409 }]);
      expect(await message(b.page).getAttribute('class')).toContain('bad');
      expect(await itemOf()).toMatchObject({ value: 1200, version: 2 });

      // Reload (re-read head office), then save again — now at the current version.
      await b.page.locator(`[id="r-${KEY}"]`).click();
      await b.page.waitForFunction((k) => ((globalThis as unknown as { document: { getElementById(i: string): { value?: string } | null } }).document.getElementById(`f-${k}`)?.value ?? '') === '1200', KEY, { timeout: 15_000 });
      await field(b.page).fill('500');
      await save(b.page).click();
      await b.page.waitForFunction((k) => /saved/i.test((globalThis as unknown as { document: { getElementById(i: string): { textContent: string | null } | null } }).document.getElementById(`m-${k}`)?.textContent ?? ''), KEY, { timeout: 15_000 });
      expect(await itemOf()).toMatchObject({ value: 500, version: 3 });
    } finally { await a.close(); await b.close(); }
  }, 90_000);

  it('a cashier is given no setup status and sees no editable field', async () => {
    expect((await shop.cloud().request({ method: 'GET', path: '/v1/platform/setup', userId: CASHIER })).status).toBe(403);
    const { page, close } = await open(CASHIER);
    try {
      await page.waitForLoadState('load');
      expect(await page.locator('#sample').isVisible()).toBe(true); // the clearly-marked stand-in, not head office's data
      expect(await field(page).count()).toBe(0);
    } finally { await close(); }
  }, 60_000);
});
