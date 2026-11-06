import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { writeSignedPack } from '../../edge/store-edge/src/signed-pack-file';
import { hmacSigner, publishPack } from '../../services/catalogue/src/index';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import { enrolmentCodeHash } from '../../packages/platform-admin/src/device-enrolment';
import { prepareTillBox, signInThroughScreen, pinOf } from '../support/till-operator';
import { deviceBase as boxDoor, sharedDeviceTls, trustingBrowserArgs } from '../support/box-tls';
import { auditPage } from './lib/a11y-audit';
import { tillCatalogue } from './lib/device-screens';

/**
 * **OB-638 (owner, 1 Nov 2026, option A): the till, the self-checkout lane and the queue till name the person signed in —
 * "Ravi (u-ravi)", the name the store computer gave at sign-in with the staff code beside it.** In real Chromium, served
 * by a real store computer with no head office (hard rule 1):
 *
 *   • the till: signed in through its own screen → "Signed in: Ravi (u-ravi)", in Tamil too; a reload keeps the name (the
 *     box's answer names them again); the record's code is unchanged; a scan still makes no network call; signed out →
 *     "Nobody signed in" (the code-only fallback is proved in tests/unit/ob638-the-screens-name-the-person-signed-in.test.ts);
 *   • the self-checkout lane: "Opened by: Attendant (u-attend)";
 *   • the queue till on an enrolled handheld: "Signed in: Ravi (u-ravi)".
 *
 * Each name check failed before OB-638 (the screens showed "Signed in: u-ravi", "Opened by: u-attend", "Signed in: Ravi").
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const SHOTS = process.env['SRE_SHOTS'];
const KEY = ['ob638', 'names', 'key'].join('-').padEnd(48, '0');
const TENANT = 't-sre';
const RICE = '8900000000707';
const ENROL = 'OB638-QUEUE-ENROL-CODE1';

let deviceTls: Awaited<ReturnType<typeof sharedDeviceTls>>;

function signedPack() {
  const snapshot = { ...tillCatalogue(), tenantId: TENANT } as unknown as CatalogueSnapshot;
  const result = publishPack({ snapshot, approvals: [], signer: hmacSigner(KEY), publishedBy: 'u-manager', publishedAt: snapshot.builtAt });
  if (!result.ok || result.pack === undefined) throw new Error(result.detail);
  return result.pack;
}

describe.skipIf(!existsSync(CHROMIUM))('OB-638: the screens name the person signed in', () => {
  let browser: Browser;
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    if (SHOTS !== undefined) mkdirSync(SHOTS, { recursive: true });
    for (const app of ['pos', 'self-checkout', 'queue-pos']) execFileSync('node', ['scripts/build-app.mjs', app], { stdio: 'ignore' });
    deviceTls = await sharedDeviceTls();
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM, args: trustingBrowserArgs(deviceTls.keyPin) });
  }, 180_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });

  async function box(pack: Record<string, unknown>, people: { userId: string; displayName: string }[], extra: Record<string, string> = {}): Promise<EdgeProcess> {
    const dir = await mkdtemp(join(tmpdir(), 'sre-ob638-'));
    stops.push(() => rm(dir, { recursive: true, force: true }));
    await writeSignedPack(dir, signedPack());
    const edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_LANE_PORT: '0', ...extra,
      ...await prepareTillBox({ dir, key: KEY, people, pack: { version: 1, policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1' }, lossPreventionRules: [], ...pack } }),
    }, () => {}))!;
    stops.push(() => edge.stop());
    return edge;
  }
  const text = async (page: Page, sel: string): Promise<string> => ((await page.textContent(sel)) ?? '').trim();

  it('the till: "Signed in: Ravi (u-ravi)" in English and Tamil, kept across a reload; the code on record; a scan makes no call; signed out, nobody', async () => {
    const edge = await box({}, [{ userId: 'u-ravi', displayName: 'Ravi' }]);
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    stops.push(() => context.close());
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/pos/`, { waitUntil: 'load' });
    await page.waitForFunction('globalThis.posSession?.hasCatalogue() === true', undefined, { timeout: 15_000 });
    expect(await text(page, '#cashier')).toBe('Nobody signed in');

    await signInThroughScreen(page, 'u-ravi');
    expect(await text(page, '#cashier')).toBe('Signed in: Ravi (u-ravi)');
    expect(await page.getAttribute('#lane', 'data-operator')).toBe('u-ravi');
    expect(await page.evaluate('globalThis.posSession.operator()')).toBe('u-ravi');
    expect(await auditPage(page, { expectLang: 'en' })).toEqual([]);
    if (SHOTS !== undefined) await page.screenshot({ path: join(SHOTS, 'till-1366-signed-in-by-name.png') });

    // a scan is still the till's own — no call leaves the page for it
    const requests: string[] = [];
    page.on('request', (r) => { requests.push(new URL(r.url()).pathname); });
    await page.keyboard.type(RICE); await page.keyboard.press('Enter');
    await page.waitForSelector('#lines tr');
    await page.waitForTimeout(200);
    expect(requests.filter((p) => p !== '/lane/sync-status'), 'no network call for a scan').toEqual([]);

    await page.click('#lang');
    await page.waitForFunction('document.documentElement.lang === "ta"');
    expect(await text(page, '#cashier')).toBe('உள்நுழைந்தவர்: Ravi (u-ravi)');
    expect(await auditPage(page, { expectLang: 'ta' })).toEqual([]);
    await page.click('#lang');

    // a reload: the box's answer about the session this tab kept names the person again
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction('globalThis.posSession?.operator() === "u-ravi"', undefined, { timeout: 15_000 });
    await page.waitForFunction('document.getElementById("cashier").textContent === "Signed in: Ravi (u-ravi)"', undefined, { timeout: 5_000 });

    // signed out: nobody, never the last name
    await page.click('#signin');
    await page.waitForFunction('document.getElementById("cashier").textContent === "Nobody signed in"');
    expect(errors).toEqual([]);
  }, 60_000);

  it('the self-checkout lane: "Opened by: Attendant (u-attend)", in Tamil too', async () => {
    const edge = await box({ rollout: { format: 'sre-rollout/1', branchId: 'store-1', switches: [{ key: 'self_checkout', branch: null, lanes: [{ laneId: 'lane-1', enabled: true, version: 1 }] }] } },
      [{ userId: 'u-attend', displayName: 'Attendant' }]);
    const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/self-checkout/`, { waitUntil: 'load' });
    await page.waitForFunction('globalThis.selfCheckout !== undefined', undefined, { timeout: 15_000 });
    expect(await text(page, '#subtitle')).toBe('Not open');
    await page.click('#colleague');
    await page.fill('#staff', 'u-attend'); await page.fill('#pin', pinOf('u-attend'));
    await page.click('#open-lane');
    await page.waitForFunction('globalThis.selfCheckout.view().open');
    await page.click('#panel-done');
    expect(await text(page, '#subtitle')).toBe('Opened by: Attendant (u-attend)');
    expect(await page.evaluate('globalThis.selfCheckout.view().attendant')).toBe('u-attend');
    await page.click('#lang');
    expect(await text(page, '#subtitle')).toBe('திறந்தவர்: Attendant (u-attend)');
    if (SHOTS !== undefined) await page.screenshot({ path: join(SHOTS, 'self-checkout-1024-opened-by-name-ta.png') });
  }, 60_000);

  it('the queue till on an enrolled handheld: "Signed in: Ravi (u-ravi)"', async () => {
    const edge = await box({
      devices: [{ deviceId: 'hh-q1', kind: 'handheld', status: 'registered', label: 'Queue till 1', enrolment: { codeHash: enrolmentCodeHash(ENROL), expiresAt: '2099-01-01T00:00:00.000Z' } }],
      rollout: { format: 'sre-rollout/1', branchId: 'store-1', switches: [{ key: 'pos.queue_busting', branch: null, lanes: [{ laneId: 'lane-1', enabled: true, version: 1 }] }] },
    }, [{ userId: 'u-ravi', displayName: 'Ravi' }], { EDGE_DEVICE_TLS_DIR: deviceTls.dir, EDGE_DEVICE_PORT: '0' });
    const phone = await browser.newContext({ viewport: { width: 360, height: 640 }, hasTouch: true, isMobile: true });
    stops.push(() => phone.close());
    const page = await phone.newPage();
    await page.goto(`${boxDoor(edge)}/queue-pos/`, { waitUntil: 'load' });
    await page.fill('#deviceId', 'hh-q1');
    await page.fill('#code', ENROL);
    await page.click('button[type=submit]');
    await page.waitForURL(/\/queue-pos\/sign-in$/);
    await page.fill('input[name=staffId]', 'u-ravi');
    await page.fill('input[name=pin]', pinOf('u-ravi'));
    await page.click('button[type=submit]');
    await page.waitForURL(/\/queue-pos\/$/);
    await page.waitForFunction('document.getElementById("who").textContent === "Signed in: Ravi (u-ravi)"', undefined, { timeout: 15_000 });
    await page.click('#lang');
    expect(await text(page, '#who')).toBe('உள்நுழைந்தவர்: Ravi (u-ravi)');
    if (SHOTS !== undefined) await page.screenshot({ path: join(SHOTS, 'queue-pos-360-signed-in-by-name-ta.png') });
  }, 60_000);
});
