import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { prepareTillBox, signInAtLane, receiptNumberAt, operatorHeader } from '../support/till-operator';

/**
 * **The manager sees the store computer's clock and every bill it marked, in a real browser on the REAL box (OB-288 lane 2
 * · P2 · OB-327 — owner, in writing, 23 Oct 2026 · §31.1 · P-08 · hard rule #1).**
 *
 * The box's own clock log (fsync'd, `clock-checks.log`) says its clock was 6 minutes behind head office when it last
 * checked. The box is COLD-STARTED with no cloud. A bill is rung at the lane: it COMMITS (a clock never blocks a sale) — and
 * the manager's screen, served by the box, shows in words beside an alert shape that the clock was out and is not yet
 * re-checked, and lists that bill by number for checking. In Tamil too. Nothing is shown while the clock agrees
 * (control by exception) — proven by tests/unit/the-manager-sees-the-box-clock.test.ts.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['manager', 'clock', 'ob327', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = 't-sre';
const PACK = ({
  version: 1,
  policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1' },
  managerPolicy: { userId: 'u-mgr', approvalLimitMinor: 500_000 },
  lossPreventionRules: [],
}) as Record<string, unknown>;

describe.skipIf(!HAVE_BROWSER)('the manager sees the box clock and the bills it marked (OB-327), on the real box', () => {
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

  it('a bill rung while the clock was 5+ minutes out commits, and the manager sees the clock warning and that bill by number', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-clock-e2e-')); dirs.push(dir);
    const tillEnv = await prepareTillBox({ dir, key: KEY, pack: PACK, people: [{ userId: 'u-cash', displayName: 'Cashier' }] });
    // The box's own clock log from before the restart: 6 minutes behind head office, half an hour ago.
    await writeFile(join(dir, 'clock-checks.log'), `${JSON.stringify({ at: new Date(Date.now() - 30 * 60_000).toISOString(), verdict: 'flag_bills', offsetSeconds: 360 })}\n`, 'utf8');
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', ...tillEnv,
    }, () => {}))!;
    stops.push(() => edge.stop());

    // The cashier signs in at the till and rings a bill with no cloud — it commits (a clock never blocks a sale).
    const port = edge.lane!.port;
    const token = await signInAtLane(port, 'u-cash');
    const number = await receiptNumberAt(port, token);
    const sale = await fetch(`http://127.0.0.1:${port}/lane/sales`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...operatorHeader(token) },
      body: JSON.stringify({
        id: `S-${number}`, number, laneId: 'lane-1', cashierId: 'u-cash', committedAt: new Date().toISOString(),
        lines: [{ productId: 'P1', quantityMinor: 1, uom: 'ea', unitPriceMinor: 4_800, lineTotalMinor: 4_800, taxRateBps: 0 }],
        tenders: [{ kind: 'cash', amount: { minor: 4_800, currency: 'INR' }, status: 'settled' }],
        total: 4_800, netMinor: 4_800, taxMinor: 0, currency: 'INR',
      }),
    });
    const saleBody = await sale.json() as { committed: boolean };
    expect(saleBody.committed, JSON.stringify(saleBody)).toBe(true);
    const saleId = `S-${number}`;

    const context = await browser.newContext();
    stops.push(() => context.close());
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // The box re-reads its sale log on each screen request (never on the manager's wait), so the bill is on the next page.
    await (await fetch(`http://127.0.0.1:${edge.screens!.port}/manager`)).text();
    await new Promise((r) => setTimeout(r, 300));
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/manager`, { waitUntil: 'load' });
    await page.waitForSelector('#box-clock:not([hidden])', { timeout: 15_000 });
    expect(await page.getAttribute('#box-clock', 'data-tone')).toBe('error');
    const words = (await page.textContent('#box-clock-words')) ?? '';
    expect(words).toContain('6 minutes');
    expect(words).toContain('has not been checked again since it started');
    // The words wear a shape (never colour alone) once the one icon set has loaded.
    await page.waitForSelector('#box-clock-words svg', { timeout: 10_000 });
    expect((await page.textContent('#box-clock-bills-h')) ?? '').toContain('5 minutes or more out');
    expect(await page.textContent(`#box-clock-bills li[data-sale="${saleId}"]`)).toContain(`${number} · lane lane-1`);

    await page.click('#lang');
    expect((await page.textContent('#box-clock-words')) ?? '').toMatch(/[஀-௿]/);
    expect((await page.textContent('#box-clock-bills-h')) ?? '').toMatch(/[஀-௿]/);
    expect(errors).toEqual([]);
  });
});
