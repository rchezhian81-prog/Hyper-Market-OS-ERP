// Children's personal data — **DPDP Act 2023 s.9** (C4). A "child" is an individual **under eighteen**
// (s.2(f)). Two hard rules the Act puts on a child's data, and this guard encodes both:
//
//   (1) A child's personal data may be processed **only with the verifiable consent of a parent or lawful
//       guardian** (s.9(1)). No parental consent → no enrolment, no marketing, no profiling of a child.
//   (2) **Behavioural tracking / monitoring of a child, and advertising TARGETED at a child, are
//       prohibited outright** (s.9(3)) — and parental consent **cannot cure them**. This is the part that
//       trips a loyalty programme up: "we got the parent's tick" does not license tracking a child.
//
// This is a pure decision overlay on top of the ordinary consent regime (`consent.ts`): it commits
// nothing and stores no child's data — it answers whether an activity is permitted. Like the lane's
// expiry block it **never guesses**: with the person's age unproven it refuses a child-restricted
// activity rather than assume an adult (you must be able to identify a child before you market to,
// profile, or track anyone). A transactional or service message — about something the person actually
// asked for — carries no child restriction, the same distinction the send-consent rules already draw.

/** DPDP Act 2023 s.2(f): a "child" is an individual who has not completed eighteen years of age. */
export const CHILD_AGE_LIMIT_YEARS = 18;

/** What we want to do with (or to) this person's data. */
export type ChildDataActivity =
  /** Enrol/store the person's data for loyalty or marketing. */
  | 'account_enrolment'
  /** Send a marketing message. */
  | 'marketing'
  /** Build a segment or a derived opinion about the person (M16-FR-04). */
  | 'profiling'
  /** Track or monitor the person's behaviour. */
  | 'behavioural_tracking'
  /** Advertising directed at this specific person. */
  | 'targeted_advertising'
  /** A message about something the person bought — no child restriction. */
  | 'transactional'
  /** Answering the person's own request — no child restriction. */
  | 'service';

export type ChildDataVerdict =
  /** Allowed — an adult, a non-restricted activity, or a child WITH verifiable parental consent. */
  | 'permitted'
  /** Blocked — a child, a curable activity, but no verifiable parental consent on record (s.9(1)). */
  | 'needs_parental_consent'
  /** Blocked — a child, and tracking / targeted advertising cannot be cured by any consent (s.9(3)). */
  | 'prohibited_for_child'
  /** Blocked — a child-restricted activity but the person's age is not established (never assume adult). */
  | 'age_unverified';

export interface ChildDataDecision {
  readonly allowed: boolean;
  readonly verdict: ChildDataVerdict;
  /** true / false when age is known; 'unknown' when it could not be established. */
  readonly isChild: boolean | 'unknown';
  readonly detail: string;
}

/** Activities the child rules touch at all. Transactional / service are deliberately outside. */
const RESTRICTED: readonly ChildDataActivity[] = [
  'account_enrolment', 'marketing', 'profiling', 'behavioural_tracking', 'targeted_advertising',
];

/** Activities a child can never be subject to, parental consent notwithstanding (s.9(3)). */
const PROHIBITED_FOR_CHILD: readonly ChildDataActivity[] = ['behavioural_tracking', 'targeted_advertising'];

/**
 * Whole years old at `asOf`, from a `YYYY-MM-DD` date of birth. Returns `undefined` if either date is
 * malformed — an unreadable date is "age unknown", never a silent zero. `asOf` may carry a time; only its
 * date is used, so the answer does not depend on the clock within the day.
 */
export function ageInYears(dateOfBirth: string, asOf: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) return undefined;
  const asOfDate = /^\d{4}-\d{2}-\d{2}/.exec(asOf)?.[0];
  if (asOfDate === undefined) return undefined;
  const dob = new Date(`${dateOfBirth}T00:00:00.000Z`);
  const at = new Date(`${asOfDate}T00:00:00.000Z`);
  if (Number.isNaN(dob.getTime()) || Number.isNaN(at.getTime())) return undefined;
  // Reject a date the calendar rolled over (e.g. 31 April) — it is not a real birth date.
  if (dob.getUTCDate() !== Number(dateOfBirth.slice(8, 10))) return undefined;
  let years = at.getUTCFullYear() - dob.getUTCFullYear();
  const beforeBirthdayThisYear =
    at.getUTCMonth() < dob.getUTCMonth() ||
    (at.getUTCMonth() === dob.getUTCMonth() && at.getUTCDate() < dob.getUTCDate());
  if (beforeBirthdayThisYear) years -= 1;
  return years < 0 ? undefined : years;
}

/**
 * Decide whether an activity on a person's data is permitted under the children's-data rules (DPDP s.9).
 *
 * Age comes from `ageYears` if given, else computed from `dateOfBirth` + `asOf`. `parentalConsentVerified`
 * is the shop's own record that a parent/guardian's consent was verifiably obtained — a bare boolean here;
 * capturing the evidence for it is the caller's job, the same as any other consent record.
 */
export function assessChildDataProcessing(input: {
  readonly activity: ChildDataActivity;
  readonly ageYears?: number;
  readonly dateOfBirth?: string;
  readonly asOf?: string;
  readonly parentalConsentVerified?: boolean;
}): ChildDataDecision {
  const age = input.ageYears ?? (input.dateOfBirth !== undefined && input.asOf !== undefined
    ? ageInYears(input.dateOfBirth, input.asOf)
    : undefined);
  const isChild: boolean | 'unknown' = age === undefined ? 'unknown' : age < CHILD_AGE_LIMIT_YEARS;

  // A transactional or service interaction about something the person themselves asked for carries no
  // child restriction — a child is still owed the message about the thing they bought.
  if (!RESTRICTED.includes(input.activity)) {
    return { allowed: true, verdict: 'permitted', isChild, detail: 'a transactional/service interaction is not a child-restricted activity' };
  }

  // Age unproven: we cannot license a child-restricted activity, because we cannot rule out a child.
  if (age === undefined) {
    return {
      allowed: false, verdict: 'age_unverified', isChild: 'unknown',
      detail: 'the person’s age is not established — a child-restricted activity is refused until it is (never assume an adult)',
    };
  }

  // An adult — the child rules do not apply; the ordinary consent regime governs.
  if (age >= CHILD_AGE_LIMIT_YEARS) {
    return { allowed: true, verdict: 'permitted', isChild: false, detail: 'an adult — the ordinary consent rules apply' };
  }

  // A child. Tracking / targeted advertising is prohibited outright — parental consent cannot cure it.
  if (PROHIBITED_FOR_CHILD.includes(input.activity)) {
    return {
      allowed: false, verdict: 'prohibited_for_child', isChild: true,
      detail: 'tracking or advertising targeted at a child is prohibited and parental consent cannot cure it (DPDP s.9(3))',
    };
  }

  // A child, a curable activity: permitted only with verifiable parental consent on record.
  if (input.parentalConsentVerified === true) {
    return { allowed: true, verdict: 'permitted', isChild: true, detail: 'a child, with the verifiable consent of a parent or guardian on record (DPDP s.9(1))' };
  }
  return {
    allowed: false, verdict: 'needs_parental_consent', isChild: true,
    detail: 'a child — this needs the verifiable consent of a parent or guardian first (DPDP s.9(1))',
  };
}
