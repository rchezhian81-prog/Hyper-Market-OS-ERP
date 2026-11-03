import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startW4Shop, openAs, says, type W4Shop } from './lib/w4-office-shop';

/**
 * **W5 · OB-212 (R4 B20–B22) — the EPR records a person keeps, on the EPR registers page, in a real browser, on the
 * production API surface over real PostgreSQL when DATABASE_URL is set.** Before W5 the page showed the registers but every
 * record other than a take-back could only be made by a programmer. Through Chromium:
 *   • the OWNER confirms the plastic registration number with who confirmed it — the answer at the top of the page turns
 *     "Confirmed" (it was "Not confirmed");
 *   • marks two products own brand — one with its packaging to the milligram, one with none, which the register lists as
 *     "packaging not declared" (never counted as zero);
 *   • adds a registered recycler and one with no number, then records the second one's number under the same recycler;
 *   • hands the shop's old till to the registered recycler naming its fixed asset, and records that a disposed steel rack was
 *     not e-waste — the disposed-asset exceptions clear;
 *   • counts the take-back bin at 500 g when the register holds nothing — the page says the count differs and the register
 *     lists the exception; the page reads in Tamil;
 *   • a STORE MANAGER records on the registers but is not offered the answers (the owner's or the CA's to confirm).
 * Every record is held by head office afterwards (read back over the API, after a restart).
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER = 'u-owner'; const MGR = 'u-mgr';

describe.skipIf(!existsSync(CHROMIUM))('EPR records (OB-212): answers, own-brand packaging, recyclers, the shop\'s e-waste, bin counts — in a real browser', () => {
  let browser: Browser;
  let shop: W4Shop;
  const T = randomUUID();
  const act = (path: string, body: unknown) => shop.ho().request({ method: 'POST', path, userId: OWNER, tenantId: T, idempotencyKey: `seed-${randomUUID()}`, body });
  const read = async <B>(path: string): Promise<B> => (await shop.ho().request({ method: 'GET', path, userId: OWNER, tenantId: T })).body as B;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startW4Shop({ tenantId: T, databaseUrl: DATABASE_URL, pages: { '/epr': { html: 'epr.html', dataGlobal: 'eprData' } } });
    await shop.ho().seedOwner(T, OWNER);
    await shop.ho().provisionRole(T, MGR, 'store_manager');
    expect((await act('/v1/org/nodes/C1', { kind: 'company', name: 'SRE Retail (test)' })).status).toBeLessThan(300);
    expect((await act('/v1/org/nodes/br-1', { kind: 'branch', name: 'br-1', parentId: 'C1', companyId: 'C1' })).status).toBeLessThan(300);
    for (const [id, name, category] of [['FA-TILL', 'Till 3', 'IT equipment'], ['FA-RACK', 'Display rack', 'Furniture']] as const) {
      expect((await act(`/v1/finance/fixed-assets/${id}`, { name, category, storeId: 'br-1', costMinor: 5_000_000, salvageMinor: 0, usefulLifeMonths: 60, inServiceDate: '2025-04-01' })).status).toBeLessThan(300);
      expect((await act(`/v1/finance/fixed-assets/${id}/dispose`, { on: '2026-10-10', proceedsMinor: 0, reason: 'end of life' })).status).toBeLessThan(300);
    }
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 240_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  it('the owner confirms an answer, declares packaging, keeps the recyclers, hands over the shop\'s e-waste and counts the bin', async () => {
    const s = await openAs(shop, browser, OWNER, '/epr');
    try {
      const p = s.page;
      await says(p, '#settings .row[data-key="plasticRegistration"] .state', /Not confirmed/);
      await p.locator('#records:not([hidden])').waitFor();
      expect(await p.isVisible('#confirm')).toBe(true);
      expect(await p.locator('#ne-asset option').count()).toBe(2);

      // The registration number, with who confirmed it.
      await p.selectOption('#cf-key', 'plasticRegistration');
      await p.fill('#cf-value', 'PWP/TN/2026/0001 (test)');
      await p.fill('#cf-by', 'CA R. Kumar (test), letter 12');
      await p.click('#cf-go');
      await says(p, '#rec-result', /^Saved: Plastic EPR registration number$/);
      await says(p, '#settings .row[data-key="plasticRegistration"] .state', /^Confirmed$/);

      // Own-brand packaging: one product to the milligram, one with nothing declared.
      await p.fill('#ob-product', 'P-JAR');
      await p.selectOption('#ob-cat-1', 'I'); await p.fill('#ob-g-1', '12.5'); await p.fill('#ob-d-1', 'jar');
      await p.selectOption('#ob-cat-2', 'II'); await p.fill('#ob-g-2', '1.2');
      await p.click('#ob-go');
      await says(p, '#own-brand li[data-product="P-JAR"]', /I: 12\.5 g per unit \(jar\) · II: 1\.2 g per unit/);
      await p.fill('#ob-product', 'P-NODECL');
      await p.click('#ob-go');
      await says(p, '#rec-result', /^Saved: P-NODECL — packaging not declared$/);
      await says(p, '#own-brand li[data-product="P-NODECL"]', /packaging not declared/);

      // Recyclers: one registered, one not — then the second one's number, under the same recycler.
      await p.fill('#rc-name', 'Green Recyclers (test)'); await p.fill('#rc-number', 'TNPCB-EW-TEST-0001');
      await p.click('#rc-go');
      await says(p, '#rec-result', /^Saved: Green Recyclers \(test\)$/);
      await p.fill('#rc-name', 'Street collector (test)');
      await p.click('#rc-go');
      await says(p, '#rec-result', /^Saved: Street collector \(test\) \(no registration number\)$/);
      await says(p, '#rc-which', /Street collector \(test\) \(no registration number\)/);
      const street = await p.locator('#rc-which option', { hasText: 'Street collector' }).getAttribute('value');
      await p.selectOption('#rc-which', street!);
      expect(await p.inputValue('#rc-name')).toBe('Street collector (test)');
      await p.fill('#rc-number', 'TNPCB-EW-TEST-0002');
      await p.click('#rc-go');
      await says(p, '#rc-which', /Street collector \(test\) — TNPCB-EW-TEST-0002/);
      await says(p, '#ho-recycler', /Street collector \(test\) — TNPCB-EW-TEST-0002/);

      // The shop's own old till, to the registered recycler, naming its fixed asset; a steel rack that was not e-waste.
      const green = await p.locator('#sh-recycler option', { hasText: 'Green Recyclers' }).getAttribute('value');
      await p.selectOption('#sh-kind', 'e_waste'); await p.selectOption('#sh-recycler', green!);
      await p.fill('#sh-what', 'Till 3'); await p.fill('#sh-weight', '9500'); await p.selectOption('#sh-asset', 'FA-TILL'); await p.fill('#sh-note', 'HN-TILL-1');
      await p.click('#sh-go');
      await says(p, '#rec-result', /^Saved: 9500 g → TNPCB-EW-TEST-0001$/);
      await expect.poll(() => p.locator('#ne-asset option').count()).toBe(1);
      await p.selectOption('#ne-asset', 'FA-RACK'); await p.fill('#ne-why', 'steel rack, no electrics');
      await p.click('#ne-go');
      await says(p, '#rec-result', /^Saved: FA-RACK$/);
      await says(p, '#ne-none', /No disposed asset is waiting/);
      await expect.poll(() => p.locator('#takeback-exceptions .row[data-exception="FA-RACK"]').count()).toBe(0);

      // Count the bin: 500 g where the register holds none — the count differs, and the register lists it.
      await p.selectOption('#ct-kind', 'e_waste'); await p.fill('#ct-grams', '500');
      await p.click('#ct-go');
      await says(p, '#rec-result', /^The count differs from the register/);
      await says(p, '#takeback-exceptions', /Count differs/);

      // Tamil.
      await p.click('#lang');
      await says(p, '#records h3[data-w="ownBrandH"]', /^சொந்த பிராண்ட் பொதி$/);
      await says(p, '#cf-go', /^பதிலைச் சேமி$/);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    // Head office holds every record — after a restart.
    await shop.restart();
    const settings = await read<{ settings: { key: string; status: string }[] }>('/v1/compliance/epr/settings');
    expect(settings.settings.find((x) => x.key === 'plasticRegistration')?.status).toBe('confirmed');
    const ob = await read<{ declarations: { productId: string; packaging: { weightPerUnitMg: number }[] }[] }>('/v1/compliance/epr/own-brand');
    expect(ob.declarations.map((d) => [d.productId, d.packaging.map((x) => x.weightPerUnitMg)])).toEqual([['P-JAR', [12_500, 1_200]], ['P-NODECL', []]]);
    const tb = await read<{ handovers: { source: string; lines: { assetId?: string }[] }[]; exceptions: { assets: unknown[]; stock: { differenceGrams: number }[] }; recyclers: { name: string; registered: boolean }[] }>('/v1/compliance/epr/take-back');
    expect(tb.handovers).toEqual([expect.objectContaining({ source: 'shop', lines: [expect.objectContaining({ assetId: 'FA-TILL' })] })]);
    expect(tb.exceptions.assets).toEqual([]);
    expect(tb.exceptions.stock.map((e) => e.differenceGrams)).toEqual([500]);
    expect(tb.recyclers.every((r) => r.registered)).toBe(true);
  }, 180_000);

  it('a store manager records on the registers but is not offered the answers to confirm', async () => {
    const s = await openAs(shop, browser, MGR, '/epr');
    try {
      await s.page.locator('#records:not([hidden])').waitFor();
      await says(s.page, '#confirm-none', /^Only the owner or the CA confirms these answers\.$/);
      expect(await s.page.isVisible('#confirm')).toBe(false);
      expect(await s.page.isVisible('#declare')).toBe(true);
      await s.page.fill('#ob-product', 'P-MGR');
      await s.page.selectOption('#ob-cat-1', 'III'); await s.page.fill('#ob-g-1', '0.75');
      await s.page.click('#ob-go');
      await says(s.page, '#own-brand li[data-product="P-MGR"]', /III: 0\.75 g per unit/);
      expect(s.writes).toEqual(['POST /v1/compliance/epr/own-brand/P-MGR']);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  }, 120_000);
});
