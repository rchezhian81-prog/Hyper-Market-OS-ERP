import { describe, it, expect } from 'vitest';
import { normaliseMobile, memberRefFor, isMemberRef, pointsEarned, pointsToTakeBack, loyaltyMemberKey } from '../../packages/loyalty/src/index';

// PF-09-a: the earn rule and the member code, pure (OB-28 "C and 1").
const KEY = loyaltyMemberKey('k'.repeat(48));

describe('a mobile number becomes a member code, never stored as itself', () => {
  it('accepts a number as people write it, and refuses what is not a 10-digit Indian mobile', () => {
    for (const raw of ['9840012345', '98400 12345', '+91 98400-12345', '919840012345', '09840012345']) expect(normaliseMobile(raw)).toBe('9840012345');
    for (const raw of ['12345', '5840012345', '98400123456', 'abc', '']) expect(normaliseMobile(raw)).toBeUndefined();
  });

  it('the same number always gives the same code; a different number or key gives another; the code holds no digits of the number', () => {
    const a = memberRefFor(KEY, '98400 12345')!;
    expect(isMemberRef(a)).toBe(true);
    expect(memberRefFor(KEY, '+919840012345')).toBe(a);
    expect(memberRefFor(KEY, '9840012346')).not.toBe(a);
    expect(memberRefFor(loyaltyMemberKey('j'.repeat(48)), '9840012345')).not.toBe(a);
    expect(a).not.toContain('9840012345');
    expect(isMemberRef('9840012345')).toBe(false);
    expect(memberRefFor(KEY, 'not a number')).toBeUndefined();
  });
});

describe('points earned and taken back', () => {
  it('earns whole points at the owner\'s rate, and nothing when the rule is not set', () => {
    expect(pointsEarned(125_000, 1)).toBe(12);
    expect(pointsEarned(125_000, 2)).toBe(25);
    expect(pointsEarned(9_999, 1)).toBe(0);
    expect(pointsEarned(125_000, 0)).toBe(0);
  });

  it('takes back in proportion to everything refunded so far, never more than was earned', () => {
    const base = { earned: 12, saleTotalMinor: 125_000 };
    expect(pointsToTakeBack({ ...base, priorRefundMinor: 0, priorTakenBack: 0, refundMinor: 25_000 })).toBe(2);
    expect(pointsToTakeBack({ ...base, priorRefundMinor: 25_000, priorTakenBack: 2, refundMinor: 50_000 })).toBe(5);
    expect(pointsToTakeBack({ ...base, priorRefundMinor: 75_000, priorTakenBack: 7, refundMinor: 50_000 })).toBe(5);
    // Five ₹250 returns one by one take back exactly what one whole return would.
    let taken = 0;
    for (let i = 0; i < 5; i += 1) taken += pointsToTakeBack({ ...base, priorRefundMinor: i * 25_000, priorTakenBack: taken, refundMinor: 25_000 });
    expect(taken).toBe(12);
    expect(pointsToTakeBack({ ...base, priorRefundMinor: 0, priorTakenBack: 0, refundMinor: 999_999 })).toBe(12);
    expect(pointsToTakeBack({ earned: 0, saleTotalMinor: 125_000, priorRefundMinor: 0, priorTakenBack: 0, refundMinor: 25_000 })).toBe(0);
  });
});
