// Card / UPI / gateway settlement and exception investigation (M14-FR-03 / §6.2).
//
// `packages/reconciliation` (M23-FR-03) answers "does this tender match that credit?".
// This module is the **cash office's day**: getting the provider's file in safely,
// telling apart the two problems that look identical, and making sure the ones that
// matter end up owned by a person with a date against them.
//
// Three things are deliberately separated here, because collapsing them is what makes
// settlement reconciliation useless in practice:
//
//   • **LATE IS NOT LOST.** A card tender with no credit yet is completely normal at
//     T+1 and a serious problem at T+9. A system that reports both as "unsettled"
//     either buries the real one in a hundred normal ones, or trains the cash office
//     to clear the list without reading it. So an unmatched tender is aged against the
//     provider's own settlement cycle, and only becomes an exception once it is late.
//
//   • **FEES ARE NOT SHORTFALLS.** The bank credits the shop **net of the provider's
//     commission**. Reconciling gross tenders against net credits flags every single
//     line as short. So the batch declares its gross, its fees and its net, and the
//     arithmetic `gross − fees = net` is checked **on the provider's own numbers**
//     before anything else happens. If that does not hold, the file is wrong and using
//     it would corrupt the reconciliation — so it is refused, not "handled".
//
//   • **AN EXCEPTION WITHOUT AN OWNER IS A LIST.** Every investigation names a person
//     and a date, closes only with an outcome, and the outcome feeds back to the rules
//     that raised it (M15-FR-04). Evidence is never deleted (hard rule #6).
//
// No card data anywhere — provider tokens and references only (hard rule #3), enforced
// by reusing the same refusal `packages/reconciliation` applies.
//
// Pure and deterministic: the file is passed in, the clock is injected.

import {
  reconcile,
  type PosTender,
  type SettlementLine,
  type ReconException,
} from '../../reconciliation/src/reconciliation';

export interface SettlementBatch {
  readonly batchId: string;
  readonly providerId: string;
  readonly currency: string;
  /** The business date the batch covers. */
  readonly settlementDate: string;
  readonly lines: readonly SettlementLine[];
  /** What the provider says it processed, before its commission. */
  readonly declaredGrossMinor: number;
  /** The provider's commission for the batch. */
  readonly declaredFeesMinor: number;
  /** What the provider says it actually paid into the bank. */
  readonly declaredNetMinor: number;
}

export type BatchRefusal =
  | 'accepted'
  | 'lines_do_not_sum_to_gross'
  | 'gross_minus_fees_is_not_net'
  | 'empty_batch'
  | 'duplicate_batch';

export interface BatchImportResult {
  readonly batchId: string;
  readonly accepted: boolean;
  readonly outcome: BatchRefusal;
  readonly detail: string;
  readonly lineTotalMinor: number;
}

/**
 * Import a provider settlement batch. It must reconcile **to its own declared
 * figures** before it is allowed anywhere near the POS tenders — the same discipline
 * `packages/import` applies to a supplier invoice (M30-FR-03), for the same reason: a
 * file that does not add up will not stop being wrong once it is inside the system.
 */
export function importSettlementBatch(
  batch: SettlementBatch,
  alreadyImportedBatchIds: readonly string[] = [],
): BatchImportResult {
  const lineTotalMinor = batch.lines.reduce((sum, l) => sum + l.amountMinor, 0);
  const base = { batchId: batch.batchId, lineTotalMinor };

  if (alreadyImportedBatchIds.includes(batch.batchId)) {
    return {
      ...base,
      accepted: false,
      outcome: 'duplicate_batch',
      detail: `batch ${batch.batchId} has already been imported — importing it again would double every credit in it`,
    };
  }
  if (batch.lines.length === 0) {
    return { ...base, accepted: false, outcome: 'empty_batch', detail: 'the batch has no lines' };
  }
  if (lineTotalMinor !== batch.declaredGrossMinor) {
    return {
      ...base,
      accepted: false,
      outcome: 'lines_do_not_sum_to_gross',
      detail: `the lines add up to ${lineTotalMinor} but the batch declares ${batch.declaredGrossMinor} — the file is incomplete or corrupt, and reconciling against it would invent differences that are not there`,
    };
  }
  if (batch.declaredGrossMinor - batch.declaredFeesMinor !== batch.declaredNetMinor) {
    return {
      ...base,
      accepted: false,
      outcome: 'gross_minus_fees_is_not_net',
      detail: `${batch.declaredGrossMinor} gross less ${batch.declaredFeesMinor} fees is not ${batch.declaredNetMinor} net — the provider's own arithmetic does not hold, so query it before using the file`,
    };
  }

  return {
    ...base,
    accepted: true,
    outcome: 'accepted',
    detail: `${batch.lines.length} line(s), ${batch.declaredGrossMinor} gross less ${batch.declaredFeesMinor} fees = ${batch.declaredNetMinor} banked`,
  };
}

export type SettlementFinding =
  /** Not settled yet, and not yet late — normal, reported for cash flow only. */
  | 'awaiting_settlement'
  /** Past the provider's cycle with no credit. Now it is a problem. */
  | 'overdue_settlement'
  | 'short_settled'
  | 'over_settled'
  | 'unknown_credit'
  | 'ambiguous_reference';

export interface SettlementException {
  readonly finding: SettlementFinding;
  readonly ref: string;
  readonly tenderId?: string;
  readonly settlementId?: string;
  /** The money at stake. Always present — an unvalued exception never gets prioritised. */
  readonly valueMinor: number;
  readonly ageDays?: number;
  readonly detail: string;
  /** False for `awaiting_settlement`: it is information, not a problem. */
  readonly needsInvestigation: boolean;
}

export interface SettlementReviewInput {
  readonly tenders: readonly (PosTender & { readonly capturedOn: string })[];
  readonly credits: readonly SettlementLine[];
  /** The provider's contracted settlement cycle in days (per-tenant, e.g. T+2). */
  readonly settlementCycleDays: number;
  /** Today, as YYYY-MM-DD. */
  readonly asOf: string;
}

export interface SettlementReview {
  readonly matchedCount: number;
  readonly matchedValueMinor: number;
  readonly exceptions: readonly SettlementException[];
  /** Money that is simply not due yet — reported so the shop can see its cash pipeline. */
  readonly awaitingValueMinor: number;
  /** Money that is genuinely late or wrong. This is the number that matters. */
  readonly atRiskValueMinor: number;
  readonly detail: string;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * Review a day's electronic tenders against what the provider actually paid.
 * Composes the M23-FR-03 matcher, then does the thing the matcher deliberately does
 * not: decide which unmatched lines are **late** and which are merely **not due yet**.
 */
export function reviewSettlement(input: SettlementReviewInput): SettlementReview {
  const result = reconcile(input.tenders, input.credits);
  const tenderById = new Map(input.tenders.map((t) => [t.id, t]));
  const tenderByRef = new Map(input.tenders.map((t) => [t.ref, t]));
  const creditById = new Map(input.credits.map((c) => [c.id, c]));

  const exceptions: SettlementException[] = [];

  for (const e of result.exceptions) {
    exceptions.push(classify(e, tenderById, tenderByRef, creditById, input));
  }

  const matchedValueMinor = result.matched.reduce((s, m) => s + m.amountMinor, 0);
  const awaitingValueMinor = exceptions
    .filter((e) => e.finding === 'awaiting_settlement')
    .reduce((s, e) => s + e.valueMinor, 0);
  const atRiskValueMinor = exceptions
    .filter((e) => e.needsInvestigation)
    .reduce((s, e) => s + Math.abs(e.valueMinor), 0);

  // Worst first: real problems ahead of things that are simply not due yet.
  const rank: Record<SettlementFinding, number> = {
    overdue_settlement: 0,
    short_settled: 1,
    ambiguous_reference: 2,
    over_settled: 3,
    unknown_credit: 4,
    awaiting_settlement: 5,
  };
  exceptions.sort((a, b) => rank[a.finding] - rank[b.finding] || b.valueMinor - a.valueMinor || a.ref.localeCompare(b.ref));

  return {
    matchedCount: result.matched.length,
    matchedValueMinor,
    exceptions,
    awaitingValueMinor,
    atRiskValueMinor,
    detail:
      atRiskValueMinor === 0
        ? `${result.matched.length} settled and matched; ${awaitingValueMinor} not due yet; nothing at risk`
        : `${atRiskValueMinor} at risk across ${exceptions.filter((e) => e.needsInvestigation).length} exception(s); ${awaitingValueMinor} simply not due yet`,
  };
}

function classify(
  e: ReconException,
  tenderById: Map<string, PosTender & { capturedOn: string }>,
  tenderByRef: Map<string, PosTender & { capturedOn: string }>,
  creditById: Map<string, SettlementLine>,
  input: SettlementReviewInput,
): SettlementException {
  if (e.kind === 'unsettled_tender') {
    const tender = e.tenderId === undefined ? undefined : tenderById.get(e.tenderId);
    const ageDays = tender === undefined ? 0 : daysBetween(tender.capturedOn, input.asOf);
    const late = ageDays > input.settlementCycleDays;
    return {
      finding: late ? 'overdue_settlement' : 'awaiting_settlement',
      ref: e.ref,
      ...(e.tenderId === undefined ? {} : { tenderId: e.tenderId }),
      valueMinor: tender?.amountMinor ?? 0,
      ageDays,
      needsInvestigation: late,
      detail: late
        ? `taken ${ageDays} days ago against a T+${input.settlementCycleDays} cycle and still not paid — chase the provider, this money may not arrive on its own`
        : `taken ${ageDays} day(s) ago; the provider settles at T+${input.settlementCycleDays}, so this is not due yet`,
    };
  }

  if (e.kind === 'amount_mismatch') {
    const variance = e.varianceMinor ?? 0;
    const short = variance < 0;
    return {
      finding: short ? 'short_settled' : 'over_settled',
      ref: e.ref,
      ...(e.tenderId === undefined ? {} : { tenderId: e.tenderId }),
      ...(e.settlementId === undefined ? {} : { settlementId: e.settlementId }),
      valueMinor: Math.abs(variance),
      needsInvestigation: true,
      detail: short
        ? `the till took ${e.expectedMinor} and the provider paid ${e.actualMinor} — ${-variance} short. If this is commission it belongs in the batch fee line, not in a per-transaction difference`
        : `the provider paid ${e.actualMinor} against a till figure of ${e.expectedMinor} — ${variance} more than was taken, which is as much of a problem as being short`,
    };
  }

  if (e.kind === 'unknown_settlement') {
    const credit = e.settlementId === undefined ? undefined : creditById.get(e.settlementId);
    return {
      finding: 'unknown_credit',
      ref: e.ref,
      ...(e.settlementId === undefined ? {} : { settlementId: e.settlementId }),
      valueMinor: credit?.amountMinor ?? 0,
      needsInvestigation: true,
      detail: 'money arrived that no till transaction accounts for — an unexplained credit is investigated, never quietly kept',
    };
  }

  const tender = tenderByRef.get(e.ref);
  return {
    finding: 'ambiguous_reference',
    ref: e.ref,
    valueMinor: tender?.amountMinor ?? 0,
    needsInvestigation: true,
    detail: `reference "${e.ref}" appears more than once — nobody can say which credit belongs to which sale until the provider clarifies`,
  };
}

// --- investigation ----------------------------------------------------------------

export type InvestigationState = 'open' | 'resolved';

export type InvestigationOutcome =
  | 'provider_error_recovered'
  | 'provider_fee_not_an_exception'
  | 'till_error'
  | 'timing_only'
  | 'written_off'
  | 'fraud_suspected';

export interface Investigation {
  readonly investigationId: string;
  readonly ref: string;
  readonly finding: SettlementFinding;
  readonly valueMinor: number;
  /** Named person. A role is not an owner (P-03). */
  readonly ownerId: string;
  readonly openedBy: string;
  readonly openedAt: string;
  readonly dueBy: string;
  readonly state: InvestigationState;
  readonly outcome?: InvestigationOutcome;
  readonly outcomeNote?: string;
  readonly resolvedBy?: string;
  readonly resolvedAt?: string;
  /** Evidence references — appended to, never replaced or deleted (hard rule #6). */
  readonly evidenceRefs: readonly string[];
}

export interface OpenInvestigationResult {
  readonly opened: boolean;
  readonly detail: string;
  readonly investigation?: Investigation;
}

/** Open an investigation on a settlement exception. It needs a **named** owner and a date. */
export function openInvestigation(input: {
  readonly investigationId: string;
  readonly exception: SettlementException;
  readonly ownerId: string;
  readonly openedBy: string;
  readonly at: string;
  readonly dueBy: string;
  readonly evidenceRefs?: readonly string[];
}): OpenInvestigationResult {
  if (!input.exception.needsInvestigation) {
    return {
      opened: false,
      detail: 'this is not a problem — it is money that is simply not due yet, and opening a case on it trains people to close cases without reading them',
    };
  }
  if (input.ownerId.trim() === '') {
    return { opened: false, detail: 'an investigation needs a named owner — an exception owned by "the cash office" is owned by nobody' };
  }
  if (input.dueBy < input.at.slice(0, 10)) {
    return { opened: false, detail: `a due date of ${input.dueBy} is already in the past` };
  }

  return {
    opened: true,
    detail: `${input.exception.finding} on ${input.exception.ref} assigned to ${input.ownerId}, due ${input.dueBy}`,
    investigation: {
      investigationId: input.investigationId,
      ref: input.exception.ref,
      finding: input.exception.finding,
      valueMinor: input.exception.valueMinor,
      ownerId: input.ownerId,
      openedBy: input.openedBy,
      openedAt: input.at,
      dueBy: input.dueBy,
      state: 'open',
      evidenceRefs: [...(input.evidenceRefs ?? [])],
    },
  };
}

/** Attach evidence. Append-only: existing references are never replaced or removed. */
export function attachEvidence(investigation: Investigation, ref: string): Investigation {
  if (ref.trim() === '' || investigation.evidenceRefs.includes(ref)) return investigation;
  return { ...investigation, evidenceRefs: [...investigation.evidenceRefs, ref] };
}

export interface ResolveResult {
  readonly resolved: boolean;
  readonly detail: string;
  readonly investigation: Investigation;
  /** What the rules should learn from this — the feedback loop into M15-FR-04. */
  readonly feedback?: string;
}

/**
 * Resolve an investigation. It closes **only with an outcome** — "closed" with no
 * category is how a shop discovers, a year later, that it has been absorbing the same
 * provider error every month and calling it done.
 */
export function resolveInvestigation(input: {
  readonly investigation: Investigation;
  readonly outcome: InvestigationOutcome;
  readonly note: string;
  readonly resolvedBy: string;
  readonly at: string;
}): ResolveResult {
  const inv = input.investigation;
  if (inv.state === 'resolved') {
    return { resolved: false, detail: 'this investigation is already resolved', investigation: inv };
  }
  if (input.note.trim() === '') {
    return { resolved: false, detail: 'an outcome needs a note saying what was actually found', investigation: inv };
  }
  if (input.outcome === 'written_off' && input.resolvedBy === inv.openedBy) {
    // Writing money off is a financial decision, not an administrative one (§28).
    return {
      resolved: false,
      detail: 'writing off a settlement difference needs someone other than the person who raised it',
      investigation: inv,
    };
  }

  const feedback: Record<InvestigationOutcome, string> = {
    provider_error_recovered: 'provider errors recur — count them per provider and raise it at the contract review (M06-FR-03)',
    provider_fee_not_an_exception: 'the fee model is not configured correctly; fix the batch fee handling so this stops appearing as a shortfall',
    till_error: 'a till is producing bad references — check the lane and the terminal pairing (M33)',
    timing_only: 'the configured settlement cycle does not match the provider contract; correct the cycle so normal timing stops raising exceptions',
    written_off: 'a written-off difference is a real loss — it belongs in the finance posting, not in a cleared list (M23)',
    fraud_suspected: 'open a loss-prevention case with the evidence attached (M15-FR-04); do not close this here',
  };

  return {
    resolved: true,
    detail: `resolved by ${input.resolvedBy} as ${input.outcome}: ${input.note}`,
    feedback: feedback[input.outcome],
    investigation: {
      ...inv,
      state: 'resolved',
      outcome: input.outcome,
      outcomeNote: input.note,
      resolvedBy: input.resolvedBy,
      resolvedAt: input.at,
    },
  };
}

export interface AgeingBucket {
  readonly label: string;
  readonly count: number;
  readonly valueMinor: number;
}

/**
 * Ageing of open investigations. The oldest unmatched money is the money least likely
 * ever to arrive, so it is reported by age rather than as one total.
 */
export function ageInvestigations(
  investigations: readonly Investigation[],
  asOf: string,
): readonly AgeingBucket[] {
  const buckets: { label: string; max: number }[] = [
    { label: '0-7 days', max: 7 },
    { label: '8-30 days', max: 30 },
    { label: '31-90 days', max: 90 },
    { label: 'over 90 days', max: Number.POSITIVE_INFINITY },
  ];
  const open = investigations.filter((i) => i.state === 'open');
  return buckets.map(({ label, max }, index) => {
    const min = index === 0 ? -Infinity : (buckets[index - 1]?.max ?? 0);
    const rows = open.filter((i) => {
      const age = daysBetween(i.openedAt.slice(0, 10), asOf);
      return age > min && age <= max;
    });
    return {
      label,
      count: rows.length,
      valueMinor: rows.reduce((s, i) => s + i.valueMinor, 0),
    };
  });
}
