import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, OWNER, type InboxShop } from './lib/ai-inbox-shop';
import type { RealCloud } from '../support/real-store';
import type { ApiHarness } from '../support/api-harness';
import { prepareCutoverEvidence } from '../support/cutover-go';
import { planLoad, executeLoad, type ExtractBundle } from '../../packages/migration/src/index';
import { shopDateOf } from '../../packages/calendar/src/shop-day';
import { storeRules } from '../support/store-rules';

/**
 * W4 · WF-19 (the migration workflow: discover → … → load → reconcile → GO/rollback) · MG-02 · MG-04 · MG-05 · MG-06 · QG-07
 * — ONE connected run in a real browser: the Old system checks page, served by the office front, on the PRODUCTION API over
 * real PostgreSQL, on SYNTHETIC legacy data (never the real old ERP, OB-282).
 *
 *   MG-02  the owner checks the export about to be loaded against the seal taken when it came out: a changed file is named
 *          "NOT the export that was sealed", the right one "the same export that was sealed" (digest AND row count);
 *   MG-05  the trial load is refused by head office while a blocking problem has no decision; once the owner decides it on
 *          the page (MG-04), the trial load's RECORD is shown — the volume, the time it took, and the full-volume projection;
 *   MG-06  the owner, who ran the load, cannot sign its figure (refused in head office's words); a second owner signs it on
 *          the page and every figure then agrees and is signed (QG-07);
 *   WF-19  the switch-over gate's own reading: the decided problem and the signed figures now PASS, the rehearsed going-back
 *          to the old system reads performed and reconciled, and what only the store computer knows reads NOT KNOWN — so
 *          the answer here is NOT YET, never a GO said from the office.
 *
 * What the page did is head office's record: the decision in the owner's name, the signature in the second owner's.
 * Synthetic data, a fresh tenant. Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['w4', 'wf19', 'old', 'system', 'key'].join('-').padEnd(48, '0');
const OWNER2 = 'u-owner2';
const RECONCILER = 'u-reconciler';
/** The synthetic export as it came out of the old system (two data rows), and the same file changed afterwards. */
const EXPORT_CSV = 'Code,Name,Qty\nP-SYN-1,Synthetic soap,12\nP-SYN-2,Synthetic oil,5\n';
const CHANGED_CSV = 'Code,Name,Qty\nP-SYN-1,Synthetic soap,120\nP-SYN-2,Synthetic oil,5\n';
const EXTRACT: ExtractBundle = {
  categories: [{ categoryId: 'home', name: 'Home care', parentId: null }],
  taxRates: [{ hsnCode: '3402', effectiveFrom: '2017-07-01', rateBps: 1800 }],
  products: [{ productId: 'P-SYN-1', sku: 'SYN-1', name: 'Synthetic soap', baseUom: 'each', primaryCategoryId: 'home', taxClass: '3402', lifecycle: 'active', barcodes: [{ code: 'INT-SYN-1', kind: 'internal' }], priceMinor: 2_000, mrpMinor: 2_500, costMinor: 1_100, marginFloorBps: 0 }],
  suppliers: [], customers: [],
  openingStock: [{ productId: 'P-SYN-1', locationId: 'br-1', quantityMinor: 12, uom: 'each', unitCostMinor: 1_100 }],
};

function asHarness(cloud: RealCloud): ApiHarness {
  return {
    request: (r: { method: 'GET' | 'POST' | 'PUT' | 'DELETE'; path: string; userId: string; branchId?: string; body?: unknown; idempotencyKey?: string; amr?: readonly string[] | null }) =>
      cloud.request({ method: r.method, path: r.path, userId: r.userId, ...(r.branchId === undefined ? {} : { branchId: r.branchId }), ...(r.body === undefined ? {} : { body: r.body }), ...(r.idempotencyKey === undefined ? {} : { idempotencyKey: r.idempotencyKey }), ...(r.amr === null ? { machine: true } : {}) }),
    provisionRole: (_t: string, userId: string, roleId: string, scope?: readonly string[] | 'all') => cloud.grant(userId, roleId, undefined, scope ?? 'all'),
  } as unknown as ApiHarness;
}

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('WF-19 on the Old system checks page: the export checked, a problem decided, the trial load recorded, the figure signed, the gate read (MG-02/04/05/06)', () => {
  let browser: Browser;
  let shop: InboxShop;
  let seal: unknown;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/old-system', html: 'old-system.html', dataGlobal: 'oldSystemData' },
      seed: async (cloud) => {
        const ok = async (p: Promise<{ status: number; body: unknown }>, what: string) => { const r = await p; if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
        await cloud.grant(OWNER2, 'owner');
        await cloud.grant(RECONCILER, 'store_manager');
        const h = asHarness(cloud);
        await storeRules(h, cloud.tenantId, OWNER, 'br-1', 0);
        // The shop's own opening load, recorded by the owner (so he is the load's operator — MG-06's rule below).
        const plan = planLoad(EXTRACT, {
          target: { targetId: 'w4-rehearsal', tenantId: cloud.tenantId, kind: 'rehearsal', label: 'W4 synthetic rehearsal shop' }, tenantId: cloud.tenantId, demoTenantIds: [], operator: OWNER,
          targetProductCount: 0, extractSealed: true, blockingExceptionsOpen: 0, loadId: 'load-opening', stockLocationId: 'br-1', receivedOnDate: shopDateOf(new Date().toISOString()), currency: 'INR',
        });
        if (!plan.ok) throw new Error(`${plan.refusedBecause}: ${plan.problems.join('; ')}`);
        const loaded = await executeLoad(h, plan);
        if (!loaded.ok) throw new Error(`the synthetic opening did not load: ${JSON.stringify(loaded.steps.filter((x) => !x.ok))}`);
        // The rest of the switch-over's evidence through the real routes (the parallel run, the rehearsed going-back, the
        // delta, the agreed limits, the backup) — the steps the page does not do.
        await prepareCutoverEvidence(h, { tenantId: cloud.tenantId, ownerId: OWNER, signerId: OWNER2, reconcilerId: RECONCILER, deltaLocationId: 'S1-DELTA', storeIds: ['br-1'] });
        // MG-02: the export sealed when it came out (as the owner's seal command does), with the old ERP's restore verified.
        seal = await ok(cloud.request({ method: 'POST', path: '/v1/migration/extracts/items-1/seal', userId: OWNER, idempotencyKey: `seal-${randomUUID()}`, body: { sourceId: 'old-erp', material: EXPORT_CSV, rowCount: 2, extractedBy: OWNER, backupVerifiedAt: '2026-11-01T09:00:00.000Z' } }), 'seal');
        // MG-04: the cleaning pass found one blocking problem; MG-06: one more figure, recorded, not yet signed.
        await ok(cloud.request({ method: 'POST', path: '/v1/migration/exceptions', userId: OWNER, idempotencyKey: `ex-${randomUUID()}`, body: { exceptions: [{ exceptionId: 'EX-NEG-1', kind: 'negative_stock', severity: 'blocking', confidence: 'certain', legacyIds: ['P-SYN-2'], evidence: 'stock on hand is -4 for Synthetic oil in the old system' }] } }), 'exception');
        await ok(cloud.request({ method: 'POST', path: '/v1/migration/control-totals', userId: OWNER, idempotencyKey: `ct-${randomUUID()}`, body: { totals: [{ totalId: 'CT-STOCK-BR1', kind: 'stock', name: 'Opening stock units at br-1', unit: 'quantity', legacyValue: 12, loadedValue: 12, legacyDerivation: 'SUM(qty) on the old system stock report for br-1', loadedDerivation: 'the opening movements on the new stock ledger at br-1' }] } }), 'control total');
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
  const file = (name: string, mimeType: string, text: string) => ({ name, mimeType, buffer: Buffer.from(text) });

  it('one run: the export against its seal, the blocking problem decided, the trial load recorded, the figure signed by a second owner, the gate read', async () => {
    const o = await open(OWNER);
    try {
      // ── MG-02: a file changed after the seal is named; the right one matches, digest and rows.
      await o.page.setInputFiles('#seal-file', file('items-1.seal.json', 'application/json', JSON.stringify({ seal })));
      await o.page.setInputFiles('#seal-extract', file('items-1.csv', 'text/csv', CHANGED_CSV));
      await o.page.click('#seal-verify');
      await o.page.locator('#seal-result li[data-verified="false"]').waitFor({ timeout: 15_000 });
      expect(await o.page.locator('#seal-result li').innerText()).toMatch(/⚠ NOT the export that was sealed — do not load it[\s\S]*digest does not match the seal/);
      await o.page.setInputFiles('#seal-extract', file('items-1.csv', 'text/csv', EXPORT_CSV));
      await o.page.click('#seal-verify');
      await o.page.locator('#seal-result li[data-verified="true"]').waitFor({ timeout: 15_000 });
      expect(await o.page.locator('#seal-result li').innerText()).toMatch(/✓ The same export that was sealed[\s\S]*verified against the seal taken at 20\d\d-/);

      // ── MG-05 before MG-04: the trial is refused by head office while the blocking problem has no decision.
      await o.page.fill('#trial-id', 'trial-1'); await o.page.fill('#trial-rows', '15000'); await o.page.fill('#trial-minutes', '12.5');
      await o.page.fill('#trial-full', '30000'); await o.page.check('#trial-empty');
      await o.page.click('#trial-run');
      await o.page.locator('#trial-status.err').waitFor({ timeout: 15_000 });
      expect(await status(o.page, 'trial-status')).toMatch(/^Head office refused: 1 blocking exceptions have no decision \(MG-04\)/);
      expect(await o.page.locator('#trial-result li').count()).toBe(0);

      // ── WF-19: the gate read now names the problem and the unsigned figure.
      await o.page.fill('#gate-cutover', 'C-1');
      await o.page.click('#gate-read');
      await o.page.locator('#gate-result li[data-go]').waitFor({ timeout: 15_000 });
      const stateOf = async (check: string) => o.page.locator(`#gate-result li[data-check="${check}"]`).getAttribute('data-state');
      expect(await stateOf('blocking_exceptions_cleared')).toBe('failed');
      expect(await stateOf('control_totals_signed')).toBe('failed');

      // ── MG-04: the owner decides the blocking problem, in writing, on the page.
      await o.page.click('#prob-show');
      await o.page.locator('#prob-list li[data-problem="EX-NEG-1"]').waitFor({ timeout: 15_000 });
      expect(await o.page.locator('#prob-list li[data-problem="EX-NEG-1"]').innerText()).toMatch(/⚠ EX-NEG-1 · negative stock · STOPS THE SWITCH-OVER[\s\S]*stock on hand is -4 for Synthetic oil[\s\S]*nobody has decided/);
      await expect.poll(() => status(o.page, 'prob-status')).toBe('⚠ 1 blocking problem(s) nobody has decided');
      await o.page.selectOption('#prob-which', 'EX-NEG-1');
      await o.page.click('#prob-decide-btn');
      await expect.poll(() => status(o.page, 'prob-status')).toBe('Choose what to do.');
      await o.page.selectOption('#prob-action', 'correct');
      await o.page.fill('#prob-reason', 'counted the synthetic shelf: 0 on hand, the -4 was a keying slip');
      await o.page.click('#prob-decide-btn');
      await o.page.locator('#prob-list li[data-problem="EX-NEG-1"][data-decided="true"]').waitFor({ timeout: 15_000 });
      expect(await o.page.locator('#prob-list li[data-problem="EX-NEG-1"]').innerText()).toMatch(/✓ EX-NEG-1[\s\S]*decided by: u-owner — Correct it — “counted the synthetic shelf: 0 on hand, the -4 was a keying slip”/);
      await expect.poll(() => status(o.page, 'prob-status')).toBe('✓ Nothing blocking is left');

      // ── MG-05: now the trial load is recorded, and its record is on the page: volume, time, projection.
      await o.page.click('#trial-run');
      await o.page.locator('#trial-result li[data-trial="trial-1"]').waitFor({ timeout: 15_000 });
      await expect.poll(() => status(o.page, 'trial-status')).toBe('✓ Trial load recorded');
      expect(await o.page.locator('#trial-result li[data-trial="trial-1"]').innerText()).toMatch(/✓ trial-1[\s\S]*15,000 rows loaded · took 12\.5 min · the full volume would take 25 min · can be repeated[\s\S]*30000 rows projects to 1500000ms/);

      // ── MG-06: the owner ran the load, so he cannot sign its figure — head office says so.
      await o.page.click('#tot-show');
      await o.page.locator('#tot-list li[data-total="CT-STOCK-BR1"]').waitFor({ timeout: 15_000 });
      expect(await o.page.locator('#tot-list li[data-total="CT-STOCK-BR1"]').getAttribute('data-signed')).toBe('false');
      expect(await o.page.locator('#tot-status').getAttribute('data-qg07')).toBe('false');
      await o.page.selectOption('#tot-which', 'CT-STOCK-BR1');
      await o.page.fill('#tot-statement', 'I counted it myself');
      await o.page.click('#tot-sign-btn');
      await expect.poll(() => status(o.page, 'tot-status')).toMatch(/^Head office refused: /);
      expect(o.errors).toEqual([]);
    } finally { await o.close(); }

    const second = await open(OWNER2);
    try {
      // ── MG-06: a second owner, who did not run the load, signs it; every figure now agrees and is signed (QG-07).
      await second.page.click('#tot-show');
      await second.page.locator('#tot-list li[data-total="CT-STOCK-BR1"]').waitFor({ timeout: 15_000 });
      await second.page.selectOption('#tot-which', 'CT-STOCK-BR1');
      await second.page.click('#tot-sign-btn');
      await expect.poll(() => status(second.page, 'tot-status')).toBe('Say what you checked, in your own words.');
      await second.page.fill('#tot-statement', 'counted the synthetic shelf at br-1 against the old report: 12 and 12');
      await second.page.click('#tot-sign-btn');
      await second.page.locator('#tot-list li[data-total="CT-STOCK-BR1"][data-signed="true"]').waitFor({ timeout: 15_000 });
      expect(await second.page.locator('#tot-list li[data-total="CT-STOCK-BR1"]').innerText()).toMatch(/✓ CT-STOCK-BR1 · Opening stock units at br-1 · agrees exactly[\s\S]*old system 12[\s\S]*came across 12[\s\S]*signed by: u-owner2 — “counted the synthetic shelf at br-1 against the old report: 12 and 12”/);
      await expect.poll(() => second.page.locator('#tot-status').getAttribute('data-qg07')).toBe('true');
      expect(await status(second.page, 'tot-status')).toBe('✓ Every figure agrees and is signed (QG-07)');

      // ── WF-19: the gate's own reading — what the page did now passes; the going-back was rehearsed; the store
      // computer's part is NOT KNOWN from the office, so the answer is NOT YET (the GO is said at the store computer).
      await second.page.fill('#gate-cutover', 'C-1');
      await second.page.click('#gate-read');
      await second.page.locator('#gate-result li[data-go]').waitFor({ timeout: 15_000 });
      const stateOf = async (check: string) => second.page.locator(`#gate-result li[data-check="${check}"]`).getAttribute('data-state');
      await expect.poll(() => stateOf('blocking_exceptions_cleared')).toBe('passed');
      expect(await stateOf('control_totals_signed')).toBe('passed');
      expect(await stateOf('rollback_demonstrated')).toBe('passed');
      expect(await stateOf('parallel_run_sufficient')).toBe('passed');
      expect(await stateOf('edge_fully_synced')).toBe('not_known');
      expect(await stateOf('owner_go')).not.toBe('passed');
      expect(await second.page.locator('#gate-result li[data-go]').getAttribute('data-go')).toBe('false');
      expect(await second.page.locator('#gate-result li[data-go]').innerText()).toMatch(/^⚠ NOT YET/);
      expect(await second.page.locator('#gate-result li[data-check="edge_fully_synced"]').innerText()).toMatch(/○ The store computer has sent everything — not known/);
      await second.page.fill('#gate-cutover', 'C-rehearsal');
      await second.page.click('#gate-rollback');
      await second.page.locator('#gate-rollback-result li[data-demonstrated]').waitFor({ timeout: 15_000 });
      expect(await second.page.locator('#gate-rollback-result li[data-demonstrated]').getAttribute('data-demonstrated')).toBe('true');
      expect(await second.page.locator('#gate-rollback-result li').innerText()).toMatch(/✓ Going back to the old system was rehearsed — performed and reconciled[\s\S]*C-rehearsal · performed · u-owner/);
      expect(second.errors).toEqual([]);
    } finally { await second.close(); }

    // Head office's own record of what the page did: the decision in the owner's name, the signature in the second owner's,
    // and no GO recorded from the office.
    const ex = (await shop.cloud().request({ method: 'GET', path: '/v1/migration/exceptions', userId: OWNER })).body as { exceptions: { exceptionId: string; resolution?: { decidedBy: string; action: string } }[] };
    expect(ex.exceptions.find((e) => e.exceptionId === 'EX-NEG-1')?.resolution).toMatchObject({ decidedBy: OWNER, action: 'correct' });
    const ct = (await shop.cloud().request({ method: 'GET', path: '/v1/migration/control-totals', userId: OWNER })).body as { totals: { totalId: string; signature?: { signedBy: string } }[]; reconciliation: { qg07Passed: boolean } };
    expect(ct.totals.find((t) => t.totalId === 'CT-STOCK-BR1')?.signature?.signedBy).toBe(OWNER2);
    expect(ct.reconciliation.qg07Passed).toBe(true);
    const win = await shop.cloud().request({ method: 'GET', path: '/v1/migration/cutover/windows/C-1', userId: OWNER });
    expect((win.body as { go: boolean }).go).toBe(false);
  }, 240_000);
});
