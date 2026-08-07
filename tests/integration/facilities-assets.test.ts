import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Facilities assets, downtime & energy, end to end through the real API (M26-FR-01 / M26-FR-04, API-11).
// A hypermarket is a building full of machines that lose money quietly. So this surface refuses to
// flatten the story: the cold room comes back in its OWN critical list, never beside a shelf trolley
// where it gets missed; an expired/absent AMC is reported against the money it protects; a breakdown
// call is NOT preventive maintenance, so a chiller nursed through breakdowns still reads as overdue;
// downtime is measured from when it BROKE, so an hour reported four hours late is a five-hour exposure
// and the unreported minutes are a number of their own; and an energy figure states how much of it was
// GUESSED. Proves the wired assets surface against the real pipeline and real RBAC.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const putAsset = (h: ApiHarness, tenantId: string, userId: string, id: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: `/v1/facilities/assets/${id}`, userId, tenantId, idempotencyKey: `as-${id}`, body });

const logService = (h: ApiHarness, tenantId: string, userId: string, assetId: string, serviceId: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: `/v1/facilities/assets/${assetId}/services/${serviceId}`, userId, tenantId, idempotencyKey: `sv-${serviceId}`, body });

const logDowntime = (h: ApiHarness, tenantId: string, userId: string, assetId: string, eventId: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/facilities/assets/${assetId}/downtime/${eventId}`, userId, tenantId, idempotencyKey: key ?? `dt-${eventId}`, body });

const logEnergy = (h: ApiHarness, tenantId: string, userId: string, readingId: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: `/v1/facilities/energy/${readingId}`, userId, tenantId, idempotencyKey: `en-${readingId}`, body });

const health = (h: ApiHarness, tenantId: string, userId: string, branchId: string, asOf: string) =>
  h.request({ method: 'GET', path: '/v1/facilities/assets/health', userId, tenantId, query: { branchId, asOf } });

const downtime = (h: ApiHarness, tenantId: string, userId: string, asOf: string) =>
  h.request({ method: 'GET', path: '/v1/facilities/assets/downtime', userId, tenantId, query: { asOf } });

const energy = (h: ApiHarness, tenantId: string, userId: string, branchId: string, from: string, to: string) =>
  h.request({ method: 'GET', path: '/v1/facilities/energy', userId, tenantId, query: { branchId, from, to } });

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

interface Alert { assetId: string; kind: string; protectsValueMinor?: number; detail: string }
interface Health { critical: Alert[]; other: Alert[] }
interface Down { summaries: { assetId: string; events: number; totalMinutes: number; unreportedMinutes: number; stillDown: boolean }[]; stillDown: number }
const sumOf = (r: Down, id: string) => r.summaries.find((s) => s.assetId === id);

const coldRoom = (over: Record<string, unknown> = {}) => ({
  branchId: 'BR1', name: 'Cold room 1', kind: 'cold_room', criticality: 'critical',
  installedOn: '2020-01-01', protectsValueMinor: 800_000, ...over,
});

describe('facilities assets: critical alone, AMC against value, downtime from failure (M26-FR-01/04)', () => {
  it('reports critical assets in their own list, and an absent AMC against the money it protects', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await putAsset(h, A, 'u-owner', 'cold-1', coldRoom()); // critical, no AMC → amc_missing
    await putAsset(h, A, 'u-owner', 'trolley-1', { branchId: 'BR1', name: 'Shelf trolley', kind: 'handling', criticality: 'routine', installedOn: '2020-01-01' });

    const r = (await health(h, A, 'u-owner', 'BR1', '2026-08-04')).body as Health;
    // The cold room is critical and reported separately; the trolley is not sorted in beside it.
    expect(r.critical.some((a) => a.assetId === 'cold-1' && a.kind === 'amc_missing')).toBe(true);
    expect(r.critical.every((a) => a.assetId !== 'trolley-1')).toBe(true);
    expect(r.other.some((a) => a.assetId === 'trolley-1' && a.kind === 'amc_missing')).toBe(true);
    // "AMC-14 expired" gets ignored; the money is what gets it renewed.
    const coldAmc = r.critical.find((a) => a.assetId === 'cold-1' && a.kind === 'amc_missing');
    expect(coldAmc?.protectsValueMinor).toBe(800_000);
    expect(coldAmc?.detail).toContain('800000');
  });

  it('does not let a breakdown call count as the preventive service it never had', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    // AMC in the future so the only story here is the service clock.
    await putAsset(h, A, 'u-owner', 'chiller-1', coldRoom({ name: 'Chiller 1', kind: 'refrigeration', installedOn: '2026-06-01', amcUntil: '2027-12-31', serviceEveryDays: 30 }));

    // A breakdown call is not preventive maintenance — it must NOT reset the clock.
    await logService(h, A, 'u-owner', 'chiller-1', 'sv-break', { performedOn: '2026-07-20', performedBy: 'u-tech', kind: 'breakdown' });
    let r = (await health(h, A, 'u-owner', 'BR1', '2026-08-04')).body as Health;
    expect(r.critical.some((a) => a.assetId === 'chiller-1' && (a.kind === 'never_serviced' || a.kind === 'service_overdue'))).toBe(true);

    // A real preventive service resets it and the alert clears.
    await logService(h, A, 'u-owner', 'chiller-1', 'sv-prev', { performedOn: '2026-07-28', performedBy: 'u-tech', kind: 'preventive' });
    r = (await health(h, A, 'u-owner', 'BR1', '2026-08-04')).body as Health;
    expect([...r.critical, ...r.other].every((a) => a.assetId !== 'chiller-1')).toBe(true);
  });

  it('measures downtime from failure, keeps unreported minutes apart, and does not double-count a restore', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await putAsset(h, A, 'u-owner', 'cold-1', coldRoom({ amcUntil: '2027-12-31' }));
    await putAsset(h, A, 'u-owner', 'freezer-1', coldRoom({ name: 'Freezer 1', kind: 'freezer', amcUntil: '2027-12-31' }));

    // Down for one hour, but it took four hours before anyone even logged it.
    await logDowntime(h, A, 'u-owner', 'cold-1', 'dt-1', { failedAt: '2026-08-04T06:00:00Z', reportedAt: '2026-08-04T10:00:00Z' }, 'dt1-open');
    // Closing it out supersedes the open record — it must not be counted twice.
    await logDowntime(h, A, 'u-owner', 'cold-1', 'dt-1', { failedAt: '2026-08-04T06:00:00Z', reportedAt: '2026-08-04T10:00:00Z', restoredAt: '2026-08-04T07:00:00Z' }, 'dt1-restore');
    // A second asset is still down.
    await logDowntime(h, A, 'u-owner', 'freezer-1', 'dt-2', { failedAt: '2026-08-04T08:00:00Z', reportedAt: '2026-08-04T08:05:00Z' });

    const r = (await downtime(h, A, 'u-owner', '2026-08-04T12:00:00Z')).body as Down;
    const cold = sumOf(r, 'cold-1');
    expect(cold?.events).toBe(1);            // the restore superseded the open record
    expect(cold?.totalMinutes).toBe(60);     // measured from when it FAILED (06:00 → 07:00)
    expect(cold?.unreportedMinutes).toBe(240); // four hours passed before it was reported
    expect(cold?.stillDown).toBe(false);
    expect(sumOf(r, 'freezer-1')?.stillDown).toBe(true);
    expect(r.stillDown).toBe(1);
  });

  it('states how much of an energy figure was estimated rather than metered', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await logEnergy(h, A, 'u-owner', 'r1', { branchId: 'BR1', onDate: '2026-08-01', kilowattHours: 100, costMinor: 100_000, source: 'meter' });
    await logEnergy(h, A, 'u-owner', 'r2', { branchId: 'BR1', onDate: '2026-08-02', kilowattHours: 50, costMinor: 50_000, source: 'estimate' });

    const r = (await energy(h, A, 'u-owner', 'BR1', '2026-08-01', '2026-08-31')).body as { kilowattHours: number; costMinor: number; estimatedShareBps: number; detail: string };
    expect(r.kilowattHours).toBe(150);
    expect(r.costMinor).toBe(150_000);
    expect(r.estimatedShareBps).toBe(3_333); // 50,000 of 150,000 = 33.33%
    expect(r.detail).toContain('ESTIMATED');
  });

  it('is authorized and per-tenant, and refuses unknown/malformed/impossible', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier'); // a cashier does not manage facilities assets
    await putAsset(h, A, 'u-owner', 'cold-1', coldRoom({ amcUntil: '2027-12-31' }));

    expect((await putAsset(h, A, 'u-cash', 'cold-x', coldRoom())).status).toBe(403);
    expect((await logService(h, A, 'u-owner', 'GHOST', 'sv-1', { performedOn: '2026-08-01', performedBy: 'u-tech', kind: 'preventive' })).status).toBe(404);
    expect((await putAsset(h, A, 'u-owner', 'bad-1', coldRoom({ kind: 'nonsense' }))).status).toBe(400);
    // A restore earlier than the failure cannot be right.
    const impossible = await logDowntime(h, A, 'u-owner', 'cold-1', 'dt-bad', { failedAt: '2026-08-04T10:00:00Z', reportedAt: '2026-08-04T10:05:00Z', restoredAt: '2026-08-04T09:00:00Z' });
    expect(impossible.status).toBe(422);
    expect(codeOf(impossible)).toBe('restored_before_it_failed');

    await h.seedOwner(B, 'u-owner-b');
    const other = (await health(h, B, 'u-owner-b', 'BR1', '2026-08-04')).body as Health;
    expect(other.critical).toEqual([]);
    expect(other.other).toEqual([]);
  });
});
