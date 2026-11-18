import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { financialYearLabel } from '../../packages/numbering/src/document-numbers';

/** The page's document, typed for the callbacks run in the browser (this project's type check has no DOM library). */
type PageDoc = { document: { getElementById(id: string): { textContent: string | null } | null; body: { innerText: string; textContent: string | null } } };

/**
 * **OB-850 — in a real Chromium: the Transfers and Count plans pages show each document's format-A number (`TRF1/YY-YY/…`,
 * `CNT1/YY-YY/…`), and a transfer or plan saved before keeps its old id.** Head office's answers are synthetic data shaped
 * as its routes answer. Screenshots (deviceScaleFactor 1) go to SRE_SCREENSHOT_DIR when set. Skips without a browser.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const SHOTS = process.env['SRE_SCREENSHOT_DIR'];

describe.skipIf(!existsSync(CHROMIUM))('OB-850 — transfers and stock counts show their numbers', () => {
  let browser: Browser;
  const stops: (() => Promise<void>)[] = [];
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    if (SHOTS !== undefined) await mkdir(SHOTS, { recursive: true });
  }, 90_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => { for (const s of stops.splice(0).reverse()) await s(); });

  const office = async (answers: Readonly<Record<string, unknown>>, inject: Readonly<Record<string, unknown>>): Promise<string> => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        const path = (req.url ?? '/').split('?')[0] ?? '/';
        for await (const chunk of req) void chunk;
        if (path in answers) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(answers[path])); return; }
        const file = path.replace(/^\//, '');
        try {
          let body = (await readFile(join('apps/web-erp/web', file))).toString('utf8');
          if (file.endsWith('.html')) body = body.replace('<!--SCREEN-DATA-->', Object.entries(inject).map(([k, v]) => `<script>window.${k} = ${JSON.stringify(v)};</script>`).join(''));
          res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream' });
          res.end(body);
        } catch { res.writeHead(404); res.end('not found'); }
      })();
    });
    await new Promise<void>((r) => { server.listen(0, '127.0.0.1', () => { r(); }); });
    stops.push(() => new Promise((d) => { server.close(() => { d(); }); server.closeAllConnections(); }));
    const a = server.address();
    return `http://127.0.0.1:${typeof a === 'object' && a !== null ? a.port : 0}`;
  };

  it('Transfers lists TRF1/YY-YY/00001; Count plans lists CNT1/YY-YY/00001; older records keep their ids', async () => {
    const yy = financialYearLabel(new Date().toISOString());
    const at = new Date().toISOString();
    const viewer = { userId: 'u-manager', permissions: ['inventory.availability.read', 'inventory.movement.append', 'inventory.count.plan', 'inventory.adjustment.approve'] };
    const line = { productId: 'p-oil', quantityMinor: 12, uom: 'ea' };
    const base = await office({
      '/v1/warehouse/transfers': { transfers: [
        { transfer: { documentNumber: `TRF1/${yy}/00001`, transferId: 'tr-new', fromLocationId: 'S1-BACK', toLocationId: 'S2', lines: [line], state: 'proposed', requestedBy: 'u-manager' }, shortfall: [], shortfallOpen: false, forIndent: false },
        { transfer: { transferId: 'tr-old-7', fromLocationId: 'S1-BACK', toLocationId: 'S2', lines: [line], state: 'received', requestedBy: 'u-manager', approvedBy: 'u-owner', dispatchedAt: at, receivedAt: at }, shortfall: [], shortfallOpen: false, forIndent: false },
      ] },
      '/v1/inventory/count-plans': { plans: [
        { documentNumber: `CNT1/${yy}/00001`, planId: 'plan-aisle-4', locationId: 'S1', productIds: ['p-oil'], frozenKinds: ['sold'], recountThresholdMinor: 50_000, note: 'aisle 4', plannedBy: 'u-manager', plannedAt: at, state: 'planned' },
        { planId: 'plan-old-3', locationId: 'S1', productIds: ['p-oil'], frozenKinds: [], recountThresholdMinor: 50_000, note: null, plannedBy: 'u-manager', plannedAt: at, state: 'approved' },
      ] },
      '/v1/inventory/adjustment-requests': { requests: [] },
    }, { transfersData: viewer, countPlansData: viewer });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    stops.push(() => context.close());
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto(`${base}/transfers.html`, { waitUntil: 'load' });
    await page.waitForFunction((n) => ((globalThis as unknown as PageDoc).document.getElementById('register')?.textContent ?? '').includes(n), `TRF1/${yy}/00001`, { timeout: 15_000 }).catch(async (e: unknown) => { throw new Error(`${String(e)} :: ${await page.evaluate(() => (globalThis as unknown as PageDoc).document.body.innerText.slice(0, 800))} :: ${errors.join(' / ')}`); });
    expect(await page.textContent('#register')).toContain('tr-old-7');
    if (SHOTS !== undefined) await page.screenshot({ path: join(SHOTS, 'transfers-list.png'), fullPage: true });

    await page.goto(`${base}/count-plans.html`, { waitUntil: 'load' });
    await page.waitForFunction((n) => (globalThis as unknown as PageDoc).document.body.innerText.includes(n), `CNT1/${yy}/00001`, { timeout: 15_000 });
    expect(await page.evaluate(() => (globalThis as unknown as PageDoc).document.body.innerText)).toContain('plan-old-3');
    if (SHOTS !== undefined) await page.screenshot({ path: join(SHOTS, 'count-plans-list.png'), fullPage: true });
    expect(errors).toEqual([]);
  }, 120_000);
});
