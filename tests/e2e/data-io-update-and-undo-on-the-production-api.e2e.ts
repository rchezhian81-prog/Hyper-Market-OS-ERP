import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startRealCloud, type RealCloud } from '../support/real-store';
import { startPageShell, type PageShell } from './lib/page-shell';
import {
  templateView, SUPPLIER_INVOICE_SPEC, SUPPLIER_INVOICE_LABEL, PRODUCT_SPEC, PRODUCT_LABEL, PRODUCT_UPDATE_SPEC, PRODUCT_UPDATE_LABEL,
} from '../../services/purchase/src/import-templates';

/**
 * **M30 round 8 — the import console changes EXISTING products by file and UNDOES a load, in a real browser, on the
 * PRODUCTION API over PostgreSQL.** The owner picks "Change existing products", pastes a file and checks it: the preview says
 * what each row changes, from → to. They ask for approval; a manager (a different person) approves it in their own session;
 * the owner loads it and the load appears under "Loads already applied", in place. Then the owner asks to UNDO it — pressing
 * "Undo it" before anyone approved says so and changes nothing; once the manager approves, "Undo it" puts each product back
 * and the row says who undid it and why. The new words switch to Tamil like the rest of the page.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['data', 'io', 'undo', 'e2e', 'key'].join('-').padEnd(48, '0');
const OWNER = 'u-owner'; const MGR = 'u-mgr';
const FILE = ['productId,name,brand,primaryCategoryId,taxClass,allergens,countryOfOrigin,netQuantity,packerDetails,minimumAge', 'p-rice,Ponni Rice 5kg,Kaveri,,,,,,,', 'p-soap,,Neem,,,,,,,'].join('\n');

async function ok(p: Promise<{ status: number; body: unknown }>, label: string): Promise<unknown> {
  const r = await p;
  if (r.status >= 300) throw new Error(`${label}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the import console changes products by file and undoes a load, on the production API (M30)', () => {
  let browser: Browser;
  let cloud: RealCloud;
  let shell: PageShell;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    cloud = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId: randomUUID(), owner: OWNER, packSigningKey: KEY });
    await cloud.grant(MGR, 'store_manager');
    let n = 0;
    const post = (path: string, body: unknown) => ok(cloud.request({ method: 'POST', path, userId: OWNER, idempotencyKey: `seed-${++n}`, body }), path);
    await post('/v1/catalogue/categories/grocery', { name: 'Grocery', parentId: null });
    await post('/v1/catalogue/categories/staples', { name: 'Staples', parentId: 'grocery', regulated: ['food', 'packed'] });
    await post('/v1/catalogue/categories/home', { name: 'Home care', parentId: null });
    await post('/v1/catalogue/products/p-rice/publish', { product: { sku: 'RICE5', name: 'Rice 5kg', baseUom: 'each', primaryCategoryId: 'staples', taxClass: '1006', lifecycle: 'draft', safety: { allergens: [], countryOfOrigin: 'India', netQuantity: '5 kg', packerDetails: 'Synthetic Mills' } } });
    await post('/v1/catalogue/products/p-soap/publish', { product: { sku: 'SOAP', name: 'Soap', baseUom: 'each', primaryCategoryId: 'home', taxClass: '3401', lifecycle: 'draft' } });
    shell = await startPageShell({
      cloud: () => cloud, page: { path: '/data-io', html: 'data-io.html', dataGlobal: 'dataIoData' },
      // The templates the store computer ships (head office's store pack, the data-io policy).
      extra: { importTemplates: [
        templateView({ spec: SUPPLIER_INVOICE_SPEC, label: SUPPLIER_INVOICE_LABEL, financial: true }),
        templateView({ spec: PRODUCT_SPEC, label: PRODUCT_LABEL, financial: false }),
        templateView({ spec: PRODUCT_UPDATE_SPEC, label: PRODUCT_UPDATE_LABEL, financial: false }),
      ] },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await shell?.stop();
    await cloud?.stop();
  });

  const product = async (id: string) => ((await cloud.request({ method: 'GET', path: `/v1/catalogue/products/${id}`, userId: OWNER })).body as { product: Record<string, unknown> }).product;
  /** The manager approves the owner's waiting request of this kind for this subject — in the manager's own session. */
  const managerApproves = async (kind: string, subjectRef: string): Promise<void> => {
    const inbox = (await cloud.request({ method: 'GET', path: '/v1/approvals/requests', userId: MGR })).body as { waitingForMe: { requestId: string; kind: string; subjectRef: string }[] };
    const req = inbox.waitingForMe.find((r) => r.kind === kind && r.subjectRef === subjectRef);
    expect(req, `a waiting ${kind} for ${subjectRef}`).toBeDefined();
    await ok(cloud.request({ method: 'POST', path: `/v1/approvals/requests/${req!.requestId}/decide`, userId: MGR, idempotencyKey: `decide-${req!.requestId}`, body: { decision: 'approved', reason: 'checked against the supplier list' } }), 'approve');
  };
  const said = async (page: Page, id: string): Promise<string> => {
    await page.locator(`#${id}:not([hidden])`).waitFor({ timeout: 15_000 });
    return (await page.textContent(`#${id}-text`)) ?? '';
  };

  it('preview says what changes; ask → a manager approves → load; then ask to undo → (not yet) → approved → undone, and the row says so', async () => {
    const context = await browser.newContext();
    await shell.signIn(context, OWNER);
    const page = await context.newPage();
    try {
      await page.goto(`${shell.base}/data-io`, { waitUntil: 'load' });
      await page.locator('#import-template option[value="product-update-v1"]').waitFor({ state: 'attached', timeout: 15_000 });
      await page.selectOption('#import-template', 'product-update-v1');
      await page.fill('#import-file', FILE);
      await page.click('#validate');
      await page.locator('#preview:not([hidden])').waitFor({ timeout: 15_000 });
      const preview = (await page.textContent('#preview')) ?? '';
      expect(preview).toContain('What this file changes');
      expect(preview).toContain('line 2 · p-rice: name "Rice 5kg" → "Ponni Rice 5kg"');
      expect(preview).toContain('line 3 · p-soap: brand "" → "Neem"');

      // Ask; a different person approves; load.
      await page.fill('#import-job', 'U-1');
      await page.fill('#import-why', 'brand names from the September supplier list');
      await page.click('#ask');
      expect(await said(page, 'ask-result')).toContain('Waiting for a second person');
      await managerApproves('data_import_commit', 'U-1');
      await page.click('#commit');
      await page.locator('#commit-result-text', { hasText: 'Loaded.' }).waitFor({ timeout: 15_000 });
      expect(await product('p-rice')).toMatchObject({ name: 'Ponni Rice 5kg', brand: 'Kaveri' });
      const row = page.locator('#my-loads li[data-job-id="U-1"]');
      await row.waitFor({ timeout: 15_000 });
      expect(await row.textContent()).toContain('In place');

      // UNDO — asked, not yet approved: "Undo it" says so and changes nothing.
      await row.locator('.undo-why').fill('wrong brand file');
      await row.locator('.ask-undo').click();
      await row.locator('.undo-result', { hasText: 'Waiting for a second person to approve the undo' }).waitFor({ timeout: 15_000 });
      await row.locator('.undo-btn').click();
      await row.locator('.undo-result', { hasText: 'Not undone yet' }).waitFor({ timeout: 15_000 });
      expect((await product('p-rice'))['name']).toBe('Ponni Rice 5kg');

      // The manager approves the undo; "Undo it" puts each product back, and the row says who undid it and why.
      await managerApproves('data_import_rollback', 'U-1');
      await row.locator('.undo-btn').click();
      const undone = page.locator('#my-loads li[data-job-id="U-1"]');
      await undone.locator('.undo-result', { hasText: 'Undone.' }).waitFor({ timeout: 15_000 });
      expect(await undone.textContent()).toContain(`Undone — ${OWNER} asked, ${MGR} approved: "wrong brand file"`);
      expect(await undone.locator('.undo-btn').count()).toBe(0);
      expect(await product('p-rice')).toMatchObject({ name: 'Rice 5kg' });
      expect((await product('p-soap'))['brand']).toBeUndefined();

      // Tamil, like the rest of the page.
      await page.click('#lang');
      await page.locator('#loads-heading', { hasText: 'ஏற்கனவே ஏற்றப்பட்டவை' }).waitFor({ timeout: 15_000 });
      expect(await page.locator('#my-loads li[data-job-id="U-1"]').textContent()).toContain('திரும்பப் பெறப்பட்டது');
    } finally {
      await context.close();
    }
  }, 90_000);
});
