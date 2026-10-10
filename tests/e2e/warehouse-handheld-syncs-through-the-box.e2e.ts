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
import { withTillPeople, issueTillPins } from '../support/till-operator';
import { signInOnPhonePage } from '../support/phone-sign-in-page';

/**
 * **A warehouse handheld, in a real browser, enrols on the store box's device socket and its scans reach the box
 * (SP-3a · ADR-0019 · S1 · F11's handheld half · M09-FR-01 · M07-FR-01 · P-01 · hard rules #1/#4/#6/#10).**
 *
 * Until SP-3a no handheld in a store could load its shell or reach the box at all: the shells were served on loopback
 * and their write base was the box's loopback lane. Everything below the browser is production: the real `startEdge`
 * opens its DEVICE socket, serves the real warehouse shell with the assignment injected and `laneWriteBase = ''`, and
 * stands its device-events pipeline behind `/lane/outbox`. A REAL headless Chromium at a handheld's size:
 *
 *   • asks for the shell with no credential and is sent to the enrolment page; types the wrong code and is refused with
 *     a reason and no shell; types the one-time code head office issued and is enrolled — the shell opens as the named
 *     worker with the assignment;
 *   • RECEIVES a delivery barcode, declares the DELIVERY COMPLETE (SP-6b — one tap, one completion behind the scan; the
 *     button is there only once something was received and gone once sent) and PUTS AWAY a goods-in item: each accepted scan shows in "Sent from this handheld"
 *     as saved here and, within a moment, with the store computer — because the box has it on its fsync'd log and in its
 *     queue for head office; the badge counts them by state;
 *   • COUNTS a bin BLIND (SP-3b · W2): the quantity sheet carries no expected figure; the count rides the same socket;
 *   • RELOADS: every scan is still listed with its state (the durable device queue is the authority), the badge
 *     agrees, and the box was sent nothing new.
 *
 * No cloud is configured: the box holds the work durably and will carry it up when one is (P-01). Head office delivery
 * is proven by `tests/integration/warehouse-handheld-reaches-the-cloud-through-the-edge.test.ts`. The browser binary is
 * the environment's pre-installed Chromium; where none is present the suite SKIPS. No physical device: PENDING.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['warehouse', 'handheld', 'reload', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = 't-sre';
const CODE = 'ABCDE-FGHJK-LMNPQ-RSTUV';
const HANDHELD = { viewport: { width: 360, height: 640 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

// DF-3-c (OB-30 "A"): the person who signs in on the phone, with the job's permission head office re-checks.
const PHONE_PERSON = 'u-worker';
const PACK_JSON = JSON.stringify(withTillPeople({
  version: 1,
  policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1', branchName: 'Main', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, privacySlaDays: 30, warehouseId: 'wh-1' },
  lossPreventionRules: [],
  warehouse: {
    assignmentId: 'A-1', workerId: 'u-worker', storeId: 'store-1',
    bins: [{ binId: 'BIN-A', storeId: 'store-1', capacityMinor: 1000, pickable: true, zone: 'ambient' }],
    grnId: 'grn-1', poId: 'po-1',
    ordered: [{ productId: 'p-rice', quantityMinor: 100, unitCostMinor: 4000, currency: 'INR' }],
    barcodes: [{ barcode: '890RICE', productId: 'p-rice', level: 'unit' }],
    goodsIn: [{ productId: 'p-good', batchId: null, quantityMinor: 6, uom: 'EA', state: 'on_hand', expiry: null }],
  },
  devices: [{ deviceId: 'hh-01', kind: 'handheld', status: 'registered', label: 'Racking 1', enrolment: { codeHash: enrolmentCodeHash(CODE), expiresAt: '2099-01-01T00:00:00.000Z' } }],
}, [{ userId: PHONE_PERSON, permissions: ['inventory.movement.append'] }]));

interface HandheldWindow {
  readonly laneWriteBase?: string;
  readonly deviceId?: string;
  readonly warehouseSession?: { sentWork(): { kind: string; id: string; state: string }[] };
  readonly warehouseRelay?: unknown;
  readonly warehouseOutbox?: { unsentCount(): number; all(): unknown[] };
  readonly document: { querySelector(selector: string): { hidden: boolean; textContent: string | null } | null; querySelectorAll(selector: string): { length: number } };
  readonly location: { pathname: string };
}

describe.skipIf(!HAVE_BROWSER)('the warehouse handheld enrols on the box\'s device socket and its scans reach the box (SP-3a · S1)', () => {
  let browser: Browser;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'warehouse-app'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function box(): Promise<{ edge: EdgeProcess; base: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'sre-wh-handheld-e2e-'));
    dirs.push(dir);
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, PACK_JSON, 'utf8');
    await issueTillPins(dir, KEY, [PHONE_PERSON]);
    const edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_DEVICE_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile,
    }, () => {}))!;
    stops.push(() => edge.stop());
    return { edge, base: `http://127.0.0.1:${edge.devices!.port}` };
  }

  async function openHandheld(base: string): Promise<Page> {
    const context = await browser.newContext(HANDHELD);
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`${base}/warehouse/`, { waitUntil: 'load' });
    return page;
  }
  const ready = (page: Page) => page.waitForFunction(
    () => (globalThis as unknown as HandheldWindow).warehouseSession !== undefined && (globalThis as unknown as HandheldWindow).laneWriteBase === '' && (globalThis as unknown as HandheldWindow).warehouseRelay !== undefined,
    undefined, { timeout: 15_000 },
  );
  /** A shop scanner is a keyboard: type the code, press Enter. */
  const scan = async (page: Page, code: string) => {
    await page.waitForSelector('#scan:not([hidden])', { timeout: 10_000 });
    await page.keyboard.type(code);
    await page.keyboard.press('Enter');
  };
  const sent = (page: Page) => page.evaluate(() => (globalThis as unknown as HandheldWindow).warehouseSession!.sentWork().map((w) => [w.kind, w.state]));
  const waitHanded = (page: Page, kind: string) => page.waitForFunction(
    (k) => (globalThis as unknown as HandheldWindow).warehouseSession!.sentWork().find((w) => w.kind === k)?.state === 'handed_to_box',
    kind, { timeout: 10_000 },
  );

  it('no credential → the enrolment page; the wrong code → refused, no shell; the right code → the shell as the named worker', async () => {
    const { base } = await box();
    const page = await openHandheld(base);
    // Sent to enrol — the shell itself is never served to a stranger.
    expect(await page.evaluate(() => (globalThis as unknown as HandheldWindow).location.pathname)).toBe('/device/enrol');
    expect(await page.textContent('body')).toContain('Enrol this handheld');
    expect(await page.evaluate(() => (globalThis as unknown as HandheldWindow).warehouseSession)).toBeUndefined();

    await page.fill('#deviceId', 'hh-01');
    await page.fill('#code', 'ABCDE-FGHJK-LMNPQ-RSTUW');
    await page.click('button[type="submit"]');
    await page.waitForSelector('#out:not([hidden])');
    expect(await page.textContent('#out')).toContain('not the enrolment code');
    expect(await page.evaluate(() => (globalThis as unknown as HandheldWindow).location.pathname)).toBe('/device/enrol');

    await page.fill('#code', 'abcde fghjk lmnpq rstuv'); // typed in lower case with spaces — normalized, still the code
    await page.click('button[type="submit"]');
    await signInOnPhonePage(page, 'warehouse', PHONE_PERSON);
    await page.waitForFunction(() => (globalThis as unknown as HandheldWindow).location.pathname === '/warehouse/', undefined, { timeout: 15_000 });
    await ready(page);
    expect(await page.textContent('#who')).toContain('u-worker');
    expect(await page.evaluate(() => (globalThis as unknown as HandheldWindow).deviceId)).toBe('hh-01');
    expect(await page.textContent('#queue-text')).toContain('nothing sent yet');
    // DF-3-c (OB-30 "A"): the phone says who is holding it, with the one button that hands it over.
    expect(await page.textContent('[data-phone-holder]')).toContain('Signed in: u-worker');
    await page.click('[data-phone-holder] button[type="submit"]');
    await page.waitForFunction(() => (globalThis as unknown as HandheldWindow).location.pathname === '/device/sign-in', undefined, { timeout: 15_000 });
    expect(await page.evaluate(() => (globalThis as unknown as HandheldWindow).warehouseSession)).toBeUndefined();
  });

  it('receive + delivery complete + put away + a blind count → saved here → with the store computer (durable on the box); reload → all still listed, nothing re-sent', async () => {
    const { edge, base } = await box();
    const page = await openHandheld(base);
    await page.fill('#deviceId', 'hh-01');
    await page.fill('#code', CODE);
    await page.click('button[type="submit"]');
    await signInOnPhonePage(page, 'warehouse', PHONE_PERSON);
    await page.waitForFunction(() => (globalThis as unknown as HandheldWindow).location.pathname === '/warehouse/', undefined, { timeout: 15_000 });
    await ready(page);

    // RECEIVE: the delivery barcode resolves to the ordered product → accepted → queued → handed to the box.
    await page.click('#receive');
    await scan(page, '890RICE');
    await page.waitForSelector('#banner:not([hidden])');
    expect(await page.textContent('#banner-title')).toBe('Received');
    await page.click('#banner-ok');
    await waitHanded(page, 'receipt');
    // The list and the badge follow the relay's render (the state moves before the paint).
    await page.waitForSelector('#sent-work .sent[data-kind="receipt"][data-state="handed_to_box"]');
    await page.waitForFunction(() => ((globalThis as unknown as HandheldWindow).document.querySelector('#queue-text')?.textContent ?? '').includes('with the store computer'), undefined, { timeout: 10_000 });

    // DELIVERY COMPLETE (SP-6b): the button appears only once something was received here; one tap queues ONE completion
    // behind the scan, naming the pack's order — no quantity is typed or sent. Then the button is gone.
    await page.waitForSelector('#done-receiving:not([hidden])');
    await page.click('#done-receiving');
    await page.waitForSelector('#banner:not([hidden])');
    expect(await page.textContent('#banner-title')).toBe('Receipt sent — head office will match the delivery to the order');
    await page.click('#banner-ok');
    await waitHanded(page, 'receipt_done');
    await page.waitForSelector('#sent-work .sent[data-kind="receipt_done"][data-state="handed_to_box"]');
    expect(await page.evaluate(() => (globalThis as unknown as HandheldWindow).document.querySelector('#done-receiving')?.hidden)).toBe(true);

    // PUT AWAY: the good goods-in item into the pickable bin.
    await page.locator('.item', { hasText: 'p-good' }).click();
    await page.click('#put-away');
    await scan(page, 'BIN-A');
    await page.waitForSelector('#banner:not([hidden])');
    expect(await page.textContent('#banner-title')).toBe('Put away');
    await page.click('#banner-ok');
    await waitHanded(page, 'put_away');
    await page.waitForSelector('#sent-work .sent[data-kind="put_away"][data-state="handed_to_box"]');
    expect(await page.textContent('#sent-work')).toContain('With the store computer');

    // COUNT, blind (SP-3b · W2): tap Count → scan the bin → scan the item → type what was seen. Same socket, same states.
    await page.click('#count-bin');
    await scan(page, 'BIN-A');
    await scan(page, 'p-good');
    await page.waitForSelector('#qty:not([hidden])');
    // The box put 6 in BIN-A a moment ago — nothing the counter reads says so (the keypad's own keys aside).
    expect(await page.textContent('#qty-title')).toBe('How many did you count? — p-good');
    expect(await page.textContent('#qty-hint')).toContain('The expected number is never shown here');
    expect(await page.textContent('#qty-entry')).toBe('0');
    await page.click('#qty-keypad button:has-text("5")');
    await page.click('#qty-ok');
    await page.waitForSelector('#banner:not([hidden])');
    expect(await page.textContent('#banner-title')).toBe('Counted');
    await page.click('#banner-ok');
    await page.waitForSelector('#scan:not([hidden])');
    await page.click('#scan-cancel'); // done counting
    await waitHanded(page, 'count');
    await page.waitForSelector('#sent-work .sent[data-kind="count"][data-state="handed_to_box"]');

    // The BOX has all four, on its fsync'd log and queued for head office — the scan, the delivery's completion behind it,
    // the applied command, the blind count.
    expect(edge.deviceEventsOutbox.pending().map((i) => i.event.type)).toEqual(['ReceivingScanned', 'ReceivingCompleted', 'WarehouseMovementApplied', 'StockCounted']);
    const records = (await readLog(edge.deviceEventsLog.path)).filter((r) => r.ok).map((r) => JSON.parse(r.ok ? r.record : '{}') as { type: string; payload: Record<string, unknown> });
    expect(records[0]?.payload).toMatchObject({ grnId: 'grn-1', productId: 'p-rice', quantityMinor: 1, receivedBy: 'u-worker', storeId: 'store-1' });
    expect(records[1]?.payload).toMatchObject({ grnId: 'grn-1', poId: 'po-1', completedBy: 'u-worker', storeId: 'store-1', scanCount: 1, source: 'warehouse-handheld' });
    expect(records[1]?.payload).not.toHaveProperty('quantityMinor');
    expect(records[2]?.payload).toMatchObject({ movedBy: 'u-worker', command: { kind: 'put_away', productId: 'p-good', toBinId: 'BIN-A', quantityMinor: 6 } });
    expect(records[3]?.payload).toMatchObject({ productId: 'p-good', binId: 'BIN-A', countedMinor: 5, counterId: 'u-worker', source: 'warehouse-handheld' });
    expect(records[3]?.payload).not.toHaveProperty('expectedMinor');
    expect(await sent(page)).toEqual([['count', 'handed_to_box'], ['put_away', 'handed_to_box'], ['receipt_done', 'handed_to_box'], ['receipt', 'handed_to_box']]);

    // RELOAD: the durable device queue is the authority — all listed, all with the store computer, box unchanged.
    await page.reload({ waitUntil: 'load' });
    await ready(page);
    await page.waitForSelector('#sent-work .sent[data-kind="receipt"][data-state="handed_to_box"]');
    await page.waitForSelector('#sent-work .sent[data-kind="receipt_done"][data-state="handed_to_box"]');
    await page.waitForSelector('#sent-work .sent[data-kind="put_away"][data-state="handed_to_box"]');
    await page.waitForSelector('#sent-work .sent[data-kind="count"][data-state="handed_to_box"]');
    await page.waitForFunction(() => ((globalThis as unknown as HandheldWindow).document.querySelector('#queue-text')?.textContent ?? '').includes('4 with the store computer'), undefined, { timeout: 10_000 });
    expect(await page.evaluate(() => (globalThis as unknown as HandheldWindow).warehouseOutbox!.unsentCount())).toBe(0);
    // The completed delivery stays completed across the reload — the durable queue remembers, so the button stays away.
    expect(await page.evaluate(() => (globalThis as unknown as HandheldWindow).document.querySelector('#done-receiving')?.hidden)).toBe(true);
    expect(edge.deviceEventsOutbox.all()).toHaveLength(4);
    expect((await readLog(edge.deviceEventsLog.path)).filter((r) => r.ok)).toHaveLength(4);
  }, 60_000);

  it('the receiving screen takes a probed arrival temperature on its own keypad: a malformed reading is refused and nothing is set; a number rides on the scan to the store computer (Wave 3 · SF-07 part 3)', async () => {
    const { edge, base } = await box();
    const page = await openHandheld(base);
    await page.fill('#deviceId', 'hh-01');
    await page.fill('#code', CODE);
    await page.click('button[type="submit"]');
    await signInOnPhonePage(page, 'warehouse', PHONE_PERSON);
    await page.waitForFunction(() => (globalThis as unknown as HandheldWindow).location.pathname === '/warehouse/', undefined, { timeout: 15_000 });
    await ready(page);
    expect(await page.textContent('#recv-temp')).toContain('not taken');
    const key = (k: string) => page.click(`#temp-keypad button:text-is("${k}")`);

    // A lone minus is not a temperature: refused on OK, nothing set, nothing queued.
    await page.click('#recv-temp');
    await page.waitForSelector('#temp:not([hidden])');
    await key('−');
    await page.click('#temp-ok');
    await page.waitForSelector('#banner:not([hidden])');
    expect(await page.textContent('#banner-title')).toBe('The temperature must be a number of degrees');
    await page.click('#banner-ok');
    expect(await page.textContent('#recv-temp')).toContain('not taken');
    expect(edge.deviceEventsOutbox.all()).toHaveLength(0);

    // −18 keyed: the button says so, and the next scan carries it to the box's durable log.
    await page.click('#recv-temp');
    await key('1'); await key('8'); await key('−');
    await page.click('#temp-ok');
    expect(await page.textContent('#recv-temp')).toContain('-18 °C');
    await page.click('#receive');
    await scan(page, '890RICE');
    await page.waitForSelector('#banner:not([hidden])');
    expect(await page.textContent('#banner-title')).toBe('Received');
    await page.click('#banner-ok');
    await waitHanded(page, 'receipt');
    const records = (await readLog(edge.deviceEventsLog.path)).filter((r) => r.ok).map((r) => JSON.parse(r.ok ? r.record : '{}') as { payload: Record<string, unknown> });
    expect(records).toHaveLength(1);
    expect(records[0]?.payload).toMatchObject({ grnId: 'grn-1', productId: 'p-rice', quantityMinor: 1, temperatureC: -18 });

    // "No reading" clears it.
    await page.click('#recv-temp');
    await page.click('#temp-none');
    expect(await page.textContent('#recv-temp')).toContain('not taken');
  }, 60_000);
});
