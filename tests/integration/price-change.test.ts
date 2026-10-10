import { describe, it, expect } from 'vitest';
import { aBranch } from '../support/a-branch';
import { storeRules } from '../support/store-rules';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { approvedRequestId, askForApproval, decide } from '../support/approval-request';

// Governed price changes through the real API (M05-FR-02, §28). A price above the legal MRP is
// rejected outright; a below-floor / below-cost price is blocked unless a SEPARATE person — who
// genuinely holds price.change.approve — signs it off with a reason. The separation is enforced
// server-side through the tested price-guard engine and the real per-tenant RBAC, not a name in a
// form: since 2b-vi-b (ADR-0024) the approver approves in their OWN session (kind `price_change`) and the
// change names that approval; a typed approver is refused. This is "M05's own path"; the pack-publish path
// re-checks §28 before it reaches the shelf.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
// MRP ₹100, cost ₹50, 20% margin floor → below-floor when price·8000 < 50,000,000, i.e. price < 6250.
const CTX = { mrpMinor: 10_000, costMinor: 5_000, marginFloorBps: 2_000, currency: 'INR' } as const;

const change = (priceMinor: number) => ({ productId: 'P1', priceMinor, ...CTX });
const propose = (h: ApiHarness, o: {
  userId: string; priceMinor: number; key: string; approval?: { decidedBy: string; reason: string }; approvalId?: string;
}) => h.request({
  method: 'POST', path: '/v1/prices/changes', userId: o.userId, tenantId: A, idempotencyKey: o.key,
  body: { ...change(o.priceMinor), ...(o.approval === undefined ? {} : { approval: o.approval }), ...(o.approvalId === undefined ? {} : { approvalId: o.approvalId }) },
});
/** The setter asks for approval of exactly this change; `checker` approves it in their own session. */
const approved = (h: ApiHarness, setter: string, checker: string, priceMinor: number) =>
  approvedRequestId(h, A, setter, checker, { kind: 'price_change', subjectRef: 'P1', details: change(priceMinor), valueMinor: priceMinor });
const code = (r: { body: unknown }): string => (r.body as { error: { code: string } }).error.code;

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.provisionOwner(A, 'owner-1'); // owner: propose + approve
  await h.provisionOwner(A, 'owner-2'); // owner: propose + approve
  await h.provisionRole(A, 'mgr', 'store_manager'); // propose, NOT approve
  await h.provisionRole(A, 'cash', 'cashier'); // neither
  await aBranch(h, A, 'owner-1'); // SF-01: the store a head-office price applies to
  await storeRules(h, A, 'owner-1', 'store-1', 2_000); // M05: the store's own 20% margin floor — what a price is judged by
  return h;
}

describe('governed price changes enforce MRP and separation of duties (M05-FR-02, §28)', () => {
  it('accepts a healthy price with no approval needed', async () => {
    const r = await propose(await cast(), { userId: 'owner-1', priceMinor: 8_000, key: 'k1' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ verdict: 'ok', approvedBy: null });
  });

  it('rejects a price above the MRP outright — no approval can lift it', async () => {
    const h = await cast();
    const r = await propose(h, { userId: 'owner-1', priceMinor: 12_000, key: 'k2', approvalId: await approved(h, 'owner-1', 'owner-2', 12_000) });
    expect(r.status).toBe(422);
    expect(code(r)).toBe('price_above_mrp');
  });

  it('blocks a below-floor price with no separate approval', async () => {
    const r = await propose(await cast(), { userId: 'owner-1', priceMinor: 6_000, key: 'k3' });
    expect(r.status).toBe(422);
    expect(code(r)).toBe('price_below_floor');
  });

  it('refuses a typed approver — naming a person is not their approval (audit PA-03)', async () => {
    const r = await propose(await cast(), { userId: 'owner-1', priceMinor: 6_000, key: 'k4t', approval: { decidedBy: 'owner-2', reason: 'clear stock' } });
    expect(r.status).toBe(422);
    expect(code(r)).toBe('approver_named_without_approval');
  });

  it('refuses a self-approved below-floor price (§28)', async () => {
    const h = await cast();
    const asked = await askForApproval(h, A, 'owner-1', { kind: 'price_change', subjectRef: 'P1', details: change(6_000), valueMinor: 6_000 });
    const r = await decide(h, A, 'owner-1', (asked.body as { requestId: string }).requestId);
    expect(r.status).toBe(422);
    expect(code(r)).toBe('self_approval');
  });

  it('refuses an approval from someone who may not approve prices', async () => {
    const h = await cast();
    const asked = await askForApproval(h, A, 'owner-1', { kind: 'price_change', subjectRef: 'P1', details: change(6_000), valueMinor: 6_000 });
    expect((await decide(h, A, 'mgr', (asked.body as { requestId: string }).requestId)).status).toBe(403);
  });

  it('allows a below-floor price with a proper two-person approval, and records who approved — once', async () => {
    const h = await cast();
    const approvalId = await approved(h, 'owner-1', 'owner-2', 6_000);
    const r = await propose(h, { userId: 'owner-1', priceMinor: 6_000, key: 'k6', approvalId });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ verdict: 'below_floor', approvedBy: 'owner-2' });
    // The approval was for ₹60 — not ₹55, and not twice.
    expect(code(await propose(h, { userId: 'owner-1', priceMinor: 5_500, key: 'k6b', approvalId }))).toBe('approval_already_used');
  });

  it('an approval of one price never sets another (the details are bound)', async () => {
    const h = await cast();
    const approvalId = await approved(h, 'owner-1', 'owner-2', 6_000);
    expect(code(await propose(h, { userId: 'owner-1', priceMinor: 5_500, key: 'k6c', approvalId }))).toBe('approval_does_not_match');
    expect(code(await propose(h, { userId: 'owner-2', priceMinor: 6_000, key: 'k6d', approvalId }))).toBe('approval_does_not_match'); // another setter
  });

  it('refuses a caller who may not propose a price change (403)', async () => {
    const r = await propose(await cast(), { userId: 'cash', priceMinor: 8_000, key: 'k7' });
    expect(r.status).toBe(403);
  });
});
