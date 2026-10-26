import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { Tally } from './lib/tally';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { prepareTillBox, signInAtLane, operatorHeader } from '../support/till-operator';

/**
 * **OB-392 (owner, 26 Oct 2026) · M12-FR-04 "lane health (peripherals, sync, offline state) shown" · store-manager.md
 * "open a lane's health" (budget 2) · QG-02 — the manager's Today screen has one card per lane, and one tap opens it.**
 *
 * A real store computer with a till (lane socket, disk, screens). The till's cashier signs in and the till reports its
 * devices: the scanner fine, the printer out of paper; the card machine says nothing. In a real Chromium the manager's
 * Today screen shows the lane with its one problem; ONE tap opens it, and it says — in the box's words, English and Tamil —
 * the printer failed (paper out), the scanner works, the card machine is NOT REPORTED (never "working"), when the till
 * last reported, nothing unsent, and that the last send to head office is not known on a box with no head office set up.
 * Skips where no browser binary is present, like its siblings.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['lane', 'health', 'today', 'key'].join('-').padEnd(48, '0');

interface Doc { readonly document: { querySelector(s: string): { hidden: boolean; textContent: string | null } | null } }

describe.skipIf(!HAVE_BROWSER)('OB-392: lane health on the manager\'s Today screen, one tap per lane', () => {
  let browser: Browser;
  let edge: EdgeProcess;
  let dir = '';

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    dir = await mkdtemp(join(tmpdir(), 'sre-lane-health-'));
    const ready = await prepareTillBox({
      dir, key: KEY, people: [{ userId: 'u-lanecash', displayName: 'Lane Cashier' }, { userId: 'u-mgr', displayName: 'Manager', manager: true }],
      pack: { managerPolicy: { userId: 'u-mgr', approvalLimitMinor: 500_000 }, lossPreventionRules: [] },
    });
    edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
      EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', ...ready,
    }, () => {}))!;
    const token = await signInAtLane(edge.lane!.port, 'u-lanecash');
    const res = await fetch(`http://127.0.0.1:${edge.lane!.port}/lane/peripherals`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...operatorHeader(token) },
      body: JSON.stringify({ devices: [{ kind: 'scanner', state: 'ok' }, { kind: 'printer', state: 'failed', detail: 'paper out' }] }),
    });
    expect(((await res.json()) as { recorded: boolean }).recorded).toBe(true);
  }, 180_000);
  afterAll(async () => {
    await browser?.close();
    await edge?.stop();
    if (dir !== '') await rm(dir, { recursive: true, force: true });
  });

  it('Today shows the lane with its problem; one tap opens printer, scanner, card machine, last report, unsent and last send', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/manager/`, { waitUntil: 'load' });
    await page.waitForSelector('#lanes-card:not([hidden]) #lane-0');
    await page.waitForFunction(() => /1 device problem/.test((globalThis as unknown as Doc).document.querySelector('#lane-0')?.textContent ?? ''));
    expect(await page.textContent('#lane-0')).toContain('Lane lane-1');
    expect(await page.isHidden('#lane-detail-0')).toBe(true);

    const taps = new Tally(page);
    await taps.tap('#lane-0');
    await page.waitForSelector('#lane-detail-0:not([hidden])');
    await page.waitForFunction(() => /Failed — paper out/.test((globalThis as unknown as Doc).document.querySelector('#lane-detail-0')?.textContent ?? ''));
    expect(taps.reset(), 'open a lane’s health').toBeLessThanOrEqual(2);
    const detail = (await page.textContent('#lane-detail-0')) ?? '';
    expect(detail).toContain('PrinterFailed — paper out');
    expect(detail).toContain('ScannerWorking');
    expect(detail).toContain('Card machineNot reported');
    expect(detail).toMatch(/Till last reported\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    expect(detail).toContain('Not yet at head office0 bill(s) or refund(s) from this till');
    expect(detail).toContain('Last sent to head officeNot known');
    expect(await page.getAttribute('#lane-0', 'aria-expanded')).toBe('true');

    // The same card in Tamil, from the one language toggle — the box's facts unchanged.
    await page.click('#lang');
    await page.waitForFunction(() => /அச்சுப்பொறி/.test((globalThis as unknown as Doc).document.querySelector('#lane-detail-0')?.textContent ?? ''));
    expect(await page.textContent('#lane-detail-0')).toContain('கார்டு இயந்திரம்சொல்லப்படவில்லை');

    // A second tap closes it again.
    await page.click('#lane-0');
    await page.waitForSelector('#lane-detail-0', { state: 'hidden' });
    await context.close();
  }, 60_000);
});
