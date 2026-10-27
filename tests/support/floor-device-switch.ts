// OB-407 (owner, 27 Oct 2026, in writing): switching ON a floor device (`esl`, `rfid`, `iot`, `cctv`) takes the owner's
// approval AND the named security reviewer's signature (OB-330 / OB-405), each decided in that person's own session. These
// helpers drive it the way the people do: the owner names the reviewer; the person switching asks twice; the owner and the
// reviewer each approve; the switch is sent naming both.

import { randomUUID } from 'node:crypto';
import type { HttpResponse } from '../../services/kernel/src/index';
import type { ApiHarness } from './api-harness';
import { approvedRequestId } from './approval-request';
import { actionDetails } from '../../services/identity/src/approval-requests';

/** The owner names the security reviewer (PUT /v1/compliance/security-reviewer) — failing loudly when refused. */
export async function nameSecurityReviewer(h: ApiHarness, tenantId: string, owner: string, reviewer: string, displayName = 'Security reviewer'): Promise<void> {
  const r = await h.request({ method: 'PUT', path: '/v1/compliance/security-reviewer', userId: owner, tenantId, idempotencyKey: `rev-${randomUUID()}`, body: { userId: reviewer, displayName, reason: 'synthetic: the named security reviewer (OB-405)' } });
  if (r.status !== 200) throw new Error(`${owner} could not name ${reviewer}: ${r.status} ${JSON.stringify(r.body)}`);
}

/** The approval subject of one place's rollout switch (services/platform/src/rollout.ts `rolloutSubject`). */
export const rolloutSubjectOf = (key: string, body: { readonly branchId: string; readonly laneId?: string }): string =>
  `rollout:${key}:${body.branchId}${body.laneId === undefined ? '' : `:${body.laneId}`}`;

/**
 * Switch a floor device ON at a place as three people: `switcher` asks for both approvals of exactly `body`, the `owner`
 * approves the `flag_change`, the `reviewer` signs the `floor_device_review`, and the switch is sent naming both. Resolves
 * the switch route's reply (the approvals failing loudly).
 */
export async function switchFloorDeviceOn(
  h: ApiHarness, tenantId: string,
  who: { readonly switcher: string; readonly owner: string; readonly reviewer: string; readonly branchHeader?: string },
  key: string, body: { readonly branchId: string; readonly laneId?: string; readonly reason: string },
): Promise<HttpResponse> {
  const sent = { ...body, enabled: true };
  const subjectRef = rolloutSubjectOf(key, body);
  const details = actionDetails(sent, { key });
  const approvalId = await approvedRequestId(h, tenantId, who.switcher, who.owner, { kind: 'flag_change', subjectRef, details });
  const reviewApprovalId = await approvedRequestId(h, tenantId, who.switcher, who.reviewer, { kind: 'floor_device_review', subjectRef, details });
  return h.request({
    method: 'PUT', path: `/v1/platform/rollout/${key}`, userId: who.switcher, tenantId, idempotencyKey: `on-${randomUUID()}`,
    ...(who.branchHeader === undefined ? {} : { branchId: who.branchHeader }), body: { ...sent, approvalId, reviewApprovalId },
  });
}
