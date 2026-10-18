import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge } from '../../edge/store-edge/src/main';
import { enrolmentCodeHash } from '../../packages/platform-admin/src/device-enrolment';
import { withTillPeople, issueTillPins } from '../support/till-operator';
import { signInOnPhonePage } from '../support/phone-sign-in-page';

/**
 * **OB-184 "A" (owner, 17 Oct 2026, "Sign out + 4-hour limit") in a real browser, against a REAL store computer.**
 *
 * A real headless Chromium as the dock phone. u-worker signs in; the bar at the top of the screen says how long the
 * sign-in has left, in English and Tamil — four hours. The phone's clock is then wound on: at 3 h 58 m the bar says two
 * minutes, and a scan is still stamped with the sign-in; past four hours — OB-186 "A" ("Lock the screen") — the screen
 * goes to the sign-in page by itself, so no scan can be made on the ended sign-in, and the stamped scan is still kept on
 * the phone (the phone's own stamper stamping nothing after the end is tests/unit/ob184-*.test.ts; the lock in full,
 * online and offline, is tests/e2e/ob186-*.e2e.ts). The
 * phone cannot reach the box meanwhile, so nothing is handed over. Skips where no browser binary is present. Synthetic data.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['ob184', 'phone', 'browser', 'key'].join('-').padEnd(48, '0');
const CODE = 'ABCDE-FGHJK-LMNPQ-RSTUV';
const HANDHELD = { viewport: { width: 360, height: 640 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const PEOPLE = [{ userId: 'u-worker', displayName: 'Worker One', permissions: ['inventory.movement.append'] }];

type Queued = { event: { type: string }; stamp?: { userId: string; madeAt: string } };

describe.skipIf(!HAVE_BROWSER)('OB-184: the handheld says how long its sign-in has left, and when it has ended', () => {
  let browser: Browser;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'warehouse-app'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 240_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  const left = (page: Page): Promise<string | null> => page.textContent('[data-phone-holder] [data-sign-in-left]');
  const queued = (page: Page): Promise<Queued[]> => page.evaluate(() => JSON.parse((globalThis as unknown as { localStorage: { getItem(k: string): string | null } }).localStorage.getItem('sre.warehouse.outbox.A-1') ?? '[]') as Queued[]);
  const scanIce = async (page: Page): Promise<void> => {
    await page.click('#receive');
    await page.waitForSelector('#scan:not([hidden])');
    await page.keyboard.type('890ICE');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#banner:not([hidden])');
    expect(await page.textContent('#banner-title')).toBe('Received');
    await page.click('#banner-ok');
  };

  it('four hours, counting down; at 3 h 58 m still stamped; past four hours the screen locks to the sign-in page', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-ob184-e2e-'));
    dirs.push(dir);
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, JSON.stringify(withTillPeople({
      version: 1,
      policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1', branchName: 'Main', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'wh-1' },
      lossPreventionRules: [],
      warehouse: {
        assignmentId: 'A-1', workerId: 'u-worker', storeId: 'store-1', grnId: 'grn-ice', poId: 'po-1',
        bins: [{ binId: 'BIN-F', storeId: 'store-1', capacityMinor: 1000, pickable: true, zone: 'frozen' }],
        ordered: [{ productId: 'p-icecream', quantityMinor: 20, unitCostMinor: 15_000, currency: 'INR' }],
        barcodes: [{ barcode: '890ICE', productId: 'p-icecream', level: 'unit' }],
      },
      devices: [{ deviceId: 'hh-01', kind: 'handheld', status: 'registered', label: 'Dock 1', enrolment: { codeHash: enrolmentCodeHash(CODE), expiresAt: '2099-01-01T00:00:00.000Z' } }],
    }, PEOPLE)), 'utf8');
    await issueTillPins(dir, KEY, PEOPLE.map((p) => p.userId));
    const edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_DEVICE_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile,
    }, () => {}))!;
    stops.push(() => edge.stop());
    const base = `http://127.0.0.1:${edge.devices!.port}`;

    const context = await browser.newContext(HANDHELD);
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.clock.install({ time: new Date() });
    // The phone cannot hand anything over to the box in this test: its queue stays on the phone to be read.
    await context.route('**/lane/outbox', (route) => route.abort());

    await page.goto(`${base}/warehouse/`, { waitUntil: 'load' });
    await page.fill('#deviceId', 'hh-01');
    await page.fill('#code', CODE);
    await page.click('button[type="submit"]');
    await signInOnPhonePage(page, 'warehouse', 'u-worker');
    await page.waitForFunction(() => (globalThis as unknown as { warehouseSession?: unknown }).warehouseSession !== undefined, undefined, { timeout: 15_000 });

    // ── Just signed in: four hours, in English and Tamil. ────────────────────────────────────────────────────────────
    expect(await page.textContent('[data-phone-holder]')).toContain('Signed in: Worker One');
    expect(await left(page)).toBe('Sign-in ends in 4 h 0 min · உள்நுழைவு முடிய 4 மணி 0 நிமிடம்');
    expect(await page.getAttribute('[data-sign-in-left]', 'role')).toBeNull();

    // ── 3 h 58 m later on the phone: two minutes left, and a scan is still stamped with the sign-in. ─────────────────────
    await page.clock.fastForward('03:58:00');
    await expect.poll(() => left(page), { timeout: 10_000 }).toBe('Sign-in ends in 0 h 2 min · உள்நுழைவு முடிய 0 மணி 2 நிமிடம்');
    await scanIce(page);
    await expect.poll(async () => (await queued(page)).length, { timeout: 10_000 }).toBe(1);
    expect((await queued(page))[0]).toMatchObject({ event: { type: 'ReceivingScanned' }, stamp: { userId: 'u-worker' } });

    // ── Past four hours (OB-186): the screen goes to the sign-in page by itself; nothing more can be scanned; the stamped
    //    scan is still kept on the phone. ─────────────────────────────────────────────────────────────────────────────
    await page.clock.fastForward('00:03:00');
    await page.waitForFunction(() => (globalThis as unknown as { location: { pathname: string } }).location.pathname === '/device/sign-in', undefined, { timeout: 10_000 });
    await page.waitForSelector('input[name="staffId"]');
    expect(await page.$('#receive')).toBeNull();
    expect(await page.$('[data-phone-holder]')).toBeNull();
    expect(await queued(page)).toHaveLength(1);
    expect((await queued(page))[0]).toMatchObject({ event: { type: 'ReceivingScanned' }, stamp: { userId: 'u-worker' } });
  });
});
