import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';

/**
 * **The Incidents and recovery-drills page, in a real browser, on the PRODUCTION API over real PostgreSQL (M35-FR-02/04 ·
 * WF-20 · §32).**
 *
 * The page is served in front of the real API (no stub): who is looking comes from head office's own
 * `GET /v1/identity/me`; every `/v1` call goes to the API under the signed-in person's token. Through Chromium:
 *
 *   • nothing is written on open; the owner records an incident (the page's one primary action) and its record drawer
 *     opens from head office's own read;
 *   • a follow-up owned by somebody who works nowhere here is refused in head office's words; one owned by the store
 *     manager is added with its date; closing before a post-mortem is refused in head office's words; the post-mortem is
 *     written and the incident is closed in the owner's own name;
 *   • a recovery drill that took 45 minutes against the 30-minute store target is recorded — and recorded as MISSED;
 *   • after a RESTART of the API, the register and head office's own record say the same (closed by the owner, with
 *     its post-mortem; the missed drill kept);
 *   • a cashier (no operations rights) is offered nothing and head office refuses the read; the page reads in Tamil;
 *     no page errors.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['incidents', 'e2e', 'production', 'signing', 'key'].join('-').padEnd(48, '0');
const CASHIER = 'u-cash-br1';

interface IncidentRow { incidentId: string; title: string; state: string; closedBy: string | null; hasPostmortem: boolean; openActions: number }

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the Incidents and recovery-drills page on the production API, in a real browser (M35-FR-02/04)', () => {
  let browser: Browser;
  let shop: InboxShop;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/incidents', html: 'incidents.html', dataGlobal: 'incidentsData' },
      seed: async (cloud) => {
        const gid = `grant-${CASHIER}`;
        await ok(cloud.request({ method: 'POST', path: '/v1/identity/grants', userId: 'u-hr', idempotencyKey: `${gid}-ask`, body: { grantId: gid, userId: CASHIER, roleId: 'cashier', branchScope: ['br-1'], reason: 'till at br-1' } }), 'ask cashier grant');
        await ok(cloud.request({ method: 'POST', path: `/v1/identity/grants/${gid}/approve`, userId: OWNER, idempotencyKey: `${gid}-approve`, body: {} }), 'approve cashier grant');
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 120_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  const open = async (who: string, branch?: string) => {
    const context = await browser.newContext();
    await shop.signIn(context, who, branch);
    const page = await context.newPage();
    const writes: string[] = []; const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${u.pathname}`); });
    await page.goto(`${shop.base}/incidents`, { waitUntil: 'load' });
    return { page, writes, errors, close: () => context.close() };
  };
  const says = async (page: Page, id: string, expected: RegExp): Promise<void> => {
    await page.waitForFunction(([i, source]) => new RegExp(source!).test((globalThis as unknown as { document: { getElementById(x: string): { textContent: string | null } | null } }).document.getElementById(i!)?.textContent ?? ''), [id, expected.source], { timeout: 15_000 });
  };
  const board = async (): Promise<IncidentRow[]> => ((await shop.cloud().request({ method: 'GET', path: '/v1/platform/incidents', userId: OWNER })).body as { incidents: IncidentRow[] }).incidents;

  it('the owner records an incident, names a follow-up owner, writes the post-mortem, closes it; a missed drill is kept; all survive a restart', async () => {
    let s = await open(OWNER);
    let incidentId = '';
    try {
      await says(s.page, 'no-incidents', /No incident has been recorded/);
      await says(s.page, 'v-open', /^0$/);
      await says(s.page, 'v-posture', /No drill recorded yet/);
      expect(s.writes, 'nothing is written on open').toEqual([]);

      // The page's one primary action.
      await s.page.click('#open-new');
      await s.page.fill('#n-title', 'Store 1 stopped syncing');
      await s.page.selectOption('#n-severity', 'sev2');
      await s.page.fill('#n-summary', 'The store computer has not reported since 09:10; the tills still sell.');
      await s.page.click('#n-save');
      await says(s.page, 'r-title', /Store 1 stopped syncing/);
      expect(await s.page.locator('#sheet').isVisible()).toBe(true);
      incidentId = (await s.page.locator('#sheet').getAttribute('data-incident'))!;
      expect(incidentId).toMatch(/^inc-/);
      await says(s.page, 'v-open', /^1$/);
      expect(await s.page.locator(`#incident-rows tr[data-incident="${incidentId}"]`).count()).toBe(1);

      // The timeline, in the owner's own name.
      await s.page.fill('#t-when', '2026-10-12T09:10');
      await s.page.fill('#t-note', 'Router at store 1 lost power');
      await s.page.click('#t-add');
      await says(s.page, 'record-status', /^Added to the timeline/);
      await says(s.page, 'r-timeline', /Router at store 1 lost power \(u-owner\)/);

      // A follow-up owned by somebody who works nowhere here: head office refuses it, in its words.
      await s.page.fill('#a-desc', 'Put the router on the UPS');
      await s.page.fill('#a-owner', 'u-nobody-here');
      await s.page.fill('#a-due', '2026-10-20');
      await s.page.click('#a-add');
      await says(s.page, 'record-status', /^Head office refused: u-nobody-here holds no sign-in at this shop/);
      // The store manager owns it.
      await s.page.fill('#a-owner', MGR);
      await s.page.click('#a-add');
      await says(s.page, 'record-status', /^Follow-up added with its named owner/);
      await says(s.page, 'r-actions', new RegExp(`Put the router on the UPS — owner ${MGR}, due 2026-10-20`));

      // Closing before a post-mortem: refused in head office's words; it stays open.
      await s.page.fill('#c-note', 'Power restored');
      await s.page.click('#c-close');
      await says(s.page, 'record-status', /^Head office refused: Incident .* has no post-mortem yet/);

      await s.page.fill('#pm-cause', 'The router had no backup power.');
      await s.page.fill('#pm-impact', 'Head office figures were 40 minutes old; no sale was lost.');
      await s.page.fill('#pm-change', 'Router on the UPS; alert the store manager after 15 minutes.');
      await s.page.click('#pm-save');
      await says(s.page, 'record-status', /^Post-mortem saved — version 1/);
      await s.page.click('#c-close');
      await says(s.page, 'record-status', /^Closed in your name/);
      await says(s.page, 'r-meta', /Closed by u-owner/);
      expect(await s.page.locator('#r-close-form').isHidden()).toBe(true); // nothing changes on a closed incident
      await says(s.page, 'v-open', /^0$/);
      await says(s.page, 'v-actions', /^1$/); // the open follow-up stays listed with its owner
      await s.page.click('#r-close');

      // A recovery drill: 45 minutes against the 30-minute store target — recorded, as MISSED.
      await s.page.click('#tab-drills');
      await s.page.fill('#d-id', '2026-Q4 store computer');
      await s.page.selectOption('#d-service', 'store-edge (committed sales)');
      await s.page.fill('#d-loss', 'zero');
      await s.page.fill('#d-back', '45');
      await s.page.click('#d-save');
      await says(s.page, 'drill-status', /Write the numbers as whole numbers/); // refused on the page; nothing sent
      await s.page.fill('#d-loss', '0');
      await s.page.click('#d-save');
      await says(s.page, 'drill-status', /^Drill recorded: took 2700s to recover against an RTO of 1800s/);
      await says(s.page, 'v-drills', /0 passed · 1 missed/);
      await says(s.page, 'v-posture', /store-edge \(committed sales\): MISSED/);

      expect(s.writes).toEqual([
        `POST /v1/platform/incidents/${incidentId}`, `POST /v1/platform/incidents/${incidentId}/timeline`,
        expect.stringMatching(new RegExp(`^POST /v1/platform/incidents/${incidentId}/actions/act-`)), expect.stringMatching(new RegExp(`^POST /v1/platform/incidents/${incidentId}/actions/act-`)),
        `POST /v1/platform/incidents/${incidentId}/close`, `POST /v1/platform/incidents/${incidentId}/postmortem`, `POST /v1/platform/incidents/${incidentId}/close`,
        'POST /v1/platform/dr-drills',
      ]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    // Head office's own record, not the page — after a restart of the API.
    await shop.restart();
    const rows = await board();
    expect(rows.find((r) => r.incidentId === incidentId)).toMatchObject({ title: 'Store 1 stopped syncing', state: 'closed', closedBy: OWNER, hasPostmortem: true, openActions: 1 });
    const one = (await shop.cloud().request({ method: 'GET', path: `/v1/platform/incidents/${incidentId}`, userId: OWNER })).body as { incident: { openedBy: string; postmortem: { by: string; version: number }; actions: { ownerUserId: string }[] } };
    expect(one.incident).toMatchObject({ openedBy: OWNER, postmortem: { by: OWNER, version: 1 }, actions: [{ ownerUserId: MGR }] });
    const drills = (await shop.cloud().request({ method: 'GET', path: '/v1/platform/dr-drills', userId: OWNER })).body as { drills: { drillId: string; drilledBy: string; result: { passed: boolean } }[] };
    expect(drills.drills).toEqual([expect.objectContaining({ drillId: '2026-Q4 store computer', drilledBy: OWNER, result: expect.objectContaining({ passed: false }) })]);

    // The page reads it back from head office after the restart.
    s = await open(OWNER);
    try {
      await s.page.locator(`#incident-rows tr[data-incident="${incidentId}"][data-state="closed"]`).waitFor({ timeout: 15_000 });
      await s.page.click('#tab-drills');
      await s.page.locator('#drill-rows tr[data-drill="2026-Q4 store computer"][data-passed="false"]').waitFor({ timeout: 15_000 });
      // In Tamil too.
      await s.page.click('#lang');
      expect(await s.page.locator('#title').innerText()).toBe('சம்பவங்களும் மீட்பு ஒத்திகைகளும்');
      expect(await s.page.locator('#d-save').innerText()).toBe('ஒத்திகையைப் பதிவு செய்');
      expect(s.writes).toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  }, 180_000);

  it('a cashier is offered nothing, and head office refuses the read; nothing is written', async () => {
    const s = await open(CASHIER, 'br-1');
    try {
      await says(s.page, 'page-status', /Your role cannot read incidents or drills/);
      expect(await s.page.locator('#open-new').isHidden()).toBe(true);
      expect(await s.page.locator('#drill-form').isHidden()).toBe(true);
      const status = await s.page.evaluate(async () => (await fetch('/v1/platform/incidents', { credentials: 'same-origin' })).status);
      expect(status).toBe(403);
      expect(s.writes).toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  }, 60_000);
});
