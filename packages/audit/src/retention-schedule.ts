// The DEFAULT audit-retention schedule (M34-FR-02 / hard rule #6 / PRV-08).
//
// `planRetention` (see ./retention) is policy-driven: the caller hands it a set of
// `RetentionPolicy` rows, one per audit object type, and it reports — never deletes — what may be
// reviewed and what is frozen. That is correct, but it left the retention routes needing a full
// policy set on every call; omit it and every record came back `no_policy` ("kept, because silence
// never means discard"). Safe, but unclassified: the owner could not see WHY each class is kept.
//
// This is the owner-approved default schedule that fills that gap. It names every audit object type
// the M34 producers actually seal today and gives each one a policy the owner ratified
// (docs/OWNER-ACTION-REGISTER.md, retention decision, 23 Sep 2026):
//
//   • EVERY class is `statutory: true`. These are the money-path and privilege/security evidence
//     hard rule #6 forbids deleting — role grants, credential lifecycle, price changes, stock
//     write-offs, purchase orders, refunds and settlement imports. Marked statutory, the plan
//     reports them "never deleted through retention", which is the truth, rather than the vaguer
//     "no policy". A statutory class is never eligible for review however old it is.
//   • The `retainDays` floor is the owner-approved **8 years** for audit/compliance evidence. On a
//     statutory class the floor never triggers a deletion — it documents the minimum-keep promise
//     for an auditor, and is a lower bound, not a licence to delete on the day it passes.
//
// This does NOT touch the statute-accurate financial retention engine (./statutory-retention:
// GST 72 months, income-tax 72 months, Companies Act 96 months, longest-wins), which serves the
// finance route over financial RECORDS. This schedule is for the domain AUDIT TRAIL, a different
// body of evidence, and the two are deliberately kept apart. A legal hold still outranks
// everything here (planRetention applies holds first).

import type { RetentionPolicy } from './retention';
import type { AuditObjectType } from './audit-trail';

/**
 * Owner-approved minimum-keep floor for audit/compliance evidence: 8 years. On a statutory class
 * (which is every class below) the engine never deletes on age, so this is the documented promise,
 * not a trigger. 8 × 365 days — a floor, deliberately not leap-exact.
 */
export const DEFAULT_AUDIT_RETENTION_YEARS = 8;
const EIGHT_YEARS_DAYS = DEFAULT_AUDIT_RETENTION_YEARS * 365;

/**
 * The default policy for every audit object type the M34 producers seal. Object types match what
 * the producers actually emit (role.grant→`user`, secret.*→`secret`, price.change &
 * stock.write_off→`product`, purchase.order.place→`purchase-order`, refund.accept→`sale`,
 * settlement.batch.import→`settlement-batch`). Every one is statutory evidence (hard rule #6).
 */
export const DEFAULT_AUDIT_RETENTION: readonly RetentionPolicy[] = [
  {
    objectType: 'user',
    retainDays: EIGHT_YEARS_DAYS,
    statutory: true,
    basis: 'Privilege-change evidence (role grants) — kept as security & governance evidence; never deleted through retention (hard rule #6)',
  },
  {
    objectType: 'secret',
    retainDays: EIGHT_YEARS_DAYS,
    statutory: true,
    basis: 'Credential-lifecycle evidence (register / rotate / revoke) — kept as security evidence; never deleted through retention (hard rule #6)',
  },
  {
    objectType: 'product',
    retainDays: EIGHT_YEARS_DAYS,
    statutory: true,
    basis: 'Price-change and stock write-off evidence — money-path evidence kept for tax and audit; never deleted through retention (hard rule #6)',
  },
  {
    objectType: 'purchase-order',
    retainDays: EIGHT_YEARS_DAYS,
    statutory: true,
    basis: 'Buying evidence (purchase orders placed) — kept for tax and audit; never deleted through retention (hard rule #6)',
  },
  {
    objectType: 'sale',
    retainDays: EIGHT_YEARS_DAYS,
    statutory: true,
    basis: 'Refund evidence — money-path evidence kept for tax and audit; never deleted through retention (hard rule #6)',
  },
  {
    objectType: 'settlement-batch',
    retainDays: EIGHT_YEARS_DAYS,
    statutory: true,
    basis: 'Settlement-import evidence (money in) — kept for tax and audit; never deleted through retention (hard rule #6)',
  },
];

/** The default policy for one object type, or `undefined` when the schedule names no default for it. */
export function defaultRetentionPolicyFor(objectType: AuditObjectType): RetentionPolicy | undefined {
  return DEFAULT_AUDIT_RETENTION.find((p) => p.objectType === objectType);
}

/**
 * The policies a retention route should use: the caller's own set when it supplied one, otherwise
 * the owner-approved default schedule. `undefined` means the caller sent a `policies` field that
 * could not be read as policies — the route must reject that (400), NOT silently fall back, because
 * a malformed policy set is a mistake to surface, not to paper over. An ABSENT field is the caller
 * choosing the default and is honoured.
 */
export function retentionPoliciesOrDefault(
  supplied: readonly RetentionPolicy[] | undefined,
  fieldWasPresent: boolean,
): readonly RetentionPolicy[] | undefined {
  if (!fieldWasPresent) return DEFAULT_AUDIT_RETENTION;
  return supplied; // present: the parsed set, or undefined when it did not read as policies (→ 400)
}
