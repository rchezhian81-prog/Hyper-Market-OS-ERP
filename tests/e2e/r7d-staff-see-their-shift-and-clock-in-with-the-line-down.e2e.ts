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
 * **Round 7 · OB-507 and OB-502 in a real browser on the REAL store computer, with NO cloud at all (M25-FR-01/03 · §31).**
 *
 * The self-service page staff use:
 *   • Rani opens "My self-service": her shifts are shown from the roster in the box's signed pack, with a line saying it is
 *     the store computer's copy and how old it is (P-08);
 *   • she presses "I am starting work (in)" and later "I am finishing work (out)": each is saved on this screen at once,
 *     handed to the box (on its fsync'd log, in her name), and listed with the shared words ("With the store computer");
 *   • in Tamil the same; a reload and a COLD RESTART of the box lose nothing and send nothing twice.
 * The production screen:
 *   • Kumar, whose food-handling certificate expired, presses "Record the run": refused before anything is saved, in words
 *     naming the certificate and the date it expired; nothing reaches the box.
 * Head office booking each mark once is proven by tests/integration/r7d-the-roster-and-certificates-ride-the-signed-pack-to-the-box.test.ts.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['r7d', 'roster', 'offline', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = 't-sre';
const asAt = new Date(Date.now() - 45 * 60_000).toISOString();
const inDays = (n: number, hh: string): string => new Date(Date.now() + n * 86_400_000).toISOString().replace(/T.*/, `T${hh}:00:00.000Z`);

const pack = (screens: Record<string, unknown>) => JSON.stringify({
  version: 1, lossPreventionRules: [],
  policies: { tradingDayCutoff: '02:00', storeId: 'S1', branchId: 'S1', timeZone: 'Asia/Kolkata' },
  roster: {
    storeId: 'S1', asAt,
    employees: [{ employeeId: 'E-RANI', name: 'Rani', roles: ['cashier'], active: true }, { employeeId: 'E-COOK', name: 'Kumar', roles: ['cook'], active: true }],
    shifts: [
      { shiftId: 'SH-1', branchId: 'S1', startsAt: inDays(1, '00'), endsAt: inDays(1, '08'), requiredRoles: [{ role: 'cashier', count: 1 }] },
      { shiftId: 'SH-2', branchId: 'S1', startsAt: inDays(2, '00'), endsAt: inDays(2, '08'), requiredRoles: [{ role: 'cashier', count: 1 }] },
    ],
    assignments: [{ shiftId: 'SH-1', employeeId: 'E-RANI', role: 'cashier' }, { shiftId: 'SH-2', employeeId: 'E-RANI', role: 'checkout lead' }],
    published: [
      { shiftId: 'SH-1', branchId: 'S1', weekStart: '2026-10-26', weekEnd: '2026-11-01', limitsNotChecked: [] },
      { shiftId: 'SH-2', branchId: 'S1', weekStart: '2026-10-26', weekEnd: '2026-11-01', limitsNotChecked: [] },
    ],
  },
  certifications: { asAt, foodHandlingKind: 'food-handling', certifications: [{ certificationId: 'C-K', employeeId: 'E-COOK', kind: 'food-handling', issuedOn: '2025-01-01', validUntil: '2026-01-31', verifiedBy: 'u-mgr' }] },
  ...screens,
});

interface EssWindow {
  readonly essAttendance?: { attendance: { marks(lang: 'en'): { kind: string; state: string }[] } };
  readonly productionTasks?: unknown;
}

describe.skipIf(!HAVE_BROWSER)('staff see their shift and clock in on the store computer with the line down (OB-507 · OB-502)', () => {
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

  const box = async (dir: string, packFile: string): Promise<EdgeProcess> => {
    const edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile,
    }, () => {}))!;
    return edge;
  };
  const waitText = (page: Page, selector: string, text: string) => page.waitForFunction(([sel, want]) => {
    const node = (globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector(sel!);
    return (node?.textContent ?? '').includes(want!);
  }, [selector, text], { timeout: 10_000 });
  const handedCount = (page: Page, n: number) => page.waitForFunction((want) => {
    const marks = (globalThis as unknown as EssWindow).essAttendance?.attendance.marks('en') ?? [];
    return marks.filter((m) => m.state === 'handed_to_box').length === want;
  }, n, { timeout: 15_000 });

  it('Rani sees her own shifts from the box\'s copy, clocks in and out offline; a reload and a cold restart lose nothing and send nothing twice', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-r7d-ess-')); dirs.push(dir);
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, pack({ essPolicy: { userId: 'E-RANI', permissions: ['payroll.ess.self', 'workforce.attendance.mark'] } }), 'utf8');
    let edge = await box(dir, packFile);
    stops.push(() => edge.stop());
    const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
    stops.push(() => context.close());
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const port = edge.screens!.port;
    await page.goto(`http://127.0.0.1:${port}/ess/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as EssWindow).essAttendance !== undefined, undefined, { timeout: 15_000 });
    expect(errors).toEqual([]);

    // Her shifts, from the box's copy of head office's roster — said as such, with its age.
    await waitText(page, '#rows', 'checkout lead');
    expect((await page.textContent('#rows')) ?? '').toContain('cashier');
    expect(await page.isVisible('#asof')).toBe(true);
    expect((await page.textContent('#asof')) ?? '').toContain('Your rota as the store computer last heard it from head office, at');
    expect(await page.isVisible('#sample')).toBe(false);

    // Clock in: saved here at once, then with the store computer. Buttons are big enough for a thumb.
    const inBox = await page.locator('#att-in').boundingBox();
    expect(inBox!.height).toBeGreaterThanOrEqual(56);
    await page.click('#att-in');
    await waitText(page, '#att-said', 'Saved on this store computer.');
    await handedCount(page, 1);
    await waitText(page, '#att-marks', 'With the store computer');
    await page.click('#att-out');
    await handedCount(page, 2);

    // On the box's own disk, in her name, once each.
    const onDisk = async (e: EdgeProcess) => (await readLog(e.deviceEventsLog.path)).filter((r) => r.ok).map((r) => JSON.parse(r.ok ? r.record : '{}') as { type: string; payload: Record<string, unknown> });
    const records = await onDisk(edge);
    expect(records.map((r) => [r.type, r.payload['employeeId'], r.payload['kind'], r.payload['method'], r.payload['storeId']])).toEqual([
      ['AttendanceMarked', 'E-RANI', 'in', 'pin', 'S1'], ['AttendanceMarked', 'E-RANI', 'out', 'pin', 'S1'],
    ]);

    // In Tamil — the same page, the same marks.
    await page.click('#lang');
    await waitText(page, '#att-title', 'எனது வருகை');
    await waitText(page, '#att-marks', 'கடைக் கணினியிடம் உள்ளது');

    // RELOAD: still listed; nothing handed twice.
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as EssWindow).essAttendance !== undefined, undefined, { timeout: 15_000 });
    await handedCount(page, 2);
    expect(edge.deviceEventsOutbox.all()).toHaveLength(2);

    // COLD RESTART of the box (same disk, a new port): the marks are still there, still waiting for head office.
    await edge.stop(); stops.shift();
    edge = await box(dir, packFile);
    stops.unshift(() => edge.stop());
    expect(edge.deviceEventsOutbox.all().map((i) => i.state)).toEqual(['pending', 'pending']);
    expect((await onDisk(edge)).filter((r) => r.type === 'AttendanceMarked')).toHaveLength(2);
  }, 120_000);

  it('Kumar, whose food-handling certificate expired, cannot record a run on the production screen — refused in words before anything is saved', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-r7d-prod-')); dirs.push(dir);
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, pack({ productionPolicy: { userId: 'E-COOK', permissions: ['production.read', 'production.plan.commit'] } }), 'utf8');
    await writeHeldWorkFeeds(dir, TENANT, {
      production: { receivedAt: asAt, feed: { name: 'production', asAt, body: { runs: [], recipes: [{ recipeId: 'r-cake', departmentId: 'cafe', outputProductId: 'CAKE', outputUom: 'ea', shelfLifeHours: 48 }], enabledDepartments: ['cafe'] } } },
    });
    const edge = await box(dir, packFile);
    stops.push(() => edge.stop());
    const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/production/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as EssWindow).productionTasks !== undefined, undefined, { timeout: 15_000 });
    await page.fill('#run-recipe', 'r-cake'); await page.fill('#run-batches', '1'); await page.fill('#run-output', '1');
    await page.fill('#run-batch', 'CAKE-1'); await page.fill('#run-location', 'S1-KITCHEN');
    await page.click('#run');
    await waitText(page, '#result-text', "Kumar's food-handling certificate expired on 2026-01-31");
    expect((await page.textContent('#result-text')) ?? '').toContain('Nothing was saved');
    await page.click('#lang');
    await page.click('#run');
    await waitText(page, '#result-text', '2026-01-31 அன்று காலாவதியானது');
    // A weigh (counter food) is refused the same way.
    for (const [id, v] of [['#weigh-dept', 'meat_fish'], ['#weigh-in', 'CHICKEN'], ['#weigh-in-g', '1000'], ['#weigh-out', 'CUTS'], ['#weigh-out-g', '800']] as const) await page.fill(id, v);
    await page.click('#weigh');
    await waitText(page, '#result-text', 'காலாவதியானது');
    expect(edge.deviceEventsOutbox.all()).toHaveLength(0);
    expect((await readLog(edge.deviceEventsLog.path)).length).toBe(0);
  }, 120_000);
});
