import { describe, it, expect } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { aBranch } from '../support/a-branch';
import { privilegeSealKey } from '../../packages/identity/src/till-seal';
import { sealPrivilegeRecord, type PrivilegeKind, type PrivilegeRecord } from '../../packages/identity/src/privilege-seal';
import { alertLifecycleAdapter, peopleAdapter } from '../../services/api/src/adapters';
import { privilegeAlertIdOf } from '../../services/api/src/box-privilege-adapters';

/**
 * **CR-01 step 4b-1 · OI-06 · ADR-0033 (amended) · OB-733 "A" · OB-735: head office adds a STORE-PC PERSON, takes a
 * rejection, and answers the store PC's read for its Users & roles page — on head office's real pipeline.**
 *
 *   • A person added on the store PC is a name and a staff id on head office's people register, state `store_pc` — no
 *     sign-in made anywhere. One person adds them (the maker's word, `identity.role.request`), by PIN; it is audited in their
 *     name with `via: office_pin` and the owner is alerted. The new person holds NOTHING until a role is asked for and approved
 *     by a second person. Refused by code: a sign-in name or a PIN in the body, a job or shared name, oneself, somebody already
 *     on the register or already holding a role, an acting person without the maker's word.
 *   • A second person turns a pending request down by PIN, with a reason: the request stays, rejected, and cannot be approved.
 *   • The store PC reads the page's lists for the person signed in on its office screens: head office judges THAT person's own
 *     authority, and answers for the box's own store only — a role held only at another store is not shown.
 */

const T = 't-cr01-4b1';
const PRIVILEGE_SECRET = randomBytes(32).toString('base64url');
const KEY = privilegeSealKey(PRIVILEGE_SECRET);

async function shop(): Promise<ApiHarness> {
  const h = apiHarness({ privilegeSealSecret: PRIVILEGE_SECRET });
  await h.provisionOwner(T, 'u-owner');
  await aBranch(h, T, 'u-owner', 'S1');
  await aBranch(h, T, 'u-owner', 'S2');
  await h.provisionRole(T, 'u-mgr', 'store_manager', ['S1']);
  await h.provisionRole(T, 'u-cash', 'cashier', ['S1']);
  await h.provisionRole(T, 'u-far', 'cashier', ['S2']);
  await h.provisionRole(T, 'u-box', 'store_computer', ['S1']);
  return h;
}

const record = (kind: PrivilegeKind, userId: string, body: Record<string, unknown>, over: Partial<PrivilegeRecord> = {}): PrivilegeRecord => ({
  kind, tenantId: T, userId, requestId: randomUUID(), confirmedAt: new Date().toISOString(), via: 'office_pin', body, ...over,
});
const relay = (h: ApiHarness, path: string, body: unknown, as = 'u-box') =>
  h.request({ method: 'POST', path, userId: as, tenantId: T, body, idempotencyKey: `k-${randomUUID()}` });
const view = (h: ApiHarness, forUser: string | undefined, as = 'u-box') =>
  h.request({ method: 'GET', path: '/v1/identity/box/users-view', userId: as, tenantId: T, ...(forUser === undefined ? {} : { query: { for: forUser } }) });
const codeOf = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const add = (h: ApiHarness, by: string, body: Record<string, unknown>) => relay(h, '/v1/identity/box/people', sealPrivilegeRecord(KEY, record('person_provision', by, body)));
const ask = (grantId: string, userId: string, roleId = 'cashier', branchScope: readonly string[] | 'all' = ['S1']) => ({ grantId, userId, roleId, branchScope, reason: 'new cashier for the morning shift' });

describe('CR-01 step 4b-1: a store-PC person, a rejection by PIN, and the page\'s lists — at head office', () => {
  it('the manager adds a person by PIN: a store-PC person, no sign-in, audited in his name, the owner alerted — holding nothing', async () => {
    const h = await shop();
    const added = record('person_provision', 'u-mgr', { userId: 'priya.k', displayName: 'Priya  Kumar' });
    const r = await relay(h, '/v1/identity/box/people', sealPrivilegeRecord(KEY, added));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ userId: 'priya.k', displayName: 'Priya Kumar', state: 'store_pc', signIn: 'none', via: 'office_pin' });

    const people = await peopleAdapter({ store: h.store, now: () => new Date().toISOString() }).people(T);
    expect(people.find((p) => p.userId === 'priya.k')).toMatchObject({ displayName: 'Priya Kumar', state: 'store_pc', secondFactor: false, requestedBy: 'u-mgr' });
    expect(JSON.stringify(people)).not.toMatch(/password|pin/i);

    // Audited in the MANAGER's name, marked office_pin, naming the box.
    const trail = await h.request({ method: 'GET', path: '/v1/audit/trail', userId: 'u-owner', tenantId: T, query: { objectType: 'user', objectId: 'priya.k' } });
    const rows = (trail.body as { matches: { action: string; actorId: string; after: Record<string, string> }[] }).matches;
    expect(rows.find((x) => x.action === 'person.store_pc.record')).toMatchObject({ actorId: 'u-mgr', after: { displayName: 'Priya Kumar', via: 'office_pin', relayedBy: 'u-box', privilegeRequestId: added.requestId } });

    // The owner is told the same day.
    const alerts = await alertLifecycleAdapter({ store: h.store, now: () => new Date().toISOString() }).alerts(T);
    const a = alerts.find((x) => x.alert.alertId === privilegeAlertIdOf(added.requestId));
    expect(a?.alert.ownerUserId).toBe('u-owner');
    expect(a?.alert.component).toContain('person added');
    expect(a?.alert.detail).toContain('u-mgr added a new person on the store PC: Priya Kumar (staff id priya.k)');
    expect(a?.alert.detail).toContain('They hold no role yet');

    // Holding nothing: the role still takes two people — asked by the manager, approved by the owner.
    const grantsBefore = await h.request({ method: 'GET', path: '/v1/identity/grants', userId: 'u-owner', tenantId: T });
    expect(JSON.stringify(grantsBefore.body)).not.toContain('priya.k');
    const askedP = await relay(h, '/v1/identity/box/grants', sealPrivilegeRecord(KEY, record('role_request', 'u-mgr', ask('g-p', 'priya.k'))));
    expect(askedP.status, JSON.stringify(askedP.body)).toBe(202);
    const ok = await relay(h, '/v1/identity/box/grants/g-p/approve', sealPrivilegeRecord(KEY, record('role_grant_approval', 'u-owner', { grantId: 'g-p' })));
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const grants = await h.request({ method: 'GET', path: '/v1/identity/grants', userId: 'u-owner', tenantId: T });
    expect((grants.body as { grants: { userId: string; roleId: string }[] }).grants).toContainEqual(expect.objectContaining({ userId: 'priya.k', roleId: 'cashier' }));
  });

  it('refused by code: a sign-in name or a PIN in the body, a job name, oneself, a known person, a role-holder, no maker\'s word', async () => {
    const h = await shop();
    expect(codeOf(await add(h, 'u-mgr', { userId: 'priya.k', displayName: 'Priya K', pin: '123456' }))).toBe('not_readable_as_a_person');
    expect(codeOf(await add(h, 'u-mgr', { signInName: 'priya.k', displayName: 'Priya K' }))).toBe('not_readable_as_a_person');
    expect(codeOf(await add(h, 'u-mgr', { userId: 'P K', displayName: 'Priya K' }))).toBe('not_readable_as_a_person');
    expect(codeOf(await add(h, 'u-mgr', { userId: 'cashier2', displayName: 'Cashier' }))).toBe('shared_or_generic_sign_in');
    expect(codeOf(await add(h, 'u-mgr', { userId: 'u-mgr', displayName: 'Mani Gopal' }))).toBe('signing_in_yourself');
    expect(codeOf(await add(h, 'u-mgr', { userId: 'u-cash', displayName: 'Kala R' }))).toBe('person_already_holds_authority');
    const cashier = await add(h, 'u-cash', { userId: 'ravi.s', displayName: 'Ravi S' });
    expect(cashier.status).toBe(403);
    expect(codeOf(cashier)).toBe('acting_person_lacks_authority');
    // Added once; the same staff id again (a new confirmation) is refused, never a second record.
    expect((await add(h, 'u-mgr', { userId: 'ravi.s', displayName: 'Ravi S' })).status).toBe(201);
    const again = await add(h, 'u-owner', { userId: 'ravi.s', displayName: 'Ravi Shankar' });
    expect(again.status).toBe(409);
    expect(codeOf(again)).toBe('person_already_known');
    const people = await peopleAdapter({ store: h.store, now: () => new Date().toISOString() }).people(T);
    expect(people.filter((p) => p.userId === 'ravi.s')).toHaveLength(1);
    expect(people.map((p) => p.userId)).not.toContain('priya.k');
  });

  it('only a store computer relays it, with the privilege key — the owner\'s own token is refused', async () => {
    const h = await shop();
    const r = await relay(h, '/v1/identity/box/people', sealPrivilegeRecord(KEY, record('person_provision', 'u-mgr', { userId: 'priya.k', displayName: 'Priya K' })), 'u-owner');
    expect(r.status).toBe(403);
    expect(codeOf(r)).toBe('not_a_store_computer');
    const wrongKey = await relay(h, '/v1/identity/box/people', sealPrivilegeRecord(privilegeSealKey(randomBytes(32).toString('hex')), record('person_provision', 'u-mgr', { userId: 'priya.k', displayName: 'Priya K' })));
    expect(codeOf(wrongKey)).toBe('privilege_seal_does_not_match');
  });

  it('a second person rejects by PIN with a reason: it stays, rejected, audited in their name — and cannot be approved after', async () => {
    const h = await shop();
    expect((await relay(h, '/v1/identity/box/grants', sealPrivilegeRecord(KEY, record('role_request', 'u-mgr', ask('g-r', 'u-new'))))).status).toBe(202);
    // A reason is required (the person's own route's rule).
    const bare = await relay(h, '/v1/identity/box/grants/g-r/reject', sealPrivilegeRecord(KEY, record('role_grant_rejection', 'u-owner', { grantId: 'g-r' })));
    expect(bare.status).toBe(400);
    expect(codeOf(bare)).toBe('rejection_needs_reason');
    // The manager does not hold the checker's word.
    const mgr = await relay(h, '/v1/identity/box/grants/g-r/reject', sealPrivilegeRecord(KEY, record('role_grant_rejection', 'u-mgr', { grantId: 'g-r', reason: 'no' })));
    expect(codeOf(mgr)).toBe('acting_person_lacks_authority');
    // Sealed for another request.
    const other = await relay(h, '/v1/identity/box/grants/g-r/reject', sealPrivilegeRecord(KEY, record('role_grant_rejection', 'u-owner', { grantId: 'g-x', reason: 'no' })));
    expect(codeOf(other)).toBe('privilege_record_does_not_match');

    const rejected = record('role_grant_rejection', 'u-owner', { grantId: 'g-r', reason: 'we already have enough cashiers' });
    const r = await relay(h, '/v1/identity/box/grants/g-r/reject', sealPrivilegeRecord(KEY, rejected));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ grantId: 'g-r', state: 'rejected', rejectedBy: 'u-owner', via: 'office_pin' });

    const trail = await h.request({ method: 'GET', path: '/v1/audit/trail', userId: 'u-owner', tenantId: T, query: { objectType: 'user', objectId: 'u-new' } });
    const rows = (trail.body as { matches: { action: string; actorId: string; after: Record<string, string> }[] }).matches;
    expect(rows.find((x) => x.action === 'role.grant.reject')).toMatchObject({ actorId: 'u-owner', after: { roleId: 'cashier', requestedBy: 'u-mgr', rejectedBy: 'u-owner', reason: 'we already have enough cashiers', via: 'office_pin', relayedBy: 'u-box' } });

    const late = await relay(h, '/v1/identity/box/grants/g-r/approve', sealPrivilegeRecord(KEY, record('role_grant_approval', 'u-owner', { grantId: 'g-r' })));
    expect(late.status).toBe(422);
    expect(codeOf(late)).toBe('grant_request_rejected');
  });

  it('the page\'s lists: the person\'s OWN authority, this store only — never a role held only at another store', async () => {
    const h = await shop();
    expect((await relay(h, '/v1/identity/box/grants', sealPrivilegeRecord(KEY, record('role_request', 'u-mgr', ask('g-here', 'u-new'))))).status).toBe(202);
    expect((await relay(h, '/v1/identity/box/grants', sealPrivilegeRecord(KEY, record('role_request', 'u-owner', ask('g-there', 'u-new2', 'cashier', ['S2']))))).status).toBe(202);
    expect((await add(h, 'u-mgr', { userId: 'priya.k', displayName: 'Priya K' })).status).toBe(201);

    // The owner: the roles, who holds what HERE, and what waits HERE.
    const owner = await view(h, 'u-owner');
    expect(owner.status, JSON.stringify(owner.body)).toBe(200);
    const o = owner.body as { mayAsk: boolean; mayRead: boolean; mayDecide: boolean; storeId: string; roles: { id: string }[]; grants: { userId: string }[]; pending: { grantId: string }[]; people: { userId: string; state: string }[] };
    expect(o).toMatchObject({ mayAsk: true, mayRead: true, mayDecide: true, storeId: 'S1' });
    expect(o.roles.map((r) => r.id)).toContain('cashier');
    expect(o.grants.map((g) => g.userId)).toEqual(expect.arrayContaining(['u-owner', 'u-mgr', 'u-cash']));
    expect(o.grants.map((g) => g.userId)).not.toContain('u-far');
    expect(o.pending.map((p) => p.grantId)).toEqual(['g-here']);
    expect(o.people).toContainEqual({ userId: 'priya.k', displayName: 'Priya K', state: 'store_pc' });

    // The store manager asks but does not read what waits (as on his own routes).
    const m = (await view(h, 'u-mgr')).body as Record<string, unknown>;
    expect(m).toMatchObject({ mayAsk: true, mayRead: false, mayDecide: false });
    expect(m['grants']).toBeDefined();
    expect(m['pending']).toBeUndefined();

    // A cashier sees no list at all.
    const c = (await view(h, 'u-cash')).body as Record<string, unknown>;
    expect(c).toMatchObject({ mayAsk: false, mayRead: false });
    for (const k of ['roles', 'grants', 'pending', 'people']) expect(c[k]).toBeUndefined();
  });

  it('the lists are read by the store computer only, and only for a named person', async () => {
    const h = await shop();
    const asOwner = await view(h, 'u-owner', 'u-owner');
    expect(asOwner.status).toBe(403);
    expect(codeOf(asOwner)).toBe('not_a_store_computer');
    expect((await view(h, 'u-owner', 'u-mgr')).status).toBe(403);
    const nobody = await view(h, undefined);
    expect(nobody.status).toBe(400);
    expect(codeOf(nobody)).toBe('needs_a_person');
  });
});
