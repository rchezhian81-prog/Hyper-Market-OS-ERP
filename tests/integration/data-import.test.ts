import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Bulk data import, end to end (M30-FR-01/03, API-03). A store loads a supplier price file, an opening-stock
// count, a batch of invoices — hundreds of rows at once. The failure this closes is a half-good file applied
// silently: some rows land, some are skipped, nobody approved it, and the totals never balanced. So: VALIDATE
// is a stateless preview (every error by line, whether a financial file reconciles) that writes nothing;
// COMMIT re-validates on the server, then applies the WHOLE job or nothing — a job with errors, that does not
// reconcile, unapproved, or approved by its own uploader is refused (§28 maker-checker). A committed job is a
// durable, append-only record surviving a restart. Gated purchase.import.read (validate/list/read) and
// purchase.import.record (commit).

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

// A simple non-financial template: a product master load, keyed by sku.
const productTemplate = {
  id: 'product-v1', domain: 'product',
  columns: [
    { name: 'sku', type: 'text', required: true },
    { name: 'name', type: 'text', required: true },
    { name: 'qty', type: 'integer', required: true },
  ],
  keyColumns: ['sku'],
};

// A financial template: supplier invoices whose amounts must sum to a declared control total.
const invoiceTemplate = {
  id: 'invoice-v1', domain: 'supplier_invoice',
  columns: [
    { name: 'inv', type: 'text', required: true },
    { name: 'amount', type: 'money_minor', required: true },
  ],
  keyColumns: ['inv'], amountColumn: 'amount',
};

const validate = (h: ApiHarness, u: string, body: Record<string, unknown>, key = 'v-1') =>
  h.request({ method: 'POST', path: '/v1/import/validate', userId: u, tenantId: A, idempotencyKey: key, body });
const commit = (h: ApiHarness, u: string, body: Record<string, unknown>, key = 'c-1') =>
  h.request({ method: 'POST', path: '/v1/import/commit', userId: u, tenantId: A, idempotencyKey: key, body });
const listCommits = (h: ApiHarness, u: string) =>
  h.request({ method: 'GET', path: '/v1/import/commits', userId: u, tenantId: A });
const readCommit = (h: ApiHarness, u: string, jobId: string) =>
  h.request({ method: 'GET', path: `/v1/import/commits/${jobId}`, userId: u, tenantId: A });

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');                     // read + record
  await h.provisionRole(A, 'u-mgr', 'store_manager');  // purchase.import.record + read
  await h.provisionRole(A, 'u-book', 'accountant');    // purchase.import.read only
  await h.provisionRole(A, 'u-cash', 'cashier');       // neither
  return h;
}

describe('bulk data import: validate, then commit the whole job or nothing under §28 (M30-FR-01/03)', () => {
  it('validates a clean file, commits it with a different-person approval, then lists and reads it (survives a restart)', async () => {
    const h = await cast();

    // VALIDATE — a preview. Two good product rows.
    const preview = await validate(h, 'u-mgr', {
      template: productTemplate,
      text: 'sku,name,qty\nA1,Rice 5kg,10\nA2,Toor Dal,5',
    });
    expect(preview.status).toBe(200);
    expect((preview.body as { preview: { totalRows: number; validCount: number; errorRowCount: number; commitReady: boolean } }).preview)
      .toMatchObject({ totalRows: 2, validCount: 2, errorRowCount: 0, commitReady: true });

    // COMMIT — uploader u-mgr, approved by u-owner (a different person). The server re-validates the file.
    const committed = await commit(h, 'u-mgr', {
      jobId: 'imp-001',
      template: productTemplate,
      text: 'sku,name,qty\nA1,Rice 5kg,10\nA2,Toor Dal,5',
      approval: { status: 'approved', decidedBy: 'u-owner', reason: 'checked against the supplier sheet' },
    });
    expect(committed.status).toBe(200);
    expect(committed.body).toMatchObject({ jobId: 'imp-001', committed: true, rowsApplied: 2 });

    // LIST shows the summary; READ returns the full applied rows.
    const list = await listCommits(h, 'u-owner');
    expect(list.body).toMatchObject({ total: 1 });
    expect((list.body as { jobs: { jobId: string; uploadedBy: string; approvedBy: string; rowsApplied: number }[] }).jobs[0])
      .toMatchObject({ jobId: 'imp-001', uploadedBy: 'u-mgr', approvedBy: 'u-owner', rowsApplied: 2 });

    const read = await readCommit(h, 'u-book', 'imp-001');
    expect(read.status).toBe(200);
    const job = (read.body as { job: { rows: Record<string, string>[]; approvedBy: string } }).job;
    expect(job.approvedBy).toBe('u-owner');
    expect(job.rows).toEqual([
      { sku: 'A1', name: 'Rice 5kg', qty: '10' },
      { sku: 'A2', name: 'Toor Dal', qty: '5' },
    ]);

    // Survives a restart — it is a durable, append-only record, not in-memory.
    const h2 = apiHarness({ store: h.store });
    expect((await listCommits(h2, 'u-owner')).body).toMatchObject({ total: 1 });
    expect((await readCommit(h2, 'u-owner', 'imp-001')).status).toBe(200);
  });

  it('refuses an import the uploader approved themselves (§28) and never records it', async () => {
    const h = await cast();
    const res = await commit(h, 'u-mgr', {
      jobId: 'imp-self',
      template: productTemplate,
      text: 'sku,name,qty\nA1,Rice,10',
      approval: { status: 'approved', decidedBy: 'u-mgr' }, // same person who uploaded
    });
    expect(res.status).toBe(422);
    expect(codeOf(res)).toBe('import_refused_self_approved');
    expect((await listCommits(h, 'u-owner')).body).toMatchObject({ total: 0 }); // nothing applied
  });

  it('refuses a financial import that does not reconcile, and previews the mismatch', async () => {
    const h = await cast();
    const text = 'inv,amount\nINV-1,1000\nINV-2,2000'; // sums to 3000

    // Preview shows it does not balance against a wrong declared total.
    const preview = await validate(h, 'u-mgr', { template: invoiceTemplate, text, declaredTotalMinor: 9999 });
    expect((preview.body as { preview: { sumMinor: number; reconciles: boolean; commitReady: boolean } }).preview)
      .toMatchObject({ sumMinor: 3000, reconciles: false, commitReady: false });

    // Commit is refused for the whole job.
    const res = await commit(h, 'u-mgr', {
      jobId: 'imp-fin', template: invoiceTemplate, text, declaredTotalMinor: 9999,
      approval: { status: 'approved', decidedBy: 'u-owner' },
    });
    expect(res.status).toBe(422);
    expect(codeOf(res)).toBe('import_refused_does_not_reconcile');

    // The same file WITH the right control total reconciles and commits.
    const ok = await commit(h, 'u-mgr', {
      jobId: 'imp-fin', template: invoiceTemplate, text, declaredTotalMinor: 3000,
      approval: { status: 'approved', decidedBy: 'u-owner' },
    }, 'c-2');
    expect(ok.status).toBe(200);
    expect((await readCommit(h, 'u-owner', 'imp-fin')).body).toMatchObject({ job: { reconciles: true, sumMinor: 3000 } });
  });

  it('refuses a file with a bad row (nothing is applied)', async () => {
    const h = await cast();
    const text = 'sku,name,qty\nA1,Rice,ten'; // qty "ten" is not a whole number

    const preview = await validate(h, 'u-mgr', { template: productTemplate, text });
    expect((preview.body as { preview: { errorRowCount: number; commitReady: boolean } }).preview)
      .toMatchObject({ errorRowCount: 1, commitReady: false });

    const res = await commit(h, 'u-mgr', {
      jobId: 'imp-bad', template: productTemplate, text,
      approval: { status: 'approved', decidedBy: 'u-owner' },
    });
    expect(res.status).toBe(422);
    expect(codeOf(res)).toBe('import_refused_has_errors');
    expect((await listCommits(h, 'u-owner')).body).toMatchObject({ total: 0 });
  });

  it('refuses committing the same job id twice, and 404s an unknown job', async () => {
    const h = await cast();
    const body = {
      jobId: 'imp-dup', template: productTemplate, text: 'sku,name,qty\nA1,Rice,10',
      approval: { status: 'approved', decidedBy: 'u-owner' },
    };
    expect((await commit(h, 'u-mgr', body, 'c-1')).status).toBe(200);

    const again = await commit(h, 'u-mgr', body, 'c-2');
    expect(again.status).toBe(409);
    expect(codeOf(again)).toBe('import_already_committed');

    const missing = await readCommit(h, 'u-owner', 'nope');
    expect(missing.status).toBe(404);
    expect(codeOf(missing)).toBe('unknown_import_job');
  });

  it('rejects a commit without a job id or without an approval (nothing applied without maker-checker)', async () => {
    const h = await cast();
    const noJob = await commit(h, 'u-mgr', {
      template: productTemplate, text: 'sku,name,qty\nA1,Rice,10',
      approval: { status: 'approved', decidedBy: 'u-owner' },
    });
    expect(noJob.status).toBe(400);
    expect(codeOf(noJob)).toBe('no_job_id');

    const noApproval = await commit(h, 'u-mgr', {
      jobId: 'imp-x', template: productTemplate, text: 'sku,name,qty\nA1,Rice,10',
    });
    expect(noApproval.status).toBe(400);
    expect(codeOf(noApproval)).toBe('no_approval');
  });

  it('enforces the read/write split: read-only may validate & list but not commit; no role is refused', async () => {
    const h = await cast();

    // Accountant (read only) can validate and list…
    expect((await validate(h, 'u-book', { template: productTemplate, text: 'sku,name,qty\nA1,Rice,10' })).status).toBe(200);
    expect((await listCommits(h, 'u-book')).status).toBe(200);
    // …but not commit.
    const denied = await commit(h, 'u-book', {
      jobId: 'imp-ro', template: productTemplate, text: 'sku,name,qty\nA1,Rice,10',
      approval: { status: 'approved', decidedBy: 'u-owner' },
    });
    expect(denied.status).toBe(403);

    // A user with neither permission is refused everywhere.
    expect((await validate(h, 'u-cash', { template: productTemplate, text: 'sku,name,qty\nA1,Rice,10' })).status).toBe(403);
    expect((await listCommits(h, 'u-cash')).status).toBe(403);
  });
});
