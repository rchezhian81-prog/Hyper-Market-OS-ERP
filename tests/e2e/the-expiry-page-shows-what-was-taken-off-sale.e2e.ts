import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { P3, p3Shop, caller } from '../support/p3-purchase';

/**
 * **The Expiry page's "Taken off sale" tab, in a real browser served by the store computer, over head office's real routes
 * (M10-FR-01 "expired stock auto-moves to expired state (not sellable)" · P-08 · Round 4b).**
 *
 * Before this tab, head office's expired register (`GET /v1/inventory/expired-batches`) was read by no screen. Through Chromium:
 *   • after the daily sweep moved a curd batch past its date off sale, the manager reads it: the batch, its date, the 12 taken
 *     off sale and "still on the shelf — throw it away"; the fresh batch is not listed; nothing is written;
 *   • once 12 are written off, the row says "Thrown away" and lists the write-off;
 *   • a person who may not read stock is told so (head office refuses them too); the tab speaks Tamil.
 * Synthetic data only. Without a browser binary it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const KEY = ['expired', 'register', 'box', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = randomUUID();
const OUTSIDER = 'u-outsider-exp';

describe.skipIf(!existsSync(CHROMIUM))('the Expiry page\'s Taken off sale tab (M10-FR-01)', () => {
  let browser: Browser;
  let ho: ApiHarness;
  let edge: EdgeProcess;
  let dir: string;
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    ho = apiHarness();
    await p3Shop(ho, TENANT);
    await ho.provisionRole(TENANT, OUTSIDER, 'supplier');
    const call = caller(ho, TENANT);
    for (const [id, batchId, expiry] of [['r-old', 'B-OLD', '2026-01-05'], ['r-new', 'B-NEW', '2099-01-01']] as const) {
      const r = await call('POST', '/v1/inventory/movements', P3.OWNER, { movementId: id, productId: 'CURD', locationId: P3.BACK, kind: 'received', quantityMinor: 12, uom: 'EA', occurredAt: '2026-01-01T00:00:00.000Z', enteredBy: P3.OWNER, batchId, expiry, unitCostMinor: 3_000 });
      if (r.status >= 300) throw new Error(`receive: ${JSON.stringify(r.body)}`);
    }
    const swept = await call('POST', '/v1/inventory/expiry-sweep', P3.OWNER, {});
    if (swept.status !== 200) throw new Error(`sweep: ${JSON.stringify(swept.body)}`);

    dir = await mkdtemp(join(tmpdir(), 'sre-expired-register-'));
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, JSON.stringify({
      version: 1, lossPreventionRules: [], policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1' },
      expiryPolicy: { nearExpiryDays: 7 }, batches: [], recalls: [],
      roles: [
        { id: 'manager', name: 'Manager', permissions: ['identity.self.read', 'quality.recall.read', 'inventory.availability.read'] },
        { id: 'qc', name: 'Quality', permissions: ['identity.self.read', 'quality.recall.read'] },
      ],
      roleAssignments: [{ userId: P3.BUYER, roleId: 'manager', branchScope: 'all' }, { userId: OUTSIDER, roleId: 'qc', branchScope: 'all' }],
    }), 'utf8');
    edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
      EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile, EDGE_SCREEN_TRUST_FORWARDED_USER: '1',
    }, () => {}))!;
  }, 240_000);
  afterAll(async () => { await browser?.close(); await edge?.stop(); if (dir !== undefined) await rm(dir, { recursive: true, force: true }); });
  afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });

  const open = async (who: string): Promise<{ page: Page; errors: string[]; writes: string[] }> => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', extraHTTPHeaders: { 'x-sre-user': who } });
    stops.push(() => context.close());
    const writes: string[] = [];
    await context.route('**/v1/**', async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (req.method() !== 'GET') writes.push(`${req.method()} ${url.pathname}`);
      const answer = await ho.request({ method: req.method() as 'GET', path: url.pathname, userId: who, tenantId: TENANT, ...(url.search === '' ? {} : { query: Object.fromEntries(url.searchParams) }) });
      await route.fulfill({ status: answer.status, contentType: 'application/json', body: JSON.stringify(answer.body ?? {}) });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const res = await page.goto(`http://127.0.0.1:${edge.screens!.port}/expiry/`, { waitUntil: 'load' });
    expect(res?.status()).toBe(200);
    await page.click('#tab-expired');
    return { page, errors, writes };
  };
  const says = (page: Page, selector: string, pattern: RegExp): Promise<unknown> => page.waitForFunction(
    ([sel, src]) => new RegExp(src!).test((globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector(sel!)?.textContent ?? ''),
    [selector, pattern.source], { timeout: 15_000 },
  );

  it('the manager reads the batch taken off sale and what is still to throw away; once written off it reads "Thrown away"', async () => {
    const m = await open(P3.BUYER);
    await m.page.click('#expired-read');
    const row = `#expired-list .expired-row[data-key="${P3.BACK}|CURD|B-OLD"]`;
    await m.page.waitForSelector(`${row}[data-to-bin="true"]`);
    const text = await m.page.textContent(row);
    expect(text).toContain('CURD · Batch B-OLD · expired 2026-01-05');
    expect(text).toContain('Taken off sale 12');
    expect(text).toContain('Still on the shelf 12');
    expect(text).toContain('still on the shelf — throw it away and record a write-off');
    expect(await m.page.textContent('#expired-list')).not.toContain('B-NEW');
    await says(m.page, '#expired-list', /1 batches still to throw away/);

    const wo = await ho.request({ method: 'POST', path: '/v1/inventory/write-off/wo-1', userId: P3.OWNER, tenantId: TENANT, idempotencyKey: 'wo-1', body: { productId: 'CURD', locationId: P3.BACK, batchId: 'B-OLD', qty: 12, uom: 'EA', lossType: 'expiry', reasonCode: 'expiry' } });
    expect(wo.status, JSON.stringify(wo.body)).toBeLessThan(300);
    {
      await m.page.click('#expired-read');
      await m.page.waitForSelector(`${row}[data-to-bin="false"]`);
      expect(await m.page.textContent(row)).toContain('Thrown away');
    }
    await m.page.click('#lang');
    await says(m.page, '#expired-title', /^விற்பனையிலிருந்து நீக்கியவை$/);
    expect(m.writes).toEqual([]);
    expect(m.errors).toEqual([]);
  }, 120_000);

  it('a person who may not read stock is told so, and head office refuses them too', async () => {
    expect((await ho.request({ method: 'GET', path: '/v1/inventory/expired-batches', userId: OUTSIDER, tenantId: TENANT })).status).toBe(403);
    const q = await open(OUTSIDER);
    await says(q.page, '#expired-status', /^Your role cannot read stock\.$/);
    await q.page.click('#expired-read');
    await says(q.page, '#expired-status', /^Your role cannot read stock\.$/);
    expect(q.writes).toEqual([]);
    expect(q.errors).toEqual([]);
  }, 60_000);
});
