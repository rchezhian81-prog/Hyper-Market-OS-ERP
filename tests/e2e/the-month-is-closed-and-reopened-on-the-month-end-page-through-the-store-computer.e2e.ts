import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { apiHarness, TEST_PACK_KEY, type ApiHarness } from '../support/api-harness';
import { decide } from '../support/approval-request';
import { buildStorePackSections } from '../../services/api/src/store-pack-builder';

/**
 * **OB-567 (owner, 31 Oct 2026) — a month is closed and reopened on head office's Month-end page, in a real browser,
 * served by a real store computer, over head office's real routes (M23-FR-04 · WF-18 · ADR-0024 · §28).**
 *
 * Through Chromium, as the signed-in person, on the page the store computer serves:
 *   • the office Finance page has neither a close nor a reopen step, and points to the Month-end page;
 *   • on the Month-end page the owner asks for the month's signature and the accountant approves it in their own session;
 *     with NOTHING checked at head office the close is refused by head office ("no figures to check") — the month stays
 *     open and the signature is not spent;
 *   • once head office holds independent evidence that agrees (the tills' card takings, the provider's settlement file and
 *     the bank's statement), the same close goes through, signed by the accountant;
 *   • the owner then reopens it there, for a written reason the accountant approved — and head office has it open again.
 * Synthetic data only (the fixtures of `the-month-closes-on-independent-evidence.test.ts`). Without a browser it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const TENANT = randomUUID();
const OWNER = 'u-owner'; const ACCT = 'u-acct';
const STORE = 'store-1';
const PERIOD = '2026-09';
const REASON = 'supplier credit note for September arrived late';

const cardSale = (saleId: string, ref: string, amountMinor: number, kind = 'card') => ({
  saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', cashierId: OWNER, tradingDay: '2026-09-01', committedAt: '2026-09-01T10:00:00.000Z',
  totalMinor: amountMinor + 5_000, currency: 'INR', packVersion: 1,
  lines: [{ productId: 'P1', quantityMinor: 1, uom: 'each', unitPriceMinor: amountMinor + 5_000, lineTotalMinor: amountMinor + 5_000 }],
  tenders: [{ kind, amountMinor, ref }, { kind: 'cash', amountMinor: 5_000 }],
});
const BATCH = {
  batchId: 'PB-0903', providerId: 'test-acquirer', currency: 'INR', settlementDate: '2026-09-03',
  lines: [{ id: 'l1', ref: 'PAY-1', amountMinor: 100_000 }, { id: 'l2', ref: 'PAY-2', amountMinor: 50_000 }],
  declaredGrossMinor: 150_000, declaredFeesMinor: 1_500, declaredNetMinor: 148_500, sourceName: 'acquirer-2026-09-03.json',
};
const CSV = ['Date,Reference,Narrative,Debit,Credit', '03/09/2026,UTR778899 PB-0903,ACQUIRER SETTLEMENT,,"1,485.00"', '15/09/2026,CHQ001,Rent,"20,000.00",'].join('\n');
const STATEMENT = { statementId: 'HDFC-2026-09', accountRef: 'HDFC-current-1', fromDate: '2026-09-01', toDate: '2026-09-30', openingMinor: 5_000_000, closingMinor: 5_000_000 + 148_500 - 2_000_000, sourceName: 'hdfc-sep.csv', csv: CSV };

describe.skipIf(!HAVE_BROWSER)('OB-567 — the month is closed and reopened on the Month-end page, through the store computer', () => {
  let browser: Browser;
  let ho: ApiHarness;
  let edge: EdgeProcess;
  let dir: string;
  const stops: (() => Promise<void>)[] = [];
  const post = async (path: string, body: unknown, userId = OWNER): Promise<void> => {
    const r = await ho.request({ method: 'POST', path, userId, tenantId: TENANT, idempotencyKey: `k-${randomUUID()}`, body });
    expect(r.status, `${path}: ${JSON.stringify(r.body)}`).toBeLessThan(300);
  };
  const stateAtHeadOffice = async (): Promise<string | undefined> =>
    ((await ho.request({ method: 'GET', path: '/v1/finance/periods', userId: OWNER, tenantId: TENANT })).body as { periods: { period: string; state: string }[] })
      .periods.find((p) => p.period === PERIOD)?.state;
  /** The accountant decides the one request waiting for them, in their own session. */
  const accountantDecides = async (decision: 'approved' | 'rejected'): Promise<string> => {
    const inbox = (await ho.request({ method: 'GET', path: '/v1/approvals/requests', userId: ACCT, tenantId: TENANT })).body as { waitingForMe: { requestId: string }[] };
    expect(inbox.waitingForMe).toHaveLength(1);
    const id = inbox.waitingForMe[0]!.requestId;
    expect((await decide(ho, TENANT, ACCT, id, decision, 'checked')).status).toBe(201);
    return id;
  };

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    ho = apiHarness();
    await ho.seedOwner(TENANT, OWNER);
    await ho.provisionRole(TENANT, ACCT, 'accountant'); // signs the month; posted nothing into it
    const sections = await buildStorePackSections({ store: ho.store, now: () => new Date().toISOString(), signer: undefined as never, settings: async () => undefined, storeName: async () => undefined }, TENANT, STORE);
    dir = await mkdtemp(join(tmpdir(), 'sre-ob567-'));
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, JSON.stringify({ ...sections, version: 1, lossPreventionRules: [], policies: { tradingDayCutoff: '00:00', storeId: STORE, branchId: STORE } }), 'utf8');
    edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: TEST_PACK_KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
      EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile, EDGE_SCREEN_TRUST_FORWARDED_USER: '1',
    }, () => {}))!;
  }, 240_000);
  afterAll(async () => { await browser?.close(); await edge?.stop(); if (dir !== undefined) await rm(dir, { recursive: true, force: true }); });
  afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });

  /** A page on the store computer as `who`; head office's API carried on that origin, as that person. */
  const open = async (who: string, path: string): Promise<{ page: Page; errors: string[] }> => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', extraHTTPHeaders: { 'x-sre-user': who } });
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
  ).catch(async (e: unknown) => {
    const seen = await page.evaluate((sel) => (globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector(sel)?.textContent ?? '(none)', selector);
    throw new Error(`${selector} never said ${pattern.source}; it says: ${JSON.stringify(seen)} (${String(e)})`);
  });
  const isHidden = (page: Page, id: string): Promise<boolean> => page.evaluate((i) => (globalThis as unknown as { document: { getElementById(x: string): { hidden: boolean } | null } }).document.getElementById(i)?.hidden ?? true, id);

  it('the Finance page has neither a close nor a reopen step, and points to the Month-end page', async () => {
    const { page, errors } = await open(OWNER, '/finance');
    for (const gone of ['#ask-close', '#close-month', '#ask-reopen', '#reopen', '#close-why', '#reopen-reason']) expect(await page.locator(gone).count(), gone).toBe(0);
    expect(await page.getAttribute('#month-end-link', 'href')).toBe('../finance-close/');
    expect(errors).toEqual([]);
  });

  it('Month-end: refused by head office with nothing checked; closed once the evidence agrees; then reopened for a written reason', async () => {
    const { page, errors } = await open(OWNER, '/finance-close');
    await page.fill('#period', PERIOD);
    await page.dispatchEvent('#period', 'change');
    await page.click('#tab-month');
    await says(page, '#month-state', /This month is open at head office\./);
    expect(await isHidden(page, 'close-box')).toBe(false);
    expect(await isHidden(page, 'reopen-box')).toBe(true);

    // Ask for the signature; the accountant approves it in their own session.
    await page.click('#ask-close');
    await says(page, '#month-status', /Asked\. Waiting for someone who may sign a month/);
    await accountantDecides('approved');

    // Nothing checked at head office: refused BY head office, in its words; the month stays open; the signature unspent.
    await page.click('#close-month');
    await says(page, '#month-status', /Not closed — head office has no figures to check for this month, so it cannot be signed\./);
    expect(await stateAtHeadOffice()).not.toBe('closed');
    expect(await isHidden(page, 'close-box')).toBe(false);

    // Head office now holds independent evidence that agrees: the tills' card takings, the provider's file, the bank's statement.
    await post('/v1/sales', cardSale('S1', 'PAY-1', 100_000));
    await post('/v1/sales', cardSale('S2', 'PAY-2', 50_000, 'upi'));
    await post('/v1/settlement/batches', BATCH);
    await post('/v1/finance/bank-statements', STATEMENT);

    // The same, still-unspent signature closes it now.
    await page.click('#close-month');
    await says(page, '#month-status', /Closed and signed\. u-acct signed it/);
    expect(await stateAtHeadOffice()).toBe('closed');
    await says(page, '#month-state', /closed and signed at head office/);
    expect(await isHidden(page, 'reopen-box')).toBe(false);
    expect(await isHidden(page, 'close-box')).toBe(true);

    // Reopen, here, for a written reason the accountant approves.
    await page.fill('#reopen-reason', REASON);
    await page.click('#ask-reopen');
    await says(page, '#month-status', /Asked\. .*The month stays closed until then\./);
    await accountantDecides('approved');
    await page.click('#reopen');
    await says(page, '#month-status', /Reopened\. u-acct approved it/);
    expect(await stateAtHeadOffice()).toBe('open');
    await says(page, '#month-state', /This month is open at head office\./);

    // In Tamil, the tab says where it is.
    await page.click('#lang');
    await says(page, '#tab-month', /மாதத்தை மூடு அல்லது மீண்டும் திற/);
    expect(errors).toEqual([]);
  });
});
