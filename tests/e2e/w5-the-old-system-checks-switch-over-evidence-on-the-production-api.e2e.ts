import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, OWNER, type InboxShop } from './lib/ai-inbox-shop';
import { planCountSample } from '../../packages/migration/src/count-verification';
import { planLoyaltySample } from '../../packages/migration/src/loyalty-verification';
import { STOCK, SUPPLIER_ITEMS, SLABS, GSTR1, GSTR3B, BANK_BODY, TB, CA_ONLY, ACCOUNTS, LOYALTY } from '../support/witness-fixtures';

/**
 * The shop's clock (Asia/Kolkata), to the second, as a datetime-local input writes it. Chromium drops ":00" seconds from
 * the value it keeps, so a time typed with ":00" reads back different and Playwright refuses the fill ("Malformed value")
 * — this test failed once a minute, on the minute (CI, 10 Nov 2026, 07:27:00). The same instant either way.
 */
const shopClock = (offsetMs: number): string => new Date(Date.now() + 330 * 60_000 + offsetMs).toISOString().slice(0, 19).replace(/:00$/, '');

/**
 * W5 · MG-11 · OD-05 · MG-10 · GT-02 — the switch-over EVIDENCE sections of the Old system checks page, ONE connected run in
 * a real browser: the page served by the office front, on the PRODUCTION API over real PostgreSQL, synthetic data only.
 *
 *   MG-11  the owner records who ran the extraction; gives the blind-count witness on the page from its CSV templates — a
 *          count planned by the person who ran the extraction is refused in head office's words and records NOTHING, the
 *          right one records the five shelf findings; the twelve kinds stand covered with sales NOT proved (a short bank
 *          statement); the page cannot be signed until the owner accepts it;
 *   OD-05  the owner accepts "sales" on the old system's word, in his own name (head office's record says u-owner);
 *   MG-11  the page is shown and kept and signed by the owner; the named reconciler (no signatory) is refused before asking;
 *   MG-11  the four going-back limits read NOT SET; the owner sets two; head office holds two numbers and two nulls;
 *   MG-10  the books side of a parallel day (the old closing-stock report) is recorded, its difference owned on the page with
 *          which side was wrong, and the printable sheet carries it with the owner's name;
 *   GT-02  a decided rollback is confirmed with the old system's first bill (DONE), a reconciliation that does not balance is
 *          kept and demonstrates nothing, and the balancing one demonstrates going back.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['w5', 'cutover', 'evidence', 'key'].join('-').padEnd(48, '0');
const OPERATOR = 'u-operator';
const MANAGER = 'u-manager';
const RECONCILER = 'u-reconciler';
const DAY = '2026-10-02';
const SEED = 20260807;

const q = (v: string | number): string => (/[",]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const rows = (header: string, lines: readonly (readonly (string | number)[])[]): string => `${header}\r\n${lines.map((l) => l.map(q).join(',')).join('\r\n')}\r\n`;
const rupees = (minor: number): string => (minor / 100).toFixed(2);

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('W5 on the Old system checks page: the signed page, the owner\'s acceptance and limits, the books side of a day, going back confirmed and reconciled (MG-10/11 · OD-05 · GT-02)', () => {
  let browser: Browser;
  let shop: InboxShop;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/old-system', html: 'old-system.html', dataGlobal: 'oldSystemData' },
      seed: async (cloud) => {
        const ok = async (p: Promise<{ status: number; body: unknown }>, what: string) => { const r = await p; if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
        await cloud.grant(OPERATOR, 'store_manager');
        await cloud.grant(MANAGER, 'store_manager');
        await cloud.grant(RECONCILER, 'store_manager');
        const post = (path: string, body: unknown) => ok(cloud.request({ method: 'POST', path, userId: OWNER, idempotencyKey: `w5-${randomUUID()}`, body }), path);
        // Four of the six witnesses through their routes (the page gives the count; the customers' answers follow once the page
        // has named who ran the extraction, which a blind sample needs). The bank statement is a
        // SHORT one — the last day cannot have landed — so sales is honestly NOT proved, and needs the owner's acceptance.
        await post('/v1/migration/witness/suppliers', { evidenceRef: 'statements-2026-03-31', statements: Object.entries(SUPPLIER_ITEMS).map(([supplierId, items]) => ({ supplierId, statementDate: '2026-03-31', ourItems: items, theirItems: items })), suppliersAsked: Object.keys(SUPPLIER_ITEMS) });
        await post('/v1/migration/witness/bank', { evidenceRef: 'bank-stmt-short', ...BANK_BODY, statementPeriod: { from: '2026-03-01', to: '2026-03-03' } });
        await post('/v1/migration/witness/tax', { evidenceRef: 'gstr-2026-03', periods: [{ period: '2026-03', gstr1: GSTR1, gstr3b: GSTR3B, books: SLABS }], periodsExpected: ['2026-03'] });
        await post('/v1/migration/witness/books', { evidenceRef: 'signed-accounts-2026-03-31', accounts: ACCOUNTS, opening: TB, cutoverDate: '2026-04-01', caOnlyAccountCodes: CA_ONLY });
        // MG-10: the owner wrote the parallel-run terms; GT-02: going back was DECIDED at the store computer (one button).
        await ok(cloud.request({ method: 'PUT', path: '/v1/migration/parallel-run/policy', userId: OWNER, idempotencyKey: `w5-pol-${randomUUID()}`, body: { cutoverId: 'C-W5', dailyReconcilerUserId: RECONCILER, requiredCleanDays: 3, maxParallelDays: 14, startedOn: '2026-10-01' } }), 'policy');
        await post('/v1/migration/cutover/rollback', { cutoverId: 'C-W5', trigger: 'owner_decision', legacySystemAvailable: true });
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  const open = async (who: string) => {
    const context = await browser.newContext();
    await shop.signIn(context, who);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${shop.base}/old-system`, { waitUntil: 'load' });
    return { page, errors, close: () => context.close() };
  };
  const status = (page: Page, id: string) => page.locator(`#${id}`).innerText();
  const file = (name: string, text: string) => ({ name, mimeType: 'text/csv', buffer: Buffer.from(text) });
  const head = () => shop.cloud();

  it('one run: the extraction named, the count witnessed, the twelve read, sales accepted by the owner, the page signed; the limits; the books side and its difference; going back confirmed and reconciled', async () => {
    const o = await open(OWNER);
    try {
      // ── MG-11: who ran the extraction.
      await o.page.fill('#run-id', 'run-1'); await o.page.fill('#run-operator', OPERATOR); await o.page.fill('#run-sources', 'old-erp');
      await o.page.click('#run-record');
      await expect.poll(() => status(o.page, 'run-status')).toMatch(/^✓ Recorded — this person can now neither plan the count nor sign the page: u-operator \(run-1\)/);

      // ── MG-11: the blind count from its templates. Planned by the person who ran the extraction: refused, nothing recorded.
      const plan = planCountSample({ planId: 'cnt-1', lines: STOCK, plannedBy: MANAGER, extractionOperator: OPERATOR, seed: SEED });
      const linesCsv = rows('line_id,product_id,description,extracted_qty,extracted_value', STOCK.map((l) => [l.lineId, l.productId, l.description, l.extractedQty, rupees(l.extractedValueMinor)]));
      const countedCsv = rows('line_id,counted_qty,counter_id', plan.plan!.lines.filter((l) => l.stratum !== 'not_counted').map((l) => [l.lineId, STOCK.find((s) => s.lineId === l.lineId)!.extractedQty, 'u-counter']));
      expect(await o.page.locator('#wit-files a[data-template="count_lines"]').getAttribute('download')).toBe('count-lines-template.csv');
      await o.page.fill('#wit-ref', 'count-sheet-2026-03-31'); await o.page.fill('#wit-plan', 'cnt-1'); await o.page.fill('#wit-planner', OPERATOR); await o.page.fill('#wit-seed', String(SEED));
      await o.page.setInputFiles('#wit-file-count_lines', file('lines.csv', linesCsv));
      await o.page.setInputFiles('#wit-file-count_counted', file('counted.csv', countedCsv));
      await o.page.click('#wit-record');
      await expect.poll(() => status(o.page, 'wit-status')).toMatch(/^Head office refused: /);
      expect(await o.page.locator('#wit-result li').count()).toBe(0);
      // A file with a bad cell is named by line and column before anything is sent.
      await o.page.fill('#wit-planner', MANAGER);
      await o.page.setInputFiles('#wit-file-count_counted', file('counted.csv', 'line_id,counted_qty,counter_id\r\nL001,twelve,u-counter\r\n'));
      await o.page.click('#wit-record');
      await expect.poll(() => status(o.page, 'wit-status')).toBe('Fix the file: What was counted, blind (CSV) — line 2, column “counted_qty”.');
      await o.page.setInputFiles('#wit-file-count_counted', file('counted.csv', countedCsv));
      await o.page.click('#wit-record');
      await o.page.locator('#wit-result li[data-domain="stock"]').waitFor({ timeout: 15_000 });
      expect(await o.page.locator('#wit-result li').count()).toBe(5);
      expect(await o.page.locator('#wit-result li[data-domain="stock"]').innerText()).toMatch(/^✓ Stock — proved · ₹[\s\S]*recorded by u-owner · count-sheet-2026-03-31[\s\S]*What it cannot prove:/);
      // The customers' own answers, through their route (a blind sample is planned against the extraction's named operator).
      const lp = planLoyaltySample({ planId: 'loy-1', balances: LOYALTY, plannedBy: MANAGER, extractionOperator: OPERATOR, source: 'drawn_before_anybody_was_told', seed: SEED });
      const loy = await head().request({ method: 'POST', path: '/v1/migration/witness/loyalty', userId: OWNER, idempotencyKey: `w5-loy-${randomUUID()}`, body: { evidenceRef: 'customer-calls', planId: 'loy-1', plannedBy: MANAGER, seed: SEED, source: 'drawn_before_anybody_was_told', balances: LOYALTY, confirmations: lp.plan!.lines.map((l) => ({ customerId: l.customerId, method: 'customer_stated_their_own_figure', statedPoints: LOYALTY.find((b) => b.customerId === l.customerId)!.pointsBalance, confirmedOn: '2026-08-20' })), pointCostMinor: 25 } });
      expect(loy.status, JSON.stringify(loy.body)).toBe(201);

      // ── MG-11: the twelve. Sales is NOT proved (the short statement), so the page cannot be signed yet.
      await o.page.click('#prog-show');
      await o.page.locator('#prog-list li[data-domain="sales"]').waitFor({ timeout: 15_000 });
      await expect.poll(() => o.page.locator('#prog-status').getAttribute('data-covered')).toBe('12');
      expect(await o.page.locator('#prog-list li[data-domain="sales"]').getAttribute('data-verdict')).toBe('not_proved');
      expect(await o.page.locator('#prog-list li[data-domain="sales"]').innerText()).toMatch(/^⚠ Sales — NOT proved/);
      await o.page.fill('#vpage-statement', 'Every finding read against its document; the limits stated against each understood.');
      await o.page.click('#vpage-sign');
      await expect.poll(() => status(o.page, 'vsign-status')).toMatch(/^Head office refused: /);

      // ── OD-05: the owner accepts sales on the old system's word, in his own name.
      await o.page.selectOption('#acc-domain', 'sales');
      await o.page.click('#acc-accept');
      await expect.poll(() => status(o.page, 'acc-status')).toBe('Write your reason — in two years it is the only record that you decided this.');
      await o.page.fill('#acc-reason', 'The March bank statement stops on the 3rd; I carry March sales on the old system\'s takings and will check them against April\'s statement.');
      await o.page.click('#acc-accept');
      await expect.poll(() => o.page.locator('#acc-status').getAttribute('data-accepted')).toBe('sales');
      expect(await status(o.page, 'acc-status')).toMatch(/^✓ Accepted in your name: Sales — u-owner · 20\d\d-/);

      // ── MG-11: the page is shown (and kept), and the owner signs it.
      await o.page.click('#vpage-show');
      await expect.poll(() => o.page.locator('#vpage-status').getAttribute('data-signatures')).toBe('0');
      expect(await o.page.locator('#vpage-text').innerText()).toContain('prepared by u-owner');
      expect(await o.page.locator('#vpage-save').getAttribute('download')).toBe('verification-page.md');
      await o.page.click('#vpage-sign');
      await expect.poll(() => o.page.locator('#vsign-status').getAttribute('data-signatures')).toBe('1');

      // ── MG-11: the four limits are the owner's — NOT SET until he sets each; two set, two left.
      await o.page.click('#lim-show');
      await expect.poll(() => o.page.locator('#lim-status').getAttribute('data-not-set')).toBe('4');
      expect(await o.page.locator('#lim-list li[data-limit="windowMinutes"]').innerText()).toMatch(/NOT SET/);
      await o.page.fill('#lim-controlTotalDifferenceMinor', '500.50'); await o.page.fill('#lim-windowMinutes', '480');
      await o.page.click('#lim-set');
      await expect.poll(() => o.page.locator('#lim-status').getAttribute('data-not-set')).toBe('2');
      expect(await o.page.locator('#lim-list li[data-limit="controlTotalDifferenceMinor"]').innerText()).toMatch(/₹500\.50/);
      expect(await o.page.locator('#lim-list li[data-limit="edgeOutageMinutes"]').getAttribute('data-set')).toBe('false');
      expect(await status(o.page, 'lim-status')).toBe('⚠ 2 limit(s) not set — the switch-over cannot be said GO');

      // ── MG-10: the books side of a parallel day — the old closing-stock report; its difference owned on the page.
      await o.page.fill('#books-date', DAY);
      await o.page.click('#books-show');
      await o.page.locator('#books-report option[value="stock_balance"]').waitFor({ state: 'attached', timeout: 15_000 });
      await o.page.selectOption('#books-report', 'stock_balance');
      await o.page.fill('#books-col-item_code', 'Item'); await o.page.fill('#books-col-quantity', 'Qty');
      await o.page.setInputFiles('#books-file', file('closing-stock.csv', 'Item,Qty\r\nSYN-DAL,3\r\n'));
      await o.page.click('#books-add');
      await o.page.locator('#books-pending li[data-report="stock_balance"]').waitFor({ timeout: 15_000 });
      await o.page.click('#books-record');
      await expect.poll(() => o.page.locator('#books-status').getAttribute('data-differences')).toBe('1');
      expect(await status(o.page, 'books-status')).toMatch(/^⚠ 1 difference\(s\) on the books side/);
      await o.page.click('#pdiff-show');
      await o.page.locator('#pdiff-list li[data-owned="false"]').first().waitFor({ timeout: 15_000 });
      const diffId = await o.page.locator('#pdiff-list li[data-owned="false"]').first().getAttribute('data-difference');
      // First a name only (the cause not yet known): it stays open, owned. Then the cause and the wrong side: resolved.
      await o.page.selectOption('#pdiff-which', diffId!);
      await o.page.click('#pdiff-own');
      await o.page.locator(`#pdiff-list li[data-difference="${diffId}"][data-owned="true"]`).waitFor({ timeout: 15_000 });
      expect(await o.page.locator(`#pdiff-list li[data-difference="${diffId}"]`).innerText()).toMatch(/owned by u-owner/);
      await expect.poll(() => o.page.locator('#pdiff-status').getAttribute('data-state')).toBe('owned');
      await o.page.selectOption('#pdiff-which', diffId!);
      await o.page.fill('#pdiff-explain', 'three packs of synthetic dal were received on the old system only');
      await o.page.selectOption('#pdiff-wrong', 'new');
      await o.page.click('#pdiff-own');
      await expect.poll(() => o.page.locator('#pdiff-status').getAttribute('data-state')).toBe('resolved');
      expect(await status(o.page, 'pdiff-status')).toMatch(/^✓ Owned in your name\. .*resolved by u-owner: three packs of synthetic dal were received on the old system only/);
      expect(await o.page.locator(`#pdiff-list li[data-difference="${diffId}"]`).count()).toBe(0);
      await o.page.click('#sheet-show');
      await o.page.locator('#sheet-text:not([hidden])').waitFor({ timeout: 15_000 });
      expect(await o.page.locator('#sheet-text').innerText()).toMatch(new RegExp(`${diffId}[\\s\\S]*u-owner[\\s\\S]*new[\\s\\S]*Reconciled by: _+`));
      expect(await o.page.locator('#sheet-save').getAttribute('download')).toBe('parallel-run-sheet.md');

      // ── GT-02: going back confirmed with the old system's first bill (the old till took a sale), then reconciled.
      await o.page.fill('#rb-cutover', 'C-W5'); await o.page.fill('#rb-bill', 'OLD-W5-1');
      await o.page.click('#rb-confirm');
      await expect.poll(() => status(o.page, 'rb-confirm-status')).toBe('Choose the date and time on the shop\'s clock.');
      const shopNow = shopClock(0); // the shop's clock (Asia/Kolkata), to the second
      await o.page.fill('#rb-from', shopNow);
      await o.page.click('#rb-confirm');
      await expect.poll(() => o.page.locator('#rb-confirm-status').getAttribute('data-state')).toBe('performed');
      expect(await status(o.page, 'rb-confirm-status')).toMatch(/^✓ Going back is DONE — confirmed in your name with bill OLD-W5-1 · C-W5 · performed/);
      expect(o.errors).toEqual([]);
    } finally { await o.close(); }

    // The store computer reports it has synced past the switch-back (its own sign-in), so the window can be reconciled.
    await head().grant('u-w5-box', 'store_computer', undefined, ['br-1']);
    const now = new Date().toISOString();
    const wm = await head().request({ method: 'POST', path: '/v1/stores/br-1/sync-watermarks', userId: 'u-w5-box', branchId: 'br-1', idempotencyKey: `w5-wm-${now}`, body: { observedAt: now, domains: [{ domain: 'sales', completeThrough: now, unsent: 0, deadLettered: 0 }] } });
    expect(wm.status, JSON.stringify(wm.body)).toBe(200);

    const rec = await open(RECONCILER);
    try {
      // The named daily reconciler (a store manager) is no signatory, and holds no right to set the
      // owner's limits or to confirm going back: the page says so before asking head office.
      await rec.page.fill('#vpage-statement', 'I read it');
      await rec.page.click('#vpage-sign');
      await expect.poll(() => status(rec.page, 'vsign-status')).toBe('Your role cannot do this step.');
      await rec.page.click('#lim-set');
      await expect.poll(() => status(rec.page, 'lim-status')).toBe('Your role cannot do this step.');
      await rec.page.click('#rb-confirm');
      await expect.poll(() => status(rec.page, 'rb-confirm-status')).toBe('Your role cannot do this step.');
      expect(rec.errors).toEqual([]);
    } finally { await rec.close(); }

    const o2 = await open(OWNER);
    try {
      // ── GT-02: a reconciliation that does not balance is KEPT and demonstrates nothing; the balancing one demonstrates it.
      const from = shopClock(-60 * 60_000);
      await o2.page.fill('#rb-cutover', 'C-W5'); await o2.page.fill('#rb-newfrom', from);
      await o2.page.fill('#rb-count', '1'); await o2.page.fill('#rb-total', '120.00');
      await o2.page.click('#rb-reconcile');
      await expect.poll(() => o2.page.locator('#rb-rec-status').getAttribute('data-demonstrated')).toBe('false');
      expect(await status(o2.page, 'rb-rec-status')).toMatch(/^⚠ Does NOT balance — kept as evidence; going back is not demonstrated:/);
      await o2.page.fill('#rb-count', '0'); await o2.page.fill('#rb-total', '0');
      await o2.page.click('#rb-reconcile');
      await expect.poll(() => o2.page.locator('#rb-rec-status').getAttribute('data-demonstrated')).toBe('true');
      expect(await status(o2.page, 'rb-rec-status')).toBe('✓ Reconciled — the old system holds every bill the new one took. Going back is demonstrated.');
      expect(o2.errors).toEqual([]);
    } finally { await o2.close(); }

    // Head office's own record of what the page did — every act in the signed-in person's name, the limits his numbers.
    const progress = (await head().request({ method: 'GET', path: '/v1/migration/verification/progress', userId: OWNER })).body as { signaturesOverThisPage: number; extractionOperatorKnown: boolean; findings: { domain: string; recordedBy: string }[] };
    expect(progress.signaturesOverThisPage).toBe(1);
    expect(progress.extractionOperatorKnown).toBe(true);
    expect(progress.findings.find((f) => f.domain === 'stock')?.recordedBy).toBe(OWNER);
    const page = (await head().request({ method: 'GET', path: '/v1/migration/verification/page', userId: OWNER })).body as { markdown: string; signatures: number };
    expect(page.signatures).toBe(1);
    expect(page.markdown).toContain('The March bank statement stops on the 3rd');
    const limits = (await head().request({ method: 'GET', path: '/v1/migration/cutover/rollback-limits', userId: OWNER })).body as { limits: Record<string, unknown>; notSet: string[] };
    expect(limits.limits).toMatchObject({ controlTotalDifferenceMinor: 50_050, edgeOutageMinutes: null, windowMinutes: 480, backupMaxAgeHours: null, setBy: OWNER });
    expect(limits.notSet).toEqual(['edgeOutageMinutes', 'backupMaxAgeHours']);
    const rb = (await head().request({ method: 'GET', path: '/v1/migration/cutover/rollback/C-W5', userId: OWNER })).body as { rollback: { state: string; execution: { confirmedBy: string; legacyFirstBillRef: string } }; reconciliations: { reconciled: boolean }[]; demonstrated: boolean };
    expect(rb.rollback).toMatchObject({ state: 'performed', execution: { confirmedBy: OWNER, legacyFirstBillRef: 'OLD-W5-1' } });
    expect(rb.reconciliations.map((r) => r.reconciled)).toEqual([false, true]); // the one that did not balance is kept
    expect(rb.demonstrated).toBe(true);
  }, 300_000);
});
