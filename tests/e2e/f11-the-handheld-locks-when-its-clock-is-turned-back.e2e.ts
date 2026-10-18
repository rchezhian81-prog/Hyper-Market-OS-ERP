import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { DRIVER_SIGN_IN_ENDED_MESSAGE, SIGN_IN_CLOCK_MESSAGE } from '../../edge/store-edge/src/handheld-sign-in';
import { enrolmentCodeHash } from '../../packages/platform-admin/src/device-enrolment';
import { withTillPeople, issueTillPins } from '../support/till-operator';
import { signInOnPhonePage } from '../support/phone-sign-in-page';

/**
 * **Follow-up F11 in a real browser, against a REAL store computer with no cloud: the handheld verifier's NEW-1, L2, L3
 * and NEW-3 (OB-187 "A").**
 *
 * A real headless Chromium as the dock phone, its clock under the test's hand; the phone cannot hand anything over to the
 * box meanwhile (its queue stays on the phone, to be read).
 *
 *   - NEW-1 + L2, a LIVE screen — A works until two hours in; then the phone's clock is turned back an hour. The very next
 *     scan finds it: it is kept on the phone, unstamped, and the screen locks AT ONCE — no timer has run — to the sign-in
 *     page saying the clock was turned back. Putting the clock right does not bring A's sign-in back.
 *   - L3 — once locked, the old screen's sync timers are stopped (nothing more is posted) and the stamp key is gone from
 *     the page's memory.
 *   - NEW-1, a KEPT screen opened with the wifi down — the clock turned back before the screen is reopened from the phone's
 *     own cache: it locks as it opens.
 *   - NEW-3 / OB-187 — the driver screen does not lock at four hours; it locks at its own twelve, saying so.
 *
 * Skips where no browser binary is present. Synthetic data only.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['f11', 'clock', 'browser', 'key'].join('-').padEnd(48, '0');
const CODE = 'ABCDE-FGHJK-LMNPQ-RSTUV';
const HANDHELD = { viewport: { width: 360, height: 640 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const H = 3_600_000;
const PEOPLE = [
  { userId: 'u-worker', displayName: 'Worker One', permissions: ['inventory.movement.append'] },
  { userId: 'u-driver', displayName: 'Driver One', permissions: ['delivery.attempt.record'] },
];

type Queued = { key: string; state: string; event: { type: string }; stamp?: { userId: string; ref: string } };
interface Win {
  readonly warehouseSession?: unknown;
  readonly routeSession?: unknown;
  readonly shellCachedAt?: string;
  readonly phoneSignIn?: { ref: string };
  readonly navigator: { serviceWorker: { ready: Promise<unknown>; controller: unknown } };
  readonly location: { pathname: string; search: string };
}

describe.skipIf(!HAVE_BROWSER)('F11: the handheld locks when its clock is turned back, and a driver\'s sign-in lasts twelve hours', () => {
  let browser: Browser;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'warehouse-app'], { stdio: 'ignore' });
    execFileSync('node', ['scripts/build-app.mjs', 'delivery-app'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 240_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  const queued = (page: Page): Promise<Queued[]> => page.evaluate(() => JSON.parse((globalThis as unknown as { localStorage: { getItem(k: string): string | null } }).localStorage.getItem('sre.warehouse.outbox.A-1') ?? '[]') as Queued[]);
  const where = (page: Page): Promise<string> => page.evaluate(() => (globalThis as unknown as Win).location.pathname + (globalThis as unknown as Win).location.search);

  /** A box, an enrolled phone with its clock under the test's hand (started at `start`), and the person signed in. */
  const signedIn = async (screen: 'warehouse' | 'driver', staffId: string, start: number): Promise<{ page: Page; context: BrowserContext; posts: { n: number } }> => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-f11-e2e-'));
    dirs.push(dir);
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, JSON.stringify(withTillPeople({
      version: 1,
      policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1', branchName: 'Main', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'wh-1' },
      lossPreventionRules: [],
      warehouse: {
        assignmentId: 'A-1', workerId: 'u-worker', storeId: 'store-1', grnId: 'grn-rice', poId: 'po-1',
        bins: [{ binId: 'BIN-A', storeId: 'store-1', capacityMinor: 1000, pickable: true, zone: 'ambient' }],
        ordered: [{ productId: 'p-rice', quantityMinor: 20, unitCostMinor: 5_000, currency: 'INR' }],
        barcodes: [{ barcode: '890RICE', productId: 'p-rice', level: 'unit' }],
      },
      route: { routeId: 'R-1', driverId: 'u-driver', stops: [{ stopId: 's1', orderRef: 'ORD-1041', area: 'Anna Nagar', codMinor: 0 }] },
      devices: [{ deviceId: 'hh-01', kind: 'handheld', status: 'registered', label: 'Phone 1', enrolment: { codeHash: enrolmentCodeHash(CODE), expiresAt: '2099-01-01T00:00:00.000Z' } }],
    }, PEOPLE)), 'utf8');
    await issueTillPins(dir, KEY, PEOPLE.map((p) => p.userId));
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_DEVICE_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile, EDGE_LANE_ID: 'lane-1',
    }, () => {}))!;
    stops.push(() => edge.stop());
    const base = `http://127.0.0.1:${edge.devices!.port}`;
    const context = await browser.newContext(HANDHELD);
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.clock.install({ time: start });
    const posts = { n: 0 };
    await context.route('**/lane/outbox', (route) => { posts.n += 1; return route.abort(); });
    await page.goto(`${base}/${screen}/`, { waitUntil: 'load' });
    await page.fill('#deviceId', 'hh-01');
    await page.fill('#code', CODE);
    await page.click('button[type="submit"]');
    await signInOnPhonePage(page, screen, staffId);
    await page.waitForFunction((s) => (s === 'driver' ? (globalThis as unknown as Win).routeSession : (globalThis as unknown as Win).warehouseSession) !== undefined, screen, { timeout: 15_000 });
    return { page, context, posts };
  };

  const scan = async (page: Page): Promise<void> => {
    await page.keyboard.type('890RICE');
    await page.keyboard.press('Enter');
  };
  const lockedForTheClock = async (page: Page): Promise<void> => {
    await page.waitForFunction(() => (globalThis as unknown as Win).location.pathname === '/device/sign-in', undefined, { timeout: 15_000 });
    expect(await where(page)).toBe('/device/sign-in?screen=warehouse&ended=clock');
    await page.waitForSelector('input[name="staffId"]');
    expect(await page.textContent('.notice')).toBe(SIGN_IN_CLOCK_MESSAGE);
    expect(await page.$('#receive')).toBeNull();
    expect(await page.$('[data-phone-holder]')).toBeNull();
  };

  it('NEW-1 + L2 + L3, a live screen: the clock turned back an hour — the next scan is kept, unstamped, and the screen locks at once; its timers stop and the key is gone', async () => {
    const start = Date.now();
    const { page, posts } = await signedIn('warehouse', 'u-worker', start);
    const ref = (await page.evaluate(() => (globalThis as unknown as Win).phoneSignIn))!.ref;
    await page.click('#receive');
    await page.waitForSelector('#scan:not([hidden])');
    // Two hours of work: the strip ticks (the latest time this sign-in has seen is kept beside the queue).
    await page.clock.pauseAt(start + 2 * H);
    await scan(page);
    await page.waitForSelector('#banner:not([hidden])');
    await page.click('#banner-ok');
    expect((await queued(page)).map((i) => [i.event.type, i.stamp?.ref])).toEqual([['ReceivingScanned', ref]]);

    // The clock is turned back an hour. No timer runs (the clock is paused): it is the next SCAN that finds it.
    await page.clock.setSystemTime(start + 1 * H);
    expect(await where(page)).toBe('/warehouse/');
    await page.click('#receive');
    await page.waitForSelector('#scan:not([hidden])');
    await scan(page);
    await lockedForTheClock(page);
    const q = await queued(page);
    expect(q.map((i) => [i.event.type, i.state])).toEqual([['ReceivingScanned', 'pending'], ['ReceivingScanned', 'pending']]);
    expect(q[1]!.stamp).toBeUndefined(); // kept on the phone — never lost — but never stamped as A's

    // L3: the stamp key is gone from the page, and the old screen's sync timers no longer run.
    expect(await page.evaluate(() => (globalThis as unknown as Win).phoneSignIn)).toBeUndefined();
    const before = posts.n;
    expect(before).toBeGreaterThan(0); // the live screen did try to hand its work over ...
    await page.clock.runFor(60_000); // ... and a minute of its 10-second timers later, the locked one tries nothing
    expect(posts.n).toBe(before);

    // The phone remembers it: this sign-in is ended on this phone for good, whatever the clock says next.
    const marks = await page.evaluate(() => (globalThis as unknown as { localStorage: { getItem(k: string): string | null } }).localStorage.getItem('sre.phone-sign-in.marks'));
    expect(JSON.parse(marks!)).toMatchObject({ [ref]: { e: 'clock_set_back' } });
  });

  it('NEW-1, a kept screen opened with the wifi down after the clock was turned back: it locks as it opens; the queue stays', async () => {
    const start = Date.now();
    const { page, context } = await signedIn('warehouse', 'u-worker', start);
    await page.evaluate(() => (globalThis as unknown as Win).navigator.serviceWorker.ready.then(() => true));
    await page.waitForFunction(() => (globalThis as unknown as Win).navigator.serviceWorker.controller !== null, undefined, { timeout: 15_000 });
    await page.click('#receive');
    await page.waitForSelector('#scan:not([hidden])');
    await page.clock.pauseAt(start + 2 * H);
    await scan(page);
    await page.waitForSelector('#banner:not([hidden])');
    await page.click('#banner-ok');

    // The wifi drops, the clock is turned back an hour, and the screen is opened again from the phone's own cache.
    await context.setOffline(true);
    await page.clock.setSystemTime(start + 1 * H);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await lockedForTheClock(page);
    expect((await queued(page)).map((i) => [i.event.type, i.state, i.stamp?.userId])).toEqual([['ReceivingScanned', 'pending', 'u-worker']]);
  });

  it('NEW-3 / OB-187: the driver screen does not lock at four hours; it locks at its own twelve, saying so', async () => {
    const start = Date.now();
    const { page } = await signedIn('driver', 'u-driver', start);
    expect(await page.textContent('[data-sign-in-left]')).toBe('Sign-in ends in 12 h 0 min · உள்நுழைவு முடிய 12 மணி 0 நிமிடம்');
    await page.clock.fastForward('04:01:00');
    expect(await where(page)).toBe('/driver/');
    expect(await page.textContent('[data-sign-in-left]')).toBe('Sign-in ends in 7 h 59 min · உள்நுழைவு முடிய 7 மணி 59 நிமிடம்');
    await page.clock.fastForward('07:57:00');
    expect(await where(page)).toBe('/driver/');
    await page.clock.fastForward('00:03:00');
    await page.waitForFunction(() => (globalThis as unknown as Win).location.pathname === '/device/sign-in', undefined, { timeout: 15_000 });
    expect(await where(page)).toBe('/device/sign-in?screen=driver&ended=1');
    expect(await page.textContent('.notice')).toBe(DRIVER_SIGN_IN_ENDED_MESSAGE);
  });
});
