import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Facilities equipment & power monitoring, end to end through the real API (M26-FR-02, API-11).
// M10 assesses the cold chain of a BATCH; this assesses the EQUIPMENT. The difference is the point:
// a breach of the room compromises EVERYTHING in it, including the batches nobody probed, so a breach
// names the stock and holds all of it; a probe that has gone QUIET is a fault not a pass (no_data /
// stale both hold — the probe that fell out of the room three weeks ago has read as "no alerts" ever
// since); and power is assessed by WHAT IT PROTECTS, with unprotected minutes counted from the mains
// failure and the critical assets with no backup named. Proves the wired surface against real RBAC.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const setRange = (h: ApiHarness, tenantId: string, userId: string, assetId: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: `/v1/facilities/equipment/${assetId}/range`, userId, tenantId, idempotencyKey: `rg-${assetId}`, body });

const setContents = (h: ApiHarness, tenantId: string, userId: string, assetId: string, contents: unknown) =>
  h.request({ method: 'POST', path: `/v1/facilities/equipment/${assetId}/contents`, userId, tenantId, idempotencyKey: `ct-${assetId}`, body: { contents } });

const reading = (h: ApiHarness, tenantId: string, userId: string, assetId: string, readingId: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: `/v1/facilities/equipment/${assetId}/readings/${readingId}`, userId, tenantId, idempotencyKey: `rd-${readingId}`, body });

const assess = (h: ApiHarness, tenantId: string, userId: string, assetId: string, asOf: string) =>
  h.request({ method: 'GET', path: `/v1/facilities/equipment/${assetId}`, userId, tenantId, query: { asOf } });

const powerEvent = (h: ApiHarness, tenantId: string, userId: string, eventId: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: `/v1/facilities/power/${eventId}`, userId, tenantId, idempotencyKey: `pw-${eventId}`, body });

const power = (h: ApiHarness, tenantId: string, userId: string, branchId: string, asOf: string) =>
  h.request({ method: 'GET', path: '/v1/facilities/power', userId, tenantId, query: { branchId, asOf } });

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

interface Equip { state: string; holdStock: boolean; exposedValueMinor: number; exposedBatches: { batchId: string }[]; minutesSinceLastReading: number | null; minutesOutOfRange: number }
interface Power { severity: string; onBackup: boolean; unprotectedMinutes: number; assetsAtRisk: string[] }

const coldRange = (over: Record<string, unknown> = {}) => ({
  branchId: 'BR1', name: 'Cold room 1', minTenthsC: 0, maxTenthsC: 80, graceMinutes: 30, expectEveryMinutes: 120, ...over,
});
const BATCHES = [
  { batchId: 'b-chicken', productId: 'p-chicken', valueMinor: 100_000 },
  { batchId: 'b-cheese', productId: 'p-cheese', valueMinor: 84_000 },
];

describe('facilities monitoring: a breach holds the whole room, silence is a fault (M26-FR-02)', () => {
  it('names and holds every batch in a breached room, including the ones nobody probed', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await setRange(h, A, 'u-owner', 'cold-1', coldRange());
    await setContents(h, A, 'u-owner', 'cold-1', BATCHES);
    // Above 8°C for two hours — well past the 30-minute grace.
    await reading(h, A, 'u-owner', 'cold-1', 'r1', { tenthsC: 120, at: '2026-08-04T06:00:00Z', source: 'sensor', recordedBy: 'probe-1' });
    await reading(h, A, 'u-owner', 'cold-1', 'r2', { tenthsC: 130, at: '2026-08-04T07:00:00Z', source: 'sensor', recordedBy: 'probe-1' });

    const r = (await assess(h, A, 'u-owner', 'cold-1', '2026-08-04T08:00:00Z')).body as Equip;
    expect(r.state).toBe('breach');
    expect(r.holdStock).toBe(true);
    expect(r.exposedValueMinor).toBe(184_000);
    expect(r.exposedBatches.map((b) => b.batchId).sort()).toEqual(['b-cheese', 'b-chicken']);
    expect(r.minutesOutOfRange).toBe(120);
  });

  it('treats a probe that has gone quiet as a fault that holds the stock, not a silent pass', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await setRange(h, A, 'u-owner', 'cold-1', coldRange());
    await setContents(h, A, 'u-owner', 'cold-1', BATCHES);
    // One reading, fine, then silence — four hours against a two-hour expectation.
    await reading(h, A, 'u-owner', 'cold-1', 'r1', { tenthsC: 40, at: '2026-08-04T06:00:00Z', source: 'manual_probe', recordedBy: 'u-duty' });

    const stale = (await assess(h, A, 'u-owner', 'cold-1', '2026-08-04T10:00:00Z')).body as Equip;
    expect(stale.state).toBe('stale');
    expect(stale.holdStock).toBe(true);
    expect(stale.minutesSinceLastReading).toBe(240);

    // A room that has NEVER reported is worse still.
    await setRange(h, A, 'u-owner', 'cold-2', coldRange({ name: 'Cold room 2' }));
    await setContents(h, A, 'u-owner', 'cold-2', BATCHES);
    const noData = (await assess(h, A, 'u-owner', 'cold-2', '2026-08-04T10:00:00Z')).body as Equip;
    expect(noData.state).toBe('no_data');
    expect(noData.holdStock).toBe(true);
  });

  it('calls a short excursion inside the grace a drift, not a breach, and does not hold', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await setRange(h, A, 'u-owner', 'cold-1', coldRange());
    await setContents(h, A, 'u-owner', 'cold-1', BATCHES);
    await reading(h, A, 'u-owner', 'cold-1', 'r1', { tenthsC: 120, at: '2026-08-04T07:30:00Z', source: 'sensor', recordedBy: 'probe-1' });

    const r = (await assess(h, A, 'u-owner', 'cold-1', '2026-08-04T07:50:00Z')).body as Equip; // 20 min < 30 grace
    expect(r.state).toBe('drifting');
    expect(r.holdStock).toBe(false);
  });

  it('assesses power by what it protects, naming the critical asset with no backup', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await setRange(h, A, 'u-owner', 'cold-1', coldRange({ name: 'Cold room 1', onBackup: false }));
    await setRange(h, A, 'u-owner', 'freezer-1', coldRange({ name: 'Freezer 1', onBackup: true }));
    await powerEvent(h, A, 'u-owner', 'p1', { branchId: 'BR1', kind: 'mains_failed', at: '2026-08-04T09:00:00Z' });
    await powerEvent(h, A, 'u-owner', 'p2', { branchId: 'BR1', kind: 'dg_failed_to_start', at: '2026-08-04T09:05:00Z' });

    const r = (await power(h, A, 'u-owner', 'BR1', '2026-08-04T09:47:00Z')).body as Power;
    expect(r.severity).toBe('unprotected');
    expect(r.unprotectedMinutes).toBe(47); // counted from the MAINS failure, not the generator attempt
    expect(r.assetsAtRisk).toEqual(['Cold room 1']); // the freezer is on backup, so it is not at risk
  });

  it('counts the unprotected gap before a generator caught, then reads normal once mains is back', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await setRange(h, A, 'u-owner', 'cold-1', coldRange({ onBackup: false }));
    await powerEvent(h, A, 'u-owner', 'p1', { branchId: 'BR2', kind: 'mains_failed', at: '2026-08-04T10:00:00Z' });
    await powerEvent(h, A, 'u-owner', 'p2', { branchId: 'BR2', kind: 'dg_started', at: '2026-08-04T10:03:00Z' });
    await powerEvent(h, A, 'u-owner', 'p3', { branchId: 'BR2', kind: 'mains_restored', at: '2026-08-04T10:30:00Z' });

    const r = (await power(h, A, 'u-owner', 'BR2', '2026-08-04T11:00:00Z')).body as Power;
    expect(r.severity).toBe('normal');
    expect(r.unprotectedMinutes).toBe(3); // the three minutes before the DG caught
    expect(r.assetsAtRisk).toEqual([]);
  });

  it('is authorized and per-tenant, and refuses unknown/malformed/inverted', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier'); // a cashier does not manage facilities monitoring
    await setRange(h, A, 'u-owner', 'cold-1', coldRange());

    expect((await setRange(h, A, 'u-cash', 'cold-x', coldRange())).status).toBe(403);
    expect((await reading(h, A, 'u-owner', 'GHOST', 'r1', { tenthsC: 40, at: '2026-08-04T06:00:00Z', source: 'sensor', recordedBy: 'x' })).status).toBe(404);
    const inverted = await setRange(h, A, 'u-owner', 'bad-1', coldRange({ minTenthsC: 80, maxTenthsC: 0 }));
    expect(inverted.status).toBe(422);
    expect(codeOf(inverted)).toBe('range_is_inverted');
    expect((await reading(h, A, 'u-owner', 'cold-1', 'r-bad', { tenthsC: 40, at: '2026-08-04T06:00:00Z', source: 'nonsense', recordedBy: 'x' })).status).toBe(400);

    await h.seedOwner(B, 'u-owner-b');
    const other = (await power(h, B, 'u-owner-b', 'BR1', '2026-08-04T09:47:00Z')).body as Power;
    expect(other.severity).toBe('normal');
    expect(other.assetsAtRisk).toEqual([]);
  });
});
