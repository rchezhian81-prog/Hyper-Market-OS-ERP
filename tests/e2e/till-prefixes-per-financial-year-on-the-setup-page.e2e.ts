import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, type InboxShop } from './lib/ai-inbox-shop';
import { financialYearOf, nextFinancialYear } from '../../packages/contracts/src/receipt-number';

/**
 * **A2 — the owner issues each till a bill-number prefix FOR a financial year on the store-setup page, in a real browser,
 * on the PRODUCTION API over real PostgreSQL.** GST bill numbers start again every financial year, so:
 *
 *   • the page says so, and offers "every year", this year and next year when issuing;
 *   • the owner issues lane-1 a prefix for NEXT year only: the till is then year-scoped, and the page flags it as needing a
 *     prefix for THIS year (head office's `needsYearPrefix`), in words;
 *   • the owner gives it this year's prefix from that flagged row; asking for next year's prefix again for this year is
 *     refused in head office's own words (a prefix is never used in two years); both years' rows show their numbers;
 *   • the Tamil words show.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const SIGN = ['prefix', 'fy', 'e2e', 'signing', 'key'].join('-').padEnd(48, '0');
const B1 = 'br-1';
const THIS_YEAR = financialYearOf(new Date().toISOString())!;
const NEXT_YEAR = nextFinancialYear(THIS_YEAR);
type Doc = { document: { getElementById(i: string): { textContent: string | null } | null } };
interface TillView { tillId: string; prefix: string; financialYear?: string }

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('till prefixes per financial year on the setup page (A2)', () => {
  let browser: Browser;
  let shop: InboxShop;
  const tills = async (): Promise<TillView[]> => ((await shop.cloud().request({ method: 'GET', path: '/v1/receipt-prefixes', userId: OWNER })).body as { tills: TillView[] }).tills;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: SIGN,
      page: {
        path: '/setup', html: 'setup.html', dataGlobal: 'setupData',
        extraData: async (api) => {
          const s = await api('/v1/platform/setup') as { items?: unknown };
          const p = await api('/v1/receipt-prefixes') as { tills?: unknown };
          return { ...(Array.isArray(s.items) ? { status: s } : {}), ...(Array.isArray(p.tills) ? { receiptPrefixes: p } : {}) };
        },
      },
      seed: async (cloud) => {
        for (const [id, body] of [
          ['C1', { kind: 'company', name: 'SRE Retail' }],
          [B1, { kind: 'branch', name: 'Store One', parentId: 'C1', companyId: 'C1' }],
        ] as const) await ok(cloud.request({ method: 'POST', path: `/v1/org/nodes/${id}`, userId: OWNER, idempotencyKey: `org-${id}`, body }), `org ${id}`);
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 120_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  const open = async () => {
    const context = await browser.newContext();
    await shop.signIn(context, OWNER);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${shop.base}/setup`, { waitUntil: 'load' });
    await page.locator('#prefixes:not([hidden])').waitFor({ timeout: 15_000 });
    return { page, errors, close: () => context.close() };
  };
  const says = (page: Page, id: string, re: RegExp) => page.waitForFunction(([i, src]) => new RegExp(src!).test((globalThis as unknown as Doc).document.getElementById(i!)?.textContent ?? ''), [id, re.source], { timeout: 15_000 });

  it('next year first → this year flagged → issued from the flagged row; one prefix never two years; Tamil', async () => {
    const first = await open();
    try {
      await says(first.page, 'prefixes-years', /start again every financial year/);
      expect(await first.page.$$eval('#pn-year option', (o) => o.map((x) => (x as unknown as { value: string }).value))).toEqual(['', THIS_YEAR, NEXT_YEAR]);
      await first.page.locator('#pn-store').fill(B1);
      await first.page.locator('#pn-till').fill('lane-1');
      await first.page.locator('#pn-prefix').fill('S1N-');
      await first.page.selectOption('#pn-year', NEXT_YEAR);
      await first.page.locator('#pn-save').click();
      await first.page.locator(`[id="pr-${B1}__lane-1__${NEXT_YEAR}"]`).waitFor({ timeout: 15_000 });
      await says(first.page, `pv-${B1}__lane-1__${NEXT_YEAR}`, /S1N-000001 … S1N-999999/);
      expect(first.errors).toEqual([]);
    } finally { await first.close(); }

    const second = await open();
    try {
      // The till is year-scoped now and has no prefix for THIS year: flagged, said.
      const flagged = second.page.locator(`[id="pr-${B1}__lane-1__${THIS_YEAR}"]`);
      expect(await flagged.getAttribute('class')).toContain('flagged');
      expect(await flagged.textContent()).toContain(`has no bill-number prefix for ${THIS_YEAR}`);
      const input = second.page.locator(`[id="px-${B1}__lane-1__${THIS_YEAR}"]`);
      await input.fill('S1N-');
      await second.page.locator(`[id="pb-${B1}__lane-1__${THIS_YEAR}"]`).click();
      await says(second.page, `pm-${B1}__lane-1__${THIS_YEAR}`, /Head office refused: The prefix S1N- was this till's for/);
      await input.fill('S1T-');
      await second.page.locator(`[id="pb-${B1}__lane-1__${THIS_YEAR}"]`).click();
      await says(second.page, `pv-${B1}__lane-1__${THIS_YEAR}`, /S1T-000001/);
      expect(await second.page.locator(`[id="pr-${B1}__lane-1__${THIS_YEAR}"]`).getAttribute('class')).not.toContain('flagged');
      await second.page.click('#lang');
      await says(second.page, 'prefixes-years', /நிதியாண்டும்/);
      expect(second.errors).toEqual([]);
    } finally { await second.close(); }
    expect((await tills()).map((t) => [t.tillId, t.prefix, t.financialYear]).sort()).toEqual([['lane-1', 'S1N-', NEXT_YEAR], ['lane-1', 'S1T-', THIS_YEAR]]);
  }, 120_000);
});
