import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startRealCloud, type RealCloud } from '../support/real-store';
import { startPageShell, type PageShell } from './lib/page-shell';
import { defaultExportPeriod } from '../../apps/web-erp/src/data-io-session';

/**
 * **Attendance is exported for a chosen period from the data import & export console, in a real browser, on the
 * PRODUCTION API over PostgreSQL (audit SF-10 round 5c · M30-FR-02 · M25/M26).**
 *
 * The console reads the export catalogue from head office; for a domain head office says is dated it shows From / To
 * (defaulting to the last 7 days ending yesterday in the shop's calendar), sends the chosen days, and says the answer:
 *   • the owner exports 1–3 September and is told how many rows were taken; the export is on head office's log with
 *     its period;
 *   • a manager of one store, signed in there, exports the same days and is told which pay columns were hidden;
 *   • a 40-day period is refused by head office and the page says so in plain words — nothing taken, nothing logged;
 *   • the labels switch to Tamil like the rest of the page.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['attendance', 'export', 'e2e', 'key'].join('-').padEnd(48, '0');
const OWNER = 'u-owner'; const MGR_S2 = 'u-mgr-s2';

async function ok(p: Promise<{ status: number; body: unknown }>, label: string): Promise<void> {
  const r = await p;
  if (r.status >= 300) throw new Error(`${label}: ${r.status} ${JSON.stringify(r.body)}`);
}

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('attendance export for a period, in a real browser on the production API (SF-10)', () => {
  let browser: Browser;
  let cloud: RealCloud;
  let shell: PageShell;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    cloud = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId: randomUUID(), owner: OWNER, packSigningKey: KEY });
    // A manager of ONE store (S2): asked for by u-hr, approved by the owner — two acts.
    const gid = `grant-${MGR_S2}`;
    await ok(cloud.request({ method: 'POST', path: '/v1/identity/grants', userId: 'u-hr', idempotencyKey: `${gid}-ask`, body: { grantId: gid, userId: MGR_S2, roleId: 'store_manager', branchScope: ['S2'], reason: 'S2 only' } }), 'ask');
    await ok(cloud.request({ method: 'POST', path: `/v1/identity/grants/${gid}/approve`, userId: OWNER, idempotencyKey: `${gid}-approve`, body: {} }), 'approve');
    let n = 0;
    const post = (path: string, body: unknown) => ok(cloud.request({ method: 'POST', path, userId: OWNER, idempotencyKey: `seed-${++n}`, body }), path);
    await post('/v1/hr/workforce/employees/E-1', { name: 'Asha', branchId: 'S1', roles: ['cashier'], active: true, hourlyRateMinor: 12_000 });
    await post('/v1/hr/workforce/employees/E-2', { name: 'Bala', branchId: 'S2', roles: ['cashier'], active: true, hourlyRateMinor: 15_000 });
    await post('/v1/hr/workforce/employees/E-3', { name: 'Chitra', branchId: 'S2', roles: ['cashier'], active: true });
    for (const [emp, date, hours] of [['E-1', '2026-09-01', 7.5], ['E-2', '2026-09-01', 6], ['E-2', '2026-09-02', 9], ['E-3', '2026-09-02', 5], ['E-1', '2026-09-03', 4], ['E-2', '2026-09-10', 8]] as const) {
      await post(`/v1/hr/workforce/attendance/${emp}/${date}`, { hours });
    }
    shell = await startPageShell({ cloud: () => cloud, page: { path: '/data-io', html: 'data-io.html', dataGlobal: 'dataIoData' } });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await shell?.stop();
    await cloud?.stop();
  });

  const open = async (who: string, branch?: string): Promise<{ page: Page; close: () => Promise<void> }> => {
    const context = await browser.newContext();
    await shell.signIn(context, who, branch);
    const page = await context.newPage();
    await page.goto(`${shell.base}/data-io`, { waitUntil: 'load' });
    await page.locator('.export-btn[data-domain="attendance"]').waitFor({ timeout: 15_000 });
    return { page, close: () => context.close() };
  };
  const exportDays = async (page: Page, from: string, to: string): Promise<string> => {
    await page.fill('.period-from', from);
    await page.fill('.period-to', to);
    await page.click('.export-btn[data-domain="attendance"]');
    await page.locator('#export-result:not([hidden])').waitFor({ timeout: 15_000 });
    return (await page.textContent('#export-result-text')) ?? '';
  };
  const attendanceLog = async () => ((await cloud.request({ method: 'GET', path: '/v1/exports', userId: OWNER })).body as { exports: { domain: string; userId: string; rowCount: number; period?: { from: string; to: string }; redactedColumns: string[] }[] }).exports.filter((e) => e.domain === 'attendance');

  it('the owner sees the default last 7 days, exports 1–3 September and is told the row count; head office logs the period', async () => {
    const { page, close } = await open(OWNER);
    try {
      const expected = defaultExportPeriod(new Date().toISOString());
      expect(await page.inputValue('.period-from')).toBe(expected.from);
      expect(await page.inputValue('.period-to')).toBe(expected.to);
      expect(await page.textContent('#export-domains')).toContain('at most 31 days');
      // Only the dated domain asks for days.
      expect(await page.locator('.period-from').count()).toBe(1);

      const said = await exportDays(page, '2026-09-01', '2026-09-03');
      expect(said).toBe('Exported 5 rows.');
      expect(await page.getAttribute('#export-result', 'class')).toContain('tone-ok');
      await page.locator('#recent-exports .row', { hasText: 'attendance — 5' }).waitFor({ timeout: 15_000 });
      const log = await attendanceLog();
      expect(log.map((e) => [e.userId, e.rowCount, e.period])).toEqual([[OWNER, 5, { from: '2026-09-01', to: '2026-09-03' }]]);
    } finally {
      await close();
    }
  }, 60_000);

  it('a manager of S2, signed in there, gets S2\'s days with the pay columns hidden — and the page says which', async () => {
    const { page, close } = await open(MGR_S2, 'S2');
    try {
      const said = await exportDays(page, '2026-09-01', '2026-09-03');
      expect(said).toBe('Exported 3 rows. Hidden for you: hours, hourlyRateMinor, costMinor.');
      const mine = (await attendanceLog()).find((e) => e.userId === MGR_S2)!;
      expect(mine).toMatchObject({ rowCount: 3, redactedColumns: ['hours', 'hourlyRateMinor', 'costMinor'] });
    } finally {
      await close();
    }
  }, 60_000);

  it('a 40-day period is refused by head office and the page says so in plain words — nothing taken; Tamil too', async () => {
    const before = (await attendanceLog()).length;
    const { page, close } = await open(OWNER);
    try {
      const said = await exportDays(page, '2026-08-01', '2026-09-09');
      expect(said).toContain('Not exported');
      expect(said).toContain('at most 31 days');
      expect(said).not.toContain('{');
      expect(await page.getAttribute('#export-result', 'class')).toContain('tone-error');
      expect((await attendanceLog()).length).toBe(before);

      await page.click('#lang');
      expect(await page.textContent('#export-domains')).toContain('முதல்');
      await page.click('.export-btn[data-domain="attendance"]');
      await page.locator('#export-result-text', { hasText: 'ஏற்றுமதி செய்யப்படவில்லை' }).waitFor({ timeout: 15_000 });
      expect((await attendanceLog()).length).toBe(before);
    } finally {
      await close();
    }
  }, 60_000);
});
