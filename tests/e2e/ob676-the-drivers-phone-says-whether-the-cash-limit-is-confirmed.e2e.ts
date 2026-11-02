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
import { deviceBase as boxDoor, sharedDeviceTls, trustingBrowserArgs } from '../support/box-tls';

/**
 * **OB-676 "A" (owner, 2 Nov 2026, in writing) · M19-FR-04 — the driver's phone, served by the store computer with no
 * network, says beside the cash difference whether the owner has confirmed the limit it was judged against.**
 *
 * The real `startEdge` serves the real driver shell from its store pack (the same `policies` head office signs). A real
 * headless Chromium at a phone's size enrols, signs in, counts the cash at the end of the shift and reads the answer:
 *   • the pack carries the ₹100 limit and NO confirmation (the owner has not confirmed it): the phone keeps working on ₹100
 *     — a ₹50 difference is not sent to the cash office — and says "The cash-difference limit (₹100.00) is not confirmed by
 *     the owner yet.";
 *   • the pack carries the owner's confirmation: the same count says no such thing.
 * In Tamil too. Needs the pre-installed Chromium; without it it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const KEY = ['ob676', 'driver', 'phone', 'signing', 'key'].join('-').padEnd(48, '0');
const CODE = 'ABCDE-FGHJK-LMNPQ-RSTUV';
const PHONE = { viewport: { width: 360, height: 640 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const PERSON = 'u-driver';
let deviceTls: Awaited<ReturnType<typeof sharedDeviceTls>>;

const packJson = (confirmed: boolean): string => JSON.stringify(withTillPeople({
  version: 1,
  policies: {
    tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1', branchName: 'Main', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000,
    handoverToleranceMinor: 10_000, privilegedActions: [],
    ...(confirmed ? { handoverToleranceConfirmed: { by: 'u-owner', at: '2026-11-02T10:00:00.000Z', version: 1 } } : {}),
  },
  lossPreventionRules: [],
  route: { routeId: 'R-1', driverId: PERSON, stops: [{ stopId: 's1', orderRef: 'ORD-1', area: 'Anna Nagar', codMinor: 0 }] },
  devices: [{ deviceId: 'hh-03', kind: 'handheld', status: 'registered', label: 'Van phone', enrolment: { codeHash: enrolmentCodeHash(CODE), expiresAt: '2099-01-01T00:00:00.000Z' } }],
}, [{ userId: PERSON, permissions: ['delivery.attempt.record'] }]));

interface PhoneWindow { readonly routeSession?: unknown; readonly location: { pathname: string } }

describe.skipIf(!existsSync(CHROMIUM))('OB-676 — the driver\'s phone says whether the owner confirmed the cash limit (M19-FR-04), offline from the box', () => {
  let browser: Browser;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'delivery-app'], { stdio: 'ignore' });
    deviceTls = await sharedDeviceTls();
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM, args: trustingBrowserArgs(deviceTls.keyPin) });
  }, 180_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function phoneOn(confirmed: boolean): Promise<Page> {
    const dir = await mkdtemp(join(tmpdir(), 'sre-ob676-phone-'));
    dirs.push(dir);
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, packJson(confirmed), 'utf8');
    await issueTillPins(dir, KEY, [PERSON]);
    const edge = (await startEdge({
      EDGE_DEVICE_TLS_DIR: deviceTls.dir, EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_DEVICE_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile,
    }, () => {}))!;
    stops.push(() => edge.stop());
    const context = await browser.newContext(PHONE);
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`${boxDoor(edge)}/driver/`, { waitUntil: 'load' });
    await page.fill('#deviceId', 'hh-03');
    await page.fill('#code', CODE);
    await page.click('button[type="submit"]');
    await signInOnPhonePage(page, 'driver', PERSON);
    await page.waitForFunction(() => (globalThis as unknown as PhoneWindow).location.pathname === '/driver/', undefined, { timeout: 15_000 });
    await page.waitForFunction(() => (globalThis as unknown as PhoneWindow).routeSession !== undefined, undefined, { timeout: 15_000 });
    return page;
  }

  /** End the shift with ₹50 in the bag — the day recorded nothing, so the difference is ₹50 over. */
  async function handOverFifty(page: Page): Promise<{ title: string; text: string }> {
    await page.click('#handover');
    await page.waitForSelector('#count:not([hidden])');
    await page.click('button[aria-label="one more ₹50.00"]');
    await page.click('#count-ok');
    await page.waitForSelector('#banner:not([hidden])');
    return { title: (await page.textContent('#banner-title')) ?? '', text: (await page.textContent('#banner-text')) ?? '' };
  }

  it('not confirmed: the phone keeps the ₹100 limit (₹50 over is not for the cash office) and says the limit is not confirmed — in Tamil too', async () => {
    const page = await phoneOn(false);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const said = await handOverFifty(page);
    expect(said.title).toBe('You have more than the day recorded, by ₹50.00');
    expect(said.text).toContain('The cash-difference limit (₹100.00) is not confirmed by the owner yet.');
    expect(said.text).not.toContain('cash office must be told');
    await page.click('#banner-ok');
    await page.click('#lang');
    const tamil = await handOverFifty(page);
    expect(tamil.text).toContain('உரிமையாளர் இன்னும் உறுதிசெய்யவில்லை');
    expect(errors).toEqual([]);
  }, 120_000);

  it('confirmed by the owner (the pack carries his confirmation): the same count says nothing about it', async () => {
    const page = await phoneOn(true);
    const said = await handOverFifty(page);
    expect(said.title).toBe('You have more than the day recorded, by ₹50.00');
    expect(said.text).not.toContain('not confirmed');
    expect(said.text).toContain('Counted: ₹50.00');
  }, 120_000);
});
