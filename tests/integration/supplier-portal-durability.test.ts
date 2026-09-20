import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Supplier-portal durability: the portal's STORED state — its refusal/probe audit trail, its buyer
// review queue and its running supplier statement — must survive a service (or store-edge box) restart
// and rebuild from the event store exactly as it stood (M24, P-04 tested recovery, P-08 no silent
// failure, hard rule #6 never delete audit evidence). The per-FR integration tests (supplier-portal /
// -compliance / -statement / -probing / -scoping) each prove a surface works on a fresh, warm process;
// none proves it comes BACK after a crash. A probe pattern a shop was about to act on, a catalogue
// awaiting a buyer's review, a supplier balance mid-reconciliation — losing any of those to a restart
// is exactly the silent data loss P-08 forbids, and for the audit trail it is hard rule #6. This
// rebuilds a NEW API surface over the SAME persisted event store and proves all three come back, then
// proves the rebuilt state is LIVE (fresh appends still land on top of it), not a frozen snapshot.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GRANTS = ['submit_catalogue', 'submit_invoice', 'submit_asn', 'acknowledge_orders', 'view_statement'];

const config = (h: ApiHarness, u: string, id: string, grants: string[]) =>
  h.request({ method: 'POST', path: `/v1/supplier-portal/partners/${id}`, userId: u, tenantId: A, idempotencyKey: `cfg-${id}`, body: { grants } });
const submit = (h: ApiHarness, u: string, id: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/supplier-portal/partners/${id}/submissions`, userId: u, tenantId: A, idempotencyKey: key ?? `sub-${body['submissionId']}`, body });
// An ASN naming another supplier's order — refused `not_your_order` and recorded as a security event.
const probe = (h: ApiHarness, u: string, id: string, submissionId: string) =>
  submit(h, u, id, { submissionId, kind: 'asn', orderPartnerId: 'OTHER' });
const probing = (h: ApiHarness, u: string) =>
  h.request({ method: 'GET', path: '/v1/supplier-portal/probing', userId: u, tenantId: A });
const reviewQueue = (h: ApiHarness, u: string, id: string) =>
  h.request({ method: 'GET', path: `/v1/supplier-portal/partners/${id}/submissions`, userId: u, tenantId: A, query: { review: 'true' } });
const setOpening = (h: ApiHarness, u: string, id: string, openingMinor: number) =>
  h.request({ method: 'POST', path: `/v1/supplier-portal/partners/${id}/statement/opening`, userId: u, tenantId: A, idempotencyKey: `op-${id}`, body: { openingMinor } });
const line = (h: ApiHarness, u: string, id: string, ref: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: `/v1/supplier-portal/partners/${id}/statement/lines/${ref}`, userId: u, tenantId: A, idempotencyKey: `ln-${ref}`, body });
const statement = (h: ApiHarness, u: string, id: string) =>
  h.request({ method: 'GET', path: `/v1/supplier-portal/partners/${id}/statement`, userId: u, tenantId: A });

type Probing = { probing: { partnerId: string; userId: string; attempts: number }[]; count: number };
type Queue = { submissions: { submissionId: string }[] };
type Stmt = { closingMinor: number; reconciles: boolean };

describe('supplier-portal stored state rebuilds after a restart (M24, P-04, P-08, hard rule #6)', () => {
  it('the probe/refusal audit trail, the review queue and the running statement all survive a restart, and fresh appends still land', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await config(h, 'u-owner', 'SUP1', GRANTS);

    // FR-04 audit trail: three refused reaches for another supplier's order — one surfaced probe pattern.
    for (const id of ['s-p1', 's-p2', 's-p3']) expect((await probe(h, 'u-owner', 'SUP1', id)).status).toBe(422);
    // FR-02: a catalogue lands for review; an invoice is accepted (and is NOT in the review queue).
    expect(((await submit(h, 'u-owner', 'SUP1', { submissionId: 's-cat', kind: 'catalogue' })).body as { requiresReview: boolean }).requiresReview).toBe(true);
    expect((await submit(h, 'u-owner', 'SUP1', { submissionId: 's-inv', kind: 'invoice' })).status).toBe(201);
    // FR-04 statement: an opening figure and two signed lines, mid-reconciliation.
    await setOpening(h, 'u-owner', 'SUP1', 100_000);
    await line(h, 'u-owner', 'SUP1', 'INV1', { kind: 'invoice', date: '2026-07-01', amountMinor: 500_000 });
    await line(h, 'u-owner', 'SUP1', 'PAY1', { kind: 'payment', date: '2026-07-10', amountMinor: -200_000 });

    // Positive controls on the warm process: opening 100,000 + invoiced 500,000 - paid 200,000 = 400,000.
    expect((await probing(h, 'u-owner')).body as Probing).toMatchObject({ count: 1, probing: [{ partnerId: 'SUP1', attempts: 3 }] });
    expect(((await reviewQueue(h, 'u-owner', 'SUP1')).body as Queue).submissions.map((s) => s.submissionId)).toEqual(['s-cat']);
    expect((await statement(h, 'u-owner', 'SUP1')).body as Stmt).toMatchObject({ closingMinor: 400_000, reconciles: true });

    // The service (or the store-edge box) crashes and comes back — a NEW surface over the SAME event store.
    const restarted = apiHarness({ store: h.store });

    // Hard rule #6: the probe pattern is still there, exactly — audit evidence is not lost to a restart.
    expect((await probing(restarted, 'u-owner')).body as Probing).toMatchObject({ count: 1, probing: [{ partnerId: 'SUP1', userId: 'u-owner', attempts: 3 }] });
    // FR-02: the catalogue is still awaiting review; the accepted invoice is still not in the queue.
    expect(((await reviewQueue(restarted, 'u-owner', 'SUP1')).body as Queue).submissions.map((s) => s.submissionId)).toEqual(['s-cat']);
    // FR-04: the statement rebuilt to the same reconciled balance.
    expect((await statement(restarted, 'u-owner', 'SUP1')).body as Stmt).toMatchObject({ closingMinor: 400_000, reconciles: true });

    // The rebuilt state is LIVE, not a frozen snapshot: a fourth distinct probe after the restart makes it four.
    expect((await probe(restarted, 'u-owner', 'SUP1', 's-p4')).status).toBe(422);
    expect(((await probing(restarted, 'u-owner')).body as Probing).probing[0]).toMatchObject({ partnerId: 'SUP1', attempts: 4 });
    // And a fresh statement line lands on the rebuilt balance: 400,000 - 100,000 = 300,000.
    await line(restarted, 'u-owner', 'SUP1', 'PAY2', { kind: 'payment', date: '2026-07-12', amountMinor: -100_000 });
    expect(((await statement(restarted, 'u-owner', 'SUP1')).body as Stmt).closingMinor).toBe(300_000);
  });
});
