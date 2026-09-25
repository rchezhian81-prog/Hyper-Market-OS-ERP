// Erasure GOVERNANCE — the controls that must hold around carrying out an erasure (M20-FR-04 / PRV / DPDP,
// owner decision). DEVELOPMENT-APPROVED; LEGAL CONFIRMATION REQUIRED — this is the technical workflow, not
// a claim that the shop is legally compliant. A lawyer confirms the policy (what is retained, for how long,
// who must be told); the code enforces whatever policy it is given.
//
// `planErasure` decides honestly what to do; `executeErasurePlan` carries it out against the stores. Between
// and after those two steps sit three controls the owner asked for, none of which existed:
//
//   1. MAKER-CHECKER (SoD §28). Verifying the request proves WHO ASKED — that the person is the data
//      subject. It does NOT authorise a member of staff to run a deletion. A destructive, irreversible act
//      across the customer's data needs a SECOND authorised person to approve it, and the person who
//      prepared/runs it can never be that approver. `authoriseErasureExecution` is the gate: verified
//      request + a distinct checker, or nothing runs.
//   2. PRIVACY TOMBSTONE. After an erasure runs, a small, PII-FREE marker records that this subject was
//      erased — who approved it, when, which categories went and which the law kept. It is the evidence the
//      erasure happened, and it holds NO personal data itself, so keeping it is not a re-identification.
//   3. PREVENT RESTORE. An erased subject must not quietly come back — a late offline sync, a re-import, a
//      cached copy re-creating the profile would silently undo the erasure. `guardAgainstRestore` turns an
//      incoming write that would re-introduce the person's PII into a VISIBLE exception, never a silent
//      last-write-wins (hard rule #10, P-08). A lawful retained record that merely references the now-
//      pseudonymised ref is allowed through — it carries no PII to restore.
//
// Pure and deterministic: the clock is injected, nothing is persisted here. The caller records the
// authorisation, the tombstone and any refused restore on an append-only trail.

import type { DataSubjectRequest, ErasurePlan, RetentionBasis } from './data-rights';
import type { ErasureExecutionReport } from './erasure-executor';

// ── 1. Maker-checker authorisation ───────────────────────────────────────────────────────────────────────

export type AuthorisationOutcome =
  | 'authorised'
  | 'not_an_erasure' // the request is not an erasure — there is nothing to execute
  | 'plan_mismatch' // the plan is for a different request than the one being authorised
  | 'not_verified' // the data subject's identity was never verified — the identity gate, carried through
  | 'checker_missing' // no second person approved — maker-checker needs two
  | 'maker_is_checker'; // the same person prepared and approved — that is not a control (SoD §28)

/** A recorded two-person authorisation to CARRY OUT an erasure. Append-only evidence for the trail. */
export interface ErasureAuthorisation {
  readonly requestId: string;
  readonly customerRef: string;
  /** The officer who prepared / will run the erasure. */
  readonly maker: string;
  /** The distinct, authorised officer who approved it. */
  readonly checker: string;
  readonly authorisedAt: string;
}

export type AuthorisationResult =
  | { readonly authorised: true; readonly outcome: 'authorised'; readonly authorisation: ErasureAuthorisation }
  | { readonly authorised: false; readonly outcome: Exclude<AuthorisationOutcome, 'authorised'>; readonly detail: string };

/**
 * Authorise carrying out an erasure. Maker-checker on top of the data-subject verification: the request
 * must be a verified erasure, and a second, distinct officer must approve. This does not run anything — it
 * decides whether running is permitted, and records who stands behind it. `maker` normally runs the
 * execution; `checker` is the approver, and the two can never be the same person (SoD §28).
 */
export function authoriseErasureExecution(input: {
  readonly request: DataSubjectRequest;
  readonly plan: ErasurePlan;
  readonly maker: string;
  readonly checker: string;
  readonly at: string;
}): AuthorisationResult {
  const { request, plan } = input;
  const maker = input.maker.trim();
  const checker = input.checker.trim();

  if (request.kind !== 'erasure') {
    return { authorised: false, outcome: 'not_an_erasure', detail: `this is a ${request.kind} request, not an erasure — there is nothing to execute` };
  }
  if (plan.requestId !== request.requestId) {
    return { authorised: false, outcome: 'plan_mismatch', detail: `the plan is for request ${plan.requestId}, not ${request.requestId}` };
  }
  // The data-subject verification gate is carried through — an unverified erasure deletes someone else's data.
  if (request.verifiedBy === undefined) {
    return { authorised: false, outcome: 'not_verified', detail: 'the request has not been verified as coming from the data subject — verify it before authorising an erasure' };
  }
  if (checker === '') {
    return { authorised: false, outcome: 'checker_missing', detail: 'an erasure needs a second, authorised officer to approve it — maker-checker requires two people' };
  }
  if (maker === '' ) {
    return { authorised: false, outcome: 'checker_missing', detail: 'the officer running the erasure must be named' };
  }
  if (maker === checker) {
    return { authorised: false, outcome: 'maker_is_checker', detail: 'the officer who prepares an erasure cannot also approve it — a second, different person must (SoD §28)' };
  }

  return {
    authorised: true,
    outcome: 'authorised',
    authorisation: { requestId: request.requestId, customerRef: request.customerRef, maker, checker, authorisedAt: input.at },
  };
}

// ── 2. Privacy tombstone ─────────────────────────────────────────────────────────────────────────────────

export interface RetainedMarker {
  readonly category: string;
  readonly retentionBasis?: RetentionBasis;
  readonly retainUntil?: string;
}

/**
 * A PII-FREE record that a subject was erased. It names the categories that went, those redacted to the
 * lawful minimum, and those kept in full under a statute (with the law and release date) — but it holds
 * NO name, phone, email or address, so keeping it is evidence of the erasure, not a re-identification of the
 * person. `complete` is false when the execution left exceptions (a store with no source, or one that
 * raised) still to resolve — the tombstone never claims a clean erasure that did not finish (P-08).
 */
export interface PrivacyTombstone {
  readonly customerRef: string;
  readonly requestId: string;
  readonly erasedAt: string;
  readonly maker: string;
  readonly checker: string;
  readonly categoriesErased: readonly string[];
  readonly categoriesMinimised: readonly string[];
  readonly categoriesRetained: readonly RetainedMarker[];
  readonly complete: boolean;
}

/**
 * Seal the tombstone for a completed (or partially completed) erasure, from the two-person authorisation and
 * the execution report. Pure derivation — it copies no personal data, only the category names and the
 * statutory bases already on the report.
 */
export function sealTombstone(input: {
  readonly authorisation: ErasureAuthorisation;
  readonly report: ErasureExecutionReport;
  readonly at: string;
}): PrivacyTombstone {
  const { authorisation: a, report } = input;
  return {
    customerRef: report.customerRef,
    requestId: report.requestId,
    erasedAt: input.at,
    maker: a.maker,
    checker: a.checker,
    categoriesErased: report.lines.filter((l) => l.outcome === 'erased').map((l) => l.category),
    categoriesMinimised: report.lines.filter((l) => l.outcome === 'minimised').map((l) => l.category),
    categoriesRetained: report.lines
      .filter((l) => l.outcome === 'retained')
      .map((l) => ({
        category: l.category,
        ...(l.retentionBasis === undefined ? {} : { retentionBasis: l.retentionBasis }),
        ...(l.retainUntil === undefined ? {} : { retainUntil: l.retainUntil }),
      })),
    complete: report.complete,
  };
}

// ── 3. Prevent restore ───────────────────────────────────────────────────────────────────────────────────

export type RestoreDecision = 'allowed' | 'refused_erased_subject';

/** An incoming write that could re-create a subject — a late sync, a re-import, a cached copy. */
export interface RestoreAttempt {
  readonly customerRef: string;
  /**
   * True when the write would re-introduce identifying PII for the subject (name, contact, a full profile).
   * False for a lawful retained record that merely references the already-pseudonymised ref — it carries no
   * PII to restore, so it is not a re-identification.
   */
  readonly carriesPii: boolean;
  /** Where the attempt came from, for the exception if it is refused. */
  readonly source: string;
}

export interface RestoreGuardResult {
  readonly customerRef: string;
  readonly decision: RestoreDecision;
  readonly detail: string;
  /** The tombstone that blocked the write, when refused — surfaced as a visible exception, never swallowed. */
  readonly tombstone?: PrivacyTombstone;
}

/**
 * Decide whether an incoming write for a subject may proceed, given the tombstones held for the tenant.
 * An erased subject whose PII would be re-created is REFUSED and surfaced (the caller records the exception
 * and does not apply the write — hard rule #10, never silent last-write-wins). A record that carries no PII,
 * or a subject with no tombstone, is allowed. The caller passes only its own tenant's tombstones, so the
 * decision is tenant-isolated by construction.
 */
export function guardAgainstRestore(input: {
  readonly attempt: RestoreAttempt;
  readonly tombstones: readonly PrivacyTombstone[];
  readonly at: string;
}): RestoreGuardResult {
  const tombstone = input.tombstones.find((t) => t.customerRef === input.attempt.customerRef);
  if (tombstone === undefined) {
    return { customerRef: input.attempt.customerRef, decision: 'allowed', detail: 'no erasure on record for this subject' };
  }
  if (!input.attempt.carriesPii) {
    return {
      customerRef: input.attempt.customerRef,
      decision: 'allowed',
      detail: 'the write carries no identifying data — a lawful retained record may reference the erased subject',
      tombstone,
    };
  }
  return {
    customerRef: input.attempt.customerRef,
    decision: 'refused_erased_subject',
    detail: `this subject was erased on ${tombstone.erasedAt} (request ${tombstone.requestId}); the write from "${input.attempt.source}" would re-create their personal data and is refused — resolve it as an exception, never re-create silently`,
    tombstone,
  };
}
