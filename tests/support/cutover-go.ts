// OB-52 — bring a rehearsal shop's cutover gate to GO through the REAL routes, so a suite can prove what the recorded GO
// opens (the opening-load reversal window, 48 hours). Every check is answered from head office's own records, as the gate
// reads them (GT-03): the extraction run named, a control total recorded and signed by somebody who did not run the load,
// three clean parallel days by the named reconciler, a rollback rehearsed, performed and reconciled, a delta applied with a
// real effect — and finally the owner, signed in, says GO. Synthetic data only (hard rule #7).

import { expect } from 'vitest';
import type { ApiHarness } from './api-harness';
import { reconcileRehearsedRollback } from './rollback-rehearsal';

export interface CutoverGoInput {
  readonly tenantId: string;
  /** The shop's owner (the genesis owner): ran the extraction, gives GO. */
  readonly ownerId: string;
  /** Another person with signing authority who did not run the load (signs the control total). */
  readonly signerId: string;
  /** A store manager provisioned in the shop — the parallel run's named reconciler. */
  readonly reconcilerId: string;
  /** Where the delta's stock lands (a product the suite does not otherwise count). */
  readonly deltaLocationId: string;
  /** The shop's own stores — each one's computer reports it has synced past the switch-back (no sale left on its disk). */
  readonly storeIds?: readonly string[];
}

type Reply = { status: number; body: unknown };

/** Everything the gate needs EXCEPT the owner's GO itself. */
export async function prepareCutoverEvidence(h: ApiHarness, input: CutoverGoInput): Promise<void> {
  const t = input.tenantId;
  let n = 0;
  const call = (method: 'POST' | 'PUT', path: string, userId: string, body: unknown): Promise<Reply> =>
    h.request({ method, path, userId, tenantId: t, idempotencyKey: `cg-${n += 1}-${Math.random()}`, body });
  const ok = (r: Reply, status: number): void => { expect(r.status, JSON.stringify(r.body)).toBe(status); };

  ok(await call('POST', '/v1/migration/extraction-runs/run-cutover', input.ownerId, { operatorId: input.ownerId }), 201);
  ok(await call('POST', '/v1/migration/control-totals', input.ownerId, { totals: [{ totalId: 'CT-STOCK', kind: 'stock', name: 'Stock units', unit: 'quantity', legacyValue: 89, loadedValue: 89, legacyDerivation: 'SUM(qty) FROM legacy stock', loadedDerivation: 'count of opening movements' }] }), 201);
  ok(await call('POST', '/v1/migration/control-totals/CT-STOCK/signature', input.signerId, { statement: 'counted a sample on the shelf myself' }), 200);
  ok(await call('PUT', '/v1/migration/parallel-run/policy', input.ownerId, { cutoverId: 'C-parallel', dailyReconcilerUserId: input.reconcilerId, requiredCleanDays: 3, maxParallelDays: 14, startedOn: '2026-10-01' }), 201);
  for (const d of ['2026-10-01', '2026-10-02', '2026-10-03']) {
    ok(await call('POST', `/v1/migration/parallel-run/days/${d}`, input.reconcilerId, { comparisons: [{ area: 'sales_value', legacyValue: 4_120_000, newValue: 4_120_000, toleranceMinor: 500 }] }), 201);
  }
  // The rehearsed window starts now — after the shop's own loading, which is not the window's trading.
  const from = new Date().toISOString();
  await new Promise((r) => { setTimeout(r, 5); });
  ok(await call('POST', '/v1/migration/cutover/rollback', input.ownerId, { cutoverId: 'C-rehearsal', trigger: 'owner_decision', legacySystemAvailable: true }), 201);
  await new Promise((r) => { setTimeout(r, 5); });
  ok(await call('POST', '/v1/migration/cutover/rollback/C-rehearsal/confirmation', input.ownerId, { legacyFirstBillRef: 'OLD-1', legacyTradingFrom: new Date().toISOString() }), 201);
  for (const storeId of input.storeIds ?? []) {
    const box = `u-cg-box-${storeId}`;
    await h.provisionRole(t, box, 'store_computer', [storeId]);
    const now = new Date().toISOString();
    const report = await h.request({ method: 'POST', path: `/v1/stores/${storeId}/sync-watermarks`, userId: box, tenantId: t, branchId: storeId, idempotencyKey: `cg-wm-${storeId}-${now}`, body: { observedAt: now, domains: [{ domain: 'sales', completeThrough: now, unsent: 0, deadLettered: 0 }] } });
    ok(report, 200);
  }
  await reconcileRehearsedRollback(h, { tenantId: t, ownerId: input.ownerId, cutoverId: 'C-rehearsal', newSystemTradingFrom: from });
  const delta = await call('POST', '/v1/migration/deltas', input.ownerId, {
    extractCutoff: '2026-10-09T00:00:00.000Z',
    changes: [{ changeKey: 'd-cutover-1', entity: 'stock', legacyId: 'P-DELTA', operation: 'update', changedAt: '2026-10-09T08:00:00.000Z', deltaQty: 1, locationId: input.deltaLocationId, uom: 'each', unitCostMinor: 100 }],
  });
  ok(delta, 200);
  expect(delta.body).toMatchObject({ applied: 1 });
}

export interface GateReply {
  readonly decision: { readonly go: boolean; readonly failed: readonly string[] };
  readonly recordedGo?: { readonly cutoverId: string; readonly goBy: string; readonly goAt: string };
  readonly reversalWindow?: { readonly opensAt: string; readonly closesAt: string };
}

/** Ask the gate, as `userId`, with the owner's GO said (it counts only when `userId` IS the owner). */
export async function askTheGate(h: ApiHarness, tenantId: string, userId: string, cutoverId: string, teamOwnerId: string): Promise<GateReply> {
  const r = await h.request({
    method: 'POST', path: '/v1/migration/cutover/decision', userId, tenantId, idempotencyKey: `gate-${Math.random()}`,
    body: { cutoverId, ownerGo: true, evidence: { edgeUnsyncedItems: 0, namedTeam: [{ userId: teamOwnerId, role: 'owner' }] } },
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as GateReply;
}
