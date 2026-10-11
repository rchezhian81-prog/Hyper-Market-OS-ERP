// GT-02 round 4 — the data half of a rollback rehearsal, for suites that rehearse a rollback through the harness: the
// store's computer reports it has synced past the switch-back (the EA-01 route, as that store's own identity), then the
// rollback's window is reconciled against what the old system holds. Synthetic data only (hard rule #7).

import { expect } from 'vitest';
import type { ApiHarness } from './api-harness';

/** Reconcile a performed rollback whose window held `count` bills worth `totalMinor` (the old system holds the same). */
export async function reconcileRehearsedRollback(h: ApiHarness, input: {
  readonly tenantId: string;
  readonly ownerId: string;
  readonly cutoverId: string;
  readonly newSystemTradingFrom: string;
  readonly count?: number;
  readonly totalMinor?: number;
}): Promise<void> {
  const t = input.tenantId;
  const owner = (path: string, body: unknown) => h.request({ method: 'POST', path, userId: input.ownerId, tenantId: t, idempotencyKey: `rr-${path}-${Math.random()}`, body });
  // One store, and its computer's own sign-in at that store.
  await owner('/v1/org/nodes/RB-CO', { kind: 'company', name: 'Rehearsal company' });
  await owner('/v1/org/nodes/RB-S1', { kind: 'branch', name: 'Rehearsal store', parentId: 'RB-CO', companyId: 'RB-CO' });
  await h.provisionRole(t, 'u-rb-box', 'store_computer', ['RB-S1']);
  const now = new Date().toISOString();
  const report = await h.request({
    method: 'POST', path: '/v1/stores/RB-S1/sync-watermarks', userId: 'u-rb-box', tenantId: t, branchId: 'RB-S1', idempotencyKey: `rr-wm-${now}`,
    body: { observedAt: now, domains: [{ domain: 'sales', completeThrough: now, unsent: 0, deadLettered: 0 }] },
  });
  expect(report.status).toBe(200);
  const done = await owner(`/v1/migration/cutover/rollback/${input.cutoverId}/reconciliation`, {
    newSystemTradingFrom: input.newSystemTradingFrom,
    legacyCarriedBack: { count: input.count ?? 0, totalMinor: input.totalMinor ?? 0 },
  });
  expect(done.status).toBe(201);
  expect(done.body).toMatchObject({ demonstrated: true });
}
