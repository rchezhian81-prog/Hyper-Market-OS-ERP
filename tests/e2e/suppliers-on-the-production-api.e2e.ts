import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';

/**
 * **Supplier onboarding through the Suppliers page, in a real browser, on the PRODUCTION API over real PostgreSQL (WF-02 ·
 * M06-FR-01 · §28 · ADR-0024).**
 *
 * `suppliers-delivery.e2e.ts` proves the page against a stub cloud. This is the connected proof: the page is served in
 * front of the real API (no stub); who is looking comes from head office's own `GET /v1/identity/me`; every `/v1` call
 * goes to the API under the signed-in person's token. Through Chromium:
 *
 *   • APPLICATION: the store manager (purchasing) proposes the supplier on the page — nothing written on open; head office
 *     keeps it as `proposed`, awaiting approval, created by the manager; the manager is offered no approve;
 *   • DOCUMENTS and BANK: the GST registration (verified by its sender, the owner) and the bank change (asked by the owner,
 *     approved by the accountant in their own session — maker-checker) go to head office's own routes. No screen
 *     captures a supplier document or asks for a bank change yet (see the report), so these two steps are sent through
 *     the API here, by the same people, and the page then SHOWS head office's verified bank account;
 *   • APPROVAL: the accountant approves on the page with a reason; head office records it in the accountant's name;
 *   • after a RESTART of the API, head office's record holds every step; a cashier sees "not permitted" and no supplier;
 *     the page reads in Tamil; no page errors.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['suppliers', 'e2e', 'production', 'signing', 'key'].join('-').padEnd(48, '0');
const ACCT = 'u-acct';
const CASHIER = 'u-cash-br1';
const GST = { documentId: 'doc-gst', kind: 'gst_registration', reference: '33KAVER1234F1Z5', validFrom: '2026-01-01', validUntil: '2027-12-31' };

interface Globals { readonly document: { querySelectorAll(x: string): { readonly length: number }; getElementById(x: string): { textContent: string | null; hidden?: boolean } | null }; readonly suppliersSession?: unknown }

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('supplier onboarding on the Suppliers page, on the production API (WF-02)', () => {
  let browser: Browser;
  let shop: InboxShop;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/suppliers', html: 'suppliers.html', dataGlobal: 'suppliersData' },
      seed: async (cloud) => {
        await cloud.grant(ACCT, 'accountant');
        const gid = `grant-${CASHIER}`;
        await ok(cloud.request({ method: 'POST', path: '/v1/identity/grants', userId: 'u-hr', idempotencyKey: `${gid}-ask`, body: { grantId: gid, userId: CASHIER, roleId: 'cashier', branchScope: ['br-1'], reason: 'till at br-1' } }), 'ask cashier grant');
        await ok(cloud.request({ method: 'POST', path: `/v1/identity/grants/${gid}/approve`, userId: OWNER, idempotencyKey: `${gid}-approve`, body: {} }), 'approve cashier grant');
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 120_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  const open = async (who: string, branch?: string) => {
    const context = await browser.newContext();
    await shop.signIn(context, who, branch);
    const page = await context.newPage();
    const writes: string[] = []; const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${u.pathname}`); });
    await page.goto(`${shop.base}/suppliers`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as Globals).suppliersSession !== undefined, undefined, { timeout: 15_000 });
    return { page, writes, errors, close: async () => { await page.waitForLoadState('networkidle').catch(() => {}); await context.close(); } }; // settle in-flight reads before the API restarts
  };
  const says = async (page: Page, id: string, expected: RegExp): Promise<void> => {
    await page.waitForFunction(([i, source]) => new RegExp(source!).test((globalThis as unknown as Globals).document.getElementById(i!)?.textContent ?? ''), [id, expected.source], { timeout: 15_000 });
  };
  const api = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, key?: string) =>
    shop.cloud().request({ method, path, userId, ...(body === undefined ? {} : { body }), ...(key === undefined ? {} : { idempotencyKey: key }) });

  it('application on the page → documents and bank at head office → approval on the page; every step is head office\'s record after a restart', async () => {
    // APPLICATION — the store manager proposes on the page.
    let s = await open(MGR, 'br-1');
    try {
      expect(s.writes, 'nothing is written on open').toEqual([]);
      expect(await s.page.isHidden('#approver')).toBe(true); // no approval right
      await s.page.fill('#propose-code', 'SUP-KAV');
      await s.page.fill('#propose-name', 'Kaveri Foods');
      await s.page.fill('#propose-gstin', '33kaver1234f1z5');
      await s.page.fill('#propose-terms', '30');
      await s.page.click('#propose');
      await s.page.waitForSelector('#result:not([hidden])', { timeout: 15_000 });
      await says(s.page, 'result-text', /Supplier proposed/);
      await s.page.locator('#rows li.row[data-supplier-id="SUP-KAV"]').waitFor({ timeout: 15_000 });
      expect(s.writes).toEqual(['POST /v1/purchase/suppliers/SUP-KAV']);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    expect((await api('GET', '/v1/purchase/suppliers/SUP-KAV', OWNER)).body).toMatchObject({ supplier: { status: 'proposed', createdBy: MGR, gstin: '33KAVER1234F1Z5', paymentTermsDays: 30 } });

    // DOCUMENTS — sent and verified by the owner, under the owner's own sign-in (no screen captures them yet).
    await ok(api('POST', '/v1/purchase/suppliers/SUP-KAV', OWNER, { name: 'Kaveri Foods', gstin: '33KAVER1234F1Z5', paymentTermsDays: 30, documents: [{ ...GST, verifiedBy: OWNER }] }, 'docs'), 'documents');
    // BANK — the owner asks; the accountant approves in their own session; the owner records the change naming it.
    const change = { newAccount: 'tok-kaveri-acct', requestedVia: 'letter', calledBackOn: '+91-90000-00001', numberWeAlreadyHeld: '+91-90000-00001', requestedAt: new Date().toISOString() };
    const asked = await api('POST', '/v1/approvals/requests', OWNER, { kind: 'supplier_bank_change', subjectRef: 'SUP-KAV', details: { ...change, supplierId: 'SUP-KAV' }, valueMinor: null, summary: 'Kaveri Foods bank account', reason: 'supplier letter, called back' }, 'ask-bank');
    expect(asked.status).toBe(201);
    const requestId = (asked.body as { requestId: string }).requestId;
    await ok(api('POST', `/v1/approvals/requests/${requestId}/decide`, ACCT, { decision: 'approved', reason: 'called back on the number we held' }, 'decide-bank'), 'approve bank change');
    await ok(api('POST', '/v1/purchase/suppliers/SUP-KAV/bank-details', OWNER, { ...change, approvalId: requestId }, 'bank'), 'bank details');

    // APPROVAL — the accountant on the page; the page shows head office's verified bank account.
    s = await open(ACCT);
    try {
      await s.page.locator('#rows li.row[data-supplier-id="SUP-KAV"]').waitFor({ timeout: 15_000 });
      expect(await s.page.locator('#rows li.row[data-supplier-id="SUP-KAV"]').innerText()).toContain('Verified bank account');
      expect(await s.page.$$eval('#approve-supplier option', (els) => els.map((e) => (e as unknown as { value: string }).value))).toEqual(['SUP-KAV']);
      await s.page.selectOption('#approve-supplier', 'SUP-KAV');
      await s.page.fill('#approve-reason', 'GST registration seen; bank called back on the number we held');
      await s.page.click('#approve');
      await says(s.page, 'result-text', /Supplier approved/);
      expect(s.writes).toEqual(['POST /v1/purchase/suppliers/SUP-KAV/approval']);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    // Head office's own record, after a restart of the API: every step, by the people who took it.
    await shop.restart();
    const one = (await api('GET', '/v1/purchase/suppliers/SUP-KAV', OWNER)).body as { supplier: { status: string; createdBy: string; approvedBy: string; documents: { documentId: string; verifiedBy: string }[] }; bank: { verifiedBy: string; requestedBy: string } | null; attention: string[] };
    expect(one.supplier).toMatchObject({ status: 'active', createdBy: MGR, approvedBy: ACCT });
    expect(one.supplier.documents.map((d) => [d.documentId, d.verifiedBy])).toEqual([['doc-gst', OWNER]]);
    expect(one.bank).toMatchObject({ requestedBy: OWNER, verifiedBy: ACCT });
    expect(one.attention).toEqual([]);
  }, 180_000);

  it('a cashier sees "not permitted", no supplier and no controls; the page reads in Tamil', async () => {
    const s = await open(CASHIER, 'br-1');
    try {
      await s.page.waitForSelector('#state:not([hidden])', { timeout: 15_000 });
      expect(((await s.page.textContent('#state-text')) ?? '').toLowerCase()).toContain('permission');
      expect(await s.page.locator('#rows li.row').count()).toBe(0);
      expect(await s.page.isHidden('#approver')).toBe(true);
      expect(await s.page.isHidden('#proposer')).toBe(true);
      expect(await s.page.locator('#title').innerText()).toBe('Suppliers');
      await s.page.click('#lang');
      await s.page.waitForFunction(() => /[஀-௿]/.test((globalThis as unknown as Globals).document.getElementById('title')?.textContent ?? ''), undefined, { timeout: 10_000 });
      expect(s.writes).toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  }, 60_000);
});
