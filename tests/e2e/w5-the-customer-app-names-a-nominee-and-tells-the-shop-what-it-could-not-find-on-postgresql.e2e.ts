import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { chromium } from 'playwright-core';
import { CHROMIUM, CONNECTED, OWNER, ok, startBoxPageOnCloud, type BoxCloudShop } from './lib/box-page-on-cloud';
import { says } from './lib/r4c-box-page';
import { startCustomerShopOnCloud, inviteAppCustomer, type CloudCustomerShop } from './lib/customer-shop-on-cloud';
import { seedOnlineCatalogue, listShopOnline, type ShopCalls, type Res } from '../support/online-shop';
import { setUpPracticeStores, type RealCloud } from '../support/real-store';
import { pinTheEveningClock, pinThePageClock } from '../support/evening-clock';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';

/**
 * **W5 · C5 (DPDP s.14) · D02-FR-04 (OB-319) — ONE connected run: the real customer app in Chromium and the staff's Customer
 * data requests page in Chromium (served by a REAL store computer), both on the PRODUCTION API over real PostgreSQL.**
 * Synthetic data only; the sign-in goes through the product's own one-time-code service with the RECORDING stub SMS port —
 * nothing is sent anywhere (OB-562).
 *
 *   • C5 — in "My information" the customer names a nominee (by reference and relationship, no name or phone kept): the app
 *     shows what the SHOP holds, read back; she withdraws it in one tap, and names one again;
 *   • C5 — the staff's Customer data requests page shows that nomination and its history; the manager records that the
 *     death certificate was checked; head office holds the verification under the manager's name;
 *   • D02-FR-04 — a FINISHED search that found nothing ("saffron") is told to the shop — the words only — and head office's
 *     range-gap report counts it; a search that found something is not told.
 * The evening clock is pinned (the shop's date is ahead of UTC then), so the range-gap window is the SHOP's today.
 * Needs DATABASE_URL and Chromium; else it SKIPS.
 */

const STORE = 'br-1';
const MGR = 'u-mgr';
const PHONE = '+919000000521';
const SUBJECT = 'cust-w5-c5';
const STORE_AT = { lat: 11.0168, lon: 76.9558 };
const NEARBY = { latitude: 11.02, longitude: 76.96 };

const callsOn = (cloud: () => RealCloud): ShopCalls => {
  const req = (method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, userId = OWNER, query?: Record<string, string>): Promise<Res> =>
    cloud().request({ method, path: query === undefined ? path : `${path}?${new URLSearchParams(query).toString()}`, userId, ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });
  const okc = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`); return r; };
  return { req, ok: okc };
};
type Doc = { document: { getElementById(id: string): { hidden: boolean } | null } };

describe.skipIf(!CONNECTED)('W5 · C5 + D02-FR-04 connected: the customer app names a nominee and tells the shop what it could not find, on PostgreSQL', () => {
  let shop: BoxCloudShop;
  let app: CloudCustomerShop;
  let browser: Browser;

  beforeAll(async () => {
    pinTheEveningClock();
    execFileSync('node', ['scripts/build-app.mjs', 'customer-app'], { stdio: 'ignore' });
    shop = await startBoxPageOnCloud({
      name: 'w5-c5-customer-app', store: STORE,
      people: [{ userId: OWNER }, { userId: MGR, branchId: STORE }],
      seed: async (cloud) => {
        const c = callsOn(() => cloud);
        await setUpPracticeStores(cloud, OWNER, [STORE]);
        for (const f of ['customer_app', 'delivery', 'loyalty']) await c.ok(c.req('PUT', `/v1/platform/entitlements/${f}`, { enabled: true }), `feature ${f}`);
        await cloud.grant(MGR, 'store_manager', undefined, [STORE]);
        await seedOnlineCatalogue(c, STORE);
        await listShopOnline(c);
        await c.ok(c.req('PUT', '/v1/serviceability/delivery-service', { storeLocation: STORE_AT, slotsPerDay: 8, windowOpen: '09:00', windowClose: '21:00', capacityPerSlot: 10, leadMinutes: 60 }), 'delivery service');
        await inviteAppCustomer(cloud, { customerId: SUBJECT, displayName: 'Kavitha Raman (synthetic)', inviter: MGR, inviterBranch: STORE, approver: OWNER });
      },
    });
    const c = callsOn(() => shop.cloud);
    const pack = (await c.ok(c.req('GET', '/v1/catalogue/pack'), 'pack')).body as { snapshot: { version: number; products: { productId: string; name: string; unitPriceMinor: number; baseUom: string }[] } };
    app = await startCustomerShopOnCloud({
      cloud: () => shop.cloud, subject: SUBJECT,
      shopData: async () => ({
        tenantId: shop.cloud.tenantId, customerRef: 'guest', packVersion: pack.snapshot.version, locationId: STORE,
        products: pack.snapshot.products.map((p) => ({ productId: p.productId, name: p.name, categoryId: 'x', unitPriceMinor: p.unitPriceMinor, uom: p.baseUom, barcodes: [], status: 'active', availableMinor: 5, availabilityAgeMinutes: 1 })),
        slots: [], storeLocation: STORE_AT, policy: { radiusMetres: 10_000, deliveryFeeMinor: 40_00 }, deliveryFeeMinor: 40_00,
        consentPurposes: [{ purpose: 'marketing', channel: 'sms' }],
      }),
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await app?.stop(); await shop?.stop(); vi.useRealTimers(); });

  async function phone(): Promise<{ ctx: BrowserContext; page: Page; errors: string[] }> {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, geolocation: NEARBY, permissions: ['geolocation'] });
    await pinThePageClock(ctx);
    const page = await ctx.newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${app.base}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as Doc).document.getElementById('sample')?.hidden === true, undefined, { timeout: 10_000 });
    return { ctx, page, errors };
  }
  async function signIn(page: Page): Promise<void> {
    await page.click('#tab-basket');
    await page.fill('#si-phone', PHONE);
    await page.click('#si-send');
    await page.waitForSelector('#si-step-code:not([hidden])');
    const code = app.sms.codeFor(PHONE);
    expect(code, 'the stub SMS port recorded a one-time code').toMatch(/^\d{4,8}$/);
    await page.fill('#si-code', code!);
    await page.click('#si-verify');
    await page.waitForSelector('#si-step-in:not([hidden])');
  }

  it('C5: she names, withdraws and names again her nominee in the app; the staff page shows it and the manager records the certificate was checked', async () => {
    const p = await phone();
    try {
      await signIn(p.page);
      await p.page.click('#tab-privacy');
      await says(p.page, '#nominee-now', /^You have not named a nominee\.$/);
      await p.page.fill('#nominee-ref', 'cust-w5-c5-son');
      await p.page.fill('#nominee-rel', 'son');
      await p.page.click('#nominee-save');
      await says(p.page, '#banner-text', /^Saved: cust-w5-c5-son \(son\) may exercise your privacy rights/);
      await p.page.click('#banner-ok');
      await says(p.page, '#nominee-now', /^Your nominee: cust-w5-c5-son \(son\)$/);
      await p.page.click('#nominee-withdraw');
      await says(p.page, '#banner-text', /is no longer your nominee/);
      await p.page.click('#banner-ok');
      await says(p.page, '#nominee-now', /^You have not named a nominee\.$/);
      await p.page.fill('#nominee-ref', 'cust-w5-c5-daughter');
      await p.page.fill('#nominee-rel', 'daughter');
      await p.page.click('#nominee-save');
      await p.page.click('#banner-ok');
      await says(p.page, '#nominee-now', /^Your nominee: cust-w5-c5-daughter \(daughter\)$/);
      await p.page.click('#lang');
      await says(p.page, '#nominee-title', /^என் நியமனதாரர்$/);
      expect(p.errors).toEqual([]);
    } finally { await p.ctx.close(); }

    // Head office holds the nomination, append-only: named, withdrawn, named again — under her, never an id she sent.
    const held = (await ok(shop.call('GET', `/v1/privacy/nominees/${SUBJECT}`, OWNER), 'nominee read')) as { current: { nomineeRef: string }; history: { action: string }[] };
    expect(held.current.nomineeRef).toBe('cust-w5-c5-daughter');
    expect(held.history.map((h) => h.action)).toEqual(['recorded', 'withdrawn', 'recorded']);

    // The manager, on the store computer's Customer data requests page.
    const m = await shop.open(MGR, '/data-requests/');
    try {
      await says(m.page, '#desk-nominee-h', /^The customer's nominee$/);
      expect(m.writes, 'nothing is written on open').toEqual([]);
      await m.page.fill('#cd-nominee-customer', SUBJECT);
      await m.page.click('#cd-nominee-form-go');
      await says(m.page, '#cd-nominee-current', /^Nominee: cust-w5-c5-daughter \(relationship: daughter\)$/);
      await says(m.page, '#cd-nominee-history', /named — cust-w5-c5-son \(son\).*withdrawn.*named — cust-w5-c5-daughter \(daughter\)/);
      await says(m.page, '#cd-nominee-verified', /^Nothing on record\.$/);
      await m.page.selectOption('#cd-nominee-basis', 'death');
      await m.page.fill('#cd-nominee-evidence', 'DC-2026-0042');
      await m.page.click('#cd-nominee-act-go');
      await says(m.page, '#cd-nominee-verified', /cust-w5-c5-daughter — death · DC-2026-0042 · by u-mgr/);
      expect(m.errors).toEqual([]);
    } finally { await m.close(); }
    const after = (await ok(shop.call('GET', `/v1/privacy/nominees/${SUBJECT}`, OWNER), 'nominee read')) as { activations: { verifiedBy: string; basis: string; evidenceRef: string }[] };
    expect(after.activations).toEqual([expect.objectContaining({ verifiedBy: MGR, basis: 'death', evidenceRef: 'DC-2026-0042' })]);
  }, 240_000);

  it('D02-FR-04: a finished search that found nothing is told to the shop (the words only); one that found something is not', async () => {
    const p = await phone();
    try {
      await signIn(p.page);
      const sent: string[] = [];
      p.page.on('response', (r) => { if (r.url().includes('search-misses')) sent.push(`${r.request().method()} ${r.status()}`); });
      await p.page.click('#tab-shop');
      await p.page.fill('#search', 'milk');
      await p.page.press('#search', 'Enter');
      await p.page.fill('#search', 'Saffron  Strands');
      await p.page.press('#search', 'Enter');
      await says(p.page, '#results-empty', /./);
      await p.page.click('#tab-basket');
      await expect.poll(() => sent).toEqual(['POST 201']);
      expect(p.errors).toEqual([]);
    } finally { await p.ctx.close(); }
    const today = shopDateIn(new Date().toISOString());
    await expect.poll(async () => {
      const r = (await shop.call('GET', `/v1/merchandising/range-gaps?from=${today}&to=${today}`, OWNER)).body as { searchesWithNoResult?: { words: string; count: number }[] };
      return r.searchesWithNoResult ?? [];
    }, { timeout: 15_000 }).toEqual([{ words: 'saffron strands', count: 1 }]);
  }, 180_000);
});
