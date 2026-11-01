import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { auditPage } from './lib/a11y-audit';
import { startOfficeShop, PEOPLE, CUSTOMER_REFS, type OfficeShop } from './lib/office-shop';
import { AccessControl } from '../../packages/rbac/src/rbac';
import { ERP_NAVIGATION, NAV_GROUP_LABELS, navigationFor } from '../../apps/web-erp/src/navigation';
import { ROLE_CATALOGUE } from '../../services/api/src/roles';

/**
 * **W1 — the office shell, in a real browser, on the REAL store computer fed by the REAL head office (owner, 1 Nov 2026:
 * "the UI is very poor … things are hard to find"; P-07 usability by role; P-08 no silent failure).**
 *
 *   • the menu, per role — cashier, store manager, owner, accountant, each holding the product's own role — shows exactly
 *     the screens that role's permissions open, in the new task workspaces, the role's daily work first; a screen it may
 *     not open is neither in the menu nor served (403);
 *   • the screen search finds a page by a plain word ("salary", "cash", a Tamil word) and Enter opens it;
 *   • a long menu stands as a dozen headings (only the daily work and the current workspace open), a heading opens its
 *     screens and the browser remembers it; a pinned page and a recently opened one sit at the top;
 *   • the Customers register searches, filters, sorts and pages 24 customers who really bought, and opens a record drawer;
 *   • an empty list says "nothing yet", never "all clear"; a role that may not read says so;
 *   • the audit (contrast, 44px targets, names, labels, no sideways scroll) is clean at 1280px and at tablet width.
 * Skips where no browser binary is present.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DESK = { viewport: { width: 1280, height: 860 } };
const TABLET = { viewport: { width: 820, height: 1100 } };

const texts = (page: Page, selector: string): Promise<string[]> =>
  page.$$eval(selector, (els) => els.map((e) => (e.textContent ?? '').trim()));
const shown = (page: Page, selector: string): Promise<string[]> =>
  page.$$eval(selector, (els) => els.filter((e) => (e as unknown as { offsetParent: unknown }).offsetParent !== null).map((e) => (e.textContent ?? '').trim()));

/** What the menu must be for this product role: its daily group, then its workspaces — straight from navigationFor. */
function expectedMenu(roleId: string): { group: string; items: string[] }[] {
  const access = new AccessControl(ROLE_CATALOGUE as never, [{ userId: 'u', roleId, branchScope: 'all' }]);
  return navigationFor(access, { userId: 'u', branchId: 'S1', roleIds: [roleId] }, ERP_NAVIGATION.filter((i) => (i.served ?? 'box') === 'box'))
    .map((g) => ({ group: NAV_GROUP_LABELS[g.group]!.en, items: g.items.map((i) => i.label) }));
}

describe.skipIf(!existsSync(CHROMIUM))('W1: the office shell finds pages and shows real registers', () => {
  let browser: Browser;
  let shop: OfficeShop;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    shop = await startOfficeShop(browser);
  }, 300_000);
  afterAll(async () => { await shop?.stop(); await browser?.close(); });

  const open = async (who: string, path: string, device = DESK) => {
    const s = await shop.asPerson(who, device);
    await s.page.goto(`${shop.base}${path}`, { waitUntil: 'load' });
    await s.page.waitForFunction('globalThis.sreChrome !== undefined && globalThis.sreOffice !== undefined');
    return s;
  };

  for (const [who, roleId, daily] of [
    [PEOPLE.cashier, 'cashier', ['Till', 'My tasks', 'Approvals', 'My payslip', 'Help and procedures']],
    [PEOPLE.manager, 'store_manager', ['Today', 'Approvals', 'Cash over / short', 'Goods receipt review', 'Stock health', 'Expiry & recalls', 'Store tasks']],
    [PEOPLE.owner, 'owner', ['Today', 'Approvals', 'Morning brief', 'Company report', 'Owner alerts and schedules', 'Month-end']],
    [PEOPLE.accountant, 'accountant', ['Day book', 'Month-end', 'Supplier bills', 'GST returns', 'Input tax credit (GSTR-2B)', 'Approvals']],
  ] as const) {
    it(`the ${roleId}'s menu: exactly the screens the role opens, in the task workspaces, the daily work first`, async () => {
      const { context, page, errors } = await open(who, '/approvals');
      try {
        const want = expectedMenu(roleId);
        expect(want[0]!.group).toBe('Your daily work');
        expect(want[0]!.items).toEqual([...daily]);
        const got = await page.$$eval('#sre-menu .group-section:not(.sre-quick)', (sections) => sections.map((s) => ({
          group: (s.querySelector('.group')?.textContent ?? '').trim(),
          items: [...s.querySelectorAll('a')].map((a) => (a.textContent ?? '').trim()),
        })));
        expect(got).toEqual(want);
        // the daily work stands open; the Approvals page is the current one, marked once
        expect(await page.getAttribute('#sre-menu .group-section[data-key="Daily"] .group-toggle', 'aria-expanded')).toBe('true');
        expect(await texts(page, '#sre-menu a[aria-current="page"]')).toEqual(['Approvals']);
        expect(await page.textContent('#sre-crumbs')).toBe('Workspace › Your daily work › Approvals');
        expect(errors).toEqual([]);
      } finally { await context.close(); }
    }, 60_000);
  }

  it('a screen the role may not open is neither offered nor served: the cashier has no Month-end, and the box refuses it', async () => {
    const { context, page } = await open(PEOPLE.cashier, '/approvals');
    try {
      const all = await texts(page, '#sre-menu a');
      for (const no of ['Month-end', 'Day book', 'Customers', 'Reports', 'Users & roles']) expect(all).not.toContain(no);
      const res = await page.goto(`${shop.base}/finance-close`, { waitUntil: 'load' });
      expect(res?.status()).toBe(403);
    } finally { await context.close(); }
  }, 60_000);

  it('the search finds a page by a plain word, in English or Tamil, and Enter opens it', async () => {
    const { context, page } = await open(PEOPLE.manager, '/approvals');
    try {
      await page.fill('#sre-find', 'salary'); // the manager has My payslip (their own), never Payroll
      expect(await shown(page, '#sre-menu li:not([hidden]) a')).toEqual(['My payslip']);
      expect(await page.textContent('#sre-find-count')).toBe('1 screen matches');
      await page.fill('#sre-find', 'shortage');
      expect(await shown(page, '#sre-menu li:not([hidden]) a')).toEqual(['Cash over / short']);
      await page.fill('#sre-find', 'expiry');
      expect(await shown(page, '#sre-menu li:not([hidden]) a')).toEqual(expect.arrayContaining(['Expiry & recalls']));
      await page.fill('#sre-find', 'காலாவதி'); // "expiry" in Tamil
      expect(await shown(page, '#sre-menu li:not([hidden]) a')).toContain('Expiry & recalls');
      await page.fill('#sre-find', 'gst return');
      expect(await shown(page, '#sre-menu li:not([hidden]) a')).toEqual(['GST returns']);
      await page.fill('#sre-find', 'zzzz');
      expect(await page.textContent('#sre-find-none')).toBe('No screen matches');
      await page.fill('#sre-find', 'members'); // a plain word for the customer list
      expect(await shown(page, '#sre-menu li:not([hidden]) a')).toEqual(['Customers']);
      await Promise.all([page.waitForURL(/\/customers\/?$/), page.press('#sre-find', 'Enter')]);
    } finally { await context.close(); }
  }, 60_000);

  it('a long menu is a dozen headings; a heading opens its screens and is remembered; pinned and recent sit at the top', async () => {
    const { context, page } = await open(PEOPLE.manager, '/approvals');
    try {
      // the manager may open far more than 24 screens: only the daily work stands open (Approvals is in it)
      const open1 = await page.$$eval('#sre-menu .group-section:not(.sre-quick)', (s) => s.filter((x) => (x as unknown as { dataset: Record<string, string> }).dataset["open"] === "true").map((x) => (x as unknown as { dataset: Record<string, string> }).dataset["key"]));
      expect(open1).toEqual(['Daily']);
      expect(await page.isVisible('#sre-menu a:text-is("Customers")')).toBe(false);
      await page.click('#sre-menu .group-section[data-key="Customers"] .group-toggle');
      expect(await page.getAttribute('#sre-menu .group-section[data-key="Customers"] .group-toggle', 'aria-expanded')).toBe('true');
      expect(await page.isVisible('#sre-menu a:text-is("Customers")')).toBe(true);
      // open Customers; pin it; go back to Approvals: Customers is pinned, the workspace still open, and recent holds it
      await Promise.all([page.waitForURL(/\/customers\/?$/), page.click('#sre-menu a:text-is("Customers")')]);
      await page.waitForFunction('globalThis.sreChrome !== undefined');
      expect(await page.textContent('#sre-pin')).toBe('Pin this page');
      await page.click('#sre-pin');
      expect(await page.textContent('#sre-pin')).toBe('Unpin this page');
      expect(await page.getAttribute('#sre-pin', 'aria-pressed')).toBe('true');
      await page.goto(`${shop.base}/approvals`, { waitUntil: 'load' });
      await page.waitForFunction('globalThis.sreChrome !== undefined');
      expect(await texts(page, '#sre-menu .sre-quick[data-key="pinned"] a')).toEqual(['Customers']);
      expect(await page.getAttribute('#sre-menu .group-section[data-key="Customers"] .group-toggle', 'aria-expanded')).toBe('true');
      await page.goto(`${shop.base}/customers`, { waitUntil: 'load' });
      await page.waitForFunction('globalThis.sreChrome !== undefined');
      await page.click('#sre-pin'); // unpin
      await page.goto(`${shop.base}/approvals`, { waitUntil: 'load' });
      await page.waitForFunction('globalThis.sreChrome !== undefined');
      expect(await page.$('#sre-menu .sre-quick[data-key="pinned"]')).toBeNull();
      expect(await texts(page, '#sre-menu .sre-quick[data-key="recent"] a')).toEqual(['Customers']);
      // still exactly one current link: the quick links are never "current"
      expect(await texts(page, '#sre-menu a[aria-current="page"]')).toEqual(['Approvals']);
    } finally { await context.close(); }
  }, 90_000);

  it('the Customers register searches, filters, sorts and pages the 24 customers who really bought — and opens a record drawer', async () => {
    const { context, page, errors } = await open(PEOPLE.manager, '/customers');
    try {
      await page.locator('#customer-rows tr').first().waitFor();
      expect(await page.textContent('#customers-count')).toBe('Showing 1–10 of 24');
      expect(await page.locator('#customer-rows tr').count()).toBe(10);
      // the summary cards are head office's counts: 10 new (they consented), 14 not profiled
      expect(await page.textContent('#counts [data-segment="new"] .sre-summary-value')).toBe('10');
      expect(await page.textContent('#counts [data-segment="not_profiled"] .sre-summary-value')).toBe('14');
      // paging
      await page.click('#customers-next');
      expect(await page.textContent('#customers-count')).toBe('Showing 11–20 of 24');
      await page.click('#customers-next');
      expect(await page.textContent('#customers-count')).toBe('Showing 21–24 of 24');
      expect(await page.isDisabled('#customers-next')).toBe(true);
      // search by a code
      await page.fill('#customers-search', 'M-017');
      expect(await texts(page, '#customer-rows tr td:first-child')).toEqual(['M-017']);
      // filter by segment
      await page.fill('#customers-search', '');
      await page.selectOption('#customers-filter-segment', 'new');
      expect(await page.textContent('#customers-count')).toBe('Showing 1–10 of 10');
      expect(new Set(await texts(page, '#customer-rows tr td:nth-child(2)'))).toEqual(new Set(['new']));
      await page.selectOption('#customers-filter-segment', '');
      // sort by code, descending — the last customer first
      await page.click('.sre-sort[data-col="customerRef"]');
      await page.click('.sre-sort[data-col="customerRef"]');
      expect(await page.getAttribute('th:has(.sre-sort[data-col="customerRef"])', 'aria-sort')).toBe('descending');
      expect((await texts(page, '#customer-rows tr td:first-child'))[0]).toBe(CUSTOMER_REFS[CUSTOMER_REFS.length - 1]);
      // nothing matches: the register says so, and how many rows it still has
      await page.fill('#customers-search', 'nobody-like-this');
      expect(await page.textContent('#customers-table .sre-state strong')).toBe('No rows match');
      expect(await page.textContent('#customers-table .sre-state')).toContain('still has 24 row(s)');
      await page.click('#customers-table .sre-state button');
      expect(await page.textContent('#customers-count')).toBe('Showing 1–10 of 24');
      // choose the columns: hide "Last bill"
      await page.click('#customers-table .sre-datatable-columns summary');
      await page.uncheck('#customers-col-lastOrderAt');
      expect(await texts(page, '#customers-grid thead th')).not.toContain('Last bill');
      await page.check('#customers-col-lastOrderAt');
      await page.click('#customers-table .sre-datatable-columns summary');
      // the record drawer: the row's facts, Escape closes it and the focus goes back to the row's button
      await page.click('#customer-rows tr[data-customer="M-024"] .sre-row-open');
      expect(await page.textContent('#sre-drawer-title')).toBe('M-024');
      expect(await page.textContent('#sre-drawer .sre-facts')).toContain('not profiled');
      await page.keyboard.press('Escape');
      expect(await page.isHidden('#sre-drawer')).toBe(true);
      expect(await page.evaluate('document.activeElement.closest("tr").dataset.customer')).toBe('M-024');
      // in Tamil, the same register in Tamil words
      await page.click('#lang');
      await page.waitForFunction('document.documentElement.lang === "ta"');
      expect(await page.textContent('#customers-count')).toBe('24 இல் 1–10 காட்டப்படுகிறது');
      expect(await auditPage(page, { expectLang: 'ta' })).toEqual([]);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, 90_000);

  it('an empty list says "nothing yet" — never "all clear"; a role that may not read is told so', async () => {
    const { context, page } = await open(PEOPLE.manager, '/customers');
    try {
      await page.locator('#customer-rows tr').first().waitFor();
      // no merge has ever been proposed in this shop
      for (const list of ['#pending', '#inforce', '#reversed']) expect(await page.textContent(list)).toBe('Nothing here yet.');
      const body = (await page.textContent('main')) ?? '';
      expect(body).not.toMatch(/all clear|no problems found|everything is fine/i);
    } finally { await context.close(); }
    const acct = await open(PEOPLE.accountant, '/approvals');
    try {
      // the accountant has nothing waiting — said only AFTER head office answered, with the cards' real noughts
      await acct.page.waitForFunction('/Nothing is waiting for you to approve/.test(document.getElementById("waiting-count")?.textContent ?? "")');
      expect(await acct.page.textContent('#approval-cards .sre-summary-card:nth-child(1) .sre-summary-value')).toBe('0');
      expect(await acct.page.textContent('#state .sre-state')).toContain('An empty list does not mean everything is fine');
      expect((await acct.page.textContent('main')) ?? '').not.toMatch(/all clear/i);
    } finally { await acct.context.close(); }
  }, 60_000);

  it('Approvals: the owner\'s two waiting requests as cards and chips; a blank reason is refused beside the field; offline it is "not known", never "nothing waiting"', async () => {
    const { context, page, errors } = await open(PEOPLE.owner, '/approvals');
    try {
      await page.locator('#waiting li[data-request-id]').first().waitFor();
      expect(await page.locator('#waiting li[data-request-id]').count()).toBe(2);
      expect(await page.textContent('#approval-cards .sre-summary-card:nth-child(1) .sre-summary-value')).toBe('2');
      expect(await page.getAttribute('#waiting li[data-request-id] .sre-chip', 'data-tone')).toBe('degraded');
      expect(await page.textContent('#waiting li[data-request-id] .sre-field-label')).toContain('(required)');
      // Approve with no reason: nothing is sent, and the field says what to do
      const writes: string[] = [];
      page.on('request', (r) => { if (r.method() !== 'GET' && new URL(r.url()).pathname.startsWith('/v1/')) writes.push(r.url()); });
      await page.click('#waiting li[data-request-id] button.approve');
      await page.waitForSelector('#waiting li[data-request-id] .sre-field-msg:not([hidden])');
      expect(await page.textContent('#waiting li[data-request-id] .sre-field-msg')).toBe('Write your reason first — the person who asked will read it.');
      expect(await page.getAttribute('#waiting li[data-request-id] input.reason', 'aria-invalid')).toBe('true');
      expect(writes).toEqual([]);
      expect(await auditPage(page, { expectLang: 'en' })).toEqual([]);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
    // head office cannot be reached: the page does not know what waits — it never says "nothing is waiting"
    const off = await shop.asPerson(PEOPLE.owner, DESK);
    try {
      await off.context.unroute('**/v1/**');
      await off.context.route('**/v1/**', (route) => route.abort('internetdisconnected'));
      await off.page.goto(`${shop.base}/approvals`, { waitUntil: 'load' });
      await off.page.waitForFunction('/could not be asked/.test(document.getElementById("waiting-count")?.textContent ?? "")');
      expect(await off.page.textContent('#approval-cards .sre-summary-card:nth-child(1) .sre-summary-value')).toBe('Not known');
      expect(await off.page.getAttribute('#state .sre-state', 'data-state')).toBe('offline');
      expect((await off.page.textContent('main')) ?? '').not.toContain('Nothing is waiting for you to approve');
    } finally { await off.context.close(); }
  }, 90_000);

  for (const [name, device] of [['1280px desk', DESK], ['tablet', TABLET]] as const) {
    it(`the shell and the Customers page pass the audit at ${name}: contrast, 44px targets, names, labels, no sideways scroll`, async () => {
      const { context, page } = await open(PEOPLE.manager, '/customers', device);
      try {
        await page.locator('#customer-rows tr').first().waitFor();
        if (device === TABLET) await page.click('#sre-menu-button');
        expect(await auditPage(page, { expectLang: 'en' })).toEqual([]);
        expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
        // the keyboard focus is seen: a tabbed-to control wears the focus ring
        await page.focus('#customers-search');
        const outline = await page.evaluate('getComputedStyle(document.activeElement).outlineStyle');
        expect(outline).not.toBe('none');
      } finally { await context.close(); }
    }, 60_000);

    it(`Today, Approvals, Reports and Month-end pass the same audit at ${name}, each as the role that uses it`, async () => {
      for (const [who, path, ready] of [
        [PEOPLE.manager, '/manager/', '#tiles > *'],
        [PEOPLE.owner, '/approvals', '#waiting li[data-request-id]'],
        [PEOPLE.manager, '/reporting/', '#reports-list .row'],
        [PEOPLE.accountant, '/finance-close', '#pay-list .sre-state[data-state="empty"]'],
      ] as const) {
        const { context, page, errors } = await open(who, path, device);
        try {
          await page.locator(ready).first().waitFor();
          expect(await auditPage(page, { expectLang: 'en' }), `${path} at ${name}`).toEqual([]);
          expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), `${path} scrolls sideways at ${name}`).toBe(true);
          expect(errors, `${path}`).toEqual([]);
        } finally { await context.close(); }
      }
    }, 120_000);
  }

  it('Reports: the catalogue at a glance from what this shop records; the finder finds a report by a word', async () => {
    const { context, page } = await open(PEOPLE.manager, '/reporting/');
    try {
      await page.locator('#reports-list .row', { hasText: 'Sales by day' }).waitFor();
      const ready = await page.locator('#reports-list .row.ready').count();
      expect(ready).toBeGreaterThan(0);
      expect(await page.textContent('#report-cards .sre-summary-card:nth-child(1) .sre-summary-value')).toBe(String(ready));
      expect(await page.textContent('#report-cards .sre-summary-card:nth-child(2) .sre-summary-value')).toBe(String(await page.locator('#blocked-list .row').count()));
      await page.fill('#find-report', 'sales day');
      const shownRows = await shown(page, '#reports-list .row strong');
      expect(shownRows).toContain('Sales by day');
      for (const r of shownRows) expect(r.toLowerCase()).toContain('sales');
      await page.fill('#find-report', 'zzzz');
      expect(await shown(page, '#reports-list .row')).toEqual([]);
      expect(await page.textContent('#find-none')).toBe('No report matches those words.');
    } finally { await context.close(); }
  }, 60_000);

  it('Month-end: the accountant\'s figures are cards; an empty list read from head office is "nothing here to act on", never a check of the month', async () => {
    const { context, page } = await open(PEOPLE.accountant, '/finance-close');
    try {
      await page.locator('#pay-list .sre-state').waitFor();
      expect(await page.getAttribute('#pay-list .sre-state', 'data-state')).toBe('empty');
      expect(await page.textContent('#pay-list .sre-state')).toContain('it is not a check that the month is right');
      expect(await page.textContent('[data-tile="open"] .sre-summary-value')).toBe('0');
      expect(await page.textContent('[data-tile="open"] .sre-summary-label')).not.toBe('');
    } finally { await context.close(); }
  }, 60_000);

  it('Today: the workspaces start with the person\'s daily work; an empty attention list says what it covers', async () => {
    const { context, page } = await open(PEOPLE.manager, '/manager/');
    try {
      await page.locator('#workspaces a').first().waitFor();
      expect(await page.textContent('#workspaces a:first-child b')).toBe('Your daily work');
      const attention = (await page.textContent('#attention')) ?? '';
      if (await page.$('#attention .quiet')) expect(attention).toContain('it is not a check of the whole store');
      expect(attention).not.toMatch(/all clear/i);
    } finally { await context.close(); }
  }, 60_000);
});
