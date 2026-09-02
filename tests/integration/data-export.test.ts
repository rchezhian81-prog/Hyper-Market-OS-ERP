import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Domain data export, end to end (M30-FR-02, API-03). Your data is yours: every authorised domain
// exports to an open CSV + JSON schema, the caller's OWN authority deciding whether it is allowed
// (per domain), which branch's rows come back, and whether sensitive columns are shown or redacted —
// and every export is logged (hard rule #6), because the audit record is the only evidence
// afterwards of who took the shop's data. Two real domains are wired: `products` (gated
// catalogue.pack.read) and `import-commits` (gated purchase.import.read). All three routes gated
// export.read; the domain's own permission is enforced underneath by the tested engine.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GROCERY = { categoryId: 'grocery', name: 'Grocery', parentId: null };
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

const product = (over: Record<string, unknown> = {}) =>
  ({ sku: 'SKU-X', name: 'A product', baseUom: 'each', primaryCategoryId: 'grocery', taxClass: '25010020', lifecycle: 'active', ...over });
const publish = (h: ApiHarness, u: string, productId: string, p: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/catalogue/products/${productId}/publish`, userId: u, tenantId: A, idempotencyKey: key, body: { product: p, categories: [GROCERY] } });

const listDomains = (h: ApiHarness, u: string) =>
  h.request({ method: 'GET', path: '/v1/export', userId: u, tenantId: A });
const exportDomain = (h: ApiHarness, u: string, domain: string, key: string) =>
  h.request({ method: 'POST', path: `/v1/export/${domain}`, userId: u, tenantId: A, idempotencyKey: key });
const exportLog = (h: ApiHarness, u: string) =>
  h.request({ method: 'GET', path: '/v1/exports', userId: u, tenantId: A });

// Seed one committed import job, via the real M30 commit route (uploader ≠ approver, §28).
const seedImportCommit = (h: ApiHarness, u: string, jobId: string, key: string) =>
  h.request({
    method: 'POST', path: '/v1/import/commit', userId: u, tenantId: A, idempotencyKey: key,
    body: {
      jobId,
      template: { id: 'product-v1', domain: 'product', columns: [{ name: 'sku', type: 'text', required: true }], keyColumns: ['sku'] },
      text: 'sku\nA1\nA2',
      approval: { status: 'approved', decidedBy: 'u-approver' },
    },
  });

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');                     // export.read + export.sensitive + catalogue + import
  await h.provisionRole(A, 'u-mgr', 'store_manager');  // export.read + catalogue.pack.read (NOT export.sensitive)
  await h.provisionRole(A, 'u-book', 'accountant');    // export.read + purchase.import.read (NOT catalogue.pack.read)
  await h.provisionRole(A, 'u-cash', 'cashier');       // no export.read
  return h;
}

describe('domain data export: an open, audited, permission-checked route out of the system (M30-FR-02)', () => {
  it('lists the exportable domains and their schema (which columns are sensitive)', async () => {
    const h = await cast();
    const res = await listDomains(h, 'u-owner');
    expect(res.status).toBe(200);
    const domains = (res.body as { domains: { domain: string; requires: string; columns: unknown[] }[] }).domains;
    expect(domains.map((d) => d.domain).sort()).toEqual(['import-commits', 'products']);
    expect(domains.find((d) => d.domain === 'products')!.requires).toBe('catalogue.pack.read');
  });

  it('exports the product master as CSV + schema, logs the export, and survives a restart', async () => {
    const h = await cast();
    expect((await publish(h, 'u-owner', 'p-a', product({ sku: 'SKU-A', name: 'Rice 5kg' }), 'k-a')).status).toBe(201);
    expect((await publish(h, 'u-owner', 'p-b', product({ sku: 'SKU-B', name: 'Toor Dal' }), 'k-b')).status).toBe(201);

    const res = await exportDomain(h, 'u-owner', 'products', 'x-1');
    expect(res.status).toBe(200);
    const body = res.body as { domain: string; csv: string; schema: { domain: string; columns: unknown[] }; audit: { rowCount: number; userId: string } };
    expect(body.domain).toBe('products');
    expect(body.schema.domain).toBe('products');
    expect(body.audit).toMatchObject({ rowCount: 2, userId: 'u-owner' });
    const lines = body.csv.trimEnd().split('\n');
    expect(lines[0]).toBe('productId,sku,name,brand,manufacturer,category,uom,taxClass,status,recallBlocked');
    expect(lines).toHaveLength(3); // header + 2 products
    expect(body.csv).toContain('SKU-A');
    expect(body.csv).toContain('Rice 5kg');

    // The export is logged — who took what, when, how many.
    const log = await exportLog(h, 'u-owner');
    expect((log.body as { total: number }).total).toBe(1);
    expect((log.body as { exports: { domain: string; rowCount: number }[] }).exports[0]).toMatchObject({ domain: 'products', rowCount: 2 });

    // Durable: the audit ledger survives a restart.
    const h2 = apiHarness({ store: h.store });
    expect((await exportLog(h2, 'u-owner')).body).toMatchObject({ total: 1 });
  });

  it('enforces the domain’s OWN permission: the accountant may export import-commits but not products', async () => {
    const h = await cast();
    await seedImportCommit(h, 'u-owner', 'imp-1', 'c-1');

    // Accountant holds export.read + purchase.import.read but NOT catalogue.pack.read.
    const commits = await exportDomain(h, 'u-book', 'import-commits', 'x-c');
    expect(commits.status).toBe(200);
    expect((commits.body as { csv: string }).csv).toContain('imp-1');

    const products = await exportDomain(h, 'u-book', 'products', 'x-p');
    expect(products.status).toBe(403);
    expect(codeOf(products)).toBe('export_not_permitted');
  });

  it('replays idempotently — the same export key logs exactly one export', async () => {
    const h = await cast();
    await publish(h, 'u-owner', 'p-a', product({ sku: 'SKU-A' }), 'k-a');

    const first = await exportDomain(h, 'u-owner', 'products', 'same-key');
    const second = await exportDomain(h, 'u-owner', 'products', 'same-key');
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((second.body as { csv: string }).csv).toBe((first.body as { csv: string }).csv);
    expect((await exportLog(h, 'u-owner')).body).toMatchObject({ total: 1 }); // logged once, not twice
  });

  it('404s an unknown domain and refuses a user with no export.read at every route', async () => {
    const h = await cast();
    expect((await exportDomain(h, 'u-owner', 'nope', 'x-n')).status).toBe(404);

    expect((await listDomains(h, 'u-cash')).status).toBe(403);
    expect((await exportDomain(h, 'u-cash', 'products', 'x-cash')).status).toBe(403);
    expect((await exportLog(h, 'u-cash')).status).toBe(403);
  });
});
