import { describe, it, expect } from 'vitest';
import { ROLE_CATALOGUE } from '../../services/api/src/roles';
import { apiHarness } from '../support/api-harness';

// OB-395 (owner, 26 Oct 2026): the accountant holds read-only `org.branch.read`, so the Company report — which takes the
// company and its branches from head office (GET /v1/org/nodes, OB-391) — shows its figures for the accountant. Read
// only: the accountant still cannot change the organisation.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const accountant = ROLE_CATALOGUE.find((r) => r.id === 'accountant');

describe('OB-395: the accountant reads the company and its branches, read only', () => {
  it('the accountant role holds org.branch.read and the report read, and no organisation write', () => {
    expect(accountant).toBeDefined();
    const perms = new Set(accountant!.permissions);
    expect(perms.has('org.branch.read')).toBe(true);
    expect(perms.has('reporting.report.read')).toBe(true);
    expect(perms.has('platform.setup.write')).toBe(false);
  });

  it('on the live API the accountant reads the org nodes and the roll-up, and is refused an org change by name', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-acct', 'accountant', 'all');
    expect((await h.request({ method: 'POST', path: '/v1/org/nodes/co-1', userId: 'u-owner', tenantId: A, idempotencyKey: 'n1', body: { kind: 'company', name: 'Test Company One' } })).status).toBe(201);
    expect((await h.request({ method: 'POST', path: '/v1/org/nodes/br-1', userId: 'u-owner', tenantId: A, idempotencyKey: 'n2', body: { kind: 'branch', name: 'Test Branch North', parentId: 'co-1', companyId: 'co-1' } })).status).toBe(201);
    expect((await h.request({ method: 'POST', path: '/v1/consolidation/memberships', userId: 'u-owner', tenantId: A, idempotencyKey: 'm1', body: { branchId: 'br-1', parentId: 'co-1', from: '2026-01-01' } })).status).toBe(201);
    expect((await h.request({ method: 'POST', path: '/v1/consolidation/contributions', userId: 'u-owner', tenantId: A, idempotencyKey: 'c1', body: { branchId: 'br-1', period: '2026-09', family: 'sales', measures: { grossMinor: 100_000, netMinor: 90_000 }, lastRefreshAt: '2026-09-25T09:30:00.000Z', revision: 1 } })).status).toBe(200);

    const nodes = await h.request({ method: 'GET', path: '/v1/org/nodes', userId: 'u-acct', tenantId: A });
    expect(nodes.status).toBe(200);
    expect((nodes.body as { nodes: { nodeId: string; name: string }[] }).nodes.map((n) => n.name).sort()).toEqual(['Test Branch North', 'Test Company One']);

    const roll = await h.request({ method: 'GET', path: '/v1/consolidation', userId: 'u-acct', tenantId: A, query: { node: 'co-1', family: 'sales', period: '2026-09', asOf: '2026-09-25T10:00:00.000Z' } });
    expect(roll.status).toBe(200);
    expect((roll.body as { measures: Record<string, number> }).measures['grossMinor']).toBe(100_000);

    const write = await h.request({ method: 'POST', path: '/v1/org/nodes/br-9', userId: 'u-acct', tenantId: A, idempotencyKey: 'n9', body: { kind: 'branch', name: 'X', parentId: 'co-1', companyId: 'co-1' } });
    expect(write.status).toBe(403);
  });
});
