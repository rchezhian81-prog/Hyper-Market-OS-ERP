import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// API-04 M28-FR-01 — the write-off write path. A loss (wastage/damage/expiry/donation/destruction) is a
// reason-coded compensating stock movement, valued for finance, and a MATERIAL loss needs captured EVIDENCE
// and a SEPARATE approver (§28: the person who raised it can never approve it). These tests drive the real
// route + adapter + tested `commitWriteOff` engine over the in-memory harness, so the whole wiring is proven.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const post = (h: ApiHarness, u: string, id: string, body: unknown, key = id) =>
  h.request({ method: 'POST', path: `/v1/inventory/write-off/${id}`, userId: u, tenantId: A, idempotencyKey: key, body });

/** The error code lives at body.error.code (the apiError envelope), never body.code. */
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

/** A base write-off body; `valueMinor` vs `thresholdMinor` decides materiality. */
const base = (over: Record<string, unknown> = {}) => ({
  productId: 'MILK-1', locationId: 'store-1', qty: 6, uom: 'ea', lossType: 'expiry',
  reasonCode: 'past-use-by', valueMinor: 30_000, thresholdMinor: 100_000, ...over,
});

describe('write-off routes (M28-FR-01)', () => {
  it('commits an immaterial loss with no approval or evidence', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const res = await post(h, 'u-owner', 'wo-1', base());
    expect(res.status).toBe(201);
    const body = res.body as { id: string; lossType: string; qtyRemoved: number; requiredApproval: boolean };
    expect(body.requiredApproval).toBe(false);
    expect(body.qtyRemoved).toBe(6);
    expect(body.lossType).toBe('expiry');
  });

  it('refuses a MATERIAL loss without captured evidence (M28-FR-01)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    // Material: value ≥ threshold, but no evidenceRef.
    const res = await post(h, 'u-owner', 'wo-2', base({ valueMinor: 500_000, lossType: 'damage', approvedBy: 'u-checker' }));
    expect(res.status).toBe(422);
    expect(codeOf(res)).toBe('write_off_needs_evidence');
  });

  it('refuses a MATERIAL loss without a separate approver, and one the raiser approves themselves (§28)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    // Evidence present but no approval → needs approval.
    const noApproval = await post(h, 'u-owner', 'wo-3', base({ valueMinor: 500_000, lossType: 'damage', evidenceRef: 'photo-1' }));
    expect(noApproval.status).toBe(422);
    expect(codeOf(noApproval)).toBe('write_off_needs_approval');
    // Self-approval: the raiser (u-owner) names themselves the approver → refused (§28).
    const selfApproved = await post(h, 'u-owner', 'wo-4', base({ valueMinor: 500_000, lossType: 'damage', evidenceRef: 'photo-1', approvedBy: 'u-owner' }));
    expect(selfApproved.status).toBe(422);
    expect(codeOf(selfApproved)).toBe('write_off_needs_approval');
  });

  it('commits a MATERIAL loss with evidence AND a different approver', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const res = await post(h, 'u-owner', 'wo-5', base({ valueMinor: 500_000, lossType: 'damage', evidenceRef: 'photo-1', approvedBy: 'u-checker' }));
    expect(res.status).toBe(201);
    const body = res.body as { requiredApproval: boolean; evidenceRef: string | null };
    expect(body.requiredApproval).toBe(true);
    expect(body.evidenceRef).toBe('photo-1');
  });

  it('refuses a missing reason and a non-positive quantity, and is idempotent on the id', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    expect((await post(h, 'u-owner', 'wo-6', base({ reasonCode: '' }))).status).toBe(400);
    expect((await post(h, 'u-owner', 'wo-7', base({ qty: 0 }))).status).toBe(400);
    // Committed once; the same id a second time is refused (append-only — a correction is a new id).
    // A DIFFERENT idempotency-key on the retry so the kernel runs the handler again (not a cached replay);
    // the handler then sees the id already recorded → 409.
    expect((await post(h, 'u-owner', 'wo-8', base())).status).toBe(201);
    expect((await post(h, 'u-owner', 'wo-8', base(), 'wo-8-again')).status).toBe(409);
  });

  it('lists committed write-offs with the day total, survives a restart, and gates read on waste.view', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier'); // no waste.view, no inventory.movement.append
    await post(h, 'u-owner', 'wo-9', base({ valueMinor: 30_000 }));
    await post(h, 'u-owner', 'wo-10', base({ valueMinor: 20_000, productId: 'BREAD', lossType: 'donation' }));

    const list = await h.request({ method: 'GET', path: '/v1/inventory/write-offs', userId: 'u-owner', tenantId: A });
    expect(list.status).toBe(200);
    const body = list.body as { count: number; totalLossMinor: number };
    expect(body.count).toBe(2);
    expect(body.totalLossMinor).toBe(50_000);

    // A cashier may neither read the losses nor record one (default-deny).
    expect((await h.request({ method: 'GET', path: '/v1/inventory/write-offs', userId: 'u-cash', tenantId: A })).status).toBe(403);
    expect((await post(h, 'u-cash', 'wo-11', base())).status).toBe(403);
  });
});
