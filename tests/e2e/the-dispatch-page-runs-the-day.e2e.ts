import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startInboxShop, ok, OWNER, type InboxShop } from './lib/ai-inbox-shop';
import { Pool } from 'pg';
import { listableProduct } from '../support/sell-online';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { makeEvent } from '../../packages/contracts/src/event';

/**
 * OB-288 fulfilment & delivery (M19-FR-01/03/04 · WF-14 · WF-15 · OB-294 · OB-313) — the Dispatch page, in a real browser,
 * on the PRODUCTION API over real PostgreSQL (synthetic data). Nothing is read on open. The dispatcher sees the confirmed
 * orders waiting, ticks them and builds a wave for the picker (the lines from the bins and the pack); sees the wave's
 * progress; enters the drivers on shift and the day's speed, plans the day from head office's own orders and hands the
 * route to its driver; sees the route on the board; reads the contribution rule ("not set — the rule only flags"); the
 * owner enters the proof-location radius, which was "not set". Tamil. A cashier is offered nothing. Needs DATABASE_URL and
 * Chromium; else it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['dispatch', 'e2e', 'signing', 'key'].join('-').padEnd(48, '0');
const STORE = { lat: 11.0168, lon: 76.9558 };

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the Dispatch page runs the day (M19-FR-01/03 · WF-14/15) on the production API, in a real browser', () => {
  let browser: Browser;
  let shop: InboxShop;
  let runDate = '';
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/dispatch', html: 'dispatch.html', dataGlobal: 'dispatchData' },
      seed: async (cloud) => {
        const req = (method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, userId = OWNER) => cloud.request({ method, path, userId, ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });
        for (const f of ['delivery', 'customer_app']) await ok(req('PUT', `/v1/platform/entitlements/${f}`, { enabled: true }), `feature ${f}`);
        for (const [u, role] of [['u-picker', 'store_manager'], ['u-driver', 'store_manager'], ['u-cash', 'cashier']] as const) await cloud.grant(u, role);
        // A customer's storefront login is an outside party's (OB-76), invited through its own flow; for this page's journey
        // the two synthetic customers are provisioned straight onto the ledger, the way tenant provisioning seeds a login.
        const pool = new Pool({ connectionString: DATABASE_URL, max: 1, options: '-c app.tenant_id=*' });
        try {
          const ledger = new SqlEventStore(pgPoolClient(pool));
          for (const c of ['c-1', 'c-2']) {
            await ledger.append(cloud.tenantId, 'identity', makeEvent({
              id: `grant-customer-${c}`, type: 'RoleGranted', occurredAt: new Date().toISOString(), idempotencyKey: `grant-${cloud.tenantId}-customer-${c}`, source: 'test/provision',
              payload: { userId: c, roleId: 'customer', branchScope: 'all', request: { grantId: `customer-${c}`, userId: c, roleId: 'customer', branchScope: 'all', requestedBy: 'test', approvedBy: 'test', requestedAt: new Date().toISOString() } },
            }));
          }
        } finally { await pool.end(); }
        for (const [productId, priceMinor] of [['RICE', 80_00], ['DAL', 75_00]] as const) {
          await listableProduct((path, body) => req('POST', path, body), { productId, storeId: 'br-1', priceMinor });
          await ok(req('POST', '/v1/inventory/movements', { movementId: `rcv-${productId}`, productId, locationId: 'br-1', kind: 'received', quantityMinor: 50, uom: 'each', unitCostMinor: 50_00, occurredAt: new Date().toISOString(), enteredBy: OWNER }), `receive ${productId}`);
        }
        await ok(req('POST', '/v1/warehouse/bins/A-01', { storeId: 'br-1', capacityMinor: 500, pickable: true }), 'bin');
        for (const p of ['RICE', 'DAL']) await ok(req('POST', `/v1/warehouse/movements/pa-${p}`, { kind: 'put_away', storeId: 'br-1', productId: p, batchId: null, quantityMinor: 30, uom: 'each', fromBinId: null, toBinId: 'A-01' }), `put away ${p}`);
        await ok(req('PUT', '/v1/serviceability/delivery-service', { storeLocation: STORE, slotsPerDay: 6, windowOpen: '09:00', windowClose: '21:00', capacityPerSlot: 10, leadMinutes: 60 }), 'delivery service');
        const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
        const svc = (await cloud.request({ method: 'GET', path: `/v1/serviceability/delivery-service?day=${tomorrow}`, userId: OWNER })).body as { day: string; slots: { startsAt: string }[] };
        runDate = svc.day;
        for (const [c, orderId, productId, door] of [['c-1', 'ORD-1', 'RICE', { lat: 11.02, lon: 76.96 }], ['c-2', 'ORD-2', 'DAL', { lat: 11.03, lon: 76.97 }]] as const) {
          await ok(req('POST', `/v1/storefront/orders/${orderId}`, { lines: [{ productId, quantityMinor: 1 }], locationId: 'br-1', fulfilment: 'delivery', deliverySlot: { startsAt: svc.slots[1]!.startsAt }, deliveryLocation: door }, c), `place ${orderId}`);
          await ok(req('POST', `/v1/orders/${orderId}/transition`, { event: 'confirm' }), `confirm ${orderId}`);
        }
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  it('orders waiting → a wave for the picker → its progress → plan → the route to its driver → the board → the rule → the owner\'s radius; Tamil; a cashier is offered nothing', async () => {
    const context = await browser.newContext();
    await shop.signIn(context, OWNER);
    const page = await context.newPage();
    const reads: string[] = []; const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/')) reads.push(`${r.method()} ${u.pathname}`); });
    await page.goto(`${shop.base}/dispatch`, { waitUntil: 'load' });
    expect(reads, 'nothing is read on open').toEqual([]);
    await page.fill('#store', 'br-1');
    await page.fill('#run-date', runDate);

    // ── Waves from confirmed orders.
    await page.click('#show-orders');
    await page.locator('#ready li.row[data-order="ORD-2"]').waitFor({ timeout: 15_000 });
    expect(await page.locator('#ready li.row').count()).toBe(2);
    await page.click('#build');
    expect(await page.textContent('#waves-status')).toBe('Name the picker and the wave.');
    await page.fill('#wave-id', 'W-1');
    await page.fill('#picker', 'u-picker');
    await page.click('#build');
    expect(await page.textContent('#waves-status')).toBe('Tick at least one order.');
    await page.check('#ready li.row[data-order="ORD-1"] input.choose');
    await page.check('#ready li.row[data-order="ORD-2"] input.choose');
    await page.click('#build');
    await page.locator('#waves-status', { hasText: '✓' }).waitFor({ timeout: 15_000 }).catch(async () => { throw new Error(`wave status: ${await page.textContent('#waves-status')}`); });
    expect(await page.textContent('#waves-status')).toBe('✓ Wave given to the picker — W-1 · u-picker · 2 lines');
    expect(await page.locator('#on-wave li.row').count()).toBe(2);
    await page.click('#show-waves');
    await page.locator('#waves li.row[data-wave="W-1"]').waitFor({ timeout: 15_000 });
    expect(await page.getAttribute('#waves li.row[data-wave="W-1"]', 'data-stage')).toBe('not_started');
    expect(await page.innerText('#waves li.row[data-wave="W-1"]')).toMatch(/⏱ W-1 · u-picker — Not started/);

    // ── The day's routes from head office's own orders; the route to its driver.
    await page.fill('#drivers', 'u-driver, 10, 06:00, 23:00');
    await page.fill('#speed', '20');
    await page.click('#plan');
    expect(await page.textContent('#plan-status')).toBe('Enter the day’s speed and minutes at each door.');
    await page.fill('#minutes', '5');
    await page.click('#plan');
    await page.locator('#planned li.row').first().waitFor({ timeout: 15_000 });
    expect(await page.textContent('#plan-status')).toBe('✓ Planned — 1 routes');
    expect(await page.innerText('#planned li.row')).toMatch(/1\. ORD-1 · Slot .* · ~/);
    await page.locator('#planned li.row button', { hasText: 'Give this route to its driver' }).click();
    await page.locator('#plan-status', { hasText: 'Given to' }).waitFor({ timeout: 15_000 });
    expect(await page.textContent('#plan-status')).toMatch(/^✓ Given to u-driver — /);

    await page.click('#show-board');
    await page.locator('#board li.row').first().waitFor({ timeout: 15_000 });
    expect(await page.getAttribute('#board li.row', 'data-status')).toBe('assigned');
    expect(await page.innerText('#board li.row')).toMatch(/With the driver/);
    expect(await page.innerText('#board li.row')).toMatch(/no door yet/);

    // ── The contribution rule: not set — the rule only flags.
    await page.click('#show-held');
    await page.locator('#threshold').waitFor({ state: 'visible', timeout: 15_000 });
    expect(await page.textContent('#threshold')).toBe('Owner’s threshold: ○ Not set — the rule only flags');

    // ── The owner's numbers: the radius "not set" until he enters it.
    await page.click('#show-controls');
    const radius = page.locator('#controls li.row[data-key="geofenceRadiusMetres"]');
    await radius.waitFor({ timeout: 15_000 });
    expect(await radius.getAttribute('data-state')).toBe('not_set');
    expect(await radius.locator('strong').innerText()).toBe('Proof-location radius (metres): ○ Not set');
    await radius.locator('input.value').fill('150');
    await radius.locator('button', { hasText: 'Save' }).click();
    await page.locator('#controls-status', { hasText: '✓ Saved.' }).waitFor({ timeout: 15_000 });
    expect(await page.locator('#controls li.row[data-key="geofenceRadiusMetres"] strong').innerText()).toBe('Proof-location radius (metres): 150');

    await page.click('#lang');
    expect(await page.textContent('#page-h')).toBe('அனுப்புதல்');
    expect(await page.textContent('#show-board-text')).toBe('வழிகளைக் காட்டு');
    expect(errors).toEqual([]);
    await context.close();

    // A cashier is offered nothing on this page.
    const c = await browser.newContext();
    await shop.signIn(c, 'u-cash');
    const pc = await c.newPage();
    await pc.goto(`${shop.base}/dispatch`, { waitUntil: 'load' });
    for (const id of ['#show-orders', '#build', '#plan', '#show-board', '#show-controls', '#propose', '#approve-settle']) expect(await pc.isDisabled(id), id).toBe(true);
    await c.close();
  }, 180_000);
});
