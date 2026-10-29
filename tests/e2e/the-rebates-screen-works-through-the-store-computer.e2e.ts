import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
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
import { sentWithApproval, decide } from '../support/approval-request';
import { ERP_NAVIGATION } from '../../apps/web-erp/src/navigation';
import { theEvening, pinTheEveningClock, pinThePageClock } from '../support/evening-clock';

/**
 * **The Supplier rebates page in a real browser, served by the store computer, over head office's real routes (QG-02 ·
 * M06-FR-03 · D03-FR-03 · OB-404 · OB-380).**
 *
 * The real store computer serves the page (as the person the front signed in); head office's API surface runs in memory and
 * every `/v1` call reaches it as that person, on the box's own origin. Through Chromium:
 *   • the buyer reads the register — the scheme, what it earned from the matched bills and what may still be claimed; a claim
 *     above that is refused in head office's words; a claim within it is raised and waits for Finance;
 *   • the buyer asks Finance; recording it as sent before Finance approves is refused; once a different person (the
 *     accountant) approves it, one click records it sent — and its due day says "not set";
 *   • its claim document shows, as sent (no draft line);
 *   • the owner sets the answer days: the claim then shows its due day; the page speaks Tamil.
 * Synthetic data only. Without a browser binary it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['rebates', 'screen', 'box', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = randomUUID();
// The shop's own date, at an evening UTC moment (19:30 UTC — already tomorrow in the shop), pinned so the evening case is
// proven whenever this runs: the bill, the accrual and "Sent on" are the shop's days, never the UTC date.
const EVENING = theEvening();
const TODAY = EVENING.shopDate;

describe.skipIf(!HAVE_BROWSER)('the Supplier rebates page through the store computer (QG-02 · OB-404)', () => {
  let browser: Browser;
  let ho: ApiHarness;
  let edge: EdgeProcess;
  let dir: string;
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    pinTheEveningClock(EVENING);
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    ho = apiHarness();
    await p3Shop(ho, TENANT, 'sup-1');
    const call = caller(ho, TENANT);
    // ₹800 of the supplier's bills matched → a 3% scheme earns ₹24.
    const lines = [{ productId: 'rice', qty: 16, unitMinor: 5_000 }];
    await issuedOrder(call, 'po-a', lines);
    await received(call, 'grn-a', 'po-a', lines);
    await capturedAndMatched(call, 'inv-a', 'po-a', lines, undefined, 'sup-1', TODAY);
    const scheme = { supplierId: 'sup-1', basis: 'purchase_value', rateBp: 300, startsOn: `${TODAY.slice(0, 4)}-01-01`, endsOn: `${TODAY.slice(0, 4)}-12-31` };
    const sch = await sentWithApproval(ho, TENANT, P3.OWNER, P3.MATCHER, { kind: 'rebate_scheme', subjectRef: 'rb-1', pathIds: { schemeId: 'rb-1' } }, scheme,
      (body) => ho.request({ method: 'POST', path: '/v1/purchase/rebate-schemes/rb-1', userId: P3.OWNER, tenantId: TENANT, idempotencyKey: 'scheme-rb-1', body }));
    if (sch.status !== 201) throw new Error(`scheme: ${JSON.stringify(sch.body)}`);
    const acc = await call('POST', '/v1/purchase/rebate-schemes/rb-1/accruals/q', P3.OWNER, { periodFrom: `${TODAY.slice(0, 4)}-01-01`, periodTo: TODAY });
    if (acc.status !== 201) throw new Error(`accrual: ${JSON.stringify(acc.body)}`);

    dir = await mkdtemp(join(tmpdir(), 'sre-rebates-screen-'));
    const packFile = join(dir, 'store-pack.json');
    const everything = [...new Set(['identity.self.read', 'purchase.contract.manage', 'purchase.rebate.terms.set', 'finance.journal.post', ...ERP_NAVIGATION.map((i) => i.requires)])];
    await writeFile(packFile, JSON.stringify({
      version: 1, lossPreventionRules: [], policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1' },
      roles: [
        { id: 'owner', name: 'Owner', permissions: everything },
        { id: 'buyer', name: 'Buyer', permissions: ['identity.self.read', 'purchase.commitment.read', 'purchase.contract.manage'] },
      ],
      roleAssignments: [{ userId: P3.OWNER, roleId: 'owner', branchScope: 'all' }, { userId: P3.BUYER, roleId: 'buyer', branchScope: 'all' }],
    }), 'utf8');
    edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
      EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile, EDGE_SCREEN_TRUST_FORWARDED_USER: '1',
    }, () => {}))!;
  }, 240_000);
  afterAll(async () => { await browser?.close(); await edge?.stop(); if (dir !== undefined) await rm(dir, { recursive: true, force: true }); vi.useRealTimers(); });
  afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });

  /** A page on the box's origin as `who`; head office's API carried on that origin, as that person. */
  const open = async (who: string, path: string): Promise<{ page: Page; errors: string[] }> => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', extraHTTPHeaders: { 'x-sre-user': who } });
    await pinThePageClock(context);
    stops.push(() => context.close());
    await context.route('**/v1/**', async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const raw = req.postData();
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
    return { page, errors };
  };
  const says = (page: Page, selector: string, pattern: RegExp): Promise<unknown> => page.waitForFunction(
    ([sel, src]) => new RegExp(src!).test((globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector(sel!)?.textContent ?? ''),
    [selector, pattern.source], { timeout: 15_000 },
  );

  it('raise within what is earned, ask Finance, record sent once a different person approved, show the document, and the owner sets the due days', async () => {
    const buyer = await open(P3.BUYER, '/rebates/');
    const p = buyer.page;
    await p.waitForSelector('#raise:not([hidden])');
    expect(await p.isHidden('#period'), 'the buyer is not offered the owner\'s answer days').toBe(true);
    await p.click('#r-show');
    await p.waitForSelector('#scheme-rows li[data-scheme="rb-1"]');
    const line = await p.textContent('#scheme-rows li[data-scheme="rb-1"]');
    expect(line).toContain('Earned ₹24.00');
    expect(line).toContain('May still be claimed ₹24.00');
    expect(line).toContain('Money earned and not claimed yet');
    expect(await p.textContent('#r-period')).toContain('Not set. No claim can show as overdue until the owner sets it.');
    await says(p, '#claim-rows', /No claim raised yet\./);

    await p.fill('#c-scheme', 'rb-1'); await p.fill('#c-amount', '25');
    await p.click('#c-raise');
    await says(p, '#c-status', /^Head office refused: Scheme rb-1 has earned 2400 paise/);
    await p.fill('#c-amount', '15'); await p.fill('#c-note', 'Q3 purchases');
    await p.click('#c-raise');
    await says(p, '#c-status', /^Claim raised\. Next: ask Finance to approve it\.$/);
    await p.waitForSelector('#claim-rows li[data-state="raised"]');
    const claimId = (await p.getAttribute('#claim-rows li[data-state="raised"]', 'data-claim'))!;
    expect(await p.textContent(`#claim-rows li[data-claim="${claimId}"]`)).toContain('Waiting for Finance to approve');

    await p.click(`#claim-rows li[data-claim="${claimId}"] button[data-act="ask"]`);
    await says(p, `#claim-rows li[data-claim="${claimId}"] .claim-status`, /^Asked\./);
    await p.click(`#claim-rows li[data-claim="${claimId}"] button[data-act="send"]`);
    await says(p, `#claim-rows li[data-claim="${claimId}"] .claim-status`, /^Finance has not approved this claim yet/);

    // The accountant approves it in their own session (the Approvals page's own route).
    const inbox = (await ho.request({ method: 'GET', path: '/v1/approvals/requests', userId: P3.MATCHER, tenantId: TENANT })).body as { waitingForMe: { requestId: string; subjectRef: string }[] };
    const request = inbox.waitingForMe.find((r) => r.subjectRef === claimId)!;
    expect((await decide(ho, TENANT, P3.MATCHER, request.requestId)).status).toBe(201);

    await p.click(`#claim-rows li[data-claim="${claimId}"] button[data-act="send"]`);
    await p.waitForSelector(`#claim-rows li[data-claim="${claimId}"][data-state="sent"]`);
    const sent = await p.textContent(`#claim-rows li[data-claim="${claimId}"]`);
    expect(sent).toContain('Sent — waiting for the supplier');
    expect(sent).toContain(`Sent on ${TODAY}`);
    expect(sent).toContain('Due day not set');
    await says(p, `#claim-rows li[data-claim="${claimId}"] .claim-status`, /^Recorded as sent\./);
    expect(await p.$$(`#claim-rows li[data-claim="${claimId}"] button[data-act="send"]`)).toHaveLength(0);

    await p.click(`#claim-rows li[data-claim="${claimId}"] button[data-act="doc"]`);
    await p.waitForSelector('#doc:not([hidden])');
    expect(await p.textContent('#doc-h')).toBe(`Supplier rebate claim ${claimId}`);
    expect(await p.isHidden('#doc-draft')).toBe(true);
    expect(await p.textContent('#doc-body')).toContain('Amount: ₹15.00');
    expect(await p.textContent('#doc-body')).toContain('To supplier: ');
    expect(await p.textContent('#doc-body')).toContain('(sup-1)');
    expect(buyer.errors).toEqual([]);

    const owner = await open(P3.OWNER, '/rebates/');
    await owner.page.waitForSelector('#period:not([hidden])');
    await owner.page.fill('#p-days', '0');
    await owner.page.click('#p-set');
    await says(owner.page, '#p-status', /^Write a whole number of days, more than 0\.$/);
    await owner.page.fill('#p-days', '30');
    await owner.page.click('#p-set');
    await says(owner.page, '#r-period', /30 days after the claim is sent/);
    const due = new Date(Date.parse(`${TODAY}T00:00:00Z`) + 30 * 86_400_000).toISOString().slice(0, 10);
    expect(await owner.page.textContent(`#claim-rows li[data-claim="${claimId}"]`)).toContain(`Answer due ${due}`);
    await owner.page.click('#lang');
    await says(owner.page, '#register-h', /^திட்டங்களும் கோரிக்கைகளும்$/);
    expect(owner.errors).toEqual([]);
  });
});
