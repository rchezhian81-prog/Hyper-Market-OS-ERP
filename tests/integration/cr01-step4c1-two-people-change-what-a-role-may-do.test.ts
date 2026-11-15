import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { aBranch } from '../support/a-branch';
import { approvedBody, askForApproval, decide } from '../support/approval-request';
import { actionDetails } from '../../services/identity/src/approval-requests';
import { tenantAccessResolver } from '../../services/api/src/access';
import { alertLifecycleAdapter, effectiveRoleCatalogue, permissionsHeldBy } from '../../services/api/src/adapters';
import { buildStorePackSections } from '../../services/api/src/store-pack-builder';
import { roleAdjustmentAlertIdOf } from '../../services/api/src/role-adjustment-adapters';
import { ROLE_CATALOGUE } from '../../services/api/src/roles';

/**
 * **CR-01 step 4c-1 · OI-06 · ADR-0034 · OB-730 "A" · OB-740 "B" · OB-741 "A": two people change what a role may do — on
 * head office's real pipeline.**
 *   • A store manager asks, the owner approves in his own session, the store manager applies it: the change is recorded
 *     (never an overwrite), audited in the asker's name with the approver named, the owner alerted, and it reaches the
 *     cashier from the very next request — the kernel's access check, the permission lookups, and the store pack.
 *   • Undo is the opposite change, the same way round the other side: the owner asks, a store manager approves.
 *   • Refused: no approval; no re-authentication; two store managers (the owner is always one of the two); the owner
 *     approving his own; an accountant approving the owner's ask; and a never-list change even with an approval in hand.
 */

const T = 't-cr01-4c1';
const MFA = { amr: ['pwd', 'mfa'], authTimeFromNowSeconds: 0 } as const;
const codeOf = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const ADD = { roleId: 'cashier', permission: 'pos.return.approve', change: 'add', reason: 'cashiers approve returns on the late shift' };
const REMOVE = { ...ADD, change: 'remove', reason: 'back to the built-in cashier' };

async function shop(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.provisionOwner(T, 'u-owner');
  await aBranch(h, T, 'u-owner', 'S1');
  await h.provisionRole(T, 'u-mgr', 'store_manager', 'all');
  await h.provisionRole(T, 'u-mgr2', 'store_manager', 'all');
  await h.provisionRole(T, 'u-acct', 'accountant');
  await h.provisionRole(T, 'u-cash', 'cashier', ['S1']);
  return h;
}
const apply = (h: ApiHarness, by: string, requestId: string, body: Record<string, unknown>, auth: object = MFA) =>
  h.request({ method: 'POST', path: `/v1/identity/role-permissions/${requestId}`, userId: by, tenantId: T, idempotencyKey: `rp-${randomUUID()}`, body, ...auth });
const check = (h: ApiHarness, by: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: '/v1/identity/role-permissions/check', userId: by, tenantId: T, idempotencyKey: `rc-${randomUUID()}`, body });
const cashierMay = async (h: ApiHarness): Promise<boolean> =>
  (await tenantAccessResolver(h.store, ROLE_CATALOGUE)(T)).can({ userId: 'u-cash', permission: 'pos.return.approve', branchId: 'S1' });

describe('CR-01 step 4c-1: two people change what a role may do — at head office', () => {
  it('a store manager asks, the owner approves: recorded, audited, alerted, and the cashier holds it from the next request', async () => {
    const h = await shop();
    expect(await cashierMay(h)).toBe(false);

    // Before asking: allowed, who it reaches, and who must approve.
    const c = await check(h, 'u-mgr', { roleId: 'cashier', permission: 'pos.return.approve', change: 'add' });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body).toMatchObject({ allowed: true, affectedPeople: [{ userId: 'u-cash', branchScope: ['S1'] }], approvedBy: 'the owner (in their own session)' });

    const applied = await apply(h, 'u-mgr', 'RP1', await approvedBody(h, T, 'u-mgr', 'u-owner', 'role_permission_change', 'RP1', ADD, { requestId: 'RP1' }));
    expect(applied.status, JSON.stringify(applied.body)).toBe(201);
    expect(applied.body).toMatchObject({ requestId: 'RP1', roleId: 'cashier', permission: 'pos.return.approve', change: 'add', requestedBy: 'u-mgr', approvedBy: 'u-owner', affectedPeople: ['u-cash'] });

    // From the very next request: the kernel's access check, the permission lookups, and the copy the tills read.
    expect(await cashierMay(h)).toBe(true);
    expect(await permissionsHeldBy(h.store, T, 'u-cash')).toContain('pos.return.approve');
    const pack = await buildStorePackSections({ store: h.store, now: () => new Date().toISOString(), signer: undefined as never, settings: async () => undefined, storeName: async () => undefined }, T, 'S1');
    expect((pack['roles'] as { id: string; permissions: string[] }[]).find((r) => r.id === 'cashier')!.permissions).toContain('pos.return.approve');
    // The built-in list itself is unchanged; another shop is untouched.
    expect(ROLE_CATALOGUE.find((r) => r.id === 'cashier')!.permissions).not.toContain('pos.return.approve');
    expect((await effectiveRoleCatalogue(h.store, 't-another-shop')).find((r) => r.id === 'cashier')!.permissions).not.toContain('pos.return.approve');

    // The page's view: what changed from the built-in role, and the history.
    const view = await h.request({ method: 'GET', path: '/v1/identity/role-permissions', userId: 'u-mgr', tenantId: T });
    expect(view.status).toBe(200);
    const body = view.body as { roles: { roleId: string; added: string[]; locked: unknown }[]; history: { requestId: string }[]; ownerReserved: string[] };
    expect(body.roles.find((r) => r.roleId === 'cashier')).toMatchObject({ added: ['pos.return.approve'], locked: null });
    expect(body.roles.find((r) => r.roleId === 'store_computer')!.locked).toMatchObject({ reason: 'machine_role' });
    expect(body.history.map((x) => x.requestId)).toEqual(['RP1']);
    expect(body.ownerReserved).toHaveLength(106); // 105 when decided (OB-741); + CR-01 step 6b's owner-only permission

    // Audited in the asker's name, the approver named; the owner alerted with who it reaches.
    const trail = await h.request({ method: 'GET', path: '/v1/audit/trail', userId: 'u-owner', tenantId: T, query: { objectType: 'role', objectId: 'cashier' } });
    const rows = (trail.body as { matches: { action: string; actorId: string; after: Record<string, string> }[] }).matches;
    expect(rows.find((x) => x.action === 'role.permission.adjust')).toMatchObject({ actorId: 'u-mgr', after: { permission: 'pos.return.approve', change: 'add', approvedBy: 'u-owner', affectedPeople: 'u-cash' } });
    const alerts = await alertLifecycleAdapter({ store: h.store, now: () => new Date().toISOString() }).alerts(T);
    const a = alerts.find((x) => x.alert.alertId === roleAdjustmentAlertIdOf('RP1'));
    expect(a?.alert.ownerUserId).toBe('u-owner');
    expect(a?.alert.detail).toContain('u-mgr asked and u-owner approved: switched ON "pos.return.approve" for the role "Cashier"');
    expect(a?.alert.detail).toContain('It reaches 1 person: u-cash.');

    // Undo: the opposite change, the other way round — the owner asks and a store manager approves.
    const c2 = await check(h, 'u-owner', { roleId: 'cashier', permission: 'pos.return.approve', change: 'remove' });
    expect(c2.body).toMatchObject({ allowed: true, approvedBy: 'a store manager (in their own session)' });
    const undone = await apply(h, 'u-owner', 'RP2', await approvedBody(h, T, 'u-owner', 'u-mgr', 'role_permission_change', 'RP2', REMOVE, { requestId: 'RP2' }));
    expect(undone.status, JSON.stringify(undone.body)).toBe(201);
    expect(await cashierMay(h)).toBe(false);
    const again = (await h.request({ method: 'GET', path: '/v1/identity/role-permissions', userId: 'u-owner', tenantId: T })).body as { roles: { roleId: string; added: string[]; removed: string[] }[]; history: unknown[] };
    expect(again.roles.find((r) => r.roleId === 'cashier')).toMatchObject({ added: [], removed: [] });
    expect(again.history).toHaveLength(2); // nothing overwritten — both changes stay on record
  });

  it('refused: no approval, no re-authentication, an approval spent twice, a change that does not match it', async () => {
    const h = await shop();
    expect(codeOf(await apply(h, 'u-mgr', 'RP1', ADD))).toBe('role_change_needs_a_second_person');
    const body = await approvedBody(h, T, 'u-mgr', 'u-owner', 'role_permission_change', 'RP1', ADD, { requestId: 'RP1' });
    const noMfa = await apply(h, 'u-mgr', 'RP1', body, { amr: ['pwd'], authTimeFromNowSeconds: 0 });
    expect([401, 403]).toContain(noMfa.status);
    // The approval is for exactly this change: another permission with it is refused.
    expect((await apply(h, 'u-mgr', 'RP1', { ...body, permission: 'till.dayclose.approve' })).status).not.toBe(201);
    expect(await cashierMay(h)).toBe(false);
    expect((await apply(h, 'u-mgr', 'RP1', body)).status).toBe(201);
    // Spent once: sending it again under another key changes nothing more.
    expect((await apply(h, 'u-mgr', 'RP1', body)).status).not.toBe(201);
    expect(((await h.request({ method: 'GET', path: '/v1/identity/role-permissions', userId: 'u-owner', tenantId: T })).body as { history: unknown[] }).history).toHaveLength(1);
  });

  it('the owner is always one of the two, and never approves his own (OB-740 "B")', async () => {
    const h = await shop();
    // Two store managers: the second cannot approve (only the owner approves a store manager's ask).
    const asked = await askForApproval(h, T, 'u-mgr', { kind: 'role_permission_change', subjectRef: 'RP1', details: actionDetails(ADD, { requestId: 'RP1' }) });
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    expect((await decide(h, T, 'u-mgr2', (asked.body as { requestId: string }).requestId)).status).not.toBe(201);
    // The owner asks: he cannot approve his own, and an accountant cannot approve it either — a store manager can.
    const own = await askForApproval(h, T, 'u-owner', { kind: 'role_permission_change', subjectRef: 'RP2', details: actionDetails(ADD, { requestId: 'RP2' }) });
    expect(own.status).toBe(201);
    const ownId = (own.body as { requestId: string }).requestId;
    expect((await decide(h, T, 'u-owner', ownId)).status).not.toBe(201);
    expect((await decide(h, T, 'u-acct', ownId)).status).not.toBe(201);
    expect((await decide(h, T, 'u-mgr', ownId)).status).toBe(201);
    expect((await apply(h, 'u-owner', 'RP2', { ...ADD, approvalId: ownId })).status).toBe(201);
    // Nobody else may even ask, check or read the page.
    expect((await askForApproval(h, T, 'u-cash', { kind: 'role_permission_change', subjectRef: 'RP3', details: actionDetails(ADD, { requestId: 'RP3' }) })).status).toBe(403);
    expect((await check(h, 'u-cash', { roleId: 'cashier', permission: 'pos.return.approve', change: 'add' })).status).toBe(403);
    expect((await h.request({ method: 'GET', path: '/v1/identity/role-permissions', userId: 'u-acct', tenantId: T })).status).toBe(403);
  });

  it('the never list is refused at head office even with an approval in hand — and the check route says why', async () => {
    const h = await shop();
    const cases: [Record<string, unknown>, string][] = [
      [{ roleId: 'store_manager', permission: 'identity.role.grant', change: 'add', reason: 'x' }, 'controls_roles_approvals_or_ai'],
      [{ roleId: 'store_manager', permission: 'price.change.approve', change: 'add', reason: 'x' }, 'owner_reserved'],
      [{ roleId: 'owner', permission: 'pos.return.approve', change: 'remove', reason: 'x' }, 'owner_role_never_reduced'],
      [{ roleId: 'store_computer', permission: 'store.pack.read', change: 'remove', reason: 'x' }, 'machine_role'],
      [{ roleId: 'cashier', permission: 'posh.complaint.read', change: 'add', reason: 'x' }, 'posh_committee'],
    ];
    let n = 0;
    for (const [change, reason] of cases) {
      n += 1;
      const checked = await check(h, 'u-mgr', change);
      expect(checked.body, reason).toMatchObject({ allowed: false, refusal: { code: 'not_changeable_from_a_screen', reason } });
      // A request crafted by hand and approved by the owner is still refused when it is applied.
      const id = `NL${n}`;
      const r = await apply(h, 'u-mgr', id, await approvedBody(h, T, 'u-mgr', 'u-owner', 'role_permission_change', id, change, { requestId: id }));
      expect(r.status, reason).toBe(422);
      expect(codeOf(r), reason).toBe('not_changeable_from_a_screen');
    }
    expect(((await h.request({ method: 'GET', path: '/v1/identity/role-permissions', userId: 'u-owner', tenantId: T })).body as { history: unknown[] }).history).toHaveLength(0);
  });

  it('neither person gives a permission they do not hold themselves (§28)', async () => {
    const h = await shop();
    // The owner and the accountant hold identity.access.review; a store manager does not — so a store manager cannot
    // ask to give it to the cashier, and cannot approve the owner's ask either.
    const give = { roleId: 'cashier', permission: 'identity.access.review', change: 'add', reason: 'x' };
    expect((await check(h, 'u-mgr', give)).body).toMatchObject({ allowed: false, refusal: { code: 'you_do_not_hold_it' } });
    const r = await apply(h, 'u-owner', 'G1', await approvedBody(h, T, 'u-owner', 'u-mgr', 'role_permission_change', 'G1', give, { requestId: 'G1' }));
    expect(codeOf(r)).toBe('gives_what_they_do_not_hold');
  });
});
