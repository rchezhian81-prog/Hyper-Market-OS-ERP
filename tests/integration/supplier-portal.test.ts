import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Supplier portal submissions, end to end through the real API (M24-FR-02, API-03). The portal is the
// one place a party OUTSIDE the business acts on the system, so the rule is absolute: NOTHING a
// supplier submits takes effect on its own. A catalogue/RFQ/claim lands for review (§28); an ASN or
// invoice needs the grant and compliance; another supplier's order is refused; a retry is a duplicate,
// not a second invoice. Proves the wired portal against the real pipeline and real per-tenant RBAC.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const GRANTS = ['submit_catalogue', 'submit_invoice', 'submit_asn', 'acknowledge_orders'];

const configPartner = (h: ApiHarness, tenantId: string, userId: string, partnerId: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/supplier-portal/partners/${partnerId}`, userId, tenantId, idempotencyKey: key ?? `cfg-${partnerId}`, body });

const submit = (h: ApiHarness, tenantId: string, userId: string, partnerId: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/supplier-portal/partners/${partnerId}/submissions`, userId, tenantId, idempotencyKey: key ?? `sub-${body['submissionId']}`, body });

const reviewQueue = (h: ApiHarness, tenantId: string, userId: string, partnerId: string, reviewOnly = false) =>
  h.request({ method: 'GET', path: `/v1/supplier-portal/partners/${partnerId}/submissions`, userId, tenantId, ...(reviewOnly ? { query: { review: 'true' } } : {}) });

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
interface Sub { requiresReview: boolean }
interface Queue { submissions: { submissionId: string; requiresReview: boolean }[] }

describe('nothing a supplier submits takes effect on its own (M24-FR-02, API-03)', () => {
  it('queues a catalogue for review and accepts an invoice for downstream matching', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await configPartner(h, A, 'u-owner', 'SUP1', { grants: GRANTS });

    // A catalogue is a proposal — it lands for review, it does not become the price list.
    expect(((await submit(h, A, 'u-owner', 'SUP1', { submissionId: 's-cat', kind: 'catalogue' })).body as Sub).requiresReview).toBe(true);
    // An invoice is accepted (and still meets M07 receiving/three-way match downstream).
    const inv = await submit(h, A, 'u-owner', 'SUP1', { submissionId: 's-inv', kind: 'invoice' });
    expect(inv.status).toBe(201);
    expect((inv.body as Sub).requiresReview).toBe(false);

    // The buyer's review queue holds the catalogue, not the invoice.
    const queue = (await reviewQueue(h, A, 'u-owner', 'SUP1', true)).body as Queue;
    expect(queue.submissions.map((s) => s.submissionId)).toEqual(['s-cat']);
  });

  it('refuses a submission the partner has no grant for', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await configPartner(h, A, 'u-owner', 'SUP1', { grants: GRANTS }); // no respond_rfq
    expect(codeOf(await submit(h, A, 'u-owner', 'SUP1', { submissionId: 's-rfq', kind: 'rfq_response' }))).toBe('no_grant');
  });

  it('refuses a duplicate submission and another supplier\'s order', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await configPartner(h, A, 'u-owner', 'SUP1', { grants: GRANTS });

    expect((await submit(h, A, 'u-owner', 'SUP1', { submissionId: 's-asn', kind: 'asn' })).status).toBe(201);
    // A retried submission (new transport key) is a duplicate, not a second ASN.
    expect(codeOf(await submit(h, A, 'u-owner', 'SUP1', { submissionId: 's-asn', kind: 'asn' }, 'sub-s-asn-again'))).toBe('duplicate');
    // An ASN naming another supplier's order is refused and recorded.
    expect(codeOf(await submit(h, A, 'u-owner', 'SUP1', { submissionId: 's-asn2', kind: 'asn', orderPartnerId: 'OTHER' }))).toBe('not_your_order');
  });

  it('refuses an invoice from a non-compliant supplier', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    // Requires a GST registration it does not hold → not compliant, checked at the action.
    await configPartner(h, A, 'u-owner', 'SUP2', { grants: ['submit_invoice'], requiredDocuments: ['gst_registration'] });
    expect(codeOf(await submit(h, A, 'u-owner', 'SUP2', { submissionId: 's-inv', kind: 'invoice' }))).toBe('not_compliant');
  });

  it('is authorized and per-tenant, and 404s an unconfigured partner', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier'); // a cashier does not operate the supplier portal
    await configPartner(h, A, 'u-owner', 'SUP1', { grants: GRANTS });

    expect((await configPartner(h, A, 'u-cash', 'SUP9', { grants: GRANTS })).status).toBe(403);
    expect((await submit(h, A, 'u-cash', 'SUP1', { submissionId: 'sx', kind: 'invoice' })).status).toBe(403);
    // A partner never configured has no grants — a submission is a 404, not a guess.
    expect((await submit(h, A, 'u-owner', 'GHOST', { submissionId: 'sy', kind: 'invoice' })).status).toBe(404);

    // Tenant B never configured SUP1.
    await h.seedOwner(B, 'u-owner-b');
    expect((await submit(h, B, 'u-owner-b', 'SUP1', { submissionId: 'sz', kind: 'invoice' })).status).toBe(404);
  });
});
