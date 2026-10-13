import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Pool } from 'pg';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM } from '../../services/api/src/adapters';

/**
 * **Round 26 · OB-99 "A" — the Store computers page, in a real browser, on the PRODUCTION API over real PostgreSQL
 * (OB-97 · OB-98 · M35-FR-03).**
 *
 * The page is served in front of the real API (no stub): who is looking comes from head office's own `GET /v1/identity/me`;
 * what they may do comes from head office's own answer on the bindings read; every `/v1` call goes to the API under the
 * signed-in person's token. Through Chromium:
 *
 *   • the owner sees the bill-number bindings and the findings that need a person, and acknowledges the "not checked" line
 *     with a reason — nothing else is written, and head office keeps it in his name;
 *   • round 28 · OB-103: on a 360 px phone, the owner acknowledges the "said unused, but head office has the bill" line with a
 *     reason — head office keeps it in his name, and the line leaves the page;
 *   • head office business staff (all stores) open the till's row, ask the owner's approval for "store computer replaced";
 *   • the owner approves it on his own Approvals page;
 *   • head office staff send the move — the binding now names the new store computer (replaced act), and the new computer's
 *     earlier refused report no longer needs a person; the page fits a 360 px phone with no sideways page scroll;
 *   • one store's manager and the IT administrator read the page and are offered no action ("not yours"), and head office
 *     refuses them if they try; the page reads in Tamil; no page errors.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['store', 'computers', 'e2e', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = randomUUID();
const HO = 'u-ho-all';
const IT = 'u-it-admin';
const BOX = 'u-box-br1';
const NEW_BOX = 'u-box-br1-new';
const P = 'B1L1-';

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the Store computers page on the production API, in a real browser (OB-99 · OB-97 · OB-98)', () => {
  let browser: Browser;
  let shop: InboxShop;
  let platform: Pool;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    platform = new Pool({ connectionString: DATABASE_URL, max: 2 });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: TENANT, signingKey: KEY,
      page: { path: '/store-computers', html: 'store-computers.html', dataGlobal: 'storeComputersData' },
      alsoPages: [{ path: '/approvals', html: 'approvals.html', dataGlobal: 'approvalsData' }],
      seed: async (cloud) => {
        await cloud.grant(HO, 'store_manager', undefined, 'all'); // head office business staff, all stores
        await cloud.grant(BOX, 'store_computer', undefined, ['br-1']);
        await cloud.grant(NEW_BOX, 'store_computer', undefined, ['br-1']); // the replacement, with its OWN sign-in
        // The IT role, laid on the ledger by the operator (the owner may not hand out platform_admin's own permissions).
        const at = new Date().toISOString();
        await new SqlEventStore(pgPoolClient(platform)).append(TENANT, STREAM.identity, makeEvent({
          id: `grant-it-${TENANT}`, type: 'RoleGranted', occurredAt: at, idempotencyKey: `grant-${TENANT}-platform_admin-${IT}`, source: 'test/ob-99',
          payload: { userId: IT, roleId: 'platform_admin', branchScope: 'all', request: { grantId: `platform_admin-${IT}`, userId: IT, roleId: 'platform_admin', branchScope: 'all', requestedBy: 'operator', approvedBy: 'operator', requestedAt: at } },
        }));
        await ok(cloud.request({ method: 'POST', path: '/v1/stores/br-1/tills/lane-1/receipt-prefix', userId: OWNER, idempotencyKey: `pfx-${TENANT}`, body: { prefix: P } }), 'issue prefix');
        // Round 28 · OB-103: head office holds a sale under B1L1-001250, made three hours ago (its receipt-number index).
        await new SqlEventStore(pgPoolClient(platform)).append(TENANT, STREAM.sales, makeEvent({
          id: `receipt-${P}001250`, type: 'ReceiptNumberIssued', occurredAt: new Date(Date.now() - 3 * 3_600_000).toISOString(), idempotencyKey: `receipt-${TENANT}-${P}001250`, source: 'test/ob-103',
          payload: { receiptNumber: `${P}001250`, saleId: `S-${P}001250` },
        }));
        const report = (box: string, issued: unknown) => ok(cloud.request({ method: 'POST', path: '/v1/store-computers/health-reports', userId: box, idempotencyKey: `rep-${randomUUID()}`, body: {
          observedAt: new Date().toISOString(), disk: { freeBytes: 5e9, totalBytes: 1e10, salesLogUsedBytes: 1000, salesLogCapacityBytes: 1e7, reserveBytes: 1e6 },
          queue: { unsent: 0, deadLettered: 0 }, tills: [], receiptNumbersIssued: issued,
        } }), `report from ${box}`);
        // The old box, restored from an old backup: more numbers it cannot vouch for than head office checks per report.
        // Round 27 · OB-100: and two numbers it took and never used (an abandoned bill, a declined card) — round 28: one of
        // them, 1250, is a sale head office holds ("said unused, but head office has the bill").
        await report(BOX, [{ prefix: P, through: 1_300, soldThrough: 1_300, atRisk: [[101, 700], [1_001, 1_300]], unused: [[1_250, 1_251]], unsent: { count: 0 } }]);
        // The replacement switched on before head office knew: its report is refused by name.
        await report(NEW_BOX, [{ prefix: P, through: 1_300, soldThrough: 1_300, unsent: { count: 0 } }]);
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); await platform?.end(); });

  const open = async (who: string, opts: { branch?: string; path?: string; width?: number } = {}) => {
    const context = await browser.newContext(opts.width === undefined ? {} : { viewport: { width: opts.width, height: 760 } });
    await shop.signIn(context, who, opts.branch);
    const page = await context.newPage();
    const writes: string[] = []; const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${u.pathname}`); });
    await page.goto(`${shop.base}${opts.path ?? '/store-computers'}`, { waitUntil: 'load' });
    return { page, writes, errors, close: async () => { await page.waitForLoadState('networkidle').catch(() => {}); await context.close(); } };
  };
  const says = async (page: Page, id: string, expected: RegExp): Promise<void> => {
    await page.waitForFunction(([i, source]) => new RegExp(source!).test((globalThis as unknown as { document: { getElementById(x: string): { textContent: string | null } | null } }).document.getElementById(i!)?.textContent ?? ''), [id, expected.source], { timeout: 15_000 });
  };
  const bindings = async (): Promise<{ storeId: string; prefix: string; computer: string; via: string }[]> =>
    ((await shop.cloud().request({ method: 'GET', path: '/v1/store-computers/prefix-bindings', userId: OWNER })).body as { bindings: { storeId: string; prefix: string; computer: string; via: string }[] }).bindings;

  it('the owner sees the bindings and acknowledges the not-checked line; HO staff ask; the owner approves; the move lands and the page fits a phone', async () => {
    // ── The owner: the list, the findings, an acknowledgement ──
    let s = await open(OWNER);
    try {
      await s.page.locator(`#binding-rows tr[data-prefix="${P}"][data-computer="${BOX}"][data-via="first_report"]`).waitFor({ timeout: 15_000 });
      await says(s.page, 'v-needs', /^3$/);
      expect(await s.page.locator('#open-replace').isVisible()).toBe(true);
      // Round 27 · OB-100: the numbers taken and never used — per store, till and day, count and numbers; information only.
      const unusedRow = s.page.locator(`#unused-rows tr[data-store="br-1"][data-prefix="${P}"][data-count="2"]`);
      await unusedRow.waitFor({ timeout: 15_000 });
      expect(await unusedRow.innerText()).toMatch(/B1L1-001250–B1L1-001251/);
      expect(await unusedRow.getAttribute('data-day')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      await says(s.page, 'v-unused', /^2$/);
      expect(await unusedRow.locator('button').count(), 'no action on an unused number').toBe(0);
      expect(s.writes, 'nothing is written on open').toEqual([]);
      await s.page.click('#tab-findings');
      const line = s.page.locator('#finding-rows li[data-kind="at_risk_not_checked"]');
      await line.waitFor({ timeout: 15_000 });
      expect(await line.innerText()).toMatch(/so 400 older one\(s\), below B1L1-000501, were NOT checked/);
      await line.locator('input[data-role="ack-reason"]').fill('ok'); // too short: refused on the page, nothing sent
      await line.locator('button[data-act="acknowledge"]').click();
      await expect.poll(async () => line.locator('.status').innerText()).toMatch(/at least 5 characters/);
      expect(s.writes).toEqual([]);
      await line.locator('input[data-role="ack-reason"]').fill('Support compared the restore record with head office');
      await line.locator('button[data-act="acknowledge"]').click();
      await says(s.page, 'page-status', /^Acknowledged in your name/);
      await s.page.locator('#finding-rows li[data-kind="at_risk_not_checked"]').waitFor({ state: 'detached', timeout: 15_000 });
      await says(s.page, 'v-needs', /^2$/);
      expect(s.writes).toEqual(['POST /v1/store-computers/at-risk-not-checked/acknowledgements']);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    const kept = await platform.query("SELECT payload->>'by' AS by, payload->>'reason' AS reason FROM event_ledger WHERE tenant_id = $1 AND type = 'BoxAtRiskNotCheckedAcknowledged'", [TENANT]);
    expect(kept.rows).toEqual([{ by: OWNER, reason: 'Support compared the restore record with head office' }]);

    // ── Round 28 · OB-103: the owner, on a 360 px phone, acknowledges "said unused, but head office has the bill" ──
    s = await open(OWNER, { width: 360 });
    try {
      await s.page.click('#tab-findings');
      const held = s.page.locator('#finding-rows li[data-kind="unused_number_received"]');
      await held.waitFor({ timeout: 15_000 });
      expect(await held.innerText()).toMatch(/Said unused, but head office has the bill — br-1 · B1L1-/);
      expect(await held.innerText()).toMatch(/gave B1L1-001250 and never put it on a bill, but head office holds a sale under that number/);
      const sideways = await s.page.evaluate(() => { const d = (globalThis as unknown as { document: { documentElement: { scrollWidth: number; clientWidth: number } } }).document.documentElement; return d.scrollWidth - d.clientWidth; });
      expect(sideways, 'the findings fit 360 px').toBeLessThanOrEqual(0);
      await held.locator('input[data-role="ack-reason"]').fill('Support checked the store computer: its unused list was wrong');
      await held.locator('button[data-act="acknowledge"]').click();
      await says(s.page, 'page-status', /^Acknowledged in your name/);
      await s.page.locator('#finding-rows li[data-kind="unused_number_received"]').waitFor({ state: 'detached', timeout: 15_000 });
      await says(s.page, 'v-needs', /^1$/);
      expect(s.writes).toEqual(['POST /v1/store-computers/unused-numbers-received/acknowledgements']);
      // In Tamil, the line's label and the acknowledge words.
      await s.page.click('#lang');
      expect(await s.page.locator('#findings-lead').innerText()).toMatch(/பயன்படாதது என்று சொன்ன எண்கள்/);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    const keptUnused = await platform.query("SELECT payload->>'by' AS by, payload->>'reason' AS reason, payload->'numbers' AS numbers FROM event_ledger WHERE tenant_id = $1 AND type = 'BoxUnusedReceivedAcknowledged'", [TENANT]);
    expect(keptUnused.rows).toEqual([{ by: OWNER, reason: 'Support checked the store computer: its unused list was wrong', numbers: [[1_250, 1_250]] }]);

    // ── Head office staff (all stores), on a 360 px phone: open the till's row, ask the owner's approval ──
    s = await open(HO, { width: 360 });
    let requestId = '';
    try {
      const row = s.page.locator(`#binding-rows tr[data-prefix="${P}"]`);
      await row.waitFor({ timeout: 15_000 });
      const sideways = await s.page.evaluate(() => { const d = (globalThis as unknown as { document: { documentElement: { scrollWidth: number; clientWidth: number } } }).document.documentElement; return d.scrollWidth - d.clientWidth; });
      expect(sideways, 'no sideways page scroll at 360 px').toBeLessThanOrEqual(0);
      await row.click();
      expect(await s.page.locator('#replace-sheet').isVisible()).toBe(true);
      expect(await s.page.inputValue('#f-from')).toBe(BOX);
      expect(await s.page.inputValue('#f-prefix')).toBe(P);
      await s.page.fill('#f-to', NEW_BOX);
      await s.page.fill('#f-reason', 'Old store computer disk failed; replaced');
      const drawerSideways = await s.page.evaluate(() => { const d = (globalThis as unknown as { document: { documentElement: { scrollWidth: number; clientWidth: number } } }).document.documentElement; return d.scrollWidth - d.clientWidth; });
      expect(drawerSideways, 'the drawer fits 360 px too').toBeLessThanOrEqual(0);
      await s.page.click('#f-ask');
      await says(s.page, 'page-status', /^Asked — the owner approves it on his Approvals page/);
      const waiting = s.page.locator('#request-rows li[data-status="waiting"]');
      await waiting.waitFor({ timeout: 15_000 });
      requestId = (await waiting.getAttribute('data-request-id'))!;
      expect(requestId).toMatch(/^areq-/);
      expect(await waiting.locator('button[data-act="send"]').count(), 'nothing to send before the owner approves').toBe(0);
      expect(s.writes).toEqual(['POST /v1/approvals/requests']);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    // ── The owner approves it on his own Approvals page ──
    s = await open(OWNER, { path: '/approvals' });
    try {
      const row = s.page.locator(`#waiting li[data-request-id="${requestId}"]`);
      await row.waitFor({ timeout: 15_000 });
      expect(await row.innerText()).toContain('Move a till\'s bill numbers to a replacement store computer');
      await row.locator('input.reason').fill('Checked the new machine at br-1');
      await row.locator('button.approve').click();
      await row.waitFor({ state: 'detached', timeout: 15_000 });
      expect(s.writes).toEqual([`POST /v1/approvals/requests/${requestId}/decide`]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    // ── Head office staff send the move ──
    s = await open(HO);
    try {
      await s.page.click('#tab-requests');
      const approved = s.page.locator(`#request-rows li[data-request-id="${requestId}"][data-status="approved"]`);
      await approved.waitFor({ timeout: 15_000 });
      expect(await approved.innerText()).toMatch(/Approved by u-owner — ready to send/);
      await approved.locator('button[data-act="send"]').click();
      await says(s.page, 'page-status', /^Moved — head office now takes B1L1-'s bill numbers from u-box-br1-new/);
      await s.page.locator(`#binding-rows tr[data-prefix="${P}"][data-computer="${NEW_BOX}"][data-via="replacement"]`).waitFor({ state: 'attached', timeout: 15_000 });
      await s.page.locator(`#request-rows li[data-request-id="${requestId}"][data-status="used"]`).waitFor({ timeout: 15_000 });
      await says(s.page, 'act-rows', /B1L1- at br-1: u-box-br1 → u-box-br1-new — asked by u-ho-all, approved by u-owner/);
      await says(s.page, 'v-needs', /^0$/); // the new computer's earlier refused report is answered by the act
      expect(s.writes).toEqual(['POST /v1/store-computers/replacements']);
      // In Tamil too.
      await s.page.click('#lang');
      expect(await s.page.locator('#title').innerText()).toBe('கடை கணினிகள்');
      expect(await s.page.locator('#open-replace').innerText()).toBe('மாற்றப்பட்ட கடை கணினியைப் பதிவு செய்');
      expect(await s.page.locator('#unused-h').innerText()).toBe('எடுத்தும் பயன்படுத்தாதவை');
      expect(await s.page.locator('#k-unused').innerText()).toBe('எடுத்தும் பயன்படுத்தாதவை');
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    // Head office's own record, not the page.
    expect((await bindings()).filter((b) => b.prefix === P).map((b) => [b.computer, b.via])).toEqual([[NEW_BOX, 'replacement']]);
  }, 240_000);

  it('one store\'s manager and the IT administrator read the page and are offered no action; head office refuses them', async () => {
    for (const [who, branch] of [[MGR, 'br-1'], [IT, undefined]] as const) {
      const s = await open(who, branch === undefined ? {} : { branch });
      try {
        await s.page.locator(`#binding-rows tr[data-prefix="${P}"]`).waitFor({ timeout: 15_000 });
        await says(s.page, 'page-status', /^You can read this\. Moving bill numbers and acknowledging findings are for the owner and head office staff who cover all stores/);
        expect(await s.page.locator('#open-replace').isHidden(), `${who}: no replace button`).toBe(true);
        await s.page.click('#tab-findings');
        expect(await s.page.locator('button[data-act="acknowledge"]').count(), `${who}: no acknowledge button`).toBe(0);
        await s.page.click('#tab-requests');
        expect(await s.page.locator('button[data-act="send"]').count()).toBe(0);
        // Head office refuses them all the same.
        const status = await s.page.evaluate(async () => (await fetch('/v1/store-computers/replacements', {
          method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'idempotency-key': `try-${Math.random()}` },
          body: JSON.stringify({ storeId: 'br-1', prefix: 'B1L1-', fromComputer: 'u-box-br1-new', toComputer: 'u-box-br1', reason: 'trying it', approvalId: 'x' }),
        })).status);
        expect(status, `${who}: refused by head office`).toBe(403);
        expect(s.errors).toEqual([]);
      } finally { await s.close(); }
    }
  }, 120_000);
});
