import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { SIGN_IN_ENDED_MESSAGE } from '../../edge/store-edge/src/handheld-sign-in';
import { enrolmentCodeHash } from '../../packages/platform-admin/src/device-enrolment';
import { withTillPeople, issueTillPins, pinOf } from '../support/till-operator';
import { signInOnPhonePage } from '../support/phone-sign-in-page';
import { deviceBase as boxDoor, sharedDeviceTls, trustingBrowserArgs } from '../support/box-tls';

let deviceTls: Awaited<ReturnType<typeof sharedDeviceTls>>;

/**
 * **OB-186 "A" (owner, 17 Oct 2026, "Lock the screen") in a real browser, against a REAL store computer with no cloud.**
 *
 * A real headless Chromium as the dock phone. u-worker (A) signs in and receives a frozen delivery — a scan and the
 * completed checklist, kept on the phone (the phone cannot hand anything over meanwhile), each stamped with A's sign-in.
 * The phone's clock is then wound past the four hours (OB-184), and the screen goes to the phone's sign-in page by itself,
 * saying the sign-in has ended — the page the box packed into the screen, so it needs no network:
 *
 *   - ONLINE — the live screen the box served;
 *   - OFFLINE — the wifi down and the screen opened from the phone's own cache; the sign-in page also forgets that kept
 *     screen (OB-180), as the box's own sign-in page does.
 *
 * Either way nothing more can be scanned; the two queued records are still on the phone, untouched; and once A signs in
 * again they reach the box and A's completion is SEALED for A (OB-180). Skips where no browser binary is present.
 * Synthetic data only.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['ob186', 'lock', 'browser', 'key'].join('-').padEnd(48, '0');
const CODE = 'ABCDE-FGHJK-LMNPQ-RSTUV';
const HANDHELD = { viewport: { width: 360, height: 640 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const RECEIVING = {
  checks: [{ checkId: 'dock-receiving', branchId: 'store-1', title: 'Chilled and frozen delivery', kind: 'receiving', graceMinutes: 0, active: true,
    assignedRole: 'store_manager', escalatesTo: 'u-owner', items: [{ itemId: 'temp', label: 'Temperature taken' }, { itemId: 'pack', label: 'Packaging intact' }] }],
  coldChainProductIds: ['p-icecream'],
};
const PEOPLE = [{ userId: 'u-worker', displayName: 'Worker One', permissions: ['inventory.movement.append'] }];

type Queued = { key: string; state: string; event: { type: string }; stamp?: { userId: string; ref: string } };
type Logged = { type: string; payload: Record<string, unknown> };
interface Win {
  readonly warehouseSession?: unknown;
  readonly shellCachedAt?: string;
  readonly phoneSignIn?: { ref: string };
  readonly navigator: { serviceWorker: { ready: Promise<unknown>; controller: unknown } };
  readonly caches: { keys(): Promise<string[]>; open(k: string): Promise<{ keys(): Promise<{ url: string }[]> }> };
  readonly location: { pathname: string; search: string };
}

describe.skipIf(!HAVE_BROWSER)('OB-186: the handheld locks to the sign-in page when its sign-in ends', () => {
  let browser: Browser;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'warehouse-app'], { stdio: 'ignore' });
    deviceTls = await sharedDeviceTls(); // OB-422: the store computer's authority, trusted as an enrolled handheld trusts it
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM, args: trustingBrowserArgs(deviceTls.keyPin) });
  }, 240_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  const queued = (page: Page): Promise<Queued[]> => page.evaluate(() => JSON.parse((globalThis as unknown as { localStorage: { getItem(k: string): string | null } }).localStorage.getItem('sre.warehouse.outbox.A-1') ?? '[]') as Queued[]);
  const keptPages = (page: Page): Promise<string[]> => page.evaluate(async () => {
    const out: string[] = [];
    for (const k of await (globalThis as unknown as Win).caches.keys()) for (const r of await (await (globalThis as unknown as Win).caches.open(k)).keys()) out.push(new URL(r.url).pathname);
    return out.filter((p) => /^\/(warehouse|picker|driver)\/(index\.html)?$/.test(p));
  });
  const where = (page: Page): Promise<string> => page.evaluate(() => (globalThis as unknown as Win).location.pathname + (globalThis as unknown as Win).location.search);

  /** A box, an enrolled dock phone with its clock under the test's hand, and A signed in on the warehouse screen. */
  const aSignedIn = async (): Promise<{ page: Page; context: BrowserContext; logged: () => Promise<Logged[]>; base: string }> => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-ob186-e2e-'));
    dirs.push(dir);
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, JSON.stringify(withTillPeople({
      version: 1,
      policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1', branchName: 'Main', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'wh-1' },
      lossPreventionRules: [],
      receivingChecklist: RECEIVING,
      warehouse: {
        assignmentId: 'A-1', workerId: 'u-worker', storeId: 'store-1', grnId: 'grn-ice', poId: 'po-1',
        bins: [{ binId: 'BIN-F', storeId: 'store-1', capacityMinor: 1000, pickable: true, zone: 'frozen' }],
        ordered: [{ productId: 'p-icecream', quantityMinor: 20, unitCostMinor: 15_000, currency: 'INR' }],
        barcodes: [{ barcode: '890ICE', productId: 'p-icecream', level: 'unit' }],
      },
      devices: [{ deviceId: 'hh-01', kind: 'handheld', status: 'registered', label: 'Dock 1', enrolment: { codeHash: enrolmentCodeHash(CODE), expiresAt: '2099-01-01T00:00:00.000Z' } }],
    }, PEOPLE)), 'utf8');
    await issueTillPins(dir, KEY, PEOPLE.map((p) => p.userId));
    const edge: EdgeProcess = (await startEdge({
      EDGE_DEVICE_TLS_DIR: deviceTls.dir,
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_DEVICE_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile, EDGE_LANE_ID: 'lane-1',
    }, () => {}))!;
    stops.push(() => edge.stop());
    const base = `${boxDoor(edge)}`;
    const context = await browser.newContext(HANDHELD);
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.clock.install({ time: new Date() });
    // The phone cannot hand anything over to the box until the test says so: its queue stays on the phone to be read.
    await context.route('**/lane/outbox', (route) => route.abort());
    await page.goto(`${base}/warehouse/`, { waitUntil: 'load' });
    await page.fill('#deviceId', 'hh-01');
    await page.fill('#code', CODE);
    await page.click('button[type="submit"]');
    await signInOnPhonePage(page, 'warehouse', 'u-worker');
    await page.waitForFunction(() => (globalThis as unknown as Win).warehouseSession !== undefined, undefined, { timeout: 15_000 });
    const logged = async (): Promise<Logged[]> => (await readLog(edge.deviceEventsLog.path)).filter((r) => r.ok).map((r) => JSON.parse(r.ok ? r.record : '{}') as Logged);
    return { page, context, logged, base };
  };

  /** A receives the frozen delivery: one scan, then delivery complete with the checklist. */
  const receive = async (page: Page): Promise<void> => {
    await page.click('#receive');
    await page.waitForSelector('#scan:not([hidden])');
    await page.keyboard.type('890ICE');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#banner:not([hidden])');
    expect(await page.textContent('#banner-title')).toBe('Received');
    await page.click('#banner-ok');
    await page.waitForSelector('#done-receiving:not([hidden])');
    await page.click('#done-receiving');
    await page.waitForSelector('#checklist:not([hidden])');
    await page.click('#checklist-items button[data-item="temp"][data-result="pass"]');
    await page.click('#checklist-items button[data-item="pack"][data-result="pass"]');
    await page.click('#checklist-ok');
    await page.waitForSelector('#banner:not([hidden])');
    await page.click('#banner-ok');
  };

  /** The screen is the sign-in page, saying the sign-in ended; nothing of the old screen is left to scan with. */
  const locked = async (page: Page): Promise<void> => {
    await page.waitForFunction(() => (globalThis as unknown as Win).location.pathname === '/device/sign-in', undefined, { timeout: 15_000 });
    expect(await where(page)).toBe('/device/sign-in?screen=warehouse&ended=1');
    await page.waitForSelector('input[name="staffId"]');
    expect(await page.textContent('.notice')).toBe(SIGN_IN_ENDED_MESSAGE);
    expect(await page.getAttribute('form', 'action')).toBe('/device/sign-in?screen=warehouse');
    expect(await page.$('#receive')).toBeNull();
    expect(await page.$('[data-phone-holder]')).toBeNull();
    // A scanner's keystrokes now go nowhere: the queue does not grow.
    await page.keyboard.type('890ICE');
    await page.keyboard.press('Enter');
  };

  /** The two records A made are on the phone, still waiting, still stamped with A's sign-in. */
  const stillQueued = async (page: Page, ref: string): Promise<void> => {
    const q = await queued(page);
    expect(q.map((i) => i.event.type)).toEqual(['ReceivingScanned', 'ReceivingCompleted']);
    for (const i of q) expect(i).toMatchObject({ state: 'pending', stamp: { userId: 'u-worker', ref } });
  };

  /** A signs in again on the sign-in page; the phone hands the queue over; A's completion is sealed for A. */
  const signInAgainAndDrain = async (page: Page, context: BrowserContext, logged: () => Promise<Logged[]>): Promise<void> => {
    await page.fill('input[name="staffId"]', 'u-worker');
    await page.fill('input[name="pin"]', pinOf('u-worker'));
    await page.click('button[type="submit"]');
    await page.waitForFunction(() => (globalThis as unknown as Win).location.pathname === '/warehouse/', undefined, { timeout: 15_000 });
    await page.waitForFunction(() => (globalThis as unknown as Win).warehouseSession !== undefined, undefined, { timeout: 15_000 });
    // The new sign-in's screen does not lock: it has its own four hours.
    expect(await page.textContent('[data-sign-in-left]')).toBe('Sign-in ends in 4 h 0 min · உள்நுழைவு முடிய 4 மணி 0 நிமிடம்');
    expect(await logged()).toEqual([]);
    await context.unroute('**/lane/outbox');
    await expect.poll(async () => (await logged()).map((e) => e.type), { timeout: 30_000 }).toEqual(['ReceivingScanned', 'ReceivingCompleted']);
    const done = (await logged()).find((e) => e.type === 'ReceivingCompleted')!;
    expect(done.payload).toMatchObject({
      grnId: 'grn-ice', completedBy: 'u-worker',
      receivingChecklist: { performedBy: 'u-worker', itemResults: { temp: 'pass', pack: 'pass' } },
      deciderVerified: { userId: 'u-worker', via: 'phone_pin', laneId: 'device:hh-01' },
    });
    await expect.poll(async () => (await queued(page)).filter((i) => i.state === 'pending').length, { timeout: 30_000 }).toBe(0);
  };

  it('ONLINE: past four hours the screen goes to the sign-in page by itself; the queue stays; A signs in again and it drains sealed for A', async () => {
    const { page, context, logged } = await aSignedIn();
    const ref = (await page.evaluate(() => (globalThis as unknown as Win).phoneSignIn))!.ref;
    await receive(page);
    await stillQueued(page, ref);

    await page.clock.fastForward('03:58:00');
    expect(await where(page)).toBe('/warehouse/'); // not yet
    await page.clock.fastForward('00:03:00');
    await locked(page);
    await stillQueued(page, ref);
    expect(await logged()).toEqual([]);

    await signInAgainAndDrain(page, context, logged);
  });

  it('OFFLINE, from the phone\'s cache: past four hours the sign-in page goes up in place; it forgets the kept page; the queue stays and drains under A\'s next sign-in', async () => {
    const { page, context, logged } = await aSignedIn();
    const ref = (await page.evaluate(() => (globalThis as unknown as Win).phoneSignIn))!.ref;
    await page.evaluate(() => (globalThis as unknown as Win).navigator.serviceWorker.ready.then(() => true));
    await page.waitForFunction(() => (globalThis as unknown as Win).navigator.serviceWorker.controller !== null, undefined, { timeout: 15_000 });
    await expect.poll(() => keptPages(page), { timeout: 10_000 }).toContain('/warehouse/');

    // The wifi drops; the phone opens its kept copy of the screen and A works on it.
    await context.setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof (globalThis as unknown as Win).shellCachedAt === 'string' && (globalThis as unknown as Win).warehouseSession !== undefined, undefined, { timeout: 15_000 });
    await receive(page);
    await stillQueued(page, ref);

    await page.clock.fastForward('03:58:00');
    expect(await where(page)).toBe('/warehouse/');
    await page.clock.fastForward('00:03:00');
    await locked(page);
    // The sign-in page forgot the kept screen holding A's ended sign-in (OB-180, as the box's own sign-in page does).
    await expect.poll(() => keptPages(page), { timeout: 10_000 }).toEqual([]);
    await stillQueued(page, ref);
    expect(await logged()).toEqual([]);

    // The wifi is back; A signs in again on the page in front of them.
    await context.setOffline(false);
    await signInAgainAndDrain(page, context, logged);
  });
});
