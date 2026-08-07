import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Supplier-portal compliance AT THE ACTION, end to end through the real API (M24-FR-03, API-03). A
// nightly compliance sweep leaves a gap, and the gap is exactly where an expired supplier gets a
// purchase order — so a partner's documents are checked at the MOMENT of the submission, not on a
// schedule. An expired or missing required document BLOCKS; a document uploaded but never verified
// counts as missing (an unverified licence is a photograph somebody uploaded); an expiring-but-valid
// one WARNS so somebody can chase it, without blocking; and another partner's documents are never read
// as cover. Proves the wired compliance check against the real pipeline and real RBAC.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const doc = (over: Record<string, unknown> = {}) => ({
  documentId: 'd1', kind: 'gst_registration', reference: 'GSTIN-1', validFrom: '2020-01-01', validUntil: '2035-01-01', verifiedBy: 'u-buyer', ...over,
});
const config = (h: ApiHarness, tenantId: string, userId: string, partnerId: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/supplier-portal/partners/${partnerId}`, userId, tenantId, idempotencyKey: key ?? `cfg-${partnerId}`, body });
const submit = (h: ApiHarness, tenantId: string, userId: string, partnerId: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/supplier-portal/partners/${partnerId}/submissions`, userId, tenantId, idempotencyKey: key ?? `sub-${body['submissionId']}`, body });
const compliance = (h: ApiHarness, tenantId: string, userId: string, partnerId: string, asOf?: string) =>
  h.request({ method: 'GET', path: `/v1/supplier-portal/partners/${partnerId}/compliance`, userId, tenantId, ...(asOf ? { query: { asOf } } : {}) });

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
interface Check { compliant: boolean; blocking: string[]; documents: { kind: string; state: string; daysRemaining?: number }[] }
const stateOf = (c: Check, kind: string) => c.documents.find((d) => d.kind === kind)?.state;

describe('supplier-portal compliance is checked at the action, not on a sweep (M24-FR-03)', () => {
  it('reads the same documents as compliant or not depending on the date it is asked', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await config(h, A, 'u-owner', 'SUP1', {
      grants: ['submit_invoice'],
      requiredDocuments: ['fssai_licence', 'gst_registration'],
      documents: [
        doc({ documentId: 'd-fssai', kind: 'fssai_licence', reference: 'FSSAI-1', validUntil: '2026-08-20' }),
        doc({ documentId: 'd-gst', kind: 'gst_registration', reference: 'GST-1', validUntil: '2026-06-01' }),
      ],
    });

    // Asked on 10 Aug: the GST expired on 1 Jun (blocks); the FSSAI expires in 10 days (warns only).
    const late = (await compliance(h, A, 'u-owner', 'SUP1', '2026-08-10')).body as Check;
    expect(late.compliant).toBe(false);
    expect(stateOf(late, 'gst_registration')).toBe('expired');
    expect(stateOf(late, 'fssai_licence')).toBe('expiring');
    expect(late.blocking).toEqual(['gst_registration']); // the expiring FSSAI is NOT a block

    // Asked on 1 May: both are still valid → compliant. Same documents, different answer: at the action.
    const early = (await compliance(h, A, 'u-owner', 'SUP1', '2026-05-01')).body as Check;
    expect(early.compliant).toBe(true);
    expect(early.blocking).toEqual([]);
  });

  it('counts an unverified document as missing, and lets trade proceed once it is verified', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    // Uploaded but never verified → counts as missing → blocks. (Far-future expiry, so date-agnostic.)
    await config(h, A, 'u-owner', 'SUP2', {
      grants: ['submit_invoice'], requiredDocuments: ['gst_registration'],
      documents: [{ documentId: 'd-gst', kind: 'gst_registration', reference: 'GST-2', validFrom: '2020-01-01', validUntil: '2035-01-01' }],
    }, 'cfg-SUP2-a');
    expect(codeOf(await submit(h, A, 'u-owner', 'SUP2', { submissionId: 's-1', kind: 'invoice' }))).toBe('not_compliant');

    // Verify the same document → the block clears and the invoice is accepted.
    await config(h, A, 'u-owner', 'SUP2', {
      grants: ['submit_invoice'], requiredDocuments: ['gst_registration'],
      documents: [doc({ documentId: 'd-gst', kind: 'gst_registration', reference: 'GST-2' })],
    }, 'cfg-SUP2-b');
    expect((await submit(h, A, 'u-owner', 'SUP2', { submissionId: 's-2', kind: 'invoice' }, 'sub-s-2')).status).toBe(201);
  });

  it('accepts an ASN with a valid document and blocks it when a required kind is missing', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await config(h, A, 'u-owner', 'SUP3', {
      grants: ['submit_asn'], requiredDocuments: ['fssai_licence'],
      documents: [doc({ documentId: 'd-fssai', kind: 'fssai_licence', reference: 'FSSAI-3' })],
    }, 'cfg-SUP3-a');
    expect((await submit(h, A, 'u-owner', 'SUP3', { submissionId: 's-asn', kind: 'asn' })).status).toBe(201);

    // Now insurance is also required and there is none on file → the next ASN is blocked.
    await config(h, A, 'u-owner', 'SUP3', {
      grants: ['submit_asn'], requiredDocuments: ['fssai_licence', 'insurance'],
      documents: [doc({ documentId: 'd-fssai', kind: 'fssai_licence', reference: 'FSSAI-3' })],
    }, 'cfg-SUP3-b');
    const blocked = await submit(h, A, 'u-owner', 'SUP3', { submissionId: 's-asn2', kind: 'asn' }, 'sub-s-asn2');
    expect(codeOf(blocked)).toBe('not_compliant');
    const c = (await compliance(h, A, 'u-owner', 'SUP3', '2026-08-10')).body as Check;
    expect(stateOf(c, 'insurance')).toBe('missing');
  });

  it('is authorized and per-tenant, and refuses unknown/malformed', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier'); // a cashier does not review supplier compliance
    await config(h, A, 'u-owner', 'SUP1', { grants: ['submit_invoice'], requiredDocuments: ['gst_registration'], documents: [doc()] });

    expect((await compliance(h, A, 'u-cash', 'SUP1', '2026-08-10')).status).toBe(403);
    expect((await compliance(h, A, 'u-owner', 'GHOST', '2026-08-10')).status).toBe(404);
    expect((await compliance(h, A, 'u-owner', 'SUP1', 'not-a-date')).status).toBe(400);
    // A malformed document is refused at configuration.
    expect((await config(h, A, 'u-owner', 'SUPBAD', { grants: ['submit_invoice'], documents: [{ documentId: 'd', kind: 'nonsense', reference: 'x', validFrom: '2020-01-01', validUntil: '2035-01-01' }] })).status).toBe(400);

    // Another tenant never configured SUP1 — its documents are never read as cover here.
    await h.seedOwner(B, 'u-owner-b');
    expect((await compliance(h, B, 'u-owner-b', 'SUP1', '2026-08-10')).status).toBe(404);
  });
});
