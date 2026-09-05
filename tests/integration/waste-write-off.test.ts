import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// API-04 M28-FR-01 — the write-off write path, now the SINGLE governed door for a stock loss. A loss
// (wastage/damage/expiry/donation/destruction) is a reason-coded compensating stock movement that REDUCES
// on-hand (one truth, P-02), valued for finance, and a MATERIAL loss (value ≥ the tenant threshold) needs
// captured EVIDENCE and a SEPARATE approver who GENUINELY holds Manager/Owner authority (§28 — the raiser can
// never approve it, and a name in the box is not an approval). The material-loss threshold is the tenant's
// policy, sourced server-side — the caller cannot declare their own and call any loss "immaterial". These
// tests drive the real route + adapter + tested `commitWriteOff` engine over the in-memory harness.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const post = (h: ApiHarness, u: string, id: string, body: unknown, key = id) =>
  h.request({ method: 'POST', path: `/v1/inventory/write-off/${id}`, userId: u, tenantId: A, idempotencyKey: key, body });
const move = (h: ApiHarness, u: string, m: Record<string, unknown>) =>
  h.request({ method: 'POST', path: '/v1/inventory/movements', userId: u, tenantId: A, idempotencyKey: `mv-${m['movementId']}`, body: m });
const availability = async (h: ApiHarness, u: string): Promise<{ productId: string; locationId: string; onHandMinor: number }[]> =>
  ((await h.request({ method: 'GET', path: '/v1/inventory/availability', userId: u, tenantId: A })).body as { rows: { productId: string; locationId: string; onHandMinor: number }[] }).rows;
const getThreshold = (h: ApiHarness, u: string) =>
  h.request({ method: 'GET', path: '/v1/inventory/write-off-threshold', userId: u, tenantId: A });
const setThreshold = (h: ApiHarness, u: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: '/v1/inventory/write-off-threshold', userId: u, tenantId: A, idempotencyKey: key, body });

/** The error code lives at body.error.code (the apiError envelope), never body.code. */
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

// The default material-loss threshold is ₹500 (50_000 paise). `valueMinor` vs that decides materiality.
const base = (over: Record<string, unknown> = {}) => ({
  productId: 'MILK-1', locationId: 'store-1', qty: 6, uom: 'ea', lossType: 'expiry',
  reasonCode: 'past-use-by', valueMinor: 30_000, ...over,
});

// u-owner raises; u-mgr (store_manager) is a genuine Manager approver; u-cash (cashier) holds neither.
async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // holds inventory.movement.append (Manager/Owner)
  await h.provisionRole(A, 'u-cash', 'cashier');       // holds neither
  return h;
}

describe('write-off routes are the single governed door for a stock loss (M28-FR-01)', () => {
  it('commits an immaterial loss (below the tenant threshold) with no approval or evidence', async () => {
    const h = await cast();
    const res = await post(h, 'u-owner', 'wo-1', base()); // ₹300 < ₹500
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ requiredApproval: false, qtyRemoved: 6, lossType: 'expiry' });
  });

  it('refuses a MATERIAL loss without captured evidence (M28-FR-01)', async () => {
    const h = await cast();
    // Material: value ≥ the ₹500 threshold, but no evidenceRef (the evidence check precedes the approver).
    const res = await post(h, 'u-owner', 'wo-2', base({ valueMinor: 500_000, lossType: 'damage', approvedBy: 'u-mgr' }));
    expect(res.status).toBe(422);
    expect(codeOf(res)).toBe('write_off_needs_evidence');
  });

  it('refuses a MATERIAL loss without a separate approver, and one the raiser approves themselves (§28)', async () => {
    const h = await cast();
    const noApproval = await post(h, 'u-owner', 'wo-3', base({ valueMinor: 500_000, lossType: 'damage', evidenceRef: 'photo-1' }));
    expect(noApproval.status).toBe(422);
    expect(codeOf(noApproval)).toBe('write_off_needs_approval');
    // Self-approval: the raiser (u-owner) names themselves the approver → refused (§28).
    const selfApproved = await post(h, 'u-owner', 'wo-4', base({ valueMinor: 500_000, lossType: 'damage', evidenceRef: 'photo-1', approvedBy: 'u-owner' }));
    expect(selfApproved.status).toBe(422);
    expect(codeOf(selfApproved)).toBe('write_off_needs_approval');
  });

  it('refuses a MATERIAL loss whose named approver does not hold the authority — a name is not an approval', async () => {
    const h = await cast();
    // A cashier (no authority) named as approver on a material loss is refused (the bypass being closed).
    const byCashier = await post(h, 'u-owner', 'wo-5a', base({ valueMinor: 500_000, lossType: 'damage', evidenceRef: 'photo-1', approvedBy: 'u-cash' }));
    expect(byCashier.status).toBe(422);
    expect(codeOf(byCashier)).toBe('approver_may_not_approve');
    // An unprovisioned name (a name typed in a box) is refused just the same.
    const byGhost = await post(h, 'u-owner', 'wo-5b', base({ valueMinor: 500_000, lossType: 'damage', evidenceRef: 'photo-1', approvedBy: 'u-nobody' }));
    expect(byGhost.status).toBe(422);
    expect(codeOf(byGhost)).toBe('approver_may_not_approve');
  });

  it('commits a MATERIAL loss with evidence AND a genuine Manager/Owner approver', async () => {
    const h = await cast();
    const res = await post(h, 'u-owner', 'wo-6', base({ valueMinor: 500_000, lossType: 'damage', evidenceRef: 'photo-1', approvedBy: 'u-mgr' }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ requiredApproval: true, evidenceRef: 'photo-1' });
  });

  it('reduces on-hand — a committed loss removes the stock, not just records it (P-02)', async () => {
    const h = await cast();
    // Receive 20 of MILK-1 at store-1, then write off 6 (immaterial). On-hand should fall to 14.
    expect((await move(h, 'u-owner', { movementId: 'rcv-1', productId: 'MILK-1', locationId: 'store-1', kind: 'received', quantityMinor: 20, uom: 'ea', occurredAt: '2026-08-07T09:00:00.000Z', enteredBy: 'u-owner' })).status).toBe(202);
    expect((await post(h, 'u-owner', 'wo-onhand', base({ qty: 6 }))).status).toBe(201);
    const milk = (await availability(h, 'u-owner')).find((r) => r.productId === 'MILK-1' && r.locationId === 'store-1');
    expect(milk).toMatchObject({ onHandMinor: 14 });
  });

  it('refuses a missing reason and a non-positive quantity, and is idempotent on the id', async () => {
    const h = await cast();
    expect((await post(h, 'u-owner', 'wo-7', base({ reasonCode: '' }))).status).toBe(400);
    expect((await post(h, 'u-owner', 'wo-8', base({ qty: 0 }))).status).toBe(400);
    // Committed once; the same id a second time is refused (append-only — a correction is a new id).
    expect((await post(h, 'u-owner', 'wo-9', base())).status).toBe(201);
    expect((await post(h, 'u-owner', 'wo-9', base(), 'wo-9-again')).status).toBe(409);
  });

  it('lists committed write-offs with the day total, survives a restart, and gates read on waste.view', async () => {
    const h = await cast();
    await post(h, 'u-owner', 'wo-10', base({ valueMinor: 30_000 }));
    await post(h, 'u-owner', 'wo-11', base({ valueMinor: 20_000, productId: 'BREAD', lossType: 'donation' }));

    const list = await h.request({ method: 'GET', path: '/v1/inventory/write-offs', userId: 'u-owner', tenantId: A });
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ count: 2, totalLossMinor: 50_000 });

    // A cashier may neither read the losses nor record one (default-deny).
    expect((await h.request({ method: 'GET', path: '/v1/inventory/write-offs', userId: 'u-cash', tenantId: A })).status).toBe(403);
    expect((await post(h, 'u-cash', 'wo-12', base())).status).toBe(403);

    const restarted = apiHarness({ store: h.store });
    expect(((await restarted.request({ method: 'GET', path: '/v1/inventory/write-offs', userId: 'u-owner', tenantId: A })).body as { count: number })).toMatchObject({ count: 2 });
  });

  it('the material-loss threshold is the tenant policy — readable, owner-settable, and not the caller\'s to declare', async () => {
    const h = await cast();
    // Default is readable and marked the software default.
    expect((await getThreshold(h, 'u-mgr')).body).toMatchObject({ thresholdMinor: 50_000, isDefault: true });
    // Only the owner may set it — a manager/cashier cannot.
    expect((await setThreshold(h, 'u-mgr', { thresholdMinor: 200_000 }, 't-mgr')).status).toBe(403);
    expect((await setThreshold(h, 'u-cash', { thresholdMinor: 200_000 }, 't-cash')).status).toBe(403);
    // The owner raises the threshold to ₹2,000.
    expect((await setThreshold(h, 'u-owner', { thresholdMinor: 200_000 }, 't-ok')).status).toBe(200);
    expect((await getThreshold(h, 'u-mgr')).body).toMatchObject({ thresholdMinor: 200_000, isDefault: false });
    // A ₹1,000 loss was MATERIAL under the ₹500 default (would need evidence + approval); under ₹2,000 it is
    // immaterial and commits with neither — proving the tenant policy, not the body, decides materiality.
    const res = await post(h, 'u-owner', 'wo-th', base({ valueMinor: 100_000 }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ requiredApproval: false });
  });
});
