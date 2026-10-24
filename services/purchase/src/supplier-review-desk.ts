// API-03 the buyer's supplier-submission desk (M24-FR-01 · M24-FR-02 · §28 · P-03 · P-07). OB-288 package 3.
//
// The decide route already existed (`POST /v1/supplier-portal/partners/:id/submissions/:sid/review`) but no screen called
// it, and the queue could be read only one supplier at a time. These reads give the buyer ONE queue:
//   • GET /v1/supplier-portal/review-queue — every supplier's submissions still waiting for a buyer (invoices and ASNs with
//     their documents, catalogue / cost proposals, RFQ replies, claims), oldest first, with the latest decisions beside
//     them; and every order's latest delivery status from its supplier (dispatched / in transit / delayed, with the date).
//   • GET /v1/supplier-portal/orders/:poId/delivery-status — one order's delivery updates, newest first.
// Reads only: the decisions are the existing review route's, in the buyer's own name, never the submitter's.

import type { Route } from '../../kernel/src/index';
import type { SubmissionRecord, SubmissionReview } from './supplier-portal';

export interface SupplierReviewDeskDeps {
  /** Every supplier the portal has met (configured, or submitted). */
  readonly partners: (tenantId: string) => Promise<readonly string[]>;
  readonly submissions: (tenantId: string, partnerId: string) => Promise<readonly SubmissionRecord[]> | readonly SubmissionRecord[];
  readonly reviews: (tenantId: string, partnerId: string) => Promise<readonly SubmissionReview[]> | readonly SubmissionReview[];
  readonly now: () => string;
}

const FEEDING = new Set(['invoice', 'asn']);
const DECIDED_ONLY = new Set(['catalogue', 'rfq_response', 'claim']);

/** Does this submission wait for a buyer's decision? */
export function awaitsBuyer(s: SubmissionRecord): boolean {
  return s.requiresReview && ((FEEDING.has(s.kind) && s.document !== undefined) || DECIDED_ONLY.has(s.kind));
}

interface DeliveryUpdate {
  readonly poId: string; readonly partnerId: string; readonly submissionId: string; readonly status: string;
  readonly expectedOn: string; readonly note: string | null; readonly receivedAt: string; readonly submittedBy: string | null;
}

const deliveryOf = (s: SubmissionRecord): DeliveryUpdate | undefined => {
  if (s.kind !== 'delivery_status' || s.document === undefined) return undefined;
  const d = s.document;
  return {
    poId: String(d['poId']), partnerId: s.partnerId, submissionId: s.submissionId, status: String(d['status']), expectedOn: String(d['expectedOn']),
    note: typeof d['note'] === 'string' ? d['note'] : null, receivedAt: s.receivedAt, submittedBy: s.submittedBy ?? null,
  };
};

export function supplierReviewDeskRoutes(deps: SupplierReviewDeskDeps): readonly Route[] {
  const gather = async (tenantId: string) => {
    const out: { partnerId: string; submissions: readonly SubmissionRecord[]; reviews: readonly SubmissionReview[] }[] = [];
    for (const partnerId of [...new Set(await deps.partners(tenantId))].sort()) {
      out.push({ partnerId, submissions: await deps.submissions(tenantId, partnerId), reviews: await deps.reviews(tenantId, partnerId) });
    }
    return out;
  };
  return [
    {
      api: 'API-03', method: 'GET', path: '/v1/supplier-portal/review-queue',
      permission: 'supplier.portal.review',
      handler: async (ctx) => {
        const all = await gather(ctx.tenantId);
        const waiting = [];
        const decided = [];
        const latestByPo = new Map<string, DeliveryUpdate>();
        for (const p of all) {
          const reviewOf = new Map(p.reviews.map((r) => [r.submissionId, r]));
          for (const s of p.submissions) {
            const review = reviewOf.get(s.submissionId);
            const row = {
              partnerId: p.partnerId, submissionId: s.submissionId, kind: s.kind, receivedAt: s.receivedAt,
              submittedBy: s.submittedBy ?? null, document: s.document ?? null,
              feeds: FEEDING.has(s.kind) ? (s.kind === 'invoice' ? 'the supplier-invoice register (three-way match)' : 'the ASN register (receiving compare)') : null,
            };
            if (review !== undefined) decided.push({ ...row, review });
            else if (awaitsBuyer(s)) waiting.push(row);
            const d = deliveryOf(s);
            if (d !== undefined) {
              const prev = latestByPo.get(d.poId);
              if (prev === undefined || prev.receivedAt <= d.receivedAt) latestByPo.set(d.poId, d);
            }
          }
        }
        waiting.sort((a, b) => (a.receivedAt < b.receivedAt ? -1 : a.receivedAt > b.receivedAt ? 1 : 0));
        decided.sort((a, b) => (a.review.reviewedAt < b.review.reviewedAt ? 1 : -1));
        const deliveries = [...latestByPo.values()].sort((a, b) => (a.expectedOn < b.expectedOn ? -1 : a.expectedOn > b.expectedOn ? 1 : 0));
        return { status: 200, body: { waiting, decided: decided.slice(0, 50), deliveries, suppliers: all.length, asAt: deps.now() } };
      },
    },
    {
      api: 'API-03', method: 'GET', path: '/v1/supplier-portal/orders/:poId/delivery-status',
      permission: 'supplier.portal.review',
      handler: async (ctx) => {
        const poId = (ctx.params['poId'] ?? '').trim();
        const updates: DeliveryUpdate[] = [];
        for (const p of await gather(ctx.tenantId)) for (const s of p.submissions) { const d = deliveryOf(s); if (d !== undefined && d.poId === poId) updates.push(d); }
        updates.sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1));
        // P-08: "no word from the supplier yet" is said as such — never an error, never a made-up status.
        return { status: 200, body: { poId, latest: updates[0] ?? null, updates, asAt: deps.now() } };
      },
    },
  ];
}
