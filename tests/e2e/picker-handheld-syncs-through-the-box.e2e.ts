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
 * **A picker handheld, in a real browser, enrols on the store box's device socket and its outcomes and pack reach the box
 * (SP-3c-i · ADR-0019 · F11's picker half · M19-FR-01 · M19-FR-02 · D09 · P-01 · hard rules #1/#4/#6/#10).**
 *
 * Until SP-3c-i a picker's queue reached nobody: it filled a durable device queue that no relay read and no cloud route
 * accepted. Everything below the browser is production: the real `startEdge` opens its DEVICE socket, serves the real picker
 * shell with the wave injected and `laneWriteBase = ''`, and stands its device-events pipeline behind `/lane/outbox`. A REAL
 * headless Chromium at a handheld's size:
 *
 *   • asks for the PICKER shell with no credential and is sent to the enrolment page carrying where it was going; types the
 *     one-time code head office issued and is enrolled — back on the picker shell, as the named picker, with the wave;
 *   • PICKS a line the spec's way — scan the bin from the list, scan the item, confirm — and the outcome shows in "Sent from
 *     this handheld" as saved here and, within a moment, with the store computer, because the box has it on its fsync'd log and
 *     in its queue for head office; the badge counts by state;
 *   • flags a QUALITY FAIL from the shelf (scan the bin → Problem → the reason) — the same socket, the same states;
 *   • PACKS the crate (temperature, seal) — the pack rides behind its outcomes, naming the picker as the packer;
 *   • RELOADS: every piece of work is still listed with its state (the durable device queue is the authority), the badge
 *     agrees, and the box was sent nothing new.
 *
 * No cloud is configured: the box holds the work durably and will carry it up when one is (P-01). Head office delivery is
 * proven by `tests/integration/picker-handheld-reaches-the-cloud-through-the-edge.test.ts`. The browser binary is the
 * environment's pre-installed Chromium; where none is present the suite SKIPS. No physical device: PENDING (SP-10).
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['picker', 'handheld', 'browser', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = 't-sre';
const CODE = 'ABCDE-FGHJK-LMNPQ-RSTUV';
const HANDHELD = { viewport: { width: 360, height: 640 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

// DF-3-c (OB-30 "A"): the person who signs in on the phone, with the job's permission head office re-checks.
const PHONE_PERSON = 'u-picker';
const PACK_JSON = JSON.stringify(withTillPeople({
  version: 1,
  policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1', branchName: 'Main', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, privilegedActions: [] },
  lossPreventionRules: [],
  wave: {
    waveId: 'W-1', pickerId: 'u-picker',
    lines: [
      { lineId: 'l1', orderRef: 'ORD-1', productId: 'p-rice', description: 'Rice 5kg', bin: 'A-01', requiredQty: 2, uom: 'ea', unitPriceMinor: 100_00 },
      { lineId: 'l2', orderRef: 'ORD-1', productId: 'p-milk', description: 'Milk 1L', bin: 'B-04', requiredQty: 1, uom: 'ea', unitPriceMinor: 60_00 },
    ],
  },
  devices: [{ deviceId: 'hh-02', kind: 'handheld', status: 'registered', label: 'Aisle picker', enrolment: { codeHash: enrolmentCodeHash(CODE), expiresAt: '2099-01-01T00:00:00.000Z' } }],
}, [{ userId: PHONE_PERSON, permissions: ['fulfilment.pack.record'] }]));

interface HandheldWindow {
  readonly laneWriteBase?: string;
  readonly deviceId?: string;
  readonly pickSession?: { sentWork(): { kind: string; id: string; state: string }[] };
  readonly pickerRelay?: unknown;
  readonly pickerOutbox?: { unsentCount(): number; all(): unknown[] };
  readonly document: { querySelector(selector: string): { hidden: boolean; textContent: string | null } | null };
  readonly location: { pathname: string; search: string };
}

describe.skipIf(!HAVE_BROWSER)('the picker handheld enrols on the box\'s device socket and its outcomes and pack reach the box (SP-3c-i)', () => {
  let browser: Browser;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'picker-app'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function box(): Promise<{ edge: EdgeProcess; base: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'sre-picker-handheld-e2e-'));
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
    await page.goto(`${base}/picker/`, { waitUntil: 'load' });
    return page;
  }
  const ready = (page: Page) => page.waitForFunction(
    () => (globalThis as unknown as HandheldWindow).pickSession !== undefined && (globalThis as unknown as HandheldWindow).laneWriteBase === '' && (globalThis as unknown as HandheldWindow).pickerRelay !== undefined,
    undefined, { timeout: 15_000 },
  );
  /** A shop scanner is a keyboard: type the code, press Enter. */
  const scan = async (page: Page, code: string) => {
    await page.keyboard.type(code);
    await page.keyboard.press('Enter');
  };
  const sent = (page: Page) => page.evaluate(() => (globalThis as unknown as HandheldWindow).pickSession!.sentWork().map((w) => [w.kind, w.id, w.state]));
  const waitHanded = (page: Page, id: string) => page.waitForFunction(
    (k) => (globalThis as unknown as HandheldWindow).pickSession!.sentWork().find((w) => w.id === k)?.state === 'handed_to_box',
    id, { timeout: 10_000 },
  );
  const queueText = (page: Page) => page.evaluate(() => (globalThis as unknown as HandheldWindow).document.querySelector('#queue-text')?.textContent ?? '');

  it('no credential → the enrolment page, carrying the picker shell as where to go back to; the right code → the picker shell as the named picker with the wave', async () => {
    const { base } = await box();
    const page = await openHandheld(base);
    expect(await page.evaluate(() => (globalThis as unknown as HandheldWindow).location.pathname)).toBe('/device/enrol');
    expect(await page.evaluate(() => (globalThis as unknown as HandheldWindow).location.search)).toBe('?why=no_credential&next=%2Fpicker%2F');
    expect(await page.textContent('body')).toContain('Enrol this handheld');
    expect(await page.evaluate(() => (globalThis as unknown as HandheldWindow).pickSession)).toBeUndefined();

    await page.fill('#deviceId', 'hh-02');
    await page.fill('#code', 'ABCDE-FGHJK-LMNPQ-RSTUW');
    await page.click('button[type="submit"]');
    await page.waitForSelector('#out:not([hidden])');
    expect(await page.textContent('#out')).toContain('not the enrolment code');

    await page.fill('#code', CODE);
    await page.click('button[type="submit"]');
    await signInOnPhonePage(page, 'picker', PHONE_PERSON);
    await page.waitForFunction(() => (globalThis as unknown as HandheldWindow).location.pathname === '/picker/', undefined, { timeout: 15_000 });
    await ready(page);
    expect(await page.textContent('#wave')).toContain('W-1');
    expect(await page.evaluate(() => (globalThis as unknown as HandheldWindow).deviceId)).toBe('hh-02');
    expect(await page.textContent('#queue-text')).toBe('nothing sent yet');
    expect(await page.evaluate(() => (globalThis as unknown as HandheldWindow).document.querySelector('#sent-heading')?.hidden)).toBe(true);
  });

  it('pick a line + a quality fail + pack the crate → saved here → with the store computer (durable on the box); reload → all still listed, nothing re-sent', async () => {
    const { edge, base } = await box();
    const page = await openHandheld(base);
    await page.fill('#deviceId', 'hh-02');
    await page.fill('#code', CODE);
    await page.click('button[type="submit"]');
    await signInOnPhonePage(page, 'picker', PHONE_PERSON);
    await page.waitForFunction(() => (globalThis as unknown as HandheldWindow).location.pathname === '/picker/', undefined, { timeout: 15_000 });
    await ready(page);

    // PICK, the spec's way: the bin scanned from the list IS step 1 → scan the item → confirm the quantity (pre-filled with what was asked).
    await scan(page, 'A-01');
    await page.waitForSelector('#scan:not([hidden])');
    expect(await page.textContent('#scan-title')).toBe('Scan the item — Rice 5kg');
    await scan(page, 'p-rice');
    await page.waitForSelector('#sheet:not([hidden])');
    expect(await page.textContent('#sheet-title')).toBe('How many are you taking?');
    expect(await page.textContent('#entry')).toBe('2');
    await page.click('#sheet-ok');
    await page.waitForSelector('#banner:not([hidden])');
    expect(await page.textContent('#banner-title')).toBe('Picked');
    await page.click('#banner-ok');
    await waitHanded(page, 'l1');
    await page.waitForSelector('#sent-work .sent[data-kind="line"][data-id="l1"][data-state="handed_to_box"]');
    expect(await page.textContent('#sent-work .sent[data-id="l1"] .what')).toBe('Line · p-rice · ORD-1 — picked · 2 ea');
    expect(await page.textContent('#sent-work .sent[data-id="l1"] .pill')).toBe('With the store computer');
    await page.waitForFunction(() => ((globalThis as unknown as HandheldWindow).document.querySelector('#queue-text')?.textContent ?? '').includes('with the store computer'), undefined, { timeout: 10_000 });

    // QUALITY FAIL from the shelf: scan the bin → the item panel offers Problem → the reason. A rejected tomato is waste, not a short.
    await scan(page, 'B-04');
    await page.waitForSelector('#scan-problem:not([hidden])');
    await page.click('#scan-problem');
    await page.waitForSelector('#choices:not([hidden])');
    await page.click('#choices button:has-text("Damaged")');
    await page.waitForSelector('#banner:not([hidden])');
    expect(await page.textContent('#banner-title')).toBe('Rejected on quality');
    await page.click('#banner-ok');
    await waitHanded(page, 'l2');
    await page.waitForSelector('#sent-work .sent[data-kind="line"][data-id="l2"][data-state="handed_to_box"]');
    expect(await page.textContent('#sent-work .sent[data-id="l2"] .what')).toBe('Line · p-milk · ORD-1 — quality_failed · 0 ea');

    // PACK: every line is resolved → the temperature, then the seal. The pack rides behind its outcomes.
    expect(await page.textContent('#step')).toContain('Every line is resolved');
    await page.click('#pack');
    await page.waitForSelector('#sheet:not([hidden])');
    expect(await page.textContent('#sheet-title')).toBe('Cold-chain temperature in °C');
    await page.click('#sheet-ok');
    await page.waitForSelector('#scan:not([hidden])');
    expect(await page.textContent('#scan-title')).toBe('Scan the tamper seal');
    await scan(page, 'SEAL-01');
    await page.waitForSelector('#banner:not([hidden])');
    expect(await page.textContent('#banner-title')).toBe('Crate packed');
    expect(await page.textContent('#banner-text')).toBe('1 items on the manifest · Value ₹200.00');
    await page.click('#banner-ok');
    await waitHanded(page, 'W-1');
    await page.waitForSelector('#sent-work .sent[data-kind="pack"][data-id="W-1"][data-state="handed_to_box"]');
    expect(await page.textContent('#sent-work .sent[data-kind="pack"] .what')).toBe('Crate packed · W-1 — 1 line · 20000 INR');
    expect(await queueText(page)).toBe('3 with the store computer');

    // The BOX has all three, on its fsync'd log and queued for head office — the pick, the rejection, the pack — each naming the picker.
    expect(edge.deviceEventsOutbox.pending().map((i) => i.event.type)).toEqual(['PickLineResolved', 'PickLineResolved', 'WavePacked']);
    const records = (await readLog(edge.deviceEventsLog.path)).filter((r) => r.ok).map((r) => JSON.parse(r.ok ? r.record : '{}') as { type: string; idempotencyKey: string; payload: Record<string, unknown> });
    expect(records.map((r) => r.idempotencyKey)).toEqual(['pick:W-1:l1:picked', 'pick:W-1:l2:quality_failed', 'pack:W-1']);
    expect(records[0]?.payload).toMatchObject({ waveId: 'W-1', lineId: 'l1', orderRef: 'ORD-1', productId: 'p-rice', state: 'picked', pickedQty: 2, uom: 'ea', finalPriceMinor: 200_00, currency: 'INR', substituted: false, pickedBy: 'u-picker' });
    expect(records[1]?.payload).toMatchObject({ lineId: 'l2', productId: 'p-milk', state: 'quality_failed', pickedQty: 0, finalPriceMinor: 0, note: 'damaged', pickedBy: 'u-picker' });
    expect(records[2]?.payload).toMatchObject({ waveId: 'W-1', packedBy: 'u-picker', lineCount: 1, totalValueMinor: 200_00, currency: 'INR', temperatureC: 4, tamperSealRef: 'SEAL-01' });
    // PII stays off the handheld and off the box: an order reference, never a customer.
    expect(JSON.stringify(records)).not.toMatch(/customer|phone|address/i);
    expect(await sent(page)).toEqual([['pack', 'W-1', 'handed_to_box'], ['line', 'l2', 'handed_to_box'], ['line', 'l1', 'handed_to_box']]);

    // RELOAD: the durable device queue is the authority — all listed, all with the store computer, box unchanged.
    await page.reload({ waitUntil: 'load' });
    await ready(page);
    await page.waitForSelector('#sent-work .sent[data-id="l1"][data-state="handed_to_box"]');
    await page.waitForSelector('#sent-work .sent[data-id="l2"][data-state="handed_to_box"]');
    await page.waitForSelector('#sent-work .sent[data-kind="pack"][data-state="handed_to_box"]');
    await page.waitForFunction(() => ((globalThis as unknown as HandheldWindow).document.querySelector('#queue-text')?.textContent ?? '').includes('3 with the store computer'), undefined, { timeout: 10_000 });
    expect(await page.evaluate(() => (globalThis as unknown as HandheldWindow).pickerOutbox!.unsentCount())).toBe(0);
    expect(edge.deviceEventsOutbox.all()).toHaveLength(3);
    expect((await readLog(edge.deviceEventsLog.path)).filter((r) => r.ok)).toHaveLength(3);
  }, 60_000);
});
