import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Supplier-portal refusal audit + probe detection, end to end (M24-FR-04, API-03). Refusals are audited
// as loudly as successes (hard rule #6): a supplier repeatedly submitting against ANOTHER supplier's
// order (`not_your_order`) is the pattern this exists to surface, and the shop should hear it from its
// own system rather than from the supplier whose prices leaked. One refusal is a mis-click; a pattern of
// them is somebody trying doors. A no-grant refusal is audited but is NOT a security event — only
// reaching for another partner's data is. The probing view is a buyer's, and per-tenant.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const GRANTS = ['submit_catalogue', 'submit_invoice', 'submit_asn', 'acknowledge_orders'];

const configPartner = (h: ApiHarness, tenantId: string, userId: string, partnerId: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: `/v1/supplier-portal/partners/${partnerId}`, userId, tenantId, idempotencyKey: `cfg-${tenantId}-${partnerId}`, body });

const submit = (h: ApiHarness, tenantId: string, userId: string, partnerId: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/supplier-portal/partners/${partnerId}/submissions`, userId, tenantId, idempotencyKey: key ?? `sub-${tenantId}-${body['submissionId']}`, body });

const probing = (h: ApiHarness, tenantId: string, userId: string, threshold?: number) =>
  h.request({ method: 'GET', path: '/v1/supplier-portal/probing', userId, tenantId, ...(threshold !== undefined ? { query: { threshold: String(threshold) } } : {}) });

// One ASN naming another supplier's order — refused `not_your_order`, and recorded as a security event.
const probe = (h: ApiHarness, tenantId: string, userId: string, partnerId: string, submissionId: string, key?: string) =>
  submit(h, tenantId, userId, partnerId, { submissionId, kind: 'asn', orderPartnerId: 'OTHER' }, key);

type Probing = { probing: { partnerId: string; userId: string; attempts: number }[]; count: number; threshold: number };

describe('supplier-portal probe detection (M24-FR-04, API-03)', () => {
  it('surfaces a partner reaching for other suppliers\' orders once it becomes a pattern', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await configPartner(h, A, 'u-owner', 'SUP1', { grants: GRANTS });

    // Two refusals is not yet a pattern (default threshold 3).
    expect((await probe(h, A, 'u-owner', 'SUP1', 's-p1')).status).toBe(422);
    expect((await probe(h, A, 'u-owner', 'SUP1', 's-p2')).status).toBe(422);
    expect(((await probing(h, A, 'u-owner')).body as Probing).count).toBe(0);

    // The third makes it one — surfaced with who and how many.
    expect((await probe(h, A, 'u-owner', 'SUP1', 's-p3')).status).toBe(422);
    const p = (await probing(h, A, 'u-owner')).body as Probing;
    expect(p.count).toBe(1);
    expect(p.probing[0]).toMatchObject({ partnerId: 'SUP1', userId: 'u-owner', attempts: 3 });
  });

  it('audits a no-grant refusal and an accepted submission, but neither is probing', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    // No respond_rfq grant → rfq_response is refused `no_grant` (audited, but not a security event).
    await configPartner(h, A, 'u-owner', 'SUP2', { grants: ['submit_invoice'] });
    for (const id of ['r1', 'r2', 'r3']) {
      expect((await submit(h, A, 'u-owner', 'SUP2', { submissionId: id, kind: 'rfq_response' })).status).toBe(422);
    }
    // And a perfectly good invoice.
    expect((await submit(h, A, 'u-owner', 'SUP2', { submissionId: 's-inv', kind: 'invoice' })).status).toBe(201);

    // Reaching for a grant you lack is not reaching for another partner's data — no probing.
    expect(((await probing(h, A, 'u-owner')).body as Probing).count).toBe(0);
  });

  it('honours a tunable threshold, and a single mis-click retried is one attempt, not a pattern', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await configPartner(h, A, 'u-owner', 'SUP1', { grants: GRANTS });

    // The same probe re-synced (new transport key, same submission id) collapses to ONE audited attempt.
    await probe(h, A, 'u-owner', 'SUP1', 's-p1');
    await probe(h, A, 'u-owner', 'SUP1', 's-p1', 'retry-s-p1');
    expect(((await probing(h, A, 'u-owner', 2)).body as Probing).count).toBe(0); // still one distinct attempt

    // A genuinely different attempt makes two — enough at threshold 2.
    await probe(h, A, 'u-owner', 'SUP1', 's-p2');
    const p = (await probing(h, A, 'u-owner', 2)).body as Probing;
    expect(p.count).toBe(1);
    expect(p.probing[0]).toMatchObject({ partnerId: 'SUP1', attempts: 2 });
  });

  it('is a buyer\'s view and per-tenant — a cashier is refused, and one tenant never sees another\'s', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');
    await configPartner(h, A, 'u-owner', 'SUP1', { grants: GRANTS });
    for (const id of ['s-p1', 's-p2', 's-p3']) await probe(h, A, 'u-owner', 'SUP1', id);

    // A cashier does not review the supplier portal.
    expect((await probing(h, A, 'u-cash')).status).toBe(403);

    // Tenant B has its own portal — A's probes are invisible there.
    await h.seedOwner(B, 'u-owner-b');
    expect(((await probing(h, B, 'u-owner-b')).body as Probing).count).toBe(0);
  });
});
