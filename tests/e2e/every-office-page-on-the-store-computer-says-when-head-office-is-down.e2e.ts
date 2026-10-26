import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { HEAD_OFFICE_PAGES } from '../../edge/store-edge/src/head-office-pages';
import { ERP_NAVIGATION } from '../../apps/web-erp/src/navigation';
import { issueTillPins, pinOf } from '../support/till-operator';

/**
 * **Every office page the store computer serves for head office, with head office DOWN (OB-380 · P-08 · NFR-08).**
 *
 * A real store computer, the office PIN on, no cloud and nothing in front of it. The owner signs in once with their PIN
 * and opens every one of the head-office pages the box now serves. For each: it answers 200; the page runs with no script
 * error; it carries the menu; it shows no DEMO or "sample" stand-in (nothing that is not head office's answer); and every
 * page that reads head office as it opens says, in its own words, that head office cannot be reached. A page that reads
 * only on a click shows no figure until then. The seven representative journeys (with head office up, and refusals) are in
 * the-office-pages-are-served-by-the-store-computer.e2e.ts.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['office', 'sweep', 'box', 'signing', 'key'].join('-').padEnd(48, '0');
const UNREACHABLE = /Head office cannot be reached|head office could not be reached|could not be read from head office|தலைமை அலுவலகத்தை அடைய முடியவில்லை/i;

describe.skipIf(!HAVE_BROWSER)('every head-office page on the store computer, with head office down', () => {
  let browser: Browser;
  let edge: EdgeProcess;
  let dir: string;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    dir = await mkdtemp(join(tmpdir(), 'sre-office-sweep-'));
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, JSON.stringify({
      version: 1, lossPreventionRules: [], policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1' },
      people: [{ userId: 'u-owner', displayName: 'Owner Person', roleId: 'owner' }],
      roles: [{ id: 'owner', name: 'Owner', permissions: [...new Set(['identity.self.read', ...ERP_NAVIGATION.map((i) => i.requires)])] }],
      roleAssignments: [{ userId: 'u-owner', roleId: 'owner', branchScope: 'all' }],
    }), 'utf8');
    await issueTillPins(dir, KEY, ['u-owner']);
    edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
      EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile, EDGE_OFFICE_SIGN_IN: 'pin',
    }, () => {}))!;
  }, 240_000);
  afterAll(async () => { await browser?.close(); await edge?.stop(); if (dir !== undefined) await rm(dir, { recursive: true, force: true }); });

  it(`all ${HEAD_OFFICE_PAGES.length} open, run cleanly, carry the menu, show no stand-in, and say head office cannot be reached`, async () => {
    expect(HEAD_OFFICE_PAGES.length).toBe(52); // the 47 of OB-380, the four QG-02 pages and the company report (OB-391)
    const base = `http://127.0.0.1:${edge.screens!.port}`;
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(`${base}/manager/`, { waitUntil: 'load' });
    await page.fill('#office-staff', 'u-owner');
    await page.fill('#office-pin', pinOf('u-owner'));
    await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('#office-submit')]);
    const findings: string[] = [];
    for (const p of HEAD_OFFICE_PAGES) {
      const errors: string[] = [];
      const calls: string[] = [];
      const onError = (e: Error): void => { errors.push(e.message); };
      const onRequest = (r: { url(): string }): void => { if (new URL(r.url()).pathname.startsWith('/v1/')) calls.push(new URL(r.url()).pathname); };
      page.on('pageerror', onError);
      page.on('request', onRequest);
      const res = await page.goto(`${base}/${p.screen}/`, { waitUntil: 'load' });
      await page.waitForLoadState('networkidle');
      if (calls.length > 0) {
        // Wait for the page's own words — never read in the same tick as the failed read.
        await page.waitForFunction((src) => new RegExp(src, 'i').test((globalThis as unknown as { document: { body: { innerText: string } } }).document.body.innerText), UNREACHABLE.source, { timeout: 15_000 })
          .catch(() => { findings.push(`${p.screen}: read head office (${calls.join(', ')}) but never said it could not be reached`); });
      }
      const state = await page.evaluate(() => {
        const d = (globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<{ hidden: boolean; innerText: string }> } }).document;
        const shown = (sel: string) => Array.from(d.querySelectorAll(sel)).filter((n) => !n.hidden && n.innerText.trim() !== '').map((n) => n.innerText.trim());
        return { standIn: [...shown('.demo'), ...shown('.sample')], menu: typeof (globalThis as unknown as { sreNavigation?: unknown }).sreNavigation };
      });
      page.off('pageerror', onError);
      page.off('request', onRequest);
      if (res?.status() !== 200) findings.push(`${p.screen}: answered ${res?.status()}`);
      if (errors.length > 0) findings.push(`${p.screen}: script errors ${errors.join(' | ')}`);
      if (state.standIn.length > 0) findings.push(`${p.screen}: shows a stand-in: ${state.standIn.join(' | ')}`);
      if (state.menu !== 'object') findings.push(`${p.screen}: no menu`);
    }
    expect(findings).toEqual([]);
    await context.close();
  }, 400_000);
});
