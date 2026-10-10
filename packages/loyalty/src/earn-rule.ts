// The loyalty earn rule and the member code (Wave 5 · PF-09-a, owner decisions OB-28 "C and 1" and OB-29 "A",
// M17-FR-01, M16-FR-01, P-04). Pure and deterministic — no clock, no store.
//
//   • THE RULE IS THE OWNER'S (OB-28 "C"). Points per ₹100 is a tenant setting; until the owner sets it, nothing is
//     earned and the screens say so. This file never assumes a rate.
//   • A MEMBER IS A CODE, NOT A PHONE NUMBER (OB-28 "1", P-04 / DPDP). The cashier keys a mobile number; the store
//     computer turns it into a keyed code before the sale is saved, and head office's member list keeps the code and the
//     last four digits only. A sale record is append-only and kept for years — a phone number written there could never
//     be erased. The code alone, without the key, names nobody; a member who leaves stops earning on it.
//   • A RETURN TAKES BACK WHAT THE SALE EARNED, IN PROPORTION (M17-FR-01 "a reversal is a compensating entry"). Worked
//     on the cumulative refund, so three part-returns never take back more — or less — than one whole return would.

import { createHmac } from 'node:crypto';
import { normaliseMobile } from './mobile';

export { normaliseMobile } from './mobile';

const MEMBER_LABEL = 'sre/loyalty-member/v1';

/** The key a store computer and head office both derive the member code with — from the pack signing key they share. */
export function loyaltyMemberKey(packSigningKey: string): Buffer {
  if (packSigningKey.length < 32) throw new RangeError('the loyalty member key needs the full pack signing key');
  return createHmac('sha256', packSigningKey).update(MEMBER_LABEL, 'utf8').digest();
}

/** The member code for a mobile number: `m-` and 24 hex characters of a keyed hash. Undefined for a non-number. */
export function memberRefFor(key: Buffer, rawMobile: string): string | undefined {
  const mobile = normaliseMobile(rawMobile);
  if (mobile === undefined) return undefined;
  return `m-${createHmac('sha256', key).update(mobile, 'utf8').digest('hex').slice(0, 24)}`;
}

/** Whether a string has the shape of a member code — what head office accepts on a sale, never a phone number. */
export const isMemberRef = (s: unknown): s is string => typeof s === 'string' && /^m-[0-9a-f]{24}$/.test(s);

/** Points a sale earns: whole points only, rounded down, at the owner's points-per-₹100. Zero when the rule is not set. */
export function pointsEarned(saleTotalMinor: number, pointsPer100Inr: number): number {
  if (!Number.isFinite(pointsPer100Inr) || pointsPer100Inr <= 0 || !Number.isInteger(saleTotalMinor) || saleTotalMinor <= 0) return 0;
  return Math.floor((saleTotalMinor * pointsPer100Inr) / 10_000);
}

/**
 * How many points this return takes back. `earned` is what the sale earned; `priorRefundMinor` and `priorTakenBack` are
 * the refunds and take-backs already recorded against it. The target is the earned points in proportion to everything
 * refunded so far (rounded down), and this return takes the difference — never negative, never past `earned`.
 */
export function pointsToTakeBack(input: {
  readonly earned: number;
  readonly saleTotalMinor: number;
  readonly priorRefundMinor: number;
  readonly priorTakenBack: number;
  readonly refundMinor: number;
}): number {
  if (input.earned <= 0 || input.saleTotalMinor <= 0 || input.refundMinor <= 0) return 0;
  const refunded = Math.min(input.saleTotalMinor, input.priorRefundMinor + input.refundMinor);
  const target = Math.min(input.earned, Math.floor((input.earned * refunded) / input.saleTotalMinor));
  return Math.max(0, target - input.priorTakenBack);
}
