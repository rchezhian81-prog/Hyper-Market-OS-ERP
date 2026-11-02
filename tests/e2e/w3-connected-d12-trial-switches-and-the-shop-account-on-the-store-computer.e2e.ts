import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Page } from 'playwright-core';
import { CONNECTED, OWNER, ok, operatorGrant, startBoxPageOnCloud, type BoxCloudShop } from './lib/box-page-on-cloud';
import { setUpPracticeStores } from '../support/real-store';
import { auditPage } from './lib/a11y-audit';

/**
 * **W3 · D12 (D12-FR-01 feature entitlements · D12-FR-03 device/version management — trial switches per lane, versioned,
 * one-step rollback · D12-FR-05 data retention/export/closure · R8-9 · OB-316 · OB-321 · OB-367 · C8/C9): ONE connected
 * run — "Trial switches and shop account" in a real browser, served by a REAL store computer, over the PRODUCTION API on
 * real PostgreSQL.** Synthetic data only.
 *   • the IT administrator previews and saves a trial switch for ONE till lane, switches it off and goes back to the first
 *     version in one step (a new version — nothing overwritten); head office's own decision for that lane reads version 3;
 *   • the owner sees the usage meter with the price "not set" (OB-321), the customer-data watch "not set" until the CA
 *     enters a number (C9), downloads the consent record and brings in a consent manager's file (C8) — head office then
 *     says "may send" for that customer; the shop-account closure stays sealed until the CA or lawyer writes the retention
 *     schedule, and nothing is deleted (OB-367);
 *   • English and Tamil; every button its icon; the accessibility audit clean; a cashier opens nothing.
 * Needs DATABASE_URL and Chromium; else it SKIPS.
 */

describe.skipIf(!CONNECTED)('D12 connected: trial switches and the shop account on the store computer, over the real cloud on PostgreSQL', () => {
  let shop: BoxCloudShop;
  beforeAll(async () => {
    shop = await startBoxPageOnCloud({
      name: 'd12-rollout', store: 'br-1',
      people: [{ userId: 'u-it' }, { userId: OWNER }, { userId: 'u-cash', branchId: 'br-1' }],
      seed: async (cloud) => {
        await setUpPracticeStores(cloud, OWNER, ['br-1']);
        // The IT role, laid on the ledger by the operator (the owner may not hand out platform_admin's own permissions).
        await operatorGrant(cloud, 'u-it', 'platform_admin');
        await cloud.grant('u-cash', 'cashier', undefined, ['br-1']);
        for (const lane of ['lane-1', 'lane-7']) await ok(cloud.request({ method: 'POST', path: `/v1/platform/devices/${lane}/register`, userId: OWNER, idempotencyKey: `dev-${lane}`, body: { branchId: 'br-1', kind: 'pos_lane', label: lane } }), lane);
      },
    });
  }, 300_000);
  afterAll(async () => { await shop?.stop(); });

  const open = async (who: string): Promise<{ page: Awaited<ReturnType<BoxCloudShop['open']>>['page']; status: number; errors: string[]; close: () => Promise<void> }> => {
    const o = await shop.open(who, '/rollout', { acceptDownloads: true });
    return { page: o.page, status: o.status, errors: o.errors, close: o.close };
  };
  const waitText = (page: Page, selector: string, text: string) => page.waitForFunction(([sel, want]) => {
    const node = (globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector(sel!);
    return (node?.textContent ?? '').includes(want!);
  }, [selector, text], { timeout: 15_000 });

  it('IT previews and saves a switch for one lane, switches it off, and goes back to version 1 in one step', async () => {
    const { page, errors, close } = await open('u-it');
    await page.waitForSelector('#board:not([hidden])');
    await waitText(page, '#board-rows', 'No trial switch has been set');
    expect(await page.isHidden('#meter')).toBe(false); // IT reads the meter
    expect(await page.isHidden('#consent')).toBe(true); // the consent record is the owner's
    for (const id of ['#ch-preview', '#ch-save']) expect(await page.locator(`${id} svg`).count(), id).toBe(1);
    await page.fill('#ch-key', 'self_checkout'); await page.fill('#ch-branch', 'br-1'); await page.fill('#ch-lane', 'lane-7');
    await page.click('#ch-preview');
    await waitText(page, '#ch-said', 'Lanes that change: lane-7');
    expect((await page.textContent('#ch-said')) ?? '').toContain('No second person needed.');
    await page.click('#ch-save');
    await waitText(page, '#ch-status', 'Fill in the switch name, the branch and the reason first.'); // no reason yet
    await page.fill('#ch-reason', 'self-checkout trial on lane 7');
    await page.click('#ch-save');
    await waitText(page, '#ch-status', 'Saved.');
    await waitText(page, '#board-rows tr[data-key="self_checkout"]', 'v1');
    await page.selectOption('#ch-state', 'off'); await page.fill('#ch-reason', 'scanner jams — stop');
    await page.click('#ch-save');
    await waitText(page, '#board-rows tr[data-key="self_checkout"]', 'v2');
    await page.click('#board-rows tr[data-key="self_checkout"] button[data-act="history"]');
    const v1 = page.locator('#history-rows li[data-version="1"]');
    await v1.waitFor({ timeout: 15_000 });
    await v1.locator('input.back-why').fill('scanner fixed — back on');
    expect(await v1.locator('button[data-act="back"] svg').count()).toBe(1);
    await v1.locator('button[data-act="back"]').click();
    await waitText(page, '#board-rows tr[data-key="self_checkout"]', 'v3');
    await waitText(page, '#history-rows li[data-version="3"]', 'restored version v1');
    const decision = (await shop.cloud.request({ method: 'GET', path: '/v1/platform/rollout/self_checkout/decision?branchId=br-1&laneId=lane-7', userId: 'u-it' })).body as { on: boolean; source: string; version: number };
    expect(decision).toMatchObject({ on: true, source: 'lane', version: 3 });
    expect(await auditPage(page, { expectLang: 'en' }), 'the rollout page').toEqual([]);
    await page.click('#lang');
    expect(await page.textContent('#page-h')).toBe('சோதனை சுவிட்சுகள் மற்றும் கடை கணக்கு');
    expect(errors).toEqual([]);
    await close();
  }, 120_000);

  it('the owner: the meter with the price "not set", the watch "not set", the consent record out and a consent manager\'s file in', async () => {
    const { page, errors, close } = await open('u-owner');
    await page.waitForSelector('#meter:not([hidden])');
    await waitText(page, '#meter-figures', 'Price');
    expect(await page.getAttribute('#meter-figures .figure:last-child', 'data-price')).toBe('not set');
    expect((await page.textContent('#meter-figures')) ?? '').toContain('not set');
    expect((await page.textContent('#meter-info')) ?? '').toContain('For information only');
    await waitText(page, '#watch-said', 'the watch never alerts until the CA enters a number');
    expect((await page.textContent('#watch-figures')) ?? '').toContain('not set');
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#cs-download')]);
    expect(download.suggestedFilename()).toMatch(/^consent-record-\d{4}-\d{2}-\d{2}\.json$/);
    await waitText(page, '#cs-status', 'Downloaded:');
    await page.click('#cs-import');
    await waitText(page, '#cs-status', 'Choose the file first.');
    const doc = { format: 'sre-dpdp-consent-record/1', consentManager: { id: 'CM-REG-0042', name: 'Synthetic Consent Manager' }, dataFiduciary: { tenantId: shop.tenantId, name: 'SRE' },
      records: [{ artefactId: 'ART-E2E-1', dataPrincipalRef: 'C-E2E', purpose: 'marketing', channel: 'email', action: 'given', at: new Date(Date.now() - 60_000).toISOString() }] };
    await page.setInputFiles('#cs-file', { name: 'cm.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(doc)) });
    await page.click('#cs-import');
    await waitText(page, '#cs-status', '1 applied · 0 need a person to check');
    const may = (await shop.cloud.request({ method: 'GET', path: '/v1/customers/C-E2E/may-we-send?purpose=marketing&channel=email', userId: 'u-owner' })).body as { verdict: string };
    expect(may.verdict).toBe('may_send');
    // OB-367: the closure section says everything is sealed until the CA or the lawyer writes the retention schedule — the
    // schedule "not set" — and nothing is deleted; no export taken yet, so it says what blocks closure. Then in Tamil.
    await page.waitForSelector('#closure:not([hidden])');
    await waitText(page, '#closure-sealed', 'It stays sealed until the CA or the lawyer writes a closure retention schedule');
    expect((await page.textContent('#closure-sealed')) ?? '').toContain('nothing is deleted');
    expect(await page.getAttribute('#closure-sealed', 'data-sealed')).toBe('true');
    expect(await page.getAttribute('#closure-figures .figure:last-child', 'data-schedule')).toBe('not_set');
    expect((await page.textContent('#closure-figures')) ?? '').toContain('Closure retention schedule');
    expect((await page.textContent('#closure-figures')) ?? '').toContain('none taken yet');
    expect((await page.textContent('#closure-blockers')) ?? '').toContain('no export has been taken');
    expect((await page.textContent('#closure-who')) ?? '').toContain('the owner approves');
    expect(await auditPage(page, { expectLang: 'en' }), 'the rollout page, owner').toEqual([]);
    await page.click('#lang');
    await waitText(page, '#closure-sealed', 'மூடல் தக்கவைப்பு அட்டவணை: அமைக்கப்படவில்லை');
    expect((await page.textContent('#closure-h')) ?? '').toBe('இந்தக் கடையின் கணக்கை மூடுதல்');
    await page.click('#lang');
    expect(errors).toEqual([]);
    await close();
    // A cashier: head office's own words for her hold no rollout word — the store computer does not serve her the page.
    const c = await open('u-cash');
    expect(c.status).toBe(403);
    await c.close();
  }, 120_000);
});
