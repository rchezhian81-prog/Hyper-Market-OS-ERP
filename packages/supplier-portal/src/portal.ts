// Supplier portal — access, submissions and statements (M24 / §35 / P-04 / hard rule #6).
//
// A supplier portal is the only place in the whole product where **someone outside the
// business logs in**. That single fact makes it the highest-risk surface here, and the
// risk is not exotic: it is one supplier seeing another supplier's prices.
//
// Two suppliers competing for the same shelf, both with a login, and a query that filters
// on a parameter the client sends. That is not a hypothetical — it is the commonest
// multi-tenant breach there is, and it is usually one missing `where` clause. So:
//
//   • **EVERY READ IS SCOPED SERVER-SIDE, FROM THE SESSION, NOT FROM THE REQUEST.**
//     `scopeToPartner` takes the partner id from the authenticated session and filters
//     there. A request that asks for another partner's data does not get an empty list —
//     it gets a **refusal that is recorded**, because a supplier probing for someone
//     else's invoices is a security event, not a UI mistake.
//   • **A PARTNER IS NEVER TRUSTED WITH ITS OWN IDENTITY.** Nothing in this module reads
//     a partner id out of a payload. There is no function that takes one.
//
// The other half is **document expiry**. A supplier whose FSSAI licence or insurance has
// lapsed cannot be issued a purchase order — not "should not", cannot — because the shop
// inherits their non-compliance the moment it accepts goods from them. Expiry is checked
// **at the action**, not at a nightly job, since the gap between the two is exactly where
// the expired supplier gets paid.
//
// Pure and deterministic: the clock is injected, nothing is written here.

export type PartnerDocumentKind =
  | 'fssai_licence'
  | 'gst_registration'
  | 'insurance'
  | 'trade_licence'
  | 'bank_mandate'
  | 'quality_certificate';

export interface PartnerDocument {
  readonly documentId: string;
  readonly partnerId: string;
  readonly kind: PartnerDocumentKind;
  readonly reference: string;
  readonly validFrom: string;
  /** Inclusive last valid date, YYYY-MM-DD. */
  readonly validUntil: string;
  readonly verifiedBy?: string;
  readonly verifiedAt?: string;
}

/** The authenticated session. The partner id comes from HERE and nowhere else. */
export interface PartnerSession {
  readonly sessionId: string;
  readonly partnerId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly grants: readonly PortalGrant[];
}

export type PortalGrant =
  | 'view_orders'
  | 'acknowledge_orders'
  | 'submit_asn'
  | 'submit_invoice'
  | 'submit_catalogue'
  | 'respond_rfq'
  | 'raise_claim'
  | 'view_statement';

export type AccessOutcome = 'allowed' | 'not_your_data' | 'no_grant' | 'wrong_tenant';

export interface AccessDecision<T> {
  readonly allowed: boolean;
  readonly outcome: AccessOutcome;
  /** Only ever the session partner's own rows. */
  readonly rows: readonly T[];
  readonly detail: string;
  /** True when this looks like probing rather than a mistake — always audited. */
  readonly securityEvent: boolean;
}

/**
 * Scope any partner-owned collection to the session's own partner.
 *
 * **The partner id is taken from the session**, never from the caller's request. An
 * attempt to read another partner's rows returns a refusal *and* is marked a security
 * event — a supplier probing for a competitor's invoices is not a UI mistake.
 */
export function scopeToPartner<T extends { readonly partnerId: string; readonly tenantId?: string }>(
  input: {
    readonly session: PartnerSession;
    readonly rows: readonly T[];
    readonly grant: PortalGrant;
    /** What the request asked for. If it names another partner, that is the event. */
    readonly requestedPartnerId?: string;
  },
): AccessDecision<T> {
  const { session } = input;

  if (!session.grants.includes(input.grant)) {
    return {
      allowed: false,
      outcome: 'no_grant',
      rows: [],
      securityEvent: false,
      detail: `this portal login does not have "${input.grant}"`,
    };
  }
  if (input.requestedPartnerId !== undefined && input.requestedPartnerId !== session.partnerId) {
    return {
      allowed: false,
      outcome: 'not_your_data',
      rows: [],
      // Recorded, not silently emptied. Someone asked for a competitor's data.
      securityEvent: true,
      detail: `session belongs to ${session.partnerId} and the request asked for ${input.requestedPartnerId} — refused and recorded`,
    };
  }

  const mine = input.rows.filter(
    (r) => r.partnerId === session.partnerId && (r.tenantId === undefined || r.tenantId === session.tenantId),
  );
  const foreign = input.rows.length - mine.length;

  return {
    allowed: true,
    outcome: 'allowed',
    rows: mine,
    securityEvent: false,
    detail:
      foreign === 0
        ? `${mine.length} row(s)`
        : `${mine.length} row(s); ${foreign} belonging to other partners were filtered server-side, not by the client`,
  };
}

export interface DocumentStatus {
  readonly kind: PartnerDocumentKind;
  readonly reference?: string;
  readonly validUntil?: string;
  readonly daysRemaining?: number;
  readonly state: 'valid' | 'expiring' | 'expired' | 'missing' | 'unverified';
  readonly detail: string;
}

export interface ComplianceCheck {
  readonly partnerId: string;
  readonly compliant: boolean;
  readonly documents: readonly DocumentStatus[];
  /** The kinds that block the action outright. */
  readonly blocking: readonly PartnerDocumentKind[];
  readonly detail: string;
}

/**
 * Check a partner's documents **at the moment of the action**, not on a nightly sweep.
 *
 * The gap between a nightly job and the action is exactly where an expired supplier gets
 * a purchase order — and once the shop accepts goods from an unlicensed food supplier, it
 * has inherited their non-compliance whatever its own paperwork says.
 *
 * A document that exists but was **never verified** counts as missing: an unverified
 * licence is a photograph somebody uploaded.
 */
export function checkPartnerCompliance(input: {
  readonly partnerId: string;
  readonly documents: readonly PartnerDocument[];
  /** Kinds this action requires. Per-tenant, per-category. */
  readonly required: readonly PartnerDocumentKind[];
  readonly today: string;
  /** Days before expiry at which it is flagged. Default 30. */
  readonly warnWithinDays?: number;
}): ComplianceCheck {
  const warn = input.warnWithinDays ?? 30;
  const dayMs = 86_400_000;
  const mine = input.documents.filter((d) => d.partnerId === input.partnerId);

  const documents = input.required.map((kind): DocumentStatus => {
    const doc = mine
      .filter((d) => d.kind === kind)
      .sort((a, b) => b.validUntil.localeCompare(a.validUntil))[0];

    if (doc === undefined) {
      return { kind, state: 'missing', detail: `no ${kind.replace(/_/g, ' ')} on file` };
    }
    if (doc.verifiedBy === undefined) {
      return {
        kind,
        reference: doc.reference,
        validUntil: doc.validUntil,
        state: 'unverified',
        detail: `${kind.replace(/_/g, ' ')} was uploaded but never verified — an unverified licence is a photograph somebody uploaded`,
      };
    }
    const daysRemaining = Math.floor(
      (Date.parse(`${doc.validUntil}T00:00:00Z`) - Date.parse(`${input.today}T00:00:00Z`)) / dayMs,
    );
    if (daysRemaining < 0) {
      return {
        kind,
        reference: doc.reference,
        validUntil: doc.validUntil,
        daysRemaining,
        state: 'expired',
        detail: `${kind.replace(/_/g, ' ')} expired ${-daysRemaining} day(s) ago — the shop inherits their non-compliance the moment it accepts goods`,
      };
    }
    if (daysRemaining <= warn) {
      return {
        kind,
        reference: doc.reference,
        validUntil: doc.validUntil,
        daysRemaining,
        state: 'expiring',
        detail: `${kind.replace(/_/g, ' ')} expires in ${daysRemaining} day(s) — chase it before it stops a delivery`,
      };
    }
    return {
      kind,
      reference: doc.reference,
      validUntil: doc.validUntil,
      daysRemaining,
      state: 'valid',
      detail: `${kind.replace(/_/g, ' ')} valid until ${doc.validUntil}`,
    };
  });

  const blocking = documents
    .filter((d) => d.state === 'expired' || d.state === 'missing' || d.state === 'unverified')
    .map((d) => d.kind);

  return {
    partnerId: input.partnerId,
    compliant: blocking.length === 0,
    documents,
    blocking,
    detail:
      blocking.length === 0
        ? `all ${documents.length} required document(s) valid`
        : `${blocking.length} document(s) block trading with this supplier: ${blocking.join(', ')}`,
  };
}

export type SubmissionKind = 'rfq_response' | 'catalogue' | 'asn' | 'invoice' | 'po_acknowledgement' | 'claim';

export type SubmissionOutcome =
  | 'accepted'
  | 'no_grant'
  | 'not_compliant'
  | 'duplicate'
  | 'not_your_order'
  | 'invalid';

export interface SubmissionResult {
  readonly submissionId: string;
  readonly accepted: boolean;
  readonly outcome: SubmissionOutcome;
  readonly detail: string;
  /** True when the submission needs a person before it has any effect (§28). */
  readonly requiresReview: boolean;
}

/**
 * Accept a supplier submission.
 *
 * **Nothing a supplier submits takes effect on its own.** A catalogue or cost proposal
 * is a *proposal*: it lands for review and a buyer decides (§28). An ASN and an invoice
 * are statements of fact that still meet the receiving and three-way-match controls
 * (M07). The portal is a door, not an authority.
 */
export function acceptSubmission(input: {
  readonly submissionId: string;
  readonly session: PartnerSession;
  readonly kind: SubmissionKind;
  readonly compliance: ComplianceCheck;
  /** For a PO acknowledgement or ASN — the order it refers to. */
  readonly orderPartnerId?: string;
  readonly alreadySubmittedIds?: readonly string[];
  readonly at: string;
}): SubmissionResult {
  const grantFor: Record<SubmissionKind, PortalGrant> = {
    rfq_response: 'respond_rfq',
    catalogue: 'submit_catalogue',
    asn: 'submit_asn',
    invoice: 'submit_invoice',
    po_acknowledgement: 'acknowledge_orders',
    claim: 'raise_claim',
  };
  const base = { submissionId: input.submissionId, requiresReview: false };

  if ((input.alreadySubmittedIds ?? []).includes(input.submissionId)) {
    return { ...base, accepted: false, outcome: 'duplicate', detail: 'this submission has already been received' };
  }
  if (!input.session.grants.includes(grantFor[input.kind])) {
    return { ...base, accepted: false, outcome: 'no_grant', detail: `this login cannot submit a ${input.kind.replace(/_/g, ' ')}` };
  }
  if (input.orderPartnerId !== undefined && input.orderPartnerId !== input.session.partnerId) {
    return {
      ...base,
      accepted: false,
      outcome: 'not_your_order',
      detail: 'that order belongs to another supplier — refused and recorded',
    };
  }
  // Compliance is checked at the action for the submissions that create an obligation.
  if (!input.compliance.compliant && (input.kind === 'asn' || input.kind === 'invoice' || input.kind === 'catalogue')) {
    return {
      ...base,
      accepted: false,
      outcome: 'not_compliant',
      detail: `${input.compliance.detail} — a supplier cannot deliver or bill while a required document is missing or expired`,
    };
  }

  // A catalogue or cost proposal is a proposal. A buyer decides (§28).
  const requiresReview = input.kind === 'catalogue' || input.kind === 'rfq_response' || input.kind === 'claim';
  return {
    submissionId: input.submissionId,
    accepted: true,
    outcome: 'accepted',
    requiresReview,
    detail: requiresReview
      ? `${input.kind.replace(/_/g, ' ')} received and queued for review — nothing a supplier submits takes effect on its own`
      : `${input.kind.replace(/_/g, ' ')} received`,
  };
}

export interface StatementLine {
  readonly partnerId: string;
  readonly tenantId?: string;
  readonly documentRef: string;
  readonly kind: 'invoice' | 'credit_note' | 'payment' | 'debit_note';
  readonly date: string;
  /** Signed: an invoice increases what we owe, a payment reduces it. */
  readonly amountMinor: number;
  readonly status: 'open' | 'settled' | 'disputed';
}

export interface Statement {
  readonly partnerId: string;
  /** False when this login has no statement grant — an empty statement is not "you owe nothing". */
  readonly accessible: boolean;
  readonly openingMinor: number;
  readonly invoicedMinor: number;
  readonly debitedMinor: number;
  readonly creditedMinor: number;
  readonly paidMinor: number;
  readonly closingMinor: number;
  readonly disputedMinor: number;
  readonly lines: readonly StatementLine[];
  readonly reconciles: boolean;
  readonly detail: string;
}

/**
 * Build a supplier statement from **the partner's own lines only**.
 *
 * The closing balance is derived from the movements and **checked against the arithmetic**
 * rather than stored: a statement that does not add up is the fastest way to lose a
 * supplier's trust, and they will be the ones who spot it.
 *
 * A disputed line is reported **separately** — it is neither owed nor written off, and
 * folding it into the balance is how a dispute quietly becomes a payment.
 *
 * `reconciles` is a real guard, not decoration: the closing balance is built from named
 * buckets, and the check adds the raw line amounts a second way. They only agree if every
 * line landed in a bucket. Add a new document kind and forget to categorise it, and this
 * goes false rather than quietly dropping the line out of a supplier's balance.
 */
export function buildStatement(input: {
  readonly session: PartnerSession;
  readonly lines: readonly StatementLine[];
  readonly openingMinor: number;
}): Statement {
  const scoped = scopeToPartner({ session: input.session, rows: input.lines, grant: 'view_statement' });
  const mine = scoped.rows;

  const sum = (f: (l: StatementLine) => boolean): number =>
    mine.filter(f).reduce((s, l) => s + l.amountMinor, 0);
  const live = (kind: StatementLine['kind']) => (l: StatementLine) =>
    l.kind === kind && l.status !== 'disputed';

  // Positive numbers throughout, whichever way the signed amount runs.
  const invoiced = sum(live('invoice'));
  const debited = sum(live('debit_note'));
  const credited = -sum(live('credit_note'));
  const paid = -sum(live('payment'));
  const disputed = Math.abs(sum((l) => l.status === 'disputed'));
  const closing = input.openingMinor + invoiced + debited - credited - paid;

  const movementSum = mine
    .filter((l) => l.status !== 'disputed')
    .reduce((s, l) => s + l.amountMinor, 0);
  const reconciles = input.openingMinor + movementSum === closing;

  return {
    partnerId: input.session.partnerId,
    accessible: scoped.allowed,
    openingMinor: input.openingMinor,
    invoicedMinor: invoiced,
    debitedMinor: debited,
    creditedMinor: credited,
    paidMinor: paid,
    closingMinor: closing,
    disputedMinor: disputed,
    lines: mine,
    reconciles,
    detail: !scoped.allowed
      ? 'this login cannot see a statement — that is a permission answer, NOT a balance of zero'
      : !reconciles
        ? `the buckets do not add up to the movements — a line kind is uncategorised and would vanish from this balance`
        : disputed === 0
          ? `${closing} outstanding across ${mine.length} line(s)`
          : `${closing} outstanding across ${mine.length} line(s); ${disputed} is disputed and is shown separately — it is neither owed nor written off`,
  };
}

export interface PartnerAuditEntry {
  readonly at: string;
  readonly partnerId: string;
  readonly userId: string;
  readonly action: string;
  readonly outcome: AccessOutcome | SubmissionOutcome;
  readonly securityEvent: boolean;
  readonly detail: string;
}

/**
 * Record what a partner did. **Refusals are audited as loudly as successes** (hard rule
 * #6): a supplier repeatedly asking for another supplier's invoices is the pattern this
 * exists to make visible, and a system that only logs successes never sees it.
 */
export function auditPartnerAction(input: {
  readonly session: PartnerSession;
  readonly action: string;
  readonly outcome: AccessOutcome | SubmissionOutcome;
  readonly securityEvent?: boolean;
  readonly detail: string;
  readonly at: string;
}): PartnerAuditEntry {
  return {
    at: input.at,
    partnerId: input.session.partnerId,
    userId: input.session.userId,
    action: input.action,
    outcome: input.outcome,
    securityEvent:
      input.securityEvent ??
      (input.outcome === 'not_your_data' || input.outcome === 'not_your_order'),
    detail: input.detail,
  };
}

export interface ProbePattern {
  readonly partnerId: string;
  readonly userId: string;
  readonly attempts: number;
  readonly detail: string;
}

/**
 * Find partners probing for other partners' data. One refusal is a mis-click; a pattern
 * of them is somebody trying doors, and the shop should hear about it from its own system
 * rather than from the supplier whose prices leaked.
 */
export function findProbing(
  entries: readonly PartnerAuditEntry[],
  threshold = 3,
): readonly ProbePattern[] {
  const byUser = new Map<string, PartnerAuditEntry[]>();
  for (const e of entries) {
    if (!e.securityEvent) continue;
    const key = `${e.partnerId}|${e.userId}`;
    byUser.set(key, [...(byUser.get(key) ?? []), e]);
  }
  return [...byUser]
    .filter(([, rows]) => rows.length >= threshold)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, rows]) => {
      const [partnerId, userId] = key.split('|');
      return {
        partnerId: partnerId ?? '',
        userId: userId ?? '',
        attempts: rows.length,
        detail: `${rows.length} attempts to reach another partner's data — one is a mis-click, ${rows.length} is somebody trying doors`,
      };
    });
}
