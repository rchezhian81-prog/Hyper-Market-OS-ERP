import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { issueTillPins, pinOf } from '../support/till-operator';

/**
 * **The office pages head office answers are served by the STORE COMPUTER (OB-380 · P-01 · P-04 · P-07 · P-08 · OB-228).**
 *
 * Until 26 Oct 2026 these pages existed but nothing in the shop served them. Now the real store computer serves them the
 * way it serves its other office pages, and this drives seven of them in a real browser THROUGH THE BOX'S OWN ORIGIN —
 * Payroll (the read-only view), Month-end, Transfers, Supplier bills, Trial switches (rollout), Dispatch and Tally files:
 *
 *   • the same front door: the page asks for the person's own PIN (OB-259) before it opens, and lands back on the page;
 *   • the same permission check: an accountant is refused Payroll (403, with the screens they may open) but opens Month-end;
 *   • the menu the box draws now offers every one of them;
 *   • the same same-origin `/v1` calls: with head office's API carried on the box's origin (Playwright stands in for the
 *     front that carries it, forwarding each call to the real API surface in memory as the signed-in person), each page
 *     draws head office's own answer. Payroll is read-only: it shows the pay-release switch in head office's words and a
 *     pay run looked up by number, offers no approve / lock / bank file, and head office still refuses approve while the
 *     owner's switch is off (OB-228);
 *   • with NOTHING carrying head office (a bare store computer, or the line down), each page says plainly that head office
 *     cannot be reached, and shows no figure as current (P-08) — in English and Tamil.
 *
 * Synthetic data only; no PostgreSQL needed (the API surface runs in memory). Without a browser binary it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['office', 'pages', 'box', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = 't-sre';
const OWNER = 'u-owner';
const ACCT = 'u-acct';
const PAGES = ['/payroll/', '/finance-close/', '/transfers/', '/supplier-bills/', '/rollout/', '/dispatch/', '/tally-files/'] as const;
/** What every page in this product says when head office does not answer — in its own words, in either language. */
const UNREACHABLE = /Head office cannot be reached|head office could not be reached|could not be read from head office|தலைமை அலுவலகத்தை அடைய முடியவில்லை/i;
const OWNER_WORDS = [
  'identity.self.read', 'payroll.statutory.read', 'finance.period.read', 'inventory.availability.read', 'purchase.invoice.capture',
  'platform.flag.read', 'delivery.run.read', 'fulfilment.wave.assign', 'till.dayclose.read',
];

describe.skipIf(!HAVE_BROWSER)('the office pages head office answers, served by the store computer (OB-380)', () => {
  let browser: Browser;
  let ho: ApiHarness;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    // Head office, in memory: the owner, an accountant, and one pay run drafted and submitted (synthetic).
    ho = apiHarness();
    await ho.provisionOwner(TENANT, OWNER);
    await ho.provisionRole(TENANT, ACCT, 'accountant');
    const append = (body: Record<string, unknown>) => ho.request({ method: 'POST', path: '/v1/hr/payroll/pay-run/PR-2026-10/append', userId: OWNER, tenantId: TENANT, body, idempotencyKey: `pr-${randomUUID()}` });
    const drafted = await append({ action: 'draft', payPeriod: '2026-10', netTotalMinor: 4_63_000_00, employeeCount: 23 });
    expect(drafted.status).toBe(201);
    expect((await append({ action: 'submit' })).status).toBe(200);
  }, 240_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  /** A real store computer with the office PIN on, no cloud, and the owner and an accountant who work here. */
  const box = async (): Promise<EdgeProcess> => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-office-pages-')); dirs.push(dir);
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, JSON.stringify({
      version: 1, lossPreventionRules: [], policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1', branchName: 'Main' },
      people: [{ userId: OWNER, displayName: 'Owner Person', roleId: 'owner' }, { userId: ACCT, displayName: 'Accountant Person', roleId: 'accountant' }],
      roles: [
        { id: 'owner', name: 'Owner', permissions: OWNER_WORDS },
        { id: 'accountant', name: 'Accountant', permissions: ['identity.self.read', 'finance.period.read'] },
      ],
      roleAssignments: [{ userId: OWNER, roleId: 'owner', branchScope: 'all' }, { userId: ACCT, roleId: 'accountant', branchScope: 'all' }],
    }), 'utf8');
    await issueTillPins(dir, KEY, [OWNER, ACCT]);
    const edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
      EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile, EDGE_OFFICE_SIGN_IN: 'pin',
    }, () => {}))!;
    stops.push(() => edge.stop());
    return edge;
  };

  /** A browser on the box's own origin. `carried` → head office's API is carried on that origin, as the signed-in person. */
  const browserOn = async (who: string, carried: boolean): Promise<{ context: BrowserContext; page: Page; calls: string[]; errors: string[] }> => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    stops.push(() => context.close());
    const calls: string[] = [];
    if (carried) {
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
        calls.push(`${req.method()} ${url.pathname} ${answer.status}`);
        await route.fulfill({ status: answer.status, contentType: 'application/json', body: JSON.stringify(answer.body ?? {}) });
      });
    }
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    return { context, page, calls, errors };
  };
  const signIn = async (page: Page, base: string, path: string, who: string): Promise<number> => {
    const first = await page.goto(`${base}${path}`, { waitUntil: 'load' });
    expect(first?.status(), `${path} asks for the PIN first`).toBe(401);
    await page.fill('#office-staff', who);
    await page.fill('#office-pin', pinOf(who));
    const [landed] = await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('#office-submit')]);
    expect(new URL(page.url()).pathname).toBe(path);
    return landed?.status() ?? 0;
  };
  /** Wait until the page's own words match (never read in the same tick as the change). */
  const says = (page: Page, pattern: RegExp, within = 'main'): Promise<unknown> => page.waitForFunction(
    ([sel, src, flags]) => new RegExp(src!, flags).test(((globalThis as unknown as { document: { querySelector(s: string): { innerText: string } | null } }).document.querySelector(sel!)?.innerText) ?? ''),
    [within, pattern.source, pattern.flags], { timeout: 15_000 },
  );
  const mainText = (page: Page): Promise<string> => page.evaluate(() => (globalThis as unknown as { document: { querySelector(s: string): { innerText: string } | null } }).document.querySelector('main')?.innerText ?? '');

  it('the same front door and permission check: the PIN first, the page after; the menu offers all seven; an accountant is refused Payroll but opens Month-end', async () => {
    const edge = await box();
    const base = `http://127.0.0.1:${edge.screens!.port}`;
    const owner = await browserOn(OWNER, false);
    expect(await signIn(owner.page, base, '/payroll/', OWNER)).toBe(200);
    const menu = await owner.page.evaluate(() => ((globalThis as unknown as { sreNavigation?: { groups: { items: { path: string }[] }[] } }).sreNavigation?.groups ?? []).flatMap((g) => g.items.map((i) => i.path)));
    for (const p of ['/payroll', '/finance-close', '/transfers', '/supplier-bills', '/rollout', '/dispatch', '/tally-files']) expect(menu, `the menu offers ${p}`).toContain(p);
    // Every page answers on the box, as the signed-in owner (the sign-in holds across the office pages).
    for (const path of PAGES) {
      const res = await owner.page.goto(`${base}${path}`, { waitUntil: 'load' });
      expect(res?.status(), `${path} is served by the store computer`).toBe(200);
      expect(await owner.page.evaluate(() => typeof (globalThis as unknown as { sreNavigation?: unknown }).sreNavigation)).toBe('object');
    }
    expect(owner.errors).toEqual([]);

    const acct = await browserOn(ACCT, false);
    const refused = await acct.page.goto(`${base}/payroll/`, { waitUntil: 'load' });
    expect(refused?.status()).toBe(401);
    await acct.page.fill('#office-staff', ACCT);
    await acct.page.fill('#office-pin', pinOf(ACCT));
    const [after] = await Promise.all([acct.page.waitForNavigation({ waitUntil: 'load' }), acct.page.click('#office-submit')]);
    expect(after?.status(), 'payroll needs payroll.statutory.read, which the accountant does not hold').toBe(403);
    expect(await acct.page.content()).toContain('/finance-close');
    const close = await acct.page.goto(`${base}/finance-close/`, { waitUntil: 'load' });
    expect(close?.status()).toBe(200);
  });

  it('head office carried on the box\'s origin: each page draws head office\'s own answer; Payroll only reads, and approve stays held (OB-228)', async () => {
    const edge = await box();
    const base = `http://127.0.0.1:${edge.screens!.port}`;
    const { page, calls, errors } = await browserOn(OWNER, true);
    await signIn(page, base, '/payroll/', OWNER);

    // Payroll — the switch in head office's words; the pay run by its number; nothing to approve, lock or pay from here.
    await says(page, /Pay release: Held — switched off/);
    expect(await mainText(page)).toContain('This page only reads');
    await page.fill('#live-run', 'PR-2026-10');
    await page.click('#live-show');
    await says(page, /Awaiting approval/);
    const payroll = await mainText(page);
    expect(payroll).toContain('2026-10');
    expect(payroll).toContain('₹4,63,000.00');
    expect(payroll).toContain('23');
    expect(payroll).not.toMatch(UNREACHABLE);
    expect(payroll).not.toMatch(/DEMO/);
    const buttons = await page.$$eval('main button:not([hidden])', (bs) => bs.map((b) => (b as unknown as { textContent: string }).textContent.trim()));
    for (const b of buttons) expect(b, 'no state change is offered from the box\'s payroll page').not.toMatch(/^(Approve|Lock|Submit|Reverse|Generate bank file)/);
    await page.click('#lang');
    await says(page, /சம்பள வெளியீடு/);
    await page.click('#lang');
    // Head office still refuses approving while the owner's switch is off, whoever asks (OB-228).
    const approve = await ho.request({ method: 'POST', path: '/v1/hr/payroll/pay-run/PR-2026-10/append', userId: OWNER, tenantId: TENANT, body: { action: 'approve' }, idempotencyKey: `ap-${randomUUID()}` });
    expect(approve.status).toBe(409);
    expect((approve.body as { error?: { code?: string } }).error?.code).toBe('pay_release_switched_off');

    // Month-end — head office's own list of payments with no answer (none here).
    await page.goto(`${base}/finance-close/`, { waitUntil: 'load' });
    await says(page, /No card or UPI payment is waiting for an answer/);
    // Transfers — head office's register (empty for this shop).
    await page.goto(`${base}/transfers/`, { waitUntil: 'load' });
    await says(page, /No transfers yet/);
    // Supplier bills — head office's bill register.
    await page.goto(`${base}/supplier-bills/`, { waitUntil: 'load' });
    await page.waitForFunction(() => true);
    await expect.poll(() => calls.some((c) => c.startsWith('GET /v1/purchase/invoice-documents 200')), { timeout: 15_000 }).toBe(true);
    // Trial switches — head office's rollout register.
    await page.goto(`${base}/rollout/`, { waitUntil: 'load' });
    await expect.poll(() => calls.some((c) => c.startsWith('GET /v1/platform/rollout 200')), { timeout: 15_000 }).toBe(true);
    // Dispatch and Tally files read on a click.
    await page.goto(`${base}/dispatch/`, { waitUntil: 'load' });
    const before = calls.length;
    await page.fill('#store', 'store-1');
    await page.click('#show-orders');
    await expect.poll(() => calls.slice(before).some((c) => / 200$/.test(c)), { timeout: 15_000 }).toBe(true);
    await page.goto(`${base}/tally-files/`, { waitUntil: 'load' });
    await page.click('#read');
    await says(page, /No day has ended since the books began|Every day's file/);
    for (const path of PAGES.slice(1)) {
      await page.goto(`${base}${path}`, { waitUntil: 'load' });
      await page.waitForLoadState('networkidle');
      expect(await mainText(page), `${path} drew head office's answer, not "unreachable"`).not.toMatch(UNREACHABLE);
    }
    expect(errors).toEqual([]);
  });

  it('nothing carrying head office: each page says plainly that head office cannot be reached, and shows nothing as current — English and Tamil', async () => {
    const edge = await box();
    const base = `http://127.0.0.1:${edge.screens!.port}`;
    const { page, errors } = await browserOn(OWNER, false);
    await signIn(page, base, '/payroll/', OWNER);
    await says(page, UNREACHABLE);
    const payroll = await mainText(page);
    expect(payroll).not.toMatch(/₹|DEMO|No run drafted/);
    await page.click('#lang');
    await says(page, /தலைமை அலுவலகத்தை அடைய முடியவில்லை/);

    for (const path of ['/finance-close/', '/transfers/', '/supplier-bills/', '/rollout/']) {
      await page.goto(`${base}${path}`, { waitUntil: 'load' });
      await says(page, UNREACHABLE);
    }
    await page.goto(`${base}/dispatch/`, { waitUntil: 'load' });
    await page.fill('#store', 'store-1');
    await page.click('#show-orders');
    await says(page, UNREACHABLE);
    await page.goto(`${base}/tally-files/`, { waitUntil: 'load' });
    await page.click('#read');
    await says(page, UNREACHABLE);
    // The box itself never answers head office's API — the call fails as a lost link, never a made-up answer.
    const direct = await fetch(`${base}/v1/finance/payment-exceptions`).then(() => 'answered', () => 'no answer');
    expect(direct).toBe('no answer');
    expect(errors).toEqual([]);
  });
});
