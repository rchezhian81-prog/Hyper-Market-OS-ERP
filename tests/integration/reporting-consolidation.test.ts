import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// API-10 company-wide consolidation (M01/M29/D13, owner decision) — branches POST their period
// contributions + memberships; the head office GETs the roll-up for a node/family/period. Durable and
// per-tenant: idempotent by revision (a re-send never doubles), a correction supersedes, an effective-dated
// hierarchy, worst-freshness + missing named, reconciliation, and scope-enforced totals (§28) — all rebuilt
// from the append-only store across a cold restart.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const member = (h: ApiHarness, u: string, t: string, branchId: string, parentId: string, from = '2026-01-01') =>
  h.request({ method: 'POST', path: '/v1/consolidation/memberships', userId: u, tenantId: t, idempotencyKey: `mem-${t}-${branchId}-${from}`, body: { branchId, parentId, from } });

const contribute = (h: ApiHarness, u: string, t: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: '/v1/consolidation/contributions', userId: u, tenantId: t, idempotencyKey: key ?? `con-${t}-${String(body['branchId'])}-${String(body['period'])}-${String(body['family'])}-${String(body['revision'])}`, body });

const rollup = (h: ApiHarness, u: string, t: string, q: Record<string, string>) =>
  h.request({ method: 'GET', path: '/v1/consolidation', userId: u, tenantId: t, query: q });

interface Report {
  readonly measures: Record<string, number>;
  readonly reportedBranches: readonly string[];
  readonly missingBranches: readonly string[];
  readonly withheldByScope: readonly string[];
  readonly reconciles: boolean;
  readonly freshness: { readonly state: string };
}

const salesBody = (branchId: string, over: Record<string, unknown> = {}) => ({
  branchId, period: '2026-09', family: 'sales',
  measures: { grossMinor: 100_000, netMinor: 90_000, marginMinor: 30_000 },
  lastRefreshAt: '2026-09-25T09:30:00.000Z', revision: 1, ...over,
});
const Q = { node: 'co-1', family: 'sales', period: '2026-09', asOf: '2026-09-25T10:00:00.000Z' };

describe('company-wide consolidation on the live surface (M01/M29/D13)', () => {
  it('rolls two branches up to the company and reconciles', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await member(h, 'u-owner', A, 'br-1', 'co-1');
    await member(h, 'u-owner', A, 'br-2', 'co-1');
    await contribute(h, 'u-owner', A, salesBody('br-1', { measures: { grossMinor: 100_000, netMinor: 90_000, marginMinor: 30_000 } }));
    await contribute(h, 'u-owner', A, salesBody('br-2', { measures: { grossMinor: 250_000, netMinor: 225_000, marginMinor: 60_000 } }));

    const res = await rollup(h, 'u-owner', A, Q);
    expect(res.status).toBe(200);
    const r = res.body as Report;
    expect(r.measures).toEqual({ grossMinor: 350_000, netMinor: 315_000, marginMinor: 90_000 });
    expect(r.reportedBranches).toEqual(['br-1', 'br-2']);
    expect(r.reconciles).toBe(true);
    expect(r.freshness.state).toBe('fresh');
  });

  it('is idempotent by revision — a re-send never doubles; a higher revision supersedes', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await member(h, 'u-owner', A, 'br-1', 'co-1');
    expect((await contribute(h, 'u-owner', A, salesBody('br-1'))).body).toMatchObject({ outcome: 'ingested' });
    // same revision, different (wrong) numbers, different idempotency key → engine IGNORES it
    const dup = await contribute(h, 'u-owner', A, salesBody('br-1', { measures: { grossMinor: 999_999 } }), 'con-dup');
    expect(dup.body).toMatchObject({ outcome: 'ignored_duplicate' });
    expect((await rollup(h, 'u-owner', A, Q)).body as Report).toMatchObject({ measures: { grossMinor: 100_000 } });
    // higher revision → REPLACES (late/corrected)
    const corrected = await contribute(h, 'u-owner', A, salesBody('br-1', { revision: 2, measures: { grossMinor: 120_000, netMinor: 108_000, marginMinor: 36_000 } }));
    expect(corrected.body).toMatchObject({ outcome: 'replaced_by_correction' });
    expect(((await rollup(h, 'u-owner', A, Q)).body as Report).measures['grossMinor']).toBe(120_000);
  });

  it('names a MISSING branch and does not reconcile (P-08)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await member(h, 'u-owner', A, 'br-1', 'co-1');
    await member(h, 'u-owner', A, 'br-2', 'co-1'); // br-2 open but silent
    await contribute(h, 'u-owner', A, salesBody('br-1'));
    const r = (await rollup(h, 'u-owner', A, Q)).body as Report;
    expect(r.reconciles).toBe(false);
    expect(r.missingBranches).toEqual(['br-2']);
  });

  it('enforces scope — a branch-scoped reader sees only their branch, the rest withheld (§28)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await member(h, 'u-owner', A, 'br-1', 'co-1');
    await member(h, 'u-owner', A, 'br-2', 'co-1');
    await contribute(h, 'u-owner', A, salesBody('br-1', { measures: { grossMinor: 100_000 } }));
    await contribute(h, 'u-owner', A, salesBody('br-2', { measures: { grossMinor: 250_000 } }));
    const r = (await rollup(h, 'u-owner', A, { ...Q, scope: 'br-1' })).body as Report;
    expect(r.measures['grossMinor']).toBe(100_000);
    expect(r.withheldByScope).toEqual(['br-2']);
  });

  it('is durable across a cold restart — the roll-up rebuilds from the store', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await member(h, 'u-owner', A, 'br-1', 'co-1');
    await contribute(h, 'u-owner', A, salesBody('br-1', { revision: 1 }));
    await contribute(h, 'u-owner', A, salesBody('br-1', { revision: 2, measures: { grossMinor: 111_000, netMinor: 100_000, marginMinor: 33_000 } }));
    const restarted = apiHarness({ store: h.store });
    const r = (await rollup(restarted, 'u-owner', A, Q)).body as Report;
    expect(r.measures['grossMinor']).toBe(111_000); // the correction survived the restart, not the original
  });

  it('is per-tenant — one company\'s branches never appear in another\'s roll-up', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-a');
    await h.seedOwner(B, 'u-b');
    await member(h, 'u-a', A, 'br-1', 'co-1');
    await contribute(h, 'u-a', A, salesBody('br-1'));
    // B has nothing under co-1.
    const rb = (await rollup(h, 'u-b', B, Q)).body as Report;
    expect(rb.reportedBranches).toEqual([]);
    expect((rb.measures['grossMinor'] ?? 0)).toBe(0);
  });

  it('gates ingestion and reads — a cashier can do neither', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');
    await member(h, 'u-owner', A, 'br-1', 'co-1');
    expect((await contribute(h, 'u-cash', A, salesBody('br-1'))).status).toBe(403);
    expect((await rollup(h, 'u-cash', A, Q)).status).toBe(403);
    expect((await rollup(h, 'u-owner', A, Q)).status).toBe(200);
  });
});
