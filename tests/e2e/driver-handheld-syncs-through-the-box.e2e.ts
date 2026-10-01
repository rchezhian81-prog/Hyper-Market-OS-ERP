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

/**
 * **A driver's phone, in a real browser, enrols on the store box's device socket and its stop outcomes, settlement and cash
 * handover reach the box (SP-3c-ii · ADR-0019 · F11's driver half · M19-FR-03 · M19-FR-04 · P-01 · hard rules #1/#3/#4/#6/#10).**
 *
 * Everything below the browser is production: the real `startEdge` opens its DEVICE socket, serves the real driver shell with
 * the route injected and `laneWriteBase = ''`, and stands its device-events pipeline behind `/lane/outbox`. A REAL headless
 * Chromium at a phone's size:
 *
 *   • asks for the DRIVER shell with no credential and is sent to the enrolment page carrying where it was going; types the
 *     one-time code and is enrolled — back on the driver shell, with the route;
 *   • DELIVERS the first stop (proof, then the cash) and FAILS the second (a reason, then back to the store): each outcome
 *     shows in "Sent from this phone" as saved here and, within a moment, with the store computer; the badge counts by state;
 *   • ends the shift: the blind cash count → the settlement AND the counted handover are queued behind the stops;
 *   • RELOADS: every piece of work is still listed with its state (the durable device queue is the authority) and the box was
 *     sent nothing new.
 *
 * No cloud is configured: the box holds the work durably and will carry it up when one is (P-01). Head office delivery is
 * proven by `tests/integration/driver-handheld-reaches-the-cloud-through-the-edge.test.ts`. No physical device: PENDING (SP-10).
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['driver', 'handheld', 'browser', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = 't-sre';
const CODE = 'ABCDE-FGHJK-LMNPQ-RSTUV';
const PHONE = { viewport: { width: 360, height: 640 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

const PACK_JSON = JSON.stringify({
  version: 1,
  policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1', branchName: 'Main', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, privilegedActions: [] },
  lossPreventionRules: [],
  route: {
    routeId: 'R-1', driverId: 'u-driver',
    stops: [
      { stopId: 's1', orderRef: 'ORD-1041', area: 'Anna Nagar', codMinor: 250_00 },
      { stopId: 's2', orderRef: 'ORD-1044', area: 'Gandhipuram', codMinor: 0 },
    ],
  },
  devices: [{ deviceId: 'hh-03', kind: 'handheld', status: 'registered', label: 'Van phone', enrolment: { codeHash: enrolmentCodeHash(CODE), expiresAt: '2099-01-01T00:00:00.000Z' } }],
});

interface PhoneWindow {
  readonly laneWriteBase?: string;
  readonly deviceId?: string;
  readonly routeSession?: { sentWork(): { kind: string; id: string; state: string; detail: string }[] };
  readonly driverRelay?: unknown;
  readonly driverOutbox?: { unsentCount(): number; all(): unknown[] };
  readonly document: { querySelector(selector: string): { hidden: boolean; textContent: string | null } | null };
  readonly location: { pathname: string; search: string };
}

describe.skipIf(!HAVE_BROWSER)('the driver\'s phone enrols on the box\'s device socket and its outcomes, settlement and handover reach the box (SP-3c-ii)', () => {
  let browser: Browser;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'delivery-app'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function box(): Promise<{ edge: EdgeProcess; base: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'sre-driver-handheld-e2e-'));
    dirs.push(dir);
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, PACK_JSON, 'utf8');
    const edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_DEVICE_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile,
    }, () => {}))!;
    stops.push(() => edge.stop());
    return { edge, base: `http://127.0.0.1:${edge.devices!.port}` };
  }

  async function openPhone(base: string): Promise<Page> {
    const context = await browser.newContext(PHONE);
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`${base}/driver/`, { waitUntil: 'load' });
    return page;
  }
  const ready = (page: Page) => page.waitForFunction(
    () => (globalThis as unknown as PhoneWindow).routeSession !== undefined && (globalThis as unknown as PhoneWindow).laneWriteBase === '' && (globalThis as unknown as PhoneWindow).driverRelay !== undefined,
    undefined, { timeout: 15_000 },
  );
  const sent = (page: Page) => page.evaluate(() => (globalThis as unknown as PhoneWindow).routeSession!.sentWork().map((w) => [w.kind, w.id, w.state]));
  /** Every queued item for an id is with the store computer (a stop has several outcomes). */
  const waitHanded = (page: Page, id: string) => page.waitForFunction(
    (k) => { const mine = (globalThis as unknown as PhoneWindow).routeSession!.sentWork().filter((w) => w.id === k); return mine.length > 0 && mine.every((w) => w.state === 'handed_to_box'); },
    id, { timeout: 10_000 },
  );
  const queueText = (page: Page) => page.evaluate(() => (globalThis as unknown as PhoneWindow).document.querySelector('#queue-text')?.textContent ?? '');

  async function enrolled(base: string): Promise<Page> {
    const page = await openPhone(base);
    expect(await page.evaluate(() => (globalThis as unknown as PhoneWindow).location.pathname)).toBe('/device/enrol');
    expect(await page.evaluate(() => (globalThis as unknown as PhoneWindow).location.search)).toBe('?why=no_credential&next=%2Fdriver%2F');
    await page.fill('#deviceId', 'hh-03');
    await page.fill('#code', CODE);
    await page.click('button[type="submit"]');
    await page.waitForFunction(() => (globalThis as unknown as PhoneWindow).location.pathname === '/driver/', undefined, { timeout: 15_000 });
    await ready(page);
    return page;
  }

  it('no credential → the enrolment page, carrying the driver shell as where to go back to; the right code → the driver shell with the route', async () => {
    const { base } = await box();
    const page = await enrolled(base);
    expect(await page.textContent('#route')).toContain('R-1');
    expect(await page.evaluate(() => (globalThis as unknown as PhoneWindow).deviceId)).toBe('hh-03');
    expect(await page.textContent('#queue-text')).toBe('nothing sent yet');
    expect(await page.evaluate(() => (globalThis as unknown as PhoneWindow).document.querySelector('#sent-heading')?.hidden)).toBe(true);
  });

  it('deliver + fail + end of shift → saved here → with the store computer (durable on the box); reload → all still listed, nothing re-sent', async () => {
    const { edge, base } = await box();
    const page = await enrolled(base);

    // DELIVER the first stop: proof first, then how it was paid, then the amount the order says (already on the keypad).
    await page.click('#deliver');
    await page.waitForSelector('#choices:not([hidden])');
    await page.click('#choices button:has-text("Photo")');
    await page.waitForSelector('#choices button:has-text("Cash")');
    await page.click('#choices button:has-text("Cash")');
    await page.waitForSelector('#keypad:not([hidden])');
    expect(await page.textContent('#entry')).toBe('250');
    await page.click('#sheet-ok');
    await page.waitForSelector('#banner:not([hidden])');
    expect(await page.textContent('#banner-title')).toBe('Delivered');
    await page.click('#banner-ok');
    await waitHanded(page, 's1');
    await page.waitForSelector('#sent-work .sent[data-kind="stop"][data-id="s1"][data-state="handed_to_box"]');
    expect(await page.textContent('#sent-work .sent[data-id="s1"] .what')).toBe('Stop · Anna Nagar · ORD-1041 — delivered · 25000 INR');
    expect(await page.textContent('#sent-work .sent[data-id="s1"] .pill')).toBe('With the store computer');
    await page.waitForFunction(() => ((globalThis as unknown as PhoneWindow).document.querySelector('#queue-text')?.textContent ?? '').includes('with the store computer'), undefined, { timeout: 10_000 });
    expect(await page.textContent('#held')).toBe('₹250.00');

    // FAIL the second: a reason, then where the goods go — back to the store.
    await page.click('#failed');
    await page.waitForSelector('#choices:not([hidden])');
    await page.click('#choices button:has-text("Nobody at home")');
    await page.waitForSelector('#choices button:has-text("Take it back")');
    await page.click('#choices button:has-text("Take it back")');
    await page.waitForSelector('#banner:not([hidden])');
    expect(await page.textContent('#banner-title')).toBe('Recorded as not delivered');
    await page.click('#banner-ok');
    await waitHanded(page, 's2');
    expect(await page.textContent('#sent-work .sent[data-id="s2"] .what')).toBe('Stop · Gandhipuram · ORD-1044 — returned_to_origin · nobody_home');

    // END OF SHIFT: count the cash blind (₹200 + ₹50), hand over → the settlement and the handover ride behind the stops.
    await page.click('#handover');
    await page.waitForSelector('#count:not([hidden])');
    expect(await page.textContent('#count .sheet-inner')).not.toContain('250');
    await page.click('button[aria-label="one more ₹200.00"]');
    await page.click('button[aria-label="one more ₹50.00"]');
    expect(await page.textContent('#count-total')).toBe('Counted: ₹250.00');
    await page.click('#count-ok');
    await page.waitForSelector('#banner:not([hidden])');
    expect(await page.textContent('#banner-title')).toBe('The cash matches exactly.');
    await page.click('#banner-ok');
    await waitHanded(page, 'R-1');
    await page.waitForSelector('#sent-work .sent[data-kind="settlement"][data-state="handed_to_box"]');
    await page.waitForSelector('#sent-work .sent[data-kind="handover"][data-state="handed_to_box"]');
    expect(await page.textContent('#sent-work .sent[data-kind="settlement"] .what')).toBe('Shift settled · R-1 — 25000 of 25000 INR · 0 exceptions');
    expect(await page.textContent('#sent-work .sent[data-kind="handover"] .what')).toBe('Cash handed over · R-1 — counted 25000 INR · balanced');
    expect(await queueText(page)).toBe('7 with the store computer');

    // The BOX has all seven, on its fsync'd log and queued for head office — each naming the driver, none naming a customer.
    expect(edge.deviceEventsOutbox.pending().map((i) => i.event.type)).toEqual([
      'DeliveryStopUpdated', 'DeliveryStopUpdated', 'DeliveryStopUpdated', 'DeliveryStopUpdated', 'DeliveryStopUpdated', 'RouteSettled', 'DriverCashHandedOver',
    ]);
    const records = (await readLog(edge.deviceEventsLog.path)).filter((r) => r.ok).map((r) => JSON.parse(r.ok ? r.record : '{}') as { idempotencyKey: string; payload: Record<string, unknown> });
    expect(records.map((r) => r.idempotencyKey)).toEqual([
      'stop:R-1:s1:out_for_delivery', 'stop:R-1:s1:delivered', 'stop:R-1:s2:out_for_delivery', 'stop:R-1:s2:failed', 'stop:R-1:s2:returned_to_origin', 'settle:R-1', 'handover:R-1',
    ]);
    expect(records[1]?.payload).toMatchObject({ routeId: 'R-1', driverId: 'u-driver', stopId: 's1', orderRef: 'ORD-1041', state: 'delivered', codExpectedMinor: 250_00, codCollectedMinor: 250_00, codMethod: 'cash', proofKind: 'photo' });
    expect(records[3]?.payload).toMatchObject({ stopId: 's2', state: 'failed', failureReason: 'nobody_home', codCollectedMinor: 0 });
    expect(records[5]?.payload).toMatchObject({ routeId: 'R-1', driverId: 'u-driver', expectedMinor: 250_00, collectedMinor: 250_00, cashHeldMinor: 250_00, matchedCount: 1, exceptionCount: 0 });
    expect(records[6]?.payload).toMatchObject({ routeId: 'R-1', driverId: 'u-driver', countedMinor: 250_00, recordedMinor: 250_00, varianceMinor: 0, material: false });
    expect(JSON.stringify(records)).not.toMatch(/customer|phone number|address/i);
    expect((await sent(page)).map((w) => w[2])).toEqual(Array(7).fill('handed_to_box'));

    // RELOAD: the durable device queue is the authority — all listed, all with the store computer, box unchanged.
    await page.reload({ waitUntil: 'load' });
    await ready(page);
    await page.waitForSelector('#sent-work .sent[data-kind="handover"][data-state="handed_to_box"]');
    await page.waitForFunction(() => ((globalThis as unknown as PhoneWindow).document.querySelector('#queue-text')?.textContent ?? '').includes('7 with the store computer'), undefined, { timeout: 10_000 });
    expect(await page.evaluate(() => (globalThis as unknown as PhoneWindow).driverOutbox!.unsentCount())).toBe(0);
    expect(edge.deviceEventsOutbox.all()).toHaveLength(7);
    expect((await readLog(edge.deviceEventsLog.path)).filter((r) => r.ok)).toHaveLength(7);
  }, 60_000);
});
