// A refund approval at head office is the approver's OWN act in their own session (ADR-0022 · audit PF-02): tests that
// used to write a manager's name into a refund body now have that manager give the approval through the real route,
// and the refund names the approval it was given.

import { randomUUID } from 'node:crypto';
import type { HttpResponse } from '../../services/kernel/src/index';
import type { ApiHarness } from './api-harness';
import type { RefundApprovalKind } from '../../services/pos/src/refund-approvals';

export interface ApprovalAsk {
  readonly kind?: RefundApprovalKind;
  /** The bill; omitted (null) only for a return without a receipt. */
  readonly saleId?: string | null;
  readonly valueMinor: number;
  /** Who will process the refund. */
  readonly requestedBy: string;
  readonly reason?: string;
}

/** `approverId` gives an approval in their own session — the route's reply, refusal or not. */
export function giveRefundApproval(h: ApiHarness, tenantId: string, approverId: string, ask: ApprovalAsk): Promise<HttpResponse> {
  return h.request({
    method: 'POST', path: '/v1/pos/refund-approvals', userId: approverId, tenantId, idempotencyKey: `apr-${randomUUID()}`,
    body: {
      kind: ask.kind ?? 'refund', ...(ask.saleId === undefined || ask.saleId === null ? {} : { saleId: ask.saleId }),
      valueMinor: ask.valueMinor, requestedBy: ask.requestedBy, reason: ask.reason ?? 'synthetic test approval',
    },
  });
}

/** As `giveRefundApproval`, resolving the approval's id — and failing loudly when the approver was refused. */
export async function refundApprovalId(h: ApiHarness, tenantId: string, approverId: string, ask: ApprovalAsk): Promise<string> {
  const res = await giveRefundApproval(h, tenantId, approverId, ask);
  if (res.status !== 201) throw new Error(`${approverId} could not approve: ${res.status} ${JSON.stringify(res.body)}`);
  return (res.body as { approvalId: string }).approvalId;
}

// One approval per (harness, tenant, processor, bill, body): a retry of the same refund — a lost reply resent with the
// same idempotency key — names the SAME approval, exactly as a desk resending what it could not confirm would.
const given = new WeakMap<ApiHarness, Map<string, Promise<Record<string, unknown>>>>();

/**
 * A refund body that names its approvers — `approvedBy` (the refund itself) and `outOfWindowApprovedBy` (a return past
 * the window) — turned into the approvals those people give in their own sessions, named by `approvalId` and
 * `outOfWindowApprovalId`. `refundKind`/`refundValueMinor` default to a receipted refund of the body's `refundMinor`;
 * the out-of-window approval is for `outOfWindowValueMinor` (default: the same refund).
 */
export async function withApprovals(
  h: ApiHarness, tenantId: string, processorId: string, saleId: string | null, body: Record<string, unknown>,
  opts: { refundKind?: RefundApprovalKind; refundValueMinor?: number; outOfWindowValueMinor?: number } = {},
): Promise<Record<string, unknown>> {
  const memo = given.get(h) ?? new Map<string, Promise<Record<string, unknown>>>();
  given.set(h, memo);
  const key = JSON.stringify([tenantId, processorId, saleId, body, opts]);
  const known = memo.get(key);
  if (known !== undefined) return known;
  const made = approve(h, tenantId, processorId, saleId, body, opts);
  memo.set(key, made);
  made.catch(() => memo.delete(key));
  return made;
}

async function approve(
  h: ApiHarness, tenantId: string, processorId: string, saleId: string | null, body: Record<string, unknown>,
  opts: { refundKind?: RefundApprovalKind; refundValueMinor?: number; outOfWindowValueMinor?: number },
): Promise<Record<string, unknown>> {
  const { approvedBy, outOfWindowApprovedBy, ...rest } = body;
  const out: Record<string, unknown> = { ...rest };
  const refundMinor = typeof body['refundMinor'] === 'number' ? body['refundMinor'] : 0;
  if (typeof approvedBy === 'string') {
    out['approvalId'] = await refundApprovalId(h, tenantId, approvedBy, {
      kind: opts.refundKind ?? 'refund', saleId, valueMinor: opts.refundValueMinor ?? refundMinor, requestedBy: processorId,
    });
  }
  if (typeof outOfWindowApprovedBy === 'string') {
    out['outOfWindowApprovalId'] = await refundApprovalId(h, tenantId, outOfWindowApprovedBy, {
      kind: 'out_of_window', saleId, valueMinor: opts.outOfWindowValueMinor ?? refundMinor, requestedBy: processorId,
    });
  }
  return out;
}
