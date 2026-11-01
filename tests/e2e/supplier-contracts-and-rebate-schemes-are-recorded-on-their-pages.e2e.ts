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
import { P3, p3Shop } from '../support/p3-purchase';
import { decide } from '../support/approval-request';
import { ERP_NAVIGATION } from '../../apps/web-erp/src/navigation';

/**
 * **Supplier terms put on head office's record from a screen, in a real browser served by the store computer (M06-FR-03
 * "contracts, schemes, rebates, lead times and supplier scorecards" · §28 · ADR-0024).**
 *
 * Before this, no screen recorded a supplier contract with its lead time (`POST /v1/purchase/contracts/:contractId`) or a
 * rebate scheme (`POST /v1/purchase/rebate-schemes/:schemeId`). Through Chromium, over head office's real routes:
 *   • on the Supplier rebates page the buyer defines a 2.5% scheme: an incomplete form is refused before any call; he asks
 *     for approval; the accountant approves exactly that scheme in her own session; he records it — head office keeps it
 *     with her as its approver, and it appears on the rebate register with no "not approved" warning;
 *   • on the Supplier scorecard page he records a contract with a 4-day lead time BEFORE anyone approved it — kept, and the
 *     contract review shows it "Not approved"; he asks, the accountant approves, he records again — now "In force";
 *     the supplier's scorecard then measures on time against that contract;
 *   • a person who may only read is shown neither form; the page speaks Tamil.
 * Synthetic data only. Without a browser binary it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const KEY = ['supplier', 'terms', 'box', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = randomUUID();
const READER = 'u-reader-terms';
const today = new Date().toISOString().slice(0, 10);
const nextYear = `${Number(today.slice(0, 4)) + 1}${today.slice(4)}`;

describe.skipIf(!existsSync(CHROMIUM))('supplier contracts and rebate schemes recorded on their pages (M06-FR-03)', () => {
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
    await ho.provisionRole(TENANT, READER, 'accountant'); // head office lets her read the contracts; the store computer's pack offers her no form
    dir = await mkdtemp(join(tmpdir(), 'sre-supplier-terms-'));
    const packFile = join(dir, 'store-pack.json');
    const everything = [...new Set(['identity.self.read', 'purchase.contract.manage', ...ERP_NAVIGATION.map((i) => i.requires)])];
    await writeFile(packFile, JSON.stringify({
      version: 1, lossPreventionRules: [], policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1' },
      roles: [
        { id: 'owner', name: 'Owner', permissions: everything },
        { id: 'buyer', name: 'Buyer', permissions: ['identity.self.read', 'purchase.commitment.read', 'purchase.contract.manage'] },
        { id: 'reader', name: 'Reader', permissions: ['identity.self.read', 'purchase.commitment.read'] },
      ],
      roleAssignments: [{ userId: P3.OWNER, roleId: 'owner', branchScope: 'all' }, { userId: P3.BUYER, roleId: 'buyer', branchScope: 'all' }, { userId: READER, roleId: 'reader', branchScope: 'all' }],
    }), 'utf8');
    edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
      EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile, EDGE_SCREEN_TRUST_FORWARDED_USER: '1',
    }, () => {}))!;
  }, 240_000);
  afterAll(async () => { await browser?.close(); await edge?.stop(); if (dir !== undefined) await rm(dir, { recursive: true, force: true }); });
  afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });

  const open = async (who: string, path: string): Promise<{ page: Page; errors: string[]; writes: string[] }> => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', extraHTTPHeaders: { 'x-sre-user': who } });
    stops.push(() => context.close());
    const writes: string[] = [];
    await context.route('**/v1/**', async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const raw = req.postData();
      if (req.method() !== 'GET') writes.push(`${req.method()} ${url.pathname}`);
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
    const res = await page.goto(`http://127.0.0.1:${edge.screens!.port}${path}`, { waitUntil: 'load' });
    expect(res?.status(), `${path} is served by the store computer`).toBe(200);
    return { page, errors, writes };
  };
  const says = (page: Page, selector: string, pattern: RegExp): Promise<unknown> => page.waitForFunction(
    ([sel, src]) => new RegExp(src!).test((globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector(sel!)?.textContent ?? ''),
    [selector, pattern.source], { timeout: 15_000 },
  );
  const approveAsAccountant = async (subjectRef: string): Promise<void> => {
    const inbox = (await ho.request({ method: 'GET', path: '/v1/approvals/requests', userId: P3.MATCHER, tenantId: TENANT })).body as { waitingForMe: { requestId: string; subjectRef: string }[] };
    const request = inbox.waitingForMe.find((r) => r.subjectRef === subjectRef);
    expect(request, `the accountant has ${subjectRef} to approve`).toBeDefined();
    expect((await decide(ho, TENANT, P3.MATCHER, request!.requestId)).status).toBe(201);
  };

  it('a rebate scheme: refused when incomplete, asked for, approved by the accountant in her own session, recorded with her as approver', async () => {
    const { page: p, errors, writes } = await open(P3.BUYER, '/rebates/');
    await p.waitForSelector('#scheme:not([hidden])');
    await p.fill('#s-id', 'rb-9'); await p.fill('#s-supplier', 'sup-1'); await p.fill('#s-rate', '2.555');
    await p.click('#s-ask');
    await says(p, '#s-status', /^Fill in the scheme code, the supplier/);
    expect(writes).toEqual([]);
    await p.fill('#s-rate', '2.5'); await p.fill('#s-starts', today); await p.fill('#s-ends', nextYear);
    await p.click('#s-ask');
    await says(p, '#s-status', /^Asked\. A different person who approves suppliers approves exactly these terms/);
    await approveAsAccountant('rb-9');
    await p.click('#s-record');
    await says(p, '#s-status', /^Recorded with its approval/);
    await p.waitForSelector('#scheme-rows li[data-scheme="rb-9"]');
    const line = await p.textContent('#scheme-rows li[data-scheme="rb-9"]');
    expect(line).toContain('Rate 2.50%');
    expect(line).not.toContain('The scheme is not approved by Finance');
    expect(writes).toEqual(['POST /v1/approvals/requests', 'POST /v1/purchase/rebate-schemes/rb-9']);
    expect(errors).toEqual([]);
    const kept = ((await ho.request({ method: 'GET', path: '/v1/purchase/rebate-schemes', userId: P3.OWNER, tenantId: TENANT })).body as { schemes: { schemeId: string; rateBp: number; approvedBy?: string }[] }).schemes.find((s) => s.schemeId === 'rb-9');
    expect(kept).toMatchObject({ rateBp: 250, approvedBy: P3.MATCHER });
  }, 120_000);

  it('a contract with its lead time: recorded unapproved (shown so), then asked, approved and recorded again — in force; the scorecard uses it', async () => {
    const { page: p, errors, writes } = await open(P3.BUYER, '/supplier-scorecard/');
    await p.waitForSelector('#contract-form:not([hidden])');
    await p.fill('#k-id', 'ct-1'); await p.fill('#k-supplier', 'sup-1'); await p.fill('#k-starts', today); await p.fill('#k-ends', nextYear); await p.fill('#k-lead', '4');
    await p.click('#k-record');
    await says(p, '#k-status', /^Recorded WITHOUT an approval/);
    await p.waitForSelector('#contracts tr[data-contract="ct-1"][data-finding="unapproved"]');
    expect(await p.textContent('#contracts tr[data-contract="ct-1"]')).toContain('Not approved — no second person signed the terms');
    await p.click('#k-ask');
    await says(p, '#k-status', /^Asked\./);
    await approveAsAccountant('ct-1');
    await p.click('#k-record');
    await says(p, '#k-status', /^Recorded with its approval/);
    await p.waitForSelector('#contracts tr[data-contract="ct-1"][data-finding="active"]');
    expect(await p.textContent('#contracts tr[data-contract="ct-1"]')).toContain('In force');
    expect(writes).toEqual(['POST /v1/purchase/contracts/ct-1', 'POST /v1/approvals/requests', 'POST /v1/purchase/contracts/ct-1']);
    const card = (await ho.request({ method: 'GET', path: '/v1/purchase/suppliers/sup-1/scorecard', userId: P3.OWNER, tenantId: TENANT })).body as { contractId: string | null };
    expect(card.contractId, 'the scorecard now measures on time against this contract').toBe('ct-1');
    await p.click('#lang');
    await says(p, '#contract-h', /^விநியோகஸ்தர் ஒப்பந்தத்தைப் பதிவு செய்$/);
    expect(errors).toEqual([]);
  }, 120_000);

  it('a person who may only read is shown the contract review but neither form', async () => {
    const r = await open(READER, '/rebates/');
    expect(await r.page.isHidden('#scheme')).toBe(true);
    const s = await open(READER, '/supplier-scorecard/');
    await s.page.waitForSelector('#contracts-section:not([hidden])');
    expect(await s.page.isHidden('#contract-form')).toBe(true);
    await s.page.click('#contracts-show');
    await s.page.waitForSelector('#contracts tr[data-contract="ct-1"]');
    expect(s.writes).toEqual([]);
    expect([...r.errors, ...s.errors]).toEqual([]);
    // Head office refuses a reader's write too.
    const refused = await ho.request({ method: 'POST', path: '/v1/purchase/contracts/ct-2', userId: P3.CASHIER, tenantId: TENANT, idempotencyKey: 'x', body: { supplierId: 'sup-1', startsOn: today, endsOn: nextYear, agreedLeadTimeDays: 1 } });
    expect(refused.status).toBe(403);
  }, 60_000);
});
