import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync, mkdirSync } from 'node:fs';
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
import { auditPage } from './lib/a11y-audit';
import { deviceBase as boxDoor, sharedDeviceTls, trustingBrowserArgs } from '../support/box-tls';

let deviceTls: Awaited<ReturnType<typeof sharedDeviceTls>>;

/**
 * **OB-172 "A" (owner, 17 Oct 2026, "Checklist on handheld") in a real browser, against a REAL store computer with NO cloud.**
 *
 * The box holds head office's store setup with the D-6 receiving checklist (temperature taken, packaging intact) and the
 * product master's cold-chain goods. A real headless Chromium:
 *
 *   • the MANAGER's store screen (behind the signed-in front, which names the manager on every request): a paneer line
 *     brings up the receiving checklist; saving without every check ticked is refused in words; a failed check needs what
 *     was done; then the delivery is saved and the box has it on its disk — the checklist INSIDE the receipt, sealed for the
 *     manager. A dry-goods delivery shows no checklist;
 *   • the warehouse HANDHELD (enrolled, the worker signed in with their own PIN): "Delivery complete" on a frozen delivery
 *     opens the checklist sheet; Cancel sends nothing; a Fail needs a tapped corrective action before Send is possible; the
 *     completion lands on the box sealed for the worker, on the phone's lane, with the checklist inside.
 *
 * Head office booking these as complete is proven by tests/integration/ob172-*.test.ts. Screenshots for the owner are
 * written only when SRE_SHOTS names a directory. Skips where no browser binary is present. Synthetic data only.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const SHOTS = process.env['SRE_SHOTS'];
const KEY = ['ob172', 'dock', 'checklist', 'key'].join('-').padEnd(48, '0');
const TENANT = 't-sre';
const CODE = 'ABCDE-FGHJK-LMNPQ-RSTUV';
const HANDHELD = { viewport: { width: 360, height: 640 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

/** What head office's store setup carries for the dock (services/api/src/r2-ops-adapters.ts `receivingChecklistSectionFor`). */
const RECEIVING = {
  checks: [{ checkId: 'dock-receiving', branchId: 'store-1', title: 'Chilled and frozen delivery', kind: 'receiving', graceMinutes: 0, active: true,
    assignedRole: 'store_manager', escalatesTo: 'u-owner', items: [{ itemId: 'temp', label: 'Temperature taken' }, { itemId: 'pack', label: 'Packaging intact' }] }],
  coldChainProductIds: ['p-icecream', 'p-paneer'],
};
const PACK = (extra: Record<string, unknown>) => JSON.stringify(withTillPeople({
  version: 1,
  policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1', branchName: 'Main', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'wh-1' },
  managerPolicy: { userId: 'u-mgr', approvalLimitMinor: 500_000 },
  lossPreventionRules: [],
  receivingChecklist: RECEIVING,
  ...extra,
}, [{ userId: 'u-worker', permissions: ['inventory.movement.append'] }, { userId: 'u-mgr', permissions: ['till.dayclose.read'] }])); // SEC-1: the manager holds the Today screen's word

interface Win {
  readonly managerSession?: { savedWork(): { kind: string; state: string }[] };
  readonly warehouseSession?: { sentWork(): { kind: string; state: string }[] };
  readonly laneWriteBase?: string;
  readonly warehouseRelay?: unknown;
  readonly document: { querySelector(s: string): { hidden: boolean } | null };
  readonly location: { pathname: string };
}
type Logged = { type: string; payload: Record<string, unknown> };

describe.skipIf(!HAVE_BROWSER)('OB-172: the receiving checklist on the store screen and the handheld, offline, inside the sealed receipt', () => {
  let browser: Browser;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    execFileSync('node', ['scripts/build-app.mjs', 'warehouse-app'], { stdio: 'ignore' });
    deviceTls = await sharedDeviceTls(); // OB-422: the store computer's authority, trusted as an enrolled handheld trusts it
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM, args: trustingBrowserArgs(deviceTls.keyPin) });
  }, 240_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function box(extra: Record<string, unknown> = {}): Promise<EdgeProcess> {
    const dir = await mkdtemp(join(tmpdir(), 'sre-ob172-e2e-'));
    dirs.push(dir);
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, PACK(extra), 'utf8');
    await issueTillPins(dir, KEY, ['u-worker']);
    // No CLOUD_API_URL: the store is offline from head office the whole time (P-01).
    const edge = (await startEdge({
      EDGE_DEVICE_TLS_DIR: deviceTls.dir,
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0', EDGE_DEVICE_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile,
      // The hosted copy (ADR-0020 §6 · OB-16): the front's sign-in names the person on every request; the box seals for them.
      EDGE_LANE_ID: 'lane-1', EDGE_LANE_TRUST_FORWARDED_USER: '1', EDGE_SCREEN_TRUST_FORWARDED_USER: '1',
    }, () => {}))!;
    stops.push(() => edge.stop());
    return edge;
  }
  const logged = async (edge: EdgeProcess): Promise<Logged[]> =>
    (await readLog(edge.deviceEventsLog.path)).filter((r) => r.ok).map((r) => JSON.parse(r.ok ? r.record : '{}') as Logged);
  const bannerUp = (page: Page) => page.waitForFunction(() => !((globalThis as unknown as Win).document.querySelector('#banner') as { hidden: boolean }).hidden);
  const shot = async (page: Page, name: string): Promise<void> => {
    if (SHOTS === undefined) return;
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
  };

  it('the manager\'s store screen: a chilled line brings up the checklist; it is refused until complete; saved, it is on the box inside the receipt, sealed for the manager', async () => {
    const edge = await box();
    const context = await browser.newContext();
    stops.push(() => context.close());
    const page = await context.newPage();
    // What the signed-in front does: it names the manager on every request (the screen page and the box's lane).
    await page.route(`http://127.0.0.1:${edge.screens!.port}/**`, (route) => route.continue({ headers: { ...route.request().headers(), 'x-sre-user': 'u-mgr' } }));
    await page.route(`http://127.0.0.1:${edge.lane!.port}/lane/**`, (route) => route.continue({ headers: { ...route.request().headers(), 'x-sre-user': 'u-mgr' } }));
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/manager`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as Win).managerSession !== undefined && typeof (globalThis as unknown as Win).laneWriteBase === 'string', undefined, { timeout: 15_000 });
    await page.click('#tab-receive');

    // Dry goods: no checklist is asked for.
    await page.fill('#grn-number', 'DN-DRY');
    await page.fill('#grn-product', 'p-dal');
    await page.fill('#grn-qty', '5');
    await page.click('#add-line');
    expect(await page.isHidden('#receive-checklist')).toBe(true);
    await page.click('#receive-lines button'); // take the dal off again

    // A chilled line: the checklist appears, with head office's own checks.
    await page.fill('#grn-number', 'DN-COLD');
    await page.fill('#grn-product', 'p-paneer');
    await page.fill('#grn-qty', '10');
    await page.fill('#grn-temp', '3');
    await page.click('#add-line');
    await page.waitForSelector('#receive-checklist:not([hidden])');
    expect(await page.textContent('#receive-checklist-items')).toContain('Temperature taken');
    expect(await page.textContent('#receive-checklist-items')).toContain('Packaging intact');
    expect(await page.textContent('#receive-checklist-why')).toContain('p-paneer');

    // Saved without the checks: refused in words, nothing saved.
    await page.click('#save-receipt');
    await bannerUp(page);
    expect(await page.textContent('#banner-text')).toContain('Do the receiving checklist first');
    await page.click('#banner-ok');
    // A failed check needs what was done.
    await page.check('input[name="rc-temp"][value="fail"]');
    await page.check('input[name="rc-pack"][value="pass"]');
    await page.waitForSelector('#receive-checklist-action-field:not([hidden])');
    expect(await auditPage(page, { expectLang: 'en' }), 'the receive form with the checklist').toEqual([]);
    await shot(page, 'manager-receiving-checklist');
    await page.click('#save-receipt');
    await bannerUp(page);
    expect(await page.textContent('#banner-text')).toContain('Write what was done about it');
    await page.click('#banner-ok');
    expect(await logged(edge)).toEqual([]);

    await page.fill('#receive-checklist-action', 'Two packs warm — refused and sent back with the driver');
    await page.click('#save-receipt');
    await bannerUp(page);
    expect(await page.textContent('#banner-title')).toBe('Delivery saved');
    expect(await page.textContent('#banner-text')).toContain('Receiving checklist saved with the delivery');
    await page.click('#banner-ok');
    await page.waitForFunction(() => (globalThis as unknown as Win).managerSession!.savedWork().find((w) => w.kind === 'receipt')?.state === 'handed_to_box', undefined, { timeout: 10_000 });

    const [receipt] = await logged(edge);
    expect(receipt?.type).toBe('GoodsReceived');
    expect(receipt?.payload).toMatchObject({
      number: 'DN-COLD', receivedBy: 'u-mgr', lines: [{ productId: 'p-paneer', quantityMinor: 10, temperatureC: 3 }],
      receivingChecklist: { checkId: 'dock-receiving', performedBy: 'u-mgr', itemResults: { temp: 'fail', pack: 'pass' }, readingTenthsC: 30, correctiveAction: 'Two packs warm — refused and sent back with the driver' },
      deciderVerified: { userId: 'u-mgr', via: 'verified_sign_in', laneId: 'lane-1' },
    });
    expect(await page.isHidden('#receive-checklist')).toBe(true); // the form is clear for the next delivery
  });

  it('the handheld: "Delivery complete" on a frozen delivery opens the checklist; Cancel sends nothing; a Fail needs a tapped action; sent, it is on the box sealed for the worker', async () => {
    const edge = await box({
      warehouse: {
        assignmentId: 'A-1', workerId: 'u-worker', storeId: 'store-1', grnId: 'grn-ice', poId: 'po-1',
        bins: [{ binId: 'BIN-F', storeId: 'store-1', capacityMinor: 1000, pickable: true, zone: 'frozen' }],
        ordered: [{ productId: 'p-icecream', quantityMinor: 20, unitCostMinor: 15_000, currency: 'INR' }],
        barcodes: [{ barcode: '890ICE', productId: 'p-icecream', level: 'unit' }],
      },
      devices: [{ deviceId: 'hh-01', kind: 'handheld', status: 'registered', label: 'Dock 1', enrolment: { codeHash: enrolmentCodeHash(CODE), expiresAt: '2099-01-01T00:00:00.000Z' } }],
    });
    const context = await browser.newContext(HANDHELD);
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`${boxDoor(edge)}/warehouse/`, { waitUntil: 'load' });
    await page.fill('#deviceId', 'hh-01');
    await page.fill('#code', CODE);
    await page.click('button[type="submit"]');
    await signInOnPhonePage(page, 'warehouse', 'u-worker');
    await page.waitForFunction(() => (globalThis as unknown as Win).warehouseSession !== undefined && (globalThis as unknown as Win).warehouseRelay !== undefined, undefined, { timeout: 15_000 });

    // Receive one scan of ice cream (a shop scanner is a keyboard: type, then Enter).
    await page.click('#receive');
    await page.waitForSelector('#scan:not([hidden])');
    await page.keyboard.type('890ICE');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#banner:not([hidden])');
    expect(await page.textContent('#banner-title')).toBe('Received');
    await page.click('#banner-ok');

    // Delivery complete → the checklist sheet. Cancel: nothing sent, the delivery stays open.
    await page.waitForSelector('#done-receiving:not([hidden])');
    await page.click('#done-receiving');
    await page.waitForSelector('#checklist:not([hidden])');
    expect(await page.textContent('#checklist-items')).toContain('Temperature taken');
    expect(await page.isDisabled('#checklist-ok')).toBe(true);
    await page.click('#checklist-cancel');
    expect(await page.isHidden('#checklist')).toBe(true);
    expect((await logged(edge)).map((e) => e.type)).not.toContain('ReceivingCompleted');

    // Again: a Fail needs what was done — Send stays off until an action is tapped.
    await page.click('#done-receiving');
    await page.waitForSelector('#checklist:not([hidden])');
    await page.click('#checklist-items button[data-item="temp"][data-result="pass"]');
    await page.click('#checklist-items button[data-item="pack"][data-result="fail"]');
    await page.waitForSelector('#checklist-actions:not([hidden])');
    expect(await page.isDisabled('#checklist-ok')).toBe(true);
    await page.click('#checklist-actions button[data-action="actionHeld"]');
    expect(await page.isDisabled('#checklist-ok')).toBe(false);
    expect(await auditPage(page, { expectLang: 'en' }), 'the handheld checklist sheet').toEqual([]);
    await shot(page, 'handheld-receiving-checklist');
    await page.click('#checklist-ok');
    await page.waitForSelector('#banner:not([hidden])');
    expect(await page.textContent('#banner-title')).toBe('Receipt sent — head office will match the delivery to the order');
    await page.click('#banner-ok');
    await page.waitForFunction(() => (globalThis as unknown as Win).warehouseSession!.sentWork().find((w) => w.kind === 'receipt_done')?.state === 'handed_to_box', undefined, { timeout: 10_000 });

    const done = (await logged(edge)).find((e) => e.type === 'ReceivingCompleted');
    expect(done?.payload).toMatchObject({
      grnId: 'grn-ice', completedBy: 'u-worker',
      receivingChecklist: { checkId: 'dock-receiving', performedBy: 'u-worker', itemResults: { temp: 'pass', pack: 'fail' }, correctiveAction: 'Held aside for the manager to check' },
      deciderVerified: { userId: 'u-worker', via: 'phone_pin' },
    });
  });
});
