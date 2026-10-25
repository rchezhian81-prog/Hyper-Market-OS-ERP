// OB-360 (owner, 24–25 Oct 2026, in writing): every change of a B2B credit limit goes through the approval engine with a
// second person. Tests that open or change a business customer's account do it the way two people do it: the MAKER asks
// for exactly the body (plus the customer id in the path), a CHECKER who also manages B2B accounts approves in their own
// session, and the maker sends the body naming the approval. The checker is provisioned as the shop's accountant
// (idempotent: a grant already given is not given twice).

import { randomUUID } from 'node:crypto';
import type { HttpResponse } from '../../services/kernel/src/index';
import type { ApiHarness } from './api-harness';
import { askForApproval, decide } from './approval-request';
import { actionDetails } from '../../services/identity/src/approval-requests';

/** The default second person: the shop's accountant (holds `b2b.account.manage`). */
export const CREDIT_LIMIT_CHECKER = 'u-credit-checker';

/**
 * Set a business customer's credit terms with a second person's approval. Resolves the account route's reply. When the
 * maker may not ask (no authority, feature off) the body is sent as it is, so the route's own refusal shows.
 */
export async function setApprovedCreditLimit(
  h: ApiHarness, tenantId: string, maker: string, customerId: string, body: Record<string, unknown>,
  opts: { readonly checker?: string; readonly checkerRole?: string; readonly idempotencyKey?: string } = {},
): Promise<HttpResponse> {
  const checker = opts.checker ?? CREDIT_LIMIT_CHECKER;
  if (opts.checker === undefined) await h.provisionRole(tenantId, checker, opts.checkerRole ?? 'accountant');
  const send = (b: Record<string, unknown>) => h.request({
    method: 'POST', path: `/v1/b2b/accounts/${encodeURIComponent(customerId)}`, userId: maker, tenantId,
    idempotencyKey: opts.idempotencyKey ?? `acc-${customerId}-${randomUUID()}`, body: b,
  });
  const asked = await askForApproval(h, tenantId, maker, { kind: 'b2b_credit_limit', subjectRef: customerId, details: actionDetails(body, { customerId }), valueMinor: null });
  if (asked.status !== 201) return send(body);
  const requestId = (asked.body as { requestId: string }).requestId;
  const decided = await decide(h, tenantId, checker, requestId);
  if (decided.status !== 201) throw new Error(`${checker} could not approve the credit limit: ${decided.status} ${JSON.stringify(decided.body)}`);
  return send({ ...body, approvalId: requestId });
}

/** The same two-person path over any request function that is already bound to its shop (an e2e's `cloud.request`). */
export async function creditLimitWithApproval(
  request: (r: { readonly method: 'POST'; readonly path: string; readonly userId: string; readonly idempotencyKey: string; readonly body: unknown }) => Promise<{ readonly status: number; readonly body: unknown }>,
  maker: string, checker: string, customerId: string, body: Record<string, unknown>, key = `acc-${customerId}`,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const asked = await request({
    method: 'POST', path: '/v1/approvals/requests', userId: maker, idempotencyKey: `${key}-ask`,
    body: { kind: 'b2b_credit_limit', subjectRef: customerId, details: actionDetails(body, { customerId }), valueMinor: null, summary: `credit limit for ${customerId}`, reason: 'synthetic test' },
  });
  if (asked.status !== 201) throw new Error(`${maker} could not ask: ${asked.status} ${JSON.stringify(asked.body)}`);
  const requestId = (asked.body as { requestId: string }).requestId;
  const decided = await request({ method: 'POST', path: `/v1/approvals/requests/${requestId}/decide`, userId: checker, idempotencyKey: `${key}-decide`, body: { decision: 'approved', reason: 'checked' } });
  if (decided.status !== 201) throw new Error(`${checker} could not approve: ${decided.status} ${JSON.stringify(decided.body)}`);
  return request({ method: 'POST', path: `/v1/b2b/accounts/${encodeURIComponent(customerId)}`, userId: maker, idempotencyKey: key, body: { ...body, approvalId: requestId } });
}
