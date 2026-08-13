// GST return SUBMISSION SAFETY — the deterministic state machine that governs filing a GSTR-1 return to
// the government portal (owner directive: GST return submission safety). Filing a return is irreversible
// and legally binding, so the ACT of submission is wrapped in a spine of controls, and every one of them
// lives here as a pure, event-sourced lifecycle — no clock, no I/O, no network. The live portal call itself
// stays OFF by default and killable (packages/e-invoice portal-switch); this engine is what makes the path
// TO that call safe.
//
// The lifecycle, and the control each transition carries:
//
//   (none) ──preview──▶ previewed ──approve──▶ approved ──submit──▶ submitting ──acknowledge──▶ filed
//                          ▲  │(re-preview)                    │
//                          │  ▼                                ├──markFailed──▶ failed ──preview──▶ …
//                       failed / unknown ◀── reconcile ────────┴──markUnknown─▶ unknown
//
//   • preview      — a maker assembles the exact figures to file and records their DIGEST. Nothing is filed;
//                    this is the "preview and reconciliation before commit". A period already `filed` (or
//                    in-flight `submitting`) refuses a new preview — DUPLICATE-SUBMISSION PREVENTION.
//   • approve      — a DIFFERENT person than the maker approves the previewed figures (maker ≠ checker, §28).
//                    From here the period is LOCKED: the approved digest is the only thing that may be filed.
//   • submit       — hand the approved return to the portal. Refused unless the figures still match the
//                    approved digest (no silent change between approval and submit) and unless the period is
//                    not already submitting/filed (single-flight). The live gate is checked at the boundary.
//   • acknowledge  — the portal returned a reference (ARN): the return is FILED (terminal success).
//   • markFailed   — the portal rejected it, classified for operator recovery; a corrected return re-previews.
//   • markUnknown  — no clear answer (timeout/outage): needs reconciliation, never assumed filed or failed.
//   • reconcile    — an operator resolves a stuck `unknown` to filed or failed with EVIDENCE — a recorded
//                    fact, never a silent rewrite.
//
// The fold is replay-safe: an event that does not fit the current state is ignored (a re-posted ack on a
// filed return, an approval before a preview), so a duplicate or out-of-order delivery cannot corrupt state.

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const FP = /^\d{6}$/; // filing period MMYYYY

export class InvalidGstr1Submission extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidGstr1Submission';
  }
}

// --- portal error classification (for operator recovery) ---------------------------------------------

/** How a portal failure should be handled — the class an operator runbook keys off. */
export type GstnErrorClass =
  | 'auth'          // credentials rejected — fix the credential vault, do not retry blindly
  | 'validation'    // the return was malformed/invalid — correct the figures and re-file
  | 'duplicate'     // the portal already has this return — reconcile to filed, do not re-submit
  | 'rate_limit'    // throttled — back off and retry later
  | 'timeout'       // no answer in time — reconcile (may or may not have landed)
  | 'portal_outage' // the portal is down — retry later
  | 'unknown';      // unclassified — investigate manually

/**
 * Classify a raw portal error code/status into a recovery class. Conservative: an unrecognised code is
 * `unknown` (investigate), never silently treated as retryable. Pure.
 */
export function classifyGstnError(code: string): GstnErrorClass {
  const c = code.trim().toUpperCase();
  if (c === '') return 'unknown';
  if (/AUTH|CREDENTIAL|TOKEN|UNAUTHORI[SZ]ED|401|403/.test(c)) return 'auth';
  if (/DUPLICATE|ALREADY|DUP_/.test(c)) return 'duplicate';
  if (/RATE|THROTTLE|TOO_MANY|429/.test(c)) return 'rate_limit';
  if (/TIMEOUT|TIMED_OUT|504|GATEWAY_TIMEOUT/.test(c)) return 'timeout';
  if (/OUTAGE|UNAVAILABLE|MAINTENANCE|502|503/.test(c)) return 'portal_outage';
  if (/VALIDATION|INVALID|SCHEMA|RET_|MALFORMED|400|422/.test(c)) return 'validation';
  return 'unknown';
}

// --- the lifecycle -----------------------------------------------------------------------------------

export type Gstr1SubmissionState =
  | 'previewed'   // figures assembled + digest recorded; awaiting approval
  | 'approved'    // approved by a checker ≠ the maker; period locked to the approved digest
  | 'submitting'  // handed to the portal; awaiting an answer (in-flight)
  | 'filed'       // portal acknowledged (ARN) — terminal success
  | 'failed'      // portal rejected — recoverable by a corrected return
  | 'unknown';    // no clear answer — needs reconciliation

export type Gstr1SubmissionAction =
  | 'preview' | 'approve' | 'submit' | 'acknowledge' | 'markFailed' | 'markUnknown' | 'reconcile';

export type Gstr1SubmissionEvent =
  | { readonly kind: 'previewed'; readonly period: string; readonly returnDigest: string; readonly by: string; readonly at: string; readonly summary?: string }
  | { readonly kind: 'approved'; readonly by: string; readonly at: string }
  | { readonly kind: 'submitted'; readonly by: string; readonly at: string }
  | { readonly kind: 'acknowledged'; readonly arn: string; readonly at: string }
  | { readonly kind: 'failed'; readonly errorCode: string; readonly errorClass: GstnErrorClass; readonly at: string }
  | { readonly kind: 'unknownResponse'; readonly detail: string; readonly at: string }
  | { readonly kind: 'reconciled'; readonly resolvedState: 'filed' | 'failed'; readonly by: string; readonly note: string; readonly at: string; readonly arn?: string };

export interface Gstr1SubmissionAggregate {
  /** The filing period, MMYYYY. */
  readonly period: string;
  readonly state: Gstr1SubmissionState;
  /** The digest of the figures the maker previewed and the checker approved — what may be filed. */
  readonly returnDigest: string;
  readonly previewedBy: string;
  readonly approvedBy?: string;
  readonly submittedBy?: string;
  /** The portal reference once filed. */
  readonly arn?: string;
  readonly errorClass?: GstnErrorClass;
  readonly detail: string;
}

/**
 * Fold a return-submission's append-only events into its current state. Replay-safe: an event that does not
 * fit the current state is IGNORED — the state machine decides validity, not the event author, so a
 * duplicate or out-of-order delivery cannot corrupt state. `undefined` until the first preview.
 */
export function foldGstr1Submission(period: string, events: readonly Gstr1SubmissionEvent[]): Gstr1SubmissionAggregate | undefined {
  let agg: Gstr1SubmissionAggregate | undefined;
  for (const e of events) {
    if (e.kind === 'previewed') {
      // A first preview creates the submission; a re-preview is allowed only while not yet locked (previewed,
      // failed, or unknown-resolved-to-failed) and replaces the digest, resetting any approval.
      if (agg === undefined || agg.state === 'previewed' || agg.state === 'failed') {
        agg = {
          period: e.period, state: 'previewed', returnDigest: e.returnDigest, previewedBy: e.by,
          detail: `previewed by ${e.by}${e.summary ? ` — ${e.summary}` : ''}`,
        };
      }
      continue;
    }
    if (agg === undefined) continue; // nothing to act on before a preview
    if (e.kind === 'approved') {
      if (agg.state === 'previewed' && e.by !== agg.previewedBy) {
        agg = { ...agg, state: 'approved', approvedBy: e.by, detail: `approved by ${e.by} — period locked to the approved figures` };
      }
    } else if (e.kind === 'submitted') {
      if (agg.state === 'approved') agg = { ...agg, state: 'submitting', submittedBy: e.by, detail: `submitted to the portal by ${e.by} — awaiting acknowledgement` };
    } else if (e.kind === 'acknowledged') {
      if (agg.state === 'submitting') agg = { ...agg, state: 'filed', arn: e.arn, detail: `filed — portal reference ${e.arn}` };
    } else if (e.kind === 'failed') {
      if (agg.state === 'submitting') agg = { ...agg, state: 'failed', errorClass: e.errorClass, detail: `rejected by the portal (${e.errorClass}: ${e.errorCode}) — correct and re-file` };
    } else if (e.kind === 'unknownResponse') {
      if (agg.state === 'submitting') agg = { ...agg, state: 'unknown', detail: `no clear answer from the portal — ${e.detail}; reconcile before assuming filed or failed` };
    } else if (e.kind === 'reconciled') {
      if (agg.state === 'unknown') {
        agg = e.resolvedState === 'filed'
          ? { ...agg, state: 'filed', ...(e.arn !== undefined ? { arn: e.arn } : {}), detail: `reconciled to filed by ${e.by}: ${e.note}` }
          : { ...agg, state: 'failed', detail: `reconciled to failed by ${e.by}: ${e.note}` };
      }
    }
  }
  return agg;
}

export type Gstr1SubmissionRefusal =
  | 'no_submission'
  | 'already_filed'
  | 'in_flight'
  | 'not_previewed'
  | 'not_approved'
  | 'not_submitting'
  | 'not_unknown'
  | 'self_approval'
  | 'digest_mismatch'
  | 'invalid_period'
  | 'reason_required';

export interface Gstr1SubmissionTransitionInput {
  readonly current?: Gstr1SubmissionAggregate;
  readonly action: Gstr1SubmissionAction;
  /** Who is taking the action — checked against the maker for `approve` (maker ≠ checker). */
  readonly actor: string;
  /** For `submit`: the digest of the figures about to be filed — must match the approved digest. */
  readonly digest?: string;
  /** For `preview`: the filing period MMYYYY (validated). */
  readonly period?: string;
  /** For `reconcile`: the evidence/note (required — no silent rewrite). */
  readonly note?: string;
}

export interface Gstr1SubmissionDecision {
  readonly allowed: boolean;
  readonly reason: string;
  readonly resultingState?: Gstr1SubmissionState;
  readonly refusal?: Gstr1SubmissionRefusal;
}

const deny = (refusal: Gstr1SubmissionRefusal, reason: string): Gstr1SubmissionDecision => ({ allowed: false, refusal, reason });
const allow = (reason: string, resultingState: Gstr1SubmissionState): Gstr1SubmissionDecision => ({ allowed: true, reason, resultingState });

/**
 * May `actor` take `action` on this return submission? Enforces the state machine and the safety controls:
 * maker ≠ checker on approve, duplicate-submission prevention (a filed/in-flight period refuses a new
 * submit or preview), the approved-digest match on submit (no silent change after approval), and evidence
 * on a reconcile. Pure; the caller appends the event only if `allowed`.
 */
export function evaluateGstr1SubmissionTransition(input: Gstr1SubmissionTransitionInput): Gstr1SubmissionDecision {
  const { current, action, actor } = input;

  if (action === 'preview') {
    if (input.period === undefined || !FP.test(input.period)) return deny('invalid_period', 'a preview needs the filing period as MMYYYY');
    if (current === undefined) return allow('preview the return for review', 'previewed');
    if (current.state === 'filed') return deny('already_filed', `the ${current.period} return is already filed (${current.arn}) — a correction is an amendment in a later period, not a re-file`);
    if (current.state === 'submitting') return deny('in_flight', 'a submission is in flight — reconcile it before previewing again');
    if (current.state === 'approved') return deny('not_previewed', 'the return is approved and locked — reject/reconcile is not a preview; file it or start a corrected period');
    if (current.state === 'unknown') return deny('in_flight', 'the last submission’s outcome is unknown — reconcile it before previewing again');
    return allow('re-preview the corrected return', 'previewed'); // previewed | failed
  }

  if (current === undefined) return deny('no_submission', 'there is no return submission to act on — preview one first');

  switch (action) {
    case 'approve':
      if (current.state !== 'previewed') return deny('not_previewed', `only a previewed return can be approved — this one is ${current.state}`);
      if (actor === current.previewedBy) return deny('self_approval', 'the person who prepared the return cannot approve it — a second, different person must (§28)');
      return allow('approve the previewed figures and lock the period', 'approved');
    case 'submit':
      if (current.state === 'filed') return deny('already_filed', `the ${current.period} return is already filed — it will not be submitted twice`);
      if (current.state === 'submitting') return deny('in_flight', 'this return is already being submitted — one submission at a time');
      if (current.state !== 'approved') return deny('not_approved', `only an approved return can be submitted — this one is ${current.state}`);
      if (input.digest !== undefined && input.digest !== current.returnDigest) return deny('digest_mismatch', 'the figures have changed since approval — re-preview and get approval again before filing');
      return allow('submit the approved return to the portal', 'submitting');
    case 'acknowledge':
      if (current.state !== 'submitting') return deny('not_submitting', `only an in-flight submission can be acknowledged — this one is ${current.state}`);
      return allow('record the portal acknowledgement — filed', 'filed');
    case 'markFailed':
      if (current.state !== 'submitting') return deny('not_submitting', `only an in-flight submission can be marked failed — this one is ${current.state}`);
      return allow('record the portal rejection', 'failed');
    case 'markUnknown':
      if (current.state !== 'submitting') return deny('not_submitting', `only an in-flight submission can be marked unknown — this one is ${current.state}`);
      return allow('record that the outcome is unknown — reconcile before assuming anything', 'unknown');
    case 'reconcile':
      if (current.state !== 'unknown') return deny('not_unknown', `only a submission whose outcome is unknown can be reconciled — this one is ${current.state}`);
      if ((input.note ?? '').trim() === '') return deny('reason_required', 'reconciliation needs evidence/a note — a stuck return is resolved by a recorded fact, never a silent rewrite');
      return allow(`reconcile: ${input.note}`, 'filed'); // resolvedState decided by the caller (filed|failed)
    default:
      return deny('no_submission', `unknown action ${String(action)}`);
  }
}

/** Validate a filing period (MMYYYY), or throw. Small guard the route reuses. */
export function assertFilingPeriod(period: string): void {
  if (!FP.test(period)) throw new InvalidGstr1Submission(`the filing period must be MMYYYY, but reads "${period}"`);
}

/** Validate an ISO-UTC timestamp, or throw. */
export function assertIsoUtc(at: string): void {
  if (!ISO_UTC.test(at) || Number.isNaN(Date.parse(at))) throw new InvalidGstr1Submission(`the timestamp must be ISO-8601 UTC, but reads "${at}"`);
}
