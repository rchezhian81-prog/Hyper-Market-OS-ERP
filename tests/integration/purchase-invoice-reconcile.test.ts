import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

/**
 * **Full three-way match with landed cost, end to end (M07-FR-04 · D03-FR-05 · §28, API-03).**
 *
 * The control that stops the shop paying for goods it never got, at a price it never agreed — and
 * knowing what the stock actually cost once freight and duty are shared across the lines. Distinct
 * from the store-backed /match: this is the stateless reconciliation the AP clerk drives with the
 * three source documents (purchase order, goods receipt, supplier invoice). It VALUES every variance,
 * apportions the charges to the paisa, and blocks payment on an out-of-tolerance variance until
 * someone who did NOT receive the goods approves it. Drives the pure `matchInvoice` through the API.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const inr = (minor: number) => ({ minor, currency: 'INR' });
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

const POLICY = { priceToleranceBp: 100, quantityToleranceBp: 0, immaterialMinor: 100 };
const ORDERED = [
  { lineId: 'l1', productId: 'rice', quantityMinor: 100, unitCost: inr(5_000) },
  { lineId: 'l2', productId: 'milk', quantityMinor: 50, unitCost: inr(2_000) },
];
const RECEIVED = [
  { lineId: 'l1', productId: 'rice', quantityMinor: 100 },
  { lineId: 'l2', productId: 'milk', quantityMinor: 50 },
];
const cleanInvoiced = [
  { lineId: 'l1', productId: 'rice', quantityMinor: 100, unitCost: inr(5_000) },
  { lineId: 'l2', productId: 'milk', quantityMinor: 50, unitCost: inr(2_000) },
];

const reconcile = (h: ApiHarness, userId: string, invoiceId: string, body: Record<string, unknown>, key: string) =>
  h.request({ method: 'POST', path: `/v1/purchase/invoices/${invoiceId}/reconcile`, userId, tenantId: A, idempotencyKey: key, body });

const base = (over: Record<string, unknown> = {}) =>
  ({ ordered: ORDERED, received: RECEIVED, invoiced: cleanInvoiced, policy: POLICY, currency: 'INR', receivedBy: 'receiver-1', ...over });

describe('three-way invoice reconciliation with landed cost (M07-FR-04, D03-FR-05)', () => {
  it('pays a clean invoice and shares freight + duty across the lines by value, to the paisa', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const res = await reconcile(h, 'u-owner', 'inv-1', base({ charges: { freight: inr(60_000), duty: inr(30_000) } }), 'rec-clean');
    expect(res.status).toBe(200);
    const r = res.body as {
      outcome: string; payable: boolean; variances: unknown[];
      landedCost: { apportionedCharges: { minor: number }; landedValue: { minor: number } }[];
    };
    expect(r.outcome).toBe('matched');
    expect(r.payable).toBe(true);
    expect(r.variances).toEqual([]);
    expect(r.landedCost[0]?.apportionedCharges.minor).toBe(75_000); // 90,000 × 500000/600000
    expect(r.landedCost[1]?.apportionedCharges.minor).toBe(15_000); // 90,000 × 100000/600000
    expect(r.landedCost[0]?.landedValue.minor).toBe(575_000);       // goods 500000 + 75000
    const spread = r.landedCost.reduce((s, l) => s + l.apportionedCharges.minor, 0);
    expect(spread).toBe(90_000); // no rounding remainder lost
  });

  it('blocks payment on a price over the agreed cost beyond tolerance, and values the variance', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const res = await reconcile(h, 'u-owner', 'inv-1', base({
      invoiced: [{ lineId: 'l1', productId: 'rice', quantityMinor: 100, unitCost: inr(5_500) }, cleanInvoiced[1]],
    }), 'rec-over');
    expect(res.status).toBe(200);
    const r = res.body as { payable: boolean; outcome: string; variances: { kind: string; value: { minor: number }; withinTolerance: boolean }[]; blockedReason: string };
    expect(r.payable).toBe(false);
    expect(r.outcome).toBe('blocked_pending_approval');
    const v = r.variances.find((x) => x.kind === 'price_over');
    expect(v?.value.minor).toBe(50_000); // ₹5.00 × 100
    expect(v?.withinTolerance).toBe(false);
    expect(r.blockedReason).toContain('needs approval');
  });

  it('releases a blocked invoice on approval — but never by the person who received the goods (§28)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const overInvoiced = base({
      invoiced: [{ lineId: 'l1', productId: 'rice', quantityMinor: 100, unitCost: inr(5_500) }, cleanInvoiced[1]],
    });

    // The receiver clearing their own receipt is refused (§28) — still not payable.
    const selfApproved = await reconcile(h, 'u-owner', 'inv-1', { ...overInvoiced, approval: { subjectRef: 'inv-1', status: 'approved', decidedBy: 'receiver-1' } }, 'rec-self');
    expect(selfApproved.status).toBe(200);
    expect((selfApproved.body as { payable: boolean }).payable).toBe(false);
    expect((selfApproved.body as { blockedReason: string }).blockedReason).toContain('received the goods cannot approve');

    // A separate approver clears it.
    const approved = await reconcile(h, 'u-owner', 'inv-1', { ...overInvoiced, approval: { subjectRef: 'inv-1', status: 'approved', decidedBy: 'buyer-1' } }, 'rec-appr');
    expect((approved.body as { payable: boolean }).payable).toBe(true);
  });

  it('refuses an approval that authorises a different invoice', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const res = await reconcile(h, 'u-owner', 'inv-1', base({
      invoiced: [{ lineId: 'l1', productId: 'rice', quantityMinor: 100, unitCost: inr(5_500) }, cleanInvoiced[1]],
      approval: { subjectRef: 'inv-OTHER', status: 'approved', decidedBy: 'buyer-1' },
    }), 'rec-wrong');
    expect(res.status).toBe(422);
    expect(codeOf(res)).toBe('approval_authorises_a_different_invoice');
  });

  it('refuses an unreadable match, and is closed without the permission', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const bad = await reconcile(h, 'u-owner', 'inv-1', { ordered: ORDERED, currency: 'INR' }, 'rec-bad'); // no invoiced/received/policy/receivedBy
    expect(bad.status).toBe(400);
    expect(codeOf(bad)).toBe('not_readable_as_a_three_way_match');

    const forbidden = await reconcile(h, 'u-nobody', 'inv-1', base(), 'rec-403');
    expect(forbidden.status).toBe(403);
  });
});
