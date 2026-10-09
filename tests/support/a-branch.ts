// SF-01 — a shop with one branch, as head office knows it (the company and the store under it). A head-office price
// change applies to every store head office knows; a test shop with no store has nowhere for a price to apply.

import type { ApiHarness } from './api-harness';

export async function aBranch(h: ApiHarness, tenantId: string, userId: string, branchId = 'store-1'): Promise<string> {
  const node = (id: string, body: Record<string, unknown>) =>
    h.request({ method: 'POST', path: `/v1/org/nodes/${id}`, userId, tenantId, idempotencyKey: `org-${id}`, body });
  for (const [id, body] of [
    ['C1', { kind: 'company', name: 'SRE Retail' }],
    [branchId, { kind: 'branch', name: 'Store 1', parentId: 'C1', companyId: 'C1' }],
  ] as const) {
    const res = await node(id, body);
    if (res.status >= 300) throw new Error(`could not set up ${id}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return branchId;
}
