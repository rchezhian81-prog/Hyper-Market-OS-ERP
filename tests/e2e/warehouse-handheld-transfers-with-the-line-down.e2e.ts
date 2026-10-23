import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { writeHeldWorkFeeds } from '../../edge/store-edge/src/work-feeds-file';
import { enrolmentCodeHash } from '../../packages/platform-admin/src/device-enrolment';
import { withTillPeople, issueTillPins } from '../support/till-operator';
import { signInOnPhonePage } from '../support/phone-sign-in-page';

/**
 * **Transfers are SENT and COUNTED IN on the warehouse handheld with the line down, in a real browser on the REAL store box
 * (OB-288 lane 2 · P2 · WF-07 · M09-FR-03 · §31 · P-01 · P-08 · hard rules #1 #10).**
 *
 * The box starts with NO cloud and with head office's transfers restored from its own disk (`work-feeds.json`). A real
 * headless Chromium at a handheld's size enrols with the one-time code, a worker signs in, and:
 *   • sees "Transfers to send" (store 1 → store 2) and "Transfers to count in" (warehouse → store 1), and when head office
 *     last said so;
 *   • SENDS one: tap → confirm → saved here and, within a moment, on the box's fsync'd device-events log as ONE
 *     `TransferDispatchRecorded` in the signed-in worker's name — no lines, stock or cost on it;
 *   • COUNTS IN the other on the keypad, one count per line (fewer than were sent — said, and head office books the shortfall):
 *     ONE `TransferReceiptRecorded` with what was counted;
 *   • a second tap on a done transfer changes nothing; a RELOAD keeps both done and listed; the box was sent nothing new.
 * Head office booking each once — and refusing a cancelled one visibly — is proven by
 * tests/integration/the-store-box-keeps-offline-work-and-books-it-once.test.ts and
 * tests/integration/a-transfer-is-cancelled-before-it-leaves-and-relayed-offline.test.ts.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['warehouse', 'transfer', 'offline', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = 't-sre';
const CODE = 'ABCDE-FGHJK-LMNPQ-RSTUV';
const HANDHELD = { viewport: { width: 360, height: 640 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const PHONE_PERSON = 'u-back';
const PACK_JSON = JSON.stringify(withTillPeople({
  version: 1,
  policies: { tradingDayCutoff: '02:00', storeId: 'S1', branchId: 'S1', branchName: 'Main', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, privacySlaDays: 15 },
  lossPreventionRules: [],
  warehouse: { assignmentId: 'A-1', workerId: 'u-back', storeId: 'S1', bins: [{ binId: 'BIN-A', storeId: 'S1', capacityMinor: 1000, pickable: true, zone: 'ambient' }] },
  devices: [{ deviceId: 'hh-01', kind: 'handheld', status: 'registered', label: 'Racking 1', enrolment: { codeHash: enrolmentCodeHash(CODE), expiresAt: '2099-01-01T00:00:00.000Z' } }],
}, [{ userId: PHONE_PERSON, permissions: ['inventory.movement.append'] }]));

const row = (transferId: string, state: string, from: string, to: string, fromStoreId: string, toStoreId: string, lines: unknown[]) =>
  ({ transfer: { transferId, state, fromLocationId: from, toLocationId: to, requestedBy: 'u-owner', lines }, fromStoreId, toStoreId });

interface HandheldWindow {
  readonly warehouseSession?: { transferWork(): { toSend: { transferId: string; doneHere: boolean }[]; toCountIn: { transferId: string; doneHere: boolean }[] }; sentWork(): { kind: string; id: string; state: string }[] };
  readonly warehouseRelay?: unknown;
  readonly laneWriteBase?: string;
  readonly location: { pathname: string };
}

describe.skipIf(!HAVE_BROWSER)('the warehouse handheld sends and counts in transfers with the line down, on the real box (OB-288 lane 2 · P2 · WF-07)', () => {
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

  const ready = (page: Page) => page.waitForFunction(
    () => (globalThis as unknown as HandheldWindow).warehouseSession !== undefined && (globalThis as unknown as HandheldWindow).laneWriteBase === '' && (globalThis as unknown as HandheldWindow).warehouseRelay !== undefined,
    undefined, { timeout: 15_000 },
  );
  const sentStates = (page: Page) => page.evaluate(() => (globalThis as unknown as HandheldWindow).warehouseSession!.sentWork().map((w) => `${w.kind}:${w.id}:${w.state}`));

  it('a send and a count-in are saved through the box in the worker\'s name with no cloud; a second tap and a reload send nothing twice', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-wh-xfer-e2e-')); dirs.push(dir);
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, PACK_JSON, 'utf8');
    await issueTillPins(dir, KEY, [PHONE_PERSON]);
    const asAt = new Date(Date.now() - 15 * 60_000).toISOString();
    await writeHeldWorkFeeds(dir, TENANT, {
      transfers: {
        receivedAt: asAt,
        feed: {
          name: 'transfers', asAt,
          body: {
            transfers: [
              row('t-out', 'approved', 'S1-BACK', 'S2', 'S1', 'S2', [{ productId: 'RICE', batchId: null, quantityMinor: 10, uom: 'EA' }]),
              row('t-in', 'in_transit', 'WH', 'S1', 'WH', 'S1', [{ productId: 'RICE', batchId: null, quantityMinor: 10, uom: 'EA' }, { productId: 'OIL', batchId: 'OIL-B7', quantityMinor: 4, uom: 'EA' }]),
              row('t-theirs', 'approved', 'S2', 'WH', 'S2', 'WH', [{ productId: 'RICE', batchId: null, quantityMinor: 1, uom: 'EA' }]),
            ],
          },
        },
      },
    });
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_DEVICE_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile,
    }, () => {}))!;
    stops.push(() => edge.stop());
    const base = `http://127.0.0.1:${edge.devices!.port}`;

    const context = await browser.newContext(HANDHELD);
    stops.push(() => context.close());
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/warehouse/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as HandheldWindow).location.pathname === '/device/enrol', undefined, { timeout: 15_000 });
    await page.fill('#deviceId', 'hh-01');
    await page.fill('#code', CODE);
    await page.click('button[type="submit"]');
    await signInOnPhonePage(page, 'warehouse', PHONE_PERSON);
    await page.waitForFunction(() => (globalThis as unknown as HandheldWindow).location.pathname === '/warehouse/', undefined, { timeout: 15_000 });
    await ready(page);

    // Only this store's own ends, with when head office said so (P-08).
    await page.waitForSelector('#xfer-send .item.transfer');
    expect(await page.textContent('#xfer-send-heading')).toBe('Transfers to send');
    expect(await page.textContent('#xfer-in-heading')).toBe('Transfers to count in');
    expect((await page.textContent('#xfer-asof')) ?? '').toContain("Head office's transfers as the store computer last heard them");
    expect(await page.locator('#xfer-send .item.transfer').count()).toBe(1);
    expect(await page.textContent('#xfer-send .item.transfer .where')).toBe('t-out');
    expect(await page.textContent('#xfer-send .item.transfer .what')).toBe('to S2 · 1 line(s)');
    // A thumb-sized row on a handheld (56 px or more).
    expect((await page.locator('#xfer-send .item.transfer').boundingBox())!.height).toBeGreaterThanOrEqual(56);

    // SEND: tap → confirm → saved and handed to the box.
    await page.click('#xfer-send .item.transfer[data-transfer="t-out"]');
    await page.waitForSelector('#confirm:not([hidden])');
    expect((await page.textContent('#confirm-title')) ?? '').toContain('Send this transfer');
    await page.click('#confirm-ok');
    await page.waitForSelector('#banner:not([hidden])');
    expect(await page.textContent('#banner-title')).toBe('Transfer sent');
    await page.click('#banner-ok');

    // COUNT IN: the keypad once per line — 8 of 10 rice, 4 of 4 oil.
    await page.click('#xfer-in .item.transfer[data-transfer="t-in"]');
    await page.waitForSelector('#qty:not([hidden])');
    expect((await page.textContent('#qty-title')) ?? '').toContain('Count in — RICE');
    await page.click('#qty-keypad button:has-text("8")');
    await page.click('#qty-ok');
    await page.waitForFunction(() => ((globalThis as unknown as { document: { getElementById(id: string): { textContent: string | null } | null } }).document.getElementById('qty-title')?.textContent ?? '').includes('OIL'), undefined, { timeout: 5_000 });
    await page.click('#qty-keypad button:has-text("4")');
    await page.click('#qty-ok');
    await page.waitForSelector('#banner:not([hidden])');
    expect(await page.textContent('#banner-title')).toBe('Transfer counted in');
    expect((await page.textContent('#banner-text')) ?? '').toContain('2 fewer than were sent');
    await page.click('#banner-ok');

    // Both with the store computer, in the worker's name, on its own disk.
    await page.waitForFunction(() => (globalThis as unknown as HandheldWindow).warehouseSession!.sentWork().filter((w) => w.state === 'handed_to_box').length === 2, undefined, { timeout: 20_000 });
    const records = (await readLog(edge.deviceEventsLog.path)).filter((r) => r.ok).map((r) => JSON.parse(r.ok ? r.record : '{}') as { type: string; payload: Record<string, unknown> });
    expect(records.map((r) => r.type)).toEqual(['TransferDispatchRecorded', 'TransferReceiptRecorded']);
    expect(records[0]?.payload).toMatchObject({ transferId: 't-out', storeId: 'S1', dispatchedBy: PHONE_PERSON, source: 'warehouse-handheld' });
    expect(Object.keys(records[0]!.payload).sort()).toEqual(['at', 'dispatchedBy', 'source', 'storeId', 'transferId']);
    expect(records[1]?.payload).toMatchObject({ transferId: 't-in', storeId: 'S1', receivedBy: PHONE_PERSON, counted: [{ productId: 'RICE', batchId: null, quantityMinor: 8 }, { productId: 'OIL', batchId: 'OIL-B7', quantityMinor: 4 }] });
    expect((await page.textContent('#sent-work')) ?? '').toContain('Transfer sent');

    // A done transfer cannot be tapped again; a reload keeps both done; nothing more reaches the box.
    expect(await page.isDisabled('#xfer-send .item.transfer[data-transfer="t-out"]')).toBe(true);
    await page.reload({ waitUntil: 'load' });
    await ready(page);
    expect(await page.evaluate(() => { const w = (globalThis as unknown as HandheldWindow).warehouseSession!.transferWork(); return [...w.toSend, ...w.toCountIn].map((r) => r.doneHere); })).toEqual([true, true]);
    expect((await sentStates(page)).sort()).toEqual(['transfer_in:t-in:handed_to_box', 'transfer_out:t-out:handed_to_box']);
    await page.waitForTimeout(500);
    expect(edge.deviceEventsOutbox.all()).toHaveLength(2);

    // Tamil: the section speaks Tamil.
    await page.click('#lang');
    expect((await page.textContent('#xfer-send-heading')) ?? '').toContain('அனுப்ப வேண்டிய மாற்றல்கள்');
    expect(errors).toEqual([]);
  });
});
