import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// A08's third leg on the live surface — "suspicious mappings" from import history (API-13 · §7.1 · M30-FR-04 · P-05).
//
// The first two A08 legs read the product master. This one reads the ONE mapping-related thing import
// history actually keeps: the per-column rejection fingerprint. A source (supplier/system/file) whose
// "hsn" column is rejected week after week is not a run of bad luck — it is a mapping that is wrong at
// the source's end, and it is exactly what a data steward should chase. A08 turns that recurring
// fingerprint into a DRAFT proposal that cites the SOURCE and points at its import-quality review.
//
// Hard rule #5 holds as everywhere else: the run reads and drafts, it commits nothing, and it writes
// nothing to any store. It uses the SAME tested history fold the import-quality routes read, so there is
// one truth about which source keeps failing — no second copy of the data.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const GROCERY = { categoryId: 'grocery', name: 'Grocery', parentId: null };
const MRP = [{ value: { minor: 5000, currency: 'INR' }, effectiveFrom: '2026-01-01' }];
const base = { baseUom: 'each', primaryCategoryId: 'grocery', taxClass: '25010020', lifecycle: 'draft' };

const err = (line: number, column: string, kind: string) => ({ line, column, kind, message: `${column} ${kind}` });
// A whole file's outcome — the summary the importer already computed. Recorded whether it committed or not.
const fileOutcome = (over: Record<string, unknown>) => ({
  sourceId: 'acme-foods', templateId: 'supplier-price-v1', fileName: 'acme-prices.csv',
  outcome: 'committed', totalRows: 1000, validRows: 1000, errorRows: 0, duplicatesForReview: 0, errors: [],
  uploadedAt: '2026-08-20T10:00:00Z', ...over,
});

const job = (h: ApiHarness, id: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: `/v1/purchase/import-jobs/${id}`, userId: 'u-owner', tenantId: A, idempotencyKey: `job-${id}`, body });
const publish = (h: ApiHarness, productId: string, product: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/catalogue/products/${productId}/publish`, userId: 'u-owner', tenantId: A, idempotencyKey: key, body: { product, categories: [GROCERY] } });
const put = (h: ApiHarness, path: string, body: unknown, key: string) =>
  h.request({ method: 'PUT', path, userId: 'u-owner', tenantId: A, idempotencyKey: key, body });
const runA08 = (h: ApiHarness, key: string) =>
  h.request({ method: 'POST', path: '/v1/ai/agents/A08/runs', userId: 'u-owner', tenantId: A, idempotencyKey: key, body: { estimatedCostMinor: 1_000 } });

/** Turn A08 on and fund it, with the kill switch off — the three gates a run must pass. */
async function armA08(h: ApiHarness): Promise<void> {
  expect((await put(h, '/v1/ai/kill-switch', { on: false }, 'k')).status).toBe(200);
  expect((await put(h, '/v1/ai/budget', { capMinor: 500_000, periodEnds: '2027-01-01T00:00:00Z' }, 'b')).status).toBe(200);
  expect((await put(h, '/v1/ai/agents/enabled', { agents: ['A08'] }, 'e')).status).toBe(200);
}

interface Proposal {
  readonly proposalId: string;
  readonly agent: string;
  readonly summary: string;
  readonly wouldRequire: string;
  readonly evidence: readonly { source: string; reference: string; summary: string }[];
  readonly committed: boolean;
}
interface RunBody {
  readonly proposals: readonly Proposal[];
  readonly refused: readonly { code?: string; detail: string }[];
  readonly committedAnything: boolean;
}
const byId = (props: readonly Proposal[], id: string): Proposal | undefined => props.find((p) => p.proposalId === id);

describe('A08 drafts suspicious-mapping suggestions from import history on the live surface', () => {
  it('flags a source that keeps failing on one column, cites import history, and commits nothing', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    // Two files from one supplier, both rejecting the "hsn" column as an unrecognised code — three rows in
    // all, and the only reason either file failed. That recurring fingerprint is a suspicious mapping.
    expect((await job(h, 'j1', fileOutcome({
      uploadedAt: '2026-08-18T09:00:00Z', validRows: 998, errorRows: 2,
      errors: [err(2, 'hsn', 'not_allowed_value'), err(5, 'hsn', 'not_allowed_value')],
    }))).status).toBe(201);
    expect((await job(h, 'j2', fileOutcome({
      uploadedAt: '2026-08-25T09:00:00Z', validRows: 999, errorRows: 1,
      errors: [err(3, 'hsn', 'not_allowed_value')],
    }))).status).toBe(201);

    await armA08(h);
    const res = await runA08(h, 'r1');
    expect(res.status).toBe(200);
    const body = res.body as RunBody;

    // Hard rule #5, stated on the reply and true of every proposal.
    expect(body.committedAnything).toBe(false);
    for (const p of body.proposals) expect(p.committed).toBe(false);

    const mapping = byId(body.proposals, 'dq-mapping:acme-foods:hsn:not_allowed_value');
    expect(mapping).toBeDefined();
    expect(mapping!.agent).toBe('A08');
    expect(mapping!.summary).toContain('acme-foods');
    expect(mapping!.summary).toContain('hsn');
    // It points at where a steward reviews the source — the fix is with the source, off-system.
    expect(mapping!.wouldRequire).toBe('GET /v1/purchase/import-quality/:sourceId');
    // The evidence is drawn from import history and cites the source, not a product.
    expect(mapping!.evidence.length).toBe(1);
    expect(mapping!.evidence[0]!.source).toBe('import history');
    expect(mapping!.evidence[0]!.reference).toBe('acme-foods');
    expect(mapping!.evidence[0]!.summary).toContain('hsn');
  });

  it('runs both legs at once — a product-master gap and a mapping gap in the same run', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    // A sellable product with no barcode → the product-master leg speaks.
    expect((await publish(h, 'p-noscan', { ...base, sku: 'SKU-NOSCAN', name: 'Loose Poha', brand: 'Local', mrpHistory: MRP }, 'k1')).status).toBe(201);
    // A supplier that keeps failing on "hsn" → the import-history leg speaks.
    await job(h, 'j1', fileOutcome({ uploadedAt: '2026-08-18T09:00:00Z', validRows: 997, errorRows: 3, errors: [err(2, 'hsn', 'not_allowed_value'), err(5, 'hsn', 'not_allowed_value'), err(9, 'hsn', 'not_allowed_value')] }));

    await armA08(h);
    const body = (await runA08(h, 'r1')).body as RunBody;

    expect(body.committedAnything).toBe(false);
    expect(byId(body.proposals, 'dq-missing-barcode:p-noscan')).toBeDefined();
    expect(byId(body.proposals, 'dq-mapping:acme-foods:hsn:not_allowed_value')).toBeDefined();
  });

  it('says nothing about a clean import history, and never about in-file duplicates', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    // A clean committed file — nothing rejected.
    await job(h, 'j-clean', fileOutcome({ uploadedAt: '2026-08-18T09:00:00Z' }));
    // A file whose only failures are the SAME key exported twice — a source data problem, not a mapping
    // one, so A08 stays silent (a steward cannot re-map a column to stop a supplier duplicating a key).
    await job(h, 'j-dupe', fileOutcome({
      sourceId: 'dupe-co', fileName: 'dupe.csv', uploadedAt: '2026-08-19T09:00:00Z', validRows: 997, errorRows: 3,
      errors: [err(2, 'sku', 'duplicate_in_file'), err(3, 'sku', 'duplicate_in_file'), err(4, 'sku', 'duplicate_in_file')],
    }));

    await armA08(h);
    const body = (await runA08(h, 'r1')).body as RunBody;
    expect(body.proposals.some((p) => p.proposalId.startsWith('dq-mapping:'))).toBe(false);
    expect(body.committedAnything).toBe(false);
  });
});
