import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { apiHarness, TEST_IDP, TEST_PACK_KEY, type ApiHarness } from '../support/api-harness';
import { STORE_RULES } from '../support/store-rules';
import type { HttpRequest } from '../../services/kernel/src/index';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { makeEvent } from '../../packages/contracts/src/event';
import { tradingMonthIn, shopDateIn } from '../../packages/calendar/src/shop-clock';
import { financeAdapter, eInvoiceAdapter, eWayBillAdapter } from '../../services/api/src/adapters';
import { TALLY_OUTBOX_STREAM } from '../../services/api/src/finance-bridge-adapters';
import type { IrnRequest } from '../../packages/e-invoice/src/index';

/**
 * **Round A (screen gap audit, 31 Oct 2026) in a real browser: five office pages that were empty forever now show head
 * office's records, served by the REAL store computer (`startEdge`) from the setup it pulled from the REAL head-office
 * routes (the API harness), with synthetic data.**
 *
 *   • Products and pricing — head office's products in their departments; an item's prices already set are read from head
 *     office through the store computer's relay when it is opened (never shown as "no price set" before they are read);
 *   • Expiry and recalls — the store's batches with their dates and units ("2.500 kg", "20 units"), a recalled batch off the
 *     markdown list, an undated batch counted, the recall on the recall list;
 *   • Finance — the month closed and signed at head office, the Tally files' dead letter;
 *   • Reports — sales reports runnable because head office says the shop records sales (no longer "records nothing");
 *   • GST reconciliation — head office's e-invoice and e-way bill queue, the portal's disagreement shown.
 * Every page says it is the store computer's copy and how old it is. With the cable OUT and after a cold restart the copy
 * is still there, and opening an item says head office cannot be reached — never a made-up price. A cashier opening
 * Finance is refused. Synthetic data, a fresh tenant. Skips where no browser binary is present.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const S1 = 'S1';
const SETTINGS = { tradingDayCutoff: '02:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 5_000, cashVarianceToleranceMinor: 5_000, privacySlaDays: 15, warehouseId: 'S1-BACK' };
const inDays = (n: number): string => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

interface Doc { readonly document: { readonly body: { readonly innerText: string } } }
const bodyText = (page: Page): Promise<string> => page.evaluate(() => (globalThis as unknown as Doc).document.body.innerText);

describe.skipIf(!existsSync(CHROMIUM))('Round A: five office pages show head office\'s records through the store computer', () => {
  let browser: Browser;
  let h: ApiHarness;
  let T = '';
  let period = '';
  let dir = '';
  let edge: EdgeProcess | undefined;
  const net = { up: true };
  const savedFetch = globalThis.fetch;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    h = apiHarness();
    T = randomUUID();
    let n = 0;
    const ok = async (method: 'POST', path: string, userId: string, body: unknown): Promise<void> => {
      const r = await h.request({ method, path, userId, tenantId: T, idempotencyKey: `e2e-${n++}`, body });
      if (r.status >= 300) throw new Error(`${path}: ${r.status} ${JSON.stringify(r.body)}`);
    };
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-box', 'store_computer', [S1]);
    await h.provisionRole(T, 'u-mgr', 'store_manager', [S1]);
    await h.provisionRole(T, 'u-acct', 'accountant', 'all');
    await h.provisionRole(T, 'u-cash', 'cashier', [S1]);
    await ok('POST', '/v1/org/nodes/C1', 'u-owner', { kind: 'company', name: 'SRE Retail' });
    await ok('POST', `/v1/org/nodes/${S1}`, 'u-owner', { kind: 'branch', name: 'SRE Hyper Market', parentId: 'C1', companyId: 'C1' });
    await ok('POST', `/v1/stores/${S1}/settings`, 'u-owner', SETTINGS);
    await ok('POST', `/v1/stores/${S1}/rules`, 'u-owner', STORE_RULES);
    await ok('POST', '/v1/catalogue/tax-classes/1006/rates/2017-07-01', 'u-owner', { rateBps: 500 });
    await ok('POST', '/v1/catalogue/tax-classes/0401/rates/2017-07-01', 'u-owner', { rateBps: 0 });
    await ok('POST', '/v1/catalogue/products/p-rice/publish', 'u-owner', {
      product: { sku: 'RICE-LOOSE', name: 'Ponni rice (loose)', baseUom: 'kg', primaryCategoryId: 'grocery', taxClass: '1006', lifecycle: 'active', mrpHistory: [{ value: { minor: 7_000, currency: 'INR' }, effectiveFrom: '2026-01-01' }] },
      categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }],
    });
    await ok('POST', '/v1/catalogue/products/p-milk/publish', 'u-owner', {
      product: { sku: 'MILK-500', name: 'Toned milk 500 ml', baseUom: 'ea', primaryCategoryId: 'dairy', taxClass: '0401', lifecycle: 'active' },
      categories: [{ categoryId: 'dairy', name: 'Dairy', parentId: null }],
    });
    const today = shopDateIn(new Date().toISOString());
    await ok('POST', '/v1/prices/list/p-rice/entries/e1', 'u-owner', { scope: 'store', scopeRef: S1, priceMinor: 6_200, mrpMinor: 7_000, costMinor: 4_800, marginFloorBps: 2_000, currency: 'INR', effectiveFrom: today });
    await ok('POST', '/v1/prices/list/p-milk/entries/e1', 'u-owner', { scope: 'store', scopeRef: S1, priceMinor: 2_800, mrpMinor: 3_000, costMinor: 2_200, marginFloorBps: 2_000, currency: 'INR', effectiveFrom: today });
    await ok('POST', '/v1/catalogue/pack', 'u-owner', { storeId: S1, asOf: today });
    const now = new Date().toISOString();
    const recv = (movementId: string, productId: string, locationId: string, quantityMinor: number, uom: string, batchId: string, expiry?: string) =>
      ok('POST', '/v1/inventory/movements', 'u-owner', { movementId, productId, locationId, kind: 'received', quantityMinor, uom, batchId, ...(expiry === undefined ? {} : { expiry }), occurredAt: now, enteredBy: 'u-owner' });
    await recv('m-rice-1', 'p-rice', S1, 2_500, 'kg', 'RICE-B1', inDays(10));
    await recv('m-milk-1', 'p-milk', S1, 12, 'ea', 'MILK-B7', inDays(2));
    await recv('m-milk-2', 'p-milk', 'S1-BACK', 8, 'ea', 'MILK-B7', inDays(2));
    await recv('m-milk-3', 'p-milk', S1, 5, 'ea', 'MILK-B8', inDays(5));
    await recv('m-milk-4', 'p-milk', S1, 3, 'ea', 'MILK-NODATE');
    await ok('POST', '/v1/quality/recalls/MILK-B8', 'u-owner', { reason: 'Supplier notice: seal failure on this batch' });
    period = tradingMonthIn(now, { timeZone: 'Asia/Kolkata', tradingDayCutoff: SETTINGS.tradingDayCutoff });
    await financeAdapter({ store: h.store, now: () => now }).markClosed(T, period, 'u-ca');
    const posting = (day: string, state: string, extra: Record<string, unknown>) => ({
      postingId: `tally-day:${day}:1`, idempotencyKey: `tally-${day}-1`, period, journalRef: `tally-day:${day}:1`, debitMinor: 150_000, creditMinor: 150_000,
      state, attempts: 1, queuedAt: now, day, sequence: 1, journalIds: [`je-${day}`], ...extra,
    });
    await h.store.append(T, TALLY_OUTBOX_STREAM, makeEvent({ id: 'tally-0', type: 'TallyOutboxFact', occurredAt: now, idempotencyKey: `tally-fact-${T}-0`, source: 'test', payload: { change: 'queued', posting: posting(`${period}-02`, 'dead_lettered', { lastFailure: 'no Tally ledger named for account 4100', deadLetteredAt: now }), by: 'system:tally-outbox', at: now } }));
    const einv = eInvoiceAdapter({ store: h.store, now: () => now });
    await einv.recordSubmit(T, 'INV-1', { version: '1.1' } as unknown as IrnRequest, now);
    await einv.recordResponse(T, 'INV-1', { state: 'registered', irn: 'IRN-0001', detail: 'registered with the IRP' } as never, now);
    await einv.recordSubmit(T, 'INV-2', { version: '1.1' } as unknown as IrnRequest, now);
    await einv.recordResponse(T, 'INV-2', { state: 'registered', irn: 'IRN-0002', detail: 'registered with the IRP' } as never, now);
    await einv.recordMismatch(T, 'INV-2', { observedState: 'cancelled', note: 'the IRP now says this IRN was cancelled', observedAt: now } as never, now);
    const ewb = eWayBillAdapter({ store: h.store, now: () => now });
    await ewb.recordSubmit(T, 'MOVE-1', { version: '1.0' } as never, now);
    await ewb.recordResponse(T, 'MOVE-1', { state: 'pending_unknown', detail: 'the portal did not answer' } as never, now);

    // The store computer's line to head office (its machine credential) — cut when `net.up` is false.
    globalThis.fetch = (async (url: string, init: RequestInit = {}): Promise<Response> => {
      if (url.startsWith('http://127.0.0.1:')) return savedFetch(url, init);
      if (!net.up) throw new Error('ECONNREFUSED');
      const hdr = (init.headers ?? {}) as Record<string, string>;
      const u = new URL(url);
      const res = await h.raw({
        method: (init.method ?? 'GET') as HttpRequest['method'], path: u.pathname, query: Object.fromEntries(u.searchParams),
        token: hdr['authorization']?.replace(/^Bearer /, ''), idempotencyKey: hdr['idempotency-key'],
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
      });
      return new Response(JSON.stringify(res.body), { status: res.status, headers: { date: new Date().toUTCString() } });
    }) as unknown as typeof globalThis.fetch;
    dir = await mkdtemp(join(tmpdir(), 'sre-round-a-e2e-'));
  }, 240_000);

  afterAll(async () => {
    globalThis.fetch = savedFetch;
    await browser?.close();
    await edge?.stop();
    if (dir !== '') await rm(dir, { recursive: true, force: true });
  });

  const start = async (): Promise<EdgeProcess> => (await startEdge({
    EDGE_DATA_DIR: dir, EDGE_TENANT_ID: T, PACK_SIGNING_KEY: TEST_PACK_KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
    EDGE_SCREEN_TRUST_FORWARDED_USER: '1', EDGE_STORE_PACK_SOURCE: 'head-office', EDGE_STORE_ID: S1,
    CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box', tenantId: T, branchId: S1 }),
  }, () => {}))!;

  /** A browser as the front signs `user` in: it names them to the store computer, and carries the page's `/v1` reads to head
   *  office in THEIR session — the part the hosted front plays (and the store PC's head-office sign-in, OB-388). */
  const asPerson = async (user: string): Promise<{ context: BrowserContext; page: Page; errors: string[] }> => {
    const context = await browser.newContext({ serviceWorkers: 'block', extraHTTPHeaders: { 'x-sre-user': user } });
    await context.route('**/v1/**', async (route) => {
      if (!net.up) { await route.abort('internetdisconnected'); return; }
      const u = new URL(route.request().url());
      const res = await h.raw({ method: route.request().method() as HttpRequest['method'], path: u.pathname, query: Object.fromEntries(u.searchParams), token: TEST_IDP.issue({ sub: user, tenantId: T, branchId: S1 }) });
      await route.fulfill({ status: res.status, contentType: 'application/json', body: JSON.stringify(res.body) });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    return { context, page, errors };
  };
  const waitText = async (page: Page, selector: string, text: string): Promise<void> => {
    try {
      await page.waitForFunction(([sel, want]) => {
        const node = (globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector(sel!);
        return (node?.textContent ?? '').includes(want!);
      }, [selector, text], { timeout: 15_000 });
    } catch (e) {
      throw new Error(`waiting for "${text}" in ${selector}; it says: ${(await page.textContent(selector).catch(() => null)) ?? '(no such element)'}`, { cause: e });
    }
  };

  const theCopy = /These figures are the store computer's copy of head office's records, as head office last sent it at \d{4}-\d{2}-\d{2} \d{2}:\d{2} \((just now|\d+ minute\(s\) old)\)/;

  async function lookAtEveryPage(base: string, online: boolean): Promise<void> {
    // ── Products and pricing, as the manager.
    {
      const { context, page, errors } = await asPerson('u-mgr');
      await page.goto(`${base}/catalogue/`, { waitUntil: 'load' });
      await waitText(page, '#item-list', 'Ponni rice (loose)');
      expect(await page.isHidden('#sample')).toBe(true);
      expect(await page.textContent('#store-copy')).toMatch(theCopy);
      const list = (await page.textContent('#item-list')) ?? '';
      expect(list).toContain('Toned milk 500 ml');
      expect(list).toContain('price: open the item to read it from head office'); // never "No price set" before it is read
      expect(list).not.toContain('No price set');
      // Open "Change a price" for the rice: its prices are read from head office through the relay.
      await page.click('button.price-this[data-sku="RICE-LOOSE"]');
      if (online) {
        await waitText(page, '#price-history', '₹62.00');
        expect(await page.textContent('#price-history')).toContain('active');
        await waitText(page, '#item-list', '₹62.00');
      } else {
        await waitText(page, '#price-history', 'Head office cannot be reached from this store computer just now');
        expect(await page.textContent('#price-history')).not.toContain('never had a price set');
      }
      expect(errors).toEqual([]);
      await context.close();
    }
    // ── Expiry and recalls, as the manager.
    {
      const { context, page, errors } = await asPerson('u-mgr');
      await page.goto(`${base}/expiry/`, { waitUntil: 'load' });
      await waitText(page, '#expiry-list', 'Toned milk 500 ml');
      expect(await page.textContent('#store-copy')).toMatch(theCopy);
      const list = (await page.textContent('#expiry-list')) ?? '';
      expect(list).toContain('Toned milk 500 ml — 20 units'); // floor and back store together
      expect(list).toContain('Ponni rice (loose) — 2.500 kg'); // grams worded in kg (OB-31)
      expect(list).toContain('MILK-B7');
      expect(list).not.toContain('MILK-B8'); // recalled: off the markdown list, never sold
      expect(await page.textContent('#no-batches')).toBe('1 more batch(es) in this shop have no expiry date on record, so they cannot be checked here.');
      await page.click('#tab-recall');
      await waitText(page, '#recall-list', 'Toned milk 500 ml');
      expect(await page.textContent('#recall-list')).toContain('OPEN');
      await page.click('#lang');
      await waitText(page, '#store-copy', 'கடைக் கணினி நகல்');
      expect(errors).toEqual([]);
      await context.close();
    }
    // ── Finance, as the accountant: the month closed and signed at head office; the dead letter on the queue.
    {
      const { context, page, errors } = await asPerson('u-acct');
      await page.goto(`${base}/finance/`, { waitUntil: 'load' });
      await waitText(page, '#blockers', 'signed by u-ca');
      expect(await page.textContent('#store-copy')).toMatch(theCopy);
      await page.click('#tab-queue');
      await waitText(page, '#dead-list', 'no Tally ledger named for account 4100');
      expect(errors).toEqual([]);
      await context.close();
    }
    // ── Reports, as the manager: the sales reports are runnable (the shop records sales — head office says so).
    {
      const { context, page, errors } = await asPerson('u-mgr');
      await page.goto(`${base}/reporting/`, { waitUntil: 'load' });
      await waitText(page, '#reports-list', 'Sales by day');
      expect(await page.textContent('#store-copy')).toMatch(theCopy);
      expect(errors).toEqual([]);
      await context.close();
    }
    // ── GST reconciliation, as the manager: head office's queue, the disagreement shown.
    {
      const { context, page, errors } = await asPerson('u-mgr');
      await page.goto(`${base}/gst-reconciliation/`, { waitUntil: 'load' });
      await waitText(page, '#rows', 'INV-2');
      expect(await page.isHidden('#sample')).toBe(true);
      expect(await page.textContent('#store-copy')).toMatch(theCopy);
      const text = await bodyText(page);
      expect(text).toContain('MOVE-1');
      expect(text).toContain('The portal now shows something different from what is on file. Do not re-issue — investigate first.');
      expect(text).toContain('IRN-0001');
      expect(errors).toEqual([]);
      await context.close();
    }
    // ── A cashier is refused the finance page — none of its figures reach them.
    {
      const { context, page } = await asPerson('u-cash');
      const res = await page.goto(`${base}/finance/`, { waitUntil: 'load' });
      expect(res?.status()).toBe(403);
      expect(await bodyText(page)).not.toContain('tally-day');
      await context.close();
    }
  }

  it('every page shows head office\'s records with the copy\'s age; offline after a cold restart the copy stays and an item says head office cannot be reached', async () => {
    edge = await start();
    expect(await edge.refreshStorePack!()).toMatchObject({ status: 'updated' });
    await lookAtEveryPage(`http://127.0.0.1:${edge.screens!.port}`, true);

    // ── THE CABLE IS CUT; COLD RESTART.
    net.up = false;
    await edge.stop();
    edge = await start();
    expect(await edge.refreshStorePack!()).toMatchObject({ status: 'offline' });
    await lookAtEveryPage(`http://127.0.0.1:${edge.screens!.port}`, false);
  }, 240_000);
});
