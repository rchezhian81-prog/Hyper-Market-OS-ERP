// Head office's maker-checker engine (ADR-0024), driven the way two people drive it: the MAKER asks in their own session,
// a different CHECKER who holds the authority approves in theirs, and the maker's action then names the approved request.

import { randomUUID } from 'node:crypto';
import type { HttpResponse } from '../../services/kernel/src/index';
import type { ApiHarness } from './api-harness';
import { actionDetails } from '../../services/identity/src/approval-requests';

export interface Ask {
  readonly kind: string;
  readonly subjectRef: string;
  /** The exact details the action will carry — the engine fingerprints them. */
  readonly details: Record<string, unknown>;
  readonly valueMinor?: number | null;
  readonly summary?: string;
  readonly reason?: string;
}

/** The maker asks — the route's reply, refusal or not. */
export function askForApproval(h: ApiHarness, tenantId: string, maker: string, ask: Ask): Promise<HttpResponse> {
  return h.request({
    method: 'POST', path: '/v1/approvals/requests', userId: maker, tenantId, idempotencyKey: `ask-${randomUUID()}`,
    body: {
      kind: ask.kind, subjectRef: ask.subjectRef, details: ask.details, valueMinor: ask.valueMinor ?? null,
      summary: ask.summary ?? `${ask.kind} for ${ask.subjectRef}`, reason: ask.reason ?? 'synthetic test',
    },
  });
}

/** A checker decides — the route's reply, refusal or not. */
export function decide(h: ApiHarness, tenantId: string, checker: string, requestId: string, decision: 'approved' | 'rejected' = 'approved', reason = 'checked'): Promise<HttpResponse> {
  return h.request({
    method: 'POST', path: `/v1/approvals/requests/${requestId}/decide`, userId: checker, tenantId,
    idempotencyKey: `decide-${randomUUID()}`, body: { decision, reason },
  });
}

/** Maker asks, checker approves; resolves the approved request's id — failing loudly when either is refused. */
export async function approvedRequestId(h: ApiHarness, tenantId: string, maker: string, checker: string, ask: Ask): Promise<string> {
  const asked = await askForApproval(h, tenantId, maker, ask);
  if (asked.status !== 201) throw new Error(`${maker} could not ask: ${asked.status} ${JSON.stringify(asked.body)}`);
  const requestId = (asked.body as { requestId: string }).requestId;
  const decided = await decide(h, tenantId, checker, requestId);
  if (decided.status !== 201) throw new Error(`${checker} could not approve: ${decided.status} ${JSON.stringify(decided.body)}`);
  return requestId;
}

/**
 * An action's body carrying an approval for exactly it: the maker asks with the body as it will be sent (plus the route's
 * path ids — the engine's own `actionDetails` rule), the checker approves in their own session, and the body names it.
 */
export async function approvedBody(
  h: ApiHarness, tenantId: string, maker: string, checker: string,
  kind: string, subjectRef: string, body: Record<string, unknown>, pathIds: Record<string, string> = {}, valueMinor: number | null = null,
): Promise<Record<string, unknown>> {
  const approvalId = await approvedRequestId(h, tenantId, maker, checker, { kind, subjectRef, details: actionDetails(body, pathIds), valueMinor });
  return { ...body, approvalId };
}
