import { describe, it, expect } from 'vitest';
import { bogoTreatment, freeSampleTreatment, voucherTimeOfSupply, InvalidPromoTaxInput } from '../../packages/finance/src/promo-tax';

// Roadmap v2.1 A12 — GST treatment of promotional supplies, per the CBIC clarifications. The point that
// matters most is the OPPOSITE input-tax-credit consequence of a BOGO vs a genuine free sample.

describe('bogoTreatment — A12: BOGO is a single supply, the free unit adds no extra tax (CBIC 92/2019)', () => {
  it('charges GST on the paid consideration only; the free units add nothing and the ITC is not reversed', () => {
    const r = bogoTreatment({ paidUnits: 1, freeUnits: 1, unitConsiderationMinor: 100_00 });
    expect(r.taxableConsiderationMinor).toBe(100_00); // one price, two units
    expect(r.extraTaxableOnFreeUnitsMinor).toBe(0);
    expect(r.itcReversalRequired).toBe(false);
  });

  it('scales to buy-2-get-1', () => {
    const r = bogoTreatment({ paidUnits: 2, freeUnits: 1, unitConsiderationMinor: 50_00 });
    expect(r.taxableConsiderationMinor).toBe(100_00);
  });

  it('rejects nonsense counts', () => {
    expect(() => bogoTreatment({ paidUnits: 0, freeUnits: 1, unitConsiderationMinor: 100 })).toThrow(InvalidPromoTaxInput);
    expect(() => bogoTreatment({ paidUnits: 1, freeUnits: -1, unitConsiderationMinor: 100 })).toThrow(InvalidPromoTaxInput);
  });
});

describe('freeSampleTreatment — A12: a genuine free sample is not a supply but the ITC is reversed (s.17(5)(h))', () => {
  it('reports no output tax, but flags the ITC reversal and states its amount when known', () => {
    const r = freeSampleTreatment({ itcClaimedMinor: 9_00 });
    expect(r.isSupply).toBe(false);
    expect(r.outputTaxMinor).toBe(0);
    expect(r.itcReversalRequired).toBe(true);
    expect(r.itcToReverseMinor).toBe(9_00);
  });

  it('still flags the reversal when the ITC amount is unknown', () => {
    const r = freeSampleTreatment();
    expect(r.itcReversalRequired).toBe(true);
    expect(r.itcToReverseMinor).toBe(0);
  });
});

describe('the BOGO ≠ free-sample distinction (the whole point of A12)', () => {
  it('BOGO keeps the ITC; a free sample reverses it', () => {
    expect(bogoTreatment({ paidUnits: 1, freeUnits: 1, unitConsiderationMinor: 100 }).itcReversalRequired).toBe(false);
    expect(freeSampleTreatment({ itcClaimedMinor: 100 }).itcReversalRequired).toBe(true);
  });
});

describe('voucherTimeOfSupply — A12: time of supply of a voucher (s.12(4))', () => {
  it('is the issue date when the supply is identifiable at issue', () => {
    const r = voucherTimeOfSupply({ supplyIdentifiableAtIssue: true, issueDate: '2026-08-01' });
    expect(r.basis).toBe('issue');
    expect(r.timeOfSupply).toBe('2026-08-01');
  });

  it('is the redemption date when the supply is NOT identifiable at issue', () => {
    const r = voucherTimeOfSupply({ supplyIdentifiableAtIssue: false, issueDate: '2026-08-01', redemptionDate: '2026-09-15' });
    expect(r.basis).toBe('redemption');
    expect(r.timeOfSupply).toBe('2026-09-15');
  });

  it('refuses to time an unidentifiable voucher that has not been redeemed yet (a pending fact, not a guess)', () => {
    expect(() => voucherTimeOfSupply({ supplyIdentifiableAtIssue: false, issueDate: '2026-08-01' })).toThrow(InvalidPromoTaxInput);
  });

  it('rejects a malformed date', () => {
    expect(() => voucherTimeOfSupply({ supplyIdentifiableAtIssue: true, issueDate: 'August' })).toThrow(InvalidPromoTaxInput);
  });
});
