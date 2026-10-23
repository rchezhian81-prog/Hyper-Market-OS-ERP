import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ApiHarness } from '../support/api-harness';
import { approvedSuppliers, deliveryPlaces } from '../support/approved-supplier';
import { useRestartableBackings, dayFromToday } from '../support/p3-backings';

// M06-FR-02 "… PO, blanket PO and approvals" (OB-288 P3): a standing agreement with a ceiling and a validity window commits
// nothing by itself; each call-off release is an ordinary purchase order, proposed by a buyer and issued by a second person,
// priced at the agreement's cost and judged against the ceiling when it is raised AND when it is issued. On the in-memory
// store and — with DATABASE_URL — on real PostgreSQL, with a cold restart reading the same agreement and drawdown back.

const backings = useRestartableBackings();
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const INR = 'INR';

interface Drawdown { ceilingMinor: number; issuedMinor: number; pendingMinor: number; remainingMinor: number; byProduct: { productId: string; releasedQty: number; remainingQty: number | null }[] }
interface Presented { agreement: { status: string; approvedBy: string | null; proposedBy: string }; drawdown: Drawdown; validToday: boolean; releases: { poId: string; status: string }[] }

async function cast(h: ApiHarness, T: string): Promise<void> {
  await h.seedOwner(T, 'u-owner');                      // approves (purchase.order.approve)
  await approvedSuppliers(h, T, 'sup-rice', 'sup-oil'); // OB-32
  await deliveryPlaces(h, T, 'store-1');                // OB-37
  await h.provisionRole(T, 'u-buyer', 'store_manager'); // proposes, cannot approve
  await h.provisionRole(T, 'u-cash', 'cashier');        // neither
}

const agreement = (over: Record<string, unknown> = {}) => ({
  supplierId: 'sup-rice', currency: INR, ceilingMinor: 1_000_000, validFrom: dayFromToday(-1), validTo: dayFromToday(90),
  deliverToLocationId: 'store-1',
  lines: [
    { productId: 'rice-5kg', agreedUnitCost: { minor: 40_000, currency: INR }, maxQty: 20 },
    { productId: 'dal-1kg', agreedUnitCost: { minor: 12_000, currency: INR } },
  ],
  ...over,
});

describe.each(backings)('blanket purchase orders (M06-FR-02) — on $name', ({ harness }) => {
  it('agreement → second-person approval → releases at the agreed price, within the ceiling, issued by a second person; a restart reads the same', async () => {
    const h = harness();
    const T = randomUUID();
    await cast(h, T);
    const post = (path: string, userId: string, body: unknown, key: string) => h.request({ method: 'POST', path, userId, tenantId: T, idempotencyKey: key, body });
    const get = (hh: ApiHarness, path: string) => hh.request({ method: 'GET', path, userId: 'u-buyer', tenantId: T });

    // A cashier cannot propose one; terms that do not hold together are refused by name.
    expect((await post('/v1/purchase/blanket-orders/bpo-1', 'u-cash', agreement(), 'cash')).status).toBe(403);
    expect(codeOf(await post('/v1/purchase/blanket-orders/bpo-x', 'u-buyer', agreement({ validTo: dayFromToday(-5) }), 'bad-dates'))).toBe('agreement_ends_before_it_starts');
    expect(codeOf(await post('/v1/purchase/blanket-orders/bpo-y', 'u-buyer', agreement({ supplierId: 'sup-nobody' }), 'bad-sup'))).toBe('supplier_unknown');

    const proposed = await post('/v1/purchase/blanket-orders/bpo-1', 'u-buyer', agreement(), 'propose');
    expect(proposed.status).toBe(201);
    expect((proposed.body as Presented).agreement).toMatchObject({ status: 'proposed', proposedBy: 'u-buyer' });

    // Nothing is released against an agreement nobody approved.
    expect(codeOf(await post('/v1/purchase/orders/rel-0', 'u-buyer', { blanketAgreementId: 'bpo-1', lines: [{ productId: 'rice-5kg', orderedQty: 5 }] }, 'early'))).toBe('agreement_not_approved');
    // The proposer cannot approve it, even holding the authority.
    await h.provisionRole(T, 'u-buyer', 'owner');
    expect(codeOf(await post('/v1/purchase/blanket-orders/bpo-1/approval', 'u-buyer', { reason: 'mine' }, 'self'))).toBe('proposer_cannot_approve');
    const approved = await post('/v1/purchase/blanket-orders/bpo-1/approval', 'u-owner', { reason: 'annual rice and dal terms agreed' }, 'approve');
    expect(approved.status).toBe(200);
    expect((approved.body as Presented).agreement).toMatchObject({ status: 'approved', approvedBy: 'u-owner' });

    // A release carries no price of its own; a product not on the agreement is refused.
    expect(codeOf(await post('/v1/purchase/orders/rel-p', 'u-buyer', { blanketAgreementId: 'bpo-1', lines: [{ productId: 'rice-5kg', orderedQty: 5, unitCost: { minor: 1, currency: INR } }] }, 'priced'))).toBe('not_readable_as_a_release');
    expect(codeOf(await post('/v1/purchase/orders/rel-q', 'u-buyer', { blanketAgreementId: 'bpo-1', lines: [{ productId: 'sugar', orderedQty: 5 }] }, 'off'))).toBe('product_not_on_agreement');
    expect(codeOf(await post('/v1/purchase/orders/rel-r', 'u-buyer', { blanketAgreementId: 'bpo-1', supplierId: 'sup-oil', lines: [{ productId: 'rice-5kg', orderedQty: 5 }] }, 'sup'))).toBe('supplier_not_the_agreements');

    // Release 1: 10 rice (₹4,000) + 20 dal (₹2,400) = ₹6,400 at the AGREED prices.
    const r1 = await post('/v1/purchase/orders/rel-1', 'u-buyer', { blanketAgreementId: 'bpo-1', lines: [{ productId: 'rice-5kg', orderedQty: 10 }, { productId: 'dal-1kg', orderedQty: 20 }] }, 'r1');
    expect(r1.status).toBe(201);
    expect((r1.body as { order: { totalMinor: number; blanketAgreementId: string; status: string; deliverToLocationId: string } }).order).toMatchObject({ totalMinor: 640_000, blanketAgreementId: 'bpo-1', status: 'proposed', deliverToLocationId: 'store-1' });
    // A re-sent release is the same order.
    expect(((await post('/v1/purchase/orders/rel-1', 'u-buyer', { blanketAgreementId: 'bpo-1', lines: [{ productId: 'rice-5kg', orderedQty: 10 }, { productId: 'dal-1kg', orderedQty: 20 }] }, 'r1-again')).body as { alreadyProposed: boolean }).alreadyProposed).toBe(true);

    // The quantity ceiling: 20 rice in all — 10 released, so 11 more is refused; the value ceiling: ₹10,000 — ₹6,400 held.
    expect(codeOf(await post('/v1/purchase/orders/rel-2', 'u-buyer', { blanketAgreementId: 'bpo-1', lines: [{ productId: 'rice-5kg', orderedQty: 11 }] }, 'r2-qty'))).toBe('quantity_ceiling_exceeded');
    expect(codeOf(await post('/v1/purchase/orders/rel-2', 'u-buyer', { blanketAgreementId: 'bpo-1', lines: [{ productId: 'dal-1kg', orderedQty: 31 }] }, 'r2-val'))).toBe('ceiling_exceeded'); // 31 × ₹120 = ₹3,720 > ₹3,600
    const r2 = await post('/v1/purchase/orders/rel-2', 'u-buyer', { blanketAgreementId: 'bpo-1', lines: [{ productId: 'dal-1kg', orderedQty: 30 }] }, 'r2'); // exactly ₹3,600
    expect(r2.status).toBe(201);

    // Each release is issued by a second person — never its buyer.
    expect(codeOf(await post('/v1/purchase/orders/rel-1/approval', 'u-buyer', { reason: 'mine' }, 'self-issue'))).toBe('proposer_cannot_approve');
    expect((await post('/v1/purchase/orders/rel-1/approval', 'u-owner', { reason: 'first call-off' }, 'issue-1')).status).toBe(200);
    // A release is never amended (re-priced or enlarged) — cancel part of it or call off more.
    expect(codeOf(await post('/v1/purchase/orders/rel-1/amendments', 'u-owner', { amendmentId: 'a1', reason: 'more', lines: [{ productId: 'rice-5kg', orderedQty: 12, unitCost: { minor: 40_000, currency: INR } }] }, 'amend'))).toBe('release_amendment_not_allowed');

    let one = (await get(h, '/v1/purchase/blanket-orders/bpo-1')).body as Presented;
    expect(one.drawdown).toMatchObject({ ceilingMinor: 1_000_000, issuedMinor: 640_000, pendingMinor: 360_000, remainingMinor: 0 });
    expect(one.validToday).toBe(true);

    // Cancelling 5 rice on the issued release gives ₹2,000 back to the agreement.
    expect((await post('/v1/purchase/orders/rel-1/cancellations', 'u-owner', { cancellationId: 'c1', reason: 'shelf full', cancelledByProduct: { 'rice-5kg': 5 } }, 'cancel')).status).toBe(200);
    one = (await get(h, '/v1/purchase/blanket-orders/bpo-1')).body as Presented;
    expect(one.drawdown).toMatchObject({ issuedMinor: 440_000, pendingMinor: 360_000, remainingMinor: 200_000 });
    expect(one.drawdown.byProduct.find((p) => p.productId === 'rice-5kg')).toMatchObject({ releasedQty: 5, remainingQty: 15 });

    // A cold restart reads the same agreement, drawdown and releases.
    const again = harness(h);
    const reread = (await get(again, '/v1/purchase/blanket-orders/bpo-1')).body as Presented;
    expect(reread.drawdown).toEqual(one.drawdown);
    expect(reread.releases.map((r) => [r.poId, r.status]).sort()).toEqual([['rel-1', 'issued'], ['rel-2', 'proposed']]);
    const list = (await again.request({ method: 'GET', path: '/v1/purchase/blanket-orders', userId: 'u-owner', tenantId: T })).body as { count: number };
    expect(list.count).toBe(1);
  }, 120_000);

  it('an expired agreement releases nothing, and an agreement head office does not hold is refused by name', async () => {
    const h = harness();
    const T = randomUUID();
    await cast(h, T);
    const post = (path: string, userId: string, body: unknown, key: string) => h.request({ method: 'POST', path, userId, tenantId: T, idempotencyKey: key, body });
    await post('/v1/purchase/blanket-orders/bpo-old', 'u-buyer', agreement({ validFrom: dayFromToday(-60), validTo: dayFromToday(-1) }), 'p');
    await post('/v1/purchase/blanket-orders/bpo-old/approval', 'u-owner', { reason: 'last year' }, 'a');
    expect(codeOf(await post('/v1/purchase/orders/rel-x', 'u-buyer', { blanketAgreementId: 'bpo-old', lines: [{ productId: 'rice-5kg', orderedQty: 1 }] }, 'x'))).toBe('outside_validity');
    expect(codeOf(await post('/v1/purchase/orders/rel-y', 'u-buyer', { blanketAgreementId: 'bpo-none', lines: [{ productId: 'rice-5kg', orderedQty: 1 }] }, 'y'))).toBe('blanket_agreement_unknown');
  }, 120_000);
});
