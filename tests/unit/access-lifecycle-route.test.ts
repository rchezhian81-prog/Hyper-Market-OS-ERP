import { describe, it, expect } from 'vitest';
import { accessLifecycleRoutes, type AccessLifecycleDeps, type LifecycleChange } from '../../services/identity/src/access-lifecycle';
import { ApiError } from '../../services/kernel/src/index';
import type { RequestContext } from '../../services/kernel/src/router';
import type { TokenRevocation } from '../../services/identity/src/revocation';
import { actionDetails, fingerprintOf, type ApprovalPort } from '../../services/identity/src/approval-requests';

/**
 * The lifecycle route's own rules at the handler (Wave 2b-i · PA-02 · §28; since 2b-vi-c-2 the caller ASKS and the approver
 * is an approval they gave in their own session): the approver cannot grant past their own
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
  // Head office's engine, standing in (2b-vi-c-2): request areq-1 was asked by u-hr (the caller) for exactly the change
  // being sent, and approved by u-approver in their own session.
  let details: Record<string, unknown> = {};
  let spent = false;
  const approvals: ApprovalPort = {
    approvalState: (_t, id) => (id !== 'areq-1' ? undefined : {
      request: { requestId: 'areq-1', kind: 'access_change', subjectRef: 'r1', valueMinor: null, fingerprint: fingerprintOf(details), details, summary: 's', reason: 'r', requestedBy: 'u-hr', requestedAt: '2026-10-05T09:00:00.000Z' },
      decision: { requestId: 'areq-1', decision: 'approved', decidedBy: 'u-approver', reason: 'ok', decidedAt: '2026-10-05T09:30:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z' },
      ...(spent ? { usedBy: 'access-change:r1' } : {}),
    }),
    approvalVersion: () => 1,
    spendApproval: () => { spent = true; },
    permissionsOfUser: () => ['identity.role.grant'],
  };
  const deps: AccessLifecycleDeps = {
    approvals,
    now: () => '2026-10-05T10:00:00.000Z',
    roles: () => ROLES,
    currentGrants: (_t, userId) => (over.held ?? []).filter((g) => g.userId === userId),
    permissionsOf: () => over.approverPermissions ?? ['pos.sale.create', 'identity.self.read', 'identity.role.grant'],
    recordChange: (_t, c) => { changes.push(c); },
    revocations: { revoke: (_t, r) => { revocations.push(r); } },
    ...over,
  };
  const route = accessLifecycleRoutes(deps)[0]!;
  const call = (body: Record<string, unknown>, userId = 'u-hr') => {
    details = actionDetails(body, { requestId: 'r1' });
    return route.handler({
      tenantId: T, userId, branchId: null, params: { requestId: 'r1' }, query: {}, body: { ...body, approvalId: 'areq-1' }, traceId: 't', idempotencyKey: 'k',
    } as RequestContext);
  };
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
    expect(await failure(l.call({ event: 'joiner', userId: 'u-new', reason: 'x', grants: [{ userId: 'u-new', roleId: 'cashier', branchScope: 'all' }] })))
      .toEqual({ status: 422, code: 'escalates_beyond_the_approver' });
    expect(l.changes).toHaveLength(0);
    expect(l.revocations).toHaveLength(0);
  });

  it('a session-closing change with no revocation store wired is refused as 503 and records nothing — never half applied', async () => {
    const l = lab({ held: [{ userId: 'u-leaver', roleId: 'cashier', branchScope: 'all' }], revocations: undefined });
    expect(await failure(l.call({ event: 'leaver', userId: 'u-leaver', reason: 'left' })))
      .toEqual({ status: 503, code: 'revocation_store_unavailable' });
    expect(l.changes).toHaveLength(0);
  });

  it('the recorded change is the diff: a mover from cashier@b1 to cashier@b2 + owner@all records two grants added, one removed, and one user-wide revocation at the decision moment', async () => {
    const l = lab({ held: [{ userId: 'u-m', roleId: 'cashier', branchScope: ['b1'] }], approverPermissions: ROLES[1]!.permissions });
    const res = await l.call({ event: 'mover', userId: 'u-m', reason: 'promoted', grants: [{ userId: 'u-m', roleId: 'cashier', branchScope: ['b2'] }, { userId: 'u-m', roleId: 'owner', branchScope: 'all' }] });
    expect(res.status).toBe(200);
    expect((res.body as { recorded: boolean; sessionsClosed: boolean })).toMatchObject({ recorded: true, sessionsClosed: true });
    expect(l.changes).toHaveLength(1);
    expect(l.changes[0]!.added.map((g) => `${g.roleId}@${g.branchScope === 'all' ? 'all' : g.branchScope.join('+')}`)).toEqual(['cashier@b2', 'owner@all']);
    expect(l.changes[0]!.removed.map((g) => `${g.roleId}@${g.branchScope === 'all' ? 'all' : g.branchScope.join('+')}`)).toEqual(['cashier@b1']);
    expect(l.changes[0]!.approvedBy).toBe('u-approver');
    expect(l.revocations).toEqual([expect.objectContaining({ userId: 'u-m', issuedBefore: Math.floor(Date.parse('2026-10-05T10:00:00.000Z') / 1000), reason: 'admin_revoked', revokedBy: 'u-hr' })]);
  });

  it('a blocked decision records nothing and says so', async () => {
    const l = lab({ held: [{ userId: 'u-l', roleId: 'cashier', branchScope: 'all' }] });
    const res = await l.call({ event: 'leaver', userId: 'u-l', reason: 'left', ownedOpenItems: [{ itemId: 'po-1', kind: 'purchase order', description: 'open' }] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ applied: false, recorded: false, sessionsClosed: false });
    expect(l.changes).toHaveLength(0);
    expect(l.revocations).toHaveLength(0);
  });

  // OB-15-c: a leaver who can still sign in at the identity server gets a fresh token no revocation covers.
  it('a leaver\'s sign-in at the identity server is switched off BEFORE anything is recorded, and the outcome says so', async () => {
    const order: string[] = [];
    const l = lab({
      held: [{ userId: 'u-leaver', roleId: 'cashier', branchScope: 'all' }],
      signIns: { end: async (_t, userId, endedBy) => { order.push(`end ${userId} by ${endedBy}`); return 'ended'; } },
      recordChange: () => { order.push('recorded'); },
    });
    const res = await l.call({ event: 'leaver', userId: 'u-leaver', reason: 'left' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ recorded: true, sessionsClosed: true, signIn: 'ended' });
    expect(order).toEqual(['end u-leaver by u-approver', 'recorded']);
  });

  it('when the identity server cannot switch a leaver off, NOTHING changes: 503, no grant removed, no session cut, the approval not spent', async () => {
    const l = lab({
      held: [{ userId: 'u-leaver', roleId: 'cashier', branchScope: 'all' }],
      signIns: { end: async () => { throw new Error('identity server: not reachable'); } },
    });
    expect(await failure(l.call({ event: 'leaver', userId: 'u-leaver', reason: 'left' })))
      .toEqual({ status: 503, code: 'identity_server_unavailable' });
    expect(l.changes).toHaveLength(0);
    expect(l.revocations).toHaveLength(0);
    // The same approval still works once the identity server answers.
    const again = lab({ held: [{ userId: 'u-leaver', roleId: 'cashier', branchScope: 'all' }], signIns: { end: async () => 'none' } });
    expect((await again.call({ event: 'leaver', userId: 'u-leaver', reason: 'left' })).body).toMatchObject({ recorded: true, signIn: 'none' });
  });

  it('a mover or joiner never touches the sign-in; a deployment without the identity server says "not connected" for a leaver', async () => {
    let ended = 0;
    const l = lab({ held: [{ userId: 'u-m', roleId: 'cashier', branchScope: ['b1'] }], signIns: { end: async () => { ended += 1; return 'ended'; } } });
    const moved = await l.call({ event: 'mover', userId: 'u-m', reason: 'moved', grants: [{ userId: 'u-m', roleId: 'cashier', branchScope: ['b2'] }] });
    expect(moved.body).not.toHaveProperty('signIn');
    expect(ended).toBe(0);
    const bare = lab({ held: [{ userId: 'u-leaver', roleId: 'cashier', branchScope: 'all' }] });
    expect((await bare.call({ event: 'leaver', userId: 'u-leaver', reason: 'left' })).body).toMatchObject({ signIn: 'not_connected' });
  });
});
