import { describe, it, expect } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { aBranch } from '../support/a-branch';
import { privilegeSealKey } from '../../packages/identity/src/till-seal';
import { sealPrivilegeRecord, type PrivilegeKind, type PrivilegeRecord } from '../../packages/identity/src/privilege-seal';
import { alertLifecycleAdapter, peopleAdapter } from '../../services/api/src/adapters';
import { privilegeAlertIdOf } from '../../services/api/src/box-privilege-adapters';

/**
 * **CR-01 step 4b-2 · OI-06 · ADR-0033 amendment 2 · OB-734 "A" · OB-735 "A" · OB-737 "A": head office takes a role back,
 * records a leaver, and records a till PIN change the store PC sealed — on head office's real pipeline.**
 *
 *   • TAKE BACK (two people, each by PIN): the maker asks through the person's own approval route (kind `access_change`); the
 *     checker approves through the person's own decide route, and the very change asked for is then applied at once through
 *     the lifecycle route AS the maker. Never the maker deciding; never somebody without the checker's word. A leaver loses
 *     every role, their store-PC record is ended, and the store PC is told to cancel their till PIN. The owner is alerted.
 *   • TILL PINS: somebody else's set or cancelled with the maker's word — never for somebody who holds any permission the
 *     acting person does not (OB-737 "A"); your own changed with only your current PIN. The PIN never comes to head office.
 */

const T = 't-cr01-4b2';
const PRIVILEGE_SECRET = randomBytes(32).toString('base64url');
const KEY = privilegeSealKey(PRIVILEGE_SECRET);

async function shop(): Promise<ApiHarness> {
  const h = apiHarness({ privilegeSealSecret: PRIVILEGE_SECRET });
  await h.provisionOwner(T, 'u-owner');
  await aBranch(h, T, 'u-owner', 'S1');
  await h.provisionRole(T, 'u-mgr', 'store_manager', ['S1']);
  await h.provisionRole(T, 'u-cash', 'cashier', ['S1']);
  await h.provisionRole(T, 'u-two', 'cashier', ['S1']);
  await h.provisionRole(T, 'u-two', 'accountant', ['S1']);
  await h.provisionRole(T, 'u-box', 'store_computer', ['S1']);
  return h;
}

const record = (kind: PrivilegeKind, userId: string, body: Record<string, unknown>): PrivilegeRecord => ({
  kind, tenantId: T, userId, requestId: randomUUID(), confirmedAt: new Date().toISOString(), via: 'office_pin', body,
});
const relay = (h: ApiHarness, path: string, body: unknown, as = 'u-box') =>
  h.request({ method: 'POST', path, userId: as, tenantId: T, body, idempotencyKey: `k-${randomUUID()}` });
const codeOf = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const sealed = (kind: PrivilegeKind, by: string, body: Record<string, unknown>) => sealPrivilegeRecord(KEY, record(kind, by, body));
const askBack = (h: ApiHarness, by: string, body: Record<string, unknown>) => relay(h, '/v1/identity/box/access-changes', sealed('access_change_request', by, body));
const decide = (h: ApiHarness, by: string, approvalId: string, decision: string, reason = 'agreed') =>
  relay(h, `/v1/identity/box/access-changes/${approvalId}/decide`, sealed('access_change_decision', by, { approvalId, decision, reason }));
const pin = (h: ApiHarness, by: string, body: Record<string, unknown>) => relay(h, '/v1/identity/box/till-pins', sealed('till_pin_change', by, body));
const grantsOf = async (h: ApiHarness, userId: string): Promise<string[]> => {
  const g = await h.request({ method: 'GET', path: '/v1/identity/grants', userId: 'u-owner', tenantId: T });
  return (g.body as { grants: { userId: string; roleId: string }[] }).grants.filter((x) => x.userId === userId).map((x) => x.roleId).sort();
};
const alertsOf = async (h: ApiHarness) => alertLifecycleAdapter({ store: h.store, now: () => new Date().toISOString() }).alerts(T);
const trailOf = async (h: ApiHarness, userId: string) => ((await h.request({ method: 'GET', path: '/v1/audit/trail', userId: 'u-owner', tenantId: T, query: { objectType: 'user', objectId: userId } })).body as { matches: { action: string; actorId: string; after: Record<string, string> }[] }).matches;

describe('CR-01 step 4b-2: a role taken back by two people on the store PC, and a leaver', () => {
  it('the manager asks, the owner approves — done at once, as the manager asked it; audited via office_pin; the owner alerted', async () => {
    const h = await shop();
    const ask = record('access_change_request', 'u-mgr', { requestId: 'access-1', event: 'mover', userId: 'u-two', reason: 'no longer on the tills', grants: [{ userId: 'u-two', roleId: 'accountant', branchScope: ['S1'] }] });
    const asked = await relay(h, '/v1/identity/box/access-changes', sealPrivilegeRecord(KEY, ask));
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    const approvalId = (asked.body as { requestId: string }).requestId;
    expect(approvalId).toMatch(/^areq-/);
    expect(await grantsOf(h, 'u-two')).toEqual(['accountant', 'cashier']); // nothing changed yet

    // §28: the manager cannot decide (no checker's word), nor can the owner's own request be decided by him (below).
    expect(codeOf(await decide(h, 'u-mgr', approvalId, 'approved'))).toBe('acting_person_lacks_authority');

    const ok = await decide(h, 'u-owner', approvalId, 'approved', 'agreed with the manager');
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ approvalId, decided: 'approved', applied: true, event: 'mover', userId: 'u-two', via: 'office_pin' });
    expect((ok.body as Record<string, unknown>)['tillPinToCancel']).toBeUndefined();
    expect(await grantsOf(h, 'u-two')).toEqual(['accountant']);

    const rows = await trailOf(h, 'u-two');
    expect(rows.find((r) => r.action === 'access.mover')).toMatchObject({ actorId: 'u-owner', after: { requestedBy: 'u-mgr', via: 'office_pin', relayedBy: 'u-box' } });
    const alerts = await alertsOf(h);
    expect(alerts.find((a) => a.alert.alertId === privilegeAlertIdOf(ask.requestId))?.alert.detail).toContain('u-mgr asked to take a role back from u-two');
    expect(alerts.some((a) => a.alert.detail.includes('u-owner approved taking a role back from u-two, asked for by u-mgr'))).toBe(true);

    // Decided once: the same approval decided again cannot apply twice.
    const again = await decide(h, 'u-owner', approvalId, 'approved');
    expect(again.status).toBeGreaterThanOrEqual(200);
    expect(await grantsOf(h, 'u-two')).toEqual(['accountant']);
  });

  it('a leaver: every role back, their store-PC record ended, and the store PC told to cancel their till PIN', async () => {
    const h = await shop();
    // A store-PC person added by the manager, then given the cashier role by two people (4b-1).
    expect((await relay(h, '/v1/identity/box/people', sealed('person_provision', 'u-mgr', { userId: 'priya.k', displayName: 'Priya K' }))).status).toBe(201);
    await h.provisionRole(T, 'priya.k', 'cashier', ['S1']);
    const asked = await askBack(h, 'u-mgr', { requestId: 'access-2', event: 'leaver', userId: 'priya.k', reason: 'left on Friday', grants: [] });
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    const approvalId = (asked.body as { requestId: string }).requestId;
    const done = await decide(h, 'u-owner', approvalId, 'approved');
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ decided: 'approved', applied: true, event: 'leaver', tillPinToCancel: 'priya.k', personEnded: true });
    expect(await grantsOf(h, 'priya.k')).toEqual([]);
    const people = await peopleAdapter({ store: h.store, now: () => new Date().toISOString() }).people(T);
    expect(people.find((p) => p.userId === 'priya.k')?.state).toBe('ended');
  });

  it('rejected: nobody\'s access changes; refused by code — no reason, oneself, an unreadable ask, not a take-back', async () => {
    const h = await shop();
    const asked = await askBack(h, 'u-mgr', { requestId: 'access-3', event: 'leaver', userId: 'u-cash', reason: 'mistake', grants: [] });
    const approvalId = (asked.body as { requestId: string }).requestId;
    const no = await decide(h, 'u-owner', approvalId, 'rejected', 'she has not left');
    expect(no.status, JSON.stringify(no.body)).toBe(200);
    expect(no.body).toMatchObject({ decided: 'rejected', applied: false });
    expect(await grantsOf(h, 'u-cash')).toEqual(['cashier']);

    expect(codeOf(await decide(h, 'u-owner', approvalId, 'approved', ' '))).toBe('not_readable_as_a_decision');
    expect(codeOf(await askBack(h, 'u-mgr', { requestId: 'access-4', event: 'leaver', userId: 'u-mgr', reason: 'x', grants: [] }))).toBe('granting_to_yourself');
    expect(codeOf(await askBack(h, 'u-mgr', { requestId: 'access-5', event: 'leaver', userId: 'u-cash', reason: 'x', grants: [{ userId: 'u-cash', roleId: 'cashier', branchScope: 'all' }] }))).toBe('not_readable_as_a_take_back');
    expect(codeOf(await askBack(h, 'u-cash', { requestId: 'access-6', event: 'leaver', userId: 'u-two', reason: 'x', grants: [] }))).toBe('acting_person_lacks_authority');
    // The owner's own ask is never decided by him (§28).
    const own = await askBack(h, 'u-owner', { requestId: 'access-7', event: 'leaver', userId: 'u-cash', reason: 'x', grants: [] });
    const self = await decide(h, 'u-owner', (own.body as { requestId: string }).requestId, 'approved');
    expect(self.status).toBe(422);
    expect(codeOf(self)).toBe('self_approval');
    expect(await grantsOf(h, 'u-cash')).toEqual(['cashier']);
  });

  it('the page\'s list: the take-backs waiting for the owner, and the manager\'s own', async () => {
    const h = await shop();
    const asked = await askBack(h, 'u-mgr', { requestId: 'access-8', event: 'leaver', userId: 'u-cash', reason: 'left', grants: [] });
    const approvalId = (asked.body as { requestId: string }).requestId;
    const view = async (forUser: string) => (await h.request({ method: 'GET', path: '/v1/identity/box/users-view', userId: 'u-box', tenantId: T, query: { for: forUser } })).body as { accessChanges?: { approvalId: string; status: string; mine: boolean; event: string }[] };
    expect((await view('u-owner')).accessChanges).toEqual([expect.objectContaining({ approvalId, status: 'waiting', mine: false, event: 'leaver' })]);
    expect((await view('u-mgr')).accessChanges).toEqual([expect.objectContaining({ approvalId, status: 'waiting', mine: true })]);
    expect((await view('u-cash')).accessChanges).toBeUndefined();
  });
});

describe('CR-01 step 4b-2: a till PIN set, cancelled or changed on the store PC — recorded, never the PIN', () => {
  it('the manager sets and cancels a cashier\'s PIN: recorded in his name, the owner alerted each time', async () => {
    const h = await shop();
    const set = record('till_pin_change', 'u-mgr', { userId: 'u-cash', action: 'set' });
    const r = await relay(h, '/v1/identity/box/till-pins', sealPrivilegeRecord(KEY, set));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ userId: 'u-cash', action: 'set', recorded: true, via: 'office_pin' });
    const cancel = record('till_pin_change', 'u-mgr', { userId: 'u-cash', action: 'cancel' });
    expect((await relay(h, '/v1/identity/box/till-pins', sealPrivilegeRecord(KEY, cancel))).status).toBe(200);

    const rows = await trailOf(h, 'u-cash');
    expect(rows.find((x) => x.action === 'till_pin.set')).toMatchObject({ actorId: 'u-mgr', after: { by: 'u-mgr', via: 'office_pin', relayedBy: 'u-box' } });
    expect(rows.find((x) => x.action === 'till_pin.cancel')).toMatchObject({ actorId: 'u-mgr' });
    const alerts = await alertsOf(h);
    expect(alerts.find((a) => a.alert.alertId === privilegeAlertIdOf(set.requestId))?.alert.detail).toContain('u-mgr set a new till PIN for u-cash');
    expect(alerts.find((a) => a.alert.alertId === privilegeAlertIdOf(cancel.requestId))?.alert.detail).toContain('u-mgr cancelled till PIN of u-cash');
  });

  it('OB-737 "A": never somebody who holds more — the manager cannot touch the owner\'s or the accountant\'s PIN; the owner can', async () => {
    const h = await shop();
    for (const who of ['u-owner', 'u-two']) {
      for (const action of ['set', 'cancel']) {
        const r = await pin(h, 'u-mgr', { userId: who, action });
        expect(r.status, `${who} ${action}`).toBe(403);
        expect(codeOf(r)).toBe('person_holds_more_authority');
      }
    }
    expect((await pin(h, 'u-owner', { userId: 'u-mgr', action: 'set' })).status).toBe(200);
    expect((await pin(h, 'u-owner', { userId: 'u-two', action: 'cancel' })).status).toBe(200);
    // A cashier holds no maker's word: not even for another cashier.
    expect(codeOf(await pin(h, 'u-cash', { userId: 'u-two', action: 'set' }))).toBe('acting_person_lacks_authority');
  });

  it('your own PIN: only yourself, with only your current PIN — no alert; and every other shape refused by code', async () => {
    const h = await shop();
    const own = record('till_pin_change', 'u-cash', { userId: 'u-cash', action: 'own' });
    const r = await relay(h, '/v1/identity/box/till-pins', sealPrivilegeRecord(KEY, own));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await trailOf(h, 'u-cash')).find((x) => x.action === 'till_pin.change_own')).toMatchObject({ actorId: 'u-cash' });
    expect((await alertsOf(h)).find((a) => a.alert.alertId === privilegeAlertIdOf(own.requestId))).toBeUndefined();

    expect(codeOf(await pin(h, 'u-cash', { userId: 'u-two', action: 'own' }))).toBe('not_your_own_pin');
    expect(codeOf(await pin(h, 'u-mgr', { userId: 'u-mgr', action: 'set' }))).toBe('use_change_your_own');
    expect(codeOf(await pin(h, 'u-mgr', { userId: 'nobody.here', action: 'set' }))).toBe('person_not_known_here');
    expect(codeOf(await pin(h, 'u-mgr', { userId: 'u-cash', action: 'set', pin: '123456' }))).toBe('not_readable_as_a_till_pin_change');
    expect(codeOf(await pin(h, 'u-mgr', { userId: 'u-cash', action: 'reset' }))).toBe('not_readable_as_a_till_pin_change');
    // Only a store computer relays it.
    const asOwner = await relay(h, '/v1/identity/box/till-pins', sealed('till_pin_change', 'u-mgr', { userId: 'u-cash', action: 'set' }), 'u-owner');
    expect(codeOf(asOwner)).toBe('not_a_store_computer');
  });
});
