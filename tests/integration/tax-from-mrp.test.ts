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

const get = (h: ApiHarness, userId: string, path: string, query: Record<string, string>) =>
  h.request({ method: 'GET', path, userId, tenantId: A, query });

describe('GET /v1/finance/tax/{bogo,free-sample,voucher-timing} — promotional supplies (A12)', () => {
  it('serves the BOGO, free-sample and voucher rules over the real pipeline, gated on the finance read', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');

    const bogo = (await get(h, 'u-owner', '/v1/finance/tax/bogo', { paidUnits: '1', freeUnits: '1', unitConsiderationMinor: '10000' })).body as { taxableConsiderationMinor: number; itcReversalRequired: boolean };
    expect(bogo.taxableConsiderationMinor).toBe(10000);
    expect(bogo.itcReversalRequired).toBe(false);       // BOGO keeps the ITC

    const sample = (await get(h, 'u-owner', '/v1/finance/tax/free-sample', { itcClaimedMinor: '900' })).body as { isSupply: boolean; itcReversalRequired: boolean; itcToReverseMinor: number };
    expect(sample.isSupply).toBe(false);
    expect(sample.itcReversalRequired).toBe(true);       // …a free sample reverses it
    expect(sample.itcToReverseMinor).toBe(900);

    const atIssue = (await get(h, 'u-owner', '/v1/finance/tax/voucher-timing', { supplyIdentifiableAtIssue: 'true', issueDate: '2026-08-01' })).body as { basis: string; timeOfSupply: string };
    expect(atIssue.basis).toBe('issue');
    expect(atIssue.timeOfSupply).toBe('2026-08-01');
    // Not identifiable at issue and not yet redeemed → refused (pending, never guessed).
    expect((await get(h, 'u-owner', '/v1/finance/tax/voucher-timing', { supplyIdentifiableAtIssue: 'false', issueDate: '2026-08-01' })).status).toBe(400);

    // The till may not use the back-office calculator.
    expect((await get(h, 'u-cash', '/v1/finance/tax/bogo', { paidUnits: '1', freeUnits: '1', unitConsiderationMinor: '10000' })).status).toBe(403);
  });
});

describe('GET /v1/finance/tax/rate-on-date — rate in force on the supply date (A6)', () => {
  it('resolves the rate across a change boundary, parses the schedule, and gates on the finance read', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');
    const schedule = '2017-07-01:1800,2026-09-01:4000';

    const before = (await get(h, 'u-owner', '/v1/finance/tax/rate-on-date', { schedule, supplyDate: '2026-08-31' })).body as { rateBps: number; effectiveFrom: string };
    expect(before.rateBps).toBe(1800);
    expect(before.effectiveFrom).toBe('2017-07-01');

    const onOrAfter = (await get(h, 'u-owner', '/v1/finance/tax/rate-on-date', { schedule, supplyDate: '2026-09-01' })).body as { rateBps: number };
    expect(onOrAfter.rateBps).toBe(4000);

    // A malformed schedule entry is refused; a supply before the earliest rate is refused; the till is refused.
    expect((await get(h, 'u-owner', '/v1/finance/tax/rate-on-date', { schedule: '2017-07-01-1800', supplyDate: '2026-09-01' })).status).toBe(400);
    expect((await get(h, 'u-owner', '/v1/finance/tax/rate-on-date', { schedule, supplyDate: '2017-06-30' })).status).toBe(400);
    expect((await get(h, 'u-cash', '/v1/finance/tax/rate-on-date', { schedule, supplyDate: '2026-09-01' })).status).toBe(403);
  });
});

interface Cess {
  hsnCode: string; cessLiable: boolean; taxableMinor: number; quantity: number;
  advaloremCessMinor: number; specificCessMinor: number; totalCessMinor: number;
  holdover?: { ok: boolean; band: string; detail: string };
}

describe('GET /v1/finance/tax/cess — GST Compensation Cess on tobacco/pan-masala (A7)', () => {
  it('computes ad-valorem + specific cess, applies the holdover check, and gates on the finance read', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');

    // Pan-masala: ₹100 taxable at 60% ad-valorem → ₹60 cess; on 28% GST it is a valid holdover.
    const pm = (await get(h, 'u-owner', '/v1/finance/tax/cess', { hsn: '21069020', taxableMinor: '10000', advaloremBps: '6000', gstRateBps: '2800' })).body as Cess;
    expect(pm.cessLiable).toBe(true);
    expect(pm.advaloremCessMinor).toBe(6000);
    expect(pm.totalCessMinor).toBe(6000);
    expect(pm.holdover!.ok).toBe(true);
    expect(pm.holdover!.band).toBe('cess_holdover_28');

    // Cigarettes: ₹200 taxable + a 20-pack at ₹4170/1000 sticks → ₹10 ad-valorem + ₹83.40 specific.
    const cig = (await get(h, 'u-owner', '/v1/finance/tax/cess', { hsn: '24022090', taxableMinor: '20000', advaloremBps: '500', specificPerQuantityMinor: '417000', perQuantity: '1000', quantity: '20' })).body as Cess;
    expect(cig.advaloremCessMinor).toBe(1000);
    expect(cig.specificCessMinor).toBe(8340);
    expect(cig.totalCessMinor).toBe(9340);

    // The double-tax guard: a cess-liable good ALSO on the 40% demerit slab is refused (holdover.ok=false).
    const dbl = (await get(h, 'u-owner', '/v1/finance/tax/cess', { hsn: '24022090', taxableMinor: '20000', advaloremBps: '500', gstRateBps: '4000' })).body as Cess;
    expect(dbl.holdover!.ok).toBe(false);
    expect(dbl.holdover!.band).toBe('demerit_40');

    // An ordinary grocery line (no cess spec) is not liable — cess is zero (the data gate).
    const bread = (await get(h, 'u-owner', '/v1/finance/tax/cess', { hsn: '1905', taxableMinor: '5000' })).body as Cess;
    expect(bread.cessLiable).toBe(false);
    expect(bread.totalCessMinor).toBe(0);

    // Refuses missing figures and a bad param; the till may not use the back-office calculator.
    expect((await get(h, 'u-owner', '/v1/finance/tax/cess', { taxableMinor: '10000' })).status).toBe(400); // no hsn
    expect((await get(h, 'u-owner', '/v1/finance/tax/cess', { hsn: '24022090', taxableMinor: 'lots' })).status).toBe(400); // non-numeric taxable
    expect((await get(h, 'u-owner', '/v1/finance/tax/cess', { hsn: '24022090', taxableMinor: '10000', advaloremBps: 'high' })).status).toBe(400); // bad param
    expect((await get(h, 'u-cash', '/v1/finance/tax/cess', { hsn: '24022090', taxableMinor: '10000', advaloremBps: '6000' })).status).toBe(403);
  });
});

describe('GET /v1/finance/tax/hsn-digits — HSN digit count by turnover (A4)', () => {
  it('reports the required digits, validates a code, and gates on the finance read', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');

    // Small shop → 4 digits; big shop (> ₹5cr) → 6.
    expect(((await get(h, 'u-owner', '/v1/finance/tax/hsn-digits', { annualTurnoverMinor: '1000000' })).body as { requiredDigits: number }).requiredDigits).toBe(4);
    expect(((await get(h, 'u-owner', '/v1/finance/tax/hsn-digits', { annualTurnoverMinor: '5000000001' })).body as { requiredDigits: number }).requiredDigits).toBe(6);

    // Validate a code: a 4-digit HSN fails for a big shop.
    const bad = (await get(h, 'u-owner', '/v1/finance/tax/hsn-digits', { annualTurnoverMinor: '5000000001', hsn: '1006' })).body as { valid: boolean; requiredDigits: number };
    expect(bad.valid).toBe(false);
    expect(bad.requiredDigits).toBe(6);
    expect(((await get(h, 'u-owner', '/v1/finance/tax/hsn-digits', { annualTurnoverMinor: '5000000001', hsn: '100630' })).body as { valid: boolean }).valid).toBe(true);

    // Refuses a malformed HSN; the till is refused.
    expect((await get(h, 'u-owner', '/v1/finance/tax/hsn-digits', { annualTurnoverMinor: '1000000', hsn: '10A6' })).status).toBe(400);
    expect((await get(h, 'u-cash', '/v1/finance/tax/hsn-digits', { annualTurnoverMinor: '1000000' })).status).toBe(403);
  });
});

describe('GET /v1/finance/tax/invoice-number — gap-free ≤16-char series with FY reset (A2)', () => {
  it('formats the next number, resets on a new FY, rejects >16 chars, and gates on the finance read', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');

    // A document dated Aug 2026 → FY 2026-27 (compact 2627); seq 1 → INV/2627/000001.
    const ok = (await get(h, 'u-owner', '/v1/finance/tax/invoice-number', { prefix: 'INV', padTo: '6', seq: '1', date: '2026-08-10' })).body as { number: string; seq: number };
    expect(ok.number).toBe('INV/2627/000001');

    // Series counting in FY 2627 but a document dated in the next FY resets the sequence to 1.
    const reset = (await get(h, 'u-owner', '/v1/finance/tax/invoice-number', { prefix: 'INV', padTo: '6', seq: '250', date: '2027-04-01', fyOfSeries: '2627' })).body as { number: string; seq: number };
    expect(reset.seq).toBe(1);
    expect(reset.number).toBe('INV/2728/000001');

    // A prefix that pushes the number past 16 chars is rejected.
    expect((await get(h, 'u-owner', '/v1/finance/tax/invoice-number', { prefix: 'INVOICE', padTo: '6', seq: '1', date: '2026-08-10' })).status).toBe(400);
    // Missing series fields → 400; the till may not use the back-office calculator.
    expect((await get(h, 'u-owner', '/v1/finance/tax/invoice-number', { prefix: 'INV', padTo: '6', date: '2026-08-10' })).status).toBe(400);
    expect((await get(h, 'u-cash', '/v1/finance/tax/invoice-number', { prefix: 'INV', padTo: '6', seq: '1', date: '2026-08-10' })).status).toBe(403);
  });
});

describe('GET /v1/finance/tax/invoice-check — mandatory Rule 46 fields (A1)', () => {
  const COMPLETE = {
    documentType: 'Tax Invoice', supplierGstin: '29ABCDE1234F1Z5', invoiceNumber: 'INV/2026/000001',
    invoiceDate: '2026-08-10', hsnCode: '1006', taxableMinor: '10000', rateBps: '1800',
    placeOfSupply: 'intra_state', taxComponents: 'CGST,SGST',
  };

  it('passes a complete invoice, names a missing field, and gates on the finance read', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');

    const ok = (await get(h, 'u-owner', '/v1/finance/tax/invoice-check', COMPLETE)).body as { valid: boolean; problems: string[] };
    expect(ok.valid).toBe(true);
    expect(ok.problems).toEqual([]);

    // Drop the GSTIN → invalid, and the problem names it.
    const noGstin = { ...COMPLETE };
    delete (noGstin as Record<string, unknown>).supplierGstin;
    const bad = (await get(h, 'u-owner', '/v1/finance/tax/invoice-check', noGstin)).body as { valid: boolean; problems: string[] };
    expect(bad.valid).toBe(false);
    expect(bad.problems.some((p) => p.startsWith('supplierGstin'))).toBe(true);

    // An intra-State invoice showing IGST is wrong.
    expect(((await get(h, 'u-owner', '/v1/finance/tax/invoice-check', { ...COMPLETE, taxComponents: 'IGST' })).body as { valid: boolean }).valid).toBe(false);

    // The till may not use the back-office calculator.
    expect((await get(h, 'u-cash', '/v1/finance/tax/invoice-check', COMPLETE)).status).toBe(403);
  });
});
