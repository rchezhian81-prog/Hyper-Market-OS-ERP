// Till-side concession tagging — sale AND line-item level (M27 / D-concession, owner decision).
//
// `concession.ts` already models the CONTRACT, the coarse `ConcessionSale`, the period charge and the
// settlement. What it could not do is capture, at the till, the fine-grained truth the owner asked for:
// **which concession/partner, on which counter, under which commission scheme, at which till/shift, sold
// what — line by line — and how the money broke down (gross/discount/tax/net/commission).** This layer is
// that capture, and the rules the owner set around it:
//
//   • A concession tag is taken **from an approved source** by a **cashier** — never invented at the till.
//     `captureConcessionTag` snapshots the commission scheme AS IT STOOD (so a later scheme change never
//     silently re-prices a posted line), computes the commission base and amount in exact integer money,
//     and is **idempotent** on the till's own key (a double-scan or a resend collapses onto one tag).
//   • A posted tag is **never rewritten**. A mistake is corrected by a **reversal** (backs the whole tag
//     out) or an **adjustment** (a compensating delta), each a NEW append-only tag that names the one it
//     corrects — the money-path discipline of the rest of the system (hard rule #2). Correcting is a
//     **supervisor**'s act, not a cashier's (SoD, §28): `mayCorrectConcessionTag` refuses a cashier.
//   • A **return or cancellation** is linked to the sale it reverses, so commission is never taken on money
//     that went back to a customer (the same rule `computePeriodCharge` keeps at the period level).
//   • Every capture and every correction is an **append-only** event on the tag (hard rules #2 #6): who did
//     what, when, from which source — the trail a settlement or an audit reads back.
//   • `concessionTagTotals` folds a set of tags into the per-concession settlement figures (gross / net /
//     commission, net of reversals and returns), so this feeds `computePeriodCharge` / `settleConcession`
//     rather than duplicating them.
//
// Exact integer money throughout (§29.1). Pure and deterministic: the clock is injected, there is no I/O;
// the caller persists the append-only tag stream.

import type { ConcessionChargeBasis } from './concession';

/** What a captured tag IS: a sale line, a return, a cancellation, or a supervisor's correction of one. */
export type ConcessionTagKind = 'sale' | 'return' | 'cancellation' | 'reversal' | 'adjustment';

/** Where a settlement stands for a tag. Set by the settlement run, read here, never guessed. */
export type SettlementStatus = 'pending' | 'included_in_charge' | 'settled';

/** Who is acting. A cashier CAPTURES; correcting a posted tag is a supervisor's act (SoD, §28). */
export type ConcessionActorRole = 'cashier' | 'supervisor' | 'store_manager';

/** Whether commission is taken on gross or on net-of-discount. Snapshotted so it cannot drift. */
export type CommissionBaseKind = 'gross' | 'net';

/**
 * The commission scheme AS IT STOOD when the line was rung, snapshotted onto the tag so a later change to
 * the contract never silently re-prices a posted sale. Mirrors the contract's `basis`.
 */
export interface CommissionSchemeSnapshot {
  readonly contractId: string;
  readonly basis: ConcessionChargeBasis;
  /** Which figure the share is taken on. Default 'gross' — matches `computePeriodCharge`. */
  readonly commissionOn: CommissionBaseKind;
  /** Share in basis points for a `revenue_share` (or `higher_of_both`) scheme, e.g. 1_500 = 15%. */
  readonly revenueShareBps?: number;
}

export type ConcessionTagOp = 'captured' | 'reversed' | 'adjusted' | 'settlement_marked' | 'capture_refused' | 'correct_refused';

export interface ConcessionTagEvent {
  readonly op: ConcessionTagOp;
  readonly at: string;
  readonly by: string;
  readonly byRole: ConcessionActorRole;
  /** The approved source the cashier recorded from (a docket, an app reference), or a correction reason. */
  readonly source?: string;
  readonly reasonCode?: string;
  readonly detail?: string;
}

export interface ConcessionTag {
  readonly tagId: string;
  readonly tenantId: string;
  readonly kind: ConcessionTagKind;
  /** The till transaction and line this tags. A line-item is the unit; a sale groups its lines by saleId. */
  readonly saleId: string;
  readonly lineId: string;
  /** Whose counter it is. */
  readonly concessionaireId: string;
  readonly contractId: string;
  /** The physical counter / partner station. */
  readonly counterId: string;
  /** Store, till and shift context, so a settlement or an audit can place the sale. */
  readonly branchId: string;
  readonly tillId: string;
  readonly shiftId: string;
  /** What was sold. */
  readonly productId: string;
  readonly qty: number;
  /** Money, exact integer minor units. net = gross - discount. */
  readonly grossMinor: number;
  readonly discountMinor: number;
  readonly taxMinor: number;
  readonly netMinor: number;
  /** The scheme snapshot + the commission this line carries under it. */
  readonly scheme: CommissionSchemeSnapshot;
  /** The figure the commission was computed on (gross or net). */
  readonly commissionBaseMinor: number;
  readonly commissionMinor: number;
  /** A return / cancellation / reversal / adjustment names the tag it corrects. */
  readonly correctsTagId?: string;
  readonly settlementStatus: SettlementStatus;
  /** The cashier who captured it and the approved source they recorded from. */
  readonly capturedBy: string;
  readonly source: string;
  /** The till's own idempotency key — a resend or double-scan collapses onto one tag. */
  readonly idempotencyKey: string;
  readonly at: string;
  readonly history: readonly ConcessionTagEvent[];
}

const isRevenueShare = (basis: ConcessionChargeBasis): boolean => basis === 'revenue_share' || basis === 'higher_of_both';

/**
 * Commission for one line under a snapshotted scheme, in exact integer money (BigInt so a busy counter
 * cannot drift by a paisa). Only a revenue-share scheme yields a per-line commission; `fixed_rent` (and
 * the fixed leg of `higher_of_both`) settle at the PERIOD level, so a line carries 0 and settlement
 * decides — never double-counted here.
 */
function commissionFor(scheme: CommissionSchemeSnapshot, grossMinor: number, netMinor: number): { baseMinor: number; commissionMinor: number } {
  const baseMinor = scheme.commissionOn === 'net' ? netMinor : grossMinor;
  if (!isRevenueShare(scheme.basis) || scheme.revenueShareBps === undefined) {
    return { baseMinor, commissionMinor: 0 };
  }
  // Sign-preserving so a return (negative gross) yields a negative commission that backs the sale out.
  const sign = baseMinor < 0 ? -1n : 1n;
  const magnitude = (BigInt(Math.abs(baseMinor)) * BigInt(scheme.revenueShareBps)) / 10_000n;
  return { baseMinor, commissionMinor: Number(sign * magnitude) };
}

/** A cashier (or above) may capture; correcting a posted tag is a supervisor's act, never a cashier's. */
export function mayCorrectConcessionTag(role: ConcessionActorRole): boolean {
  return role !== 'cashier';
}

export interface CaptureInput {
  readonly tenantId: string;
  readonly tagId: string;
  readonly kind: Extract<ConcessionTagKind, 'sale' | 'return' | 'cancellation'>;
  readonly saleId: string;
  readonly lineId: string;
  readonly concessionaireId: string;
  readonly counterId: string;
  readonly branchId: string;
  readonly tillId: string;
  readonly shiftId: string;
  readonly productId: string;
  readonly qty: number;
  readonly grossMinor: number;
  readonly discountMinor: number;
  readonly taxMinor: number;
  readonly scheme: CommissionSchemeSnapshot;
  /** The cashier recording it, and the approved source (docket / app reference) they read it from. */
  readonly capturedBy: string;
  readonly byRole: ConcessionActorRole;
  readonly source: string;
  readonly idempotencyKey: string;
  readonly at: string;
  /** For a return / cancellation, the sale-line tag being reversed. */
  readonly correctsTagId?: string;
}

/**
 * Capture a concession line tag from an approved source.
 *
 * `net = gross - discount`; commission is computed from the snapshotted scheme so a later contract change
 * cannot re-price this line. A return / cancellation carries a NEGATIVE gross (the caller signs it) and
 * names the tag it reverses, so its commission is negative and the settlement nets it out.
 */
export function captureConcessionTag(input: CaptureInput): ConcessionTag {
  const netMinor = input.grossMinor - input.discountMinor;
  const { baseMinor, commissionMinor } = commissionFor(input.scheme, input.grossMinor, netMinor);
  const event: ConcessionTagEvent = {
    op: 'captured', at: input.at, by: input.capturedBy, byRole: input.byRole, source: input.source,
    detail: `${input.kind} of ${input.qty}×${input.productId} for ${input.concessionaireId}`,
  };
  return {
    tagId: input.tagId,
    tenantId: input.tenantId,
    kind: input.kind,
    saleId: input.saleId,
    lineId: input.lineId,
    concessionaireId: input.concessionaireId,
    contractId: input.scheme.contractId,
    counterId: input.counterId,
    branchId: input.branchId,
    tillId: input.tillId,
    shiftId: input.shiftId,
    productId: input.productId,
    qty: input.qty,
    grossMinor: input.grossMinor,
    discountMinor: input.discountMinor,
    taxMinor: input.taxMinor,
    netMinor,
    scheme: input.scheme,
    commissionBaseMinor: baseMinor,
    commissionMinor,
    ...(input.correctsTagId === undefined ? {} : { correctsTagId: input.correctsTagId }),
    settlementStatus: 'pending',
    capturedBy: input.capturedBy,
    source: input.source,
    idempotencyKey: input.idempotencyKey,
    at: input.at,
    history: [event],
  };
}

export type CaptureRefusal = 'not_a_cashier_role' | 'duplicate_idempotency_key';

export interface CaptureResult {
  readonly captured: boolean;
  readonly tag?: ConcessionTag;
  readonly existing?: ConcessionTag;
  readonly refusal?: CaptureRefusal;
}

/**
 * Idempotent capture against the existing tag stream. A resend or double-scan carrying an idempotency key
 * already present returns the ORIGINAL tag unchanged (never a second charge). Any actor role may capture a
 * sale — a cashier is the ordinary case; the role is recorded for the audit.
 */
export function captureConcessionTagIdempotent(input: CaptureInput, existing: readonly ConcessionTag[]): CaptureResult {
  const priorSameTenant = existing.filter((t) => t.tenantId === input.tenantId);
  const dup = priorSameTenant.find((t) => t.idempotencyKey === input.idempotencyKey);
  if (dup !== undefined) return { captured: false, existing: dup, refusal: 'duplicate_idempotency_key' };
  return { captured: true, tag: captureConcessionTag(input) };
}

const append = (tag: ConcessionTag, event: ConcessionTagEvent): ConcessionTag => ({ ...tag, history: [...tag.history, event] });

export type CorrectionRefusal = 'not_permitted_for_role' | 'already_corrected_by_reversal';

export interface CorrectionResult {
  readonly corrected: boolean;
  /** The NEW compensating tag (reversal / adjustment). Never a rewrite of the original. */
  readonly correction?: ConcessionTag;
  /** The original, with the correction recorded in its append-only history. */
  readonly original: ConcessionTag;
  readonly refusal?: CorrectionRefusal;
}

/**
 * Reverse a posted tag — a supervisor's correction that backs the WHOLE line out.
 *
 * It never rewrites the original: it emits a NEW tag of kind `reversal` with every money field negated,
 * naming the tag it corrects, and records the reversal on the original's append-only history. A cashier is
 * refused (SoD, §28); a tag already reversed is refused so a line cannot be backed out twice.
 */
export function reverseConcessionTag(input: {
  readonly original: ConcessionTag;
  readonly newTagId: string;
  readonly by: string;
  readonly byRole: ConcessionActorRole;
  readonly reasonCode: string;
  readonly now: string;
  readonly alreadyReversed?: boolean;
}): CorrectionResult {
  if (!mayCorrectConcessionTag(input.byRole)) {
    return {
      corrected: false,
      refusal: 'not_permitted_for_role',
      original: append(input.original, { op: 'correct_refused', at: input.now, by: input.by, byRole: input.byRole, reasonCode: input.reasonCode, detail: 'a cashier may not correct a posted concession sale (reversal/adjustment is a supervisor act)' }),
    };
  }
  if (input.alreadyReversed === true) {
    return { corrected: false, refusal: 'already_corrected_by_reversal', original: input.original };
  }
  const o = input.original;
  const reversal: ConcessionTag = {
    ...o,
    tagId: input.newTagId,
    kind: 'reversal',
    grossMinor: -o.grossMinor,
    discountMinor: -o.discountMinor,
    taxMinor: -o.taxMinor,
    netMinor: -o.netMinor,
    commissionBaseMinor: -o.commissionBaseMinor,
    commissionMinor: -o.commissionMinor,
    correctsTagId: o.tagId,
    settlementStatus: 'pending',
    capturedBy: input.by,
    source: input.reasonCode,
    idempotencyKey: `${o.idempotencyKey}:reversal`,
    at: input.now,
    history: [{ op: 'captured', at: input.now, by: input.by, byRole: input.byRole, reasonCode: input.reasonCode, detail: `reversal of ${o.tagId}` }],
  };
  return {
    corrected: true,
    correction: reversal,
    original: append(o, { op: 'reversed', at: input.now, by: input.by, byRole: input.byRole, reasonCode: input.reasonCode, detail: `reversed by ${input.newTagId}` }),
  };
}

/**
 * Adjust a posted tag by a compensating DELTA — a supervisor's correction for a wrong amount, discount or
 * tax without backing the whole line out. It emits a NEW tag of kind `adjustment` carrying the deltas
 * (which the caller signs), recomputes commission on the delta under the snapshotted scheme, names the tag
 * it corrects, and records it on the original's history. A cashier is refused (SoD, §28).
 */
export function adjustConcessionTag(input: {
  readonly original: ConcessionTag;
  readonly newTagId: string;
  readonly by: string;
  readonly byRole: ConcessionActorRole;
  readonly grossDeltaMinor: number;
  readonly discountDeltaMinor: number;
  readonly taxDeltaMinor: number;
  readonly reasonCode: string;
  readonly now: string;
}): CorrectionResult {
  if (!mayCorrectConcessionTag(input.byRole)) {
    return {
      corrected: false,
      refusal: 'not_permitted_for_role',
      original: append(input.original, { op: 'correct_refused', at: input.now, by: input.by, byRole: input.byRole, reasonCode: input.reasonCode, detail: 'a cashier may not adjust a posted concession sale (a supervisor act)' }),
    };
  }
  const o = input.original;
  const netDelta = input.grossDeltaMinor - input.discountDeltaMinor;
  const { baseMinor, commissionMinor } = commissionFor(o.scheme, input.grossDeltaMinor, netDelta);
  const adjustment: ConcessionTag = {
    ...o,
    tagId: input.newTagId,
    kind: 'adjustment',
    grossMinor: input.grossDeltaMinor,
    discountMinor: input.discountDeltaMinor,
    taxMinor: input.taxDeltaMinor,
    netMinor: netDelta,
    commissionBaseMinor: baseMinor,
    commissionMinor,
    correctsTagId: o.tagId,
    settlementStatus: 'pending',
    capturedBy: input.by,
    source: input.reasonCode,
    idempotencyKey: `${o.idempotencyKey}:adjust:${input.newTagId}`,
    at: input.now,
    history: [{ op: 'captured', at: input.now, by: input.by, byRole: input.byRole, reasonCode: input.reasonCode, detail: `adjustment of ${o.tagId}` }],
  };
  return {
    corrected: true,
    correction: adjustment,
    original: append(o, { op: 'adjusted', at: input.now, by: input.by, byRole: input.byRole, reasonCode: input.reasonCode, detail: `adjusted by ${input.newTagId} (gross ${input.grossDeltaMinor >= 0 ? '+' : ''}${input.grossDeltaMinor})` }),
  };
}

/** Mark a tag's settlement status (the settlement run sets this; it is never guessed at the till). */
export function markSettlementStatus(tag: ConcessionTag, status: SettlementStatus, by: string, byRole: ConcessionActorRole, now: string): ConcessionTag {
  return append({ ...tag, settlementStatus: status }, { op: 'settlement_marked', at: now, by, byRole, detail: `settlement ${status}` });
}

export interface ConcessionTagTotals {
  readonly concessionaireId: string;
  readonly contractId: string;
  readonly tags: number;
  readonly grossMinor: number;
  readonly discountMinor: number;
  readonly taxMinor: number;
  readonly netMinor: number;
  readonly commissionMinor: number;
  readonly detail: string;
}

/**
 * Fold a set of tags into the per-concession settlement figures, **netting reversals and returns by
 * construction** (they carry negative money). Filters to one tenant, optionally one concessionaire and a
 * capture window, so this feeds `computePeriodCharge` / `settleConcession` rather than duplicating them.
 */
export function concessionTagTotals(input: {
  readonly tags: readonly ConcessionTag[];
  readonly tenantId: string;
  readonly concessionaireId?: string;
  readonly from?: string;
  readonly to?: string;
}): ConcessionTagTotals {
  const window = input.tags.filter(
    (t) =>
      t.tenantId === input.tenantId &&
      (input.concessionaireId === undefined || t.concessionaireId === input.concessionaireId) &&
      (input.from === undefined || t.at >= input.from) &&
      (input.to === undefined || t.at <= `${input.to}T23:59:59.999Z`),
  );
  const sum = (pick: (t: ConcessionTag) => number): number => window.reduce((s, t) => s + pick(t), 0);
  const grossMinor = sum((t) => t.grossMinor);
  const netMinor = sum((t) => t.netMinor);
  const commissionMinor = sum((t) => t.commissionMinor);
  return {
    concessionaireId: input.concessionaireId ?? '(all)',
    contractId: window[0]?.contractId ?? '(none)',
    tags: window.length,
    grossMinor,
    discountMinor: sum((t) => t.discountMinor),
    taxMinor: sum((t) => t.taxMinor),
    netMinor,
    commissionMinor,
    detail: `${window.length} tag(s): ${grossMinor} gross, ${netMinor} net, ${commissionMinor} commission (reversals and returns netted)`,
  };
}
