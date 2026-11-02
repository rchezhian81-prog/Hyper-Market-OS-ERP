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
 *   • DOCUMENTS (W3): the manager files the GST registration on the page as "not checked yet"; the owner, who saw the
 *     original, marks it checked on the page — head office records each under their own sign-in;
 *   • BANK (W3, a high-risk change): the owner asks for the bank change on the page (a full account number, and a call-back
 *     to a number we did not hold, are each refused before anything is sent); the accountant approves it on their own
 *     Approvals page (maker-checker); the owner records it on the Suppliers page naming that approval — the page then SHOWS
 *     head office's verified, masked bank account;
 *   • APPROVAL: the accountant approves on the page with a reason; head office records it in the accountant's name;
 *   • ACTIVE/BLOCKED (W3): the manager puts the supplier on hold with a reason (none: refused first) and lifts it again;
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
const GST = { kind: 'gst_registration', reference: '33KAVER1234F1Z5', validFrom: '2026-01-01', validUntil: '2027-12-31' };

interface Globals { readonly document: { querySelectorAll(x: string): { readonly length: number }; getElementById(x: string): { textContent: string | null; hidden?: boolean } | null }; readonly suppliersSession?: unknown }

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('supplier onboarding on the Suppliers page, on the production API (WF-02)', () => {
  let browser: Browser;
  let shop: InboxShop;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/suppliers', html: 'suppliers.html', dataGlobal: 'suppliersData' },
      alsoPages: [{ path: '/approvals', html: 'approvals.html', dataGlobal: 'approvalsData' }],
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

  const open = async (who: string, branch?: string, path = '/suppliers') => {
    const context = await browser.newContext();
    await shop.signIn(context, who, branch);
    const page = await context.newPage();
    const writes: string[] = []; const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${u.pathname}`); });
    await page.goto(`${shop.base}${path}`, { waitUntil: 'load' });
    if (path === '/suppliers') await page.waitForFunction(() => (globalThis as unknown as Globals).suppliersSession !== undefined, undefined, { timeout: 15_000 });
    return { page, writes, errors, close: async () => { await page.waitForLoadState('networkidle').catch(() => {}); await context.close(); } }; // settle in-flight reads before the API restarts
  };
  const says = async (page: Page, id: string, expected: RegExp): Promise<void> => {
    await page.waitForFunction(([i, source]) => new RegExp(source!).test((globalThis as unknown as Globals).document.getElementById(i!)?.textContent ?? ''), [id, expected.source], { timeout: 15_000 });
  };
  const api = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, key?: string) =>
    shop.cloud().request({ method, path, userId, ...(body === undefined ? {} : { body }), ...(key === undefined ? {} : { idempotencyKey: key }) });

  const pick = async (page: Page, supplierId: string): Promise<void> => {
    await page.locator(`#rec-supplier option[value="${supplierId}"]`).waitFor({ state: 'attached', timeout: 15_000 });
    await page.selectOption('#rec-supplier', supplierId);
    await page.click('#rec-show');
    await page.waitForSelector('#rec-body:not([hidden])', { timeout: 15_000 });
  };
  type Held = { supplier: { status: string; createdBy: string; approvedBy: string | null; gstin: string; paymentTermsDays: number; documents: { documentId: string; kind: string; verifiedBy?: string }[] }; blocked: boolean; bank: { accountRef: string; verifiedBy: string; requestedBy: string } | null; attention: string[] };
  const held = async (): Promise<Held> => (await api('GET', '/v1/purchase/suppliers/SUP-KAV', OWNER)).body as Held;

  it('application, papers, bank change and hold — every step on the page, by the people who take it; head office\'s record after a restart', async () => {
    // APPLICATION — the store manager proposes on the page, then files the GST registration as "not checked yet".
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

      // DOCUMENTS (WF-02 "KYC/commercial documents") — captured on the page; a "valid until" before "valid from" is refused first.
      await pick(s.page, 'SUP-KAV');
      await says(s.page, 'doc-list', /No paper is on file/);
      expect(await s.page.isHidden('#bank-box'), 'the manager may not change where a supplier is paid').toBe(true);
      await s.page.selectOption('#doc-kind', GST.kind);
      await s.page.fill('#doc-ref', GST.reference);
      await s.page.fill('#doc-from', GST.validUntil);
      await s.page.fill('#doc-until', GST.validFrom);
      await s.page.click('#doc-save');
      await says(s.page, 'doc-status', /cannot be before/);
      await s.page.fill('#doc-from', GST.validFrom);
      await s.page.fill('#doc-until', GST.validUntil);
      await s.page.click('#doc-save');
      await says(s.page, 'doc-status', /^Saved on the supplier/);
      await s.page.locator('#doc-list li[data-checked="no"]').waitFor({ timeout: 15_000 });
      expect(await s.page.locator('#doc-list li[data-checked="no"]').innerText()).toMatch(/GST registration 33KAVER1234F1Z5 · Valid from 2026-01-01 · Valid until 2027-12-31 · Not checked yet/);
      expect(s.writes).toEqual(['POST /v1/purchase/suppliers/SUP-KAV', 'POST /v1/purchase/suppliers/SUP-KAV']);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    expect((await held()).supplier).toMatchObject({ status: 'proposed', createdBy: MGR, gstin: '33KAVER1234F1Z5', paymentTermsDays: 30, documents: [{ kind: 'gst_registration' }] });
    expect((await held()).supplier.documents[0]!.verifiedBy).toBeUndefined();

    // The owner, who saw the original, marks it checked; then asks for the bank change — a full account number is refused.
    s = await open(OWNER);
    try {
      await pick(s.page, 'SUP-KAV');
      await s.page.click('#doc-list li[data-checked="no"] button.verify-doc');
      await says(s.page, 'doc-status', /Marked as checked by you/);
      await s.page.locator('#doc-list li[data-checked="yes"]').waitFor({ timeout: 15_000 });
      expect(await s.page.locator('#doc-list li[data-checked="yes"]').innerText()).toContain(`Checked by ${OWNER}`);
      await says(s.page, 'bank-asks', /You have not asked for a bank change/);
      await s.page.fill('#bank-account', '50100123456789');
      await s.page.selectOption('#bank-via', 'letter');
      await s.page.fill('#bank-on', '2026-11-01');
      await s.page.fill('#bank-called', '+91-90000-00001');
      await s.page.fill('#bank-held', '+91-90000-00001');
      await s.page.fill('#bank-why', 'supplier letter; rang back on the number we held');
      await s.page.click('#bank-ask');
      await says(s.page, 'bank-status', /looks like a full account number/);
      await s.page.fill('#bank-account', '••••4321');
      await s.page.fill('#bank-called', '+91-99999-99999');
      await s.page.click('#bank-ask');
      await says(s.page, 'bank-status', /not the number we already held/);
      await s.page.fill('#bank-called', '+91-90000-00001');
      await s.page.click('#bank-ask');
      await says(s.page, 'bank-status', /^Asked\. A different person/);
      await s.page.locator('#bank-asks li[data-status="waiting"]').waitFor({ timeout: 15_000 });
      expect(await s.page.locator('#bank-asks li[data-status="waiting"]').innerText()).toMatch(/SUP-KAV → ••••4321 · Waiting for a second person/);
      expect(s.writes).toEqual(['POST /v1/purchase/suppliers/SUP-KAV', 'POST /v1/approvals/requests']);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    expect((await held()).supplier.documents.map((d) => [d.kind, d.verifiedBy])).toEqual([['gst_registration', OWNER]]);
    expect((await held()).bank, 'nothing changes until a second person approves').toBeNull();

    // The accountant approves the change on their own Approvals page (maker-checker).
    s = await open(ACCT, undefined, '/approvals');
    try {
      const row = s.page.locator('#waiting li', { hasText: 'SUP-KAV' });
      await row.waitFor({ timeout: 15_000 });
      await row.locator('input.reason').fill('rang back on the number we held');
      await row.locator('button.approve').click();
      await row.waitFor({ state: 'detached', timeout: 15_000 });
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    // The owner records the approved change on the Suppliers page — the details are the approved request's own.
    s = await open(OWNER);
    try {
      await pick(s.page, 'SUP-KAV');
      await s.page.locator('#bank-asks li[data-status="approved"] button.record-bank').waitFor({ timeout: 15_000 });
      await s.page.click('#bank-asks li[data-status="approved"] button.record-bank');
      await says(s.page, 'bank-status', /^Recorded — payments now go to the verified account/);
      await s.page.locator('#bank-asks li[data-status="used"]').waitFor({ timeout: 15_000 });
      await says(s.page, 'rows', /Verified bank account ••••4321/);
      expect(s.writes).toEqual(['POST /v1/purchase/suppliers/SUP-KAV/bank-details']);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    expect((await held()).bank).toMatchObject({ accountRef: '••••4321', requestedBy: OWNER, verifiedBy: ACCT });

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

    // ACTIVE / BLOCKED — the manager puts the supplier on hold with a reason (none: refused first), then lifts it.
    s = await open(MGR, 'br-1');
    try {
      await pick(s.page, 'SUP-KAV');
      await says(s.page, 'hold-state', /not on hold/);
      await s.page.click('#hold-go');
      await says(s.page, 'hold-status', /Write why/);
      await s.page.fill('#hold-why', 'short deliveries three weeks running');
      await s.page.click('#hold-go');
      await says(s.page, 'hold-status', /^On hold/);
      await says(s.page, 'hold-state', /ON HOLD/);
      await says(s.page, 'rows', /On hold — nothing is paid or ordered/);
      expect((await held()).blocked).toBe(true);
      await s.page.fill('#hold-why', 'the supplier made the shortfall good');
      await s.page.click('#hold-go');
      await says(s.page, 'hold-status', /^Hold lifted/);
      expect(s.writes).toEqual(['POST /v1/purchase/suppliers/SUP-KAV/block-status', 'POST /v1/purchase/suppliers/SUP-KAV/block-status']);
      // The page reads in Tamil, papers section included.
      await s.page.click('#lang');
      await says(s.page, 'rec-h', /[஀-௿]/);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    // Head office's own record, after a restart of the API: every step, by the people who took it.
    await shop.restart();
    const one = await held();
    expect(one.supplier).toMatchObject({ status: 'active', createdBy: MGR, approvedBy: ACCT });
    expect(one.supplier.documents.map((d) => [d.kind, d.verifiedBy])).toEqual([['gst_registration', OWNER]]);
    expect(one.bank).toMatchObject({ accountRef: '••••4321', requestedBy: OWNER, verifiedBy: ACCT });
    expect(one.blocked).toBe(false);
    expect(one.attention).toEqual([]);
  }, 240_000);

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
