// Payroll — the pay-run lifecycle (WP3 inc4). A pay run moves money to real people, so it is the part of
// payroll that most needs a spine of controls: one person prepares it, a DIFFERENT person approves it, and
// once it is locked it is FINAL — a mistake found afterwards is fixed by a visible reversal and a fresh
// run, never by a silent rewrite. That is the owner's rule ("correction by reversal/adjustment, never
// silent rewriting") and separation of duties (§28), made into a small state machine.
//
// States: draft → submitted → approved → locked, plus reversed (a correction after lock). The one control
// that matters above all: **the approver may not be the submitter** (maker ≠ checker). It is enforced in
// BOTH the transition guard (before an action is taken) and the event fold (so a hand-crafted event stream
// cannot self-approve). Append-only and event-sourced — the same shape as the e-invoice / e-way-bill folds.
// Pure and deterministic — no clock, no I/O; the caller stamps the time and commits.

export type PayRunState = 'draft' | 'submitted' | 'approved' | 'locked' | 'reversed';
export type PayRunAction = 'submit' | 'approve' | 'reject' | 'lock' | 'reverse';

export interface PayRunAggregate {
  readonly payRunId: string;
  readonly payPeriod: string; // e.g. '2026-08'
  readonly state: PayRunState;
  /** Who submitted the run for approval (the maker). */
  readonly submittedBy?: string;
  /** Who approved it (the checker) — never the submitter. */
  readonly approvedBy?: string;
  readonly lockedAt?: string;
  readonly reversedReason?: string;
  /** Summary carried from the draft, for a reviewer. */
  readonly netTotalMinor?: number;
  readonly employeeCount?: number;
  readonly detail: string;
}

export type PayRunEvent =
  | { readonly kind: 'drafted'; readonly payPeriod: string; readonly by: string; readonly at: string; readonly netTotalMinor?: number; readonly employeeCount?: number }
  | { readonly kind: 'submitted'; readonly by: string; readonly at: string }
  | { readonly kind: 'approved'; readonly by: string; readonly at: string }
  | { readonly kind: 'rejected'; readonly by: string; readonly at: string; readonly reason?: string }
  | { readonly kind: 'locked'; readonly at: string }
  | { readonly kind: 'reversed'; readonly by: string; readonly reason: string; readonly at: string };

/**
 * Fold a pay run's append-only events into its current state. An event that does not fit the current state
 * is IGNORED (an approval before submission, a second lock, a self-approval) — the state machine, not the
 * event author, decides what is valid. `undefined` until the run is drafted.
 */
export function foldPayRun(payRunId: string, events: readonly PayRunEvent[]): PayRunAggregate | undefined {
  let agg: PayRunAggregate | undefined;
  for (const e of events) {
    if (e.kind === 'drafted') {
      if (agg === undefined) {
        agg = {
          payRunId, payPeriod: e.payPeriod, state: 'draft',
          ...(e.netTotalMinor !== undefined ? { netTotalMinor: e.netTotalMinor } : {}),
          ...(e.employeeCount !== undefined ? { employeeCount: e.employeeCount } : {}),
          detail: `drafted for ${e.payPeriod} by ${e.by}`,
        };
      }
      continue;
    }
    if (agg === undefined) continue; // no run yet
    if (e.kind === 'submitted') {
      if (agg.state === 'draft') agg = { ...agg, state: 'submitted', submittedBy: e.by, detail: `submitted for approval by ${e.by}` };
    } else if (e.kind === 'approved') {
      // maker ≠ checker — a self-approval is ignored, not applied.
      if (agg.state === 'submitted' && e.by !== agg.submittedBy) agg = { ...agg, state: 'approved', approvedBy: e.by, detail: `approved by ${e.by}` };
    } else if (e.kind === 'rejected') {
      if (agg.state === 'submitted' && e.by !== agg.submittedBy) agg = { ...agg, state: 'draft', submittedBy: undefined, detail: `rejected by ${e.by}${e.reason ? `: ${e.reason}` : ''} — back to draft` };
    } else if (e.kind === 'locked') {
      if (agg.state === 'approved') agg = { ...agg, state: 'locked', lockedAt: e.at, detail: `locked at ${e.at} — final; a correction is a reversal and a new run` };
    } else if (e.kind === 'reversed') {
      if (agg.state === 'locked') agg = { ...agg, state: 'reversed', reversedReason: e.reason, detail: `reversed by ${e.by}: ${e.reason} — issue a corrected run` };
    }
  }
  return agg;
}

export type PayRunRefusalReason =
  | 'no_pay_run'
  | 'not_in_draft'
  | 'not_submitted'
  | 'not_approved'
  | 'not_locked'
  | 'self_approval'
  | 'reason_required';

export interface PayRunTransitionInput {
  readonly current?: PayRunAggregate;
  readonly action: PayRunAction;
  /** Who is performing the action — checked against the submitter for approve/reject (maker ≠ checker). */
  readonly actor: string;
  /** Required for a reversal (the reason a locked run is being corrected). */
  readonly reason?: string;
}

export interface PayRunTransitionDecision {
  readonly allowed: boolean;
  readonly reason: string;
  readonly resultingState?: PayRunState;
  readonly refusal?: PayRunRefusalReason;
}

const refuse = (refusal: PayRunRefusalReason, reason: string): PayRunTransitionDecision => ({ allowed: false, refusal, reason });

/**
 * May `actor` take `action` on the run in its current state? Enforces the state machine and — the control
 * that matters — that the approver (or rejecter) is not the submitter (§28, maker ≠ checker). Pure; the
 * caller appends the corresponding event only if `allowed`.
 */
export function evaluatePayRunTransition(input: PayRunTransitionInput): PayRunTransitionDecision {
  const { current, action, actor } = input;
  if (current === undefined) return refuse('no_pay_run', 'there is no pay run to act on — draft one first');

  switch (action) {
    case 'submit':
      if (current.state !== 'draft') return refuse('not_in_draft', `only a draft run can be submitted — this one is ${current.state}`);
      return { allowed: true, reason: 'submit for approval', resultingState: 'submitted' };
    case 'approve':
      if (current.state !== 'submitted') return refuse('not_submitted', `only a submitted run can be approved — this one is ${current.state}`);
      if (actor === current.submittedBy) return refuse('self_approval', 'the person who submitted the pay run cannot approve it — a second, different person must (§28)');
      return { allowed: true, reason: 'approve', resultingState: 'approved' };
    case 'reject':
      if (current.state !== 'submitted') return refuse('not_submitted', `only a submitted run can be rejected — this one is ${current.state}`);
      if (actor === current.submittedBy) return refuse('self_approval', 'the submitter cannot reject their own submission — a different person reviews it');
      return { allowed: true, reason: 'reject back to draft', resultingState: 'draft' };
    case 'lock':
      if (current.state !== 'approved') return refuse('not_approved', `only an approved run can be locked — this one is ${current.state}`);
      return { allowed: true, reason: 'lock the run', resultingState: 'locked' };
    case 'reverse':
      if (current.state !== 'locked') return refuse('not_locked', `only a locked run can be reversed — this one is ${current.state}; before locking, reject it back to draft instead`);
      if ((input.reason ?? '').trim() === '') return refuse('reason_required', 'a reversal needs a reason — a locked pay run is corrected by a visible reversal, never a silent rewrite');
      return { allowed: true, reason: `reverse: ${input.reason}`, resultingState: 'reversed' };
  }
}
