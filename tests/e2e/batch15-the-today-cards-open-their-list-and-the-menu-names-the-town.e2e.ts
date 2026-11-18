import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { auditPage } from './lib/a11y-audit';
import { emptyPack, known, type StorePack } from '../../edge/store-edge/src/store-pack';
import { managerPayload, type ScreenInput } from '../../edge/store-edge/src/screen-data';
import { branchOf } from '../../edge/store-edge/src/screen-navigation';
import { directoryPayload } from '../../edge/store-edge/src/screen-directory';
import type { LoggedSale } from '../../edge/store-edge/src/read-model';

/**
 * **Batch 15 on the rendered Today page — from the store computer's own payload, not a hand-made one (P-08).**
 *
 * The pack (low-stock list, supplier names, town) and the box's history (yesterday's figures, a price change, an
 * approval decided here) go through the SAME builders the store computer serves with; the page then:
 *   • shows Low stock as a number against yesterday, and the card and its Needs attention row open the list by name;
 *   • with no reorder level set, says "Not known — no reorder levels set yet" and links to the Reorder tab;
 *   • lists Recent activity with each row's status as a word beside an icon;
 *   • names the town under the store's name in the menu, and nothing when unset;
 *   • audits clean at a desk and on a phone, in English and Tamil.
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const WEB_DIR = 'apps/web-erp/web';
const DESK = { viewport: { width: 1280, height: 800 } };
const PHONE = { viewport: { width: 360, height: 640 }, hasTouch: true, isMobile: true };
const DAY = '2026-11-18';
const NOW = '2026-11-18T08:30:00.000Z';

function inputWith(over: Partial<StorePack>, extra: Partial<ScreenInput> = {}): ScreenInput {
  const pack: StorePack = {
    ...emptyPack('test'),
    policies: known({ storeId: 'S1', branchId: 'S1', branchName: 'SRE Hyper Market', branchTown: 'Tiruppur', tradingDayCutoff: '02:00', timeZone: 'Asia/Kolkata' } as never),
    purchaseOrders: known([{ poId: 'PO-1', supplierId: 'SUP-1', lines: [{ productId: 'DAL', qty: 10, unitMinor: 100 }] }]),
    receipts: known([]),
    products: known([{ productId: 'DAL', name: 'Toor dal 1kg' }, { productId: 'OIL', name: 'Sunflower oil 1L' }] as never),
    lowStock: known({ levelsSet: 5, items: [{ productId: 'OIL', onHandMinor: 0, reorderPoint: 24, uom: 'ea' }, { productId: 'DAL', onHandMinor: 4, reorderPoint: 30, uom: 'ea' }] }),
    suppliers: known([{ supplierId: 'SUP-1', name: 'Aachi Masala Foods' }]),
    ...over,
  };
  const sale = { id: 's1', number: 'B-101', laneId: 'lane-1', cashierId: 'u', tradingDay: DAY, total: 45_000, committedAt: '2026-11-18T04:00:00.000Z' } as LoggedSale;
  return {
    pack, sales: [sale], tradingDay: DAY, now: NOW, unreadableRecords: 0,
    outbox: { pending: () => [], depth: () => 0 },
    todayHistory: [
      { kind: 'daily_figure', figure: 'lowStock', tradingDay: '2026-11-17', value: 1, at: '2026-11-17T10:00:00.000Z' },
      { kind: 'daily_figure', figure: 'purchaseOrdersOpen', tradingDay: '2026-11-17', value: 3, at: '2026-11-17T10:00:00.000Z' },
      { kind: 'price_change', productId: 'DAL', fromMinor: 12_000, toMinor: 12_500, packVersion: 9, at: '2026-11-18T06:00:00.000Z' },
    ],
    boxWork: [{ type: 'ApprovalDecided', occurredAt: '2026-11-18T07:00:00.000Z', sent: false, payload: { id: 'ap-1', subjectType: 'stock_count', subjectRef: 'CNT-9', status: 'rejected' } }],
    ...extra,
  } as unknown as ScreenInput;
}

const menuOf = (pack: StorePack) => ({
  userId: 'u-mgr', branchId: 'S1', person: { name: 'Meena Raghavan', role: 'Store manager' }, branch: branchOf(pack), why: null,
  groups: [
    { group: { en: 'Today', ta: 'இன்று' }, items: [{ id: 'dashboard', label: { en: 'Today', ta: 'இன்று' }, path: '/manager/', current: true }] },
    { group: { en: 'Buying', ta: 'கொள்முதல்' }, items: [{ id: 'buying', label: { en: 'Buying', ta: 'கொள்முதல்' }, path: '/buying/', current: false }] },
  ],
});

async function serve(globals: Record<string, unknown>): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      const file = path === '/' ? 'index.html' : path.replace(/^\//, '');
      try {
        let text = (await readFile(join(WEB_DIR, file))).toString('utf8');
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
        if (file.endsWith('.html')) text = text.replace('<!--SCREEN-DATA-->', Object.entries(globals).map(([n, v]) => `<script>window.${n} = ${JSON.stringify(v).replace(/</g, '\\u003c')};</script>`).join(''));
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
        res.end(text);
      } catch { res.writeHead(404); res.end('not found'); }
    })();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const addr = server.address();
    resolve({ base: `http://127.0.0.1:${typeof addr === 'object' && addr !== null ? addr.port : 0}`, stop: () => new Promise((done) => { server.close(() => done()); server.closeAllConnections(); }) });
  }));
}

describe.skipIf(!existsSync(CHROMIUM))('batch 15 — the Today cards, Recent activity and the town, on the rendered page', () => {
  let browser: Browser;
  const stops: (() => Promise<void>)[] = [];
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });

  async function open(input: ScreenInput, device: typeof DESK | typeof PHONE): Promise<{ page: Page; errors: string[] }> {
    const srv = await serve({ sreNavigation: menuOf(input.pack), managerData: managerPayload(input), sreDirectory: directoryPayload(input.pack, 'u-mgr'), shopTimeZone: 'Asia/Kolkata' });
    stops.push(srv.stop);
    const context = await browser.newContext(device);
    stops.push(() => context.close());
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${srv.base}/index.html`, { waitUntil: 'load' });
    await page.waitForFunction('globalThis.sreChrome !== undefined', undefined, { timeout: 15_000 });
    await page.waitForSelector('#kpis [data-kpi="lowStock"]');
    return { page, errors };
  }
  const texts = (page: Page, sel: string): Promise<string[]> =>
    page.evaluate(`[...document.querySelectorAll(${JSON.stringify(sel)})].map((e) => e.textContent.replace(/\\s+/g, ' ').trim())`) as Promise<string[]>;

  it('low stock is a number against yesterday; the card and its row open the list by name; activity and the town are said; audit clean', async () => {
    for (const device of [DESK, PHONE]) {
      const { page, errors } = await open(inputWith({}), device);
      expect(await page.textContent('#kpis [data-kpi="lowStock"] .kpi-n')).toBe('2');
      expect(await page.textContent('#kpis [data-kpi="lowStock"] .kpi-trend')).toMatch(/\+100%.*vs\. Tue, 17 Nov, at its end/);
      expect(await page.evaluate('document.querySelector(\'#kpis [data-kpi="lowStock"] .kpi-trend\').classList.contains("worse-up")')).toBe(true);
      expect(await page.textContent('#kpis [data-kpi="purchaseOrders"] .kpi-trend')).toMatch(/vs\. Tue, 17 Nov, at its end/);
      expect(await page.evaluate('document.getElementById("tiles")')).toBeNull(); // the old strip is gone
      // the Needs attention row opens the list
      expect(await page.evaluate('document.getElementById("lowstock-card").hidden')).toBe(true);
      const row = page.locator('#attention li', { hasText: 'items at or below their reorder level' });
      await row.locator('button.go').click();
      expect(await page.evaluate('document.getElementById("lowstock-card").hidden')).toBe(false);
      expect(await texts(page, '#lowstock-rows tbody td')).toEqual(['Sunflower oil 1L', '0 ea', '24 ea', 'Toor dal 1kg', '4 ea', '30 ea']);
      await page.click('#lowstock-close');
      expect(await page.evaluate('document.getElementById("lowstock-card").hidden')).toBe(true);
      // the card opens it too, by keyboard
      await page.focus('#kpis [data-kpi="lowStock"]');
      await page.keyboard.press('Enter');
      expect(await page.evaluate('document.getElementById("lowstock-card").hidden')).toBe(false);
      // Recent activity: newest first, each status a word beside its icon
      const kinds = await page.evaluate('[...document.querySelectorAll("#recent tbody tr")].map((r) => r.dataset.kind)');
      expect(kinds).toEqual(['approval', 'price_change', 'sale']);
      expect(await texts(page, '#recent tbody tr td.state > span')).toEqual(['Rejected', 'On the tills', 'Completed']);
      expect(await page.evaluate('[...document.querySelectorAll("#recent tbody tr td.state > span")].every((s) => s.querySelector("svg") !== null)')).toBe(true);
      expect((await texts(page, '#recent tbody tr'))[0]).toMatch(/stock count · saved here, not yet at head office/);
      // the town under the store's name
      if (device !== DESK) await page.click('#sre-menu-button');
      expect(await page.textContent('#sre-menu .branch small.town')).toBe('Tiruppur');
      expect(await auditPage(page, { expectLang: 'en' }), `Today at ${device.viewport.width}`).toEqual([]);
      if (device === DESK) {
        await page.click('#lang');
        await page.waitForFunction('document.documentElement.lang === "ta"');
        expect(await page.textContent('#lowstock-close')).toBe('மூடு');
        expect(await auditPage(page, { expectLang: 'ta' }), 'Today in Tamil').toEqual([]);
      }
      expect(errors).toEqual([]);
    }
  }, 120_000);

  it('no reorder level set: "Not known — no reorder levels set yet" with the way to set them; no town set: nothing under the name', async () => {
    const input = inputWith({
      lowStock: known({ levelsSet: 0, items: [] }),
      policies: known({ storeId: 'S1', branchId: 'S1', branchName: 'SRE Hyper Market', tradingDayCutoff: '02:00', timeZone: 'Asia/Kolkata' } as never),
    }, { todayHistory: [] });
    const { page, errors } = await open(input, DESK);
    expect(await page.textContent('#kpis [data-kpi="lowStock"] .kpi-n')).toBe('Not known');
    expect(await page.textContent('#kpis [data-kpi="lowStock"] .kpi-why')).toBe('no reorder levels set yet');
    expect(await page.getAttribute('#kpis [data-kpi="lowStock"] a.kpi-link', 'href')).toBe('/buying/#reorder');
    expect(await page.textContent('#kpis [data-kpi="purchaseOrders"] .kpi-trend')).toMatch(/No earlier day yet/);
    expect(await page.textContent('#attention')).toMatch(/Low stock: Not known — no reorder levels set yet/);
    expect(await page.evaluate('document.querySelector("#sre-menu .branch small.town")')).toBeNull();
    expect(await auditPage(page, { expectLang: 'en' })).toEqual([]);
    expect(errors).toEqual([]);
  }, 60_000);
});
