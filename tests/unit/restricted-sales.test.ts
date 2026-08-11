import { describe, it, expect } from 'vitest';
import { checkRestrictedSale, type RestrictedLine } from '../../packages/restricted-sales/src/index';

// B14 (COTPA 2003 s.6/s.7): a tobacco line demands age-18 confirmation and refuses a below-pack quantity.

const tobacco = (o: Partial<RestrictedLine> = {}): RestrictedLine =>
  ({ lineId: 'l1', productId: 'cig-20s', quantityMinor: 1000, uom: 'pack', ageRestricted: true, restrictionKind: 'tobacco', minSaleQuantityMinor: 1000, ...o });
const bread: RestrictedLine = { lineId: 'l2', productId: 'bread', quantityMinor: 1000, uom: 'each' };

describe('restricted-sale gate (B14)', () => {
  it('allows a tobacco pack once age is confirmed 18+', () => {
    const r = checkRestrictedSale({ lines: [tobacco(), bread], ageVerification: { verified: true, ageYears: 25 } });
    expect(r.allowed).toBe(true);
    expect(r.blocks).toHaveLength(0);
  });

  it('blocks a tobacco line when age is not confirmed, and when the customer is under age', () => {
    expect(checkRestrictedSale({ lines: [tobacco()] }).blocks[0]!.reason).toBe('age_not_verified');
    expect(checkRestrictedSale({ lines: [tobacco()], ageVerification: { verified: false } }).blocks[0]!.reason).toBe('age_not_verified');
    expect(checkRestrictedSale({ lines: [tobacco()], ageVerification: { verified: true, ageYears: 16 } }).blocks[0]!.reason).toBe('underage');
  });

  it('refuses a below-pack (loose single-stick) tobacco quantity', () => {
    const r = checkRestrictedSale({ lines: [tobacco({ quantityMinor: 50 })], ageVerification: { verified: true, ageYears: 30 } });
    expect(r.allowed).toBe(false);
    expect(r.blocks.map((b) => b.reason)).toContain('below_pack_minimum');
  });

  it('reports every failing line at once and ignores unrestricted lines', () => {
    const r = checkRestrictedSale({ lines: [tobacco({ lineId: 'a', quantityMinor: 30 }), bread], ageVerification: undefined });
    // The one tobacco line fails BOTH the age gate and the pack minimum; bread is untouched.
    expect(r.blocks.map((b) => b.reason).sort()).toEqual(['age_not_verified', 'below_pack_minimum']);
  });

  it('respects a store’s configured minimum age', () => {
    expect(checkRestrictedSale({ lines: [tobacco()], ageVerification: { verified: true, ageYears: 20 }, minimumAge: 21 }).blocks[0]!.reason).toBe('underage');
  });
});
