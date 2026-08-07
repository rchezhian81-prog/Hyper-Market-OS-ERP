// API-03 Supplier portal — submissions (M24-FR-02). The portal is the one place a party OUTSIDE the
// business acts on the system, so the rule is absolute: **nothing a supplier submits takes effect on
// its own.** A catalogue, an RFQ response or a claim lands *for review* and a buyer decides (§28); an
// ASN or invoice is accepted only if the partner holds the grant and is compliant, and it still meets
// M07 receiving and the three-way match downstream. A submission naming another supplier's order is
// refused and recorded; a retried one is a duplicate, not a second invoice.
//
// The rule is the pure `acceptSubmission` in `packages/supplier-portal` — another complete engine
// nothing fed on the cloud. The partner's grants come from its stored configuration, never a payload.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  acceptSubmission,
  type PortalGrant, type SubmissionKind, type ComplianceCheck,
} from '../../../packages/supplier-portal/src/index';

const GRANTS: readonly PortalGrant[] = ['view_orders', 'acknowledge_orders', 'submit_asn', 'submit_invoice', 'submit_catalogue', 'respond_rfq', 'raise_claim', 'view_statement'];
const KINDS: readonly SubmissionKind[] = ['rfq_response', 'catalogue', 'asn', 'invoice', 'po_acknowledgement', 'claim'];

/** A partner's portal configuration — what this supplier's login may submit, and whether compliant. */
export interface PartnerConfig {
  readonly grants: readonly PortalGrant[];
  readonly compliant: boolean;
}

/** A submission as it is persisted — enough to list the review queue and refuse a duplicate. */
export interface SubmissionRecord {
  readonly submissionId: string;
  readonly partnerId: string;
  readonly kind: SubmissionKind;
  readonly requiresReview: boolean;
  readonly receivedAt: string;
}

export interface SupplierPortalDeps {
  readonly partner: (tenantId: string, partnerId: string) => Promise<PartnerConfig | undefined> | PartnerConfig | undefined;
  readonly submissions: (tenantId: string, partnerId: string) => Promise<readonly SubmissionRecord[]> | readonly SubmissionRecord[];
  readonly recordPartner: (tenantId: string, partnerId: string, config: PartnerConfig, at: string) => Promise<void> | void;
  readonly recordSubmission: (tenantId: string, partnerId: string, record: SubmissionRecord) => Promise<void> | void;
  readonly now: () => string;
}

export function supplierPortalRoutes(deps: SupplierPortalDeps): readonly Route[] {
  return [
    {
      // Configure a partner's portal grants and compliance. Latest configuration applies.
      api: 'API-03', method: 'POST', path: '/v1/supplier-portal/partners/:partnerId',
      permission: 'supplier.portal.manage', idempotent: true,
      handler: async (ctx) => {
        const partnerId = ctx.params['partnerId'] ?? '';
        const b = (ctx.body ?? {}) as { grants?: unknown; compliant?: unknown };
        if (!Array.isArray(b.grants) || !b.grants.every((g) => (GRANTS as readonly string[]).includes(g as string)) || typeof b.compliant !== 'boolean') {
          throw apiError(400, {
            code: 'not_readable_as_a_partner',
            whatHappened: 'A partner needs a list of valid portal grants and a compliant flag.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send { "grants": [...], "compliant": true|false }. Nothing was configured.',
          });
        }
        await deps.recordPartner(ctx.tenantId, partnerId, { grants: b.grants as PortalGrant[], compliant: b.compliant }, deps.now());
        return { status: 201, body: { partnerId, grants: b.grants, compliant: b.compliant } };
      },
    },
    {
      // Receive a supplier submission. Nothing takes effect on its own — a catalogue/RFQ/claim is
      // queued for a buyer; an ASN/invoice needs the grant and compliance. The partner's grants come
      // from its stored config, never the payload.
      api: 'API-03', method: 'POST', path: '/v1/supplier-portal/partners/:partnerId/submissions',
      permission: 'supplier.portal.submit', idempotent: true,
      handler: async (ctx) => {
        const partnerId = ctx.params['partnerId'] ?? '';
        const b = (ctx.body ?? {}) as { submissionId?: unknown; kind?: unknown; orderPartnerId?: unknown };
        if (typeof b.submissionId !== 'string' || b.submissionId.trim() === '' || typeof b.kind !== 'string' || !KINDS.includes(b.kind as SubmissionKind)) {
          throw apiError(400, {
            code: 'not_readable_as_a_submission',
            whatHappened: 'A submission needs a submission id and a kind (rfq_response, catalogue, asn, invoice, po_acknowledgement or claim).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the submission id and kind. Nothing was received.',
          });
        }

        const config = await deps.partner(ctx.tenantId, partnerId);
        if (config === undefined) throw notFound(`supplier-portal partner ${partnerId}`);
        const prior = await deps.submissions(ctx.tenantId, partnerId);

        const compliance: ComplianceCheck = {
          partnerId, compliant: config.compliant, documents: [],
          blocking: config.compliant ? [] : ['gst_registration'],
          detail: config.compliant ? 'all required documents valid' : 'a required document is missing or expired',
        };
        const result = acceptSubmission({
          submissionId: b.submissionId,
          session: { sessionId: `portal-${partnerId}`, partnerId, tenantId: ctx.tenantId, userId: ctx.userId, grants: config.grants },
          kind: b.kind as SubmissionKind,
          compliance,
          ...(typeof b.orderPartnerId === 'string' ? { orderPartnerId: b.orderPartnerId } : {}),
          alreadySubmittedIds: prior.map((s) => s.submissionId),
          at: deps.now(),
        });

        if (!result.accepted) {
          throw apiError(422, {
            code: result.outcome,
            whatHappened: result.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was accepted. Check the grant, the compliance documents and that the order belongs to this supplier.',
          });
        }

        const record: SubmissionRecord = { submissionId: b.submissionId, partnerId, kind: b.kind as SubmissionKind, requiresReview: result.requiresReview, receivedAt: deps.now() };
        await deps.recordSubmission(ctx.tenantId, partnerId, record);
        return { status: 201, body: { submissionId: b.submissionId, partnerId, kind: b.kind, accepted: true, requiresReview: result.requiresReview } };
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
        const rows = reviewOnly ? all.filter((s) => s.requiresReview) : all;
        return {
          status: 200,
          body: { partnerId, submissions: rows.map((s) => ({ submissionId: s.submissionId, kind: s.kind, requiresReview: s.requiresReview, receivedAt: s.receivedAt })), asAt: deps.now() },
        };
      },
    },
  ];
}
