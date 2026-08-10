import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Roadmap v2.1 A9 (GST from tax-inclusive MRP) + A8 (place-of-supply split), on the live API. The
// tested `extractInclusiveGst` engine now runs on a real route — GET /v1/finance/tax/from-mrp — so the
// back office computes the tax breakdown ONCE, authoritatively, on the server. Proven here over the real
// pipeline: the paisa-exact reconciliation, the CGST+SGST vs IGST split, the RBAC gate, and refusals.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const fromMrp = (h: ApiHarness, userId: string, q: Record<string, string>) =>
  h.request({ method: 'GET', path: '/v1/finance/tax/from-mrp', userId, tenantId: A, query: q });

interface Rounded {
  taxableMinor: number; totalTaxMinor: number; grossMinor: number; roundOffMinor: number;
  components: { component: string; amountMinor: number }[];
}
interface Breakdown {
  grossMinor: number; taxableMinor: number; totalTaxMinor: number; rateBps: number;
  placeOfSupply: string; reconcilesToGross: boolean;
  components: { component: string; rateBps: number; amountMinor: number }[];
  nearestRupee: Rounded;
}

describe('GET /v1/finance/tax/from-mrp — GST pulled out of an inclusive MRP (A9/A8)', () => {
  it('extracts an intra-State breakdown that reconciles to the MRP to the paisa', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    const r = (await fromMrp(h, 'u-owner', { mrpMinor: '11800', rateBps: '1800', placeOfSupply: 'intra_state' })).body as Breakdown;
    expect(r.taxableMinor).toBe(10000);
    expect(r.totalTaxMinor).toBe(1800);
    expect(r.taxableMinor + r.totalTaxMinor).toBe(r.grossMinor); // A9 invariant, end to end
    expect(r.components.map((c) => c.component)).toEqual(['CGST', 'SGST']);
    expect(r.components.every((c) => c.rateBps === 900)).toBe(true);
    expect(r.components.reduce((s, c) => s + c.amountMinor, 0)).toBe(1800);
  });

  it('also serves the whole-rupee per-component view (A10) with its round-off stated', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    // ₹9.99 @ 18% intra → exact taxable 847 / CGST 76 / SGST 77; rounded per component → 800 / 100 / 100.
    const r = (await fromMrp(h, 'u-owner', { mrpMinor: '999', rateBps: '1800', placeOfSupply: 'intra_state' })).body as Breakdown;
    expect(r.taxableMinor + r.totalTaxMinor).toBe(999);          // exact view still reconciles (A9)
    expect(r.nearestRupee.taxableMinor).toBe(800);
    expect(r.nearestRupee.components.map((c) => c.amountMinor)).toEqual([100, 100]);
    expect(r.nearestRupee.grossMinor).toBe(1000);
    expect(r.nearestRupee.roundOffMinor).toBe(1);               // the invoice "Round Off" line
  });

  it('extracts an inter-State breakdown as a single IGST equal to the intra-State total', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    const r = (await fromMrp(h, 'u-owner', { mrpMinor: '10500', rateBps: '500', placeOfSupply: 'inter_state' })).body as Breakdown;
    expect(r.taxableMinor).toBe(10000);
    expect(r.components).toHaveLength(1);
    expect(r.components[0]!.component).toBe('IGST');
    expect(r.components[0]!.amountMinor).toBe(500);
  });

  it('is gated on a finance read — owner, manager and accountant may compute; the till may not', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-mgr', 'store_manager'); // finance.period.read
    await h.provisionRole(A, 'u-acct', 'accountant');   // finance.period.read
    await h.provisionRole(A, 'u-cash', 'cashier');       // no finance.period.read

    const q = { mrpMinor: '11800', rateBps: '1800', placeOfSupply: 'intra_state' };
    for (const u of ['u-owner', 'u-mgr', 'u-acct']) {
      expect((await fromMrp(h, u, q)).status).toBe(200);
    }
    // The till computes tax offline (hard rule #1); it has no business on the back-office calculator.
    expect((await fromMrp(h, 'u-cash', q)).status).toBe(403);
  });

  it('refuses missing figures, a missing place of supply, and an odd intra-State rate', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    expect((await fromMrp(h, 'u-owner', { rateBps: '1800', placeOfSupply: 'intra_state' })).status).toBe(400); // no mrp
    expect((await fromMrp(h, 'u-owner', { mrpMinor: 'lots', rateBps: '1800', placeOfSupply: 'intra_state' })).status).toBe(400); // non-numeric
    expect((await fromMrp(h, 'u-owner', { mrpMinor: '11800', rateBps: '1800' })).status).toBe(400); // no place
    expect((await fromMrp(h, 'u-owner', { mrpMinor: '11800', rateBps: '1801', placeOfSupply: 'intra_state' })).status).toBe(400); // odd intra rate
    // …the same odd rate is fine inter-State (single IGST line).
    expect((await fromMrp(h, 'u-owner', { mrpMinor: '11800', rateBps: '1801', placeOfSupply: 'inter_state' })).status).toBe(200);
  });
});

const discountEligibility = (h: ApiHarness, userId: string, q: Record<string, string>) =>
  h.request({ method: 'GET', path: '/v1/finance/tax/discount-eligibility', userId, tenantId: A, query: q });

interface Discount { discountMinor: number; reducesTaxableValue: boolean; eligibleReductionMinor: number; basis: string }

describe('GET /v1/finance/tax/discount-eligibility — CGST s.15(3) (A11)', () => {
  it('decides eligibility over the real pipeline and gates it on the finance read', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');

    // On the invoice → reduces the taxable value.
    const onInv = (await discountEligibility(h, 'u-owner', { discountMinor: '5000', onInvoice: 'true' })).body as Discount;
    expect(onInv.reducesTaxableValue).toBe(true);
    expect(onInv.basis).toBe('on_invoice');
    expect(onInv.eligibleReductionMinor).toBe(5000);

    // Post-supply with all three conditions → reduces; missing one → commercial only.
    expect(((await discountEligibility(h, 'u-owner', { discountMinor: '5000', preAgreed: 'true', invoiceLinked: 'true', itcReversed: 'true' })).body as Discount).reducesTaxableValue).toBe(true);
    const missing = (await discountEligibility(h, 'u-owner', { discountMinor: '5000', preAgreed: 'true', invoiceLinked: 'true' })).body as Discount;
    expect(missing.reducesTaxableValue).toBe(false);
    expect(missing.eligibleReductionMinor).toBe(0);

    // Refuses a missing amount; and the till may not use the back-office calculator.
    expect((await discountEligibility(h, 'u-owner', { onInvoice: 'true' })).status).toBe(400);
    expect((await discountEligibility(h, 'u-cash', { discountMinor: '5000', onInvoice: 'true' })).status).toBe(403);
  });
});
