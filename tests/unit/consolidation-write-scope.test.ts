import { describe, it, expect } from 'vitest';
import { consolidationRoutes } from '../../services/reporting/src/consolidation-route';
import { ApiError, type RequestContext } from '../../services/kernel/src/index';

/**
 * A branch feed writes ITS OWN branch (Wave 2b-ii · PA-01). Only the owner holds `reporting.consolidation.manage` in the
 * catalogue (company-wide), so the API surface cannot show a branch-limited writer; the rule is pinned at the handler.
 */
const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function lab() {
  const written: string[] = [];
  const routes = consolidationRoutes({
    recordContribution: (_t, c) => { written.push(`con:${c.branchId}`); },
    contributions: () => [],
    recordMembership: (_t, m) => { written.push(`mem:${m.branchId}`); },
    memberships: () => [],
    now: () => '2026-09-25T10:00:00.000Z',
  });
  const route = (path: string) => routes.find((r) => r.method === 'POST' && r.path === path)!;
  const ctx = (body: unknown, scope: readonly string[] | 'all' | undefined): RequestContext =>
    ({ tenantId: T, userId: 'u-feed', branchId: 'br-1', ...(scope === undefined ? {} : { scope }), params: {}, query: {}, body, traceId: 't', idempotencyKey: 'k' } as RequestContext);
  return { written, contribute: (branchId: string, scope: readonly string[] | 'all' | undefined) => route('/v1/consolidation/contributions').handler(ctx({ branchId, period: '2026-09', family: 'sales', measures: { grossMinor: 1 }, lastRefreshAt: null, revision: 1 }, scope)),
    member: (branchId: string, scope: readonly string[] | 'all' | undefined) => route('/v1/consolidation/memberships').handler(ctx({ branchId, parentId: 'co-1', from: '2026-01-01' }, scope)) };
}
const refusal = async (p: unknown): Promise<string> => { try { await p; } catch (e) { if (e instanceof ApiError) return e.body.code; throw e; } return 'no-error'; };

describe('consolidation writes name a branch the writer holds', () => {
  it('a br-1 feed writes br-1 and is refused br-2 by name; a company-wide feed writes anywhere; no scope at all writes nothing', async () => {
    const l = lab();
    expect(await refusal(l.contribute('br-2', ['br-1']))).toBe('outside_your_branch_scope');
    expect(await refusal(l.member('br-2', ['br-1']))).toBe('outside_your_branch_scope');
    expect(l.written).toEqual([]);
    await l.contribute('br-1', ['br-1']); await l.member('br-1', ['br-1']);
    await l.contribute('br-2', 'all');
    expect(l.written).toEqual(['con:br-1', 'mem:br-1', 'con:br-2']);
    expect(await refusal(l.contribute('br-1', undefined))).toBe('outside_your_branch_scope');
  });
});
