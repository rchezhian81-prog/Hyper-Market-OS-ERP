// A store's working rules as head office holds them (DF-3-b-1) — every value set, as the owner sets them. The margin floor is
// the one the pricing routes judge a head-office price by (M05 · PA audit): never a figure sent with the price.

import type { ApiHarness } from './api-harness';
import { aBranch } from './a-branch';

export const STORE_RULES = {
  approvalLimitMinor: 500_000, marginFloorBps: 2_000, nearExpiryDays: 30,
  reporting: { laggingAfterMinutes: 5, staleAfterMinutes: 60 },
  service: { returnWindowDays: 7, approvalThresholdMinor: 200_000, noReceiptCapMinor: 50_000, agentAuthorityMinor: 5_000, compensationCapMinor: 50_000 },
  journalPrefixes: { takings: 'TK', tax: 'TX', refunds: 'RF' }, dormantAfterDays: 60, aiStaleAfterMinutes: 60,
  merchandising: { refillAtBp: 5_000, countStaleAfterMinutes: 120, refillRole: 'store_manager' },
  writeOffMaterialThresholdMinor: 50_000,
  checklist: [] as { itemId: string; description: string; blocking: boolean }[],
} as const;

/** The owner sets a store's rules — with the margin floor given (basis points). */
export async function storeRules(h: ApiHarness, tenantId: string, ownerId: string, storeId: string, marginFloorBps: number): Promise<void> {
  const res = await h.request({
    method: 'POST', path: `/v1/stores/${storeId}/rules`, userId: ownerId, tenantId, idempotencyKey: `rules-${storeId}-${marginFloorBps}`,
    body: { ...STORE_RULES, marginFloorBps },
  });
  if (res.status >= 300) throw new Error(`store rules not set: ${res.status} ${JSON.stringify(res.body)}`);
}

/** A store head office knows (the company and the branch under it), with its rules set — for a test whose prices name it. */
export async function aStoreWithRules(h: ApiHarness, tenantId: string, ownerId: string, storeId: string, marginFloorBps: number): Promise<void> {
  await aBranch(h, tenantId, ownerId, storeId);
  await storeRules(h, tenantId, ownerId, storeId, marginFloorBps);
}
