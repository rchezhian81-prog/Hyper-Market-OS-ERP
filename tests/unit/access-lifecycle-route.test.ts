import { describe, it, expect } from 'vitest';
import { accessLifecycleRoutes, type AccessLifecycleDeps, type LifecycleChange } from '../../services/identity/src/access-lifecycle';
import { ApiError } from '../../services/kernel/src/index';
import type { RequestContext } from '../../services/kernel/src/router';
import type { TokenRevocation } from '../../services/identity/src/revocation';

/**
 * The lifecycle route's own rules at the handler (Wave 2b-i · PA-02 · §28): the approver cannot grant past their own
 * authority (only the owner holds `identity.role.grant` in the catalogue, so the API surface cannot show this case —
 * the rule is pinned here), a session-closing change without a revocation store records NOTHING, and the recorded
 * change is exactly the diff between what the ledger says and what was decided.
 */

const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ROLES = [
  { id: 'cashier', name: 'Cashier', permissions: ['pos.sale.create', 'identity.self.read'] },
  { id: 'owner', name: 'Owner', permissions: ['pos.sale.create', 'identity.self.read', 'identity.role.grant', 'everything.else'] },
];

function lab(over: Partial<AccessLifecycleDeps> & { held?: readonly { userId: string; roleId: string; branchScope: readonly string[] | 'all' }[]; approverPermissions?: readonly string[] }) {
  const changes: LifecycleChange[] = [];
  const revocations: TokenRevocation[] = [];
  const deps: AccessLifecycleDeps = {
    now: () => '2026-10-05T10:00:00.000Z',
    roles: () => ROLES,
    currentGrants: (_t, userId) => (over.held ?? []).filter((g) => g.userId === userId),
    permissionsOf: () => over.approverPermissions ?? ['pos.sale.create', 'identity.self.read', 'identity.role.grant'],
    recordChange: (_t, c) => { changes.push(c); },
    revocations: { revoke: (_t, r) => { revocations.push(r); } },
    ...over,
  };
  const route = accessLifecycleRoutes(deps)[0]!;
  const call = (body: Record<string, unknown>, userId = 'u-approver') => route.handler({
    tenantId: T, userId, branchId: null, params: { requestId: 'r1' }, query: {}, body, traceId: 't', idempotencyKey: 'k',
  } as RequestContext);
  return { call, changes, revocations };
}

const failure = async (p: unknown): Promise<{ status: number; code: string }> => {
  try { await p; } catch (e) {
    if (e instanceof ApiError) {
      const b = e.body as unknown as { code?: string; error?: { code?: string } };
      return { status: e.status, code: b.code ?? b.error?.code ?? '' };
    }
    throw e;
  }
  throw new Error('expected the handler to refuse');
};

describe('the lifecycle route at the handler', () => {
  it('an approver who does not hold what the role grants cannot grant it — nothing recorded, no session touched', async () => {
    const l = lab({ approverPermissions: ['identity.role.grant', 'identity.self.read'] }); // not pos.sale.create
    expect(await failure(l.call({ event: 'joiner', userId: 'u-new', requestedBy: 'u-hr', reason: 'x', grants: [{ userId: 'u-new', roleId: 'cashier', branchScope: 'all' }] })))
      .toEqual({ status: 422, code: 'escalates_beyond_the_approver' });
    expect(l.changes).toHaveLength(0);
    expect(l.revocations).toHaveLength(0);
  });

  it('a session-closing change with no revocation store wired is refused as 503 and records nothing — never half applied', async () => {
    const l = lab({ held: [{ userId: 'u-leaver', roleId: 'cashier', branchScope: 'all' }], revocations: undefined });
    expect(await failure(l.call({ event: 'leaver', userId: 'u-leaver', requestedBy: 'u-hr', reason: 'left' })))
      .toEqual({ status: 503, code: 'revocation_store_unavailable' });
    expect(l.changes).toHaveLength(0);
  });

  it('the recorded change is the diff: a mover from cashier@b1 to cashier@b2 + owner@all records two grants added, one removed, and one user-wide revocation at the decision moment', async () => {
    const l = lab({ held: [{ userId: 'u-m', roleId: 'cashier', branchScope: ['b1'] }], approverPermissions: ROLES[1]!.permissions });
    const res = await l.call({ event: 'mover', userId: 'u-m', requestedBy: 'u-hr', reason: 'promoted', grants: [{ userId: 'u-m', roleId: 'cashier', branchScope: ['b2'] }, { userId: 'u-m', roleId: 'owner', branchScope: 'all' }] });
    expect(res.status).toBe(200);
    expect((res.body as { recorded: boolean; sessionsClosed: boolean })).toMatchObject({ recorded: true, sessionsClosed: true });
    expect(l.changes).toHaveLength(1);
    expect(l.changes[0]!.added.map((g) => `${g.roleId}@${g.branchScope === 'all' ? 'all' : g.branchScope.join('+')}`)).toEqual(['cashier@b2', 'owner@all']);
    expect(l.changes[0]!.removed.map((g) => `${g.roleId}@${g.branchScope === 'all' ? 'all' : g.branchScope.join('+')}`)).toEqual(['cashier@b1']);
    expect(l.changes[0]!.approvedBy).toBe('u-approver');
    expect(l.revocations).toEqual([expect.objectContaining({ userId: 'u-m', issuedBefore: Math.floor(Date.parse('2026-10-05T10:00:00.000Z') / 1000), reason: 'admin_revoked', revokedBy: 'u-approver' })]);
  });

  it('a blocked decision records nothing and says so', async () => {
    const l = lab({ held: [{ userId: 'u-l', roleId: 'cashier', branchScope: 'all' }] });
    const res = await l.call({ event: 'leaver', userId: 'u-l', requestedBy: 'u-hr', reason: 'left', ownedOpenItems: [{ itemId: 'po-1', kind: 'purchase order', description: 'open' }] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ applied: false, recorded: false, sessionsClosed: false });
    expect(l.changes).toHaveLength(0);
    expect(l.revocations).toHaveLength(0);
  });
});
