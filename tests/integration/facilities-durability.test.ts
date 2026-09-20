import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Facilities durability — the whole surface rebuilds from the event store after a restart (M26, API-11,
// P-04 "tested recovery", P-08 no silent failure, FND-01 append-only).
//
// M26's four FRs are each integration-tested for behaviour + RBAC + per-tenant isolation
// (facilities-assets / -monitoring / -schedules / -incidents). The one property those suites do not prove
// — the property a control surface an auditor relies on actually depends on — is that what was recorded
// SURVIVES the process going away: an asset's missing-AMC alert, a cold room holding stock on a breach,
// an overdue statutory task, an open serious incident. All of it is event-sourced; a restart must replay
// the log to the SAME truth, and appends must continue afterwards. This mirrors the restart-rebuild proof
// the other event-sourced surfaces carry (goods-receipt, warehouse-counts, connector-delivery).

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

// ── route helpers (same shapes the per-FR suites use) ───────────────────────────────────────────────────
const putAsset = (h: ApiHarness, u: string, id: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: `/v1/facilities/assets/${id}`, userId: u, tenantId: A, idempotencyKey: `as-${id}`, body });
const health = (h: ApiHarness, u: string, asOf: string) =>
  h.request({ method: 'GET', path: '/v1/facilities/assets/health', userId: u, tenantId: A, query: { branchId: 'BR1', asOf } });

const setRange = (h: ApiHarness, u: string, id: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: `/v1/facilities/equipment/${id}/range`, userId: u, tenantId: A, idempotencyKey: `rg-${id}`, body });
const setContents = (h: ApiHarness, u: string, id: string, contents: unknown) =>
  h.request({ method: 'POST', path: `/v1/facilities/equipment/${id}/contents`, userId: u, tenantId: A, idempotencyKey: `ct-${id}`, body: { contents } });
const reading = (h: ApiHarness, u: string, id: string, rid: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: `/v1/facilities/equipment/${id}/readings/${rid}`, userId: u, tenantId: A, idempotencyKey: `rd-${rid}`, body });
const assess = (h: ApiHarness, u: string, id: string, asOf: string) =>
  h.request({ method: 'GET', path: `/v1/facilities/equipment/${id}`, userId: u, tenantId: A, query: { asOf } });

const defineSched = (h: ApiHarness, u: string, id: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: `/v1/facilities/schedules/${id}`, userId: u, tenantId: A, idempotencyKey: `fs-${id}`, body });
const raiseTask = (h: ApiHarness, u: string, schedId: string, taskId: string, dueOn: string) =>
  h.request({ method: 'POST', path: `/v1/facilities/schedules/${schedId}/tasks/${taskId}`, userId: u, tenantId: A, idempotencyKey: `ft-${taskId}`, body: { dueOn } });
const overdue = (h: ApiHarness, u: string, asOf: string) =>
  h.request({ method: 'GET', path: '/v1/facilities/overdue', userId: u, tenantId: A, query: { asOf } });

const raiseIncident = (h: ApiHarness, u: string, id: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: `/v1/facilities/incidents/${id}`, userId: u, tenantId: A, idempotencyKey: `in-${id}`, body });
const evidence = (h: ApiHarness, u: string, from: string, to: string) =>
  h.request({ method: 'GET', path: '/v1/facilities/evidence', userId: u, tenantId: A, query: { branchId: 'BR1', from, to } });

// ── shapes ──────────────────────────────────────────────────────────────────────────────────────────────
const coldRoom = (over: Record<string, unknown> = {}) => ({
  branchId: 'BR1', name: 'Cold room 1', kind: 'cold_room', criticality: 'critical',
  installedOn: '2020-01-01', protectsValueMinor: 800_000, ...over,
});
const coldRange = (over: Record<string, unknown> = {}) => ({
  branchId: 'BR1', name: 'Cold room 1', minTenthsC: 0, maxTenthsC: 80, graceMinutes: 30, expectEveryMinutes: 120, ...over,
});
const BATCHES = [
  { batchId: 'b-chicken', productId: 'p-chicken', valueMinor: 100_000 },
  { batchId: 'b-cheese', productId: 'p-cheese', valueMinor: 84_000 },
];
const fire = (over: Record<string, unknown> = {}) => ({
  branchId: 'BR1', title: 'Fire extinguisher check', category: 'fire_safety', frequency: 'monthly',
  assignedRole: 'facilities', escalatesTo: 'u-mgr', evidenceRequired: true, verificationRequired: true, ...over,
});
const serious = (over: Record<string, unknown> = {}) => ({
  branchId: 'BR1', kind: 'injury', severity: 'serious', occurredAt: '2026-08-10T09:00:00Z', reportedAt: '2026-08-10T09:30:00Z',
  reportedBy: 'u-floor', description: 'A member of staff slipped on a wet aisle', evidenceRefs: ['photo.jpg'], ...over,
});

interface Health { critical: { assetId: string; kind: string }[] }
interface Equip { state: string; holdStock: boolean; exposedValueMinor: number }
interface Overdue { overdue: { taskId: string; level: string }[]; complianceRisks: number }
interface Pack { openIncidents: number; presentable: boolean; gaps: string[] }

describe('facilities durability: the whole surface rebuilds from the event store after a restart (M26)', () => {
  it('replays assets, equipment, schedules and incidents to the same truth, and keeps appending', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    // FR-01: a critical asset with no AMC → an amc_missing alert in the critical list.
    await putAsset(h, 'u-owner', 'cold-1', coldRoom());
    // FR-02: a cold room breached for two hours holds ₹1,84,000 of stock.
    await setRange(h, 'u-owner', 'cold-eq', coldRange());
    await setContents(h, 'u-owner', 'cold-eq', BATCHES);
    await reading(h, 'u-owner', 'cold-eq', 'r1', { tenthsC: 120, at: '2026-08-04T06:00:00Z', source: 'sensor', recordedBy: 'probe-1' });
    await reading(h, 'u-owner', 'cold-eq', 'r2', { tenthsC: 130, at: '2026-08-04T07:00:00Z', source: 'sensor', recordedBy: 'probe-1' });
    // FR-03: an overdue, compliance-linked statutory task.
    await defineSched(h, 'u-owner', 'sched-fire', fire());
    await raiseTask(h, 'u-owner', 'sched-fire', 't-fire', '2026-08-01');
    // FR-04: an open serious incident.
    await raiseIncident(h, 'u-owner', 'inc-open', serious());

    // Sanity: the live instance shows the state before we throw the process away.
    expect(((await health(h, 'u-owner', '2026-08-10')).body as Health).critical.some((a) => a.assetId === 'cold-1' && a.kind === 'amc_missing')).toBe(true);

    // Restart: a NEW surface over the SAME persisted event store — every read must rebuild from the log.
    const restarted = apiHarness({ store: h.store });

    const rHealth = (await health(restarted, 'u-owner', '2026-08-10')).body as Health;
    expect(rHealth.critical.some((a) => a.assetId === 'cold-1' && a.kind === 'amc_missing'), 'the asset alert did not survive the restart').toBe(true);

    const rEquip = (await assess(restarted, 'u-owner', 'cold-eq', '2026-08-04T08:00:00Z')).body as Equip;
    expect(rEquip.state, 'the breach did not survive the restart').toBe('breach');
    expect(rEquip.holdStock).toBe(true);
    expect(rEquip.exposedValueMinor).toBe(184_000);

    const rOver = (await overdue(restarted, 'u-owner', '2026-08-10')).body as Overdue;
    expect(rOver.overdue.find((o) => o.taskId === 't-fire')?.level, 'the overdue task did not survive the restart').toBe('compliance_risk');
    expect(rOver.complianceRisks).toBe(1);

    const rPack = (await evidence(restarted, 'u-owner', '2026-08-01', '2026-08-31')).body as Pack;
    expect(rPack.openIncidents, 'the open incident did not survive the restart').toBe(1);
    expect(rPack.presentable).toBe(false);
    expect(rPack.gaps.some((g) => g.includes('serious injury still open'))).toBe(true);

    // And the rebuilt surface is LIVE, not a read-only replay: a new append lands and is visible.
    await putAsset(restarted, 'u-owner', 'cold-2', coldRoom({ name: 'Cold room 2' }));
    const after = (await health(restarted, 'u-owner', '2026-08-10')).body as Health;
    expect(after.critical.some((a) => a.assetId === 'cold-2' && a.kind === 'amc_missing'), 'the restarted surface would not accept a new append').toBe(true);
  });
});
