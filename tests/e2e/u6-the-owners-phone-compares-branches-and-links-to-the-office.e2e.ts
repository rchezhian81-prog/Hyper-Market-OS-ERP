import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { auditPage } from './lib/a11y-audit';
import { serveShell } from './lib/device-screens';

/**
 * **U6 · M29-FR-02 · OB-701 (owner, 7 Nov 2026, decision 4 = B) — the owner's phone, in real Chromium at 360px: two
 * branches SIDE BY SIDE with their own figures and data age, and LINKS to the office's audit log and system health (never a
 * copy).** A branch that never reached the phone says "Not known" on every figure; the links carry the public prefix the
 * store computer gave; one shop shows no comparison; both languages audited.
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const PHONE = { viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true };
const NOW = Date.now();
const SALE = (saleId: string, totalMinor: number, cogsMinor: number) => ({ saleId, netMinor: totalMinor, taxMinor: 0, totalMinor, cogsMinor, units: 2, tender: 'cash', currency: 'INR' });
const DATA = (branches: unknown[]) => ({
  ownerId: 'u-owner', staleAfterSeconds: 900, approvalLimitMinor: 10_000_000_00, branches,
});
const MAIN = { branchId: 'b1', name: 'Main', lastSyncedAt: new Date(NOW - 60_000).toISOString(), sales: [SALE('s1', 500_00, 300_00), SALE('s2', 250_00, 100_00)], exceptions: [], approvals: [{ id: 'a1', subjectType: 'price_change', subjectRef: 'Toor dal 1kg', requestedBy: 'u-buyer', branchId: 'b1', valueMinor: 45_000 }] };
const ANNEXE = { branchId: 'b2', name: 'Annexe', lastSyncedAt: null, sales: [], exceptions: [], approvals: [] };
const OFFICE = { auditLog: '/shop/audit-log', storeComputers: '/shop/store-computers', compare: '/shop/branch-compare' };

describe.skipIf(!existsSync(CHROMIUM))('the owner\'s phone compares branches and links to the office', () => {
  let browser: Browser;
  const stops: (() => Promise<void>)[] = [];
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'owner-app'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });

  async function open(globals: Record<string, unknown>): Promise<Page> {
    const srv = await serveShell('owner-app', globals);
    stops.push(srv.stop);
    const context = await browser.newContext(PHONE);
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`${srv.base}/`, { waitUntil: 'load' });
    await page.waitForFunction('globalThis.ownerSession !== undefined', undefined, { timeout: 15_000 });
    return page;
  }

  it('two branches side by side — figures and data age each their own, "Not known" for the one that never reached the phone; the office links; English and Tamil audited', async () => {
    const page = await open({ ownerData: DATA([MAIN, ANNEXE]), ownerOffice: OFFICE });
    await page.waitForSelector('#compare-section:not([hidden])');
    const cards = page.locator('#compare .cmp');
    expect(await cards.count()).toBe(2);
    expect(await page.textContent('#compare .cmp[data-branch="b1"] .cmp-name')).toBe('Main');
    expect(await page.textContent('#compare .cmp[data-branch="b1"] .cmp-grid')).toContain('₹750.00');
    expect(await page.textContent('#compare .cmp[data-branch="b1"] .cmp-grid')).toContain('₹350.00');
    expect(await page.textContent('#compare .cmp[data-branch="b1"] .cmp-age')).toContain('Data:');
    // The branch that never reached the phone: every figure "Not known", never ₹0.00, and said so on its data line.
    const annexe = await page.textContent('#compare .cmp[data-branch="b2"]');
    expect(annexe).not.toContain('₹0.00');
    expect(await page.locator('#compare .cmp[data-branch="b2"] dd.unknown').count()).toBe(5);
    expect(await page.textContent('#compare .cmp[data-branch="b2"] .cmp-age')).toContain('No data has ever reached this phone');
    // Reading the comparison did not move the branch in view.
    expect(await page.getAttribute('#branches button:first-child', 'aria-current')).toBe('page');

    // The office links: the office's own pages, under the prefix the store computer gave — never a copy on the phone.
    const links = page.locator('#office-links a.office-link');
    expect(await links.count()).toBe(3);
    expect(await links.nth(0).getAttribute('href')).toBe('/shop/audit-log');
    expect(await links.nth(1).getAttribute('href')).toBe('/shop/store-computers');
    expect(await links.nth(2).getAttribute('href')).toBe('/shop/branch-compare');
    expect(await page.textContent('#office-note')).toBe('These open the office\'s own pages. Nothing is copied to this phone.');
    // U7: the owner phone carries one main heading — the header's title is the page's h1 (the audit's one-h1 rule holds).
    expect(await page.locator('h1').count()).toBe(1);
    expect(await page.textContent('h1#title')).toBe('Today · SRE Hyper Market');
    expect(await auditPage(page, { expectLang: 'en' })).toEqual([]);

    await page.click('#lang');
    expect(await page.textContent('#compare-title')).toBe('கிளைகள் அருகருகே');
    expect(await page.textContent('#office-title')).toBe('அலுவலகத்திலும்');
    expect(await links.nth(0).textContent()).toBe('தணிக்கைப் பதிவு — யார் என்ன செய்தார்');
    expect(await page.textContent('h1#title')).toBe('இன்று · SRE Hyper Market');
    expect(await auditPage(page, { expectLang: 'ta' })).toEqual([]);
  });

  it('one shop: no comparison; served without the office links the section says so rather than guessing a path', async () => {
    const page = await open({ ownerData: DATA([MAIN]) });
    expect(await page.isHidden('#compare-section')).toBe(true);
    expect(await page.locator('#office-links a').count()).toBe(0);
    expect(await page.textContent('#office-note')).toBe('The office links are not on this copy of the app.');
  });
});
