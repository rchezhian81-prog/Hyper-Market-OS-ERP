// The box in this file runs on a UTC machine — what its container keeps without the TZ backstop.
process.env['TZ'] = 'UTC';

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { prepareTillBox } from '../support/till-operator';

/**
 * **Re-audit lane 1 R1a (M01-FR-02 · P-08): the manager sees, in a real browser on the REAL box, that the store computer's
 * own time zone is not the shop's** — in words beside a shape, in English and Tamil. The box still dates by the shop's
 * zone from its signed pack (proven by tests/integration/the-store-box-dates-by-the-shops-zone-even-on-a-utc-machine).
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['manager', 'zone', 'r1a', 'signing', 'key'].join('-').padEnd(48, '0');
const PACK = ({
  version: 1,
  policies: { tradingDayCutoff: '00:00', timeZone: 'Asia/Kolkata', storeId: 'store-1', branchId: 'store-1' },
  managerPolicy: { userId: 'u-mgr', approvalLimitMinor: 500_000 },
  lossPreventionRules: [],
}) as Record<string, unknown>;

describe.skipIf(!HAVE_BROWSER)('the manager sees when the box zone is not the shop zone (R1a), on the real box', () => {
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

  it('a box on UTC under an Asia/Kolkata shop shows the zone warning in words, with a shape, in both languages', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-zone-e2e-')); dirs.push(dir);
    const tillEnv = await prepareTillBox({ dir, key: KEY, pack: PACK, people: [{ userId: 'u-cash', displayName: 'Cashier' }] });
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', ...tillEnv,
    }, () => {}))!;
    stops.push(() => edge.stop());
    expect(edge.zoneCheck()).toMatchObject({ verdict: 'differs', machineTimeZone: 'UTC' });

    const context = await browser.newContext();
    stops.push(() => context.close());
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/manager`, { waitUntil: 'load' });
    await page.waitForSelector('#box-clock:not([hidden])', { timeout: 15_000 });
    await page.waitForSelector('#box-zone-words:not([hidden])', { timeout: 15_000 });
    await page.waitForFunction("(document.querySelector('#box-zone-words')?.textContent ?? '').includes('UTC')", undefined, { timeout: 10_000 });
    const words = (await page.textContent('#box-zone-words')) ?? '';
    expect(words).toContain('Asia/Kolkata');
    expect(words).toContain('still dated by the shop');
    expect(await page.getAttribute('#box-clock', 'data-tone')).toBe('warn');
    await page.waitForSelector('#box-zone-words svg', { timeout: 10_000 });

    await page.click('#lang');
    await page.waitForFunction("/[஀-௿]/.test(document.querySelector('#box-zone-words')?.textContent ?? '')", undefined, { timeout: 10_000 });
    expect(errors).toEqual([]);
  });
});
