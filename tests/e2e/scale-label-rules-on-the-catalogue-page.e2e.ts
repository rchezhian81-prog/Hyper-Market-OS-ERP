import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, OWNER, type InboxShop } from './lib/ai-inbox-shop';

/**
 * **OB-570 "A" · M03-FR-02 — the Product user sees, adds and stops the scale-label rules on the Products and prices page**,
 * in a real browser, on the PRODUCTION API over real PostgreSQL:
 *
 *   • the owner (who holds the product role) adds "labels starting 2: item code digits 2–7, weight in grams 8–12"; the page
 *     says it in those plain words, and head office holds it — after a RESTART too;
 *   • an ambiguous rule (prefix 21) is refused in head office's own words; nothing is saved;
 *   • with head office unreachable the page says nothing was saved — never a fake success — and nothing was;
 *   • stopping the rule is its own write; the page then says no rule is set; the words switch to Tamil;
 *   • a cashier reads the rules and is offered no way to change them.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['scale', 'rules', 'e2e', 'signing', 'key'].join('-').padEnd(48, '0');
const CASHIER = 'u-cash';

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('scale label rules on the catalogue page, on the production API (OB-570 "A")', () => {
  let browser: Browser;
  let shop: InboxShop;
  const rules = async (): Promise<{ prefix: string; rule: { valueKind: string } }[]> =>
    ((await shop.cloud().request({ method: 'GET', path: '/v1/catalogue/scale-label-rules', userId: OWNER })).body as { rules: { prefix: string; rule: { valueKind: string } }[] }).rules;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/catalogue', html: 'catalogue.html', dataGlobal: 'catalogueData', extraData: async () => ({ storeId: 'br-1', products: [] }) },
      seed: async (cloud) => { await cloud.grant(CASHIER, 'cashier'); },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  const open = async (who: string) => {
    const context = await browser.newContext();
    await shop.signIn(context, who);
    const page = await context.newPage();
    const writes: string[] = []; const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${u.pathname}`); });
    await page.goto(`${shop.base}/catalogue?tab=scale`, { waitUntil: 'load' });
    return { page, writes, errors, close: () => context.close() };
  };
  const says = async (page: Page, selector: string, expected: RegExp): Promise<void> => {
    await page.waitForFunction(([sel, source]) => new RegExp(source!).test((globalThis as unknown as { document: { querySelector(x: string): { textContent: string | null } | null } }).document.querySelector(sel!)?.textContent ?? ''), [selector, expected.source], { timeout: 15_000 });
  };
  const fill = async (page: Page, prefix: string, item: [string, string], value: [string, string], kind = 'weight'): Promise<void> => {
    await page.fill('#scale-prefix', prefix);
    await page.fill('#scale-item-from', item[0]); await page.fill('#scale-item-to', item[1]);
    await page.fill('#scale-value-from', value[0]); await page.fill('#scale-value-to', value[1]);
    await page.selectOption('#scale-kind', kind);
  };

  it('the owner adds a rule in plain words; an ambiguous one is refused; unreachable says nothing was saved; stopping it is its own write', async () => {
    const s = await open(OWNER);
    try {
      await says(s.page, '#scale-list', /No scale label rule is set/);
      expect(s.writes, 'nothing is written on open').toEqual([]);

      await fill(s.page, '2', ['2', '7'], ['8', '12']);
      await s.page.fill('#scale-reason', 'deli scale');
      await s.page.click('#scale-save');
      await says(s.page, '#scale-save-status', /^Saved at head office\./);
      await says(s.page, '#scale-list [data-prefix="2"]', /Labels starting with 2: item code in digits 2–7, weight in grams in digits 8–12/);
      expect(s.writes).toEqual(['POST /v1/catalogue/scale-label-rules/2']);

      // Ambiguous: refused in head office's own words, nothing saved.
      await fill(s.page, '21', ['3', '7'], ['8', '12']);
      await s.page.click('#scale-save');
      await says(s.page, '#scale-save-status', /^Head office refused: .*would match both this rule and the rule for prefix "2"/);
      expect((await rules()).map((r) => r.prefix)).toEqual(['2']);

      // Head office unreachable: said, never a success; nothing reached head office.
      await s.page.route('**/v1/catalogue/scale-label-rules/**', (route) => route.abort());
      await fill(s.page, '3', ['2', '7'], ['8', '12'], 'price');
      await s.page.click('#scale-save');
      await says(s.page, '#scale-save-status', /^Head office cannot be reached — nothing was saved\./);
      await s.page.unroute('**/v1/catalogue/scale-label-rules/**');
      expect((await rules()).map((r) => r.prefix)).toEqual(['2']);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    // A restart of head office reads the same rule.
    await shop.restart();
    expect((await rules()).map((r) => [r.prefix, r.rule.valueKind])).toEqual([['2', 'weight']]);

    const t = await open(OWNER);
    try {
      await says(t.page, '#scale-list [data-prefix="2"]', /Labels starting with 2/);
      await t.page.click('#lang');
      await says(t.page, '#tab-scale', /^எடை லேபிள் விதிகள்/); // the shared chrome adds the section's first sentence beneath
      await says(t.page, '#scale-list [data-prefix="2"]', /2 இல் தொடங்கும் லேபிள்கள்/);
      await t.page.click('#lang');
      // OB-574: Stop with no reason asks for one and sends nothing; with a reason it stops the rule.
      await t.page.click('#scale-list [data-withdraw="2"]');
      await says(t.page, '#scale-save-status', /^Write why this rule stops/);
      expect(t.writes).toEqual([]);
      await t.page.fill('#scale-reason', 'the deli scale was replaced');
      await t.page.click('#scale-list [data-withdraw="2"]');
      await says(t.page, '#scale-save-status', /^Stopped at head office\./);
      await says(t.page, '#scale-list', /No scale label rule is set/);
      expect(t.writes).toEqual(['POST /v1/catalogue/scale-label-rules/2/withdrawal']);
      expect(await rules()).toEqual([]);
      expect(t.errors).toEqual([]);
    } finally { await t.close(); }
  }, 180_000);

  it('a cashier reads the rules and is offered no way to change them', async () => {
    const s = await open(CASHIER);
    try {
      await says(s.page, '#scale-status', /You can read these rules; changing them needs the product role\./);
      expect(await s.page.locator('#scale-form').isHidden()).toBe(true);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    expect((await shop.cloud().request({ method: 'POST', path: '/v1/catalogue/scale-label-rules/2', userId: CASHIER, idempotencyKey: randomUUID(), body: { itemStart: 1, itemLength: 6, valueStart: 7, valueLength: 5, valueKind: 'weight' } })).status).toBe(403);
  }, 60_000);
});
