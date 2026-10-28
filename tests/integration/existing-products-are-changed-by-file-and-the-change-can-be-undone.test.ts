import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { approvedRequestId } from '../support/approval-request';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';

/**
 * **M30 · SF-06 residual (round 8) — EXISTING products changed by file, previewed, approved, undone.** On the real API, in
 * memory and — with DATABASE_URL — on real PostgreSQL, through `product-update-v1`:
 *   • the preview lists every change field by field (from → to) and every row error by line: an unknown product, a SKU / base
 *     unit / lifecycle the file may never change, a row that changes nothing, a change that breaks the product's own rules;
 *   • nothing changes until a second person approves THIS file; then each product gets a new version (the old one kept);
 *   • the undo (a second person's approval again) puts back the version each product had before the load — and is refused,
 *     by name, for a product someone changed again after the load (that change would be silently lost).
 */

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });
const backings: { name: string; harness: () => ApiHarness }[] = [{ name: 'the in-memory event store', harness: () => apiHarness() }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });

type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const HEADER = 'productId,name,brand,primaryCategoryId,taxClass,allergens,countryOfOrigin,netQuantity,packerDetails,minimumAge';
const csv = (...rows: string[]) => [HEADER, ...rows].join('\n');

describe.each(backings)('existing products are changed by file, and the change can be undone — on $name (M30)', ({ harness }) => {
  it('preview with changes and row errors → approval → new versions → undo to what was there; undo refused after a later change', async () => {
    const h = harness();
    const A = randomUUID();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-mgr', 'store_manager');
    await h.provisionRole(A, 'u-cash', 'cashier');
    const post = (path: string, userId: string, body: unknown, key = `k-${randomUUID()}`) => h.request({ method: 'POST', path, userId, tenantId: A, idempotencyKey: key, body });
    const get = (path: string) => h.request({ method: 'GET', path, userId: 'u-owner', tenantId: A });
    const product = async (id: string) => ((await get(`/v1/catalogue/products/${id}`)).body as { product: Record<string, unknown> & { safety?: Record<string, unknown> } }).product;
    for (const [id, body] of [['grocery', { name: 'Grocery', parentId: null }], ['staples', { name: 'Staples', parentId: 'grocery', regulated: ['food', 'packed'] }], ['home', { name: 'Home care', parentId: null }]] as const) {
      expect((await post(`/v1/catalogue/categories/${id}`, 'u-owner', body)).status).toBe(201);
    }
    expect((await post('/v1/catalogue/products/p-rice/publish', 'u-owner', { product: { sku: 'RICE5', name: 'Rice 5kg', baseUom: 'each', primaryCategoryId: 'staples', taxClass: '1006', lifecycle: 'draft', safety: { allergens: [], countryOfOrigin: 'India', netQuantity: '5 kg', packerDetails: 'Synthetic Mills', consumerCareContact: 'Care desk 1800-000-0000' } } })).status).toBe(201);
    expect((await post('/v1/catalogue/products/p-soap/publish', 'u-owner', { product: { sku: 'SOAP', name: 'Soap', baseUom: 'each', primaryCategoryId: 'home', taxClass: '3401', lifecycle: 'draft' } })).status).toBe(201);
    const riceBefore = await product('p-rice');

    // ── THE PREVIEW: every change from → to, every bad row by line ─────────────────────────────────────────────────────
    const good = csv('p-rice,Ponni Rice 5kg,Kaveri,,,,,,Kaveri Mills Erode,', 'p-soap,,Neem,,,,,,,');
    const v = await post('/v1/import/validate', 'u-owner', { templateId: 'product-update-v1', text: good });
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({ preview: { validCount: 2, errorRowCount: 0, commitReady: true } });
    expect((v.body as { changes: unknown }).changes).toEqual([
      { line: 2, key: 'p-rice', changes: [{ field: 'name', from: 'Rice 5kg', to: 'Ponni Rice 5kg' }, { field: 'brand', from: '', to: 'Kaveri' }, { field: 'packerDetails', from: 'Synthetic Mills', to: 'Kaveri Mills Erode' }] },
      { line: 3, key: 'p-soap', changes: [{ field: 'brand', from: '', to: 'Neem' }] },
    ]);
    const bad = await post('/v1/import/validate', 'u-owner', { templateId: 'product-update-v1', text: [`${HEADER},sku`, 'p-ghost,X,,,,,,,,,', 'p-rice,Rice 5kg,,,,,,,,,', 'p-soap,,,,,,,,,,SOAP-NEW', 'p-rice,,,staples,,,,,,0,'].join('\n') });
    const errors = (bad.body as { preview: { errors: { line: number; column: string; message: string }[]; commitReady: boolean } }).preview;
    expect(errors.commitReady).toBe(false);
    const byLine = (n: number) => errors.errors.filter((e) => e.line === n).map((e) => e.column);
    expect(byLine(2)).toContain('productId'); // unknown product
    expect(errors.errors.find((e) => e.line === 3)?.message).toMatch(/Nothing on this row changes product p-rice/);
    expect(byLine(4)).toContain('sku'); // a SKU is never changed by file
    expect(byLine(5)).toContain('minimumAge');
    // Nothing changed by a preview.
    expect((await product('p-rice')).name).toBe('Rice 5kg');

    // ── APPROVAL: nothing without a second person's approval of THIS file; then new versions ──────────────────────────
    const fp = (v.body as { contentFingerprint: string }).contentFingerprint;
    expect(codeOf(await post('/v1/import/commit', 'u-owner', { jobId: 'U-1', templateId: 'product-update-v1', text: good }))).toBe('no_approval');
    expect((await post('/v1/import/commit', 'u-mgr', { jobId: 'U-1', templateId: 'product-update-v1', text: good, approvalId: 'x' })).status).toBe(403); // a manager may not publish products
    const approvalId = await approvedRequestId(h, A, 'u-owner', 'u-mgr', { kind: 'data_import_commit', subjectRef: 'U-1', details: { jobId: 'U-1', contentFingerprint: fp } });
    const loaded = await post('/v1/import/commit', 'u-owner', { jobId: 'U-1', templateId: 'product-update-v1', text: good, approvalId });
    expect(loaded.status).toBe(200);
    expect(loaded.body).toMatchObject({ committed: true, rowsApplied: 2, effects: [{ kind: 'product_update', ref: 'p-rice' }, { kind: 'product_update', ref: 'p-soap' }] });
    const riceAfter = await product('p-rice');
    expect(riceAfter).toMatchObject({ name: 'Ponni Rice 5kg', brand: 'Kaveri', sku: 'RICE5', baseUom: 'each', lifecycle: riceBefore['lifecycle'], safety: { allergens: [], countryOfOrigin: 'India', netQuantity: '5 kg', packerDetails: 'Kaveri Mills Erode' } });
    expect((await product('p-soap')).brand).toBe('Neem');

    // ── UNDO: a second person's approval; each product goes back to the version the load replaced ──────────────────────
    const undo = await approvedRequestId(h, A, 'u-owner', 'u-mgr', { kind: 'data_import_rollback', subjectRef: 'U-1', details: { jobId: 'U-1' } });
    expect((await post('/v1/import/commits/U-1/rollback', 'u-owner', { reason: 'wrong brand file', approvalId: undo })).status).toBe(200);
    expect(await product('p-rice')).toMatchObject({ name: 'Rice 5kg', safety: { packerDetails: 'Synthetic Mills' } });
    expect((await product('p-rice'))['brand']).toBeUndefined();
    expect((await product('p-soap'))['brand']).toBeUndefined();
    expect((await get('/v1/import/commits/U-1')).body).toMatchObject({ job: { rolledBack: { requestedBy: 'u-owner', approvedBy: 'u-mgr', reason: 'wrong brand file' } } });

    // ── A later change by hand blocks the undo of a load, by name (it would be silently lost — hard rule #10) ─────────
    const second = csv('p-soap,,Neem Gold,,,,,,,');
    const fp2 = ((await post('/v1/import/validate', 'u-owner', { templateId: 'product-update-v1', text: second })).body as { contentFingerprint: string }).contentFingerprint;
    const ap2 = await approvedRequestId(h, A, 'u-owner', 'u-mgr', { kind: 'data_import_commit', subjectRef: 'U-2', details: { jobId: 'U-2', contentFingerprint: fp2 } });
    expect((await post('/v1/import/commit', 'u-owner', { jobId: 'U-2', templateId: 'product-update-v1', text: second, approvalId: ap2 })).status).toBe(200);
    expect((await post('/v1/catalogue/products/p-soap/publish', 'u-owner', { product: { sku: 'SOAP', name: 'Soap bar', baseUom: 'each', primaryCategoryId: 'home', taxClass: '3401', lifecycle: 'draft', brand: 'Neem Gold' } })).status).toBe(201);
    const undo2 = await approvedRequestId(h, A, 'u-owner', 'u-mgr', { kind: 'data_import_rollback', subjectRef: 'U-2', details: { jobId: 'U-2' } });
    const refused = await post('/v1/import/commits/U-2/rollback', 'u-owner', { reason: 'undo', approvalId: undo2 });
    expect(refused.status).toBe(409);
    expect(codeOf(refused)).toBe('import_effect_in_use');
    expect((refused.body as { error: { whatHappened: string } }).error.whatHappened).toMatch(/p-soap was changed again after this load/);
    expect((await product('p-soap')).name).toBe('Soap bar');
  });
});
