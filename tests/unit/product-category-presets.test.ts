import { describe, it, expect } from 'vitest';
import {
  presetFor,
  presetPolicy,
  CATEGORY_KINDS,
  resolvePolicy,
  categorySaleDecision,
  categoryReturnDecision,
  needsApproval,
} from '../../packages/product/src/index';

describe('category presets (directive categories A–G)', () => {
  it('ships a preset for every recognised kind, each a fresh mutable copy', () => {
    expect(CATEGORY_KINDS.length).toBe(9);
    for (const kind of CATEGORY_KINDS) {
      const a = presetFor(kind);
      const b = presetFor(kind);
      expect(a).toEqual(b);
      expect(a).not.toBe(b); // fresh clone — safe to spread-and-tweak
    }
  });

  it('keeps exactly the controlled/blocked categories off by default', () => {
    const offByDefault = CATEGORY_KINDS.filter((k) => !presetFor(k).enabledByDefault).sort();
    expect(offByDefault).toEqual(['gold_jewellery', 'otc_pharma_lite', 'prescription_blocked']);
  });

  it('A grocery/FMCG sells with no ceremony and is returnable', () => {
    const r = presetFor('grocery_fmcg');
    expect(categorySaleDecision(r).allowed).toBe(true);
    expect(categoryReturnDecision(r, 3).allowed).toBe(true);
  });

  it('B fresh produce is weighed, perishable, priced per weight, not returnable, markdown-approved', () => {
    const r = presetFor('fresh_produce');
    expect(r.quantityMode).toBe('weighed');
    expect(r.valuation).toBe('rate_per_unit_weight');
    expect(r.shelfLife.blockSaleAfterExpiry).toBe(true);
    expect(categorySaleDecision(r, { expired: true }).refusals.map((x) => x.reason)).toContain('expired');
    expect(categoryReturnDecision(r, 0).allowed).toBe(false);
    expect(needsApproval(r, 'markdown')).toBe(true);
  });

  it('C gold is OFF by default, serial + catch-weight + rate-per-gram, KYC & serial at the till, rate override approved, not returnable', () => {
    const r = presetFor('gold_jewellery');
    expect(r.enabledByDefault).toBe(false);
    expect(r.traceability).toBe('serial');
    expect(r.quantityMode).toBe('catch_weight');
    expect(r.valuation).toBe('rate_per_unit_weight');
    expect(needsApproval(r, 'rate_override')).toBe(true);
    // Off until switched on, even with KYC + serial supplied.
    expect(categorySaleDecision(r, { kycOnFile: true, serialCaptured: true }).refusals.map((x) => x.reason)).toContain('category_not_enabled');
    // Switched on but missing KYC → named.
    const on = categorySaleDecision(r, { categoryEnabled: true, serialCaptured: true });
    expect(on.refusals.map((x) => x.reason)).toContain('kyc_required');
    // Switched on with everything → allowed.
    expect(categorySaleDecision(r, { categoryEnabled: true, kycOnFile: true, serialCaptured: true }).allowed).toBe(true);
    expect(categoryReturnDecision(r, 0).allowed).toBe(false);
  });

  it('D OTC pharmacy-lite is OFF by default, batch, and blocks a sale past expiry', () => {
    const r = presetFor('otc_pharma_lite');
    expect(r.enabledByDefault).toBe(false);
    expect(r.traceability).toBe('batch');
    expect(r.shelfLife.blockSaleAfterExpiry).toBe(true);
    expect(categorySaleDecision(r, { categoryEnabled: true, expired: true }).refusals.map((x) => x.reason)).toContain('expired');
  });

  it('D prescription/Schedule-H items are blocked outright, whatever the context', () => {
    const r = presetFor('prescription_blocked');
    const d = categorySaleDecision(r, { categoryEnabled: true, kycOnFile: true, serialCaptured: true, ageConfirmed: true, ageYears: 40 });
    expect(d.allowed).toBe(false);
    expect(d.refusals).toHaveLength(1);
    expect(d.refusals[0]!.reason).toBe('category_blocked');
  });

  it('E cosmetics block past use-before and restrict returns to approval', () => {
    const r = presetFor('cosmetics');
    expect(r.shelfLife.blockSaleAfterExpiry).toBe(true);
    expect(categoryReturnDecision(r, 3)).toMatchObject({ allowed: true, approvalRequired: true });
  });

  it('F electronics require the serial captured at the till', () => {
    const r = presetFor('electronics');
    expect(r.traceability).toBe('serial');
    expect(categorySaleDecision(r, {}).refusals.map((x) => x.reason)).toContain('serial_not_captured');
    expect(categorySaleDecision(r, { serialCaptured: true }).allowed).toBe(true);
  });

  it('G apparel is returnable within a generous window and markdown/exchange approved', () => {
    const r = presetFor('apparel_footwear');
    expect(categoryReturnDecision(r, 10).allowed).toBe(true);
    expect(needsApproval(r, 'markdown')).toBe(true);
    expect(needsApproval(r, 'exchange')).toBe(true);
  });

  it('presetPolicy wraps a preset in an effective-dated policy that resolvePolicy reads', () => {
    const policy = presetPolicy('cat-gold', 'gold_jewellery', '2026-08-01');
    expect(resolvePolicy(policy.history, '2026-07-31')).toBeUndefined(); // before adoption
    expect(resolvePolicy(policy.history, '2026-08-12')?.enabledByDefault).toBe(false);
  });
});
