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
import { deviceBase as boxDoor, sharedDeviceTls, trustingBrowserArgs } from '../support/box-tls';
import { pathFor } from '../../edge/sync-agent/src/http-transport';

/**
 * **W5 · M09-FR-03 — the back store counts a floor RETURN in on the warehouse handheld, with the line down, on the REAL box.**
 * The box holds head office's open indents (as `pullIndentsFeed` lays them in); one carries a return the floor sent back on
 * the Indents page. The handheld lists it under "Returns from the floor to count in"; the worker taps it, counts the line on
 * the keypad (one fewer than the floor sent — said: head office books the shortfall) and it is ONE `FloorIndentReturnAccepted`
 * on the box's fsync'd device log in the signed-in worker's name, queued for head office's synced route — a second tap and a
 * reload send nothing twice. (Head office's half — the acceptor re-verified, the stock moved once, the returner refused — is
 * proven in tests/integration/w5-a-floor-return-is-counted-in-on-the-warehouse-handheld.test.ts.) Synthetic data; no cloud.
 */

let deviceTls: Awaited<ReturnType<typeof sharedDeviceTls>>;
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['w5', 'floor', 'return', 'signing', 'key'].join('-').padEnd(48, '0');
const CODE = 'ABCDE-FGHJK-LMNPQ-RSTUV';
const PHONE_PERSON = 'u-back';
const line = (productId: string) => ({ productId, uom: 'EA', requestedMinor: 10, allocatedMinor: 10, issuedMinor: 10, receivedMinor: 10, inTransitMinor: 0, shortfallMinor: 0, damagedMinor: 0, returnedMinor: 0, outstandingMinor: 0 });
const PACK_JSON = JSON.stringify(withTillPeople({
  version: 1,
  policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1', branchName: 'Main', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'S1-BACK' },
  lossPreventionRules: [],
  warehouse: { assignmentId: 'A-1', workerId: 'u-back', storeId: 'store-1', bins: [{ binId: 'BIN-A', storeId: 'store-1', capacityMinor: 1000, pickable: true }] },
  floorIndents: {
    asAt: '2026-11-03T05:00:00.000Z',
    indents: [{
      indentId: 'ind-7', state: 'received', fromLocationId: 'S1-BACK', toLocationId: 'store-1', requestedBy: 'u-floor', issues: [], attention: ['return_awaiting_back_store'],
      returns: [{ returnId: 'ret-1', transferId: 'tr-ret-1', returnedBy: 'u-floor', requestedAt: '2026-11-03T04:50:00.000Z', reason: 'overstock', state: 'requested', lines: [{ productId: 'RICE', batchId: null, quantityMinor: 6 }] }],
      totals: { lines: [line('RICE')] },
    }],
  },
  devices: [{ deviceId: 'hh-01', kind: 'handheld', status: 'registered', label: 'Racking 1', enrolment: { codeHash: enrolmentCodeHash(CODE), expiresAt: '2099-01-01T00:00:00.000Z' } }],
}, [{ userId: PHONE_PERSON, permissions: ['inventory.movement.append'] }]));

interface HandheldWindow {
  readonly laneWriteBase?: string;
  readonly warehouseSession?: { sentWork(): { kind: string; id: string; state: string }[]; floorReturns(): { returnId: string; doneHere: boolean }[] };
  readonly warehouseRelay?: unknown;
  readonly warehouseOutbox?: { unsentCount(): number };
  readonly location: { pathname: string };
}

describe.skipIf(!HAVE_BROWSER)('the warehouse handheld counts in a floor return on the real box (W5 · M09-FR-03)', () => {
  let browser: Browser;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'warehouse-app'], { stdio: 'ignore' });
    deviceTls = await sharedDeviceTls();
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM, args: trustingBrowserArgs(deviceTls.keyPin) });
  }, 180_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function box(): Promise<EdgeProcess> {
    const dir = await mkdtemp(join(tmpdir(), 'sre-w5-return-e2e-'));
    dirs.push(dir);
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, PACK_JSON, 'utf8');
    await issueTillPins(dir, KEY, [PHONE_PERSON]);
    const edge = (await startEdge({
      EDGE_DEVICE_TLS_DIR: deviceTls.dir, EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_DEVICE_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile,
    }, () => {}))!;
    stops.push(() => edge.stop());
    return edge;
  }
  const ready = (page: Page) => page.waitForFunction(
    () => (globalThis as unknown as HandheldWindow).warehouseSession !== undefined && (globalThis as unknown as HandheldWindow).laneWriteBase === '' && (globalThis as unknown as HandheldWindow).warehouseRelay !== undefined,
    undefined, { timeout: 15_000 },
  );

  it('lists the waiting return, counts it in on the keypad, and hands ONE record to the box in the worker\'s name', async () => {
    const edge = await box();
    const context = await browser.newContext({ viewport: { width: 360, height: 640 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    stops.push(() => context.close());
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${boxDoor(edge)}/warehouse/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as HandheldWindow).location.pathname === '/device/enrol', undefined, { timeout: 15_000 });
    await page.fill('#deviceId', 'hh-01');
    await page.fill('#code', CODE);
    await page.click('button[type="submit"]');
    await signInOnPhonePage(page, 'warehouse', PHONE_PERSON);
    await page.waitForFunction(() => (globalThis as unknown as HandheldWindow).location.pathname === '/warehouse/', undefined, { timeout: 15_000 });
    await ready(page);

    await page.waitForSelector('#ret-in .item.return[data-return="ret-1"]');
    expect(await page.textContent('#ret-in-heading')).toContain('Returns from the floor to count in');
    expect(await page.textContent('#ret-in .item.return .where')).toBe('ind-7');
    expect(await page.textContent('#ret-in .item.return .what')).toBe('RICE · sent back by u-floor · why: overstock');

    await page.click('#ret-in .item.return[data-return="ret-1"]');
    await page.waitForSelector('#qty:not([hidden])');
    expect((await page.textContent('#qty-title')) ?? '').toContain('Count in — RICE');
    await page.click('#qty-keypad button:has-text("5")');
    await page.click('#qty-ok');
    await page.waitForSelector('#banner:not([hidden])');
    expect(await page.textContent('#banner-title')).toBe('Return counted in');
    expect(await page.textContent('#banner-text')).toContain('1 fewer than the floor sent; head office books the shortfall');
    await page.click('#banner-ok');

    await page.waitForFunction(() => (globalThis as unknown as HandheldWindow).warehouseSession!.sentWork().find((x) => x.kind === 'return_in')?.state === 'handed_to_box', undefined, { timeout: 10_000 });
    expect(await page.textContent('#sent-work')).toContain('Floor return counted in');
    expect(edge.deviceEventsOutbox.pending().map((i) => i.event.type)).toEqual(['FloorIndentReturnAccepted']);
    const pending = edge.deviceEventsOutbox.pending()[0]!.event;
    expect(pathFor(pending)).toBe('/v1/floor/indents/ind-7/returns/ret-1/accepted/synced');
    const records = (await readLog(edge.deviceEventsLog.path)).filter((r) => r.ok).map((r) => JSON.parse(r.ok ? r.record : '{}') as { type: string; payload: Record<string, unknown> });
    expect(records).toHaveLength(1);
    expect(records[0]?.payload).toMatchObject({ indentId: 'ind-7', returnId: 'ret-1', acceptedBy: PHONE_PERSON, counted: [{ productId: 'RICE', batchId: null, quantityMinor: 5 }], source: 'warehouse-handheld' });

    // A second tap changes nothing; a reload keeps it counted and sends nothing twice.
    expect(await page.isDisabled('#ret-in .item.return[data-return="ret-1"]')).toBe(true);
    await page.reload({ waitUntil: 'load' });
    await ready(page);
    await page.waitForSelector('#ret-in .item.return[data-return="ret-1"] .flag.done');
    expect(await page.evaluate(() => (globalThis as unknown as HandheldWindow).warehouseSession!.floorReturns().map((r) => [r.returnId, r.doneHere]))).toEqual([['ret-1', true]]);
    expect(edge.deviceEventsOutbox.pending()).toHaveLength(1);
    expect(errors).toEqual([]);
  });
});
