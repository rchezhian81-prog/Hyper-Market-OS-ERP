// A data principal's NOMINEE (R3 · C5 · DPDP Act 2023 s.14). A customer may name a person who will exercise their privacy
// rights if they die or can no longer act. Signed sentence: "a customer can record, change and withdraw a nominee
// (append-only). On a verified death or incapacity, the nominee can exercise the rights."
//
//   • The nominee is kept as the customer gave them, by REFERENCE (`nomineeRef` — the nominee's own customer account, or
//     the number of the nomination form the shop holds on paper) and the relationship. No name, number or address of the
//     nominee is kept here: data the shop does not hold it cannot leak (data minimisation, DPDP s.8(7)).
//   • Every change is a NEW record — recorded, changed, withdrawn; the latest stands and every earlier one stays (hard
//     rule #2).
//   • The nominee may act only after a named staff member has VERIFIED the death or incapacity against evidence, and only
//     the nominee the customer named at that time.
//
// Pure and deterministic: no clock, no I/O.

export type NomineeAction = 'recorded' | 'changed' | 'withdrawn';

export interface NomineeRecord {
  readonly customerRef: string;
  readonly action: NomineeAction;
  /** Null on a withdrawal. */
  readonly nomineeRef: string | null;
  readonly relationship: string | null;
  /** Who did it: the customer themselves, signed in. */
  readonly by: string;
  readonly at: string;
}

export type ActivationBasis = 'death' | 'incapacity';
export const ACTIVATION_BASES: readonly ActivationBasis[] = ['death', 'incapacity'];

/** A staff member's verification that the customer has died or can no longer act, against evidence. */
export interface NomineeActivation {
  readonly activationId: string;
  readonly customerRef: string;
  readonly nomineeRef: string;
  readonly basis: ActivationBasis;
  /** The document seen — the certificate's reference, never its contents. */
  readonly evidenceRef: string;
  readonly verifiedBy: string;
  readonly verifiedAt: string;
}

export interface CurrentNominee {
  readonly nomineeRef: string;
  readonly relationship: string | null;
  readonly since: string;
}

/** The customer's nominee now — the latest record, unless it withdrew them. */
export function currentNominee(records: readonly NomineeRecord[], customerRef: string): CurrentNominee | null {
  const mine = records.filter((r) => r.customerRef === customerRef);
  const last = mine.at(-1);
  if (last === undefined || last.action === 'withdrawn' || last.nomineeRef === null) return null;
  return { nomineeRef: last.nomineeRef, relationship: last.relationship, since: last.at };
}

/** The action a new nomination is: the first one is `recorded`, a later one (after one stands) is `changed`. */
export function nominationAction(records: readonly NomineeRecord[], customerRef: string): 'recorded' | 'changed' {
  return currentNominee(records, customerRef) === null ? 'recorded' : 'changed';
}

export type NomineeMayAct =
  | { readonly ok: true; readonly activation: NomineeActivation }
  | { readonly ok: false; readonly reason: 'no_nominee' | 'not_the_nominee' | 'not_verified'; readonly detail: string };

/**
 * May `nomineeRef` exercise `customerRef`'s rights? Only the nominee the customer named, and only once a verification of
 * death or incapacity naming that nominee stands.
 */
export function mayNomineeAct(input: {
  readonly records: readonly NomineeRecord[];
  readonly activations: readonly NomineeActivation[];
  readonly customerRef: string;
  readonly nomineeRef: string;
}): NomineeMayAct {
  const current = currentNominee(input.records, input.customerRef);
  if (current === null) return { ok: false, reason: 'no_nominee', detail: `${input.customerRef} has no nominee on record` };
  if (current.nomineeRef !== input.nomineeRef) return { ok: false, reason: 'not_the_nominee', detail: `${input.nomineeRef} is not the nominee ${input.customerRef} named` };
  const activation = [...input.activations].reverse().find((a) => a.customerRef === input.customerRef && a.nomineeRef === input.nomineeRef);
  if (activation === undefined) return { ok: false, reason: 'not_verified', detail: `no death or incapacity of ${input.customerRef} has been verified — the nominee cannot act yet` };
  return { ok: true, activation };
}
