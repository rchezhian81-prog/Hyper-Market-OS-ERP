import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { prepareTillBox, pinOf } from '../support/till-operator';

/**
 * **D04-FR-05 · M12-FR-04 — the served till reports its devices when the cashier signs in, and the manager's Today screen
 * says which one has failed, in a real browser.**
 *
 * The device adapter on the till computer is hardware-side (external); here a stand-in adapter on the page answers as a
 * real one would (the printer is out of paper). The cashier signs in through the till's own control with staff ID and
 * till PIN; the report reaches the store computer's disk; the manager's Today screen, served by the same box, shows the
 * failed printer in its attention list — and before the report it said "not known", never "all fine". Skips where no
 * browser binary is present.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['served', 'till', 'devices', 'signing', 'key'].join('-').padEnd(48, '0');

interface PosWindow { readonly posSession?: { operator(): string | undefined } }
interface Doc { readonly document: { getElementById(id: string): { textContent: string | null } | null } }

describe.skipIf(!HAVE_BROWSER)('the served till reports its devices (D04-FR-05)', () => {
  let browser: Browser;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'pos'], { stdio: 'ignore' });
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 120_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it('the cashier signs in, the adapter\'s words reach the box, and the manager sees the failed printer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-served-till-devices-'));
    dirs.push(dir);
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '8090', EDGE_LANE_ID: 'lane-1', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
      ...await prepareTillBox({ dir, key: KEY, pack: { managerPolicy: { userId: 'u-mgr' }, lossPreventionRules: [] }, people: [{ userId: 'u-lanecash', displayName: 'Lane Cashier' }, { userId: 'u-mgr', displayName: 'Manager', manager: true }] }),
    }, () => {}))!;
    stops.push(() => edge.stop());
    // The lane socket on the port the till shell posts to (its built-in default), as a one-PC install runs it.
    expect(edge.lane?.port).toBe(8090);
    const base = `http://127.0.0.1:${edge.screens!.port}`;
    const context = await browser.newContext();
    stops.push(() => context.close());

    // The manager's Today, before any till has reported: not known — never "all fine".
    const manager = await context.newPage();
    await manager.goto(`${base}/manager`, { waitUntil: 'load' });
    await manager.waitForFunction(() => ((globalThis as unknown as Doc).document.getElementById('attention')?.textContent ?? '').includes('Till devices'), undefined, { timeout: 10_000 });
    expect(await manager.textContent('#attention')).toContain('Till devices: Not known');

    // The till computer's device adapter (hardware-side; a stand-in here) says the printer is out of paper.
    const till = await context.newPage();
    await till.addInitScript(() => {
      (globalThis as unknown as { sreDevices: unknown }).sreDevices = {
        status: async () => [{ kind: 'scanner', state: 'ok' }, { kind: 'printer', state: 'failed', detail: 'paper out' }, { kind: 'cash_drawer', state: 'ok' }],
      };
    });
    await till.goto(`${base}/pos/`, { waitUntil: 'load' });
    await till.waitForFunction(() => (globalThis as unknown as PosWindow).posSession !== undefined, undefined, { timeout: 15_000 });
    await till.bringToFront();
    await till.click('#signin');
    await till.waitForSelector('#sheet:not([hidden]) #entry:not([aria-label])');
    await till.keyboard.type('u-lanecash');
    await till.keyboard.press('Enter');
    await till.waitForSelector('#sheet:not([hidden]) #entry[aria-label]', { timeout: 5_000 });
    await till.keyboard.type(pinOf('u-lanecash'));
    await till.keyboard.press('Enter');
    await till.waitForFunction(() => (globalThis as unknown as PosWindow).posSession!.operator() === 'u-lanecash', undefined, { timeout: 5_000 });

    // On the box's disk, by the person signed in.
    const deadline = Date.now() + 5_000;
    let kept: { laneId: string; reportedBy: string; devices: { kind: string; state: string }[] }[] = [];
    while (Date.now() < deadline && kept.length === 0) {
      kept = (await readLog(join(dir, 'peripheral-health.log'))).flatMap((r) => (r.ok ? [JSON.parse(r.record) as (typeof kept)[number]] : []));
      if (kept.length === 0) await new Promise((r) => { setTimeout(r, 100); });
    }
    expect(kept).toEqual([expect.objectContaining({ laneId: 'lane-1', reportedBy: 'u-lanecash' })]);

    // The manager reloads Today: the failed printer is in the attention list, named.
    await manager.reload({ waitUntil: 'load' });
    await manager.waitForFunction(() => ((globalThis as unknown as Doc).document.getElementById('attention')?.textContent ?? '').includes('paper out'), undefined, { timeout: 10_000 });
    expect(await manager.textContent('#attention')).toContain('1 till device(s) failed or not working properly — lane-1: printer has failed — paper out');
  }, 60_000);
});
