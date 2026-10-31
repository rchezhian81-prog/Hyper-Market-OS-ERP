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
import { withTillPeople } from '../support/till-operator';

/**
 * **OB-288 LP/workforce package — on the REAL store box with NO cloud, in a real browser (§31 · P-01):**
 *   • the Help page (M25-FR-04 "help works offline"): the cashier sees the procedures for their role from the library the
 *     box holds (and when it heard it) — never the owner's — with the emergency contacts, and acknowledges one; the
 *     acknowledgement reaches the box's fsync'd device-events log in their name; a reload sends nothing twice;
 *   • the Facilities page (M26-FR-02 "readings cache/queue"): a manager types the probe's temperature for the cold room —
 *     a word is refused, nothing saved — and the reading reaches the box in their name, timed when taken;
 *   • the Record-a-loss page (M28-FR-01 "queued"): a loss saved with the kind and the reason chosen from the closed lists.
 * Head office re-checking each person and booking it is proven by
 * tests/integration/the-store-computer-carries-readings-losses-and-acknowledgements.test.ts. Skips without a browser.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['lpw', 'line', 'down', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = 't-sre';

interface Win {
  readonly help?: { session: { queue?: { items(): { state: string }[] } } };
  readonly equipmentReadingQueue?: { queue: { items(): { state: string }[] } };
  readonly writeOffQueue?: { queue: { items(): { state: string }[] } };
}
type Logged = { type: string; payload: Record<string, unknown> };

const PACK = JSON.stringify(withTillPeople({
  version: 1, lossPreventionRules: [],
  policies: { tradingDayCutoff: '02:00', storeId: 'S1', branchId: 'S1' },
  facilitiesPolicy: { permissions: [] },
  writeOffCapturePolicy: { permissions: [], materialThresholdMinor: 50_000 },
}, [
  { userId: 'u-cash', till: false, pin: false, permissions: ['workforce.help.read', 'workforce.sop.ack.self'] },
  { userId: 'u-mgr', till: false, pin: false, permissions: ['workforce.help.read', 'workforce.sop.ack.self', 'facilities.overdue.read', 'facilities.reading.record', 'inventory.movement.append', 'waste.view'] },
]));

async function heldFeeds(dir: string): Promise<void> {
  const asAt = new Date(Date.now() - 20 * 60_000).toISOString();
  await writeHeldWorkFeeds(dir, TENANT, {
    help: { receivedAt: asAt, feed: { name: 'help', asAt, body: {
      sops: [
        { sopId: 'SOP-01', title: 'The PC is down', titleTa: 'கணினி இயங்கவில்லை', version: 1, forRoles: ['role-of-u-cash', 'role-of-u-mgr'], category: 'procedure', bodyEn: 'Keep selling on paper bills.', bodyTa: 'காகித பில்லில் விற்பனையைத் தொடருங்கள்.' },
        { sopId: 'SOP-03', title: 'Owner\'s close', titleTa: 'உரிமையாளர் மூடல்', version: 1, forRoles: ['owner'], category: 'procedure', bodyEn: 'x', bodyTa: 'x' },
      ],
      people: [{ employeeId: 'u-cash', roles: ['role-of-u-cash'] }, { employeeId: 'u-mgr', roles: ['role-of-u-mgr'] }],
      acknowledgements: [], emergencyContacts: [{ label: 'Fire service', labelTa: 'தீயணைப்பு', phone: '101' }], contactsSet: true,
    } } },
    equipment: { receivedAt: asAt, feed: { name: 'equipment', asAt, body: { equipment: [{ assetId: 'cold-1', name: 'Cold room 1', branchId: 'S1', range: { minTenthsC: 0, maxTenthsC: 80, graceMinutes: 30 }, lastReadingAt: null }] } } },
  });
}

describe.skipIf(!HAVE_BROWSER)('help, readings and losses saved at the store with the line down, on the real box (OB-288 LP/workforce)', () => {
  let browser: Browser;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  const box = async (): Promise<EdgeProcess> => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-lpw-e2e-')); dirs.push(dir);
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, PACK, 'utf8');
    await heldFeeds(dir);
    const edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile,
      // The hosted copy (ADR-0020 §6 · OB-16): the front's sign-in names the person on every request.
      EDGE_LANE_ID: 'lane-1', EDGE_LANE_TRUST_FORWARDED_USER: '1', EDGE_SCREEN_TRUST_FORWARDED_USER: '1',
    }, () => {}))!;
    stops.push(() => edge.stop());
    return edge;
  };
  const open = async (edge: EdgeProcess, who: string, path: string): Promise<{ page: Page; errors: string[] }> => {
    const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
    stops.push(() => context.close());
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route(`http://127.0.0.1:${edge.screens!.port}/**`, (route) => route.continue({ headers: { ...route.request().headers(), 'x-sre-user': who } }));
    await page.route(`http://127.0.0.1:${edge.lane!.port}/lane/**`, (route) => route.continue({ headers: { ...route.request().headers(), 'x-sre-user': who } }));
    await page.goto(`http://127.0.0.1:${edge.screens!.port}${path}`, { waitUntil: 'load' });
    return { page, errors };
  };
  const logged = async (edge: EdgeProcess): Promise<Logged[]> =>
    (await readLog(edge.deviceEventsLog.path)).filter((r) => r.ok).map((r) => JSON.parse(r.ok ? r.record : '{}') as Logged);
  const waitText = (page: Page, selector: string, text: string) => page.waitForFunction(([sel, want]) => {
    const node = (globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector(sel!);
    return (node?.textContent ?? '').includes(want!);
  }, [selector, text], { timeout: 15_000 });

  it('help: the cashier\'s procedures from the box\'s library, acknowledged with no cloud and carried in their name; once', async () => {
    const edge = await box();
    const { page, errors } = await open(edge, 'u-cash', '/help/');
    await page.locator('#sops article[data-sop="SOP-01"]').waitFor({ timeout: 15_000 });
    expect(await page.locator('#sops article[data-sop="SOP-03"]').count()).toBe(0);
    expect((await page.textContent('#as-at')) ?? '').toContain('As the store computer last heard it');
    expect((await page.textContent('#contact-rows')) ?? '').toContain('Fire service: 101');
    const ack = page.locator('#sops article[data-sop="SOP-01"] button[data-act="ack"]');
    expect(await ack.locator('svg').count()).toBe(1);
    expect((await ack.boundingBox())!.height).toBeGreaterThanOrEqual(48);
    await ack.click();
    await page.waitForFunction(() => (globalThis as unknown as Win).help?.session.queue?.items()[0]?.state === 'handed_to_box', undefined, { timeout: 20_000 });
    const records = await logged(edge);
    expect(records.map((r) => r.type)).toEqual(['SopAcknowledged']);
    expect(records[0]!.payload).toMatchObject({ sopId: 'SOP-01', employeeId: 'u-cash', version: 1 });
    await page.click('#lang');
    expect((await page.textContent('#contact-rows')) ?? '').toContain('தீயணைப்பு: 101');
    await page.reload({ waitUntil: 'load' });
    await waitText(page, '#sops article[data-sop="SOP-01"]', 'You have read this version');
    await page.waitForTimeout(500);
    expect(edge.deviceEventsOutbox.all()).toHaveLength(1);
    expect(errors).toEqual([]);
  }, 90_000);

  it('facilities: a word is refused, nothing saved; the probe\'s temperature reaches the box in the manager\'s name; a cashier is offered no reading', async () => {
    const edge = await box();
    const { page, errors } = await open(edge, 'u-mgr', '/facilities/');
    const room = page.locator('#eq-rows li[data-asset="cold-1"]');
    await room.waitFor({ timeout: 15_000 });
    expect((await room.textContent()) ?? '').toContain('range 0.0°C – 8.0°C');
    await room.locator('input.eq-reading').fill('cold');
    await room.locator('button.eq-save').click();
    await waitText(page, '#eq-result-text', 'Type the temperature as a number');
    expect(edge.deviceEventsOutbox.all()).toHaveLength(0);
    expect(await room.locator('button.eq-save svg').count()).toBe(1);
    expect((await room.locator('button.eq-save').boundingBox())!.height).toBeGreaterThanOrEqual(48);
    await room.locator('input.eq-reading').fill('3.5');
    await room.locator('button.eq-save').click();
    await page.waitForFunction(() => (globalThis as unknown as Win).equipmentReadingQueue?.queue.items()[0]?.state === 'handed_to_box', undefined, { timeout: 20_000 });
    const records = await logged(edge);
    expect(records.map((r) => r.type)).toEqual(['EquipmentReadingRecorded']);
    expect(records[0]!.payload).toMatchObject({ assetId: 'cold-1', tenthsC: 35, source: 'manual_probe', recordedBy: 'u-mgr', storeId: 'S1' });
    expect(errors).toEqual([]);
    // SEC-1 (P-04): a cashier does not hold the facilities screen's word, so the box refuses them the screen itself — the
    // "may not open this screen" page, none of its figures, no reading form — as the PIN path does.
    const cashier = await open(edge, 'u-cash', '/facilities/');
    await waitText(cashier.page, '#office-heading', 'u-cash may not open this screen');
    expect(await cashier.page.locator('#eq-rows').count()).toBe(0);
    expect(await cashier.page.content()).not.toContain('window.facilitiesData');
  }, 90_000);

  it('record a loss: saved only with the kind and the reason chosen from the closed lists, then carried by the box', async () => {
    const edge = await box();
    const { page, errors } = await open(edge, 'u-mgr', '/write-off-capture/');
    await page.waitForSelector('#woq:not([hidden])', { timeout: 15_000 });
    await page.fill('#woq-product', 'MILK'); await page.fill('#woq-location', 'S1'); await page.fill('#woq-qty', '2');
    await page.click('#woq-save');
    await waitText(page, '#woq-result-text', 'choose the kind of loss and why');
    expect(edge.deviceEventsOutbox.all()).toHaveLength(0);
    await page.selectOption('#woq-type', 'damage'); await page.selectOption('#woq-reason', 'damage');
    await page.click('#woq-save');
    await page.waitForFunction(() => (globalThis as unknown as Win).writeOffQueue?.queue.items()[0]?.state === 'handed_to_box', undefined, { timeout: 20_000 });
    const records = await logged(edge);
    expect(records.map((r) => r.type)).toEqual(['WriteOffCaptured']);
    expect(records[0]!.payload).toMatchObject({ productId: 'MILK', locationId: 'S1', qty: 2, uom: 'ea', lossType: 'damage', reasonCode: 'damage', raisedBy: 'u-mgr', storeId: 'S1' });
    await page.click('#lang');
    await waitText(page, '#woq-title', 'இணைப்பு இல்லையா');
    expect(errors).toEqual([]);
  }, 90_000);
});
