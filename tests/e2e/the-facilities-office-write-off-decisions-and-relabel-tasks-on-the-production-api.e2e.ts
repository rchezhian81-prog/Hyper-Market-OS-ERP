import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, type InboxShop } from './lib/ai-inbox-shop';
import { STORE_RULES } from '../support/store-rules';

/**
 * OB-288 LP/workforce package — three head-office screens in a real browser, on the PRODUCTION API over real PostgreSQL:
 *   • the Facilities page's office read (M26-FR-01/02/04): the asset register, a critical asset with no AMC, a cold room
 *     whose last reading is in range, the open incident — read on a click, nothing changed;
 *   • the Record-a-loss page's captured losses (M28-FR-01 "approval on sync"): a big loss the store computer carried waits
 *     for a second person, who approves it with a reason — the raiser cannot;
 *   • the Store tasks page's relabel tasks (D11-FR-03): a price change raised one per shelf place; one is closed with the
 *     price the new label shows and its photo — a label at another price is refused and the task stays open.
 * Needs DATABASE_URL and Chromium; else it SKIPS. Synthetic data only.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['lpw', 'office', 'e2e', 'key'].join('-').padEnd(48, '0');
const ago = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the facilities office, captured losses and relabel tasks (OB-288 LP/workforce) on the production API, in a real browser', () => {
  let browser: Browser;
  let shop: InboxShop;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/facilities', html: 'facilities.html', dataGlobal: 'facilitiesData' },
      alsoPages: [
        { path: '/write-off-capture', html: 'write-off-capture.html', dataGlobal: 'writeOffCaptureData' },
        { path: '/store-tasks', html: 'store-tasks.html', dataGlobal: 'storeOpsData' },
        { path: '/my-tasks', html: 'my-tasks.html', dataGlobal: 'storeOpsData' },
      ],
      seed: async (cloud) => {
        const post = (path: string, userId: string, body: unknown, method: 'POST' | 'PUT' = 'POST', branchId?: string) =>
          ok(cloud.request({ method, path, userId, idempotencyKey: `seed-${path}-${userId}`, body, ...(branchId === undefined ? {} : { branchId }) }), path);
        await cloud.grant('u-mgr', 'store_manager');
        await cloud.grant('u-mgr2', 'store_manager');
        await cloud.grant('box-1', 'store_computer', undefined, ['br-1']);
        await post('/v1/stores/br-1/rules', 'u-owner', { ...STORE_RULES, marginFloorBps: 0 });
        // Facilities: a critical cold room with no AMC, its range, a reading in range, an open incident.
        await post('/v1/facilities/assets/cold-1', 'u-owner', { branchId: 'br-1', name: 'Cold room 1', kind: 'cold_room', criticality: 'critical', installedOn: '2020-01-01', protectsValueMinor: 800_000 });
        await post('/v1/facilities/equipment/cold-1/range', 'u-owner', { branchId: 'br-1', name: 'Cold room 1', minTenthsC: 0, maxTenthsC: 80, graceMinutes: 30, expectEveryMinutes: 120 });
        await post('/v1/facilities/equipment/cold-1/readings/rd-1', 'u-mgr', { tenthsC: 40, at: ago(10), source: 'manual_probe', recordedBy: 'u-mgr' });
        await post('/v1/facilities/incidents/I1', 'u-mgr', { branchId: 'br-1', kind: 'near_miss', severity: 'minor', occurredAt: ago(60), reportedAt: ago(55), reportedBy: 'u-mgr', description: 'wet floor by the chiller' });
        // A loss the store computer carried: big, with its photo — waiting for a second person.
        await post('/v1/inventory/movements', 'u-owner', { movementId: 'rcv-MILK', productId: 'MILK', locationId: 'br-1', kind: 'received', quantityMinor: 100, uom: 'ea', occurredAt: ago(600), enteredBy: 'u-owner', unitCostMinor: 5_000 });
        await post('/v1/inventory/write-off/WO-3/synced', 'box-1', { writeOffId: 'WO-3', productId: 'MILK', locationId: 'br-1', qty: 20, uom: 'ea', lossType: 'damage', reasonCode: 'damage', evidenceRef: 'photo-wo-3', raisedBy: 'u-mgr', capturedAt: ago(30), storeId: 'br-1' }, 'POST', 'br-1');
        // Relabel: the salt has two shelf places; a price change raises a task for each.
        await post('/v1/merchandising/stores/br-1/shelf-map', 'u-mgr', { locations: [{ locationId: 'L1', aisle: 1, rack: 1, bay: 1, shelf: 1, position: 1 }, { locationId: 'L2', aisle: 4, rack: 1, bay: 1, shelf: 2, position: 1 }] }, 'PUT');
        await post('/v1/merchandising/stores/br-1/planograms/PG-1', 'u-mgr', { effectiveFrom: '2026-01-01', assignments: [{ productId: 'p-salt', locationId: 'L1', capacityMinor: 10, primary: true }, { productId: 'p-salt', locationId: 'L2', capacityMinor: 10, primary: false }] }, 'PUT');
        await post('/v1/catalogue/products/p-salt/publish', 'u-owner', { product: { sku: 'SKU-SALT', name: 'Salt 1kg', baseUom: 'each', primaryCategoryId: 'grocery', taxClass: '25010020', lifecycle: 'draft' }, categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }] });
        await post('/v1/prices/changes', 'u-owner', { productId: 'p-salt', priceMinor: 1_800, mrpMinor: 2_500, costMinor: 1_000, currency: 'INR', marginFloorBps: 0, storeId: 'br-1' });
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  const open = async (who: string, path: string): Promise<{ page: Page; errors: string[]; close: () => Promise<void> }> => {
    const context = await browser.newContext();
    await shop.signIn(context, who);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${shop.base}${path}`, { waitUntil: 'load' });
    return { page, errors, close: () => context.close() };
  };
  const waitText = (page: Page, selector: string, text: string) => page.waitForFunction(([sel, want]) => {
    const node = (globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector(sel!);
    return (node?.textContent ?? '').includes(want!);
  }, [selector, text], { timeout: 15_000 });

  it('facilities office: the register, the critical asset with no AMC, the cold room in range, the open incident; no reading form off the box', async () => {
    const { page, errors, close } = await open('u-owner', '/facilities');
    await page.waitForSelector('#office:not([hidden])');
    expect(await page.isHidden('#eq')).toBe(true); // manual readings are the store computer's page
    await page.fill('#office-branch', 'br-1');
    expect(await page.locator('#office-read svg').count()).toBe(1);
    await page.click('#office-read');
    await page.waitForSelector('#office-parts:not([hidden])', { timeout: 15_000 });
    expect((await page.textContent('#o-alerts')) ?? '').toContain('Cold room 1 — No AMC recorded');
    expect((await page.textContent('#o-equipment li[data-asset="cold-1"]')) ?? '').toContain('Within range');
    expect((await page.textContent('#o-equipment li[data-asset="cold-1"]')) ?? '').toContain('4.0°C');
    expect((await page.textContent('#o-incidents')) ?? '').toContain('wet floor by the chiller');
    await page.click('#lang');
    await waitText(page, '#office-heading', 'சொத்துகள்');
    expect((await page.textContent('#o-equipment li[data-asset="cold-1"]')) ?? '').toContain('வரம்பிற்குள்');
    expect(errors).toEqual([]);
    await close();
  }, 120_000);

  it('captured losses: the raiser cannot approve their own; a second person approves with a reason and it is recorded', async () => {
    const raiser = await open('u-mgr', '/write-off-capture');
    const mine = raiser.page.locator('#wod-rows li[data-write-off="WO-3"]');
    await mine.waitFor({ timeout: 15_000 });
    expect(await raiser.page.isHidden('#woq')).toBe(true); // the line-down queue is the store computer's page
    await mine.locator('textarea.wod-why').fill('my own loss');
    await mine.locator('button[data-act="approve"]').click();
    await waitText(raiser.page, '#wod-status', 'cannot also approve it');
    await raiser.close();

    const { page, errors, close } = await open('u-mgr2', '/write-off-capture');
    const row = page.locator('#wod-rows li[data-write-off="WO-3"]');
    await row.waitFor({ timeout: 15_000 });
    expect((await row.textContent()) ?? '').toContain('Waiting for a second person');
    expect((await row.textContent()) ?? '').toContain('₹1,000.00');
    await row.locator('button[data-act="approve"]').click();
    await waitText(page, '#wod-status', 'Write your reason first.');
    await row.locator('textarea.wod-why').fill('saw the split crate');
    expect(await row.locator('button[data-act="approve"] svg').count()).toBe(1);
    await row.locator('button[data-act="approve"]').click();
    await waitText(page, '#wod-rows li[data-write-off="WO-3"]', 'Recorded');
    const written = (await shop.cloud().request({ method: 'GET', path: '/v1/inventory/write-offs', userId: 'u-owner' })).body as { count: number };
    expect(written.count).toBe(1);
    expect(errors).toEqual([]);
    await close();
  }, 120_000);

  it('relabel tasks: one per shelf place; a label at another price is refused and stays open; the right price with its photo closes it', async () => {
    const { page, errors, close } = await open('u-mgr', '/store-tasks');
    await page.waitForSelector('#relabel:not([hidden])');
    await waitText(page, '#relabel-open', '2 to change');
    const first = page.locator('#relabel-rows li[data-product="p-salt"]').first();
    expect((await first.textContent()) ?? '').toContain('₹18.00');
    // OB-358: who it is for — no department of the store owns salt here, so the store manager, said why; mine marked.
    const forWho = (await first.locator('.for').textContent()) ?? '';
    expect(forWho).toContain('For: the store manager');
    expect(forWho).toContain('no department owns this product here');
    expect(forWho).toContain('✓ yours');
    expect(await first.locator('.for').getAttribute('data-assignee')).toBe('store_manager');
    await first.locator('input.rl-price').fill('20');
    await first.locator('input.rl-photo').fill('photo-l1');
    await first.locator('button[type="submit"]').click();
    await waitText(page, '#relabel-status', 'the price is ₹18.00');
    await first.locator('input.rl-price').fill('18');
    await first.locator('button[type="submit"]').click();
    await waitText(page, '#relabel-open', '1 to change');
    expect((await page.textContent('#relabel-rows')) ?? '').toContain('Changed by u-mgr · ');
    expect(errors).toEqual([]);
    await close();
    // OB-358: My tasks — the store manager's own relabel tasks (the one still open, and the one done); Tamil heading.
    const mine = await open('u-mgr', '/my-tasks');
    await mine.page.waitForSelector('#relabel:not([hidden])');
    await waitText(mine.page, '#relabel-h', 'Shelf labels to change — mine');
    await waitText(mine.page, '#relabel-open', '1 to change');
    expect(await mine.page.locator('#relabel-rows li').count()).toBe(2);
    await mine.page.click('#lang');
    await waitText(mine.page, '#relabel-h', 'மாற்ற வேண்டிய அலமாரி லேபிள்கள் — என்னுடையவை');
    expect(mine.errors).toEqual([]);
    await mine.close();
  }, 120_000);
});
