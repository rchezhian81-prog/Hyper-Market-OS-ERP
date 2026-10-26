import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';

/**
 * **The Investigations page reads the shop's own records, in a real browser on the store computer (M15-FR-02 · M15-FR-03 ·
 * OB-301 · lane 2 RP-1).**
 *
 * The real store computer serves the Investigations page (`/loss-prevention/`); its "From the shop's own records" section
 * (`lp-records.js` over the tested `lp-signals-session.ts`) reads head office on a click. Head office's answers here are a
 * same-origin stand-in (synthetic). Proven in Chromium:
 *   • nothing is read on open; on "Read the records" the page draws a fraud signal (kind, subject, strength, value, its
 *     records, traced), each register's count — "not known" for one head office could not read, never "0" — the staff
 *     purchase against the rule with its reasons, the owner's two numbers as "not set", and the shared bank account with
 *     the payment blocked until a person reviews it; then the same in Tamil;
 *   • a role without `lp.case.read` is told so and the button is off — nothing is fetched;
 *   • head office refusing one of the three reads shows head office's own words, and no partial result;
 *   • head office unreachable says so: "nothing was read", never an empty "no signal".
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['lp', 'records', 'box', 'signing', 'key'].join('-').padEnd(48, '0');

const RECORDS: Readonly<Record<string, unknown>> = {
  '/v1/loss-prevention/cases': { openCount: 0, totalValueMinor: 0, cases: [] },
  '/v1/loss-prevention/exceptions': { day: '2026-10-26', count: 0, exceptions: [] },
  '/v1/fraud-signals/stored': {
    signals: [{ signalId: 'sig-1', domain: 'coupon', kind: 'coupon_beyond_limit', subjectRef: 'CPN-10', confidence: 'strong', valueMinor: 25_000, evidenceRefs: ['coupon:CPN-10', 'sale:S-9'], detail: 'used 4 times, limit 1', reconciles: true, unmatchedEvidence: [] }],
    sources: [{ domain: 'coupon', known: true, read: 4 }, { domain: 'loyalty', known: false, read: 0, why: 'the points register did not answer' }, { domain: 'delivery', known: true, read: 2 }, { domain: 'supplier', known: true, read: 1, history: 5 }],
    allReconcile: true,
  },
  '/v1/loss-prevention/staff-purchases/exceptions': {
    bills: [{ saleId: 'S-1', receiptNumber: 'R-1', laneId: 'lane-2', cashierId: 'u-cash', employeeId: 'e-7', committedAt: '2026-10-25T05:00:00.000Z', totalMinor: 12_000, discountBps: 1_500, allowed: false, refusals: ['self_billing'], words: { en: 'A staff member may not ring their own shopping.', ta: 'பணியாளர் தன் சொந்தப் பொருட்களுக்குப் பில் போடக் கூடாது.' } }],
    policy: { staffDiscountCapBps: null, serviceDeskLaneIds: null },
  },
  '/v1/fraud-signals/duplicate-bank': { flags: [{ accountRef: 'XXXX1234', holders: [{ holderId: 'sup-1', holderType: 'supplier' }, { holderId: 'e-7', holderType: 'employee' }] }], employeesFolded: 12 },
};

describe.skipIf(!HAVE_BROWSER)('the Investigations page reads the shop\'s own records (RP-1)', () => {
  let browser: Browser;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  /** The real box, its Investigations screen named for `permissions`; head office answered by `answer` (or nothing). */
  const open = async (permissions: readonly string[], answer?: (path: string) => { status: number; body: unknown }): Promise<{ page: Page; reads: string[]; errors: string[] }> => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-lp-records-')); dirs.push(dir);
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, JSON.stringify({ version: 1, lossPreventionRules: [], policies: { tradingDayCutoff: '02:00', storeId: 'store-1' }, lossPreventionPolicy: { userId: 'u-lp', permissions } }), 'utf8');
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile,
    }, () => {}))!;
    stops.push(() => edge.stop());
    const context = await browser.newContext({ viewport: { width: 390, height: 900 }, serviceWorkers: 'block' });
    stops.push(() => context.close());
    const reads: string[] = [];
    if (answer !== undefined) {
      await context.route('**/v1/**', async (route) => {
        const url = new URL(route.request().url());
        reads.push(`${route.request().method()} ${url.pathname}${url.search}`);
        const a = answer(url.pathname);
        await route.fulfill({ status: a.status, contentType: 'application/json', body: JSON.stringify(a.body) });
      });
    }
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const res = await page.goto(`http://127.0.0.1:${edge.screens!.port}/loss-prevention/`, { waitUntil: 'load' });
    expect(res?.status()).toBe(200);
    await page.waitForSelector('#rec:not([hidden])');
    return { page, reads, errors };
  };
  const records = (path: string) => (path in RECORDS ? { status: 200, body: RECORDS[path] } : { status: 404, body: { error: { code: 'not_found', whatHappened: 'no such route' } } });
  const statusSays = (page: Page, pattern: RegExp) => page.waitForFunction(
    ([src]) => new RegExp(src!).test((globalThis as unknown as { document: { getElementById(i: string): { textContent: string | null } | null } }).document.getElementById('rec-status')?.textContent ?? ''),
    [pattern.source], { timeout: 15_000 },
  );
  const text = (page: Page, id: string) => page.evaluate((i) => (globalThis as unknown as { document: { getElementById(x: string): { innerText: string } | null } }).document.getElementById(i)?.innerText ?? '', id);

  it('on a click, draws the signals, the staff purchase, the owner\'s numbers as "not set" and the shared account — then in Tamil', async () => {
    const { page, reads, errors } = await open(['lp.case.read'], records);
    await page.waitForLoadState('networkidle');
    expect(reads.filter((r) => /fraud-signals|staff-purchases/.test(r)), 'nothing of the records is read on open').toEqual([]);
    await page.fill('#rec-from', '2026-10-01');
    await page.fill('#rec-to', '2026-10-25');
    await page.click('#rec-read');
    await page.waitForSelector('#rec-result:not([hidden])');
    expect(reads).toContain('GET /v1/fraud-signals/stored?from=2026-10-01&to=2026-10-25');
    expect(reads).toContain('GET /v1/loss-prevention/staff-purchases/exceptions?from=2026-10-01&to=2026-10-25');
    expect(reads).toContain('GET /v1/fraud-signals/duplicate-bank');
    const signals = await text(page, 'rec-signals');
    expect(signals).toContain('A coupon used past its own limit — CPN-10');
    expect(signals).toContain('Strong');
    expect(signals).toContain('At stake: ₹250.00');
    expect(signals).toContain('Records: coupon:CPN-10, sale:S-9');
    expect(signals).toContain('✓ Traced to its records');
    const sources = await text(page, 'rec-sources');
    expect(sources).toContain('Coupons: 4 read');
    expect(sources).toContain('Points: not known — the points register did not answer');
    expect(sources).toContain('Supplier bills: 1 read (+5)');
    expect(await text(page, 'rec-policy')).toBe('Staff discount (owner): not set · Service-desk till (owner): not set');
    const staff = await text(page, 'rec-staff');
    expect(staff).toContain('✕ R-1 — e-7');
    expect(staff).toContain('Against the rule');
    expect(staff).toContain('Rang their own shopping');
    expect(staff).toContain('A staff member may not ring their own shopping.');
    const bank = await text(page, 'rec-bank');
    expect(bank).toContain('⚠ XXXX1234');
    expect(bank).toContain('Supplier: sup-1');
    expect(bank).toContain('Staff member: e-7');
    expect(bank).toContain('Payment blocked until a person reviews it');
    expect(await text(page, 'rec-bank-note')).toBe('12 staff salary accounts compared');
    // Every button carries its icon beside its word.
    expect(await page.$eval('#rec-read', (b) => (b as unknown as { querySelector(s: string): unknown }).querySelector('svg') !== null)).toBe(true);
    await page.click('#lang');
    await page.waitForFunction(() => ((globalThis as unknown as { document: { getElementById(i: string): { textContent: string | null } | null } }).document.getElementById('rec-heading')?.textContent ?? '') === 'கடையின் சொந்தப் பதிவுகளிலிருந்து');
    expect(await text(page, 'rec-policy')).toContain('அமைக்கப்படவில்லை');
    expect(await text(page, 'rec-staff')).toContain('பணியாளர் தன் சொந்தப் பொருட்களுக்குப் பில் போடக் கூடாது.');
    expect(errors).toEqual([]);
  });

  it('a role without lp.case.read is told so, the button is off, and nothing is fetched', async () => {
    const { page, reads } = await open(['lp.case.manage'], records);
    await statusSays(page, /Your role cannot read investigations\./);
    expect(await page.$eval('#rec-read', (b) => (b as unknown as { disabled: boolean }).disabled)).toBe(true);
    expect(reads.filter((r) => /fraud-signals|staff-purchases/.test(r))).toEqual([]);
  });

  it('head office refusing one read shows its own words and no partial result', async () => {
    const { page } = await open(['lp.case.read'], (path) => (path === '/v1/fraud-signals/duplicate-bank'
      ? { status: 403, body: { error: { code: 'forbidden', whatHappened: 'Your role may not read bank accounts.' } } }
      : records(path)));
    await page.click('#rec-read');
    await statusSays(page, /^Head office refused: Your role may not read bank accounts\.$/);
    expect(await page.$eval('#rec-result', (r) => (r as unknown as { hidden: boolean }).hidden)).toBe(true);
  });

  it('head office unreachable (nothing carries it to the store computer): "nothing was read", never "no signal"', async () => {
    const { page } = await open(['lp.case.read']);
    await page.click('#rec-read');
    await statusSays(page, /^Head office cannot be reached — nothing was read\.$/);
    expect(await page.$eval('#rec-result', (r) => (r as unknown as { hidden: boolean }).hidden)).toBe(true);
    expect(await text(page, 'rec-signals')).not.toContain('No signal');
  });
});
