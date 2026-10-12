import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';
import { TEST_IDP } from '../support/api-harness';

/**
 * **OB-81 "A" — the owner issues each till its bill-number prefix on the store-setup page, in a real browser, on the
 * PRODUCTION API over real PostgreSQL.**
 *
 * The setup page is served in front of the real API; the prefix panel is given head office's own
 * `GET /v1/receipt-prefixes` under the viewer's token, and each issue goes to the real
 * `POST /v1/stores/:storeId/tills/:tillId/receipt-prefix`. Through Chromium:
 *
 *   • nothing is written by opening the page; the registered till with no prefix is FLAGGED (two stores);
 *   • a prefix past 10 characters or with a space is refused on the field, in head office's rule's words, and not sent;
 *   • the owner issues S1L1- to br-1's lane-1: the page shows the bill numbers it makes; head office holds version 1;
 *   • the owner asks for the same prefix for br-2's lane-1: head office's refusal is shown in its own words, nothing saved;
 *     then br-2's lane-1 gets S2L1-;
 *   • the store manager (no setup right) sees the prefixes read-only, only for their own store; a cashier sees no panel;
 *   • after an API RESTART head office still holds both, and the reopened page shows them; the Tamil heading shows.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const SIGN = ['prefix', 'e2e', 'production', 'signing', 'key'].join('-').padEnd(48, '0');
const CASHIER = 'u-cash-prefix';
const B1 = 'br-1'; const B2 = 'br-2';

interface TillView { storeId: string; tillId: string; prefix: string; version: number }
type Doc = { document: { getElementById(i: string): { textContent: string | null } | null } };

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('till bill-number prefixes on the setup page, production API, real browser (OB-81)', () => {
  let browser: Browser;
  let shop: InboxShop;
  const tills = async (): Promise<TillView[]> => ((await shop.cloud().request({ method: 'GET', path: '/v1/receipt-prefixes', userId: OWNER })).body as { tills: TillView[] }).tills;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: SIGN,
      page: {
        path: '/setup', html: 'setup.html', dataGlobal: 'setupData',
        // What the store computer gives the setup screen: head office's setup status and till prefixes for THIS viewer.
        extraData: async (api) => {
          const s = await api('/v1/platform/setup') as { items?: unknown };
          const p = await api('/v1/receipt-prefixes') as { tills?: unknown };
          return { ...(Array.isArray(s.items) ? { status: s } : {}), ...(Array.isArray(p.tills) ? { receiptPrefixes: p } : {}) };
        },
      },
      seed: async (cloud) => {
        await cloud.grant(CASHIER, 'cashier');
        for (const [id, body] of [
          ['C1', { kind: 'company', name: 'SRE Retail' }],
          [B1, { kind: 'branch', name: 'Store One', parentId: 'C1', companyId: 'C1' }],
          [B2, { kind: 'branch', name: 'Store Two', parentId: 'C1', companyId: 'C1' }],
        ] as const) await ok(cloud.request({ method: 'POST', path: `/v1/org/nodes/${id}`, userId: OWNER, idempotencyKey: `org-${id}`, body }), `org ${id}`);
        await ok(cloud.request({ method: 'POST', path: '/v1/platform/devices/lane-1/register', userId: OWNER, idempotencyKey: 'reg-lane-1', body: { branchId: B1, kind: 'pos_lane', label: 'Store One lane 1' } }), 'register lane-1');
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await shop?.stop();
  });

  const open = async (who: string, branch?: string) => {
    const context = await browser.newContext();
    await shop.signIn(context, who, branch);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${shop.base}/setup`, { waitUntil: 'load' });
    return { page, errors, close: () => context.close() };
  };
  const text = (page: Page, id: string) => page.evaluate((i) => (globalThis as unknown as Doc).document.getElementById(i)?.textContent ?? '', id);
  const says = (page: Page, id: string, re: RegExp) => page.waitForFunction(([i, src]) => new RegExp(src!).test((globalThis as unknown as Doc).document.getElementById(i!)?.textContent ?? ''), [id, re.source], { timeout: 15_000 });

  it('the owner: nothing written on open; the unissued till is flagged; a bad prefix is refused on the field; S1L1- is issued and head office holds it', async () => {
    expect(await tills()).toEqual([]);
    const { page, errors, close } = await open(OWNER);
    try {
      await page.locator('#prefixes:not([hidden])').waitFor({ timeout: 15_000 });
      expect(await tills()).toEqual([]); // opening wrote nothing
      expect(await text(page, 'prefixes-stores')).toMatch(/More than one store/);
      expect(await page.locator(`[id="pr-${B1}__lane-1"]`).getAttribute('class')).toContain('flagged');
      const input = page.locator(`[id="px-${B1}__lane-1"]`);
      const button = page.locator(`[id="pb-${B1}__lane-1"]`);
      await input.fill('S1 L1');
      await says(page, `pm-${B1}__lane-1`, /capital letters/);
      expect(await button.isDisabled()).toBe(true);
      await input.fill('S1LANE0001-');
      await says(page, `pm-${B1}__lane-1`, /at most 10/);
      expect(await button.isDisabled()).toBe(true);
      await input.fill('S1L1-');
      await says(page, `pm-${B1}__lane-1`, /S1L1-000001 … S1L1-999999/);
      await button.click();
      await says(page, `pv-${B1}__lane-1`, /S1L1-/);
      await says(page, `pm-${B1}__lane-1`, /Issued/);
      expect(errors).toEqual([]);
    } finally { await close(); }
    expect((await tills()).map((t) => [t.storeId, t.tillId, t.prefix, t.version])).toEqual([[B1, 'lane-1', 'S1L1-', 1]]);
  }, 90_000);

  it('the owner asks for S1L1- for Store Two\'s lane-1: head office\'s refusal is shown in its words, nothing saved; then S2L1- is issued', async () => {
    const { page, errors, close } = await open(OWNER);
    try {
      await page.locator('#prefixes-new:not([hidden])').waitFor({ timeout: 15_000 });
      await page.locator('#pn-store').fill(B2);
      await page.locator('#pn-till').fill('lane-1');
      await page.locator('#pn-prefix').fill('S1L1-');
      await page.locator('#pn-save').click();
      await says(page, 'pn-msg', /Head office refused: The prefix S1L1- was issued to till lane-1 at Store One/);
      expect((await tills()).filter((t) => t.storeId === B2)).toEqual([]);
      await page.locator('#pn-prefix').fill('S2L1-');
      await page.locator('#pn-save').click();
      await page.locator(`[id="pr-${B2}__lane-1"]`).waitFor({ timeout: 15_000 });
      await says(page, `pv-${B2}__lane-1`, /S2L1-000001 … S2L1-999999/);
      expect(errors).toEqual([]);
    } finally { await close(); }
    expect((await tills()).map((t) => [t.storeId, t.tillId, t.prefix])).toEqual([[B1, 'lane-1', 'S1L1-'], [B2, 'lane-1', 'S2L1-']]);
  }, 90_000);

  it('a store manager sees their own store\'s prefixes read-only; a cashier is given no panel; head office refuses either an issue', async () => {
    const mgr = await open(MGR, B1);
    try {
      await mgr.page.locator('#prefixes:not([hidden])').waitFor({ timeout: 15_000 });
      await says(mgr.page, `pv-${B1}__lane-1`, /S1L1-/);
      expect(await mgr.page.locator(`[id="pr-${B2}__lane-1"]`).count()).toBe(0); // another store's till is not theirs to see
      expect(await mgr.page.locator(`[id="px-${B1}__lane-1"]`).count()).toBe(0);
      expect(await mgr.page.locator('#prefixes-new').isHidden()).toBe(true);
      expect(mgr.errors).toEqual([]);
    } finally { await mgr.close(); }
    const cash = await open(CASHIER);
    try {
      await cash.page.waitForLoadState('load');
      expect(await cash.page.locator('#prefixes').isHidden()).toBe(true);
    } finally { await cash.close(); }
    // Head office refuses an issue from either, whatever a page shows: the manager signed in at their own store, the cashier.
    for (const who of [MGR, CASHIER]) {
      const token = TEST_IDP.issue({ sub: who, tenantId: shop.cloud().tenantId, branchId: B1 });
      const r = await fetch(`${shop.cloud().baseUrl}/v1/stores/${B1}/tills/lane-1/receipt-prefix`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': `k-${randomUUID()}` }, body: JSON.stringify({ prefix: 'S1Z1-' }),
      });
      expect(r.status, who).toBe(403);
      expect(((await r.json()) as { error: { whatHappened: string } }).error.whatHappened).toMatch(/platform\.setup\.write/);
    }
    expect((await tills()).find((t) => t.storeId === B1)?.prefix).toBe('S1L1-');
  }, 90_000);

  it('after an API restart head office still holds both prefixes, the page shows them, and the Tamil heading shows', async () => {
    await shop.restart();
    expect((await tills()).map((t) => [t.storeId, t.tillId, t.prefix, t.version])).toEqual([[B1, 'lane-1', 'S1L1-', 1], [B2, 'lane-1', 'S2L1-', 1]]);
    const { page, errors, close } = await open(OWNER);
    try {
      await says(page, `pv-${B2}__lane-1`, /S2L1-/);
      await page.click('#lang');
      await says(page, 'prefixes-title', /கவுண்டர் பில் எண் முன்னொட்டுகள்/);
      expect(errors).toEqual([]);
    } finally { await close(); }
  }, 90_000);
});
