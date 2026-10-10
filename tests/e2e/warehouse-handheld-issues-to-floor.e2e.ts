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
 * **The back store ISSUES against a floor indent on the warehouse handheld, in a real browser on the real box (SP-8c · F08 ·
 * WF-06 · M09-FR-03 · §28 · §31 · P-01 · hard rules #1/#2/#4/#6/#10).**
 *
 * The audit's F08 remainder: no handheld could issue the stock the floor asked for against the ask. Everything below the
 * browser is production: the real `startEdge` opens its DEVICE socket, serves the real warehouse shell with the assignment
 * injected — the floor indents the box holds for the back store derived from head office's register (`floorIndents`, the
 * section `pullIndentsFeed` lays in) — and stands its device-events pipeline behind `/lane/outbox`. A REAL headless Chromium
 * at a handheld's size enrols with the one-time code, then:
 *
 *   • sees "To issue to the floor": the indent, the item, who asked, what is still owed, and the bins here that hold it;
 *   • taps the line → scans a bin holding the product → scans the item → confirms the quantity (≤3 after the tap): the issue
 *     is saved on this handheld, within a moment WITH the store computer — on its fsync'd device-events log and in its queue
 *     for head office, as ONE `FloorIndentIssued` naming the indent, the bin and the issuer; the handheld's own bin
 *     projection fell by what went; the line shows the remainder still owed;
 *   • is refused at the racking for a bin holding none of the product, and for the item the floor did not ask for — before
 *     anything is confirmed, with nothing queued;
 *   • RELOADS: the issue is still listed with its state; the box was sent nothing new.
 *
 * No cloud is configured: the box holds the work durably and carries it up when one is (P-01). Head office delivery —
 * the transfer dispatched once, the bin lowered in the same write, lost reply / duplicate / refusal — is proven by
 * `tests/integration/floor-indents-handheld-issue.test.ts`. Where no Chromium is present the suite SKIPS. No physical device: PENDING.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['warehouse', 'issue', 'indent', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = 't-sre';
const CODE = 'ABCDE-FGHJK-LMNPQ-RSTUV';
const HANDHELD = { viewport: { width: 360, height: 640 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const AS_AT = '2026-10-01T09:00:00.000Z';

const line = (productId: string, outstandingMinor: number) => ({ productId, uom: 'EA', requestedMinor: outstandingMinor, allocatedMinor: outstandingMinor, issuedMinor: 0, receivedMinor: 0, inTransitMinor: 0, shortfallMinor: 0, damagedMinor: 0, returnedMinor: 0, outstandingMinor });
/** The box's pack: the back store's bins and what they hold, the worker, and — as `pullIndentsFeed` would lay it in — head office's open indents. */
// DF-3-c (OB-28 "A"): the person who signs in on the phone, with the job's permission head office re-checks.
const PHONE_PERSON = 'u-back';
const PACK_JSON = JSON.stringify(withTillPeople({
  version: 1,
  policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1', branchName: 'Main', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, privacySlaDays: 30, warehouseId: 'S1-BACK' },
  lossPreventionRules: [],
  warehouse: {
    assignmentId: 'A-1', workerId: 'u-back', storeId: 'store-1',
    bins: [
      { binId: 'BIN-A', storeId: 'store-1', capacityMinor: 1000, pickable: true, zone: 'ambient' },
      { binId: 'BIN-C', storeId: 'store-1', capacityMinor: 1000, pickable: true, zone: 'ambient' },
    ],
    barcodes: [{ barcode: '890RICE', productId: 'RICE', level: 'unit' }, { barcode: '890OIL', productId: 'OIL', level: 'unit' }],
    contents: { 'BIN-A|RICE|': 30, 'BIN-C|OIL|': 4 },
  },
  floorIndents: {
    asAt: AS_AT,
    indents: [
      { indentId: 'ind-1', state: 'approved', fromLocationId: 'S1-BACK', toLocationId: 'store-1', requestedBy: 'u-floor', requestedAt: '2026-10-01T08:00:00.000Z', flags: [], attention: ['owed_by_back_store'], needsAttention: true, issues: [], totals: { lines: [line('RICE', 12)] } },
      { indentId: 'ind-2', state: 'requested', fromLocationId: 'S1-BACK', toLocationId: 'store-1', requestedBy: 'u-floor', totals: { lines: [line('OIL', 0)] } },
    ],
  },
  devices: [{ deviceId: 'hh-01', kind: 'handheld', status: 'registered', label: 'Racking 1', enrolment: { codeHash: enrolmentCodeHash(CODE), expiresAt: '2099-01-01T00:00:00.000Z' } }],
}, [{ userId: PHONE_PERSON, permissions: ['inventory.movement.append'] }]));

interface HandheldWindow {
  readonly laneWriteBase?: string;
  readonly warehouseSession?: { sentWork(): { kind: string; id: string; state: string }[]; indentLines(): { indentId: string; productId: string; remainingMinor: number; binIds: string[] }[]; binContents(): Record<string, number> };
  readonly warehouseRelay?: unknown;
  readonly warehouseOutbox?: { unsentCount(): number; all(): unknown[] };
  readonly document: { querySelector(selector: string): { hidden: boolean; textContent: string | null } | null; querySelectorAll(selector: string): { length: number } };
  readonly location: { pathname: string };
}

describe.skipIf(!HAVE_BROWSER)('the warehouse handheld issues against a floor indent and the issue reaches the box (SP-8c · F08)', () => {
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
    const dir = await mkdtemp(join(tmpdir(), 'sre-wh-issue-e2e-'));
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

  /** Enrol the handheld with head office's one-time code and open the shell as the named worker. */
  async function openEnrolled(base: string): Promise<Page> {
    const context = await browser.newContext(HANDHELD);
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`${base}/warehouse/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as HandheldWindow).location.pathname === '/device/enrol', undefined, { timeout: 15_000 });
    await page.fill('#deviceId', 'hh-01');
    await page.fill('#code', CODE);
    await page.click('button[type="submit"]');
    await signInOnPhonePage(page, 'warehouse', PHONE_PERSON);
    await page.waitForFunction(() => (globalThis as unknown as HandheldWindow).location.pathname === '/warehouse/', undefined, { timeout: 15_000 });
    await ready(page);
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

  it('the handheld lists what the back store owes; tap → scan bin → scan item → confirm issues it, on the box within a moment, the bin projection lowered; a wrong bin and a wrong item are refused at the racking; a reload keeps the issue', async () => {
    const { edge, base } = await box();
    const page = await openEnrolled(base);

    // The issue list comes from head office's register as the box holds it: ind-1 RICE 12 owed (ind-2 is not approved → not listed).
    await page.waitForSelector('#issue-lines .item.issue');
    expect(await page.evaluate(() => (globalThis as unknown as HandheldWindow).warehouseSession!.indentLines().map((l) => [l.indentId, l.productId, l.remainingMinor, l.binIds]))).toEqual([['ind-1', 'RICE', 12, ['BIN-A']]]);
    expect(await page.textContent('#issue-heading')).toBe('To issue to the floor');
    expect(await page.textContent('#issue-lines .item.issue .where')).toBe('BIN-A');
    expect(await page.textContent('#issue-lines .item.issue .what')).toBe('ind-1 · RICE · asked by u-floor');
    expect(await page.textContent('#issue-lines .item.issue .qty')).toBe('12 units · EA · still owed');
    expect(await page.isHidden('#issue')).toBe(false);

    // A bin holding none of the product is refused at the racking — nothing confirmed, nothing queued.
    await page.click('#issue-lines .item.issue');
    await page.click('#issue');
    await scan(page, 'BIN-C');
    await page.waitForSelector('#banner:not([hidden])');
    expect(await page.textContent('#banner-title')).toBe('This bin holds none of that item — scan the bin the stock is in');
    await page.click('#banner-ok');
    expect(await page.evaluate(() => (globalThis as unknown as HandheldWindow).warehouseOutbox!.unsentCount())).toBe(0);

    // The wrong item at the shelf is refused too.
    await page.click('#issue-lines .item.issue');
    await page.click('#issue');
    await scan(page, 'BIN-A');
    await scan(page, '890OIL');
    await page.waitForSelector('#banner:not([hidden])');
    expect(await page.textContent('#banner-title')).toContain('not the item');
    await page.click('#banner-ok');
    expect(await page.evaluate(() => (globalThis as unknown as HandheldWindow).warehouseOutbox!.unsentCount())).toBe(0);
    expect(await page.evaluate(() => (globalThis as unknown as HandheldWindow).warehouseSession!.binContents()['BIN-A|RICE|'])).toBe(30);

    // The real thing: tap the line → scan BIN-A → scan the item → confirm the 12 still owed.
    await page.click('#issue-lines .item.issue');
    await page.click('#issue');
    expect(await page.textContent('#step')).toContain('Scan the bin you are taking it from');
    await scan(page, 'BIN-A');
    await scan(page, '890RICE');
    await page.waitForSelector('#confirm:not([hidden])');
    expect(await page.textContent('#confirm-title')).toBe('Confirm the issue — ind-1');
    expect(await page.textContent('#confirm-qty')).toBe('12 units · EA');
    expect(await page.textContent('#confirm-hint')).toBe('RICE · from bin BIN-A · asked by u-floor');
    await page.click('#confirm-ok');
    await page.waitForSelector('#banner:not([hidden])');
    expect(await page.textContent('#banner-title')).toBe('Issued to the floor');
    expect(await page.textContent('#banner-text')).toBe('12 EA of RICE issued to the floor for ind-1 from BIN-A');
    await page.click('#banner-ok');

    // Saved on this handheld; within a moment WITH the store computer — on its fsync'd log and queued for head office as ONE fact.
    await page.waitForFunction(() => (globalThis as unknown as HandheldWindow).warehouseSession!.sentWork().find((x) => x.kind === 'issue')?.state === 'handed_to_box', undefined, { timeout: 10_000 });
    await page.waitForSelector('#sent-work .sent[data-kind="issue"][data-state="handed_to_box"]');
    expect(await page.textContent('#sent-work .sent[data-kind="issue"] .what')).toContain('Issued to the floor · RICE · BIN-A');
    expect(await page.textContent('#sent-work')).toContain('With the store computer');
    expect(edge.deviceEventsOutbox.pending().map((i) => i.event.type)).toEqual(['FloorIndentIssued']);
    const records = (await readLog(edge.deviceEventsLog.path)).filter((r) => r.ok).map((r) => JSON.parse(r.ok ? r.record : '{}') as { type: string; payload: Record<string, unknown> });
    expect(records).toHaveLength(1);
    expect(records[0]?.payload).toMatchObject({ indentId: 'ind-1', issuedBy: 'u-back', storeId: 'store-1', source: 'warehouse-handheld', lines: [{ productId: 'RICE', batchId: null, quantityMinor: 12, binId: 'BIN-A', uom: 'EA' }] });
    // The line is fully issued and gone; the handheld's own bin projection fell by what went.
    expect(await page.locator('#issue-lines .item.issue').count()).toBe(0);
    expect(await page.isHidden('#issue')).toBe(true);
    expect(await page.evaluate(() => (globalThis as unknown as HandheldWindow).warehouseSession!.binContents()['BIN-A|RICE|'])).toBe(18);

    // RELOAD: the durable device queue is the authority — the issue is still listed, the box was sent nothing new.
    await page.reload({ waitUntil: 'load' });
    await ready(page);
    await page.waitForSelector('#sent-work .sent[data-kind="issue"][data-state="handed_to_box"]');
    expect(await page.evaluate(() => (globalThis as unknown as HandheldWindow).warehouseOutbox!.unsentCount())).toBe(0);
    expect(edge.deviceEventsOutbox.all()).toHaveLength(1);
    expect((await readLog(edge.deviceEventsLog.path)).filter((r) => r.ok)).toHaveLength(1);
  }, 60_000);
});
