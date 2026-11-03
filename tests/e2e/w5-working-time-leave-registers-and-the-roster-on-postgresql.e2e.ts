import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startW4Shop, openAs, says, type W4Shop } from './lib/w4-office-shop';

/**
 * **W5 — the working-time pack on the pages people use (C18 · OB-152 · OB-155 · OB-156 · OB-166 · OB-181) and the service
 * standard and labour cost (OB-142 · M25-FR-01), in a real browser, on the production API surface over real PostgreSQL
 * when DATABASE_URL is set.**
 *   • Settings (the owner): every limit "not set" until filled; the daily hours cap is filled with the part of the Act and
 *     who confirmed it, and shows in force;
 *   • Staff list (the store manager): a day of sick leave is recorded — NOT CHECKED, the leave rule is not set; the
 *     attendance, leave and holiday registers read back for the period;
 *   • Staff schedule (the store manager): the week's roster breaks the daily hours cap — the check names the breach and
 *     head office REFUSES the publication in its words (OB-152 "A"); the shift is shortened, the week checks clean and is
 *     published; the owner sets the cashier's service standard; labour cost against the day's sales is shown with
 *     "guide not set" — no comparison against a number the owner never gave.
 * Synthetic data only: a fresh random tenant, made-up staff and hours. All dates are fixed — nothing depends on "today".
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER = 'u-owner'; const MGR = 'u-mgr';
const EMP = 'E-W5-2';
const WEEK = '2026-11-09'; // a Monday

describe.skipIf(!existsSync(CHROMIUM))('W5 working time, leave, registers and the roster (PostgreSQL when set), in a real browser', () => {
  let browser: Browser;
  let shop: W4Shop;
  const T = randomUUID();
  const call = (userId: string, path: string, body?: unknown) => shop.ho().request({
    method: body === undefined ? 'GET' : 'POST', path, userId, tenantId: T, ...(body === undefined ? {} : { idempotencyKey: `k-${randomUUID()}`, body }),
  });
  const ok = async (p: ReturnType<typeof call>, what: string): Promise<unknown> => { const r = await p; if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
  const shift = (hoursLong: number) => ({ branchId: 'br-1', startsAt: `${WEEK}T03:30:00.000Z`, endsAt: new Date(Date.parse(`${WEEK}T03:30:00.000Z`) + hoursLong * 3_600_000).toISOString(), requiredRoles: [{ role: 'cashier', count: 1 }] });

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startW4Shop({
      tenantId: T, databaseUrl: DATABASE_URL,
      pages: {
        '/settings': { html: 'settings.html', dataGlobal: 'settingsData' },
        '/staff': { html: 'staff.html', dataGlobal: 'staffData' },
        '/schedule': { html: 'schedule.html', dataGlobal: 'scheduleData' },
      },
    });
    await shop.ho().seedOwner(T, OWNER);
    await shop.ho().provisionRole(T, MGR, 'store_manager');
    await ok(call(OWNER, `/v1/hr/workforce/employees/${EMP}`, { name: 'Staff B', branchId: 'br-1', roles: ['cashier'], active: true, hourlyRateMinor: 10_000 }), 'employee');
    await ok(call(MGR, '/v1/hr/workforce/shifts/SH-W5-1', shift(10)), 'shift');
    await ok(call(MGR, `/v1/hr/workforce/shifts/SH-W5-1/assignments/${EMP}`, { role: 'cashier' }), 'assign');
    await ok(call(MGR, `/v1/hr/workforce/attendance/${EMP}/2026-11-02`, { hours: 8 }), 'attendance');
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 240_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  it('C18 · OB-155: Settings — every limit "not set" until the owner fills it with its source and who confirmed it', async () => {
    const s = await openAs(shop, browser, OWNER, '/settings');
    try {
      // Head office answered (an error would be said here, in its words).
      await s.page.waitForSelector('#wt-limits', { timeout: 30_000 }).catch(async (e: unknown) => { throw new Error(`no limits drawn; #wt-status says ${JSON.stringify(await s.page.textContent('#wt-status').catch(() => null))}; errors ${JSON.stringify(s.errors)} (${String(e)})`); });
      await says(s.page, '#wt-limits [data-limit="maxDailyWorkMinutes"]', /not set — needs the value/);
      await says(s.page, '#wt-leave [data-leave="sick"]', /not set/);
      await says(s.page, '#wt-week', /Monday to Sunday/);
      await s.page.selectOption('#wt-key', 'maxDailyWorkMinutes');
      await s.page.fill('#wt-value', '480');
      await s.page.click('#wt-save');
      await says(s.page, '#wt-save-status', /^Fill in every field first\.$/);
      expect(s.writes).toEqual([]);
      await s.page.fill('#wt-source', 'TN Shops and Establishments Act (synthetic citation)'); await s.page.fill('#wt-conf', 'Owner, synthetic ref 2');
      await s.page.click('#wt-save');
      await says(s.page, '#wt-limits [data-limit="maxDailyWorkMinutes"][data-state="in_force"]', /480 minutes · in force/);
      expect(s.writes).toEqual(['POST /v1/hr/compliance/working-time/settings/maxDailyWorkMinutes']);
      await s.page.click('#lang');
      await says(s.page, '#wt-h', /^பணி நேர வரம்புகளும் விடுப்பும் \(கடைகள் சட்டம்\)$/);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  }, 120_000);

  it('C18 · OB-156: Staff list — sick leave recorded NOT CHECKED; the three registers read back', async () => {
    const s = await openAs(shop, browser, MGR, '/staff');
    try {
      await s.page.waitForSelector('#hr-lv-save');
      await s.page.fill('#hr-lv-emp', EMP); await s.page.fill('#hr-lv-date', '2026-11-03');
      await s.page.selectOption('#hr-lv-type', 'sick');
      await s.page.click('#hr-lv-save');
      await says(s.page, '#hr-lv-done', /E-W5-2 · 2026-11-03 · Sick leave · Leave taken · recorded — NOT CHECKED/);
      for (const [which, from, to, asOf, expected] of [
        ['attendance', '2026-11-01', '2026-11-15', '', /E-W5-2 · Staff B/],
        ['leave', '', '', '2026-11-30', /E-W5-2 · Staff B/],
        ['holidays', '2026-11-09', '2026-11-15', '', /E-W5-2 · Staff B.*2026-11-09: \d+ days off/],
      ] as const) {
        await s.page.selectOption('#hr-reg-which', which);
        await s.page.fill('#hr-reg-from', from); await s.page.fill('#hr-reg-to', to); await s.page.fill('#hr-reg-asof', asOf);
        await s.page.click('#hr-reg-show');
        await says(s.page, `#hr-reg-out[data-register="${which}"]`, expected);
      }
      await says(s.page, '#hr-reg-out', /Not checked \(not set yet\):/);
      expect(s.writes).toEqual([`POST /v1/hr/compliance/leave/${EMP}/2026-11-03`]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  }, 120_000);

  it('C18 · OB-152 · OB-166 · OB-142: Staff schedule — a breach is refused by head office; the fixed week is published; standards and labour cost', async () => {
    let s = await openAs(shop, browser, MGR, '/schedule');
    try {
      await s.page.waitForSelector('#rc-check');
      await s.page.fill('#rc-branch', 'br-1'); await s.page.fill('#rc-week', WEEK);
      await s.page.click('#rc-check');
      await says(s.page, '#rc-verdict[data-publishable="false"]', /Breaks the limits:.*Staff B/);
      await s.page.click('#rc-publish');
      await says(s.page, '#rc-status', /^Head office refused: The roster for the week of 2026-11-09 was not published: it breaks the working-time limits/);
      // The manager shortens the shift (a new version of it), and the week checks clean and is published.
      await ok(call(MGR, '/v1/hr/workforce/shifts/SH-W5-1', shift(8)), 'shorter shift');
      await s.page.click('#rc-check');
      await says(s.page, '#rc-verdict[data-publishable="true"]', /^Can be published\.$/);
      await says(s.page, '#rc-notchecked', /Not checked \(not set yet\):/);
      await s.page.click('#rc-publish');
      await says(s.page, '#rc-published', /^Published\. Published with \d+ working-time limit\(s\) NOT checked/);
      await says(s.page, `#rp-out [data-week="${WEEK}"][data-state="published"]`, /2026-11-09 – 2026-11-15published/);
      await s.page.fill('#lc-date', '2026-11-02'); await s.page.fill('#lc-sales', '10000');
      await s.page.click('#lc-show');
      await says(s.page, '#lc-line', /^Labour cost ₹800\.00 · 8\.00% of sales · guide not set$/);
      expect(await s.page.locator('#ls-save').count(), 'the service standard is the owner\'s').toBe(0);
      expect(s.writes.filter((w) => w.startsWith('POST /v1/hr/compliance/roster-publications/')).length).toBe(2);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    s = await openAs(shop, browser, OWNER, '/schedule');
    try {
      await says(s.page, '#ls-out', /No service standard is set yet/);
      await s.page.fill('#ls-role', 'cashier'); await s.page.fill('#ls-n', '20');
      await s.page.click('#ls-save');
      await says(s.page, '#ls-out [data-role="cashier"]', /cashier: 20.*set by u-owner/);
      expect(s.writes).toEqual(['POST /v1/hr/workforce/labour-standards/cashier']);
      await s.page.click('#lang');
      await says(s.page, '#rc-h', /^வாரப் பணிமுறையைச் சரிபார்த்து வெளியிடு$/);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  }, 180_000);
});
