import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// M18-FR-01 / D08 — the per-tenant, effective-dated serviceability policy on the live surface (API-07).
// The owner sets which addresses the store delivers to (radius/fee/threshold/minimum) FROM A DATE; until
// he does, resolving falls back to the D08 default (10 km) and NEVER 404s — the store is serviceable from
// day one. Append-only: a change is a later-dated period; a different policy on the same date is refused.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

const setPeriod = (h: ApiHarness, u: string, t: string, from: string, policy: unknown, key = `svc-${from}`) =>
  h.request({ method: 'POST', path: `/v1/serviceability/periods/${from}`, userId: u, tenantId: t, idempotencyKey: key, body: policy });
const resolveOn = (h: ApiHarness, u: string, t: string, on: string) =>
  h.request({ method: 'GET', path: '/v1/serviceability', userId: u, tenantId: t, query: { on } });
const listPeriods = (h: ApiHarness, u: string, t: string) =>
  h.request({ method: 'GET', path: '/v1/serviceability/periods', userId: u, tenantId: t });

interface Resolved { readonly source: string; readonly effectiveFrom: string | null; readonly policy: { radiusMetres?: number; deliveryFeeMinor?: number } }

describe('serviceability configuration on the live surface (M18-FR-01 / D08)', () => {
  it('resolves to the D08 default (10 km) before anything is configured — never 404s', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const res = await resolveOn(h, 'u-owner', A, '2026-09-24');
    expect(res.status).toBe(200);
    expect(res.body as Resolved).toMatchObject({ source: 'default', effectiveFrom: null });
    expect((res.body as Resolved).policy.radiusMetres).toBe(10_000);
  });

  it('sets an effective-dated policy and resolves it, switching on the effective-from boundary; durable across restart', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    expect((await setPeriod(h, 'u-owner', A, '2026-07-01', { radiusMetres: 8_000, deliveryFeeMinor: 3_000 })).status).toBe(201);
    expect((await setPeriod(h, 'u-owner', A, '2026-10-01', { radiusMetres: 12_000, deliveryFeeMinor: 2_000 })).status).toBe(201);

    // day before the later period → the earlier policy
    expect(((await resolveOn(h, 'u-owner', A, '2026-09-30')).body as Resolved).policy.radiusMetres).toBe(8_000);
    // on the effective-from day → the new policy
    const onDay = (await resolveOn(h, 'u-owner', A, '2026-10-01')).body as Resolved;
    expect(onDay).toMatchObject({ source: 'scheduled', effectiveFrom: '2026-10-01' });
    expect(onDay.policy.radiusMetres).toBe(12_000);

    // Durable across a cold restart (a fresh surface over the same event store).
    const restarted = apiHarness({ store: h.store });
    expect(((await resolveOn(restarted, 'u-owner', A, '2026-10-01')).body as Resolved).policy.radiusMetres).toBe(12_000);
  });

  it('lists the whole schedule, sorted by effective date', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await setPeriod(h, 'u-owner', A, '2026-10-01', { radiusMetres: 12_000 });
    await setPeriod(h, 'u-owner', A, '2026-07-01', { radiusMetres: 8_000 });
    const body = (await listPeriods(h, 'u-owner', A)).body as { schedule: { effectiveFrom: string }[]; count: number };
    expect(body.count).toBe(2);
    expect(body.schedule.map((p) => p.effectiveFrom)).toEqual(['2026-07-01', '2026-10-01']);
  });

  it('refuses a DIFFERENT policy on the same effective date, but an identical re-send is idempotent', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    expect((await setPeriod(h, 'u-owner', A, '2026-07-01', { radiusMetres: 8_000 }, 'k1')).status).toBe(201);
    const clash = await setPeriod(h, 'u-owner', A, '2026-07-01', { radiusMetres: 9_000 }, 'k2');
    expect(clash.status).toBe(409);
    expect(codeOf(clash)).toBe('serviceability_already_set_on_that_date');
    // identical re-send → 201, no duplicate period
    expect((await setPeriod(h, 'u-owner', A, '2026-07-01', { radiusMetres: 8_000 }, 'k3')).status).toBe(201);
    expect(((await listPeriods(h, 'u-owner', A)).body as { count: number }).count).toBe(1);
  });

  it('is per-tenant: one shop\'s serviceability never affects another\'s', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner-a');
    await h.seedOwner(B, 'u-owner-b');
    await setPeriod(h, 'u-owner-a', A, '2026-07-01', { radiusMetres: 8_000 });
    // B configured nothing → still the default.
    expect((await resolveOn(h, 'u-owner-b', B, '2026-09-24')).body as Resolved).toMatchObject({ source: 'default' });
  });

  it('rejects a malformed policy and a missing date, and gates on the serviceability permissions', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier'); // holds neither serviceability permission
    const bad = await setPeriod(h, 'u-owner', A, '2026-07-01', { radiusMetres: -5 });
    expect(bad.status).toBe(400);
    expect(codeOf(bad)).toBe('not_readable_as_a_serviceability_policy');
    const noDate = await h.request({ method: 'GET', path: '/v1/serviceability', userId: 'u-owner', tenantId: A });
    expect(noDate.status).toBe(400);
    expect((await setPeriod(h, 'u-cash', A, '2026-07-01', { radiusMetres: 8_000 }, 'c1')).status).toBe(403);
    expect((await resolveOn(h, 'u-cash', A, '2026-09-24')).status).toBe(403);
  });
});
