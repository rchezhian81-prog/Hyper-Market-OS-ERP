// OB-288 P1 (M01-FR-01 "structural changes are owner-approved (maker-checker, §28)"): activating, suspending or closing a
// place in the business, or changing one that is no longer a draft, waits for an owner's approval of exactly that change.
// A scenario's structural step, driven the way two people drive it.

import type { ApiHarness } from './api-harness';
import { approvedRequestId } from './approval-request';
import { actionDetails } from '../../services/identity/src/approval-requests';

/** An org-node upsert body carrying an owner's approval of exactly it. */
export async function approvedNodeBody(
  h: ApiHarness, tenantId: string, maker: string, owner: string, nodeId: string, body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const approvalId = await approvedRequestId(h, tenantId, maker, owner, { kind: 'org_structure_change', subjectRef: nodeId, details: actionDetails(body, { nodeId }) });
  return { ...body, approvalId };
}

/** An activation body carrying an owner's approval of activating this node. */
export async function approvedActivationBody(h: ApiHarness, tenantId: string, maker: string, owner: string, nodeId: string): Promise<Record<string, unknown>> {
  const approvalId = await approvedRequestId(h, tenantId, maker, owner, { kind: 'org_structure_change', subjectRef: nodeId, details: { nodeId, action: 'activate' } });
  return { approvalId };
}
