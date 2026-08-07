// The customer's privacy centre (M16 · D07 · PRV · DPDP Act 2023) — the model behind the part of
// the app where somebody controls what the shop may do with their information.
//
// The rules already exist and are tested in `packages/customer`: what consent means, what an
// erasure can and cannot delete, why an unverified request is refused. This layer holds the two
// things no single function can — **the symmetry**, and **what the customer is truthfully told**.
//
// ── The control this file exists to hold ────────────────────────────────────
//
// **Withdrawing consent must be no harder than giving it.** That is not a design preference; it is
// section 6(6) of the Digital Personal Data Protection Act 2023 — the ease of withdrawing consent
// must be *comparable to* the ease with which it was given.
//
// It is also the single most common dark pattern in consumer software, and it is never built
// deliberately. It arrives one reasonable decision at a time: giving consent is a toggle at
// sign-up, and withdrawing it becomes a settings page, then a confirmation, then a "tell us why",
// then an email to support. Nobody ever decided to make it hard. It simply cost nothing to add a
// step on the way out and something to add one on the way in.
//
// So the symmetry is **structural rather than a habit**: there is exactly one function that changes
// a consent, it takes the direction as an argument, and both directions cost the same. There is no
// `withdrawConsent` with extra parameters for it to grow a reason field, a confirmation flag or a
// retention offer. A guardrail counts the taps on the screen in both directions and fails if they
// differ.
//
// ── The second: a request that has been RAISED is not a request that has been DONE ──
//
// The phone can raise a data request. It cannot fulfil one — verifying that a request really comes
// from the data subject, and executing it, happen in the back office where the evidence is. So this
// returns a request in state `raised` with the date the shop must answer by, and the screen says
// exactly that. An app that said "your data has been deleted" the moment somebody tapped a button
// would be lying about the one subject where being lied to matters most.
//
// ── The third: an erasure is almost never total, and the customer is told BEFORE they ask ──
//
// Tax invoices, GST records and audit evidence survive an erasure request because the law requires
// it. `planErasure` produces that answer honestly — but it produces it *afterwards*. Somebody who
// taps "delete everything about me" believing everything will go, and finds out later that eight
// years of invoices remain, has been misled even though every individual step was accurate. So the
// limits are stated **on the button**, before it is pressed.

import {
  hasConsent,
  type ConsentGrant,
  type ConsentState,
} from '../../../packages/customer/src/consent';
import type { DataSubjectRequest, RightKind } from '../../../packages/customer/src/data-rights';

/** One thing the shop may want to do with a customer's information, and on which channel. */
export interface ConsentPurposeSpec {
  readonly purpose: string;
  readonly channel: string;
  /**
   * True when the shop cannot operate without it (an order confirmation on the order you placed).
   *
   * Marked so the screen can say *why* it is not a choice, rather than showing a toggle that
   * refuses to move. A necessary purpose that pretends to be optional is its own dark pattern.
   */
  readonly required?: boolean;
}

export interface ConsentControl {
  readonly purpose: string;
  readonly channel: string;
  readonly granted: boolean;
  readonly required: boolean;
  /**
   * How many actions it takes to change this, in each direction.
   *
   * Both are 1 and the type says so, because the number is the control. It is reported rather than
   * assumed so a test can read it and a screen cannot quietly disagree with it.
   */
  readonly tapsToGrant: 1;
  readonly tapsToWithdraw: 1;
}

/**
 * The consent switches, as the screen renders them.
 *
 * One row per purpose, one toggle each, and the toggle is the whole interaction in both
 * directions. There is deliberately no "manage preferences" sub-page: a second screen on the way
 * out and not on the way in is exactly the asymmetry the Act forbids.
 */
export function consentControls(
  state: ConsentState,
  purposes: readonly ConsentPurposeSpec[],
): readonly ConsentControl[] {
  return purposes.map((spec) => ({
    purpose: spec.purpose,
    channel: spec.channel,
    granted: hasConsent(state, spec.purpose, spec.channel),
    required: spec.required === true,
    tapsToGrant: 1,
    tapsToWithdraw: 1,
  }));
}

export type ConsentRefusal =
  /** The purpose is not one this tenant offers — an unknown switch is refused, not invented. */
  | 'unknown_purpose'
  /** The shop cannot deliver an order without telling you about it. Explained, not hidden. */
  | 'required_for_service';

export type ConsentChange =
  | { readonly ok: true; readonly state: ConsentState; readonly granted: boolean }
  | { readonly ok: false; readonly refusal: ConsentRefusal };

/**
 * Grant or withdraw a consent. **One function, both directions, identical cost.**
 *
 * There is no separate `withdrawConsent`, and that absence is the design: a second function is
 * where a reason field, a confirmation step and a "are you sure, here is what you will miss"
 * screen accumulate, none of which would ever be added to the granting path.
 *
 * A withdrawal is recorded as a withdrawal rather than by deleting the grant — the history is
 * retained (M16-FR-02), so the shop can prove what it was allowed to do and when.
 */
export function setConsent(
  state: ConsentState,
  purposes: readonly ConsentPurposeSpec[],
  input: { readonly purpose: string; readonly channel: string; readonly granted: boolean },
): ConsentChange {
  const spec = purposes.find((p) => p.purpose === input.purpose && p.channel === input.channel);
  if (spec === undefined) return { ok: false, refusal: 'unknown_purpose' };
  if (spec.required === true && !input.granted) return { ok: false, refusal: 'required_for_service' };

  const others = state.grants.filter((g) => !(g.purpose === input.purpose && g.channel === input.channel));
  const grant: ConsentGrant = {
    purpose: input.purpose,
    channel: input.channel,
    granted: input.granted,
    // Withdrawal is a fact about the grant, not the absence of one. Deleting the row would leave
    // the shop unable to show what it had been permitted to do, which is the record an auditor
    // and the customer both need.
    ...(input.granted ? {} : { withdrawn: true }),
  };
  return { ok: true, granted: input.granted, state: { grants: [...others, grant] } };
}

// ── Data-subject requests ───────────────────────────────────────────────────

/** What the customer is told about a right BEFORE they exercise it. */
export interface RightOffer {
  readonly kind: RightKind;
  /**
   * True when exercising it cannot be complete, because the law requires some records to survive.
   *
   * Stated on the button. Somebody who taps "delete everything" believing everything goes, and
   * discovers eight years of invoices remain, has been misled even though every later step was
   * accurate.
   */
  readonly partialByLaw: boolean;
}

/** Every right this app offers, and whether it can ever be complete. */
export const RIGHTS_OFFERED: readonly RightOffer[] = Object.freeze([
  { kind: 'access', partialByLaw: false },
  { kind: 'correction', partialByLaw: false },
  { kind: 'export', partialByLaw: false },
  // An erasure is almost always partial: tax invoices, GST records and audit evidence survive it.
  { kind: 'erasure', partialByLaw: true },
]);

export interface RaisedRequest {
  readonly request: DataSubjectRequest;
  /**
   * What the screen shows. It says the request was **received**, never that it was done — the
   * phone cannot verify a requester or execute an erasure, and both happen where the evidence is.
   */
  readonly tellTheCustomer: string;
}

export class UnknownRightError extends Error {
  constructor(kind: string) {
    super(`"${kind}" is not a right this app can raise.`);
    this.name = 'UnknownRightError';
  }
}

/** Add days to an ISO date, in UTC. The SLA is a tenant policy, never a constant here. */
function plusDays(atIso: string, days: number): string {
  const at = Date.parse(atIso);
  if (Number.isNaN(at)) throw new RangeError(`"${atIso}" is not a valid timestamp.`);
  return new Date(at + days * 86_400_000).toISOString();
}

/**
 * Raise a data-subject request from the customer's own phone — no staff, no email, no phone call
 * (QG-02: *"a privacy request can be raised without contacting staff"*).
 *
 * It comes back in state `raised` and **unverified**, which is correct and is not a gap: verifying
 * that the request really comes from the data subject is what stops one person reading or deleting
 * another person's account, and a phone that verified itself would be no check at all.
 */
export function raiseRequest(input: {
  readonly requestId: string;
  readonly tenantId: string;
  readonly customerRef: string;
  readonly kind: RightKind;
  readonly at: string;
  /** The tenant's answer-by SLA in days. Per-tenant policy, never a constant in this file. */
  readonly slaDays: number;
}): RaisedRequest {
  const offer = RIGHTS_OFFERED.find((r) => r.kind === input.kind);
  if (offer === undefined) throw new UnknownRightError(input.kind);

  const dueBy = plusDays(input.at, input.slaDays);
  const request: DataSubjectRequest = Object.freeze({
    requestId: input.requestId,
    tenantId: input.tenantId,
    customerRef: input.customerRef,
    kind: input.kind,
    raisedAt: input.at,
    state: 'raised',
    dueBy,
  });

  const by = dueBy.slice(0, 10);
  return {
    request,
    tellTheCustomer: offer.partialByLaw
      ? `We have your request (reference ${input.requestId}). We must answer by ${by}. ` +
        'We will delete everything we are allowed to delete, and we will tell you exactly what we ' +
        'have to keep and why — invoices and tax records have to be kept by law even when you ask ' +
        'us to delete them.'
      : `We have your request (reference ${input.requestId}). We must answer by ${by}. ` +
        'Nobody needs to be contacted — this is already with us.',
  };
}
