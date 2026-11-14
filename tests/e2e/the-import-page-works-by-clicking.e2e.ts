import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser } from 'playwright-core';
import { apiHarness, TEST_IDP } from '../support/api-harness';
import { aStoreWithRules } from '../support/store-rules';
import { buildPersonToken } from '../../scripts/lib/operator-env';
import { createImportApp } from '../../scripts/lib/import-app';
import { xlsx } from '../support/xlsx';

/**
 * OB-704 (owner, 7 Nov 2026: "screens, not commands") — the import page, driven in a real browser the way the owner and
 * his staff use it: sign in with a staff ID and PIN, choose the three Excel reports, read them. OB-733 (owner, 14 Nov 2026,
 * replacing OB-696; "sell at the till only"): an item with no label facts is ready to load all the same — the facts are
 * on their own "Facts still to read" tile, best sellers first; typed in (some now, the rest later) and saved, the item
 * leaves that list. No command is typed anywhere. Made-up data.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const SHOP = [['TEST SHOP'], ['1 Test Road']];
const EAN = [['Item Id', 'Item Name', 'EanCode'], ['11', 'TEST RICE 1KG', '8901234567890'], ['12', 'TEST DAL 500G', '8901234567911']];
const HSN = [['Item Id', 'Item Name', 'Hsn Code', 'Item Quantity', 'Gst %'], ['11', 'TEST RICE 1KG', '10063020', '500', '5'], ['12', 'TEST DAL 500G', '07133100', '300', '5']];
const BUYS = [['Purc Date', 'Purc No', 'Item Id', 'Cost', 'NetCost', 'Selling', 'MRP'], ['01/11/2026', '1', '11', '60', '60', '70', '80']];
const BUYS_EARLIER = [['Purc Date', 'Purc No', 'Item Id', 'Cost', 'NetCost', 'Selling', 'MRP'], ['01/09/2026', '1', '12', '50', '50', '60', '65']];

describe.skipIf(!existsSync(CHROMIUM))('the import page works by clicking (OB-704)', () => {
  let browser: Browser; let server: Server; let base = ''; let dir = '';
  beforeAll(async () => {
    const h = apiHarness();
    const T = randomUUID();
    await h.seedOwner(T, 'owner-01');
    await aStoreWithRules(h, T, 'owner-01', 'SRE-T1', 0);
    dir = mkdtempSync(join(tmpdir(), 'sre-import-page-'));
    const app = createImportApp({
      client: { request: async (r) => h.raw({ method: r.method, path: r.path, ...(r.body === undefined ? {} : { body: r.body }), ...(r.idempotencyKey === undefined ? {} : { idempotencyKey: r.idempotencyKey }), token: buildPersonToken({ sub: r.userId, tenantId: r.tenantId, ttlSeconds: 300, authTimeSec: Math.floor(Date.parse(r.signedInAt) / 1000) }, TEST_IDP.policy(), Date.now()) }) },
      verifyPin: (u, p) => (u === 'owner-01' && p === '111111' ? 'ok' : 'wrong'), tenantId: T, storeId: 'SRE-T1', targetKind: 'rehearsal', demoTenantIds: ['pilot-demo'],
      dataDir: join(dir, 'imports'), pageHtml: readFileSync('scripts/import-page/index.html', 'utf8'), now: () => new Date('2026-11-07T10:00:00.000Z'),
    });
    server = createServer((rq, rs) => { void app(rq, rs); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const [name, rows] of [['EANCODE.xlsx', EAN], ['HSN.xlsx', HSN], ['Purchases-1.xlsx', BUYS_EARLIER], ['Purchases-2.xlsx', BUYS]] as const) writeFileSync(join(dir, name), xlsx([...SHOP, ...rows]));
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 90_000);
  afterAll(async () => { await browser?.close(); await new Promise<void>((r) => server.close(() => r())); });

  it('sign in → choose the three reports → read → ready with its facts still to read → type them, some now, the rest later → off the list', { timeout: 60_000 }, async () => {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/`);
    await page.fill('#staff', 'owner-01');
    await page.fill('#pin', '000000');
    await page.click('#signin-form button[type=submit]');
    await page.waitForSelector('#msg:not([hidden])');
    expect(await page.textContent('#msg')).toContain('not owner-01\'s till PIN');
    await page.fill('#pin', '111111');
    await page.click('#signin-form button[type=submit]');
    await page.waitForSelector('#start:not([hidden])');
    expect(await page.textContent('#who')).toBe('Signed in: owner-01');

    // OB-706: every file in ONE choice, any order; the page tells them apart. The backup day is asked the first time only.
    expect(await page.isVisible('#backup-label')).toBe(true);
    await page.setInputFiles('#f-all', [join(dir, 'Purchases-2.xlsx'), join(dir, 'HSN.xlsx'), join(dir, 'Purchases-1.xlsx'), join(dir, 'EANCODE.xlsx')]);
    await page.fill('#backup-on', '2026-11-06');
    await page.click('#read-form button[type=submit]');
    await page.waitForSelector('#work:not([hidden])');
    expect(await page.textContent('#msg')).toContain('Read: 2 packaged-grocery items. Barcodes: 1 file(s) · HSN: 1 file(s) · prices: 2 file(s), 2 rows, from 2026-09-01 to 2026-11-01');
    // OB-733: the rice has no label facts yet and is ready to load all the same; both items are on the facts tile.
    expect(await page.textContent('#prepare-btn')).toBe('Prepare a load (1 ready item(s))');
    const factsTile = page.locator('#tiles .tile', { hasText: 'Facts still to read (not a blocker)' });
    expect(await factsTile.locator('.v').textContent()).toBe('2');
    await factsTile.click();
    expect(await page.textContent('#list-note')).toContain('blank means not read yet, never "none"');
    const rice = page.locator('details.item', { hasText: 'TEST RICE 1KG' });
    expect(await rice.locator('.chip.later').textContent()).toBe('Facts still to read');
    await rice.locator('summary').click();
    // Two facts read now; the rest later.
    await rice.getByLabel('Allergens (write "none" when the pack declares none)').fill('none');
    await rice.getByLabel('Country of origin').fill('India');
    await rice.getByRole('button', { name: 'Save this fix' }).click();
    await page.waitForFunction(() => ((globalThis as unknown as { document: { getElementById(id: string): { textContent: string | null } | null } }).document.getElementById('msg')?.textContent ?? '').includes('Saved for TEST RICE 1KG'));
    const riceNow = page.locator('details.item', { hasText: 'TEST RICE 1KG' });
    await riceNow.locator('summary').click();
    expect(await riceNow.locator('.gap.later .why').textContent()).toBe('Facts still to read off the pack: net quantity, packer, consumer care.');
    expect(await riceNow.getByLabel('Country of origin').inputValue()).toBe('India'); // what was read stays shown
    for (const [label, value] of Object.entries({ 'Net quantity (e.g. 500 g)': '1 kg', 'Packer / manufacturer / importer, and town': 'Test Foods, Chennai', 'Consumer care phone or email': '1800 000 000' })) await riceNow.getByLabel(label).fill(value);
    await riceNow.getByRole('button', { name: 'Save this fix' }).click();
    await page.waitForFunction(() => (globalThis as unknown as { document: { querySelector(q: string): { textContent: string | null } | null } }).document.querySelector('#tiles .tile:nth-child(6) .v')?.textContent === '1');
    expect(await page.locator('details.item', { hasText: 'TEST RICE 1KG' }).count()).toBe(0); // off the facts list
    expect(await page.textContent('#prepare-btn')).toBe('Prepare a load (1 ready item(s))');

    // Back to the items needing a fix.
    await page.locator('#tiles .tile', { hasText: 'Need a fix' }).click();

    // The dal still has a wrong barcode: a wrong one typed in is refused, in words.
    const dal = page.locator('details.item', { hasText: 'TEST DAL 500G' });
    await dal.locator('summary').click();
    await dal.getByLabel(/Barcode\(s\) as printed/).fill('8901234567911');
    await dal.locator('.gap', { hasText: 'Barcode:' }).getByRole('button', { name: 'Save this fix' }).click();
    await page.waitForFunction(() => ((globalThis as unknown as { document: { getElementById(id: string): { textContent: string | null } | null } }).document.getElementById('msg')?.textContent ?? '').includes('not a pack barcode'));
    await page.click('#back');
    await page.waitForSelector('#backup-known:not([hidden])');
    expect(await page.isVisible('#backup-label')).toBe(false);
    expect(await page.textContent('#backup-known')).toContain('last restored and checked on 2026-11-06');
    expect(errors).toEqual([]);
  });
});
