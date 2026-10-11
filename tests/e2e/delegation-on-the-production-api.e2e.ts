import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';

/**
 * **The Delegation page, in a real browser, on the PRODUCTION API over real PostgreSQL (M02-FR-03 · §28 · hard rule 4 —
 * EA-10's M02 proof gap: "browser proof of delegation on the real API").**
 *
 * The page is served in front of the real API (no stub): who is looking comes from head office's own
 * `GET /v1/identity/me`; every `/v1` call goes to the API under the signed-in person's token. Through Chromium:
 *
 *   • the owner lends the br-1 manager's refund authority to an assistant for twenty days, capped at ₹2,000 — head office
 *     answers that the OWNER authorised it (from the session, never the page), and the assistant's effective authority is
 *     now "delegated" on the manager's behalf, at br-1 only, up to ₹2,000 (read back from head office, not the page);
 *   • refused in head office's words, nothing recorded: lending to the same person (self-delegation); the manager
 *     lending HIS OWN authority unsupervised (§28 — a separate person must authorise); a cap above the lender's limit;
 *   • the owner ends it early: it shows "Ended early" and head office no longer gives the assistant the authority;
 *   • the delegations survive a RESTART of the API; a cashier, who may not read delegations, is told so.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['delegation', 'e2e', 'production', 'signing', 'key'].join('-').padEnd(48, '0');
const ASSISTANT = 'u-asst'; const CASHIER = 'u-cash-dl';
const TODAY = new Date().toISOString().slice(0, 10);
// Twenty days: inside the 90-day maximum, and beyond the 7-day "ends soon" warning, so it reads as lent now.
const UNTIL = new Date(Date.now() + 19 * 86_400_000).toISOString().slice(0, 10);

interface Row { delegationId: string; fromUserId: string; toUserId: string; untilDate: string; state: string; detail: string }

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the Delegation page on the production API, in a real browser (M02-FR-03 · §28)', () => {
  let browser: Browser;
  let shop: InboxShop;

  const rowsAtHeadOffice = async (): Promise<Row[]> => ((await shop.cloud().request({ method: 'GET', path: '/v1/access/delegations', userId: OWNER })).body as { rows: Row[] }).rows;
  const authorityOf = async (userId: string): Promise<{ source: string; onBehalfOf?: string }> => (await shop.cloud().request({
    method: 'POST', path: '/v1/access/delegations/effective-authority', userId: OWNER, idempotencyKey: `ea-${randomUUID()}`, body: { userId, subjectType: 'refund' },
  })).body as { source: string };

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/delegation', html: 'delegation.html', dataGlobal: 'delegationData' },
      seed: async (cloud) => { await cloud.grant(CASHIER, 'cashier'); await cloud.grant(ASSISTANT, 'cashier'); },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 120_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  // The br-1 manager signs in AT br-1 — their grant reaches that branch only.
  const open = async (who: string) => {
    const context = await browser.newContext();
    await shop.signIn(context, who, who === MGR ? 'br-1' : undefined);
    const page = await context.newPage();
    const writes: string[] = []; const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${u.pathname.replace(/dlg-[^/]+/, 'dlg-…')}`); });
    await page.goto(`${shop.base}/delegation`, { waitUntil: 'load' });
    return { page, writes, errors, close: () => context.close() };
  };
  const statusSays = async (page: Page, id: string, expected: RegExp): Promise<void> => {
    await page.waitForFunction(([i, source]) => new RegExp(source!).test((globalThis as unknown as { document: { getElementById(x: string): { textContent: string | null } | null } }).document.getElementById(i!)?.textContent ?? ''), [id, expected.source], { timeout: 15_000 });
  };
  const lend = async (page: Page, from: string, to: string, cap: string, reason: string): Promise<void> => {
    await page.fill('#from', from);
    await page.fill('#to', to);
    await page.fill('#from-date', TODAY);
    await page.fill('#until-date', UNTIL);
    await page.fill('#cap', cap);
    await page.check('input[name="kind"][value="refund"]');
    await page.fill('#reason', reason);
    await page.click('#lend');
  };

  it('the owner lends the manager\'s refund authority, time-boxed and capped; head office records it as the owner\'s act', async () => {
    expect((await authorityOf(ASSISTANT)).source).toBe('none');
    const s = await open(OWNER);
    try {
      await statusSays(s.page, 'rows', /No authority is lent right now/);
      expect(s.writes, 'nothing is written on open').toEqual([]);
      // Refused, nothing recorded: lending to the same person.
      await lend(s.page, MGR, MGR, '2000', 'cover');
      await statusSays(s.page, 'lend-status', /^Head office refused: delegating to yourself/);
      // The real one — and head office's own answer to it (who authorised it comes from the session, not the page).
      const answered = s.page.waitForResponse((r) => r.request().method() === 'POST' && r.status() === 201 && r.url().includes('/v1/access/delegations/'));
      await lend(s.page, MGR, ASSISTANT, '2000', 'Manager on leave for twenty days');
      expect(await (await answered).json()).toMatchObject({ fromUserId: MGR, toUserId: ASSISTANT, untilDate: UNTIL, authorisedBy: OWNER });
      await statusSays(s.page, 'lend-status', /^Lent — head office recorded it, authorised by you/);
      await s.page.locator('#rows li.lend.state-active').waitFor({ timeout: 15_000 });
      expect(await s.page.locator('#rows li.lend').innerText()).toMatch(new RegExp(`${MGR} lends to ${ASSISTANT}[\\s\\S]*Lent now[\\s\\S]*until ${UNTIL}`));
      expect(s.writes).toEqual(['POST /v1/access/delegations/dlg-…', 'POST /v1/access/delegations/dlg-…']);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    // Head office's own record: one delegation, authorised by the owner; the assistant now approves refunds under it.
    const rows = await rowsAtHeadOffice();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ fromUserId: MGR, toUserId: ASSISTANT, untilDate: UNTIL, state: 'active' });
    // The assistant now approves refunds as THEMSELVES on the manager's behalf — at br-1 only, up to ₹2,000.
    expect(await authorityOf(ASSISTANT)).toMatchObject({ source: 'delegated', onBehalfOf: MGR, branchScope: ['br-1'], authorityLimit: { minor: 200_000, currency: 'INR' } });
  }, 120_000);

  it('the manager cannot lend his OWN authority unsupervised (§28) — refused in head office\'s words, nothing recorded', async () => {
    const s = await open(MGR);
    try {
      await s.page.locator('#rows li.lend').first().waitFor({ timeout: 15_000 });
      await lend(s.page, MGR, 'u-other', '1000', 'I am going away');
      await statusSays(s.page, 'lend-status', /^Head office refused: a delegation needs a separate person to authorise it/);
    } finally { await s.close(); }
    expect(await rowsAtHeadOffice()).toHaveLength(1);
  }, 60_000);

  it('survives a restart; the owner ends it early and head office stops giving the authority; a cashier is told they may not read it', async () => {
    await shop.restart();
    let s = await open(OWNER);
    try {
      const row = s.page.locator('#rows li.lend.state-active');
      await row.waitFor({ timeout: 15_000 });
      await row.locator('button[data-act="end"]').click();
      await statusSays(s.page, 'list-status', /^Ended/);
      await s.page.locator('#rows li.lend.state-revoked').waitFor({ timeout: 15_000 });
      expect(await s.page.locator('#rows li.lend').innerText()).toContain('Ended early');
    } finally { await s.close(); }
    expect((await rowsAtHeadOffice())[0]).toMatchObject({ state: 'revoked' });
    expect((await authorityOf(ASSISTANT)).source).toBe('none');

    s = await open(CASHIER);
    try {
      await statusSays(s.page, 'list-status', /Your role cannot read delegations/);
      expect(await s.page.locator('#lend-section').isHidden()).toBe(true);
      await s.page.click('#lang');
      expect(await s.page.locator('#title').innerText()).toBe('அதிகாரப் பகிர்வு');
      expect(s.writes).toEqual([]);
    } finally { await s.close(); }
  }, 120_000);
});
