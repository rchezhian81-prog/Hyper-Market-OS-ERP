import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Roadmap v2.1 A9 (GST from tax-inclusive MRP) + A8 (place-of-supply split), on the live API. The
// tested `extractInclusiveGst` engine now runs on a real route — GET /v1/finance/tax/from-mrp — so the
// back office computes the tax breakdown ONCE, authoritatively, on the server. Proven here over the real
// pipeline: the paisa-exact reconciliation, the CGST+SGST vs IGST split, the RBAC gate, and refusals.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const fromMrp = (h: ApiHarness, userId: string, q: Record<string, string>) =>
  h.request({ method: 'GET', path: '/v1/finance/tax/from-mrp', userId, tenantId: A, query: q });

interface Breakdown {
  grossMinor: number; taxableMinor: number; totalTaxMinor: number; rateBps: number;
  placeOfSupply: string; reconcilesToGross: boolean;
  components: { component: string; rateBps: number; amountMinor: number }[];
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
