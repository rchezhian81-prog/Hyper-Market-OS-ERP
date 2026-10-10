import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { seedSubstitutionTruth, recordOrderRules, paidOnline, SWAP_PRODUCTS } from '../support/substitution-truth';
import { approvedRequestId } from '../support/approval-request';
import { actionDetails } from '../../services/identity/src/approval-requests';

// API-07 M19-FR-01 / P-08 — the tenant-wide substitution EXCEPTION worklist. Recording a swap is not the
// end of it: some swaps owe the customer money back, need a COD/collect adjustment, were charged above the
// cap under approval, or were refused by policy and left the customer short. `GET /v1/orders/substitution-
// exceptions` folds EVERY recorded swap for the tenant (a per-tenant index appended beside each per-order
// stream) and runs the tested `substitutionExceptions` engine — worst (most money at stake) first — so
// nothing owing money or leaving a customer short waits unseen. A same-price swap that owes nothing never
// appears; a correct-but-refused swap still appears (the customer got less than they ordered).

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const LOC = 'store-1';

const place = (h: ApiHarness, u: string, t: string, orderId: string) =>
  h.request({ method: 'POST', path: `/v1/orders/${orderId}/promise`, userId: u, tenantId: t, idempotencyKey: `place-${t}-${orderId}`,
    body: { lines: [{ productId: 'MILK', quantityMinor: 2 }], locationId: LOC } });

const offer = (over: Record<string, unknown> = {}) => ({
  lineId: 'l1', orderedProductId: 'MILK', orderedName: 'Milk 1L', orderedUnitPriceMinor: 5_000, orderedQuantityMinor: 2,
  substituteProductId: 'MILK-ALT', substituteName: 'Milk 1L alt', substituteUnitPriceMinor: 4_000, substituteQuantityMinor: 2,
  offeredAt: '2026-09-24T10:00:00.000Z', ...over,
});

const sub = (h: ApiHarness, u: string, t: string, orderId: string, body: unknown) =>
  h.request({ method: 'POST', path: `/v1/orders/${orderId}/substitute`, userId: u, tenantId: t, idempotencyKey: `sub-${t}-${orderId}`, body });

const exceptions = (h: ApiHarness, u: string, t: string) =>
  h.request({ method: 'GET', path: '/v1/orders/substitution-exceptions', userId: u, tenantId: t });

interface Queue { readonly exceptions: readonly { orderId: string; lineId: string; kind: string; amountMinor: number }[]; readonly count: number; readonly atRiskMinor: number }

/** Record one swap per order, each producing a different exception kind (or none). */
// FUL-14: every fact a swap is decided from is STORED — the published prices and attributes, the order's payment, the
// customer's rules on the order, the customer's yes to a higher price and a second person's approval.
async function seedSwaps(h: ApiHarness, u: string, t: string): Promise<void> {
  await seedSubstitutionTruth(h, t, SWAP_PRODUCTS);
  await h.provisionRole(t, 'u-picker-lead', 'store_manager');
  const ready = async (orderId: string) => { await place(h, u, t, orderId); await recordOrderRules(h, t, u, orderId, { preference: 'best_match' }); };
  await ready('ord-a'); // cheaper prepaid swap → refund_due 2000
  await paidOnline(h, t, u, 'ord-a', 10_000);
  expect((await sub(h, u, t, 'ord-a', { offer: offer(), decision: 'confirmed' })).status).toBe(201);
  await ready('ord-b'); // dearer COD approved above cap → above_cap_charge 8000
  const approvalId = await approvedRequestId(h, t, 'u-picker-lead', u, {
    kind: 'substitution_above_cap', subjectRef: 'ord-b/l1', valueMinor: 8_000,
    details: actionDetails({ substituteProductId: 'MILK-DEAR', substituteQuantityMinor: 2 }, { orderId: 'ord-b', lineId: 'l1' }),
  });
  expect((await sub(h, 'u-picker-lead', t, 'ord-b', { offer: offer({ substituteProductId: 'MILK-DEAR' }), decision: 'confirmed', approvalId, customerAcceptsHigherPrice: true, contact: { method: 'phone', reference: 'call-ord-b' } })).status).toBe(201);
  // policy-refused controlled item on a cash-on-delivery order → the line is short and the door collects ₹100 less: a collect
  // adjustment of 10000 (FUL-14: its tender is read from the order, so the money is never left out)
  await ready('ord-c');
  expect((await sub(h, u, t, 'ord-c', { offer: offer({ substituteProductId: 'BEER' }), decision: 'confirmed' })).status).toBe(201);
  await ready('ord-d'); // same-price swap → owes nothing → NOT an exception
  await paidOnline(h, t, u, 'ord-d', 10_000);
  expect((await sub(h, u, t, 'ord-d', { offer: offer({ substituteProductId: 'MILK-SAME' }), decision: 'confirmed' })).status).toBe(201);
}

describe('tenant-wide substitution exception worklist (M19-FR-01 / P-08)', () => {
  it('folds every swap shop-wide, worst first, and omits a same-price swap that owes nothing', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await seedSwaps(h, 'u-owner', A);

    const res = await exceptions(h, 'u-owner', A);
    expect(res.status).toBe(200);
    const q = res.body as Queue;
    expect(q.count).toBe(3); // ord-d (same price) does not appear
    expect(q.atRiskMinor).toBe(20_000); // 10000 + 8000 + 2000 — the refused line on a cash-on-delivery order is ₹100 less to collect (FUL-14: its tender is now read)
    expect(q.exceptions.map((e) => [e.orderId, e.kind, e.amountMinor])).toEqual([
      ['ord-c', 'collect_adjustment', 10_000],
      ['ord-b', 'above_cap_charge', 8_000],
      ['ord-a', 'refund_due', 2_000],
    ]);
  });

  it('is empty when nothing has been substituted — count 0, nothing at risk', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const q = (await exceptions(h, 'u-owner', A)).body as Queue;
    expect(q).toMatchObject({ count: 0, atRiskMinor: 0 });
    expect(q.exceptions).toEqual([]);
  });

  it('is per-tenant — one shop\'s swaps never appear in another\'s worklist', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner-a');
    await h.seedOwner(B, 'u-owner-b');
    await seedSwaps(h, 'u-owner-a', A);
    // B substituted nothing.
    expect(((await exceptions(h, 'u-owner-b', B)).body as Queue).count).toBe(0);
    // A is unaffected.
    expect(((await exceptions(h, 'u-owner-a', A)).body as Queue).count).toBe(3);
  });

  it('is durable across a cold restart — the worklist rebuilds from the store', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await seedSwaps(h, 'u-owner', A);
    const restarted = apiHarness({ store: h.store });
    const q = (await exceptions(restarted, 'u-owner', A)).body as Queue;
    expect(q.count).toBe(3);
    expect(q.atRiskMinor).toBe(20_000);
  });

  it('gates the worklist on order.read — a cashier cannot read the shop-wide money-at-risk view', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');
    await seedSwaps(h, 'u-owner', A);
    expect((await exceptions(h, 'u-cash', A)).status).toBe(403);
    expect((await exceptions(h, 'u-owner', A)).status).toBe(200);
  });
});
