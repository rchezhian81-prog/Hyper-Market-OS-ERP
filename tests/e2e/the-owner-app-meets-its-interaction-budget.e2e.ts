import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { Tally } from './lib/tally';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';

/**
 * **The owner's phone screen meets its interaction budget — counted, in a real browser (owner-command-centre.md · QG-02 ·
 * design system §1 rule 1 · lane 1 R4).**
 *
 * The real store computer serves the owner app with a request waiting for the owner. Counted, one tap each:
 *   • drill a KPI to its detail (≤3): the figure itself opens what it is made of — one tap;
 *   • approve a pending item (≤3: open → review → approve): Approve on the request, then the reason it is approved for —
 *     two; the decision is the owner's, recorded with a reason code from the screen's own list.
 * Skips where no browser binary is present.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['owner', 'budget', 'signing', 'key'].join('-').padEnd(48, '0');

describe.skipIf(!HAVE_BROWSER)('the owner app\'s interaction budget, counted on the served screen', () => {
  let browser: Browser;
  let edge: EdgeProcess;
  let dir: string;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'owner-app'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    dir = await mkdtemp(join(tmpdir(), 'sre-owner-budget-'));
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, JSON.stringify({
      version: 1, lossPreventionRules: [],
      policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1', branchName: 'Main', staleAfterSeconds: 900 },
      approvals: [{ id: 'a1', subjectType: 'price_change', subjectRef: 'Toor dal 1kg', requestedBy: 'u-buyer', branchId: 'store-1', valueMinor: 45_000 }],
    }), 'utf8');
    edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
      EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile,
    }, () => {}))!;
  }, 180_000);
  afterAll(async () => { await browser?.close(); await edge?.stop(); if (dir !== undefined) await rm(dir, { recursive: true, force: true }); });

  it('drill a KPI 1 · approve a pending item 2', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/owner/`, { waitUntil: 'load' });
    await page.waitForSelector('#kpis button.kpi');
    const taps = new Tally(page);

    await taps.tap('#kpis button.kpi');
    await page.waitForSelector('#drill:not([hidden])');
    expect(taps.reset(), 'drill a KPI to its detail').toBeLessThanOrEqual(3);
    expect(await page.textContent('#drill-title')).not.toBe('—');
    await page.click('#drill-close');

    await page.waitForSelector('#approvals .row .row-actions button.primary');
    expect(await page.textContent('#approvals .row')).toContain('Toor dal 1kg');
    await taps.tap('#approvals .row .row-actions button.primary');
    await page.waitForSelector('#decide:not([hidden]) #decide-reasons button');
    await taps.tap('#decide-reasons button:first-child');
    await page.waitForSelector('#banner:not([hidden])');
    expect(taps.reset(), 'approve a pending item (owner)').toBeLessThanOrEqual(3);
    expect(await page.textContent('#banner')).toContain('Toor dal 1kg');
    expect(errors).toEqual([]);
    await context.close();
  });
});
