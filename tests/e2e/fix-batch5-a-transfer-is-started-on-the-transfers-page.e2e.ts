import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';

/**
 * **Fix batch 5 · D-036 on the production API, in a real browser (WF-07 · M09-FR-03 · §28 · P-07).** The walkthrough found the
 * Transfers page listed transfers ("Send an approved transfer…") but nobody could find where one is STARTED. Now the page
 * starts one: the places and the item chosen, a whole quantity, "Propose this transfer" — head office records it as proposed
 * by this person, values it at its own cost (no price is typed), and it waits on the register for a SECOND person to send it
 * (the proposer cannot). A person who may not move stock sees no form. Synthetic data only; skips without a database.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['batch5', 'start', 'transfer', 'signing', 'key'].join('-').padEnd(48, '0');
const MGR2 = 'u-mgr2-b5'; const CASHIER = 'u-cash-b5';

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('D-036: a transfer is started on the Transfers page', () => {
  let browser: Browser;
  let shop: InboxShop;
  const get = async (path: string) => (await shop.cloud().request({ method: 'GET', path, userId: OWNER })).body;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/transfers', html: 'transfers.html', dataGlobal: 'transfersData' },
      seed: async (cloud) => {
        await cloud.grant(CASHIER, 'cashier');
        await cloud.grant(MGR2, 'store_manager');
        const p = (path: string, userId: string, body: unknown) => ok(cloud.request({ method: 'POST', path, userId, idempotencyKey: `seed-${randomUUID()}`, body }), path);
        await p('/v1/org/nodes/C1', OWNER, { kind: 'company', name: 'SRE Retail' });
        await p('/v1/org/nodes/br-1', OWNER, { kind: 'branch', name: 'Store 1', parentId: 'C1', companyId: 'C1' });
        await p('/v1/org/nodes/br-1-back', OWNER, { kind: 'warehouse', name: 'Store 1 back store', parentId: 'br-1', companyId: 'C1' });
        await p('/v1/inventory/movements', OWNER, { movementId: 's-p1', productId: 'P1', locationId: 'br-1-back', kind: 'received', quantityMinor: 50, uom: 'EA', occurredAt: new Date(Date.now() - 60_000).toISOString(), enteredBy: OWNER, unitCostMinor: 200 });
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  const open = async (who: string) => {
    const context = await browser.newContext();
    await shop.signIn(context, who, who === CASHIER ? undefined : 'br-1');
    const page = await context.newPage();
    const writes: string[] = []; const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${u.pathname} ${r.postData() ?? ''}`); });
    await page.goto(`${shop.base}/transfers`, { waitUntil: 'load' });
    return { page, writes, errors, close: () => context.close() };
  };
  const says = async (page: Page, id: string, expected: RegExp): Promise<void> => {
    await page.waitForFunction(([i, source]) => new RegExp(source!).test((globalThis as unknown as { document: { getElementById(x: string): { textContent: string | null } | null } }).document.getElementById(i!)?.textContent ?? ''), [id, expected.source], { timeout: 15_000 });
  };

  it('the manager starts one on the page; head office holds it proposed by him, waiting for a second person, priced by head office', async () => {
    const s = await open(MGR);
    try {
      await s.page.waitForSelector('#start-box:not([hidden])', { timeout: 15_000 });
      await says(s.page, 'start-transfer', /^Start a transfer$/);
      expect(s.writes, 'nothing is written on open').toEqual([]);
      // A slip is said before anything is sent: the same place both ends.
      await s.page.fill('#s-from', 'br-1-back'); await s.page.fill('#s-to', 'br-1-back');
      await s.page.fill('#s-item', 'P1'); await s.page.fill('#s-qty', '24');
      await s.page.click('#s-add');
      await s.page.click('#s-propose');
      await says(s.page, 's-status', /^From and to are the same place/);
      expect(s.writes).toEqual([]);
      // The right places: proposed, in his session.
      await s.page.fill('#s-to', 'br-1');
      const answered = s.page.waitForResponse((r) => r.request().method() === 'POST' && /\/v1\/warehouse\/transfers\/tr-[^/]+$/.test(new URL(r.url()).pathname));
      await s.page.click('#s-propose');
      expect((await answered).status()).toBeLessThan(300);
      await says(s.page, 's-status', /^Proposed — it now waits on this page for a second person to send it/);
      expect(s.writes).toHaveLength(1);
      expect(s.writes[0]).toMatch(/^POST \/v1\/warehouse\/transfers\/tr-\S+ \{"fromLocationId":"br-1-back","toLocationId":"br-1","lines":\[\{"productId":"P1","quantityMinor":24,"uom":"EA"\}\]\}$/);
      expect(s.writes[0]).not.toMatch(/cost|price|approvedBy/i);
      // The register shows it waiting to be sent.
      await s.page.locator('#register tbody tr[data-state="proposed"]').first().waitFor({ timeout: 15_000 });
      // Tamil words on the form.
      await s.page.click('#lang');
      await says(s.page, 'start-transfer', /^புதிய இடமாற்றம் தொடங்கு$/);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    const all = (await get('/v1/warehouse/transfers')) as { transfers: { transfer: { transferId: string; state: string; requestedBy: string } }[] };
    const mine = all.transfers.map((r) => r.transfer).filter((t) => t.requestedBy === MGR);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.state).toBe('proposed');
  }, 180_000);

  it('a cashier, who may not move stock, sees no form', async () => {
    const s = await open(CASHIER);
    try {
      await s.page.waitForTimeout(1_000);
      expect(await s.page.isHidden('#start-box')).toBe(true);
      expect(s.writes).toEqual([]);
    } finally { await s.close(); }
  }, 60_000);
});
