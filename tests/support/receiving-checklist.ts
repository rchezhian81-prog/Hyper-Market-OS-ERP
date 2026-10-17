// OB-164 (owner, 16 Oct 2026, "Chilled and frozen only"): a chilled or frozen goods receipt needs its D-6 receiving checklist
// on file before it is booked. Tests that book cold-chain deliveries record it first through the REAL food-safety routes —
// a receiving check defined once per tenant, and a passing record whose subjectRef is the goods receipt id.

interface Requester {
  request(input: { method: 'GET' | 'POST'; path: string; userId: string; tenantId: string; idempotencyKey?: string; body?: unknown }): Promise<{ status: number; body: unknown }>;
}

export const RECEIVING_CHECK_ID = 'dock-receiving';

/** Define the tenant's receiving checklist (idempotent: the same definition again changes nothing). */
export async function defineReceivingCheck(h: Requester, tenantId: string, by: string, branchId = 'store-1'): Promise<void> {
  const res = await h.request({
    method: 'POST', path: `/v1/facilities/food-safety/checks/${RECEIVING_CHECK_ID}`, userId: by, tenantId,
    idempotencyKey: `define-${RECEIVING_CHECK_ID}-${branchId}`,
    body: { branchId, title: 'Chilled and frozen delivery', kind: 'receiving', graceMinutes: 0, assignedRole: 'store_manager', escalatesTo: 'u-owner', items: [{ itemId: 'temp', label: 'Temperature taken' }, { itemId: 'pack', label: 'Packaging intact' }] },
  });
  if (res.status >= 300) throw new Error(`receiving check: ${res.status} ${JSON.stringify(res.body)}`);
}

/** Record the receiving checklist for one delivery (its goods receipt id), passing. */
export async function recordReceivingChecklist(h: Requester, tenantId: string, grnId: string, by: string, definer = by, branchId = 'store-1'): Promise<void> {
  await defineReceivingCheck(h, tenantId, definer, branchId);
  const res = await h.request({
    method: 'POST', path: `/v1/facilities/food-safety/checks/${RECEIVING_CHECK_ID}/records/rc-${grnId}`, userId: by, tenantId,
    idempotencyKey: `rc-${grnId}`, body: { subjectRef: grnId, itemResults: { temp: 'pass', pack: 'pass' } },
  });
  if (res.status >= 300) throw new Error(`receiving checklist for ${grnId}: ${res.status} ${JSON.stringify(res.body)}`);
}
