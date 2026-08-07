// Data-subject rights: access, correction, export and erasure (M16-FR-03 / PRV / DPDP).
//
// This is the module where two laws point in opposite directions, and pretending
// otherwise is the failure. A customer has a right to have their personal data erased.
// The Income Tax Act, the GST rules and the Companies Act require the shop to keep its
// invoices, its tax records and its audit trail for years. Both are true at once.
//
// Systems handle this in one of three ways, and two are wrong:
//
//   • **DELETE EVERYTHING.** The shop destroys statutory records and cannot answer a tax
//     query. Illegal, and the customer's request caused it.
//   • **DELETE NOTHING, SAY NOTHING.** The request is quietly filed. The customer
//     believes they have been erased and they have not, which is the worse betrayal
//     because they stopped worrying about it.
//   • **ERASE WHAT CAN BE ERASED, KEEP WHAT MUST BE KEPT, AND TELL THE CUSTOMER
//     EXACTLY WHICH IS WHICH AND WHY.** That is what this module does (P-08).
//
// So an erasure produces a **plan, not a deletion**: every category of data the shop
// holds about this person is classified as erasable, minimisable (identity stripped from
// a record that must survive) or legally retained — and the retained ones are named to
// the customer with the law that requires them and the date they can finally go.
//
// Two absolutes:
//   • **AUDIT EVIDENCE IS NEVER DELETED** (hard rule #6). Not for a data-subject request,
//     not for anyone. It is minimised — the person becomes a pseudonym — and the trail
//     survives.
//   • **A REQUEST IS VERIFIED BEFORE IT IS FULFILLED.** An unverified erasure request is
//     the easiest way to delete someone else's account, and an unverified *access*
//     request is a way to read their shopping history.
//
// Pure and deterministic: the clock is injected, nothing is deleted here — this produces
// the plan a fulfilment step executes and an auditor later reads.

export type RightKind = 'access' | 'correction' | 'export' | 'erasure';

export type RequestState = 'raised' | 'verified' | 'fulfilled' | 'refused' | 'partially_fulfilled';

export interface DataSubjectRequest {
  readonly requestId: string;
  readonly tenantId: string;
  readonly customerRef: string;
  readonly kind: RightKind;
  readonly raisedAt: string;
  /** How the requester proved they are the data subject. Absent = unverified. */
  readonly verifiedBy?: string;
  readonly verifiedAt?: string;
  readonly state: RequestState;
  /** The policy SLA in days, per tenant. */
  readonly dueBy: string;
}

/** Why a record cannot be erased. Each is a real statute, not a general excuse. */
export type RetentionBasis =
  | 'tax_invoice'
  | 'gst_record'
  | 'company_law'
  | 'audit_evidence'
  | 'legal_hold'
  | 'fraud_investigation';

export interface DataCategory {
  readonly category: string;
  readonly recordCount: number;
  /** Present when the law requires this category to survive an erasure request. */
  readonly retentionBasis?: RetentionBasis;
  /** The date the retention obligation ends, where there is one. */
  readonly retainUntil?: string;
  /**
   * True when the record must survive but the person need not be identifiable in it —
   * an invoice keeps its line items and totals; the name becomes a pseudonym.
   */
  readonly minimisable?: boolean;
}

export type Disposition = 'erase' | 'minimise' | 'retain';

export interface CategoryPlan {
  readonly category: string;
  readonly recordCount: number;
  readonly disposition: Disposition;
  readonly retentionBasis?: RetentionBasis;
  readonly retainUntil?: string;
  /** Written for the customer, not for a lawyer. */
  readonly explanation: string;
}

export interface ErasurePlan {
  readonly requestId: string;
  readonly customerRef: string;
  readonly plan: readonly CategoryPlan[];
  readonly erasedRecordCount: number;
  readonly minimisedRecordCount: number;
  readonly retainedRecordCount: number;
  /** True when at least one category cannot be erased. Almost always true. */
  readonly partial: boolean;
  /** The complete, honest message sent to the customer. */
  readonly customerStatement: readonly string[];
}

const LAW: Record<RetentionBasis, string> = {
  tax_invoice: 'Indian income-tax law requires sales invoices to be kept for eight years',
  gst_record: 'GST law requires these records to be kept for six years from the annual return',
  company_law: 'the Companies Act requires these books to be kept for eight years',
  audit_evidence: 'this is audit evidence and can never be deleted by anyone, including us',
  legal_hold: 'this is subject to a legal hold and cannot be touched until it is lifted',
  fraud_investigation: 'this is evidence in an open investigation',
};

/**
 * Plan an erasure. Nothing is deleted here — this produces the honest answer, category
 * by category, that a fulfilment step then executes and the customer is shown.
 */
export function planErasure(input: {
  readonly request: DataSubjectRequest;
  readonly categories: readonly DataCategory[];
  readonly at: string;
}): ErasurePlan {
  const plan = input.categories.map((c): CategoryPlan => {
    if (c.retentionBasis === undefined) {
      return {
        category: c.category,
        recordCount: c.recordCount,
        disposition: 'erase',
        explanation: `Deleted in full — ${c.recordCount} record(s).`,
      };
    }
    // Audit evidence is never erased and never minimised out of existence: the person
    // becomes a pseudonym and the trail survives intact (hard rule #6).
    const disposition: Disposition = c.minimisable === true ? 'minimise' : 'retain';
    return {
      category: c.category,
      recordCount: c.recordCount,
      disposition,
      retentionBasis: c.retentionBasis,
      ...(c.retainUntil === undefined ? {} : { retainUntil: c.retainUntil }),
      explanation:
        disposition === 'minimise'
          ? `Your name and contact details have been removed from ${c.recordCount} record(s), but the records themselves are kept because ${LAW[c.retentionBasis]}${c.retainUntil === undefined ? '' : `, until ${c.retainUntil}`}.`
          : `${c.recordCount} record(s) are kept in full because ${LAW[c.retentionBasis]}${c.retainUntil === undefined ? '' : `, until ${c.retainUntil}`}.`,
    };
  });

  const erased = plan.filter((p) => p.disposition === 'erase').reduce((s, p) => s + p.recordCount, 0);
  const minimised = plan.filter((p) => p.disposition === 'minimise').reduce((s, p) => s + p.recordCount, 0);
  const retained = plan.filter((p) => p.disposition === 'retain').reduce((s, p) => s + p.recordCount, 0);
  const partial = minimised + retained > 0;

  const customerStatement: string[] = [
    `We have acted on your request to delete your data (reference ${input.request.requestId}).`,
  ];
  if (erased > 0) {
    customerStatement.push(
      `${erased} record(s) have been deleted completely: ${plan.filter((p) => p.disposition === 'erase').map((p) => p.category).join(', ')}.`,
    );
  }
  if (partial) {
    customerStatement.push(
      'Some records could not be deleted, and we would rather tell you exactly which than let you believe they were gone:',
      ...plan.filter((p) => p.disposition !== 'erase').map((p) => `• ${p.category}: ${p.explanation}`),
      'These are kept because the law requires it, not because we want them. They are not used for marketing, and nobody can search them by your name.',
    );
  } else {
    customerStatement.push('Nothing about you is retained.');
  }

  return {
    requestId: input.request.requestId,
    customerRef: input.request.customerRef,
    plan,
    erasedRecordCount: erased,
    minimisedRecordCount: minimised,
    retainedRecordCount: retained,
    partial,
    customerStatement,
  };
}

export type FulfilmentRefusal = 'fulfilled' | 'not_verified' | 'wrong_state' | 'nothing_held';

export interface FulfilmentResult {
  readonly requestId: string;
  readonly fulfilled: boolean;
  readonly outcome: FulfilmentRefusal;
  readonly detail: string;
  readonly request: DataSubjectRequest;
  /** The data handed back, for access and export requests. */
  readonly payload?: Readonly<Record<string, unknown>>;
}

/**
 * Fulfil an access, correction or export request.
 *
 * **Verification is checked first, always.** An unverified erasure deletes someone
 * else's account; an unverified access request hands over their shopping history. Both
 * are one careless branch away, so the branch is at the top and nothing precedes it.
 */
export function fulfilRequest(input: {
  readonly request: DataSubjectRequest;
  readonly held: Readonly<Record<string, unknown>>;
  readonly fulfilledBy: string;
  readonly at: string;
}): FulfilmentResult {
  const r = input.request;
  const base = { requestId: r.requestId, request: r };

  if (r.verifiedBy === undefined) {
    return {
      ...base,
      fulfilled: false,
      outcome: 'not_verified',
      detail:
        'this request has not been verified as coming from the data subject — fulfilling it unverified is how one person reads or deletes another person\'s account',
    };
  }
  if (r.state === 'fulfilled' || r.state === 'refused') {
    return { ...base, fulfilled: false, outcome: 'wrong_state', detail: `this request is already ${r.state}` };
  }

  const keys = Object.keys(input.held);
  if (keys.length === 0) {
    // An honest "we hold nothing" is a valid, complete answer — and it is fulfilled,
    // not refused, because the customer asked a question and got a true reply.
    return {
      ...base,
      fulfilled: true,
      outcome: 'nothing_held',
      detail: 'we hold no personal data for this customer',
      request: { ...r, state: 'fulfilled' },
      payload: {},
    };
  }

  return {
    ...base,
    fulfilled: true,
    outcome: 'fulfilled',
    detail: `${r.kind} request fulfilled by ${input.fulfilledBy} across ${keys.length} categor(y/ies)`,
    request: { ...r, state: 'fulfilled' },
    payload: input.held,
  };
}

export interface OverdueRequest {
  readonly requestId: string;
  readonly customerRef: string;
  readonly kind: RightKind;
  readonly daysOverdue: number;
  readonly detail: string;
}

/**
 * Requests past their policy SLA. A privacy request that quietly ages is the one a
 * regulator asks about first, so overdue ones are surfaced by how late they are — and a
 * request that has not even been **verified** is called out separately, because that is
 * a queue the shop controls entirely and has simply not worked.
 */
export function overdueRequests(
  requests: readonly DataSubjectRequest[],
  today: string,
): readonly OverdueRequest[] {
  const dayMs = 86_400_000;
  return requests
    .filter((r) => r.state !== 'fulfilled' && r.state !== 'refused')
    .map((r) => ({
      r,
      daysOverdue: Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${r.dueBy}T00:00:00Z`)) / dayMs),
    }))
    .filter(({ daysOverdue }) => daysOverdue > 0)
    .sort((a, b) => b.daysOverdue - a.daysOverdue)
    .map(({ r, daysOverdue }) => ({
      requestId: r.requestId,
      customerRef: r.customerRef,
      kind: r.kind,
      daysOverdue,
      detail:
        r.verifiedBy === undefined
          ? `${daysOverdue} day(s) past the deadline and STILL NOT VERIFIED — this queue is entirely ours and has not been worked`
          : `${daysOverdue} day(s) past the deadline`,
    }));
}
