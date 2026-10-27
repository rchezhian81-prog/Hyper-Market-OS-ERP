import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { enrolmentCodeHash } from '../../packages/platform-admin/src/device-enrolment';
import { withTillPeople, issueTillPins, pinOf } from '../support/till-operator';
import { signInOnPhonePage } from '../support/phone-sign-in-page';
import { deviceBase as boxDoor, sharedDeviceTls, trustingBrowserArgs } from '../support/box-tls';

let deviceTls: Awaited<ReturnType<typeof sharedDeviceTls>>;

/**
 * **OB-180 "A" (owner, 17 Oct 2026, "Stamp each record") in a real browser, against a REAL store computer with no cloud.**
 *
 * A real headless Chromium as the dock phone:
 *
 *   1. u-worker (A) signs in; the page the box serves carries A's sign-in to stamp under, and the phone's service worker
 *      keeps the page for offline use;
 *   2. the shop wifi drops: the phone reloads from its cache (A's page, said to be a kept copy) and A receives a frozen
 *      delivery and declares it complete with the checklist — all of it kept on the phone, each record stamped with A's
 *      sign-in;
 *   3. the wifi is back but the phone has not yet handed anything over; u-other (B) opens the sign-in page — which
 *      forgets the kept page holding A's sign-in — and signs in. A's sign-in ends there;
 *   4. B's page hands the queue over under B's sign-in. The box seals A's completion for A, not for B and not unsealed.
 *
 * Head office booking it complete in A's name is proven by tests/integration/ob180-*.test.ts (the same box, with head
 * office). Skips where no browser binary is present. Synthetic data only.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['ob180', 'stamp', 'browser', 'key'].join('-').padEnd(48, '0');
const TENANT = 't-sre';
const CODE = 'ABCDE-FGHJK-LMNPQ-RSTUV';
const HANDHELD = { viewport: { width: 360, height: 640 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const RECEIVING = {
  checks: [{ checkId: 'dock-receiving', branchId: 'store-1', title: 'Chilled and frozen delivery', kind: 'receiving', graceMinutes: 0, active: true,
    assignedRole: 'store_manager', escalatesTo: 'u-owner', items: [{ itemId: 'temp', label: 'Temperature taken' }, { itemId: 'pack', label: 'Packaging intact' }] }],
  coldChainProductIds: ['p-icecream'],
};
const PEOPLE = [{ userId: 'u-worker', displayName: 'Worker One', permissions: ['inventory.movement.append'] }, { userId: 'u-other', displayName: 'Other', permissions: ['inventory.movement.append'] }];

interface Win {
  readonly warehouseSession?: { sentWork(): { kind: string; state: string }[] };
  readonly warehouseRelay?: unknown;
  readonly phoneSignIn?: { userId: string; ref: string; key: string };
  readonly shellCachedAt?: string;
  readonly navigator: { serviceWorker: { ready: Promise<unknown>; controller: unknown } };
  readonly caches: { keys(): Promise<string[]>; open(k: string): Promise<{ keys(): Promise<{ url: string }[]> }> };
}
type Logged = { type: string; payload: Record<string, unknown> };

describe.skipIf(!HAVE_BROWSER)('OB-180: the handheld stamps each record with the sign-in it was made under', () => {
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

  const keptPages = (page: Page): Promise<string[]> => page.evaluate(async () => {
    const out: string[] = [];
    for (const k of await (globalThis as unknown as Win).caches.keys()) for (const r of await (await (globalThis as unknown as Win).caches.open(k)).keys()) out.push(new URL(r.url).pathname);
    return out.filter((p) => /^\/(warehouse|picker|driver)\/(index\.html)?$/.test(p));
  });

  it('A works offline from the kept page; B signs in; the queue reaches the box under B and A\'s completion is sealed for A', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-ob180-e2e-'));
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
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_DEVICE_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile, EDGE_LANE_ID: 'lane-1',
    }, () => {}))!;
    stops.push(() => edge.stop());
    const logged = async (): Promise<Logged[]> => (await readLog(edge.deviceEventsLog.path)).filter((r) => r.ok).map((r) => JSON.parse(r.ok ? r.record : '{}') as Logged);
    const base = `${boxDoor(edge)}`;

    const context = await browser.newContext(HANDHELD);
    stops.push(() => context.close());
    const page = await context.newPage();

    // ── 1. A signs in; the served page carries A's sign-in; the service worker keeps the page. ────────────────────────
    await page.goto(`${base}/warehouse/`, { waitUntil: 'load' });
    await page.fill('#deviceId', 'hh-01');
    await page.fill('#code', CODE);
    await page.click('button[type="submit"]');
    await signInOnPhonePage(page, 'warehouse', 'u-worker');
    await page.waitForFunction(() => (globalThis as unknown as Win).warehouseSession !== undefined && (globalThis as unknown as Win).warehouseRelay !== undefined, undefined, { timeout: 15_000 });
    const signInA = await page.evaluate(() => (globalThis as unknown as Win).phoneSignIn);
    expect(signInA).toMatchObject({ userId: 'u-worker' });
    await page.evaluate(() => (globalThis as unknown as Win).navigator.serviceWorker.ready.then(() => true));
    await page.waitForFunction(() => (globalThis as unknown as Win).navigator.serviceWorker.controller !== null, undefined, { timeout: 15_000 });
    await expect.poll(() => keptPages(page), { timeout: 10_000 }).toContain('/warehouse/');

    // ── 2. The wifi drops. The phone opens A's kept page and A works: a frozen scan, then delivery complete. ─────────────
    await context.setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof (globalThis as unknown as Win).shellCachedAt === 'string' && (globalThis as unknown as Win).warehouseSession !== undefined, undefined, { timeout: 15_000 });
    expect(await page.evaluate(() => (globalThis as unknown as Win).phoneSignIn?.ref)).toBe(signInA!.ref);
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
    // Kept on the phone, each record stamped with A's sign-in; nothing on the box.
    const queued = await page.evaluate(() => JSON.parse((globalThis as unknown as { localStorage: { getItem(k: string): string | null } }).localStorage.getItem('sre.warehouse.outbox.A-1') ?? '[]') as { key: string; state: string; event: { type: string }; stamp?: { ref: string; userId: string } }[]);
    expect(queued.map((i) => i.event.type)).toEqual(['ReceivingScanned', 'ReceivingCompleted']);
    for (const i of queued) expect(i).toMatchObject({ state: 'pending', stamp: { ref: signInA!.ref, userId: 'u-worker' } });
    expect(JSON.stringify(queued)).not.toContain(signInA!.key); // the key is never written to the queue
    expect(await logged()).toEqual([]);

    // ── 3. The wifi is back, the phone has not handed anything over yet; B opens the sign-in page and signs in. ──────────
    await context.route('**/lane/outbox', (route) => route.abort());
    await context.setOffline(false);
    await page.goto(`${base}/device/sign-in?screen=warehouse`, { waitUntil: 'load' });
    // The sign-in page forgot the kept page that held A's sign-in.
    await expect.poll(() => keptPages(page), { timeout: 10_000 }).toEqual([]);
    await page.fill('input[name="staffId"]', 'u-other');
    await page.fill('input[name="pin"]', pinOf('u-other'));
    await page.click('button[type="submit"]');
    await page.waitForFunction(() => (globalThis as unknown as { location: { pathname: string } }).location.pathname === '/warehouse/', undefined, { timeout: 15_000 });
    await page.waitForFunction(() => (globalThis as unknown as Win).warehouseRelay !== undefined, undefined, { timeout: 15_000 });
    const signInB = await page.evaluate(() => (globalThis as unknown as Win).phoneSignIn);
    expect(signInB).toMatchObject({ userId: 'u-other' });
    expect(signInB!.ref).not.toBe(signInA!.ref);
    expect(signInB!.key).not.toBe(signInA!.key);
    expect(await logged()).toEqual([]);

    // ── 4. B's page hands the queue over: A's completion is sealed for A. ─────────────────────────────────────────────────
    await context.unroute('**/lane/outbox');
    await expect.poll(async () => (await logged()).map((e) => e.type), { timeout: 20_000 }).toEqual(['ReceivingScanned', 'ReceivingCompleted']);
    const done = (await logged()).find((e) => e.type === 'ReceivingCompleted')!;
    expect(done.payload).toMatchObject({
      grnId: 'grn-ice', completedBy: 'u-worker',
      receivingChecklist: { performedBy: 'u-worker', itemResults: { temp: 'pass', pack: 'pass' } },
      deciderVerified: { userId: 'u-worker', via: 'phone_pin', laneId: 'device:hh-01' },
    });
  });
});
