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

/**
 * **Food-safety checks are saved at the facilities screen with the line down, in a real browser on the REAL store box
 * (OB-288 lane 2 · P2 · M10-FR-02 "evidence captured offline; queued" · §31 · P-01 · P-08).**
 *
 * The box starts with NO cloud and with head office's food-safety checks restored from its own disk (`work-feeds.json`).
 * At the actual screen a manager sees today's slots worked out from those checks (the one head office already has is
 * shown done), records the chiller reading — refused first, in words, when it fails with nothing done about it — and the
 * saved check reaches the box's fsync'd device-events log in the manager's name, timed when it was done. A reload sends
 * nothing twice. Head office booking it once is proven by
 * tests/integration/the-store-box-keeps-offline-work-and-books-it-once.test.ts.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['food', 'safety', 'offline', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = 't-sre';
const HOUR = 3_600_000;
const THIS_HOUR = new Date(Math.floor(Date.now() / HOUR) * HOUR).toISOString();
const LAST_HOUR = new Date(Date.parse(THIS_HOUR) - HOUR).toISOString();

interface FsWindow {
  readonly foodSafetyQueue?: { view(lang: 'en'): { rows: { checkId: string; slotDueAt: string; state: string; saved?: { state: string } }[] } };
  readonly foodSafetyRelay?: unknown;
}

const PACK_JSON = JSON.stringify({
  version: 1, lossPreventionRules: [],
  policies: { tradingDayCutoff: '02:00', storeId: 'S1', branchId: 'S1' },
  facilitiesPolicy: { userId: 'u-mgr', permissions: ['facilities.overdue.read', 'facilities.task.record'] },
});

async function boxWithHeldChecks(dir: string): Promise<void> {
  const asAt = new Date(Date.now() - 20 * 60_000).toISOString();
  await writeHeldWorkFeeds(dir, TENANT, {
    'food-safety': {
      receivedAt: asAt,
      feed: {
        name: 'food-safety', asAt,
        body: {
          checks: [{
            checkId: 'chk-chiller', branchId: 'S1', title: 'Dairy chiller temperature', kind: 'temperature', everyMinutes: 60,
            startsAt: new Date(Date.parse(THIS_HOUR) - 24 * HOUR).toISOString(), graceMinutes: 30, minTenthsC: 0, maxTenthsC: 50, items: [],
            assignedRole: 'store_manager', escalatesTo: 'u-owner', active: true,
          }],
          slots: [{ checkId: 'chk-chiller', slotDueAt: LAST_HOUR, state: 'done', performedBy: 'u-mgr' }],
          receiving: [],
        },
      },
    },
  });
}

describe.skipIf(!HAVE_BROWSER)('food-safety checks at the facilities screen with the line down, on the real box (OB-288 lane 2 · P2)', () => {
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

  const ready = (page: Page) => page.waitForFunction(() => (globalThis as unknown as FsWindow).foodSafetyQueue !== undefined && (globalThis as unknown as FsWindow).foodSafetyRelay !== undefined, undefined, { timeout: 15_000 });
  const waitText = (page: Page, selector: string, text: string) => page.waitForFunction(([sel, want]) => {
    const node = (globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector(sel!);
    return (node?.textContent ?? '').includes(want!);
  }, [selector, text], { timeout: 5_000 });
  const rowOf = (slot: string) => `#fs-rows li[data-check="chk-chiller"][data-slot="${slot}"]`;
  const slotState = (page: Page, slot: string) => page.evaluate((s) => (globalThis as unknown as FsWindow).foodSafetyQueue!.view('en').rows.find((r) => r.checkId === 'chk-chiller' && r.slotDueAt === s), slot);

  it('a chiller reading is checked, saved through the box in the manager\'s name with no cloud, and a reload sends nothing twice', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-fs-e2e-')); dirs.push(dir);
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, PACK_JSON, 'utf8');
    await boxWithHeldChecks(dir);
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile,
    }, () => {}))!;
    stops.push(() => edge.stop());
    const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
    stops.push(() => context.close());
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/facilities/`, { waitUntil: 'load' });
    await ready(page);
    expect(errors).toEqual([]);

    // Head office's checks as the box last heard them (P-08: and when), with the slot head office has shown done.
    await page.waitForSelector('#fs:not([hidden])');
    expect((await page.textContent('#fs-heading')) ?? '').toContain('Food-safety checks today');
    expect((await page.textContent('#fs-asof')) ?? '').toContain('as the store computer last heard them');
    expect(await page.getAttribute(rowOf(LAST_HOUR), 'data-state')).toBe('done_ho');
    expect(await page.locator(`${rowOf(LAST_HOUR)} form`).count()).toBe(0);

    // A failing reading with nothing done about it is refused in words, and nothing is saved.
    await page.fill(`${rowOf(THIS_HOUR)} input.fs-reading`, '9');
    await page.click(`${rowOf(THIS_HOUR)} button.fs-save`);
    await waitText(page, '#fs-result-text', 'write down what was done about it');
    expect(edge.deviceEventsOutbox.all()).toHaveLength(0);

    // A good reading is saved here and handed to the box.
    await page.fill(`${rowOf(THIS_HOUR)} input.fs-reading`, '3.5');
    await page.click(`${rowOf(THIS_HOUR)} button.fs-save`);
    await waitText(page, '#fs-result-text', 'Check saved on this screen');
    await page.waitForFunction((s) => (globalThis as unknown as FsWindow).foodSafetyQueue!.view('en').rows.find((r) => r.checkId === 'chk-chiller' && r.slotDueAt === s)?.saved?.state === 'handed_to_box', THIS_HOUR, { timeout: 20_000 });
    expect((await page.textContent(`${rowOf(THIS_HOUR)} .saved`)) ?? '').toContain('With the store computer');

    // On the box's own disk, in the manager's name, timed when it was done.
    const records = (await readLog(edge.deviceEventsLog.path)).filter((r) => r.ok).map((r) => JSON.parse(r.ok ? r.record : '{}') as { type: string; payload: Record<string, unknown> });
    expect(records.map((r) => r.type)).toEqual(['FoodSafetyCheckRecorded']);
    expect(records[0]?.payload).toMatchObject({ checkId: 'chk-chiller', storeId: 'S1', performedBy: 'u-mgr', slotDueAt: THIS_HOUR, readingTenthsC: 35, source: 'facilities-screen' });
    expect(typeof records[0]?.payload['at']).toBe('string');

    // Tamil: the same section speaks Tamil.
    await page.click('#lang');
    expect((await page.textContent('#fs-heading')) ?? '').toContain('உணவுப் பாதுகாப்பு');
    await page.click('#lang');

    // RELOAD: the slot still reads as done here, with the box's word; nothing re-sent to the box.
    await page.reload({ waitUntil: 'load' });
    await ready(page);
    expect((await slotState(page, THIS_HOUR))?.state).toBe('saved_here');
    await page.waitForTimeout(500);
    expect(edge.deviceEventsOutbox.all()).toHaveLength(1);
    expect(errors).toEqual([]);
  });
});
