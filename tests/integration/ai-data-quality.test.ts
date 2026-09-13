import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// The Data Quality agent (A08) on the live surface (API-13 · §7.1 · P-05 · M03-FR-02/04).
//
// This is the first agent that actually PRODUCES something. It scans the tenant's real published
// product master for the gaps that can genuinely occur — a sellable item with no barcode, two
// records that look like the same thing, an item with no printed MRP — and returns each as a DRAFT
// proposal citing the real product(s) and naming the ordinary catalogue endpoint a person would call.
//
// The whole of hard rule #5 is the shape it holds here: the run reads and drafts, it commits nothing,
// and it writes nothing to any store — the reply says `committedAnything: false`, and a data steward
// acts (assign a barcode, merge a duplicate, add an MRP) through the normal route, which applies its
// own permissions, approvals and audit. And the three gates still hold: nothing runs until A08 is
// enabled by name and funded, with the kill switch off.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const GROCERY = { categoryId: 'grocery', name: 'Grocery', parentId: null };
const MRP = [{ value: { minor: 5000, currency: 'INR' }, effectiveFrom: '2026-01-01' }];

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

const publish = (h: ApiHarness, productId: string, product: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/catalogue/products/${productId}/publish`, userId: 'u-owner', tenantId: A, idempotencyKey: key, body: { product, categories: [GROCERY] } });
const assignBarcode = (h: ApiHarness, productId: string, code: string, key: string) =>
  h.request({ method: 'POST', path: `/v1/catalogue/products/${productId}/barcodes/${code}`, userId: 'u-owner', tenantId: A, idempotencyKey: key, body: { kind: 'ean' } });
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

const base = { baseUom: 'each', primaryCategoryId: 'grocery', taxClass: '25010020', lifecycle: 'draft' };
const byId = (props: readonly Proposal[], id: string): Proposal | undefined => props.find((p) => p.proposalId === id);

describe('the Data Quality agent (A08) drafts evidence-backed suggestions on the live surface', () => {
  it('scans the product master and drafts a proposal per real gap, committing nothing', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    // A clean, well-formed product: barcode + MRP + a unique name → nothing to say about it.
    expect((await publish(h, 'p-salt', { ...base, sku: 'SKU-SALT', name: 'Tata Salt 1kg', brand: 'Tata', mrpHistory: MRP }, 'k1')).status).toBe(201);
    expect((await assignBarcode(h, 'p-salt', '8901000000001', 'bc1')).status).toBe(201);

    // Two look-alike records (same name + brand, different SKUs) → a suspected duplicate. Both are
    // otherwise complete, so the ONLY thing said about them is that they may be the same item.
    expect((await publish(h, 'p-atta-1', { ...base, sku: 'SKU-ATTA-1', name: 'Aashirvaad Atta 5kg', brand: 'Aashirvaad', mrpHistory: MRP }, 'k2')).status).toBe(201);
    expect((await assignBarcode(h, 'p-atta-1', '8901000000002', 'bc2')).status).toBe(201);
    expect((await publish(h, 'p-atta-2', { ...base, sku: 'SKU-ATTA-2', name: 'AASHIRVAAD ATTA 5 KG', brand: 'aashirvaad', mrpHistory: MRP }, 'k3')).status).toBe(201);
    expect((await assignBarcode(h, 'p-atta-2', '8901000000003', 'bc3')).status).toBe(201);

    // A product on sale with NO barcode → it cannot be scanned. (MRP present, so only that one gap.)
    expect((await publish(h, 'p-noscan', { ...base, sku: 'SKU-NOSCAN', name: 'Loose Poha', brand: 'Local', mrpHistory: MRP }, 'k4')).status).toBe(201);

    // A product on sale with NO printed MRP → a Legal Metrology gap. (Barcode present, so only that.)
    expect((await publish(h, 'p-nomrp', { ...base, sku: 'SKU-NOMRP', name: 'Sugar 1kg', brand: 'Local' }, 'k5')).status).toBe(201);
    expect((await assignBarcode(h, 'p-nomrp', '8901000000004', 'bc5')).status).toBe(201);

    // Kill switch off and funded, but A08 not yet enabled → the enable gate refuses it (429).
    expect((await put(h, '/v1/ai/kill-switch', { on: false }, 'k')).status).toBe(200);
    expect((await put(h, '/v1/ai/budget', { capMinor: 500_000, periodEnds: '2027-01-01T00:00:00Z' }, 'b')).status).toBe(200);
    expect((await runA08(h, 'r0')).status).toBe(429);

    // Now enable A08 by name — and only then does the run pass the gate.
    expect((await put(h, '/v1/ai/agents/enabled', { agents: ['A08'] }, 'e')).status).toBe(200);
    const res = await runA08(h, 'r1');
    expect(res.status).toBe(200);
    const body = res.body as RunBody;

    // Hard rule #5, stated on the reply and true of every proposal.
    expect(body.committedAnything).toBe(false);
    for (const p of body.proposals) expect(p.committed).toBe(false);

    // Exactly the three real gaps, each a deterministic proposal id, each citing the real product(s).
    const missingBarcode = byId(body.proposals, 'dq-missing-barcode:p-noscan');
    expect(missingBarcode).toBeDefined();
    expect(missingBarcode!.agent).toBe('A08');
    expect(missingBarcode!.summary).toContain('Loose Poha');
    expect(missingBarcode!.wouldRequire).toBe('POST /v1/catalogue/products/:productId/barcodes/:code');
    expect(missingBarcode!.evidence.length).toBeGreaterThan(0);
    expect(missingBarcode!.evidence[0]!.reference).toBe('SKU-NOSCAN');

    const duplicate = byId(body.proposals, 'dq-duplicate:p-atta-1:p-atta-2');
    expect(duplicate).toBeDefined();
    expect(duplicate!.wouldRequire).toBe('POST /v1/catalogue/merges/:mergeId');
    // A duplicate cites BOTH records — the reviewer sees what was matched.
    expect(duplicate!.evidence.map((e) => e.reference).sort()).toEqual(['SKU-ATTA-1', 'SKU-ATTA-2']);

    const missingMrp = byId(body.proposals, 'dq-missing-mrp:p-nomrp');
    expect(missingMrp).toBeDefined();
    expect(missingMrp!.wouldRequire).toBe('POST /v1/catalogue/products/:productId/publish');
    expect(missingMrp!.summary).toContain('Sugar 1kg');

    // The clean product is never mentioned.
    expect(body.proposals.some((p) => p.proposalId.includes('p-salt'))).toBe(false);
  });

  it('says nothing about a clean catalogue — no barcode, no fabricated finding', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    expect((await publish(h, 'p-salt', { ...base, sku: 'SKU-SALT', name: 'Tata Salt 1kg', brand: 'Tata', mrpHistory: MRP }, 'k1')).status).toBe(201);
    expect((await assignBarcode(h, 'p-salt', '8901000000001', 'bc1')).status).toBe(201);
    expect((await publish(h, 'p-sugar', { ...base, sku: 'SKU-SUGAR', name: 'Sugar 1kg', brand: 'Local', mrpHistory: MRP }, 'k2')).status).toBe(201);
    expect((await assignBarcode(h, 'p-sugar', '8901000000002', 'bc2')).status).toBe(201);

    await armA08(h);
    const body = (await runA08(h, 'r1')).body as RunBody;
    expect(body.proposals).toEqual([]);
    expect(body.committedAnything).toBe(false);
  });

  it('an empty product master produces no proposals — an enabled agent with nothing to find finds nothing', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await armA08(h);
    const body = (await runA08(h, 'r1')).body as RunBody;
    expect(body.proposals).toEqual([]);
    expect(body.committedAnything).toBe(false);
  });
});
