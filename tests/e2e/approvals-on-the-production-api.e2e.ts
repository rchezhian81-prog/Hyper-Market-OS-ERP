import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, OWNER, type InboxShop } from './lib/ai-inbox-shop';

/**
 * **The Approvals page, in a real browser, on the PRODUCTION API over real PostgreSQL (M02-FR-03 · ADR-0024 · §28 —
 * EA-10's M02 proof gap: "browser proof of approvals on the real API").**
 *
 * The page is served in front of the real API (no stub): the screen data comes from head office's own
 * `GET /v1/identity/me`, every `/v1` call goes to the API under the signed-in person's token. The maker (u-hr, a store
 * manager holding `identity.role.request`) asks for an access change through the real route; then, through Chromium:
 *
 *   • the owner (the checker) opens Approvals and sees the maker's request read LIVE, in plain words, nothing written;
 *   • Approve with no reason sends nothing; with a reason the real API records the decision IN THE OWNER'S NAME — read
 *     back from head office, not from the page;
 *   • a second request is rejected with a reason, and the MAKER, opening the page in their own session, sees both
 *     outcomes under "What you asked for" — and never sees their own request waiting for them (no self-approval);
 *   • a cashier, who holds no approval authority, sees nothing waiting.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['approvals', 'e2e', 'production', 'signing', 'key'].join('-').padEnd(48, '0');
const MAKER = 'u-hr'; const CASHIER = 'u-cash-ap'; const OWNER2 = 'u-owner-2';

interface Live { requestId: string; status: string; decidedBy?: string; decisionReason?: string; requestedBy: string }

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the Approvals page on the production API, in a real browser (M02-FR-03 · §28)', () => {
  let browser: Browser;
  let shop: InboxShop;
  const ids: string[] = [];

  const ask = async (subjectRef: string, reason: string): Promise<string> => {
    const r = await shop.cloud().request({
      method: 'POST', path: '/v1/approvals/requests', userId: MAKER, idempotencyKey: `ask-${subjectRef}`,
      body: { kind: 'access_change', subjectRef, valueMinor: null, details: { userId: subjectRef, event: 'joiner', roleId: 'cashier' }, summary: `Give ${subjectRef} the cashier role`, reason },
    });
    if (r.status !== 201) throw new Error(`ask: ${r.status} ${JSON.stringify(r.body)}`);
    return (r.body as { requestId: string }).requestId;
  };
  const inboxOf = async (who: string) => (await shop.cloud().request({ method: 'GET', path: '/v1/approvals/requests', userId: who })).body as { waitingForMe: Live[]; mine: Live[] };

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/approvals', html: 'approvals.html', dataGlobal: 'approvalsData' },
      seed: async (cloud) => { await cloud.grant(CASHIER, 'cashier'); await cloud.grant(OWNER2, 'owner'); },
    });
    ids.push(await ask('u-new-anita', 'Anita starts on the tills on Monday'));
    ids.push(await ask('u-new-ravi', 'Ravi asked for till access'));
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await shop?.stop();
  });

  const open = async (who: string) => {
    const context = await browser.newContext();
    await shop.signIn(context, who);
    const page = await context.newPage();
    const writes: string[] = [];
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${u.pathname}`); });
    await page.goto(`${shop.base}/approvals`, { waitUntil: 'load' });
    return { page, writes, errors, close: () => context.close() };
  };
  const result = async (page: Page, expected: RegExp): Promise<void> => {
    await page.waitForFunction((source) => {
      const doc = (globalThis as unknown as { document: { getElementById(i: string): { hidden: boolean; textContent: string | null } | null } }).document;
      const box = doc.getElementById('result');
      return box !== null && !box.hidden && new RegExp(source).test(doc.getElementById('result-text')?.textContent ?? '');
    }, expected.source, { timeout: 15_000 });
  };

  it('the owner sees the maker\'s requests live; no reason sends nothing; approving records the decision in the owner\'s name', async () => {
    const { page, writes, errors, close } = await open(OWNER);
    try {
      const row = page.locator(`#waiting li[data-request-id="${ids[0]!}"]`);
      await row.waitFor({ timeout: 15_000 });
      expect(writes, 'nothing is written on open').toEqual([]);
      expect(await page.locator('#sample').isHidden()).toBe(true);
      const text = await row.innerText();
      expect(text).toContain('Give u-new-anita the cashier role');
      expect(text).toContain(`Asked by: ${MAKER}`);
      expect(text).toContain('Why: Anita starts on the tills on Monday');

      await row.locator('button.approve').click();
      await result(page, /Write a reason first/);
      expect(writes, 'no decision leaves the page without a reason').toEqual([]);

      await row.locator('input.reason').fill('Checked the rota — she starts Monday');
      await row.locator('button.approve').click();
      await result(page, /^Approved\./);
      await row.waitFor({ state: 'detached', timeout: 15_000 });
      expect(writes).toEqual([`POST /v1/approvals/requests/${ids[0]!}/decide`]);
      expect(errors).toEqual([]);
    } finally { await close(); }
    // Read back from head office — the decision is the owner's, with the owner's reason.
    const mine = (await inboxOf(MAKER)).mine.find((r) => r.requestId === ids[0]);
    expect(mine).toMatchObject({ status: 'approved', decidedBy: OWNER, decisionReason: 'Checked the rota — she starts Monday' });
  }, 90_000);

  it('the owner rejects the second with a reason; the maker sees both outcomes and never their own request to decide', async () => {
    let s = await open(OWNER);
    try {
      const row = s.page.locator(`#waiting li[data-request-id="${ids[1]!}"]`);
      await row.waitFor({ timeout: 15_000 });
      await row.locator('input.reason').fill('Ravi is not on the staff list yet');
      await row.locator('button.reject').click();
      await row.waitFor({ state: 'detached', timeout: 15_000 });
    } finally { await s.close(); }
    expect((await inboxOf(MAKER)).mine.find((r) => r.requestId === ids[1])).toMatchObject({ status: 'rejected', decidedBy: OWNER });

    s = await open(MAKER);
    try {
      await s.page.locator(`#mine li[data-request-id="${ids[1]!}"]`).waitFor({ timeout: 15_000 }).catch(() => undefined);
      await s.page.waitForFunction(() => /Rejected by/.test((globalThis as unknown as { document: { getElementById(i: string): { textContent: string | null } | null } }).document.getElementById('mine')?.textContent ?? ''), undefined, { timeout: 15_000 });
      const mine = await s.page.locator('#mine').innerText();
      expect(mine).toContain(`Approved by ${OWNER}`);
      expect(mine).toContain(`Rejected by ${OWNER}: Ravi is not on the staff list yet`);
      expect(await s.page.locator('#waiting > li').count(), 'a maker never decides their own request').toBe(0);
      expect(s.writes).toEqual([]);
    } finally { await s.close(); }
  }, 90_000);

  it('a second owner who ASKS for something never sees it waiting for them — though they could decide anyone else\'s', async () => {
    const r = await shop.cloud().request({
      method: 'POST', path: '/v1/approvals/requests', userId: OWNER2, idempotencyKey: 'ask-own2',
      body: { kind: 'access_change', subjectRef: 'u-new-kumar', valueMinor: null, details: { userId: 'u-new-kumar', event: 'joiner', roleId: 'cashier' }, summary: 'Give u-new-kumar the cashier role', reason: 'Kumar covers weekends' },
    });
    expect(r.status).toBe(201);
    const own = (r.body as { requestId: string }).requestId;
    const other = await ask('u-new-priya', 'Priya joins the evening shift');
    const s = await open(OWNER2);
    try {
      await s.page.locator(`#waiting li[data-request-id="${other}"]`).waitFor({ timeout: 15_000 }); // they DO decide others'
      expect(await s.page.locator(`#waiting li[data-request-id="${own}"]`).count(), 'never their own (§28)').toBe(0);
      expect(await s.page.locator(`#mine li[data-request-id="${own}"]`).count()).toBe(1);
    } finally { await s.close(); }
    // …and it is head office that withholds it, not only the page.
    expect((await inboxOf(OWNER2)).waitingForMe.map((x) => x.requestId)).not.toContain(own);
    const self = await shop.cloud().request({ method: 'POST', path: `/v1/approvals/requests/${own}/decide`, userId: OWNER2, idempotencyKey: 'self-decide', body: { decision: 'approved', reason: 'mine' } });
    expect(self.status).toBe(422);
  }, 90_000);

  it('a cashier, who holds no approval authority, has nothing waiting — the server decides, not the page', async () => {
    const third = await ask('u-new-meena', 'Meena joins next week');
    const s = await open(CASHIER);
    try {
      await s.page.waitForFunction(() => /0 waiting|Nothing is waiting/i.test((globalThis as unknown as { document: { body: { textContent: string | null } } }).document.body.textContent ?? ''), undefined, { timeout: 15_000 });
      expect(await s.page.locator(`#waiting li[data-request-id="${third}"]`).count()).toBe(0);
    } finally { await s.close(); }
    expect((await inboxOf(CASHIER)).waitingForMe).toEqual([]);
    expect((await inboxOf(OWNER)).waitingForMe.map((r) => r.requestId)).toContain(third);
  }, 90_000);
});
