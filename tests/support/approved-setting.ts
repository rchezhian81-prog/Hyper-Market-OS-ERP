// OB-288 P1 (M01-FR-02): a high-impact setting (the trading-day cut-off, the currency) changes only with the owner's
// approval. A scenario's setup change, driven the way two people drive it: the maker asks for exactly this answer, the
// owner approves in his own session, and the setup route then names the approval.

import type { ApiHarness } from './api-harness';
import { approvedRequestId } from './approval-request';
import { actionDetails } from '../../services/identity/src/approval-requests';

export async function approvedSettingBody(
  h: ApiHarness, tenantId: string, maker: string, owner: string, key: string, body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const approvalId = await approvedRequestId(h, tenantId, maker, owner, { kind: 'config_change', subjectRef: `setting:${key}`, details: actionDetails(body, { key }) });
  return { ...body, approvalId };
}
