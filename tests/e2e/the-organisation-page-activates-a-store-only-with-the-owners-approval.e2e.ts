import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, type InboxShop } from './lib/ai-inbox-shop';

/**
 * M01-FR-01 "structural changes are owner-approved (maker-checker, §28)" (OB-288 lane 1 · P1) — the Organisation page, in a
 * real browser, on the PRODUCTION API over real PostgreSQL: pressing Activate on a ready store ASKS for the owner's
 * approval (nothing is activated); pressing it again says it still waits; once the other owner approves on the Approvals
 * page, Activate makes it active, naming that approval; the maker never approves their own. English and Tamil.
 * Needs DATABASE_URL and Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['org', 'approval', 'e2e', 'key'].join('-').padEnd(48, '0');
const G1 = '33AABCS1429B1Z1';
const OWNER2 = 'u-owner-2';

type Doc = { document: { getElementById(x: string): { textContent: string | null } | null } };

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the Organisation page activates a store only with the owner\'s approval (M01-FR-01)', () => {
  let browser: Browser;
  let shop: InboxShop;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/organisation', html: 'organisation.html', dataGlobal: 'organisationData' },
      seed: async (cloud) => {
        await cloud.grant(OWNER2, 'owner');
        await ok(cloud.request({ method: 'POST', path: '/v1/org/nodes/C-GO', userId: OWNER, idempotencyKey: 'c-go', body: { kind: 'company', name: 'Synthetic Retail' } }), 'company');
        await ok(cloud.request({ method: 'POST', path: `/v1/org/gst-registrations/${G1}`, userId: OWNER, idempotencyKey: 'g-go', body: { companyId: 'C-GO', legalName: 'Synthetic Retail Pvt Ltd' } }), 'gst');
        await ok(cloud.request({ method: 'POST', path: '/v1/org/nodes/B-GO', userId: OWNER, idempotencyKey: 'b-go', body: { kind: 'branch', name: 'Ready store', parentId: 'C-GO', companyId: 'C-GO', gstin: G1 } }), 'branch');
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  const statusSays = (page: Page, re: RegExp) => page.waitForFunction((src) => new RegExp(src).test((globalThis as unknown as Doc).document.getElementById('tree-status')?.textContent ?? ''), re.source, { timeout: 15_000 });
  const status = async (): Promise<string> => ((await shop.cloud().request({ method: 'GET', path: '/v1/org/nodes/B-GO', userId: OWNER })).body as { node: { status: string } }).node.status;

  it('asks first, waits, and activates once the other owner approves — English and Tamil', async () => {
    const context = await browser.newContext();
    await shop.signIn(context, OWNER);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${shop.base}/organisation`, { waitUntil: 'load' });
    const activate = page.locator('#tree li[data-node="B-GO"] button[data-act="activate"]');
    await activate.waitFor({ timeout: 15_000 });
    await activate.click();
    await statusSays(page, /⏳ Asked — making a place active is the owner's approval/);
    expect(await status()).toBe('draft');
    await activate.click();
    await statusSays(page, /⏳ Still waiting for the owner's approval/);
    // The maker cannot approve their own; the other owner approves on the Approvals page (in his own session).
    const inbox = (await shop.cloud().request({ method: 'GET', path: '/v1/approvals/requests', userId: OWNER2 })).body as { waitingForMe: { requestId: string; kind: string; subjectRef: string }[] };
    const req = inbox.waitingForMe.find((r) => r.kind === 'org_structure_change' && r.subjectRef === 'B-GO')!;
    const self = await shop.cloud().request({ method: 'POST', path: `/v1/approvals/requests/${req.requestId}/decide`, userId: OWNER, idempotencyKey: 'self', body: { decision: 'approved', reason: 'mine' } });
    expect(self.status).toBe(422);
    await ok(shop.cloud().request({ method: 'POST', path: `/v1/approvals/requests/${req.requestId}/decide`, userId: OWNER2, idempotencyKey: 'other', body: { decision: 'approved', reason: 'GST and address checked' } }), 'approve');
    await page.click('#lang');
    await page.locator('#tree li[data-node="B-GO"] button[data-act="activate"]').click();
    await statusSays(page, /செயல்படுத்தப்பட்டது/);
    expect(await status()).toBe('active');
    expect(errors).toEqual([]);
    await context.close();
  }, 180_000);
});
