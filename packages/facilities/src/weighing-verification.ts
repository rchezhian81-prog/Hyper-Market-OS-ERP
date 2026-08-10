// Verified-scale gate (roadmap v2.1 B6 — Legal Metrology / M12·M34). A weighing instrument used for
// trade must carry a CURRENT verification stamp from Legal Metrology; selling by weight on a scale
// whose stamp has lapsed is an offence, and every weighed price it produces is legally unsound. This
// is a DIFFERENT clock from the asset's maintenance contract (assets.ts tracks AMC/warranty) — a scale
// can be perfectly serviced and still be illegal to trade on because its verification expired.
//
// So this gate answers one question the till asks before it trusts a weight: is this scale's
// verification current as of today? An expired stamp BLOCKS trading on that lane; a stamp nearing
// expiry warns, so the re-verification can be booked before it stops the counter. The scale register
// fields the roadmap names (approval no., capacity, last stamping, re-verification due — B7) travel on
// the record. Pure and deterministic: "today" is passed in, there is no clock.

/** A weighing instrument on the Legal Metrology register (the fields B7 requires). */
export interface WeighingScale {
  readonly assetId: string;
  /** Legal Metrology model-approval number. */
  readonly approvalNo: string;
  /** Maximum capacity in grams. */
  readonly capacityGrams: number;
  /** Date of the last verification stamp (YYYY-MM-DD). */
  readonly lastStampedOn: string;
  /** Date the verification must be renewed by (YYYY-MM-DD). */
  readonly reverificationDueOn: string;
}

export type ScaleVerificationLevel = 'current' | 'due_soon' | 'expired';

export interface ScaleVerificationStatus {
  readonly verificationCurrent: boolean;
  /** True when the scale may not be used for trade — the gate B6 enforces. */
  readonly tradingBlocked: boolean;
  /** Days until re-verification is due; negative once overdue. */
  readonly daysRemaining: number;
  readonly level: ScaleVerificationLevel;
  readonly detail: string;
}

export class InvalidScaleVerification extends Error {
  constructor(detail: string) {
    super(`Cannot assess scale verification: ${detail}`);
    this.name = 'InvalidScaleVerification';
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function assertDate(value: string, label: string): void {
  if (!DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))) {
    throw new InvalidScaleVerification(`${label} "${value}" is not a valid YYYY-MM-DD date`);
  }
}

function daysBetween(from: string, to: string): number {
  return Math.floor((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000);
}

/**
 * Whether a weighing scale's Legal Metrology verification is current as of `asOf` (B6). An expired
 * stamp blocks trading on that lane; within `noticeDays` of expiry it warns but still trades.
 *
 * @throws InvalidScaleVerification on a bad date or a non-positive notice window.
 */
export function weighingScaleVerification(
  scale: { readonly reverificationDueOn: string },
  asOf: string,
  noticeDays = 30,
): ScaleVerificationStatus {
  assertDate(scale.reverificationDueOn, 'reverificationDueOn');
  assertDate(asOf, 'asOf');
  if (!Number.isInteger(noticeDays) || noticeDays < 0) {
    throw new InvalidScaleVerification('noticeDays must be a non-negative whole number of days');
  }

  const daysRemaining = daysBetween(asOf, scale.reverificationDueOn);
  const verificationCurrent = daysRemaining >= 0; // due date is the last valid trading day
  const level: ScaleVerificationLevel = !verificationCurrent ? 'expired' : daysRemaining <= noticeDays ? 'due_soon' : 'current';

  return {
    verificationCurrent,
    tradingBlocked: !verificationCurrent,
    daysRemaining,
    level,
    detail: !verificationCurrent
      ? `verification lapsed ${-daysRemaining} day(s) ago — this scale may not be used for trade until it is re-verified`
      : daysRemaining <= noticeDays
        ? `verification due in ${daysRemaining} day(s) — book re-verification before it stops the counter`
        : `verification current — ${daysRemaining} day(s) remaining`,
  };
}
