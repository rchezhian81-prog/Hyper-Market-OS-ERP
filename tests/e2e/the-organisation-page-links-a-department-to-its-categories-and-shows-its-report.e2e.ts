import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, type InboxShop } from './lib/ai-inbox-shop';
import type { RealCloud } from '../support/real-store';

/**
 * M01-FR-01 "departments" · acceptance "a report filtered to one department returns only that department's data" — the
 * Organisation page, in a real browser, on the PRODUCTION API over real PostgreSQL:
 *
 *   • the owner ticks the dairy category for the Dairy department and ASKS the other owner's approval (nothing changes);
 *     the asker cannot approve his own; once the other owner approves, "Save the approved change" sends it naming that
 *     approval number and head office holds the link;
 *   • the Dairy report for the trading day shows only the milk sold — the rice (owned by no department) is shown apart;
 *   • with head office unreachable the page says nothing was saved; the words switch to Tamil;
 *   • a store manager reads the departments and the report and is offered no way to change what a department owns.
 *
 * Needs DATABASE_URL and Chromium; without either it SKIPS. Synthetic data only.
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['org', 'departments', 'e2e', 'key'].join('-').padEnd(48, '0');
const OWNER2 = 'u-owner-2';
const MANAGER = 'u-sm';
const DAY = '2030-05-20';

async function seedShop(cloud: RealCloud): Promise<void> {
  const req = (method: 'POST', path: string, body: unknown, key: string) => cloud.request({ method, path, userId: OWNER, idempotencyKey: key, body });
  await cloud.grant(OWNER2, 'owner');
  await cloud.grant(MANAGER, 'store_manager');
  await ok(req('POST', '/v1/org/nodes/C1', { kind: 'company', name: 'Synthetic Retail' }, 'c1'), 'company');
  await ok(req('POST', '/v1/org/nodes/store-01', { kind: 'branch', name: 'Main store', parentId: 'C1', companyId: 'C1' }, 's1'), 'branch');
  for (const [id, name] of [['D-dairy', 'Dairy'], ['D-grocery', 'Grocery']] as const) await ok(req('POST', `/v1/org/nodes/${id}`, { kind: 'department', name, parentId: 'store-01' }, id), id);
  await ok(req('POST', '/v1/catalogue/tax-classes/04061000/rates/2017-07-01', { rateBps: 500 }, 'tax'), 'tax');
  for (const [id, cat, code] of [['p-milk', 'dairy-cat', '8901000000019'], ['p-rice', 'grocery-cat', '8901000000026']] as const) {
    await ok(req('POST', `/v1/catalogue/products/${id}/publish`, { product: { sku: `SKU-${id}`, name: id, baseUom: 'ea', primaryCategoryId: cat, taxClass: '04061000', lifecycle: 'draft' }, categories: [{ categoryId: cat, name: cat, parentId: null }] }, `pub-${id}`), `publish ${id}`);
    await ok(req('POST', `/v1/prices/list/${id}/entries/e1`, { scope: 'store', scopeRef: 'store-01', priceMinor: 5_000, mrpMinor: 6_000, costMinor: 1, marginFloorBps: 0, currency: 'INR', effectiveFrom: '2030-01-01' }, `price-${id}`), `price ${id}`);
    await ok(req('POST', `/v1/catalogue/products/${id}/barcodes/${code}`, { kind: 'ean' }, `bc-${id}`), `barcode ${id}`);
    await ok(req('POST', '/v1/inventory/movements', { movementId: `rx-${id}`, productId: id, locationId: 'store-01', kind: 'received', quantityMinor: 20, uom: 'EA', occurredAt: '2030-05-01T00:00:00.000Z', enteredBy: OWNER, unitCostMinor: 1_000 }, `rx-${id}`), `receive ${id}`);
  }
  await ok(req('POST', '/v1/sales', {
    saleId: 'S-1', receiptNumber: 'R-1', laneId: 'lane-1', locationId: 'store-01', cashierId: OWNER, tradingDay: DAY, committedAt: `${DAY}T10:00:00Z`, totalMinor: 15_000, currency: 'INR', packVersion: 1,
    lines: [{ productId: 'p-milk', quantityMinor: 2, uom: 'EA', unitPriceMinor: 5_000, lineTotalMinor: 10_000 }, { productId: 'p-rice', quantityMinor: 1, uom: 'EA', unitPriceMinor: 5_000, lineTotalMinor: 5_000 }],
    tenders: [{ kind: 'cash', amountMinor: 15_000 }],
  }, 'sale'), 'sale');
}

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the Organisation page links a department to its categories and shows its report (M01-FR-01)', () => {
  let browser: Browser;
  let shop: InboxShop;
  const owned = async (): Promise<{ departmentId: string; categoryIds: string[] }[]> =>
    ((await shop.cloud().request({ method: 'GET', path: '/v1/org/departments', userId: OWNER })).body as { departments: { departmentId: string; categoryIds: string[] }[] }).departments;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/organisation', html: 'organisation.html', dataGlobal: 'organisationData' },
      seed: seedShop,
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  const open = async (who: string) => {
    const context = await browser.newContext();
    await shop.signIn(context, who);
    const page = await context.newPage();
    const writes: string[] = []; const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${u.pathname}`); });
    await page.goto(`${shop.base}/organisation`, { waitUntil: 'load' });
    return { page, writes, errors, close: () => context.close() };
  };
  const says = async (page: Page, selector: string, expected: RegExp): Promise<void> => {
    await page.waitForFunction(([sel, source]) => new RegExp(source!).test((globalThis as unknown as { document: { querySelector(x: string): { textContent: string | null } | null } }).document.querySelector(sel!)?.textContent ?? ''), [selector, expected.source], { timeout: 15_000 });
  };

  it('asks the owner, saves the approved link naming its number, and the Dairy report holds only dairy — English and Tamil', async () => {
    const s = await open(OWNER);
    try {
      await says(s.page, '#dept-unowned', /Categories no department owns: dairy-cat, grocery-cat/);
      await s.page.selectOption('#dept-pick', 'D-dairy');
      await says(s.page, '#dept-owns', /Owns no categories yet/);
      expect(s.writes, 'reading writes nothing').toEqual([]);

      await s.page.check('#dept-cats input[data-cat="dairy-cat"]');
      await s.page.click('#dept-ask');
      await says(s.page, '#dept-link-status', /^Write why, then ask again/);
      expect(s.writes).toEqual([]);
      await s.page.fill('#dept-reason', 'the dairy counter');
      await s.page.click('#dept-ask');
      await says(s.page, '#dept-link-status', /^Asked\. The owner decides it on the Approvals page/);
      await says(s.page, '#dept-mine', /Approval number areq-.*: dairy-cat — waiting for the owner/);
      expect(s.writes).toEqual(['POST /v1/approvals/requests']);
      expect((await owned()).find((d) => d.departmentId === 'D-dairy')!.categoryIds).toEqual([]);

      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    // The asker cannot approve his own; the other owner approves (in his own session, as on his Approvals page).
    const inbox = (await shop.cloud().request({ method: 'GET', path: '/v1/approvals/requests', userId: OWNER2 })).body as { waitingForMe: { requestId: string; kind: string; subjectRef: string }[] };
    const req = inbox.waitingForMe.find((r) => r.kind === 'org_structure_change' && r.subjectRef === 'department:D-dairy')!;
    expect(req).toBeDefined();
    expect((await shop.cloud().request({ method: 'POST', path: `/v1/approvals/requests/${req.requestId}/decide`, userId: OWNER, idempotencyKey: 'self', body: { decision: 'approved', reason: 'mine' } })).status).toBe(422);
    await ok(shop.cloud().request({ method: 'POST', path: `/v1/approvals/requests/${req.requestId}/decide`, userId: OWNER2, idempotencyKey: 'other', body: { decision: 'approved', reason: 'dairy is its own counter' } }), 'approve');

    const t = await open(OWNER);
    try {
      await t.page.selectOption('#dept-pick', 'D-dairy');
      await says(t.page, '#dept-mine', new RegExp(`Approval number ${req.requestId}: dairy-cat — approved by ${OWNER2}`));
      // Head office unreachable: nothing saved, said so.
      await t.page.route('**/v1/org/departments/*/categories', (route) => route.abort());
      await t.page.click(`#dept-mine [data-use="${req.requestId}"]`);
      await says(t.page, '#dept-link-status', /^Head office cannot be reached — nothing was saved\./);
      await t.page.unroute('**/v1/org/departments/*/categories');
      expect((await owned()).find((d) => d.departmentId === 'D-dairy')!.categoryIds).toEqual([]);

      await t.page.click(`#dept-mine [data-use="${req.requestId}"]`);
      await says(t.page, '#dept-link-status', new RegExp(`^Saved at head office with the owner’s approval \\(${OWNER2}\\)\\.`));
      await says(t.page, '#dept-owns', /Owns: dairy-cat/);
      await says(t.page, '#dept-mine', /approved and saved/);
      expect((await owned()).find((d) => d.departmentId === 'D-dairy')!.categoryIds).toEqual(['dairy-cat']);
      expect(t.writes.filter((w) => w.endsWith('/categories'))).toEqual(['POST /v1/org/departments/D-dairy/categories', 'POST /v1/org/departments/D-dairy/categories']);

      // The report: only dairy's milk; the rice no department owns is shown apart.
      await t.page.selectOption('#report-dept', 'D-dairy');
      await t.page.fill('#report-day', DAY);
      await t.page.click('#report-show');
      await says(t.page, '#report-total', /^Dairy on 2030-05-20: ₹100\.00$/);
      await says(t.page, '#report-lines', /^p-milk: 2 sold on 1 bills, ₹100\.00$/);
      await says(t.page, '#report-unowned', /^Sold that day in categories no department owns: ₹50\.00$/);
      await t.page.click('#lang');
      await says(t.page, '#dept-h', /^பிரிவுகளும் அவற்றின் வகைகளும்/);
      await says(t.page, '#report-total', /2030-05-20 அன்று Dairy/);
      expect(t.errors).toEqual([]);
    } finally { await t.close(); }
  }, 180_000);

  it('a store manager reads the departments and a report, and is offered no way to change what a department owns', async () => {
    const s = await open(MANAGER);
    try {
      await says(s.page, '#dept-status', /You can read the departments; changing what one owns needs setup rights\./);
      expect(await s.page.locator('#dept-link').isHidden()).toBe(true);
      await s.page.selectOption('#report-dept', 'D-grocery');
      await s.page.fill('#report-day', DAY);
      await s.page.click('#report-show');
      await says(s.page, '#report-lines', /No sale of this department’s products that day\./);
      await says(s.page, '#report-note', /This department owns no categories yet/);
      expect(s.writes).toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    expect((await shop.cloud().request({ method: 'POST', path: '/v1/org/departments/D-grocery/categories', userId: MANAGER, idempotencyKey: randomUUID(), body: { categoryIds: [], reason: 'x', approvalId: 'areq-x' } })).status).toBe(403);
  }, 60_000);
});
