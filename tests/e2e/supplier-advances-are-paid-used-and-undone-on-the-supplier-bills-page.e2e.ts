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
import { P3, p3Shop, caller, issuedOrder, received, capturedAndMatched } from '../support/p3-purchase';
import { decide } from '../support/approval-request';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/index';
import { askedThenConfirmed } from './lib/confirm-sheet';

/**
 * **Supplier advances on the Supplier bills page, in a real browser served by the store computer, over head office's real
 * routes (D10-FR-01 "AP/AR and advances" · §28 · WF-18 · hard rule #2).**
 *
 * Before this section no screen called `/v1/finance/supplier-advances*`: the accountant could not record or use an advance.
 * Through Chromium:
 *   • the paying accountant asks to pay ₹1,000 in advance (an incomplete form is refused before any call); recording it is
 *     not offered until a DIFFERENT person approves it in their own session; then one click records exactly what was
 *     approved — one journal, the approver named; the register and the ledger's advances account agree;
 *   • the matching accountant uses ₹300 of it against the supplier's matched bill — left ₹700 — then undoes the use by a
 *     compensating journal — left ₹1,000 again; the undo is never offered twice;
 *   • a person who may only check bills is shown no advances section (head office refuses their read too); Tamil words.
 * Synthetic data only. Without a browser binary it SKIPS.
 */

// U2b: the shared date field reads dd/mm/yyyy, as a shop person writes it
const ddmm = (iso: string): string => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const KEY = ['supplier', 'advances', 'box', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = randomUUID();
const CHECKER = 'u-bill-checker';
const TODAY = new Date().toISOString().slice(0, 10);
const leg = (account: string, side: 'debit' | 'credit') => ({ account, side, component: 'amount' });
const MAP = { rules: [...DEFAULT_RETAIL_POSTING_MAP.rules,
  { kind: 'supplier_advance', legs: [leg('supplier_advances', 'debit'), leg('bank_clearing', 'credit')] },
  { kind: 'supplier_advance_applied', legs: [leg('supplier_payable', 'debit'), leg('supplier_advances', 'credit')] }] };

describe.skipIf(!existsSync(CHROMIUM))('supplier advances on the Supplier bills page (D10-FR-01)', () => {
  let browser: Browser;
  let ho: ApiHarness;
  let edge: EdgeProcess;
  let dir: string;
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    ho = apiHarness();
    await p3Shop(ho, TENANT, 'sup-1');
    await ho.provisionRole(TENANT, CHECKER, 'cashier');
    const call = caller(ho, TENANT);
    const lines = [{ productId: 'rice', qty: 10, unitMinor: 5_000 }];
    await issuedOrder(call, 'po-a', lines);
    await received(call, 'grn-a', 'po-a', lines);
    await capturedAndMatched(call, 'inv-a', 'po-a', lines, undefined, 'sup-1', TODAY);
    const mapped = await ho.request({ method: 'PUT', path: '/v1/finance/posting-map', userId: P3.MATCHER, tenantId: TENANT, idempotencyKey: 'map-1', body: MAP });
    if (mapped.status >= 300) throw new Error(`map: ${JSON.stringify(mapped.body)}`);

    dir = await mkdtemp(join(tmpdir(), 'sre-supplier-advances-'));
    const packFile = join(dir, 'store-pack.json');
    const accountant = ['identity.self.read', 'purchase.invoice.match', 'purchase.invoice.capture', 'finance.period.read', 'purchase.supplier.pay', 'finance.journal.post'];
    await writeFile(packFile, JSON.stringify({
      version: 1, lossPreventionRules: [], policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1' },
      roles: [
        { id: 'accountant', name: 'Accountant', permissions: accountant },
        { id: 'checker', name: 'Bill checker', permissions: ['identity.self.read', 'purchase.invoice.match'] },
      ],
      roleAssignments: [...[P3.PAYER, P3.PAY_APPROVER, P3.MATCHER].map((userId: string) => ({ userId, roleId: 'accountant', branchScope: 'all' })), { userId: CHECKER, roleId: 'checker', branchScope: 'all' }],
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
      const raw = req.postData();
      if (req.method() !== 'GET') writes.push(`${req.method()} ${url.pathname.replace(/(adv|use|undo)-[A-Za-z0-9]+/g, '$1-…')}`);
      const answer = await ho.request({
        method: req.method() as 'GET', path: url.pathname, userId: who, tenantId: TENANT,
        ...(raw === null ? {} : { body: JSON.parse(raw) as unknown }),
        ...(req.headers()['idempotency-key'] === undefined ? {} : { idempotencyKey: req.headers()['idempotency-key'] }),
        ...(url.search === '' ? {} : { query: Object.fromEntries(url.searchParams) }),
      });
      await route.fulfill({ status: answer.status, contentType: 'application/json', body: JSON.stringify(answer.body ?? {}) });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const res = await page.goto(`http://127.0.0.1:${edge.screens!.port}/supplier-bills/`, { waitUntil: 'load' });
    expect(res?.status()).toBe(200);
    return { page, errors, writes };
  };
  const says = (page: Page, selector: string, pattern: RegExp): Promise<unknown> => page.waitForFunction(
    ([sel, src]) => new RegExp(src!).test((globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector(sel!)?.textContent ?? ''),
    [selector, pattern.source], { timeout: 15_000 },
  );

  it('asked, approved by a different person, recorded exactly as approved; used against the matched bill; undone by a compensating journal', async () => {
    const payer = await open(P3.PAYER);
    const p = payer.page;
    await p.waitForSelector('#adv-pay:not([hidden])');
    await p.fill('#adv-supplier', 'sup-1'); await p.fill('#adv-amount', '1000');
    await p.click('#adv-ask');
    await says(p, '#adv-ask-status', /^Fill in the supplier, an amount in rupees/);
    expect(payer.writes).toEqual([]);
    await p.fill('#adv-on', ddmm(TODAY)); await p.selectOption('#adv-method', 'bank_transfer'); await p.fill('#adv-ref', 'NEFT-ADV-1'); await p.fill('#adv-po', 'po-a');
    await p.click('#adv-ask');
    await says(p, '#adv-ask-status', /^Asked\. A different person who pays suppliers approves exactly this payment/);
    await p.waitForSelector('#adv-asks li[data-status="waiting"]');
    expect(await p.locator('#adv-asks button[data-act="record"]').count(), 'nothing to record before a second person approves').toBe(0);
    await says(p, '#adv-list', /No advance has been paid\./);

    // A different person approves it in their own session (the Approvals page's own route).
    const inbox = (await ho.request({ method: 'GET', path: '/v1/approvals/requests', userId: P3.PAY_APPROVER, tenantId: TENANT })).body as { waitingForMe: { requestId: string; kind: string }[] };
    const request = inbox.waitingForMe.find((r) => r.kind === 'supplier_payment')!;
    expect((await decide(ho, TENANT, P3.PAY_APPROVER, request.requestId)).status).toBe(201);

    await p.click('#adv-show');
    await p.waitForSelector('#adv-asks li[data-status="approved"] button[data-act="record"]');
    // U1 · OB-626: the consequence-and-confirm sheet names the money and the supplier; Go back sends nothing; Confirm sends once.
    await askedThenConfirmed(p, () => p.click('#adv-asks li[data-status="approved"] button[data-act="record"]'), /Record ₹1,000\.00 paid to supplier sup-1 as an advance/, () => payer.writes.length);
    await says(p, '#adv-status', /^Recorded — one journal in the books, with who approved it\.$/);
    const row = await p.textContent('#adv-list li[data-advance]');
    expect(row).toContain('Supplier sup-1 · order po-a');
    expect(row).toContain('Paid ₹1,000.00 · Used against bills ₹0.00 · Left ₹1,000.00');
    expect(row).toContain(`approved by ${P3.PAY_APPROVER}`);
    await says(p, '#adv-ledger', /^The advances left on the register equal the advances account in the ledger\.$/);
    expect(payer.writes).toEqual(['POST /v1/approvals/requests', 'POST /v1/finance/supplier-advances/adv-…']);
    expect(payer.errors).toEqual([]);

    const matcher = await open(P3.MATCHER);
    const m = matcher.page;
    await m.click('#adv-show');
    const li = m.locator('#adv-list li[data-advance]');
    await li.waitFor();
    await li.locator('input.use-bill').fill('inv-a'); await li.locator('input.use-amount').fill('300'); await li.locator('input.use-on').fill(TODAY);
    await li.locator('button[data-act="use"]').click();
    await says(m, '#adv-status', /^Used against the bill — one journal in the books\.$/);
    await says(m, '#adv-list li[data-advance]', /Used against bills ₹300\.00 · Left ₹700\.00/);
    expect(await m.textContent('#adv-list li[data-advance]')).toContain('bill inv-a · ₹300.00');
    const use = m.locator('#adv-list li[data-advance] [data-application]').first();
    await use.locator('input.undo-on').fill(TODAY);
    await use.locator('button[data-act="undo"]').click();
    await says(m, '#adv-status', /^Undone by a compensating journal/);
    await says(m, '#adv-list li[data-advance]', /Used against bills ₹0\.00 · Left ₹1,000\.00/);
    expect(await m.locator('#adv-list button[data-act="undo"]').count(), 'an undone use is not offered for undoing again').toBe(0);
    await says(m, '#adv-ledger', /equal the advances account/);
    await m.click('#lang');
    await says(m, '#adv-h', /^விநியோகஸ்தர் முன்பணங்கள்$/);
    expect(matcher.writes).toEqual(['POST /v1/finance/supplier-advances/adv-…/applications/use-…', 'POST /v1/finance/supplier-advances/adv-…/applications/undo-…']);
    expect(matcher.errors).toEqual([]);
    const reg = (await ho.request({ method: 'GET', path: '/v1/finance/supplier-advances', userId: P3.MATCHER, tenantId: TENANT })).body as { advances: { paidMinor: number; appliedMinor: number; leftMinor: number; applications: unknown[] }[]; agrees: boolean };
    expect(reg.advances).toEqual([expect.objectContaining({ paidMinor: 100_000, appliedMinor: 0, leftMinor: 100_000 })]);
    expect(reg.advances[0]!.applications).toHaveLength(2);
    expect(reg.agrees).toBe(true);
  }, 120_000);

  it('a person who may only check bills is shown no advances section, and head office refuses their read', async () => {
    expect((await ho.request({ method: 'GET', path: '/v1/finance/supplier-advances', userId: CHECKER, tenantId: TENANT })).status).toBe(403);
    const c = await open(CHECKER);
    expect(await c.page.isHidden('#adv-section')).toBe(true);
    expect(c.writes).toEqual([]);
    expect(c.errors).toEqual([]);
  }, 60_000);
});
