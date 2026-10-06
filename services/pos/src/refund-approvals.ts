// A REFUND APPROVAL AT HEAD OFFICE is an approval object the approver gives in their own session — never a name in the
// refund's body (ADR-0022 · Wave 2b-v-c · audit PF-02 · M13-FR-01/02/03 · §28 · hard rules #2, #10).
//
// The audit's reproduction: a desk refund named a provisioned manager in `approvedBy`; the manager never signed in or
// approved, the route checked only that the NAME held the authority, and the refund settled. Now:
//
//   • the approver gives the approval themselves — `POST /v1/pos/refund-approvals`, in THEIR session, holding
//     `pos.return.approve` — for one kind (a refund on a bill, an exchange's refunded difference, a return without a
//     receipt, a return past the shop's window), one bill, one amount and one named person who will process it; never
//     for themselves (§28). It expires after fifteen minutes;
//   • the refund route then names the APPROVAL (`approvalId`), not a person: it must exist, match the refund's kind,
//     bill, amount and processor, not have expired, and not have been used by a different refund; the approver must
//     STILL hold the authority. It is spent in the same atomic batch as the refund, under the same guard that stops two
//     refunds of one bill — so one approval pays one refund, even under two simultaneous requests;
//   • a body that names an approver (`approvedBy`, `outOfWindowApprovedBy`) with no approval behind it is refused.
//
// The store computer's own approvals (ADR-0021) travel on synced refunds and are judged where those are recorded.

import { randomUUID } from 'node:crypto';
import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';

/** What an approval is for. */
export type RefundApprovalKind = 'refund' | 'exchange_refund' | 'no_receipt_return' | 'out_of_window';
const KINDS: readonly RefundApprovalKind[] = ['refund', 'exchange_refund', 'no_receipt_return', 'out_of_window'];
/** How long an approval given at head office stays usable. */
export const REFUND_APPROVAL_MINUTES = 15;
/** The authority to approve a refund; and the authority the person processing it must hold. */
export const REFUND_APPROVE = 'pos.return.approve';
export const REFUND_PROCESS = 'pos.return.record';

export interface RefundApproval {
  readonly approvalId: string;
  readonly kind: RefundApprovalKind;
  /** The bill it is for; `null` only for a return without a receipt. */
  readonly saleId: string | null;
  readonly valueMinor: number;
  /** The person who will process the refund — the one who may use this approval. */
  readonly requestedBy: string;
  readonly approvedBy: string;
  readonly reason: string;
  readonly givenAt: string;
  readonly expiresAt: string;
}

/** An approval and, once spent, the refund that spent it. */
export interface RefundApprovalState {
  readonly approval: RefundApproval;
  readonly usedBy?: string;
}

/** Spend this approval for this refund — appended in the refund's own atomic batch. */
export interface ApprovalUse {
  readonly approvalId: string;
  readonly usedBy: string;
}

export interface RefundApprovalDeps {
  readonly recordRefundApproval: (tenantId: string, approval: RefundApproval) => Promise<void> | void;
  /** The permissions a person holds in this tenant — `undefined` when head office does not know them. */
  readonly permissionsOfUser: (tenantId: string, userId: string) => Promise<readonly string[] | undefined> | readonly string[] | undefined;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

export function refundApprovalRoutes(deps: RefundApprovalDeps): readonly Route[] {
  return [
    {
      // An approver approves ONE refund, in their own session (ADR-0022). The refund then names this approval.
      api: 'API-05', method: 'POST', path: '/v1/pos/refund-approvals',
      permission: REFUND_APPROVE, idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body !== null && typeof ctx.body === 'object' ? ctx.body : {}) as Record<string, unknown>;
        const kind = KINDS.find((k) => k === b['kind']);
        const saleId = isStr(b['saleId']) ? b['saleId'].trim() : null;
        const valueMinor = typeof b['valueMinor'] === 'number' && Number.isSafeInteger(b['valueMinor']) && b['valueMinor'] > 0 ? b['valueMinor'] : undefined;
        const requestedBy = isStr(b['requestedBy']) ? b['requestedBy'].trim() : undefined;
        const reason = isStr(b['reason']) ? b['reason'].trim().slice(0, 300) : undefined;
        if (kind === undefined || valueMinor === undefined || requestedBy === undefined || reason === undefined || (kind !== 'no_receipt_return' && saleId === null)) {
          throw apiError(400, {
            code: 'not_readable_as_a_refund_approval',
            whatHappened: 'An approval names what it is for: the kind (refund, exchange_refund, no_receipt_return or out_of_window), the bill (saleId, except for a return without a receipt), the amount in paise, who will process the refund (requestedBy), and why.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was approved. Send those five things.',
          });
        }
        // §28: the approver is never the person who processes the refund.
        if (requestedBy === ctx.userId) {
          throw apiError(422, {
            code: 'self_approval',
            whatHappened: `${ctx.userId} cannot approve a refund they will process themselves (§28).`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'A different supervisor or manager must approve it. Nothing was approved.',
          });
        }
        const held = await deps.permissionsOfUser(ctx.tenantId, requestedBy);
        if (held === undefined || !held.includes(REFUND_PROCESS)) {
          throw apiError(422, {
            code: held === undefined ? 'requester_unknown' : 'requester_may_not_process_refunds',
            whatHappened: held === undefined
              ? `Head office does not know ${requestedBy}, so an approval cannot be given to them.`
              : `${requestedBy} is not allowed to process refunds, so an approval for them would never be used.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Check who will process the refund. Nothing was approved.',
          });
        }
        const givenAt = deps.now();
        const approval: RefundApproval = {
          approvalId: `rap-${randomUUID()}`, kind, saleId: kind === 'no_receipt_return' ? null : saleId, valueMinor,
          requestedBy, approvedBy: ctx.userId, reason, givenAt,
          expiresAt: new Date(Date.parse(givenAt) + REFUND_APPROVAL_MINUTES * 60_000).toISOString(),
        };
        await deps.recordRefundApproval(ctx.tenantId, approval);
        return { status: 201, body: approval };
      },
    },
  ];
}

/** The approval a refund names — `approvalId` (or another field, e.g. `outOfWindowApprovalId`) — or undefined. */
export function approvalIdIn(body: unknown, field = 'approvalId'): string | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const v = (body as Record<string, unknown>)[field];
  return isStr(v) ? v.trim() : undefined;
}

/** Refused: the body names a person as approver with no approval behind it (the audit's PF-02 reproduction). */
export function namedApproverRefusal(named: string, field: string): Error {
  return apiError(422, {
    code: 'approver_named_without_approval',
    whatHappened: `This refund names ${named} as approver (${field}), but naming a person is not an approval: they never approved it.`,
    wasItSaved: 'not_saved',
    nextSafeAction: 'The approver approves it in their own session (POST /v1/pos/refund-approvals); then send the approvalId it gives. No money has moved.',
  });
}

/**
 * May this refund spend this approval? Bound to the kind, the bill, the amount and the processor; unexpired; not spent
 * by a different refund; and its approver must STILL hold the authority. Resolves the approval or throws the refusal in
 * the desk's words (nothing has moved).
 */
export async function takeRefundApproval(input: {
  readonly state: RefundApprovalState | undefined;
  readonly kind: RefundApprovalKind;
  readonly saleId: string | null;
  readonly valueMinor: number;
  readonly processedBy: string;
  readonly returnId: string;
  readonly now: string;
  readonly canApprove: (userId: string) => Promise<boolean> | boolean;
}): Promise<RefundApproval> {
  const refuse = (code: string, whatHappened: string): never => {
    throw apiError(422, { code, whatHappened, wasItSaved: 'not_saved', nextSafeAction: 'Ask the approver to approve this refund in their own session, and send the approvalId it gives. No money has moved.' });
  };
  const s = input.state;
  if (s === undefined) return refuse('approval_unknown', 'Head office never gave that approval.');
  const a = s.approval;
  if (s.usedBy !== undefined && s.usedBy !== input.returnId) return refuse('approval_already_used', `That approval was already used for refund ${s.usedBy}; one approval pays one refund.`);
  if (s.usedBy === undefined && Date.parse(a.expiresAt) <= Date.parse(input.now)) return refuse('approval_expired', `That approval expired at ${a.expiresAt} (they last ${REFUND_APPROVAL_MINUTES} minutes).`);
  if (a.kind !== input.kind || a.saleId !== input.saleId || a.valueMinor !== input.valueMinor || a.requestedBy !== input.processedBy) {
    return refuse('approval_does_not_match', `That approval is for a ${a.kind.replace(/_/g, ' ')} of ${a.valueMinor} paise${a.saleId === null ? '' : ` on bill ${a.saleId}`}, processed by ${a.requestedBy} — not this one.`);
  }
  if (!(await input.canApprove(a.approvedBy))) return refuse('approver_may_not_approve', `${a.approvedBy} no longer holds the authority to approve a refund, so their approval does not count.`);
  return a;
}
