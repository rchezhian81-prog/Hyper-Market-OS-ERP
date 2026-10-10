// API-03 Supplier portal — submissions (M24-FR-02). The portal is the one place a party OUTSIDE the
// business acts on the system, so the rule is absolute: **nothing a supplier submits takes effect on
// its own.** A catalogue, an RFQ response or a claim lands *for review* and a buyer decides (§28); an
// ASN or invoice is accepted only if the partner holds the grant and is compliant, and it still meets
// M07 receiving and the three-way match downstream. A submission naming another supplier's order is
// refused and recorded; a retried one is a duplicate, not a second invoice.
//
// The rule is the pure `acceptSubmission` in `packages/supplier-portal` — another complete engine
// nothing fed on the cloud. The partner's grants come from its stored configuration, never a payload.
//
// SF-09 (Batch 2) — the portal FEEDS purchasing. A submission carries its DOCUMENT (an invoice's own lines, an ASN's
// lines), kept exactly as sent. A supplier submits its own under `supplier.portal.self.submit` (the partner is the
// login's binding, never the request); an order the document names is looked up on head office's register and must be
// that supplier's. An invoice or ASN then waits for a BUYER (never the person who submitted it) to review it: accepted,
// the invoice is captured onto the supplier-invoice register (the three-way match reads it) and the ASN onto the ASN
// register (the ASN compare reads it); rejected, it feeds nothing — and the reason is kept beside it.

import type { Route, RequestContext } from '../../kernel/src/index';
import type { Asn, AsnLine } from '../../../packages/receiving/src/asn';
import { apiError, notFound, documentsVerifiedByTheCaller } from '../../kernel/src/index';
import {
  acceptSubmission, checkPartnerCompliance, buildStatement, auditPartnerAction, findProbing, scopeToPartner,
  type PortalGrant, type SubmissionKind, type PartnerDocument, type PartnerDocumentKind, type StatementLine,
  type PartnerAuditEntry, type PartnerSession,
} from '../../../packages/supplier-portal/src/index';

export type { PartnerDocument, StatementLine, PartnerAuditEntry } from '../../../packages/supplier-portal/src/index';

const GRANTS: readonly PortalGrant[] = ['view_orders', 'acknowledge_orders', 'submit_asn', 'submit_invoice', 'submit_catalogue', 'respond_rfq', 'raise_claim', 'view_statement'];
const KINDS: readonly SubmissionKind[] = ['rfq_response', 'catalogue', 'asn', 'invoice', 'po_acknowledgement', 'claim'];
const DOCUMENT_KINDS: readonly PartnerDocumentKind[] = ['fssai_licence', 'gst_registration', 'insurance', 'trade_licence', 'bank_mandate', 'quality_certificate'];
const LINE_KINDS: readonly StatementLine['kind'][] = ['invoice', 'credit_note', 'payment', 'debit_note'];
const LINE_STATUSES: readonly StatementLine['status'][] = ['open', 'settled', 'disputed'];

const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00.000Z`));
const isDateTime = (s: unknown): s is string => typeof s === 'string' && s.trim() !== '' && !Number.isNaN(Date.parse(s));
const isStr = (s: unknown): s is string => typeof s === 'string' && s.trim() !== '';

/**
 * A partner's portal configuration — what this supplier's login may submit, the compliance documents
 * it holds, and which document kinds this tenant requires before an action takes effect. Compliance is
 * NO LONGER a stored boolean: it is derived at the moment of the action from these documents and their
 * expiry, so a licence that lapsed after the config was set blocks the very next delivery (M24-FR-03).
 */
export interface PartnerConfig {
  readonly grants: readonly PortalGrant[];
  readonly documents: readonly PartnerDocument[];
  readonly requiredDocuments: readonly PartnerDocumentKind[];
  /**
   * The user id(s) that ARE this supplier's portal login(s) — the buyer binds them here (M24-FR-01, §35).
   *
   * This is the ONLY place a user is bound to a partner, and it is set by the BUYER configuring the
   * partner, never by the supplier. A supplier-facing read then derives its partner id from this binding
   * (the adapter folds it into a login index), so the partner id it is scoped to comes from the
   * authenticated session, not from anything the supplier's request carries. Optional (default none) so a
   * partner with no portal login yet is still configurable.
   */
  readonly logins: readonly string[];
}

/** Read a partner's documents from a payload, stamping the partner id from the PATH — never the body,
 *  the same rule the rest of the portal applies (another supplier's documents are never cover). */
function readDocuments(v: unknown, partnerId: string): readonly PartnerDocument[] | undefined {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return undefined;
  const out: PartnerDocument[] = [];
  for (const raw of v) {
    const d = raw as Record<string, unknown>;
    if (!isStr(d['documentId']) || !DOCUMENT_KINDS.includes(d['kind'] as PartnerDocumentKind) || !isStr(d['reference'])
      || !isDate(d['validFrom']) || !isDate(d['validUntil'])
      || (d['verifiedBy'] !== undefined && !isStr(d['verifiedBy']))
      || (d['verifiedAt'] !== undefined && !isDateTime(d['verifiedAt']))) {
      return undefined;
    }
    out.push({
      documentId: d['documentId'] as string, partnerId, kind: d['kind'] as PartnerDocumentKind,
      reference: d['reference'] as string, validFrom: d['validFrom'] as string, validUntil: d['validUntil'] as string,
      ...(isStr(d['verifiedBy']) ? { verifiedBy: d['verifiedBy'] } : {}),
      ...(isDateTime(d['verifiedAt']) ? { verifiedAt: d['verifiedAt'] } : {}),
    });
  }
  return out;
}

/** A submission as it is persisted — enough to list the review queue and refuse a duplicate. */
export interface SubmissionRecord {
  readonly submissionId: string;
  readonly partnerId: string;
  readonly kind: SubmissionKind;
  readonly requiresReview: boolean;
  readonly receivedAt: string;
  /** SF-09: the document exactly as the supplier sent it (an invoice's lines, an ASN's lines) — never rewritten. */
  readonly document?: Readonly<Record<string, unknown>>;
  /** SF-09: who submitted it — the supplier's own login, or the buyer keying it in. */
  readonly submittedBy?: string;
}

/** SF-09: a buyer's decision on an invoice / ASN submission — append-only beside it; what it fed, when accepted. */
export interface SubmissionReview {
  readonly submissionId: string;
  readonly partnerId: string;
  readonly decision: 'accepted' | 'rejected';
  readonly reason: string;
  readonly reviewedBy: string;
  readonly reviewedAt: string;
  readonly fed: { readonly invoiceId: string } | { readonly asnId: string } | null;
}

/** The kinds whose document feeds purchasing once a buyer accepts it. */
const FEEDING: readonly SubmissionKind[] = ['invoice', 'asn'];

const isObjRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNonNegIntV = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

/** The ORDER a document names, when it names one (its `poId`). */
const poOf = (document: Readonly<Record<string, unknown>> | undefined): string | undefined =>
  document !== undefined && isStr(document['poId']) ? (document['poId'] as string).trim() : undefined;

/** Read an invoice / ASN document's SHAPE (its arithmetic is head office's to re-check at review); other kinds: any object. */
function documentProblem(kind: SubmissionKind, document: unknown, required: boolean): string | undefined {
  if (document === undefined) return required && FEEDING.includes(kind) ? `a${kind === 'asn' ? 'n ASN' : 'n invoice'} submission needs its document` : undefined;
  if (!isObjRec(document)) return 'the document is not readable';
  if (document['supplierId'] !== undefined) return 'the document names a supplier — the supplier is the partner the submission is from, never a field';
  if (document['poId'] !== undefined && !isStr(document['poId'])) return 'poId must be text';
  if (kind === 'invoice') {
    if (!isStr(document['invoiceId']) || !isNonNegIntV(document['declaredTotalMinor']) || !Array.isArray(document['lines']) || document['lines'].length === 0) {
      return 'an invoice document needs { invoiceId, declaredTotalMinor, lines: [{ productId, quantity, unitPriceMinor, lineTotalMinor, uom? }], poId? }';
    }
  }
  if (kind === 'asn') {
    const lines = document['lines'];
    if (!isStr(document['asnId']) || !isStr(document['expectedAt']) || !Array.isArray(lines) || lines.length === 0
      || !lines.every((l) => isObjRec(l) && isStr(l['lineId']) && isStr(l['productId']) && isNonNegIntV(l['quantityMinor']) && isStr(l['uom']))) {
      return 'an ASN document needs { asnId, expectedAt, lines: [{ lineId, productId, quantityMinor, uom, batchId?, expiry? }], poId? }';
    }
  }
  return undefined;
}

/** The ASN an accepted ASN document becomes — the supplier stamped from the partner, never the document. */
function asnFrom(document: Readonly<Record<string, unknown>>, partnerId: string): Asn {
  const lines = (document['lines'] as Record<string, unknown>[]).map((l): AsnLine => ({
    lineId: l['lineId'] as string, productId: l['productId'] as string, quantityMinor: l['quantityMinor'] as number, uom: l['uom'] as string,
    ...(isStr(l['batchId']) ? { batchId: l['batchId'] } : {}), ...(isStr(l['expiry']) ? { expiry: l['expiry'] } : {}),
  }));
  return { asnId: document['asnId'] as string, supplierId: partnerId, expectedAt: document['expectedAt'] as string, lines, ...(isStr(document['poId']) ? { poId: document['poId'] } : {}) };
}

export interface SupplierPortalDeps {
  readonly partner: (tenantId: string, partnerId: string) => Promise<PartnerConfig | undefined> | PartnerConfig | undefined;
  /**
   * Which partner (if any) this authenticated user is a portal login for (M24-FR-01, §35). Resolved from
   * the stored `logins` binding, NEVER from the request — this is what makes "a supplier sees only its own
   * data" a server-side fact. `undefined` when the login is bound to no partner (not a supplier login).
   */
  readonly partnerForUser: (tenantId: string, userId: string) => Promise<string | undefined> | string | undefined;
  readonly submissions: (tenantId: string, partnerId: string) => Promise<readonly SubmissionRecord[]> | readonly SubmissionRecord[];
  readonly statementLines: (tenantId: string, partnerId: string) => Promise<readonly StatementLine[]> | readonly StatementLine[];
  readonly opening: (tenantId: string, partnerId: string) => Promise<number> | number;
  readonly recordPartner: (tenantId: string, partnerId: string, config: PartnerConfig, at: string) => Promise<void> | void;
  readonly recordSubmission: (tenantId: string, partnerId: string, record: SubmissionRecord) => Promise<void> | void;
  readonly recordStatementLine: (tenantId: string, partnerId: string, line: StatementLine) => Promise<void> | void;
  readonly recordOpening: (tenantId: string, partnerId: string, openingMinor: number) => Promise<void> | void;
  /** Append a partner-action audit entry. Refusals are recorded as loudly as successes (hard rule #6);
   *  the caller keys it on the action so a re-sync of the same attempt is one entry, not two. */
  readonly recordAudit: (tenantId: string, entry: PartnerAuditEntry, key: string) => Promise<void> | void;
  /** Every partner-action audit entry for the tenant — what `findProbing` reads across partners. */
  readonly auditEntries: (tenantId: string) => Promise<readonly PartnerAuditEntry[]> | readonly PartnerAuditEntry[];
  /** SF-09: the supplier an order on head office's register is with, or undefined when there is no such order. */
  readonly orderSupplier?: (tenantId: string, poId: string) => Promise<string | undefined> | string | undefined;
  /** SF-09: the buyer decisions on this partner's submissions (append-only). */
  readonly reviews?: (tenantId: string, partnerId: string) => Promise<readonly SubmissionReview[]> | readonly SubmissionReview[];
  readonly recordReview?: (tenantId: string, review: SubmissionReview) => Promise<void> | void;
  /** SF-09: capture an accepted invoice onto the supplier-invoice register (`capturePortalInvoice`). */
  readonly captureInvoice?: (tenantId: string, input: {
    readonly invoiceId: string; readonly supplierId: string; readonly poId: string | null; readonly declaredTotalMinor: number; readonly lines: unknown;
    readonly submittedBy: string; readonly reviewedBy: string; readonly submissionId: string; readonly branchId: string | null;
  }) => Promise<{ readonly ok: true } | { readonly ok: false; readonly code: string; readonly detail: string }>;
  /** SF-09: record an accepted ASN on the ASN register the compare route reads. */
  readonly recordAsn?: (tenantId: string, asn: Asn, at: string) => Promise<void> | void;
  readonly now: () => string;
}

export function supplierPortalRoutes(deps: SupplierPortalDeps): readonly Route[] {
  // Resolve the authenticated caller's OWN supplier session for a /me read (M24-FR-01, §35). The partner
  // id comes from the stored login binding, never the request; a login bound to no partner is refused as
  // "not a supplier login". Returns the session the scoped read runs against.
  const meSession = async (tenantId: string, userId: string): Promise<PartnerSession> => {
    const partnerId = await deps.partnerForUser(tenantId, userId);
    if (partnerId === undefined) {
      throw apiError(403, {
        code: 'not_a_supplier_login',
        whatHappened: 'This login is not bound to any supplier, so it has no supplier portal data of its own.',
        wasItSaved: 'not_saved',
        nextSafeAction: 'A buyer binds a login to a supplier when they configure the partner (the partner\'s "logins").',
      });
    }
    const config = await deps.partner(tenantId, partnerId);
    if (config === undefined) throw notFound(`supplier-portal partner ${partnerId}`);
    return { sessionId: `portal-${partnerId}`, partnerId, tenantId, userId, grants: config.grants };
  };

  // Turn a scope decision into either the caller's own rows or a recorded refusal (M24-FR-01/04). A
  // request naming another partner is a security event: recorded on the tenant's audit trail (so
  // `findProbing` surfaces a pattern of it — hard rule #6) and refused 403 — NOT silently emptied. A
  // login without the read grant is a permission answer, also 403, never an empty list read as "nothing".
  const scopedOrRefused = async <T extends { readonly partnerId: string; readonly tenantId?: string }>(
    tenantId: string, session: PartnerSession, rows: readonly T[], grant: PortalGrant,
    requestedPartnerId: string | undefined, action: string,
  ): Promise<readonly T[]> => {
    const decision = scopeToPartner({ session, rows, grant, ...(requestedPartnerId === undefined ? {} : { requestedPartnerId }) });
    if (decision.securityEvent) {
      const entry = auditPartnerAction({ session, action, outcome: decision.outcome, detail: decision.detail, at: deps.now() });
      // Keyed on the FOREIGN partner asked for, so repeated distinct probes each count (a pattern) while
      // an identical retry collapses to one entry.
      await deps.recordAudit(tenantId, entry, `${session.partnerId}-${session.userId}-${action}-${requestedPartnerId ?? ''}`);
    }
    if (!decision.allowed) {
      throw apiError(403, {
        code: decision.outcome,
        whatHappened: decision.detail,
        wasItSaved: 'not_saved',
        nextSafeAction: decision.outcome === 'not_your_data'
          ? 'You can only see your own data. This attempt was recorded.'
          : 'Ask the buyer to grant this on your portal login.',
      });
    }
    return decision.rows;
  };

  /**
   * Receive one submission for `partnerId` from `submittedBy` — shared by the buyer-keyed route and the supplier's own
   * (`/me`) route. The order a document names is looked up on head office's register (SF-09) — never taken from the body;
   * every outcome is audited before a refusal throws (hard rule #6).
   */
  // `documentRequired`: a supplier's OWN invoice / ASN must carry its paper (SF-09); a buyer logging that a supplier sent
  // something may record it without — it then feeds nothing until a submission with the document arrives.
  const receive = async (ctx: RequestContext, partnerId: string, submittedBy: string, documentRequired: boolean): Promise<{ status: number; body: unknown }> => {
    const b = (ctx.body ?? {}) as { submissionId?: unknown; kind?: unknown; orderPartnerId?: unknown; document?: unknown };
    if (typeof b.submissionId !== 'string' || b.submissionId.trim() === '' || typeof b.kind !== 'string' || !KINDS.includes(b.kind as SubmissionKind)) {
      throw apiError(400, {
        code: 'not_readable_as_a_submission',
        whatHappened: 'A submission needs a submission id and a kind (rfq_response, catalogue, asn, invoice, po_acknowledgement or claim).',
        wasItSaved: 'not_saved',
        nextSafeAction: 'Send the submission id and kind. Nothing was received.',
      });
    }
    const kind = b.kind as SubmissionKind;
    const problem = documentProblem(kind, b.document, documentRequired);
    if (problem !== undefined) {
      throw apiError(400, { code: 'not_readable_as_a_document', whatHappened: `${problem}.`, wasItSaved: 'not_saved', nextSafeAction: 'Send the document as the paper says it. Nothing was received.' });
    }
    const document = b.document as Readonly<Record<string, unknown>> | undefined;

    const config = await deps.partner(ctx.tenantId, partnerId);
    if (config === undefined) throw notFound(`supplier-portal partner ${partnerId}`);
    const prior = await deps.submissions(ctx.tenantId, partnerId);

    // SF-09: the order a document names is head office's to say whose it is — never the body's word.
    const poId = poOf(document);
    let orderPartnerId: string | undefined = typeof b.orderPartnerId === 'string' ? b.orderPartnerId : undefined;
    if (poId !== undefined && deps.orderSupplier !== undefined) {
      const supplier = await deps.orderSupplier(ctx.tenantId, poId);
      if (supplier === undefined) {
        throw apiError(422, { code: 'order_unknown', whatHappened: `There is no purchase order ${poId} on head office's register.`, wasItSaved: 'not_saved', nextSafeAction: 'Check the order number on the paper. Nothing was received.' });
      }
      orderPartnerId = supplier;
    }

    const compliance = checkPartnerCompliance({
      partnerId, documents: config.documents, required: config.requiredDocuments, today: deps.now().slice(0, 10),
    });
    const session = { sessionId: `portal-${partnerId}`, partnerId, tenantId: ctx.tenantId, userId: submittedBy, grants: config.grants };
    const result = acceptSubmission({
      submissionId: b.submissionId, session, kind, compliance,
      ...(orderPartnerId === undefined ? {} : { orderPartnerId }),
      alreadySubmittedIds: prior.map((s) => s.submissionId),
      at: deps.now(),
    });
    const entry = auditPartnerAction({ session, action: `submit:${kind}`, outcome: result.outcome, detail: result.detail, at: deps.now() });
    await deps.recordAudit(ctx.tenantId, entry, `${partnerId}-${b.submissionId}-${result.outcome}`);
    if (!result.accepted) {
      throw apiError(422, {
        code: result.outcome,
        whatHappened: result.detail,
        wasItSaved: 'not_saved',
        nextSafeAction: 'Nothing was accepted. Check the grant, the compliance documents and that the order belongs to this supplier.',
      });
    }
    // SF-09: an invoice / ASN with its document waits for a buyer before it feeds purchasing.
    const awaitsBuyer = document !== undefined && FEEDING.includes(kind);
    const record: SubmissionRecord = {
      submissionId: b.submissionId, partnerId, kind, requiresReview: result.requiresReview || awaitsBuyer, receivedAt: deps.now(),
      ...(document === undefined ? {} : { document }), submittedBy,
    };
    await deps.recordSubmission(ctx.tenantId, partnerId, record);
    return { status: 201, body: { submissionId: b.submissionId, partnerId, kind, accepted: true, requiresReview: record.requiresReview, ...(awaitsBuyer ? { awaiting: 'buyer_review' } : {}) } };
  };

  const reviewOf = async (tenantId: string, partnerId: string, submissionId: string): Promise<SubmissionReview | undefined> =>
    (await deps.reviews?.(tenantId, partnerId) ?? []).find((r) => r.submissionId === submissionId);
  const present = (s: SubmissionRecord, review: SubmissionReview | undefined) => ({
    submissionId: s.submissionId, kind: s.kind, requiresReview: s.requiresReview, receivedAt: s.receivedAt,
    ...(s.submittedBy === undefined ? {} : { submittedBy: s.submittedBy }),
    ...(s.document === undefined ? {} : { document: s.document }),
    review: review === undefined ? (s.document !== undefined && FEEDING.includes(s.kind) ? 'awaiting_buyer' : null) : review,
  });

  return [
    {
      // Configure a partner's grants, compliance documents and the document kinds this tenant requires.
      // Latest configuration applies. Compliance is derived at the action, not stored as a flag.
      api: 'API-03', method: 'POST', path: '/v1/supplier-portal/partners/:partnerId',
      permission: 'supplier.portal.manage', idempotent: true,
      handler: async (ctx) => {
        const partnerId = ctx.params['partnerId'] ?? '';
        const b = (ctx.body ?? {}) as { grants?: unknown; documents?: unknown; requiredDocuments?: unknown; logins?: unknown };
        const documents = readDocuments(b.documents, partnerId);
        if (!Array.isArray(b.grants) || !b.grants.every((g) => (GRANTS as readonly string[]).includes(g as string))
          || documents === undefined
          || (b.requiredDocuments !== undefined && (!Array.isArray(b.requiredDocuments) || !b.requiredDocuments.every((k) => DOCUMENT_KINDS.includes(k as PartnerDocumentKind))))
          || (b.logins !== undefined && (!Array.isArray(b.logins) || !b.logins.every((u) => isStr(u))))) {
          throw apiError(400, {
            code: 'not_readable_as_a_partner',
            whatHappened: 'A partner needs a list of valid portal grants, optional compliance documents ({ documentId, kind, reference, validFrom, validUntil, verifiedBy? — yourself, if you verified it }), the document kinds it requires, and the user id(s) that are its portal logins.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send { "grants": [...], "documents": [...], "requiredDocuments": [...], "logins": [...] }. Nothing was configured.',
          });
        }
        const requiredDocuments = (b.requiredDocuments as PartnerDocumentKind[] | undefined) ?? [];
        const logins = (b.logins as string[] | undefined) ?? [];
        // A verified document is cover for an ASN or an invoice (M24-FR-03), so who verified it is the person who did,
        // under their own sign-in (2b-vi-c, PA-03): verified now → the caller; re-sent exactly as stored → kept.
        const now = deps.now();
        const verified = documentsVerifiedByTheCaller(ctx, documents, (await deps.partner(ctx.tenantId, partnerId))?.documents ?? [], now);
        await deps.recordPartner(ctx.tenantId, partnerId, { grants: b.grants as PortalGrant[], documents: verified, requiredDocuments, logins }, now);
        return { status: 201, body: { partnerId, grants: b.grants, documents: verified.length, requiredDocuments, logins: logins.length } };
      },
    },
    {
      // Receive a supplier submission. Nothing takes effect on its own — a catalogue/RFQ/claim is
      // queued for a buyer; an ASN/invoice needs the grant and compliance. The partner's grants come
      // from its stored config, never the payload.
      api: 'API-03', method: 'POST', path: '/v1/supplier-portal/partners/:partnerId/submissions',
      permission: 'supplier.portal.submit', idempotent: true,
      // Compliance AT THE ACTION (M24-FR-03), every outcome audited before a refusal throws (hard rule #6) — `receive`.
      handler: async (ctx) => receive(ctx, ctx.params['partnerId'] ?? '', ctx.userId, false),
    },
    {
      // SF-09 — a SUPPLIER submits its OWN document (an invoice, an ASN …) through the portal. The partner is the caller's
      // stored login binding (M24-FR-01, §35) — there is no partner id in the request to change. Body: { submissionId,
      // kind, document }. An invoice / ASN then waits for a buyer's review before it feeds purchasing.
      api: 'API-03', method: 'POST', path: '/v1/supplier-portal/me/submissions',
      permission: 'supplier.portal.self.submit', idempotent: true,
      handler: async (ctx) => {
        const session = await meSession(ctx.tenantId, ctx.userId);
        return receive(ctx, session.partnerId, ctx.userId, true);
      },
    },
    {
      // SF-09 — a BUYER reviews an invoice / ASN a supplier submitted. Body: { decision: 'accept' | 'reject', reason }.
      // Never the person who submitted it (§28). Accepted: the invoice is captured onto the supplier-invoice register (the
      // three-way match reads it) / the ASN onto the ASN register (the compare reads it) — exactly as the supplier sent it.
      // Rejected: it feeds nothing. Once per submission: the same decision again is 200, a different one 409.
      api: 'API-03', method: 'POST', path: '/v1/supplier-portal/partners/:partnerId/submissions/:submissionId/review',
      permission: 'supplier.portal.review', idempotent: true,
      handler: async (ctx) => {
        const partnerId = (ctx.params['partnerId'] ?? '').trim();
        const submissionId = (ctx.params['submissionId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const decision = b['decision'] === 'accept' ? 'accepted' : b['decision'] === 'reject' ? 'rejected' : undefined;
        if (decision === undefined || !isStr(b['reason'])) {
          throw apiError(400, { code: 'not_readable_as_a_review', whatHappened: 'A review needs { decision: "accept" | "reject", reason }.', wasItSaved: 'not_saved', nextSafeAction: 'Send the decision and why. Nothing was decided.' });
        }
        const submission = (await deps.submissions(ctx.tenantId, partnerId)).find((s) => s.submissionId === submissionId);
        if (submission === undefined) throw notFound(`submission ${submissionId} from supplier ${partnerId}`);
        if (submission.document === undefined || !FEEDING.includes(submission.kind)) {
          throw apiError(409, { code: 'nothing_to_feed', whatHappened: `Submission ${submissionId} is a ${submission.kind.replace(/_/g, ' ')}${submission.document === undefined ? ' with no document' : ''} — only an invoice or an ASN with its document feeds purchasing.`, wasItSaved: 'not_saved', nextSafeAction: 'Nothing was decided.' });
        }
        const prior = await reviewOf(ctx.tenantId, partnerId, submissionId);
        if (prior !== undefined) {
          if (prior.decision === decision) return { status: 200, body: { review: prior, alreadyReviewed: true } };
          throw apiError(409, { code: 'already_reviewed', whatHappened: `${prior.reviewedBy} already ${prior.decision} submission ${submissionId} at ${prior.reviewedAt}; a second decision would be a second truth.`, wasItSaved: 'not_saved', nextSafeAction: 'Read the submission again.' });
        }
        if (submission.submittedBy === ctx.userId) {
          throw apiError(403, { code: 'self_review', whatHappened: `${ctx.userId} submitted ${submissionId} and cannot also review it (§28).`, wasItSaved: 'not_saved', nextSafeAction: 'A different buyer reviews it. Nothing was decided.' });
        }
        const doc = submission.document;
        let fed: SubmissionReview['fed'] = null;
        const at = deps.now();
        if (decision === 'accepted') {
          if (submission.kind === 'invoice') {
            if (deps.captureInvoice === undefined) throw apiError(503, { code: 'invoice_register_unavailable', whatHappened: 'The supplier-invoice register is not wired here.', wasItSaved: 'not_saved', nextSafeAction: 'Try again later. Nothing was decided.' });
            const out = await deps.captureInvoice(ctx.tenantId, {
              invoiceId: doc['invoiceId'] as string, supplierId: partnerId, poId: poOf(doc) ?? null, declaredTotalMinor: doc['declaredTotalMinor'] as number,
              lines: doc['lines'], submittedBy: submission.submittedBy ?? partnerId, reviewedBy: ctx.userId, submissionId, branchId: ctx.branchId ?? null,
            });
            if (!out.ok) throw apiError(422, { code: out.code, whatHappened: `The invoice cannot be accepted: ${out.detail}.`, wasItSaved: 'not_saved', nextSafeAction: 'Reject it with the reason, so the supplier can send a corrected invoice. Nothing was captured.' });
            fed = { invoiceId: doc['invoiceId'] as string };
          } else {
            if (deps.recordAsn === undefined) throw apiError(503, { code: 'asn_register_unavailable', whatHappened: 'The ASN register is not wired here.', wasItSaved: 'not_saved', nextSafeAction: 'Try again later. Nothing was decided.' });
            const asn = asnFrom(doc, partnerId);
            await deps.recordAsn(ctx.tenantId, asn, at);
            fed = { asnId: asn.asnId };
          }
        }
        const review: SubmissionReview = { submissionId, partnerId, decision, reason: (b['reason'] as string).trim(), reviewedBy: ctx.userId, reviewedAt: at, fed };
        await deps.recordReview?.(ctx.tenantId, review);
        return { status: 201, body: { review, alreadyReviewed: false } };
      },
    },
    {
      // The buyer's review queue — what a supplier submitted that a person must decide on before it
      // has any effect. `?review=true` narrows to the submissions still awaiting review.
      api: 'API-03', method: 'GET', path: '/v1/supplier-portal/partners/:partnerId/submissions',
      permission: 'supplier.portal.review',
      handler: async (ctx) => {
        const partnerId = ctx.params['partnerId'] ?? '';
        const reviewOnly = ctx.query['review'] === 'true';
        const all = await deps.submissions(ctx.tenantId, partnerId);
        const reviews = await deps.reviews?.(ctx.tenantId, partnerId) ?? [];
        const decided = new Set(reviews.map((r) => r.submissionId));
        // SF-09: `?review=true` lists what still waits for a person — a document already decided no longer does.
        const rows = reviewOnly ? all.filter((s) => s.requiresReview && !decided.has(s.submissionId)) : all;
        return {
          status: 200,
          body: { partnerId, submissions: rows.map((s) => present(s, reviews.find((r) => r.submissionId === s.submissionId))), asAt: deps.now() },
        };
      },
    },
    {
      // Why a partner can (or cannot) trade, checked against a date — so a buyer sees the expiring
      // document to chase BEFORE it blocks a delivery, not the block after. `?asOf=` defaults to today.
      api: 'API-03', method: 'GET', path: '/v1/supplier-portal/partners/:partnerId/compliance',
      permission: 'supplier.portal.review',
      handler: async (ctx) => {
        const partnerId = ctx.params['partnerId'] ?? '';
        const asOf = ctx.query['asOf'];
        if (asOf !== undefined && !isDate(asOf)) throw apiError(400, { code: 'compliance_needs_a_valid_date', whatHappened: 'The compliance check needs ?asOf=YYYY-MM-DD, or none to use today.', wasItSaved: 'not_saved', nextSafeAction: 'Send a valid date or omit it. A check reads, it never writes.' });
        const config = await deps.partner(ctx.tenantId, partnerId);
        if (config === undefined) throw notFound(`supplier-portal partner ${partnerId}`);
        const check = checkPartnerCompliance({
          partnerId, documents: config.documents, required: config.requiredDocuments, today: isDate(asOf) ? asOf : deps.now().slice(0, 10),
        });
        return { status: 200, body: check };
      },
    },
    {
      // Set the opening balance a statement builds from (e.g. a migrated figure). Latest applies.
      api: 'API-03', method: 'POST', path: '/v1/supplier-portal/partners/:partnerId/statement/opening',
      permission: 'supplier.portal.manage', idempotent: true,
      handler: async (ctx) => {
        const partnerId = ctx.params['partnerId'] ?? '';
        const openingMinor = (ctx.body as { openingMinor?: unknown } | null)?.openingMinor;
        if (typeof openingMinor !== 'number' || !Number.isInteger(openingMinor)) {
          throw apiError(400, { code: 'opening_needs_a_whole_number', whatHappened: 'The opening balance is a whole number of minor units (it may be negative).', wasItSaved: 'not_saved', nextSafeAction: 'Send { "openingMinor": <integer> }. Nothing was set.' });
        }
        if (await deps.partner(ctx.tenantId, partnerId) === undefined) throw notFound(`supplier-portal partner ${partnerId}`);
        await deps.recordOpening(ctx.tenantId, partnerId, openingMinor);
        return { status: 201, body: { partnerId, openingMinor } };
      },
    },
    {
      // Record a statement line — an invoice, credit note, payment or debit note. The amount is SIGNED
      // (an invoice increases what is owed, a payment reduces it); a disputed line is carried but never
      // folded into the balance. The document ref comes from the PATH; the partner id never from a body.
      api: 'API-03', method: 'POST', path: '/v1/supplier-portal/partners/:partnerId/statement/lines/:documentRef',
      permission: 'supplier.portal.manage', idempotent: true,
      handler: async (ctx) => {
        const partnerId = ctx.params['partnerId'] ?? '';
        const documentRef = ctx.params['documentRef'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!LINE_KINDS.includes(b['kind'] as StatementLine['kind']) || !isDate(b['date'])
          || typeof b['amountMinor'] !== 'number' || !Number.isInteger(b['amountMinor'])
          || (b['status'] !== undefined && !LINE_STATUSES.includes(b['status'] as StatementLine['status']))) {
          throw apiError(400, { code: 'not_readable_as_a_statement_line', whatHappened: 'A statement line needs a kind (invoice/credit_note/payment/debit_note), a date, a signed whole-number amount, and an optional status (open/settled/disputed).', wasItSaved: 'not_saved', nextSafeAction: 'Send the line fields. Nothing was recorded.' });
        }
        if (await deps.partner(ctx.tenantId, partnerId) === undefined) throw notFound(`supplier-portal partner ${partnerId}`);
        const line: StatementLine = {
          partnerId, tenantId: ctx.tenantId, documentRef,
          kind: b['kind'] as StatementLine['kind'], date: b['date'] as string,
          amountMinor: b['amountMinor'] as number,
          status: (b['status'] as StatementLine['status'] | undefined) ?? 'open',
        };
        await deps.recordStatementLine(ctx.tenantId, partnerId, line);
        return { status: 201, body: { partnerId, documentRef, kind: line.kind, status: line.status } };
      },
    },
    {
      // The partner's statement — closing balance built from named buckets and cross-checked a second
      // way (`reconciles` goes false rather than letting an uncategorised line vanish); a disputed line
      // shown SEPARATELY; and when the partner's config lacks `view_statement`, a permission answer
      // (`accessible: false`) rather than a balance of zero, because those are not the same thing.
      api: 'API-03', method: 'GET', path: '/v1/supplier-portal/partners/:partnerId/statement',
      permission: 'supplier.portal.review',
      handler: async (ctx) => {
        const partnerId = ctx.params['partnerId'] ?? '';
        const config = await deps.partner(ctx.tenantId, partnerId);
        if (config === undefined) throw notFound(`supplier-portal partner ${partnerId}`);
        const statement = buildStatement({
          session: { sessionId: `portal-${partnerId}`, partnerId, tenantId: ctx.tenantId, userId: ctx.userId, grants: config.grants },
          lines: await deps.statementLines(ctx.tenantId, partnerId),
          openingMinor: await deps.opening(ctx.tenantId, partnerId),
        });
        return { status: 200, body: statement };
      },
    },
    {
      // Partners probing for other partners' data (M24-FR-04). One refusal is a mis-click; a pattern of
      // them is somebody trying doors, and the shop should hear it from its own system rather than from
      // the supplier whose prices leaked. Reads the tenant's audit trail (recorded on every submission
      // above) and runs `findProbing`. `?threshold=` is how many security refusals count as a pattern
      // (default 3). A static path — no `:partnerId` — so it is the tenant-wide security view for a buyer.
      api: 'API-03', method: 'GET', path: '/v1/supplier-portal/probing',
      permission: 'supplier.portal.review',
      handler: async (ctx) => {
        const raw = Number(ctx.query['threshold']);
        const threshold = Number.isInteger(raw) && raw > 0 ? raw : 3;
        const probing = findProbing(await deps.auditEntries(ctx.tenantId), threshold);
        return { status: 200, body: { probing, threshold, count: probing.length, asAt: deps.now() } };
      },
    },
    {
      // A supplier reads its OWN submissions (M24-FR-01, §35). The partner id is the caller's bound
      // partner from the SESSION, never a path or body — there is no `:partnerId` here to change. A
      // request that names another partner via `?partnerId=` is refused AND recorded (a competitor probe
      // is not a UI mistake — it feeds `findProbing`). Gated `supplier.portal.self`: a supplier login sees
      // its own, and a buyer (who does not hold it) uses the partner-scoped review routes above instead.
      api: 'API-03', method: 'GET', path: '/v1/supplier-portal/me/submissions',
      permission: 'supplier.portal.self',
      handler: async (ctx) => {
        const session = await meSession(ctx.tenantId, ctx.userId);
        const requested = isStr(ctx.query['partnerId']) ? ctx.query['partnerId'] : undefined;
        const rows = await scopedOrRefused(ctx.tenantId, session, await deps.submissions(ctx.tenantId, session.partnerId), 'view_orders', requested, 'read:submissions');
        const reviews = await deps.reviews?.(ctx.tenantId, session.partnerId) ?? [];
        return {
          status: 200,
          // SF-09: the supplier sees its own document and where the buyer's review has got to (the reviewer's reason with it).
          body: { partnerId: session.partnerId, submissions: rows.map((s) => present(s, reviews.find((r) => r.submissionId === s.submissionId))), asAt: deps.now() },
        };
      },
    },
    {
      // A supplier reads its OWN statement (M24-FR-01, §35) — the closing balance built from its own lines
      // only, disputed shown separately, `accessible:false` (not a zero) when the login lacks the grant.
      // Same session-scoping as above; a `?partnerId=` naming another partner is refused and recorded.
      api: 'API-03', method: 'GET', path: '/v1/supplier-portal/me/statement',
      permission: 'supplier.portal.self',
      handler: async (ctx) => {
        const session = await meSession(ctx.tenantId, ctx.userId);
        const requested = isStr(ctx.query['partnerId']) ? ctx.query['partnerId'] : undefined;
        // Probe check first (records + refuses a cross-partner ask) — buildStatement scopes internally too,
        // but only the explicit requested-partner comparison turns a probe into the recorded security event.
        await scopedOrRefused(ctx.tenantId, session, await deps.statementLines(ctx.tenantId, session.partnerId), 'view_statement', requested, 'read:statement');
        const statement = buildStatement({
          session,
          lines: await deps.statementLines(ctx.tenantId, session.partnerId),
          openingMinor: await deps.opening(ctx.tenantId, session.partnerId),
        });
        return { status: 200, body: statement };
      },
    },
  ];
}
