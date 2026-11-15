import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startOfficeShop, PEOPLE, type OfficeShop } from './lib/office-shop';
import { AccessControl } from '../../packages/rbac/src/rbac';
import { ERP_NAVIGATION, NAV_GROUP_LABELS, navigationFor } from '../../apps/web-erp/src/navigation';
import { ROLE_CATALOGUE } from '../../services/api/src/roles';

/**
 * **D-027 / D-007 — a short "daily work" menu per role, everything else under one closed "More" (owner, daily-work walk:
 * "the screens are too complicated"; P-07 usability by role; decided under OB-801 as a reversible UI choice).**
 *
 * In a real browser, on the real store computer fed by the real head office, for each product role:
 *   • the links a person sees WITHOUT opening "More" are their daily work only — ten or fewer, the expected ones, in order;
 *   • "More" stands closed, says "More" (Tamil: "மேலும்"), and every other screen the role may open is still in it —
 *     nothing removed, nothing added (the same list `navigationFor` derives from the permissions);
 *   • a permitted screen that is not daily work is reached by opening "More" and its workspace, and it opens;
 *   • the cashier's daily list holds Till, My tasks, My payslip, My self-service, Help — and no "Duplicates and merges".
 * Skips where no browser binary is present.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DESK = { viewport: { width: 1280, height: 860 } };

const WAREHOUSE = 'u-wh';
const RECEIVER = 'u-recv';
const BUYER = 'u-buy';
const BUY_APPROVER = 'u-buy-ok';

const shownLinks = (page: Page): Promise<string[]> =>
  page.$$eval('#sre-menu a', (els) => els.filter((e) => (e as unknown as { offsetParent: unknown }).offsetParent !== null).map((e) => (e.textContent ?? '').trim()));

/** Every screen this role may open on the box, as navigationFor derives it from the permissions alone. */
function permitted(roleId: string): { group: string; label: string; path: string }[] {
  const access = new AccessControl(ROLE_CATALOGUE as never, [{ userId: 'u', roleId, branchScope: 'all' }]);
  return navigationFor(access, { userId: 'u', branchId: 'S1', roleIds: [roleId] }, ERP_NAVIGATION.filter((i) => (i.served ?? 'box') === 'box'))
    .flatMap((g) => g.items.map((i) => ({ group: g.group, label: i.label, path: i.path })));
}

describe.skipIf(!existsSync(CHROMIUM))('D-027 / D-007: a short daily menu per role, the rest under "More"', () => {
  let browser: Browser;
  let shop: OfficeShop;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    shop = await startOfficeShop(browser, {
      seed: async (_ok, h, T) => {
        await h.provisionRole(T, WAREHOUSE, 'warehouse_user', ['S1']);
        await h.provisionRole(T, RECEIVER, 'receiver_qc', ['S1']);
        await h.provisionRole(T, BUYER, 'purchase_user', ['S1']);
        await h.provisionRole(T, BUY_APPROVER, 'purchase_approver', ['S1']);
      },
    });
  }, 300_000);
  afterAll(async () => { await shop?.stop(); await browser?.close(); });

  const open = async (who: string, path: string) => {
    const s = await shop.asPerson(who, DESK);
    await s.page.goto(`${shop.base}${path}`, { waitUntil: 'load' });
    await s.page.waitForFunction('globalThis.sreChrome !== undefined');
    return s;
  };

  // [person, role, a daily page to stand on, the daily list as the rail shows it]. The daily table can never widen what a
  // role opens: a listed job the role's permissions do not open is simply not drawn — the warehouse and receiver roles
  // hold no indent read (Floor indents), the purchase roles no bill match or goods-receipt read (Supplier bills, Goods
  // receipt review), the accountant no over/short review (Cash over / short).
  const ROLES: readonly (readonly [string, string, string, readonly string[]])[] = [
    [PEOPLE.cashier, 'cashier', '/my-tasks', ['Till', 'My tasks', 'My payslip', 'My self-service', 'Help and procedures']],
    [PEOPLE.manager, 'store_manager', '/approvals', ['Today', 'Approvals', 'Cash over / short', 'Products', 'Stock health', 'Expiry & recalls', 'Store tasks', 'Buying', 'Goods receipt review', 'Supplier bills']],
    [WAREHOUSE, 'warehouse_user', '/transfers', ['Warehouse handheld', 'Goods receipt review', 'Transfers', 'Stock ledger']],
    [RECEIVER, 'receiver_qc', '/goods-receipt', ['Warehouse handheld', 'Goods receipt review', 'Transfers', 'Stock ledger']],
    [BUYER, 'purchase_user', '/suppliers', ['Buying', 'Requisitions and quotes', 'Suppliers']],
    [BUY_APPROVER, 'purchase_approver', '/suppliers', ['Buying', 'Requisitions and quotes', 'Suppliers']],
    [PEOPLE.accountant, 'accountant', '/approvals', ['Supplier bills', 'Approvals', 'Day book', 'GST returns', 'Reports']],
    [PEOPLE.owner, 'owner', '/approvals', ['Today', 'Approvals', 'Morning brief', 'Reports', 'Price lists', 'Users & roles', 'Cash over / short']],
  ];

  for (const [who, roleId, where, daily] of ROLES) {
    it(`the ${roleId} sees only the daily work (≤ 10) until "More" is opened — and every other permitted screen is under "More"`, async () => {
      const { context, page, errors } = await open(who, where);
      try {
        const all = permitted(roleId);
        expect(daily.length).toBeLessThanOrEqual(10);
        // what stands on the rail before anything is opened: the daily list, nothing else
        const visible = await shownLinks(page);
        expect(visible.length).toBeLessThanOrEqual(10);
        expect(visible).toEqual([...daily]);
        // one closed "More"
        expect(await page.textContent('#sre-menu .sre-more-toggle')).toBe('More');
        expect(await page.getAttribute('#sre-menu .sre-more-toggle', 'aria-expanded')).toBe('false');
        // nothing removed: the rail still carries every screen the role may open, each once
        const everyLink = await page.$$eval('#sre-menu .group-section:not(.sre-quick) a', (els) => els.map((e) => (e.textContent ?? '').trim()));
        expect([...everyLink].sort()).toEqual(all.map((i) => i.label).sort());
        // a permitted screen that is not daily work: hidden until "More" and its workspace are opened, then it opens
        const other = all.find((i) => i.group !== 'Daily' && !daily.includes(i.label))!;
        expect(other).toBeDefined();
        const link = page.locator('#sre-menu .sre-more a', { hasText: other.label }).first();
        expect(await link.isVisible()).toBe(false);
        await page.click('#sre-menu .sre-more-toggle');
        expect(await page.getAttribute('#sre-menu .sre-more-toggle', 'aria-expanded')).toBe('true');
        const heading = page.locator(`#sre-menu .sre-more .group-section[data-key="${other.group}"] .group-toggle`);
        if ((await heading.getAttribute('aria-expanded')) !== 'true') await heading.click();
        expect(await link.isVisible()).toBe(true);
        const res = await page.goto(`${shop.base}${other.path}`, { waitUntil: 'load' });
        expect(res?.status(), `${other.path} as ${roleId}`).toBe(200);
        expect(errors).toEqual([]);
      } finally { await context.close(); }
    }, 90_000);
  }

  it('the cashier: no "Duplicates and merges" on the daily list (D-007), yet the screen the role opens is still under "More"', async () => {
    const { context, page } = await open(PEOPLE.cashier, '/my-tasks');
    try {
      const visible = await shownLinks(page);
      for (const no of ['Duplicates and merges', 'Category rules', 'App content', 'GST and cess rates', 'Picker handheld', 'Delivery handheld', 'Approvals']) expect(visible).not.toContain(no);
      expect(await page.locator('#sre-menu .sre-more a', { hasText: 'Duplicates and merges' }).count()).toBe(1);
      // the search still looks everywhere, "More" included, and opens what it finds
      await page.fill('#sre-find', 'duplicates');
      expect(await shownLinks(page)).toEqual(['Duplicates and merges']);
      await page.fill('#sre-find', '');
      expect(await shownLinks(page)).toEqual(['Till', 'My tasks', 'My payslip', 'My self-service', 'Help and procedures']);
      // in Tamil the two headings are Tamil words
      await page.click('#lang');
      await page.waitForFunction('document.documentElement.lang === "ta"');
      expect(await page.textContent('#sre-menu .sre-more-toggle')).toBe('மேலும்');
      expect((await page.textContent('#sre-menu .group-section[data-key="Daily"] .group-toggle'))?.trim()).toBe(NAV_GROUP_LABELS['Daily']!.ta);
    } finally { await context.close(); }
  }, 60_000);

  it('standing on a screen that lives under "More" opens "More" at that screen\'s workspace', async () => {
    const { context, page } = await open(PEOPLE.manager, '/customers');
    try {
      expect(await page.getAttribute('#sre-menu .sre-more-toggle', 'aria-expanded')).toBe('true');
      expect(await page.isVisible('#sre-menu a[aria-current="page"]')).toBe(true);
    } finally { await context.close(); }
  }, 60_000);
});
