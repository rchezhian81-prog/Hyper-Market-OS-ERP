import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startRealCloud, type RealCloud } from '../support/real-store';
import { startPageShell, type PageShell } from './lib/page-shell';
import { auditPage } from './lib/a11y-audit';
import { DOMAIN_TEMPLATE_VIEWS } from '../../services/purchase/src/import-templates-domains';
import { tradingDayIn } from '../../packages/calendar/src/index';

/**
 * **OB-288 lane 4 · P2 — the owner's alerts and schedules page, and the further import templates on the import console, in a
 * real browser on the PRODUCTION API over PostgreSQL.**
 *   • Owner alerts and schedules (M29-FR-03/04): the five alerts each say "Not set — this alert does not fire until you
 *     enter it"; the owner types a number and saves it; "Check now" sends the voided-bills alert to his inbox and the
 *     page says it is there; he schedules "Sales by day" and it is prepared at once ("Prepared, not sent" while sending is
 *     switched off). A manager reads the page but has no save buttons; a cashier opens nothing. English and Tamil; every
 *     button its icon; the page passes the accessibility audit.
 *   • The import console (OB-315): the owner picks "Customers from the old system", pastes a file with one customer who
 *     never said yes to loyalty, checks it, and the preview names that line — nothing is loaded.
 * Needs DATABASE_URL and the pre-installed Chromium; else it SKIPS. Synthetic data only.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['owner', 'alerts', 'e2e', 'key'].join('-').padEnd(48, '0');
const OWNER = 'u-owner'; const MGR = 'u-mgr'; const CASHIER = 'u-cash'; const BOX = 'u-box';

async function ok(p: Promise<{ status: number; body: unknown }>, label: string): Promise<unknown> {
  const r = await p;
  if (r.status >= 300) throw new Error(`${label}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('owner alerts and schedules, and the further import templates (OB-288 lane 4 · P2), on the production API', () => {
  let browser: Browser;
  let cloud: RealCloud;
  let alertsShell: PageShell;
  let dataIoShell: PageShell;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    cloud = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId: randomUUID(), owner: OWNER, packSigningKey: KEY });
    await cloud.grant(MGR, 'store_manager');
    await cloud.grant(CASHIER, 'cashier');
    await cloud.grant(BOX, 'store_computer', undefined, ['S1']);
    const day = tradingDayIn(new Date().toISOString(), { timeZone: 'Asia/Kolkata', tradingDayCutoff: '00:00' });
    const at = new Date().toISOString();
    for (const [id, bill] of [['V-1', 'B-1'], ['V-2', 'B-2']] as const) {
      await ok(cloud.request({ method: 'POST', path: `/v1/loss-prevention/activity/${id}/synced`, userId: BOX, branchId: 'S1', idempotencyKey: `act-${id}`, body: { activityId: id, kind: 'void', laneId: 'lane-1', cashierId: 'c-1', billRef: bill, lineId: 'L1', productId: 'P1', description: 'Rice', valueMinor: 30_000, reason: 'customer_changed_mind', at, tradingDay: day } }), `void ${id}`);
    }
    await ok(cloud.request({ method: 'POST', path: '/v1/sales', userId: CASHIER, idempotencyKey: 'sale-1', body: { saleId: 'B-9', receiptNumber: 'R-9', laneId: 'lane-1', locationId: 'S1', cashierId: CASHIER, tradingDay: day, committedAt: at, totalMinor: 30_000, currency: 'INR', packVersion: 1, lines: [{ productId: 'P1', quantityMinor: 1, uom: 'ea', unitPriceMinor: 30_000, lineTotalMinor: 30_000 }], tenders: [{ kind: 'cash', amountMinor: 30_000 }] } }), 'sale');
    alertsShell = await startPageShell({ cloud: () => cloud, page: { path: '/owner-alerts', html: 'owner-alerts.html', dataGlobal: 'ownerAlertsData' } });
    dataIoShell = await startPageShell({ cloud: () => cloud, page: { path: '/data-io', html: 'data-io.html', dataGlobal: 'dataIoData' }, extra: { importTemplates: [...DOMAIN_TEMPLATE_VIEWS] } });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await alertsShell?.stop(); await dataIoShell?.stop(); await cloud?.stop(); });

  const open = async (shell: PageShell, who: string, path: string): Promise<{ page: Page; errors: string[]; close: () => Promise<void> }> => {
    const context = await browser.newContext();
    await shell.signIn(context, who);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${shell.base}${path}`, { waitUntil: 'load' });
    return { page, errors, close: () => context.close() };
  };
  const waitText = (page: Page, selector: string, text: string) => page.waitForFunction(([sel, want]) => {
    const node = (globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector(sel!);
    return (node?.textContent ?? '').includes(want!);
  }, [selector, text], { timeout: 15_000 });

  it('the owner: five alerts "not set"; he sets one; "Check now" puts it in his inbox; he schedules a report and it is prepared; Tamil', async () => {
    const { page, errors, close } = await open(alertsShell, OWNER, '/owner-alerts');
    await page.locator('#t-rows li[data-kind="voided_bill"]').waitFor({ timeout: 15_000 });
    expect(await page.locator('#t-rows li[data-state="not_set"]').count()).toBe(5);
    expect((await page.textContent('#t-rows li[data-kind="cash_short"]')) ?? '').toContain('Not set — this alert does not fire until you enter it.');
    await waitText(page, '#d-rows li[data-kind="voided_bill"]', 'Not set');
    // A bad number is refused on the page, and nothing is saved.
    const row = page.locator('#t-rows li[data-kind="voided_bill"]');
    await row.locator('input.threshold-value').fill('two');
    await row.locator('button[data-act="save"]').click();
    await waitText(page, '#t-status', 'Type a whole number, at least 1.');
    await row.locator('input.threshold-value').fill('2');
    expect(await row.locator('button[data-act="save"] svg').count()).toBe(1);
    await row.locator('button[data-act="save"]').click();
    await waitText(page, '#t-status', 'Saved.');
    await waitText(page, '#t-rows li[data-kind="voided_bill"]', 'Set to 2');
    expect(await page.locator('#t-rows li[data-state="not_set"]').count()).toBe(4);
    // After-hours: set, but it cannot fire — said.
    const ah = page.locator('#t-rows li[data-kind="after_hours_login"]');
    await ah.locator('input.threshold-value').fill('8-23');
    await ah.locator('button[data-act="save"]').click();
    await waitText(page, '#t-rows li[data-kind="after_hours_login"]', 'cannot fire');
    // Check now → the voided-bills alert is in his inbox, and the page says so.
    expect(await page.locator('#d-check svg').count()).toBe(1);
    await page.click('#d-check');
    await waitText(page, '#d-status', 'Alerts newly sent to your inbox: 1');
    await waitText(page, '#d-alerts', 'in your alert inbox');
    const inbox = (await cloud.request({ method: 'GET', path: '/v1/platform/alerts/inbox', userId: OWNER })).body as { alerts: { alert: { alertId: string } }[] };
    expect(inbox.alerts.some((a) => a.alert.alertId.includes('voided_bill'))).toBe(true);
    // A schedule: "Sales by day" at 00:00 — prepared at once, and said "not sent" while sending is off.
    await page.fill('#s-id', 's-daily'); await page.selectOption('#s-kind', 'report'); await page.fill('#s-target', 'sales_by_day'); await page.fill('#s-time', '00:00');
    expect(await page.locator('#s-save svg').count()).toBe(1);
    await page.click('#s-save');
    await page.locator('#s-rows li[data-schedule="s-daily"]').waitFor({ timeout: 15_000 });
    await page.click('#s-run');
    await waitText(page, '#s-status', 'Prepared: 1');
    await waitText(page, '#s-rows li[data-schedule="s-daily"]', 'Prepared, not sent');
    expect(await auditPage(page, { expectLang: 'en', minTarget: 56 }), 'the owner alerts page').toEqual([]);
    await page.click('#lang');
    expect(await page.textContent('#page-h')).toBe('உரிமையாளர் எச்சரிக்கைகள் மற்றும் திட்டமிட்ட அறிக்கைகள்');
    await waitText(page, '#t-rows li[data-kind="cash_short"]', 'அமைக்கப்படவில்லை');
    expect(errors).toEqual([]);
    await close();
  }, 120_000);

  it('a manager reads the alerts but cannot set them; a cashier opens nothing', async () => {
    const m = await open(alertsShell, MGR, '/owner-alerts');
    await m.page.locator('#t-rows li[data-kind="voided_bill"]').waitFor({ timeout: 15_000 });
    expect(await m.page.locator('#t-rows button[data-act="save"]').count()).toBe(0);
    expect(await m.page.isHidden('#d-check')).toBe(true);
    expect(m.errors).toEqual([]);
    await m.close();
    const c = await open(alertsShell, CASHIER, '/owner-alerts');
    await waitText(c.page, '#page-status', 'Your role cannot open this page.');
    expect(await c.page.isHidden('#thresholds')).toBe(true);
    await c.close();
  }, 60_000);

  it('the import console checks a customer file: the one with no recorded yes to loyalty is named, and nothing loads', async () => {
    const { page, errors, close } = await open(dataIoShell, OWNER, '/data-io');
    await page.locator('#import-template option[value="customer-v1"]').waitFor({ state: 'attached', timeout: 15_000 });
    await page.selectOption('#import-template', 'customer-v1');
    await page.fill('#import-file', ['mobile,loyaltyConsent,consentGivenOn,consentEvidence,name', '9876543210,yes,2025-04-01,paper form,Lakshmi R', '9876543211,no,2025-04-01,paper form,'].join('\n'));
    await page.click('#validate');
    await page.locator('#preview:not([hidden])').waitFor({ timeout: 15_000 });
    const preview = (await page.textContent('#preview')) ?? '';
    expect(preview).toContain('no recorded yes to loyalty');
    expect(preview).not.toContain('9876543211');
    const members = (await cloud.request({ method: 'POST', path: '/v1/loyalty/members/lookup', userId: OWNER, idempotencyKey: 'look-1', body: { mobile: '9876543210' } })).body as { member: boolean };
    expect(members.member).toBe(false);
    expect(errors).toEqual([]);
    await close();
  }, 60_000);
});
