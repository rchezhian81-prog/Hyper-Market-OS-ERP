import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { auditPage } from './lib/a11y-audit';
import { startOfficeShop, PEOPLE, S1, type OfficeShop } from './lib/office-shop';

/**
 * **U2 (UI/UX gap audit G5, G14) — five HARD pages pick a thing by NAME on the REAL store computer fed by the REAL head
 * office; the id the page sends is exactly what it was.**
 *
 *   • Store tasks: the store is the manager's own from the sign-in; "Who does it" is picked from the store's people —
 *     three letters find the person, the pick fills the field, the task lands at head office naming that person.
 *   • Delegation: both people picked by name; the dates are the shared dd/mm field — an impossible day (31/02) is refused
 *     beside the field and nothing is sent; a real one reaches the confirm sheet in words, and Go back sends nothing.
 *   • Quotations: the store is filled in; the customer and the item picked by name (the item by what the tills charge
 *     from); the quotation lands with the same ids; the date field holds the default in dd/mm.
 *   • Record a write-off: with head office's product list unreachable the picker SAYS so and the code typed in its place
 *     fills the field (never a dead end); reachable again, three letters find the product and the place by name.
 *   • Customer cases: the case number is GIVEN by the page (the shop's day and the next free number), the customer picked
 *     by name; the case lands under that number and the next number is proposed.
 * Audit clean with a picker open. Skips where no browser binary is present.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DESK = { viewport: { width: 1280, height: 860 } };
const iso = (plus: number): string => new Date(Date.now() + plus * 86_400_000).toISOString().slice(0, 10);
const ddmm = (d: string): string => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const words = (d: string): string => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;

describe.skipIf(!existsSync(CHROMIUM))('U2: the HARD pages pick things by name', () => {
  let browser: Browser;
  let shop: OfficeShop;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    shop = await startOfficeShop(browser);
  }, 300_000);
  afterAll(async () => { await shop?.stop(); await browser?.close(); });

  const open = async (who: string, path: string) => {
    const s = await shop.asPerson(who, DESK);
    const writes: { path: string; body: unknown }[] = [];
    s.page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() === 'POST') writes.push({ path: u.pathname, body: JSON.parse(r.postData() ?? 'null') }); });
    await s.page.goto(`${shop.base}${path}`, { waitUntil: 'load' });
    await s.page.waitForFunction('globalThis.sreOffice !== undefined && typeof globalThis.sreOffice.pick === "function"');
    return { ...s, writes };
  };
  /** Open the picker behind a field, type a few letters, and take the row that names the thing. */
  const pick = async (page: Page, field: string, letters: string, id: string): Promise<void> => {
    await page.click(`#${field}-pick`);
    await page.waitForSelector('#sre-picker');
    await page.fill('#sre-picker-q', letters);
    const row = page.locator(`#sre-picker .sre-picker-row[data-id="${id}"]`);
    await row.waitFor({ timeout: 15_000 });
    await row.click();
    await page.waitForSelector('#sre-picker', { state: 'detached' });
    expect(await page.inputValue(`#${field}`), `${field} holds the id`).toBe(id);
  };

  it('Store tasks: the store is the manager\'s own; who does it is picked by name; the task lands naming that person', async () => {
    const s = await open(PEOPLE.manager, '/store-tasks');
    try {
      await s.page.waitForSelector('body[data-task-defaults="ready"]');
      expect(await s.page.inputValue('#a-branch'), 'the store from the sign-in, never typed first').toBe(S1);
      expect(await s.page.textContent('#l-a-person'), 'the label asks for a person, not an id').toBe('Who does it');
      await s.page.fill('#a-title', 'Face up aisle 3');
      await pick(s.page, 'a-person', 'cas', PEOPLE.cashier);
      await s.page.click('#a-save');
      await s.page.waitForFunction("document.getElementById('assign-status').className.includes('good')", undefined, { timeout: 15_000 });
      const sent = s.writes.find((w) => w.path.startsWith('/v1/hr/workforce/assigned-tasks/'));
      expect(sent, 'the task reached head office').toBeDefined();
      expect((sent!.body as { assignedTo: string; branchId: string }).assignedTo).toBe(PEOPLE.cashier);
      expect((sent!.body as { assignedTo: string; branchId: string }).branchId).toBe(S1);
      expect(s.errors).toEqual([]);
    } finally { await s.context.close(); }
  });

  it('Delegation: both people picked by name; an impossible date is refused beside the field; the sheet says the dates in words; Go back sends nothing', async () => {
    const s = await open(PEOPLE.owner, '/delegation');
    try {
      await pick(s.page, 'from', 'mgr', PEOPLE.manager);
      await pick(s.page, 'to', 'acc', PEOPLE.accountant);
      expect(await s.page.getAttribute('#from-date', 'placeholder'), 'a date a shop person reads').toBe('dd/mm/yyyy');
      await s.page.fill('#from-date', ddmm(iso(0)));
      await s.page.fill('#until-date', '31/02/2026');
      await s.page.locator('#until-date').blur();
      const msg = s.page.locator('#until-date-msg');
      await msg.waitFor({ state: 'visible', timeout: 10_000 });
      expect(await msg.textContent(), 'the impossible day is said beside the field').toMatch(/./);
      await s.page.fill('#cap', '2000');
      await s.page.check('input[name="kind"][value="refund"]');
      await s.page.fill('#reason', 'On leave');
      await s.page.click('#lend');
      expect(await s.page.textContent('#lend-status'), 'the page refuses before anything is sent').toMatch(/Fill in whose authority/);
      expect(s.writes).toEqual([]);
      await s.page.fill('#until-date', ddmm(iso(10)));
      await s.page.click('#lend');
      await s.page.locator('#sre-confirm').waitFor({ timeout: 15_000 });
      expect(await s.page.textContent('#sre-confirm-title')).toContain(`from ${words(iso(0))} until ${words(iso(10))}`);
      expect(await auditPage(s.page), 'the sheet over the picked fields passes the audit').toEqual([]);
      await s.page.click('#sre-confirm-back');
      expect(await s.page.textContent('#lend-status')).toBe('Nothing was lent.');
      expect(s.writes).toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.context.close(); }
  });

  it('Quotations: the store is filled in; the customer and the item are picked by name; the date holds the default in dd/mm; the quotation lands with the same ids', async () => {
    // The quotation's line is read against the signed PRICE PACK the tills charge from: a store price for the milk and the
    // pack built, through head office's own routes, as the owner.
    for (const [path, body] of [
      ['/v1/prices/list/p-milk/entries/e1', { scope: 'store', scopeRef: S1, priceMinor: 3_000, mrpMinor: 3_200, costMinor: 1, marginFloorBps: 0, currency: 'INR', effectiveFrom: iso(0) }],
      // OB-532: head office quotes a product only when it knows its lowest price — the milk came in at a cost once.
      ['/v1/inventory/goods-receipt/opening-u2-milk', { warehouseId: S1, receivedOnDate: iso(0), currency: 'INR', lines: [{ lineId: 'L1', productId: 'p-milk', orderedMinor: 20, countedMinor: 20, uom: 'ea', unitCost: { minor: 2_000, currency: 'INR' }, condition: 'good' }] }],
      ['/v1/catalogue/pack', { storeId: S1 }],
    ] as const) {
      const r = await shop.h.request({ method: 'POST', path, userId: PEOPLE.owner, tenantId: shop.tenantId, idempotencyKey: `u2-${path}`, body });
      expect(r.status, `${path}: ${JSON.stringify(r.body)}`).toBeLessThan(300);
    }
    const s = await open(PEOPLE.manager, '/quotations');
    try {
      await s.page.waitForSelector('#make:not([hidden])');
      expect(await s.page.inputValue('#q-store'), 'the person\'s own store, filled in').toBe(S1);
      expect(await s.page.textContent('#q-store-l')).toBe('Store');
      expect(await s.page.inputValue('#q-until'), 'the default date, as a shop person reads it').toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
      await pick(s.page, 'q-customer', 'M-00', 'M-001');
      await s.page.click('#l-code-pick');
      await s.page.waitForSelector('#sre-picker');
      await s.page.fill('#sre-picker-q', 'ton');
      const row = s.page.locator('#sre-picker .sre-picker-row[data-id="p-milk"]');
      await row.waitFor({ timeout: 15_000 });
      expect(await row.locator('.sre-picker-name').textContent()).toBe('Toned milk 500 ml');
      await row.click();
      expect(await s.page.inputValue('#l-code'), 'the code the tills charge from').toBe('MILK-500');
      await s.page.fill('#l-qty', '2');
      await s.page.click('#l-add');
      await s.page.waitForFunction("document.querySelector('#lines li[data-product]') !== null || (document.getElementById('l-status').textContent || '') !== ''", undefined, { timeout: 15_000 });
      expect(await s.page.textContent('#l-status'), 'the line reads against the pack').toBe('');
      await s.page.waitForSelector('#lines li[data-product="p-milk"]');
      expect(await auditPage(s.page)).toEqual([]);
      await s.page.click('#q-make');
      await s.page.waitForFunction("(document.getElementById('q-status').textContent || '') !== ''", undefined, { timeout: 15_000 });
      expect(await s.page.textContent('#q-status')).toMatch(/^Quotation made/);
      const sent = s.writes.find((w) => w.path.startsWith('/v1/pos/quotations/'));
      expect(sent).toBeDefined();
      const body = sent!.body as { storeId: string; customerRef: string; validUntil: string; lines: { productId: string }[] };
      expect(body.storeId).toBe(S1);
      expect(body.customerRef).toBe('M-001');
      expect(body.validUntil).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(body.lines[0]!.productId).toBe('p-milk');
      expect(s.errors).toEqual([]);
    } finally { await s.context.close(); }
  });

  it('Record a write-off: head office unreachable, the store computer\'s own copy is offered and said so, and the typed code still fills the field; reachable, the product and the place are found by name', async () => {
    const s = await open(PEOPLE.manager, '/write-off-capture/');
    try {
      await s.page.waitForSelector('#capturer:not([hidden])');
      await s.context.route('**/v1/catalogue/products**', (r) => r.abort());
      await s.page.click('#wo-product-pick');
      await s.page.waitForSelector('#sre-picker');
      // U5 (P-01): the list is the store computer's signed copy — said above the rows; a product published since may be
      // missing from it, so the typed code stays offered beside it (never a dead end)
      await s.page.waitForSelector('#sre-picker-source', { state: 'visible', timeout: 15_000 });
      expect(await s.page.textContent('#sre-picker-source'), 'the picker says whose copy the list is').toMatch(/from this store computer's copy of the catalogue/);
      await s.page.waitForSelector('#sre-picker-typed', { state: 'visible', timeout: 15_000 });
      await s.page.fill('#sre-picker-typed', 'p-milk');
      await s.page.click('#sre-picker-use-code');
      await s.page.waitForSelector('#sre-picker', { state: 'detached' });
      expect(await s.page.inputValue('#wo-product'), 'the typed code is the fallback, never a dead end').toBe('p-milk');
      await s.context.unroute('**/v1/catalogue/products**');
      await pick(s.page, 'wo-product', 'ton', 'p-milk');
      expect(await s.page.textContent('#wo-product-name')).toBe('Toned milk 500 ml');
      await pick(s.page, 'wo-location', 'Hyp', S1);
      expect(await s.page.textContent('#wo-location-name')).toBe('SRE Hyper Market');
      await s.page.click('#wo-location-pick');
      await s.page.waitForSelector('#sre-picker');
      expect(await auditPage(s.page), 'the picker passes the audit').toEqual([]);
      await s.page.keyboard.press('Escape');
      await s.page.waitForSelector('#sre-picker', { state: 'detached' });
      expect(await s.page.inputValue('#wo-location'), 'Escape keeps what was picked').toBe(S1);
      expect(s.errors).toEqual([]);
    } finally { await s.context.close(); }
  });

  it('Customer cases: the number is given by the page, the customer picked by name, the case lands under that number and the next is proposed', async () => {
    const s = await open(PEOPLE.manager, '/service-desk');
    try {
      await s.page.waitForFunction("/^C-\\d{8}-001$/.test(document.getElementById('new-id').value)", undefined, { timeout: 15_000 });
      const number = await s.page.inputValue('#new-id');
      expect(await s.page.getAttribute('#new-id', 'readonly'), 'never typed').not.toBeNull();
      expect(await s.page.textContent('#l-new-customer')).toBe('Customer');
      await pick(s.page, 'new-customer', 'M-00', 'M-002');
      await s.page.fill('#new-summary', 'The milk was sour');
      await s.page.click('#open-case');
      await s.page.waitForSelector(`#case-rows tr[data-case-id="${number}"]`, { timeout: 15_000 });
      const sent = s.writes.find((w) => w.path === `/v1/service/cases/${number}`);
      expect(sent).toBeDefined();
      expect((sent!.body as { customerRef: string }).customerRef).toBe('M-002');
      expect(await s.page.inputValue('#new-id'), 'the next free number').toBe(number.replace(/001$/, '002'));
      expect(s.errors).toEqual([]);
    } finally { await s.context.close(); }
  });
});
