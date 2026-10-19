// MG-10 — the daily reconciler SIGNS a parallel-run day (§34.1 "daily parallel controls", G10, R-05).
//
// `compareParallelDay` raises a difference for every area where the two systems disagree by more than the day's
// tolerance — that is what makes a difference MATERIAL here: within tolerance it is never raised at all. Until now a
// day was compared and its differences owned, but nothing let a person put their name to the day as a whole, and
// so nothing could refuse a signature over a day that still carried a difference nobody had explained.
//
// The rule, and the only rule: **a day cannot be signed while one of its material differences is unexplained.**
// Unexplained means not resolved (no explanation recorded), or "explained" in words that say nothing — the same
// test the verification page applies to an acceptance (`looksLikeNoReason`), and `ownDifference` already refuses
// "the new system is probably right" (hard rule #10). Every refused signature names each difference that stopped it.
//
// A signature belongs to the figures it was given over (`dayDigest`): a day recorded again later with different
// figures is a different day, and the old signature no longer applies to it — it stays in the ledger as history.
//
// Pure and deterministic.

import type { DayComparison, ParallelDifference } from './cutover';
import { looksLikeNoReason } from './verification-report';

export interface ParallelDaySignature {
  readonly businessDate: string;
  /** The figures signed over — a digest of the day's comparisons as recorded. */
  readonly dayDigest: string;
  readonly signedBy: string;
  readonly signedAt: string;
  readonly statement: string;
  /** Each difference on the day as it stood when signed — its name, amount and explanation, for the sheet. */
  readonly differences: readonly { readonly differenceId: string; readonly area: string; readonly difference: number; readonly explanation: string; readonly wrongSide?: string; readonly ownerUserId: string }[];
}

export type DaySignRefusal =
  | 'nobody_named'
  | 'day_not_recorded'
  | 'not_the_named_reconciler'
  | 'unexplained_material_difference'
  | 'statement_says_nothing';

export type DaySignResult =
  | { readonly ok: true; readonly signature: ParallelDaySignature; readonly detail: string }
  | { readonly ok: false; readonly refusedBecause: DaySignRefusal; readonly detail: string; readonly unexplained: readonly ParallelDifference[] };

/** A stable digest of a day's comparisons (order-independent), so a signature is bound to the figures it saw. */
export function dayDigestOf(comparisons: readonly DayComparison[]): string {
  const material = [...comparisons]
    .map((c) => `${c.area}:${c.legacyValue}:${c.newValue}:${c.toleranceMinor}`)
    .sort()
    .join('|');
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < material.length; i += 1) {
    const c = material.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return `day-${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

/** The differences on this date that stop a signature: not resolved, or "explained" in words that say nothing. */
export function unexplainedDifferences(businessDate: string, differences: readonly ParallelDifference[]): readonly ParallelDifference[] {
  return differences.filter((d) => d.businessDate === businessDate
    && (d.status !== 'resolved' || d.explanation === undefined || looksLikeNoReason(d.explanation)));
}

export function signParallelDay(input: {
  readonly businessDate: string;
  /** The day as recorded — its comparisons. Absent: the day was never recorded, so there is nothing to sign. */
  readonly comparisons: readonly DayComparison[] | undefined;
  readonly differences: readonly ParallelDifference[];
  readonly signedBy: string;
  readonly statement: string;
  readonly now: string;
  /** The ONE person the owner named to reconcile daily (R-05) — and the owner may sign too. */
  readonly reconcilerUserId: string;
  readonly ownerUserId: string | undefined;
}): DaySignResult {
  const refuse = (refusedBecause: DaySignRefusal, detail: string, unexplained: readonly ParallelDifference[] = []): DaySignResult =>
    ({ ok: false, refusedBecause, detail, unexplained });
  if (input.signedBy.trim() === '') return refuse('nobody_named', 'a day signed by nobody is a day nobody checked');
  if (input.comparisons === undefined || input.comparisons.length === 0) {
    return refuse('day_not_recorded', `${input.businessDate} has no recorded figures — enter the old system's totals beside the new system's first`);
  }
  if (input.signedBy !== input.reconcilerUserId && input.signedBy !== input.ownerUserId) {
    return refuse('not_the_named_reconciler', `${input.reconcilerUserId} is the person named to reconcile daily (R-05); ${input.signedBy} is not, and is not the owner`);
  }
  const unexplained = unexplainedDifferences(input.businessDate, input.differences);
  if (unexplained.length > 0) {
    return refuse('unexplained_material_difference',
      `${input.businessDate} cannot be signed: ${unexplained.length} difference(s) beyond tolerance still have no reason — ${unexplained.map((d) => `${d.differenceId} (${d.area.replace(/_/g, ' ')}, ${d.difference})`).join(', ')}. Find out why the two systems differ, write it on each one, then sign.`,
      unexplained);
  }
  if (looksLikeNoReason(input.statement)) {
    return refuse('statement_says_nothing', 'say in your own words what you checked (at least 20 characters) — "ok" is not a record anybody can read a year from now');
  }
  const todays = input.differences.filter((d) => d.businessDate === input.businessDate);
  return {
    ok: true,
    signature: {
      businessDate: input.businessDate,
      dayDigest: dayDigestOf(input.comparisons),
      signedBy: input.signedBy,
      signedAt: input.now,
      statement: input.statement.trim(),
      differences: todays.map((d) => ({
        differenceId: d.differenceId, area: d.area, difference: d.difference, explanation: d.explanation!, ownerUserId: d.ownerUserId!,
        ...(d.wrongSide === undefined ? {} : { wrongSide: d.wrongSide }),
      })),
    },
    detail: todays.length === 0
      ? `${input.businessDate} signed by ${input.signedBy}: both systems agree in every area`
      : `${input.businessDate} signed by ${input.signedBy}: ${todays.length} difference(s), each explained`,
  };
}

/** Is this signature still over the day as it is now recorded? A re-recorded day is a different day. */
export function signatureStillApplies(signature: ParallelDaySignature, comparisons: readonly DayComparison[] | undefined): boolean {
  return comparisons !== undefined && signature.dayDigest === dayDigestOf(comparisons);
}
