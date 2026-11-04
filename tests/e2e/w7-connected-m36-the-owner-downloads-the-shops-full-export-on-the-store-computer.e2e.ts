import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { Page } from 'playwright-core';
import { CONNECTED, OWNER, ok, startBoxPageOnCloud, type BoxCloudShop } from './lib/box-page-on-cloud';
import { setUpPracticeStores } from '../support/real-store';
import { auditPage } from './lib/a11y-audit';

/**
 * **W7 · M36-FR-02 / M36-FR-03 · D12-FR-05 · P-06 (open and portable) · OB-367: ONE connected run — the owner downloads
 * the shop's full export from "Trial switches and shop account", in a real browser served by a REAL store computer, over the
 * PRODUCTION API on real PostgreSQL.** Synthetic data only.
 *   • the button asks head office's own export route (GET /v1/platform/export) under the owner's own permission
 *     (platform.tenant.export); the saved file is EXACTLY what that route returns, and it holds this shop's records (the
 *     goods-in written before, and the owner's own grants) and nobody else's;
 *   • the page says in words what the file holds (its parts and records, complete) and when it was taken on the shop's clock;
 *   • the closure readiness then names that export as the latest and complete — and the closure itself stays sealed until the
 *     CA or lawyer writes the retention schedule (OB-367): nothing is closed or deleted;
 *   • English and Tamil; the button carries its icon; the accessibility audit clean; a cashier is not served the page.
 * Needs DATABASE_URL and Chromium; else it SKIPS.
 */

describe.skipIf(!CONNECTED)('M36 connected: the owner downloads the shop\'s full export on the store computer, over the real cloud on PostgreSQL', () => {
  let shop: BoxCloudShop;
  beforeAll(async () => {
    shop = await startBoxPageOnCloud({
      name: 'w7-export', store: 'br-1',
      people: [{ userId: OWNER }, { userId: 'u-cash', branchId: 'br-1' }],
      seed: async (cloud) => {
        await setUpPracticeStores(cloud, OWNER, ['br-1']);
        await cloud.grant('u-cash', 'cashier', undefined, ['br-1']);
        await ok(cloud.request({
          method: 'POST', path: '/v1/inventory/movements', userId: OWNER, idempotencyKey: 'w7-exp-mv-1',
          body: { movementId: 'w7-exp-mv-1', productId: 'W7-EXPORT-RICE', kind: 'received', quantityMinor: 1200, locationId: 'br-1', uom: 'each', enteredBy: OWNER, occurredAt: new Date(Date.now() - 60_000).toISOString() },
        }), 'goods in');
      },
    });
  }, 300_000);
  afterAll(async () => { await shop?.stop(); });

  const waitText = (page: Page, selector: string, text: string) => page.waitForFunction(([sel, want]) => {
    const node = (globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector(sel!);
    return (node?.textContent ?? '').includes(want!);
  }, [selector, text], { timeout: 20_000 });

  it('the owner downloads the full export — head office\'s file unaltered, holding this shop\'s records — and the closure names it, still sealed', async () => {
    const o = await shop.open(OWNER, '/rollout', { acceptDownloads: true });
    const { page, errors, reads, writes } = o;
    await page.waitForSelector('#closure:not([hidden])');
    await waitText(page, '#closure-figures', 'none taken yet');
    expect(await page.textContent('#ex-download')).toContain('Download the shop\'s full export');
    expect(await page.locator('#ex-download svg').count()).toBe(1);
    expect((await page.textContent('#export-lead')) ?? '').toContain('Every record this shop holds');

    const [download, answered] = await Promise.all([
      page.waitForEvent('download'),
      page.waitForResponse((r) => new URL(r.url()).pathname === '/v1/platform/export'),
      page.click('#ex-download'),
    ]);
    expect(download.suggestedFilename()).toMatch(/^shop-full-export-\d{4}-\d{2}-\d{2}-[A-Za-z0-9_-]+\.json$/);
    const saved = await readFile((await download.path())!, 'utf8');
    // The saved file IS head office's answer to that request, byte for byte — the page never re-writes it.
    expect(answered.status()).toBe(200);
    expect(saved).toBe(await answered.text());
    const file = JSON.parse(saved) as { export: { exportId: string; tenantId: string; requestedBy: string; complete: boolean; totalRows: number; domains: { domain: string; rows: number }[] }; data: Record<string, { type: string; payload: Record<string, unknown> }[]> };

    // It is the shop's own export, taken by the owner, and it holds the shop's records: the goods-in and the owner's grants.
    expect(file.export).toMatchObject({ tenantId: shop.tenantId, requestedBy: OWNER, complete: true });
    const all = Object.values(file.data).flat();
    expect(all.some((e) => e.type === 'InventoryMoved' && e.payload['productId'] === 'W7-EXPORT-RICE')).toBe(true);
    expect(all.some((e) => e.type === 'RoleGranted')).toBe(true);
    expect(file.export.totalRows).toBe(all.length);
    // Head office asked again holds the same records (plus its own note that an export was taken, on the platform stream).
    const direct = (await shop.call('GET', '/v1/platform/export', OWNER)).body as typeof file;
    for (const k of Object.keys(file.data)) expect(Object.keys(direct.data), k).toContain(k);
    for (const k of Object.keys(file.data)) expect(JSON.stringify(direct.data[k]!.slice(0, file.data[k]!.length)), k).toBe(JSON.stringify(file.data[k]));
    expect(direct.export.domains.map((d) => d.domain)).toEqual(file.export.domains.map((d) => d.domain));

    // In words: what it holds and when it was taken (the shop's clock), complete.
    await waitText(page, '#ex-status', 'Saved the shop\'s full export');
    const said = (await page.textContent('#ex-status')) ?? '';
    expect(said).toContain(`It holds ${file.export.totalRows} records in ${file.export.domains.length} parts:`);
    expect(said).toContain('(shop\'s clock) by u-owner');
    expect(said).toContain('Complete — every part of the shop is in it.');
    expect(await page.getAttribute('#ex-status', 'data-complete')).toBe('true');

    // The closure readiness now names this export, complete — and the closure stays sealed (OB-367): nothing is closed.
    await waitText(page, '#closure-figures', `${file.export.exportId} · complete`);
    await expect.poll(async () => (await page.textContent('#closure-blockers')) ?? '').not.toContain('no export has been taken');
    expect(await page.getAttribute('#closure-sealed', 'data-sealed')).toBe('true');
    expect(await page.getAttribute('#closure-figures .figure:last-child', 'data-schedule')).toBe('not_set');
    expect(reads).toContain('GET /v1/platform/export');
    expect(writes.filter((w) => w.includes('/v1/platform/'))).toEqual([]); // taking the export writes nothing from the page — head office records the manifest itself
    const closure = (await shop.call('GET', '/v1/platform/tenant/closure', OWNER)).body as { state: string; latestExport: { exportId: string; complete: boolean } | null };
    expect(closure.state).toBe('active');
    expect(closure.latestExport?.complete).toBe(true);

    expect(await auditPage(page, { expectLang: 'en' }), 'the rollout page with the export').toEqual([]);
    await page.click('#lang');
    await waitText(page, '#ex-status', 'கடையின் முழு ஏற்றுமதி சேமிக்கப்பட்டது');
    expect(await page.textContent('#export-h')).toBe('கடையின் முழு ஏற்றுமதி');
    await page.click('#lang');
    expect(errors).toEqual([]);
    await o.close();

    // A cashier is not served the page at all.
    const c = await shop.open('u-cash', '/rollout');
    expect(c.status).toBe(403);
    await c.close();
  }, 180_000);
});
