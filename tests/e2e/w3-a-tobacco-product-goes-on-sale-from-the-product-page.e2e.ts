import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';
import { says } from './lib/r4c-box-page';
import { regulatedPublishBody } from '../support/approval-request';
import type { ApiHarness } from '../support/api-harness';

/**
 * **W3 (D01-FR-05 "regulated-item flags" · B16 · COTPA 2003 s.7 · OB-140 "A") — a tobacco product is put on sale from the
 * Product details page, in a real browser, on the PRODUCTION API over real PostgreSQL.** No screen reached these routes
 * before, so a tobacco product could not be put on sale through the screens.
 *   • the cigarettes are a draft head office will not activate: the page lists them "Not on sale · no warning picture on
 *     record", and putting them on sale is refused (tobacco_warning_not_confirmed);
 *   • the OWNER records the government's warning picture on the page (a bad id is refused on the page, nothing sent);
 *   • the store manager — who may confirm but not record a picture, and is offered no picture form — confirms, in her own
 *     name, that the packs carry it, naming what she looked at; head office holds HER name on the confirmation;
 *   • the product is then published (with the second person's approval a tobacco product needs) and is on sale; the page
 *     says "On sale · confirmed by u-mgr-br1".
 * Synthetic data, a fresh tenant. Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['w3', 'tobacco', 'e2e', 'key'].join('-').padEnd(48, '0');
const ACCOUNTANT = 'u-acct';
const TOBACCO = { categoryId: 'tobacco', name: 'Tobacco', parentId: null, regulated: ['age_restricted'] };
const CIGARETTES = { sku: 'CIG10', name: 'Cigarettes 10s (demo)', baseUom: 'ea', primaryCategoryId: 'tobacco', taxClass: '24022010', lifecycle: 'draft', safety: { minimumAge: 18, tobacco: true, packMinimumMinor: 1 } };

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('a tobacco product goes on sale from the Product details page (D01-FR-05)', () => {
  let browser: Browser;
  let shop: InboxShop;
  const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown) =>
    shop.cloud().request({ method, path, userId, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: randomUUID() }) });
  /** The approval helpers speak the in-process harness's shape; the real API takes the same calls over HTTP. */
  const asHarness = (): ApiHarness => ({
    request: (r: { method: 'GET' | 'POST'; path: string; userId: string; body?: unknown; idempotencyKey?: string }) =>
      shop.cloud().request({ method: r.method, path: r.path, userId: r.userId, ...(r.body === undefined ? {} : { body: r.body }), ...(r.idempotencyKey === undefined ? {} : { idempotencyKey: r.idempotencyKey }) }),
  } as unknown as ApiHarness);

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/product-details', html: 'product-details.html', dataGlobal: 'productDetailsData' },
      seed: async (cloud) => {
        await cloud.grant(ACCOUNTANT, 'accountant');
        const req = (path: string, body: unknown) => cloud.request({ method: 'POST', path, userId: OWNER, body, idempotencyKey: `seed-${randomUUID()}` });
        await ok(req('/v1/catalogue/tax-classes/24022010/rates/2017-07-01', { rateBps: 2_800 }), 'tax');
        await ok(req('/v1/catalogue/products/p-cig/publish', { product: CIGARETTES, categories: [TOBACCO] }), 'draft');
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  const open = async (who: string) => {
    const context = await browser.newContext();
    await shop.signIn(context, who, 'br-1');
    const page = await context.newPage();
    const writes: string[] = []; const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${u.pathname}`); });
    await page.goto(`${shop.base}/product-details`, { waitUntil: 'load' });
    return { page, writes, errors, close: () => context.close() };
  };

  it('the owner records the picture, the manager confirms the packs in her name, and the product then goes on sale', async () => {
    const sellNow = await call('POST', '/v1/catalogue/products/p-cig/publish', OWNER, { product: { ...CIGARETTES, lifecycle: 'active' }, categories: [TOBACCO] });
    expect((sellNow.body as { error?: { code?: string } }).error?.code).toBe('tobacco_warning_not_confirmed');

    // ── the owner records the government's picture
    const o = await open(OWNER);
    await o.page.waitForSelector('#tobacco:not([hidden])');
    await says(o.page, '#pictures-now', /No warning picture is on record yet/);
    await says(o.page, '#tobacco-rows li[data-product="p-cig"]', /Cigarettes 10s \(demo\) \(p-cig\) — Not on sale · no warning picture on record/);
    expect(await o.page.locator('#tobacco-rows button').count()).toBe(0); // nothing to confirm against yet
    await o.page.fill('#tw-id', 'GSR 2019!');
    await o.page.fill('#tw-notified', '2019-10-01'); await o.page.fill('#tw-from', '2020-01-01');
    await o.page.fill('#tw-ref', 'G.S.R. 2019 (demo)'); await o.page.fill('#tw-evidence', 'DOC-gsr-2019');
    await o.page.click('#tw-record');
    await says(o.page, '#picture-status', /^Type a picture id/);
    expect(o.writes).toEqual([]);
    await o.page.fill('#tw-id', 'P-2020');
    await o.page.click('#tw-record');
    await says(o.page, '#picture-status', /^Recorded: P-2020\.$/);
    await says(o.page, '#pictures-now', /In force today: P-2020/);
    await says(o.page, '#picture-rows li[data-picture="P-2020"]', /P-2020 — In force from 2020-01-01/);
    expect(o.writes).toEqual(['POST /v1/catalogue/tobacco-warning-pictures/P-2020']);
    expect(o.errors).toEqual([]);
    await o.close();

    // ── the store manager confirms the packs, in her own name; she is offered no picture form
    const m = await open(MGR);
    await m.page.waitForSelector('#tobacco:not([hidden])');
    expect(await m.page.isVisible('#picture-form')).toBe(false);
    await says(m.page, '#tobacco-rows li[data-product="p-cig"]', /Not on sale · its packs were never confirmed/);
    expect(await m.page.inputValue('#tc-picture-p-cig')).toBe('P-2020');
    await m.page.click('#tc-go-p-cig');
    await says(m.page, '#confirm-status', /^Say where the evidence is kept\.$/);
    expect(m.writes).toEqual([]);
    await m.page.fill('#tc-evidence-p-cig', 'PHOTO-pack-front');
    await m.page.click('#tc-go-p-cig');
    await says(m.page, '#confirm-status', /Confirmed, in your name\. Save the product again on its Record tab to put it on sale\./);
    expect(m.writes).toEqual(['POST /v1/catalogue/products/p-cig/tobacco-warning-confirmation']);
    const held = (await call('GET', '/v1/catalogue/products/p-cig', OWNER)).body as { product?: { tobaccoWarning?: { confirmations: { confirmedBy: string; evidenceRef: string }[] } }; tobaccoWarning?: { confirmations: { confirmedBy: string; evidenceRef: string }[] } };
    const confirmations = (held.product ?? held).tobaccoWarning?.confirmations ?? [];
    expect(confirmations).toEqual([expect.objectContaining({ confirmedBy: MGR, evidenceRef: 'PHOTO-pack-front' })]);

    // ── now head office puts it on sale (a tobacco product reaching the tills needs a second person's approval as well)
    const body = await regulatedPublishBody(asHarness(), shop.cloud().tenantId, 'p-cig', { product: CIGARETTES, categories: [TOBACCO] }, OWNER, ACCOUNTANT);
    const activated = await call('POST', '/v1/catalogue/products/p-cig/publish', OWNER, body);
    expect(activated.status, JSON.stringify(activated.body)).toBeLessThan(300);
    expect((activated.body as Record<string, unknown>)['activation']).toBeUndefined();
    await m.page.reload({ waitUntil: 'load' });
    await says(m.page, '#tobacco-rows li[data-product="p-cig"]', new RegExp(`On sale · confirmed by ${MGR}`));
    await m.page.click('#lang');
    await says(m.page, '#tobacco-h', /^புகையிலை சுகாதார எச்சரிக்கை$/);
    expect(m.errors).toEqual([]);
    await m.close();
  }, 180_000);
});
