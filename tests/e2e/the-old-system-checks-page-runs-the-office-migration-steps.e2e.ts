import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';
import type { RealCloud } from '../support/real-store';
import type { ApiHarness } from '../support/api-harness';
import { prepareCutoverEvidence, askTheGate } from '../support/cutover-go';
import { planLoad, executeLoad, type ExtractBundle } from '../../packages/migration/src/index';
import { storeRules } from '../support/store-rules';

/**
 * W3 · MG-01 · MG-03 · MG-07 · MG-08 · MG-09 · MG-11 · MG-12 (roadmap §30 migration controls) — the Old system checks page,
 * in a real browser, on the PRODUCTION API over real PostgreSQL, on SYNTHETIC legacy data (never the real old ERP, OB-282).
 * Every one of these head-office routes had no caller on any screen before this page:
 *
 *   MG-01  the owner lists two synthetic sources; head office names the paper file's four gaps and the program's none;
 *   MG-03  the owner approves a tax-code mapping (his name and the time come back on it) and keeps the file; head office
 *          then measures it against the values the old data carries — 3 rows carry a code nothing covers;
 *   MG-07  the br-1 manager proposes leaving 40 unreadable scans behind, valued; the owner rejects it in writing;
 *   MG-09  the owner compares two synthetic item exports — one new, one changed, one gone — each now a problem to decide;
 *   MG-11  the switch-over night: the window the owner's GO opened reads OPEN with its 48 hours; the night check says no
 *          agreed limit is crossed (and names what it cannot judge);
 *   MG-08  the owner asks to undo the opening load; he cannot approve his own ask (refused in head office's words); a
 *          second owner approves it on the screen and the read-back says every domain is back to zero;
 *   MG-12  switching the old system off is blocked three ways by name, and the page says the old data is never deleted.
 *
 * Synthetic data, a fresh tenant. Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['old', 'system', 'checks', 'e2e', 'key'].join('-').padEnd(48, '0');
const OWNER2 = 'u-owner2';
const RECONCILER = 'u-reconciler';
const LOAD = 'load-opening';
/** A tiny SYNTHETIC opening: one product, twelve on the shelf at the practice store (never the real old ERP). */
const EXTRACT: ExtractBundle = {
  categories: [{ categoryId: 'home', name: 'Home care', parentId: null }],
  taxRates: [{ hsnCode: '3402', effectiveFrom: '2017-07-01', rateBps: 1800 }],
  products: [{ productId: 'P-SYN-1', sku: 'SYN-1', name: 'Synthetic soap', baseUom: 'each', primaryCategoryId: 'home', taxClass: '3402', lifecycle: 'active', barcodes: [{ code: 'INT-SYN-1', kind: 'internal' }], priceMinor: 2_000, mrpMinor: 2_500, costMinor: 1_100, marginFloorBps: 0 }],
  suppliers: [], customers: [],
  openingStock: [{ productId: 'P-SYN-1', locationId: 'br-1', quantityMinor: 12, uom: 'each', unitCostMinor: 1_100 }],
};

/** The few harness calls the cutover helpers make, answered by the REAL cloud (each as that person's own sign-in). */
function asHarness(cloud: RealCloud): ApiHarness {
  return {
    request: (r: { method: 'GET' | 'POST' | 'PUT' | 'DELETE'; path: string; userId: string; branchId?: string; body?: unknown; idempotencyKey?: string; amr?: readonly string[] | null }) =>
      cloud.request({ method: r.method, path: r.path, userId: r.userId, ...(r.branchId === undefined ? {} : { branchId: r.branchId }), ...(r.body === undefined ? {} : { body: r.body }), ...(r.idempotencyKey === undefined ? {} : { idempotencyKey: r.idempotencyKey }), ...(r.amr === null ? { machine: true } : {}) }),
    provisionRole: (_t: string, userId: string, roleId: string, scope?: readonly string[] | 'all') => cloud.grant(userId, roleId, undefined, scope ?? 'all'),
  } as unknown as ApiHarness;
}

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the Old system checks page runs the office migration steps (MG-01/03/07/08/09/11/12)', () => {
  let browser: Browser;
  let shop: InboxShop;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/old-system', html: 'old-system.html', dataGlobal: 'oldSystemData' },
      seed: async (cloud) => {
        // A second owner (the second approver, OB-44) and the parallel run's named reconciler — granted the product's way.
        await cloud.grant(OWNER2, 'owner');
        await cloud.grant(RECONCILER, 'store_manager');
        // The switch-over gate brought to GO through the real routes, on synthetic evidence (OB-52: the GO opens the window).
        const h = asHarness(cloud);
        await storeRules(h, cloud.tenantId, OWNER, 'br-1', 0); // the practice store's rules, so its prices can be judged
        const plan = planLoad(EXTRACT, {
          target: { targetId: 'w3-rehearsal', tenantId: cloud.tenantId, kind: 'rehearsal', label: 'W3 synthetic rehearsal shop' }, tenantId: cloud.tenantId, demoTenantIds: [], operator: OWNER,
          targetProductCount: 0, extractSealed: true, blockingExceptionsOpen: 0, loadId: LOAD, stockLocationId: 'br-1', receivedOnDate: new Date().toISOString().slice(0, 10), currency: 'INR',
        });
        if (!plan.ok) throw new Error(`${plan.refusedBecause}: ${plan.problems.join('; ')}`);
        const loaded = await executeLoad(h, plan);
        if (!loaded.ok) throw new Error(`the synthetic opening did not load: ${JSON.stringify(loaded.steps.filter((x) => !x.ok))}`);
        await prepareCutoverEvidence(h, { tenantId: cloud.tenantId, ownerId: OWNER, signerId: OWNER2, reconcilerId: RECONCILER, deltaLocationId: 'S1-DELTA', storeIds: ['br-1'] /* the practice store's computer reports it synced */ });
        const gate = await askTheGate(h, cloud.tenantId, OWNER, 'C-1', OWNER);
        if (!gate.decision.go) throw new Error(`the switch-over gate did not reach GO: ${JSON.stringify(gate.decision.failed)}`);
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  const open = async (who: string) => {
    const context = await browser.newContext();
    await shop.signIn(context, who, who === MGR ? 'br-1' : undefined);
    const page = await context.newPage();
    const errors: string[] = []; const writes: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${u.pathname}`); });
    await page.goto(`${shop.base}/old-system`, { waitUntil: 'load' });
    return { page, errors, writes, close: () => context.close() };
  };
  const status = (page: Page, id: string) => page.locator(`#${id}`).innerText();

  it('MG-01 discovery, MG-03 mapping, MG-09 export comparison and MG-12 retirement — the owner, on the screen', async () => {
    const s = await open(OWNER);
    try {
      expect(s.writes, 'nothing is written on open').toEqual([]);
      // ── MG-01: two synthetic sources; the paper file's gaps are named by head office.
      await s.page.fill('#src-id', 'old-erp'); await s.page.fill('#src-name', 'Synthetic old shop program');
      await s.page.selectOption('#src-kind', 'erp_database'); await s.page.fill('#src-owner', 'u-it-custodian');
      await s.page.fill('#src-rows', '15000'); await s.page.selectOption('#src-basis', 'counted'); await s.page.fill('#src-retention', '8');
      await s.page.click('#src-add');
      await s.page.fill('#src-id', 'paper-ledgers'); await s.page.fill('#src-name', 'Synthetic paper credit ledgers');
      await s.page.selectOption('#src-kind', 'paper'); await s.page.selectOption('#src-basis', 'unknown'); await s.page.uncheck('#src-extract');
      await s.page.click('#src-add');
      expect(await s.page.locator('#src-list li[data-source]').count()).toBe(2);
      await s.page.click('#src-check');
      await s.page.locator('#disc-result li[data-complete]').waitFor({ timeout: 15_000 });
      expect(await s.page.locator('#disc-result li[data-complete]').getAttribute('data-complete')).toBe('false');
      expect(await s.page.locator('#disc-result li[data-complete]').innerText()).toMatch(/⚠ 4 gap\(s\) — the list is not complete[\s\S]*15000 rows counted/);
      const gaps = await s.page.locator('#disc-result li[data-gap]').evaluateAll((els) => els.map((e) => `${(e as HTMLElement).dataset['source']} ${(e as HTMLElement).dataset['gap']}`));
      expect(gaps).toEqual(['paper-ledgers no_named_owner', 'paper-ledgers volume_unknown', 'paper-ledgers no_retention_period', 'paper-ledgers not_extractable']);

      // ── MG-03: approve a tax-code mapping in the owner's name; then measure it against the old data.
      await s.page.fill('#map-id', 'tax-codes');
      await s.page.selectOption('#map-domain', 'tax_code'); await s.page.fill('#map-old', 'T5'); await s.page.fill('#map-new', '0500'); await s.page.fill('#map-why', 'the old T5 was 5% GST');
      await s.page.click('#map-add');
      await s.page.click('#map-coverage');
      await expect.poll(() => status(s.page, 'map-status')).toBe('Approve the mapping first — head office measures coverage only with an approved mapping.');
      await s.page.click('#map-approve');
      await s.page.locator('#map-result li[data-approved="true"]').waitFor({ timeout: 15_000 });
      expect(await s.page.locator('#map-result li').innerText()).toMatch(/✓ tax-codes v1[\s\S]*Approved by: u-owner · on: 20\d\d-/);
      expect(await s.page.locator('#map-save').getAttribute('download')).toBe('tax-codes-v1-approved.json');
      for (const [v, rows] of [['T5', '9'], ['T12', '3']] as const) {
        await s.page.selectOption('#seen-domain', 'tax_code'); await s.page.fill('#seen-value', v); await s.page.fill('#seen-rows', rows); await s.page.click('#seen-add');
      }
      await s.page.click('#map-coverage');
      await s.page.locator('#map-result li[data-covered]').waitFor({ timeout: 15_000 });
      expect(await s.page.locator('#map-result li[data-covered]').innerText()).toMatch(/⚠ 3 rows carry a value nothing covers/);
      expect(await s.page.locator('#map-result li[data-uncovered="tax_code"]').innerText()).toMatch(/Tax code: T12/);

      // ── MG-09: two synthetic item exports.
      await s.page.click('#diff-show');
      await s.page.locator('#diff-runs li').first().waitFor({ timeout: 15_000 });
      expect(await s.page.locator('#diff-runs').innerText()).toMatch(/No comparison yet\./);
      await s.page.fill('#diff-id', 'items-1');
      await s.page.selectOption('#diff-domain', 'items');
      await s.page.fill('#diff-col-item_code', 'Code'); await s.page.fill('#diff-col-name', 'Name');
      await s.page.setInputFiles('#diff-baseline', { name: 'items-loaded.csv', mimeType: 'text/csv', buffer: Buffer.from('Code,Name\nA1,Synthetic rice\nA2,Synthetic dal\n') });
      await s.page.setInputFiles('#diff-latest', { name: 'items-latest.csv', mimeType: 'text/csv', buffer: Buffer.from('Code,Name\nA1,Synthetic rice 5kg\nA3,Synthetic oil\n') });
      await s.page.click('#diff-run');
      await s.page.locator('#diff-runs li[data-diff="items-1"]').waitFor({ timeout: 15_000 });
      await expect.poll(() => status(s.page, 'diff-status')).toMatch(/^✓ 3 difference\(s\), each now an exception to decide on the migration register — nothing was applied\./);
      expect(await s.page.locator('#diff-runs li[data-diff="items-1"]').innerText()).toMatch(/⏸ items-1 · Items[\s\S]*1 new · 1 changed · 1 gone · 0 same · 3 still to decide[\s\S]*items-loaded\.csv → items-latest\.csv · u-owner/);

      // ── MG-12: blocked three ways, by name; the old data is never deleted.
      await s.page.fill('#ar-id', 'arch-1'); await s.page.fill('#ar-source', 'old-erp'); await s.page.fill('#ar-digest', 'synthetic-digest-1');
      await s.page.fill('#ar-rows', '15000'); await s.page.fill('#ar-on', '2026-11-01'); await s.page.fill('#ar-years', '8');
      await s.page.fill('#ar-earliest', '2019-04-01'); await s.page.fill('#ar-latest', '2026-10-31');
      await s.page.click('#ar-assess');
      await s.page.locator('#retire-result li[data-may-retire]').waitFor({ timeout: 15_000 });
      expect(await s.page.locator('#retire-result li[data-may-retire]').getAttribute('data-may-retire')).toBe('false');
      expect(await s.page.locator('#retire-result li[data-may-retire]').innerText()).toMatch(/⚠ Not yet[\s\S]*keep the records until 2034-10-31/);
      expect(await s.page.locator('#retire-result li[data-blocker]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset['blocker']))).toEqual(['retention_not_elapsed', 'restore_never_verified', 'cutover_not_accepted']);
      expect(await s.page.locator('#retire-result').innerText()).toMatch(/The old data is never deleted, whatever else happens\./);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    // What the page recorded is head office's: the comparison and its three exceptions are on the register.
    const runs = (await shop.cloud().request({ method: 'GET', path: '/v1/migration/export-diffs', userId: OWNER })).body as { runs: { diffId: string; by: string; exceptionIds: string[] }[] };
    expect(runs.runs.map((r) => [r.diffId, r.by, r.exceptionIds.length])).toEqual([['items-1', OWNER, 3]]);
  }, 180_000);

  it('MG-07 the manager proposes leaving records behind and the owner rejects in writing; MG-11 the night; MG-08 a second owner approves undoing the opening load', async () => {
    const m = await open(MGR);
    try {
      await m.page.click('#excl-show');
      await m.page.locator('#excl-list li').first().waitFor({ timeout: 15_000 });
      expect(await m.page.locator('#excl-decide').isHidden()).toBe(true); // only the owner decides (OD-05)
      expect(await m.page.locator('#night-check').isHidden()).toBe(true);
      await m.page.fill('#excl-id', 'scans-2019'); await m.page.selectOption('#excl-scope', 'named_records');
      await m.page.fill('#excl-count', '40'); await m.page.fill('#excl-value', '1250.50');
      await m.page.fill('#excl-desc', 'Synthetic scanned delivery notes from 2019');
      await m.page.fill('#excl-reason', 'the scan files are unreadable — every one fails to open');
      await m.page.click('#excl-propose-btn');
      await m.page.locator('#excl-list li[data-exclusion="scans-2019"]').waitFor({ timeout: 15_000 });
      expect(await m.page.locator('#excl-list li[data-exclusion="scans-2019"]').innerText()).toMatch(/⏸ scans-2019 · waiting for the owner[\s\S]*Named records · Synthetic scanned delivery notes from 2019 · 40 · ₹1,250\.50[\s\S]*proposed by: u-mgr-br1/);
      expect(m.errors).toEqual([]);
    } finally { await m.close(); }

    const o = await open(OWNER);
    try {
      await o.page.click('#excl-show');
      await o.page.locator('#excl-list li[data-exclusion="scans-2019"]').waitFor({ timeout: 15_000 });
      await o.page.selectOption('#excl-which', 'scans-2019');
      await o.page.click('#excl-decide-btn');
      await expect.poll(() => status(o.page, 'excl-status')).toBe('Choose approve or reject.');
      await o.page.selectOption('#excl-choice', 'reject');
      await o.page.fill('#excl-statement', 'Keep them — the supplier may still ask about 2019.');
      await o.page.click('#excl-decide-btn');
      await o.page.locator('#excl-list li[data-exclusion="scans-2019"][data-status="rejected"]').waitFor({ timeout: 15_000 });
      expect(await o.page.locator('#excl-list li[data-exclusion="scans-2019"]').innerText()).toMatch(/✗ scans-2019 · rejected by the owner[\s\S]*decided by: u-owner — “Keep them — the supplier may still ask about 2019\.”/);

      // ── MG-11: the window the GO opened, and the night check against the owner's agreed limits.
      await o.page.fill('#cutover-id', 'C-1');
      await o.page.click('#window-show');
      await o.page.locator('#night-result li[data-window]').waitFor({ timeout: 15_000 });
      expect(await o.page.locator('#night-result li[data-window]').getAttribute('data-window')).toBe('open');
      expect(await o.page.locator('#night-result li').innerText()).toMatch(/● Window OPEN[\s\S]*GO given by: u-owner/);
      await o.page.click('#night-check');
      await o.page.locator('#night-result li[data-roll-back]').waitFor({ timeout: 15_000 });
      expect(await o.page.locator('#night-result li[data-roll-back]').getAttribute('data-roll-back')).toBe('false');
      expect(await o.page.locator('#night-result li[data-roll-back]').innerText()).toMatch(/✓ No agreed limit is crossed/);

      // ── MG-08: the owner asks to undo the opening load; he cannot approve his own ask.
      await o.page.fill('#load-id', LOAD);
      await o.page.fill('#reverse-reason', 'the synthetic stock file was the wrong day');
      await o.page.click('#reverse-ask');
      await o.page.locator('#reverse-result li[data-reversed]').waitFor({ timeout: 15_000 });
      expect(await o.page.locator('#reverse-result li[data-reversed]').getAttribute('data-approved')).toBe('false');
      expect(await o.page.locator('#reverse-result li[data-reversed]').innerText()).toMatch(/⏸ Not undone yet[\s\S]*load-opening · C-1 · asked by: u-owner — “the synthetic stock file was the wrong day”/);
      await o.page.click('#reverse-approve');
      await o.page.locator('#night-status.err').waitFor({ timeout: 15_000 });
      expect(await status(o.page, 'night-status')).toMatch(/^Head office refused: You requested the reversal of load load-opening, so you cannot also approve it/);
      expect(o.errors).toEqual([]);
    } finally { await o.close(); }

    const second = await open(OWNER2);
    try {
      await second.page.fill('#load-id', LOAD);
      await second.page.click('#reverse-approve');
      await second.page.locator('#reverse-result li[data-approved="true"]').waitFor({ timeout: 15_000 });
      expect(await second.page.locator('#reverse-result li[data-reversed]').getAttribute('data-reversed')).toBe('true');
      expect(await second.page.locator('#reverse-result li[data-reversed]').innerText()).toMatch(/✓ Every domain is back to zero[\s\S]*approved by: u-owner2/);
      // The stock the load opened was taken back out by its own record — opened 12, taken back 12, none left.
      expect(await second.page.locator('#reverse-result').innerText()).toMatch(/stock_quantity · [^\n]*\n[^\n]*opened 12 · taken back 12 · left 0/);
      expect(second.errors).toEqual([]);
    } finally { await second.close(); }
    // Head office's own record: asked by one owner, approved by the other.
    const back = (await shop.cloud().request({ method: 'GET', path: `/v1/migration/opening-reversals/${LOAD}`, userId: OWNER })).body as { request: { requestedBy: string }; approval: { approvedBy: string } };
    expect([back.request.requestedBy, back.approval.approvedBy]).toEqual([OWNER, OWNER2]);
  }, 180_000);
});
