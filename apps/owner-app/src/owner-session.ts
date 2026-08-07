// The owner's command centre (docs/design/screens/owner-command-centre.md · M29 · D13 · M02 · M15
// · A01 read-only). `brief.ts` already builds the day's numbers, the three things needing
// attention and the grouped alerts; this is everything around it that makes the brief something a
// person can *act* on from a phone in another town.
//
// ── The decision this file exists to hold ───────────────────────────────────
//
// **The owner is remote, and every number on this screen is historical by construction.** It is
// last-synced data (§31) — the store may have been trading for eleven hours since it left. That is
// fine for reading the day. It is not fine for approving a ₹8 lakh purchase order, and the
// difference between those two uses of the same screen is the whole design here.
//
// So a decision carries the ground it was made on. `decide()` records the data's freshness state
// and age **into the decision itself**, and when the data is not fresh the screen must pass an
// explicit acknowledgement — one deliberate act, with the age in front of the owner — before the
// decision is accepted. Not a block: an owner who cannot approve anything while travelling is an
// owner who will start telephoning instructions instead, and a telephoned approval has no audit
// trail at all. But never a silent one either.
//
// **One thing genuinely is blocked:** deciding when nothing has ever synced. `missing` is not old
// data, it is *no* data — there is no basis for a decision, and an acknowledgement of nothing is
// not informed consent.
//
// ── The second decision: a queued approval can go out of date ───────────────
//
// A decision made on a phone with no signal is queued, and while it sits there the request it
// answers can change or be withdrawn — the §31.1 case the spec names. When fresh data arrives,
// `reconcileQueued` compares each queued decision against the request as it now stands and reports
// the ones that no longer match. **They are never silently dropped and never silently sent**: they
// come back to the owner as something to look at again, because a ₹40,000 approval that quietly
// applied to a ₹90,000 request is exactly the failure a maker-checker exists to prevent.
//
// ── And a smaller one that matters on a phone ───────────────────────────────
//
// Every KPI drills to the sale facts behind it (M29-FR-02, QG-02 "any KPI drills to its source in
// ≤3 taps"), and the drill is computed from the same facts the KPI was, so the total of the drill
// is the KPI. A drill-through that shows a *sample* of the transactions is how a figure and its
// evidence come to disagree.

import { decide as decideRequest, type ApprovalRequest, type Approver, type Decision, type DecidedRequest } from '../../../packages/approvals/src/approvals';
import { isValidReasonFor } from '../../../packages/approvals/src/reasons';
import type { Freshness, FreshnessState, SaleFact } from '../../../packages/reporting/src/index';
import { buildBrief, type BuildBriefInput, type OwnerBrief, type PendingApproval } from './brief';

// ── What the phone was last told ────────────────────────────────────────────

/**
 * One branch's last-synced payload.
 *
 * Multi-branch is not a future feature to bolt on (OB-05): this product is sold to whoever buys it
 * and the second store is a row, not a rewrite. A branch is therefore the unit of everything here
 * — of freshness, of the brief, and of the approvals routed to it.
 */
export interface BranchPayload {
  readonly branchId: string;
  readonly name: string;
  /** When this branch's data last reached the cloud; null if it never has. */
  readonly lastSyncedAt: string | null;
  readonly sales: readonly SaleFact[];
  readonly exceptions: BuildBriefInput['exceptions'];
  readonly approvals: readonly PendingApproval[];
}

export interface OwnerConfig {
  /** The owner, as the approval engine sees them: who, where, and up to what value. */
  readonly owner: Approver;
  /** Seconds after which a branch's data counts as stale. Per-tenant. */
  readonly staleAfterSeconds: number;
  /**
   * Whether a decision on stale data needs an explicit acknowledgement.
   *
   * Choose-able per tenant, and defaulted on. A shop whose owner sits in the office all day may
   * reasonably turn it off; a chain whose owner approves from three hours away should not.
   */
  readonly acknowledgeStaleDecisions: boolean;
}

/** The clock, injected — the brief is pure, and so is everything that reads it. */
export type Now = () => string;

// ── A decision, and the ground it was made on ───────────────────────────────

/**
 * A decision the owner made, with the state of the data underneath it.
 *
 * `freshnessAtDecision` and `dataAgeSeconds` are not diagnostics. They are part of the decision:
 * *approved, on data that was eleven hours old, and he was told so* is a different fact from
 * *approved*, and only one of them can be defended afterwards.
 */
export interface OwnerDecision {
  readonly request: DecidedRequest;
  readonly branchId: string;
  readonly freshnessAtDecision: FreshnessState;
  readonly dataAgeSeconds: number | null;
  /** True when the owner was shown the staleness and acted anyway. */
  readonly acknowledgedStale: boolean;
  /**
   * What the request looked like when the owner decided it.
   *
   * Compared against the request as it later stands, so a queued decision that no longer answers
   * the same question can be caught rather than applied (§31.1).
   */
  readonly fingerprint: string;
}

export type DecideRefusal =
  /** No pending request with that id on this branch — a stale screen, not a rule breach. */
  | 'request_not_found'
  /** A reason outside the catalogue for this decision. Refused rather than recorded. */
  | 'unknown_reason_code'
  /** The data is stale and the owner has not been shown that it is. */
  | 'stale_data_not_acknowledged'
  /** Nothing has ever synced from this branch. There is no basis for a decision at all. */
  | 'no_data_at_all'
  /** §28: the owner cannot decide a request they made themselves. */
  | 'self_approval_forbidden'
  /** Every decision carries a reason (audit). */
  | 'reason_required'
  /** The owner has no authority in this branch. */
  | 'out_of_scope'
  /** Above the owner's own approval limit — rare, but a limit that cannot bind is not a limit. */
  | 'exceeds_authority';

/** The full refusal vocabulary the screen must have words for, in every language it offers. */
export const OWNER_DECIDE_REFUSALS: readonly DecideRefusal[] = Object.freeze([
  'request_not_found',
  'unknown_reason_code',
  'stale_data_not_acknowledged',
  'no_data_at_all',
  'self_approval_forbidden',
  'reason_required',
  'out_of_scope',
  'exceeds_authority',
]);

export type OwnerDecisionOutcome =
  | { readonly ok: true; readonly decision: OwnerDecision; readonly queuedCount: number }
  | { readonly ok: false; readonly refusal: DecideRefusal };

/**
 * The ASCII unit separator. Not a character that appears in a subject, a reference or a user id,
 * which is the only reason a fingerprint built by joining is safe to compare at all.
 */
const PART = '\u001f';

/**
 * What the request was, reduced to the parts a decision actually answers.
 *
 * Subject, requester and **value** — because the question *"do you approve ₹40,000 of this?"* and
 * the question *"do you approve ₹90,000 of this?"* are different questions with the same id.
 *
 * Joined on a separator rather than run together, because this fingerprint is a control and a
 * control that can collide is not one: `('ab','c')` and `('a','bc')` are different requests, and
 * plain concatenation says they are the same. A part carrying the separator itself is refused
 * rather than escaped — there is no legitimate reason for one to, and quietly mangling it would
 * put the collision straight back.
 */
export function fingerprintOf(request: Pick<PendingApproval, 'subjectType' | 'subjectRef' | 'requestedBy' | 'valueMinor'>): string {
  const parts = [request.subjectType, request.subjectRef, request.requestedBy, String(request.valueMinor ?? 'none')];
  for (const part of parts) {
    if (part.includes(PART)) {
      throw new RangeError('An approval field may not contain a unit separator.');
    }
  }
  return parts.join(PART);
}

// ── Queued decisions that went out of date ──────────────────────────────────

export type StaleDecisionReason =
  /** The request changed — most importantly, its value — while the decision sat in the queue. */
  | 'request_changed'
  /** The request is gone: withdrawn, or already decided by somebody else. */
  | 'request_withdrawn';

export interface StaleQueuedDecision {
  readonly decision: OwnerDecision;
  readonly reason: StaleDecisionReason;
  /** The request as it now stands, when it still exists. */
  readonly nowIs: PendingApproval | null;
}

export interface QueueReconciliation {
  /** Decisions that still answer the same question and may go as they are. */
  readonly stillValid: readonly OwnerDecision[];
  /** Decisions that no longer do. Never dropped, never sent — shown to the owner again. */
  readonly needsAnotherLook: readonly StaleQueuedDecision[];
}

// ── Drill-through ───────────────────────────────────────────────────────────

/** The KPIs a figure on the brief can be drilled into (M29-FR-02). */
export const DRILLABLE_KPIS = Object.freeze([
  'grossSales',
  'margin',
  'baskets',
  'averageBasket',
] as const);

export type DrillableKpi = (typeof DRILLABLE_KPIS)[number];

export interface DrillLine {
  readonly saleId: string;
  /** The figure this sale contributed to the KPI being drilled, in minor units. */
  readonly contributesMinor: number;
  readonly tender: string;
  readonly units: number;
}

export interface Drill {
  readonly kpi: DrillableKpi;
  /** Every sale behind the figure, largest contribution first — never a sample. */
  readonly lines: readonly DrillLine[];
  /**
   * The sum of the lines.
   *
   * Checked against the KPI by a test rather than asserted here, because a drill-through whose
   * total differs from the figure it drills is a reporting system nobody will trust again.
   */
  readonly totalMinor: number;
  /** For `baskets`, the count is the answer and the total is meaningless — this says which. */
  readonly countIsTheAnswer: boolean;
}

// ── The session ─────────────────────────────────────────────────────────────

export interface BranchFreshness {
  readonly branchId: string;
  readonly name: string;
  readonly freshness: Freshness;
}

export interface OwnerSession {
  /** Every branch the owner can look at, with how current each one's data is. */
  branches(): readonly BranchFreshness[];
  /** The branch currently being viewed. */
  currentBranchId(): string;
  /** Switch branch (≤2 taps in the spec). Unknown ids are refused rather than blanking the screen. */
  viewBranch(branchId: string): boolean;
  /** The brief for the branch in view — deterministic, and it renders with the AI off. */
  brief(): OwnerBrief;
  /** Every sale behind a figure on the brief (M29-FR-02). */
  drill(kpi: DrillableKpi): Drill;
  /** Decide an approval. Records the freshness of the ground it was decided on. */
  decide(input: {
    readonly requestId: string;
    readonly decision: Decision;
    readonly reasonCode: string;
    /** True when the owner has been shown the data is stale and has chosen to go ahead. */
    readonly acknowledgeStale?: boolean;
  }): OwnerDecisionOutcome;
  /** Decisions made and not yet sent — the owner's own unsent count (§31). */
  queued(): readonly OwnerDecision[];
  /** Check the queue against fresh data. Nothing is dropped and nothing is silently sent. */
  reconcileQueued(): QueueReconciliation;
  /** Drop a queued decision the owner has looked at again — after it was shown, never before. */
  discardQueued(requestId: string): boolean;
}

export class UnknownBranchError extends Error {
  constructor(branchId: string) {
    super(`No branch "${branchId}" in this payload.`);
    this.name = 'UnknownBranchError';
  }
}

/** How each drillable KPI is built from one sale. One definition, used by the KPI and the drill. */
const CONTRIBUTION: Readonly<Record<DrillableKpi, (sale: SaleFact) => number>> = Object.freeze({
  grossSales: (s) => s.totalMinor,
  margin: (s) => s.netMinor - s.cogsMinor,
  baskets: (s) => s.totalMinor, // the count is the answer; the value is what a basket was worth
  averageBasket: (s) => s.totalMinor,
});

export function createOwnerSession(
  config: OwnerConfig,
  /** Every branch's last-synced payload. Empty is a legitimate state and is reported as such. */
  payloads: readonly BranchPayload[],
  now: Now,
  /**
   * Decisions made earlier and not yet sent.
   *
   * The queue is an **input**, not just internal state, because on a phone it outlives the screen:
   * the owner approves three things on a train, the app is killed, new data arrives, and the
   * session is rebuilt. If the queue lived only inside the session those three decisions would be
   * gone — silently, which is the worst way for an approval to disappear. Handing it back in is
   * also what makes `reconcileQueued` mean anything: it compares yesterday's answers against
   * today's questions.
   */
  alreadyQueued: readonly OwnerDecision[] = [],
): OwnerSession {
  if (payloads.length === 0) {
    throw new RangeError('An owner session needs at least one branch payload.');
  }
  let current = payloads[0]!.branchId;
  const queue = new Map<string, OwnerDecision>(alreadyQueued.map((d) => [d.request.id, d]));

  const payloadFor = (branchId: string): BranchPayload => {
    const found = payloads.find((p) => p.branchId === branchId);
    if (found === undefined) throw new UnknownBranchError(branchId);
    return found;
  };

  const briefFor = (branchId: string): OwnerBrief => {
    const payload = payloadFor(branchId);
    return buildBrief({
      asOf: now(),
      lastSyncedAt: payload.lastSyncedAt,
      staleAfterSeconds: config.staleAfterSeconds,
      sales: payload.sales,
      exceptions: payload.exceptions,
      // A request the owner has already decided is not still waiting on them. Leaving it in the
      // inbox is how the same purchase order gets approved twice from a phone with no signal.
      approvals: payload.approvals.filter((a) => !queue.has(a.id)),
    });
  };

  return {
    branches: () => payloads.map((payload) => ({
      branchId: payload.branchId,
      name: payload.name,
      freshness: briefFor(payload.branchId).freshness,
    })),

    currentBranchId: () => current,

    viewBranch: (branchId) => {
      // An unknown branch leaves the screen where it is. Blanking it would look like a branch with
      // no sales, which is a very different thing from a branch that is not there.
      if (!payloads.some((p) => p.branchId === branchId)) return false;
      current = branchId;
      return true;
    },

    brief: () => briefFor(current),

    drill: (kpi) => {
      const sales = payloadFor(current).sales;
      const contribution = CONTRIBUTION[kpi];
      const lines = sales
        .map((sale) => ({
          saleId: sale.saleId,
          contributesMinor: contribution(sale),
          tender: sale.tender,
          units: sale.units,
        }))
        .sort((a, b) => b.contributesMinor - a.contributesMinor);
      return {
        kpi,
        lines,
        totalMinor: lines.reduce((sum, line) => sum + line.contributesMinor, 0),
        countIsTheAnswer: kpi === 'baskets',
      };
    },

    decide: (input) => {
      const payload = payloadFor(current);
      const pending = payload.approvals.find((a) => a.id === input.requestId);
      if (pending === undefined || queue.has(input.requestId)) {
        return { ok: false, refusal: 'request_not_found' };
      }
      if (!isValidReasonFor(input.decision, input.reasonCode)) {
        return { ok: false, refusal: 'unknown_reason_code' };
      }

      // The ground first, before any rule about the request itself: there is no point checking an
      // approval limit against a value that may have moved twice since it left the store.
      const dataFreshness = briefFor(current).freshness;
      if (dataFreshness.state === 'missing') {
        // Not old data — *no* data. An acknowledgement of nothing is not informed consent.
        return { ok: false, refusal: 'no_data_at_all' };
      }
      const stale = dataFreshness.state === 'stale';
      if (stale && config.acknowledgeStaleDecisions && input.acknowledgeStale !== true) {
        return { ok: false, refusal: 'stale_data_not_acknowledged' };
      }

      const request: ApprovalRequest = {
        id: pending.id,
        subjectType: pending.subjectType,
        subjectRef: pending.subjectRef,
        requestedBy: pending.requestedBy,
        branchId: payload.branchId,
        value: pending.valueMinor === null ? null : { minor: pending.valueMinor, currency: 'INR' },
        status: 'pending',
      };
      // §28 and the value limit stay with the engine. The owner is an approver like any other, and
      // a surface that decided for itself which rules applied to the owner would be the one place
      // separation of duties quietly stopped applying.
      const outcome = decideRequest(request, config.owner, input.decision, input.reasonCode, now());
      if (!outcome.ok) return { ok: false, refusal: outcome.refusal };

      const decision: OwnerDecision = Object.freeze({
        request: outcome.request,
        branchId: payload.branchId,
        freshnessAtDecision: dataFreshness.state,
        dataAgeSeconds: dataFreshness.ageSeconds,
        acknowledgedStale: stale,
        fingerprint: fingerprintOf(pending),
      });
      queue.set(pending.id, decision);
      return { ok: true, decision, queuedCount: queue.size };
    },

    queued: () => [...queue.values()],

    reconcileQueued: () => {
      const stillValid: OwnerDecision[] = [];
      const needsAnotherLook: StaleQueuedDecision[] = [];
      for (const decision of queue.values()) {
        const payload = payloads.find((p) => p.branchId === decision.branchId);
        const nowIs = payload?.approvals.find((a) => a.id === decision.request.id) ?? null;
        if (nowIs === null) {
          // Withdrawn, or somebody else decided it. Either way this decision answers a question
          // nobody is asking any more, and sending it would be a decision about nothing.
          needsAnotherLook.push({ decision, reason: 'request_withdrawn', nowIs: null });
          continue;
        }
        if (fingerprintOf(nowIs) !== decision.fingerprint) {
          // The question changed underneath the answer — the §31.1 case. A ₹40,000 approval that
          // quietly applied to a ₹90,000 request is the exact failure maker-checker exists to stop.
          needsAnotherLook.push({ decision, reason: 'request_changed', nowIs });
          continue;
        }
        stillValid.push(decision);
      }
      return { stillValid, needsAnotherLook };
    },

    discardQueued: (requestId) => queue.delete(requestId),
  };
}
