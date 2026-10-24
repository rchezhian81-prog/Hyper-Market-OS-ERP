import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, OWNER, type InboxShop } from './lib/ai-inbox-shop';
import { SETUP_CATALOGUE, setupItem } from '../../packages/tenant/src/index';

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

/** OB-288 P1 · OB-336: the settings that need the owner's approval (M01-FR-02's two, and the three the owner added on 23 Oct
 *  2026 — the time zone, the till's spend cap and the bulk-publish threshold) — one person's save is refused. */
const HIGH_IMPACT: readonly string[] = ['trading_day.cutoff', 'locale.currency', 'locale.time_zone', 'loyalty.till_spend_cap_paise', 'catalogue.bulk_publish_threshold', 'store.state'];

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

  it('OB-78: the owner moves the early disk-warning line (hours of trading) on the screen; a nonsense value is refused in the engine\'s words; head office holds it after a restart', async () => {
    const WARN = 'platform.box_disk_warn_hours';
    const warnOf = async (): Promise<Item> => ((await shop.cloud().request({ method: 'GET', path: '/v1/platform/setup', userId: OWNER })).body as { items: Item[] }).items.find((i) => i.key === WARN)!;
    expect(await warnOf()).toMatchObject({ value: 48, isDefault: true, version: 0 });
    const { page, errors, close } = await open(OWNER);
    const said = (re: RegExp) => page.waitForFunction(([k, src]) => new RegExp(src!).test((globalThis as unknown as { document: { getElementById(i: string): { textContent: string | null } | null } }).document.getElementById(`m-${k}`)?.textContent ?? ''), [WARN, re.source], { timeout: 15_000 });
    try {
      await page.locator(`[id="f-${WARN}"]`).waitFor({ timeout: 15_000 });
      await page.locator(`[id="f-${WARN}"]`).fill('0');
      // Refused on the field in the engine's own words, and Save stays off — nothing is sent.
      await said(/Give a whole number of trading hours, from 1 to 720/);
      expect(await page.locator(`[id="s-${WARN}"]`).isDisabled()).toBe(true);
      expect(await warnOf()).toMatchObject({ value: 48, version: 0 });
      await page.locator(`[id="f-${WARN}"]`).fill('24');
      await page.locator(`[id="s-${WARN}"]`).click();
      await said(/Saved/);
      expect(errors).toEqual([]);
    } finally { await close(); }
    expect(await warnOf()).toMatchObject({ value: 24, version: 1, isDefault: false });
    await shop.restart();
    expect(await warnOf()).toMatchObject({ value: 24, version: 1 });
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

/**
 * **Every setting the setup screen offers, table-driven: the right control, a save head office keeps after a restart,
 * and a refusal in the engine's own words (EN and TA).**
 *
 * Round 13 found that settings added to the catalogue after the screen was built — the three loyalty settings and the
 * bulk-publish line — had no number editor: they were shown as TEXT, so whatever the owner typed reached the engine as
 * a string and every save was refused ("Give a whole number…") — the owner could not set loyalty from the screen at
 * all. The table below must name EVERY catalogue item (a new setting without a row fails the first test), and the
 * expected control for a number / on-off / list setting is derived from the setting's own default type, not hand-kept.
 */
interface Row {
  /** What the owner types (a string), ticks (true) or picks (select) on the screen. */
  readonly enter: string | true;
  /** What head office must then hold. */
  readonly stored: unknown;
  /** For a string-typed setting: the control the screen must offer (numbers, on/off and lists derive theirs). */
  readonly control?: 'time' | 'text' | 'select';
  /** A value the engine refuses: what is typed, and the value the engine's rule is asked about (for its words). */
  readonly bad?: { readonly enter: string; readonly value: unknown };
}
const TABLE: Readonly<Record<string, Row>> = {
  'tax.default_bps': { enter: '1800', stored: 1800, bad: { enter: '10001', value: 10001 } },
  'trading_day.cutoff': { enter: '22:30', stored: '22:30', control: 'time', bad: { enter: '', value: '' } },
  'locale.time_zone': { enter: 'Asia/Dubai', stored: 'Asia/Dubai', control: 'text', bad: { enter: 'Mars/Olympus', value: 'Mars/Olympus' } },
  'receipt.paper_format': { enter: 'thermal-58', stored: 'thermal-58', control: 'select' },
  'locale.languages': { enter: 'en\nta\nhi', stored: ['en', 'ta', 'hi'], bad: { enter: '', value: [] } },
  'locale.currency': { enter: 'usd', stored: 'USD', control: 'text', bad: { enter: 'US', value: 'US' } },
  'production.departments': { enter: 'bakery, café', stored: ['bakery', 'café'] },
  'picking.zone_order': { enter: 'ambient\nsecure\nchilled\nfrozen', stored: ['ambient', 'secure', 'chilled', 'frozen'] },
  'delivery.radius_km': { enter: '7.5', stored: 7.5, bad: { enter: '-1', value: -1 } },
  'pos.age_restricted.minimum_age': { enter: '21', stored: 21, bad: { enter: '121', value: 121 } },
  'pos.licence_hours.enabled': { enter: true, stored: true },
  'merchandising.shelf_count_stale_after_minutes': { enter: '90', stored: 90, bad: { enter: '0', value: 0 } },
  'merchandising.shelf_refill_at_bp': { enter: '2500', stored: 2500, bad: { enter: '10001', value: 10001 } },
  'catalogue.bulk_publish_threshold': { enter: '200', stored: 200, bad: { enter: '0', value: 0 } },
  'loyalty.points_per_100_inr': { enter: '2', stored: 2, bad: { enter: '101', value: 101 } },
  'loyalty.point_value_paise': { enter: '25', stored: 25, bad: { enter: '10001', value: 10001 } },
  'loyalty.till_spend_cap_paise': { enter: '75000', stored: 75_000, bad: { enter: '10000001', value: 10_000_001 } },
  'platform.box_disk_warn_hours': { enter: '36', stored: 36, bad: { enter: '0', value: 0 } },
  'platform.box_unsent_warn_hours': { enter: '4', stored: 4, bad: { enter: '73', value: 73 } },
  'platform.box_claim_slack_numbers': { enter: '0', stored: 0, bad: { enter: '101', value: 101 } },
  'platform.box_claim_slack_percent': { enter: '2', stored: 2, bad: { enter: '51', value: 51 } },
  // A22 (OB-326): the B2C dynamic QR — switched off by default; each detail empty (not set) or well formed.
  'invoice.b2c_dynamic_qr.on': { enter: true, stored: true },
  'invoice.b2c_dynamic_qr.upi_id': { enter: 'srehyper@okaxis', stored: 'srehyper@okaxis', control: 'text', bad: { enter: 'srehyper', value: 'srehyper' } },
  'invoice.b2c_dynamic_qr.bank_account': { enter: '123456789012', stored: '123456789012', control: 'text', bad: { enter: '1234', value: '1234' } },
  'invoice.b2c_dynamic_qr.ifsc': { enter: 'HDFC0001234', stored: 'HDFC0001234', control: 'text', bad: { enter: 'HDFC1234', value: 'HDFC1234' } },
  // OB-348: the shop's state — a two-letter code (high-impact: the owner approves); OB-299: the delivery-fee product.
  'store.state': { enter: 'TN', stored: 'TN', control: 'text', bad: { enter: 'Tamil Nadu', value: 'Tamil Nadu' } },
  'delivery.till_fee_product': { enter: 'p-delivery', stored: 'p-delivery', control: 'text', bad: { enter: 'home delivery', value: 'home delivery' } },
};

/** The control a setting must be edited with: derived from its default's type for numbers, on/off and lists. */
function expectedControl(key: string): { tag: string; type?: string } {
  const item = setupItem(key)!;
  const d = item.setting.defaultValue;
  if (typeof d === 'number') return { tag: 'input', type: 'number' };
  if (typeof d === 'boolean') return { tag: 'input', type: 'checkbox' };
  if (Array.isArray(d)) return { tag: 'textarea' };
  const c = TABLE[key]!.control!;
  return c === 'select' ? { tag: 'select' } : { tag: 'input', type: c };
}

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('store setup: every setting is editable with the right control and kept by head office (table-driven)', () => {
  let browser: Browser;
  let shop: InboxShop;
  const items = async (who = OWNER): Promise<Item[]> => ((await shop.cloud().request({ method: 'GET', path: '/v1/platform/setup', userId: who })).body as { items: Item[] }).items;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: SIGN,
      page: {
        path: '/setup', html: 'setup.html', dataGlobal: 'setupData',
        extraData: async (api) => { const s = await api('/v1/platform/setup') as { items?: unknown }; return Array.isArray(s.items) ? { status: s } : {}; },
      },
      seed: async () => undefined,
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await shop?.stop();
  });

  const open = async () => {
    const context = await browser.newContext();
    await shop.signIn(context, OWNER);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${shop.base}/setup`, { waitUntil: 'load' });
    await page.locator('[id="f-tax.default_bps"]').waitFor({ timeout: 15_000 });
    return { page, errors, close: () => context.close() };
  };
  const text = (page: Page, id: string) => page.evaluate((i) => (globalThis as unknown as { document: { getElementById(x: string): { textContent: string | null } | null } }).document.getElementById(i)?.textContent ?? '', id);
  const enter = async (page: Page, key: string, value: string | true) => {
    const f = page.locator(`[id="f-${key}"]`);
    if (value === true) await f.check();
    else if (expectedControl(key).tag === 'select') await f.selectOption(value);
    else await f.fill(value);
  };

  it('the table names every setting the setup catalogue offers, and the screen shows each with its right control', async () => {
    expect(Object.keys(TABLE).sort()).toEqual(SETUP_CATALOGUE.map((i) => i.setting.key).sort());
    expect((await items()).map((i) => i.key).sort()).toEqual(Object.keys(TABLE).sort());
    const { page, errors, close } = await open();
    try {
      for (const key of Object.keys(TABLE)) {
        const want = expectedControl(key);
        const got = await page.locator(`[id="f-${key}"]`).evaluate((n) => ({ tag: n.tagName.toLowerCase(), type: (n as unknown as { type?: string }).type }));
        expect({ key, tag: got.tag, ...(want.type ? { type: got.type } : {}) }).toEqual({ key, ...want });
        // A number editor is bounded by the catalogue's declared range — the same numbers the engine's rule checks.
        const range = setupItem(key)!.range;
        if (typeof setupItem(key)!.setting.defaultValue === 'number') {
          const attrs = await page.locator(`[id="f-${key}"]`).evaluate((n) => ({ min: n.getAttribute('min'), max: n.getAttribute('max'), step: n.getAttribute('step') }));
          expect({ key, ...attrs }).toEqual({ key, min: String(range!.min), max: range!.max === undefined ? null : String(range!.max), step: range!.whole ? '1' : 'any' });
        }
      }
      expect(errors).toEqual([]);
    } finally { await close(); }
  }, 90_000);

  it('each value the engine refuses is refused on the field in the engine\'s own words (EN and TA), Save stays off, and nothing reaches head office', async () => {
    const { page, errors, close } = await open();
    const puts: string[] = [];
    page.on('request', (r) => { if (r.method() === 'PUT') puts.push(r.url()); });
    try {
      for (const [key, row] of Object.entries(TABLE)) {
        if (row.bad === undefined) continue;
        const words = setupItem(key)!.validate!(row.bad.value);
        expect(words, key).not.toBeNull();
        await enter(page, key, row.bad.enter);
        expect(await text(page, `m-${key}`), key).toContain(words!);
        expect(await page.locator(`[id="s-${key}"]`).isDisabled(), key).toBe(true);
      }
      // In Tamil the refusal is introduced in Tamil and still quotes the engine's own words.
      await page.locator('#lang').click();
      const key = 'loyalty.points_per_100_inr';
      await enter(page, key, TABLE[key]!.bad!.enter);
      const said = await text(page, `m-${key}`);
      expect(said).toMatch(/[஀-௿]/);
      expect(said).toContain(setupItem(key)!.validate!(TABLE[key]!.bad!.value)!);
      expect(puts).toEqual([]);
      expect(errors).toEqual([]);
    } finally { await close(); }
    for (const i of await items()) expect({ key: i.key, version: i.version }).toEqual({ key: i.key, version: 0 });
  }, 120_000);

  it('the owner changes every setting on the screen; head office holds each new value, versioned, and still after a restart', async () => {
    const { page, errors, close } = await open();
    try {
      // Every setting is tried; any the screen will not save is named with what the field said, all at once.
      const notSaved: string[] = [];
      for (const [key, row] of Object.entries(TABLE)) {
        await enter(page, key, row.enter);
        if (await page.locator(`[id="s-${key}"]`).isDisabled()) { notSaved.push(`${key}: ${await text(page, `m-${key}`)}`); continue; }
        await page.locator(`[id="s-${key}"]`).click();
        await page.waitForFunction((k) => /Saved/.test((globalThis as unknown as { document: { getElementById(i: string): { textContent: string | null } | null } }).document.getElementById(`m-${k}`)?.textContent ?? ''), key, { timeout: 15_000 })
          .catch(async () => { notSaved.push(`${key}: ${await text(page, `m-${key}`)}`); });
      }
      // OB-288 P1 (M01-FR-02 "owner approval for currency/precision and trading-day changes") and OB-336 (time zone, till spend
      // cap, bulk-publish threshold): those are refused for one person, in head office's own words on the screen, and nothing
      // of them is kept.
      expect(notSaved.filter((n) => !HIGH_IMPACT.some((k) => n.startsWith(`${k}:`)))).toEqual([]);
      for (const k of HIGH_IMPACT) expect(notSaved.find((n) => n.startsWith(`${k}:`))).toMatch(/is high-impact: the owner approves it first/);
      expect(errors).toEqual([]);
    } finally { await close(); }
    const want = Object.entries(TABLE).map(([key, row]) => (HIGH_IMPACT.includes(key)
      ? { key, value: setupItem(key)!.setting.defaultValue, version: 0, isDefault: true }
      : { key, value: row.stored, version: 1, isDefault: false })).sort((a, b) => a.key.localeCompare(b.key));
    const held = async () => (await items()).map((i) => ({ key: i.key, value: i.value, version: i.version, isDefault: i.isDefault })).sort((a, b) => a.key.localeCompare(b.key));
    expect(await held()).toEqual(want);
    await shop.restart();
    expect(await held()).toEqual(want);
    // And the reopened screen shows the kept values in the editors.
    const again = await open();
    try {
      expect(await again.page.locator('[id="f-loyalty.points_per_100_inr"]').inputValue()).toBe('2');
      // OB-336: the till's spend cap was refused for one person, so the editor still shows the owner's ₹500 default.
      expect(await again.page.locator('[id="f-loyalty.till_spend_cap_paise"]').inputValue()).toBe('50000');
      expect(await again.page.locator('[id="f-pos.licence_hours.enabled"]').isChecked()).toBe(true);
      expect(again.errors).toEqual([]);
    } finally { await again.close(); }
  }, 180_000);

  it('the setup page\'s own script is kept by the worker: with the network cut it still opens and shows what head office last said (round 13)', async () => {
    // setup.js registered the worker but was missing from its SHELL, so offline the cached page came back without the
    // script that draws it — an empty frame of "—". The worker now keeps it, like every other back-office view.
    const context = await browser.newContext();
    await shop.signIn(context, OWNER);
    try {
      const page = await context.newPage();
      const failed: string[] = [];
      page.on('requestfailed', (r) => failed.push(new URL(r.url()).pathname));
      await page.goto(`${shop.base}/setup`, { waitUntil: 'load' });
      await page.evaluate('navigator.serviceWorker.ready.then(() => true)');
      await page.waitForFunction('navigator.serviceWorker.controller !== null', undefined, { timeout: 15_000 });
      expect(await page.evaluate("caches.match('./setup.js').then((r) => r !== undefined)")).toBe(true);
      await (await context.newCDPSession(page)).send('Network.clearBrowserCache');
      await context.setOffline(true);
      await page.reload({ waitUntil: 'load' });
      expect(await page.evaluate("fetch(location.href, { method: 'POST', cache: 'no-store', body: 'probe' }).then(() => 'reached', () => 'cut')")).toBe('cut');
      expect(await page.evaluate("typeof window.shellCachedAt === 'string'")).toBe(true);
      expect(failed.filter((f) => f.endsWith('.js'))).toEqual([]);
      expect((await page.textContent('#headline-text'))?.trim()).not.toBe('—');
      expect(await page.locator('[id="f-loyalty.points_per_100_inr"]').getAttribute('type')).toBe('number');
    } finally { await context.close(); }
  }, 90_000);
});
