import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { auditPage } from './lib/a11y-audit';
import { startOfficeShop, PEOPLE, S1, type OfficeShop } from './lib/office-shop';

/**
 * **U2b (UI/UX gap audit G5, G14) — the people and stock pages pick a thing by NAME on the REAL store computer fed by
 * the REAL head office; the id the page sends is exactly what it was.**
 *
 *   • Warehouse: the from/to places are picked from the store computer's own directory (the back store by three letters,
 *     with every head-office read cut — it comes from the signed pack), the product by its name, the person by name; the
 *     transfer proposal the page queues carries exactly those ids. The audit is clean with the picker open, in EN and TA.
 *   • Staff schedule: the store is the manager's own, said by name beside the field, and can be picked.
 *   • Incidents: a follow-up's owner is picked by name; the follow-up lands at head office naming that person.
 *   • AI control: the day the limit runs until is the shared dd/mm field — filled with the end of the shop's month in the
 *     shop's form, an impossible day (31/02) refused beside it, ISO read back.
 *   • Today, Receive: the month of manufacture is picked from a list of the last 36 months, named in the reader's
 *     language, never typed; its value is the 'YYYY-MM' the receipt line always carried.
 * Skips where no browser binary is present.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DESK = { viewport: { width: 1280, height: 860 } };

describe.skipIf(!existsSync(CHROMIUM))('U2b: the people and stock pages pick things by name', () => {
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

  it('Warehouse: places from the store computer\'s own directory (head office cut), the product and the person by name; the audit clean with the picker open', async () => {
    const s = await open(PEOPLE.manager, '/warehouse-supervisor/');
    try {
      await pick(s.page, 't-product', 'ton', 'p-milk');
      expect(await s.page.textContent('#t-product-name'), 'the product\'s name is said beside the field').toContain('Toned milk');
      await pick(s.page, 'k-assignee', 'cas', PEOPLE.cashier);
      // the places come from the signed pack: cut every head-office read and they still come
      await s.context.route('**/v1/**', (route) => route.abort());
      await pick(s.page, 't-from', 'back', 'S1-BACK');
      await pick(s.page, 't-to', 'hyper', S1);
      await s.context.unroute('**/v1/**');
      // the picker open passes the audit, in English and — the toggle pressed with the sheet closed — in Tamil
      await s.page.click('#t-from-pick');
      await s.page.waitForSelector('#sre-picker');
      expect(await auditPage(s.page)).toEqual([]);
      await s.page.keyboard.press('Escape');
      await s.page.waitForSelector('#sre-picker', { state: 'detached' });
      await s.page.click('#lang');
      expect(await s.page.textContent('#t-from-pick'), 'the button follows the toggle').toContain('தேர்ந்தெடு');
      await s.page.click('#t-from-pick');
      await s.page.waitForSelector('#sre-picker');
      expect(await auditPage(s.page, { expectLang: 'ta' })).toEqual([]);
      await s.page.keyboard.press('Escape');
      await s.page.waitForSelector('#sre-picker', { state: 'detached' });
      expect(await s.page.inputValue('#t-from'), 'Escape keeps the pick').toBe('S1-BACK');
      expect(s.errors).toEqual([]);
    } finally { await s.context.close(); }
  });

  it('Staff schedule: the store is the manager\'s own, said by name, and can be picked', async () => {
    const s = await open(PEOPLE.manager, '/schedule');
    try {
      await s.page.waitForFunction("document.getElementById('branch') !== null && document.getElementById('branch').value !== ''");
      expect(await s.page.inputValue('#branch'), 'the store from the sign-in, never typed first').toBe(S1);
      expect(await s.page.textContent('#branch-own')).toContain('SRE Hyper Market');
      expect(await s.page.textContent('#branch-own')).toContain('your store');
      await s.page.click('#lang');
      expect(await s.page.textContent('#branch-own')).toContain('உங்கள் கடை');
      expect(await s.page.$('#branch-pick'), 'a Choose… button sits beside the store').not.toBeNull();
      expect(s.errors).toEqual([]);
    } finally { await s.context.close(); }
  });

  it('Incidents: a follow-up\'s owner is picked by name and the follow-up lands naming that person', async () => {
    const s = await open(PEOPLE.manager, '/incidents');
    try {
      await s.page.click('#open-new');
      await s.page.fill('#n-title', 'Chiller 2 alarm');
      await s.page.fill('#n-summary', 'Temperature rose to 9 °C at 06:10; stock moved to chiller 1.');
      await s.page.click('#n-save');
      await s.page.waitForSelector('#sheet:not([hidden])', { timeout: 15_000 });
      await s.page.fill('#a-desc', 'Service engineer to check the compressor');
      await s.page.fill('#a-due', '30/11/2026');
      await pick(s.page, 'a-owner', 'cas', PEOPLE.cashier);
      await s.page.click('#a-add');
      await s.page.waitForFunction((who) => Array.from((globalThis as unknown as { document: { querySelectorAll(sel: string): ArrayLike<{ textContent: string | null }> } }).document.querySelectorAll('#sheet li, #sheet p')).some((n) => (n.textContent ?? '').includes(who)), PEOPLE.cashier, { timeout: 15_000 }).catch(() => {});
      const sent = s.writes.find((w) => /\/v1\/platform\/incidents\/[^/]+\/actions/.test(w.path) || (w.path.includes('incident') && w.path.includes('action')));
      expect(sent, 'the follow-up reached head office').toBeDefined();
      expect((sent!.body as { ownerUserId: string }).ownerUserId).toBe(PEOPLE.cashier);
      expect(s.errors).toEqual([]);
    } finally { await s.context.close(); }
  });

  it('AI control: the day the limit runs until is the shared dd/mm field, filled with the end of the shop\'s month; Investigations: 31/02 refused beside the field, a real day read back as ISO', async () => {
    const s = await open(PEOPLE.owner, '/ai/');
    try {
      await s.page.waitForFunction("document.body.dataset.aiControl === 'ok'", undefined, { timeout: 15_000 });
      await s.page.waitForFunction("document.getElementById('period') !== null && document.getElementById('period').closest('.sre-date') !== null");
      // the limits form opens only for a person head office lets set them; the field itself is the shared one, holding the shop's month end
      const period = await s.page.$eval('#period', (el) => { const i = el as unknown as { value: string; dataset: { iso?: string }; placeholder: string }; return { shown: i.value, iso: i.dataset.iso ?? '', placeholder: i.placeholder }; });
      expect(period.placeholder).toBe('dd/mm/yyyy');
      expect(period.iso, 'the end of the shop\'s month, as ISO behind the field').toMatch(/^\d{4}-\d{2}-(28|29|30|31)$/);
      expect(period.shown, 'shown as a shop person writes it').toBe(`${period.iso.slice(8, 10)}/${period.iso.slice(5, 7)}/${period.iso.slice(0, 4)}`);
      expect(await s.page.$$eval('label[for="period"]', (ls) => ls.filter((l) => !(l as unknown as { hidden: boolean }).hidden).length), 'one visible label for the field, never two').toBe(1);
      expect(s.errors).toEqual([]);
    } finally { await s.context.close(); }
    const lp = await open(PEOPLE.manager, '/loss-prevention');
    try {
      await lp.page.waitForSelector('#together:not([hidden])', { timeout: 15_000 });
      await lp.page.waitForFunction("document.getElementById('together-from') !== null && document.getElementById('together-from').closest('.sre-date') !== null");
      await lp.page.fill('#together-from', '31/02/2026');
      await lp.page.dispatchEvent('#together-from', 'change');
      await lp.page.waitForFunction("document.getElementById('together-from').getAttribute('aria-invalid') === 'true'");
      expect(await lp.page.evaluate(() => (globalThis as unknown as { sreOffice: { dateValue(id: string): string | null } }).sreOffice.dateValue('together-from'))).toBeNull();
      await lp.page.fill('#together-from', '01/10/2026');
      await lp.page.dispatchEvent('#together-from', 'change');
      expect(await lp.page.evaluate(() => (globalThis as unknown as { sreOffice: { dateValue(id: string): string | null } }).sreOffice.dateValue('together-from'))).toBe('2026-10-01');
      expect(await lp.page.$('#together-id-pick'), 'the subject is picked by name').not.toBeNull();
      expect(lp.errors).toEqual([]);
    } finally { await lp.context.close(); }
  });

  it('Today, Receive: the month of manufacture is picked from a list of months named in the reader\'s language, never typed', async () => {
    const s = await open(PEOPLE.manager, '/manager/');
    try {
      await s.page.click('#tab-receive');
      await s.page.waitForSelector('#view-receive:not([hidden])');
      expect(await s.page.$eval('#grn-mfg', (el) => el.tagName)).toBe('SELECT');
      const options = await s.page.$$eval('#grn-mfg option', (os) => os.map((o) => { const opt = o as unknown as { value: string; textContent: string | null }; return { value: opt.value, text: opt.textContent ?? '' }; }));
      expect(options.length).toBe(37);
      expect(options[0]!.value).toBe('');
      expect(options.slice(1).every((o) => /^\d{4}-(0[1-9]|1[0-2])$/.test(o.value))).toBe(true);
      expect(options[1]!.text).toMatch(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4}$/);
      await s.page.click('#lang');
      expect(await s.page.$eval('#grn-mfg option:nth-child(2)', (o) => o.textContent ?? '')).toMatch(/[஀-௿]/);
      expect(await s.page.textContent('#grn-mfg-hint')).toContain('தேர்ந்தெடுங்கள்');
      expect(s.errors).toEqual([]);
    } finally { await s.context.close(); }
  });
});
