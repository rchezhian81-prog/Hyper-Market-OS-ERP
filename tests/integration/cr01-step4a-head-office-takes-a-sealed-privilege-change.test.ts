import { describe, it, expect } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { apiHarness, TEST_PACK_KEY, TEST_BOX_HISTORY_SEAL_SECRET, type ApiHarness } from '../support/api-harness';
import { privilegeSealKey } from '../../packages/identity/src/till-seal';
import { sealPrivilegeRecord, type PrivilegeKind, type PrivilegeRecord } from '../../packages/identity/src/privilege-seal';
import { alertLifecycleAdapter } from '../../services/api/src/adapters';
import { privilegeAlertIdOf } from '../../services/api/src/box-privilege-adapters';

/**
 * **CR-01 step 4a · OI-06 · ADR-0033 · OB-731 "A" · OB-732 "B": head office takes a privilege change the store PC sealed
 * after a PIN confirmation — and refuses, by code, everything it cannot trust.**
 *
 *   The store PC's credential (`store_computer`, locked to store S1) relays a sealed record to
 *   `/v1/identity/box/grants` and `…/grants/:grantId/approve`. Refused: no seal, a seal made with another key (the pack key's
 *   till seal key included), a body changed after sealing, a `confirmedAt` older than 300 s or in the future, a request id
 *   used before, a credential that is not a store computer's, a requester approving their own request, an acting person
 *   who lacks the route's authority, an approver who lacks what is granted. Accepted: run as the PERSON, audited in their
 *   name with `via: office_pin`, and an owner alert raised naming who, what, when and who approved.
 */

const T = 't-cr01-4a';
const PRIVILEGE_SECRET = randomBytes(32).toString('base64url');
const KEY = privilegeSealKey(PRIVILEGE_SECRET);

async function shop(): Promise<ApiHarness> {
  const h = apiHarness({ privilegeSealSecret: PRIVILEGE_SECRET });
  await h.provisionOwner(T, 'u-owner');
  await h.provisionRole(T, 'u-mgr', 'store_manager');
  await h.provisionRole(T, 'u-box', 'store_computer', ['S1']);
  return h;
}

const record = (kind: PrivilegeKind, userId: string, body: Record<string, unknown>, over: Partial<PrivilegeRecord> = {}): PrivilegeRecord => ({
  kind, tenantId: T, userId, requestId: randomUUID(), confirmedAt: new Date().toISOString(), via: 'office_pin', body, ...over,
});
const ask = (grantId: string, userId = 'u-new', roleId = 'cashier') => ({ grantId, userId, roleId, branchScope: 'all', reason: 'new cashier for the morning shift' });

const relay = (h: ApiHarness, path: string, body: unknown, as = 'u-box', key = `k-${randomUUID()}`) =>
  h.request({ method: 'POST', path, userId: as, tenantId: T, body, idempotencyKey: key });
const codeOf = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } }).error?.code;

describe('CR-01 step 4a: the box-relay privilege routes accept only a fresh, sealed, once-used record from a store computer', () => {
  it('a good request and a good approval: run as the PERSON, audited in their name via office_pin, an owner alert each', async () => {
    const h = await shop();
    const asked = record('role_request', 'u-mgr', ask('g-1'));
    const r1 = await relay(h, '/v1/identity/box/grants', sealPrivilegeRecord(KEY, asked));
    expect(r1.status, JSON.stringify(r1.body)).toBe(202);
    expect(r1.body).toMatchObject({ grantId: 'g-1', state: 'pending', requestedBy: 'u-mgr', via: 'office_pin', privilegeRequestId: asked.requestId });

    const approved = record('role_grant_approval', 'u-owner', { grantId: 'g-1' });
    const r2 = await relay(h, '/v1/identity/box/grants/g-1/approve', sealPrivilegeRecord(KEY, approved));
    expect(r2.status, JSON.stringify(r2.body)).toBe(201);
    expect(r2.body).toMatchObject({ via: 'office_pin' });

    // The role is held now — granted by the owner, asked by the manager (§28 two people).
    const grants = await h.request({ method: 'GET', path: '/v1/identity/grants', userId: 'u-owner', tenantId: T });
    expect((grants.body as { grants: { userId: string; roleId: string }[] }).grants).toContainEqual(expect.objectContaining({ userId: 'u-new', roleId: 'cashier' }));

    // The audit trail: both acts in the PERSON's name, marked office_pin, naming the box that carried them.
    const trail = await h.request({ method: 'GET', path: '/v1/audit/trail', userId: 'u-owner', tenantId: T, query: { objectType: 'user', objectId: 'u-new' } });
    const rows = (trail.body as { matches: { action: string; actorId: string; after: Record<string, string> }[] }).matches;
    expect(rows.find((r) => r.action === 'role.grant.request')).toMatchObject({ actorId: 'u-mgr', after: { via: 'office_pin', relayedBy: 'u-box', privilegeRequestId: asked.requestId } });
    expect(rows.find((r) => r.action === 'role.grant')).toMatchObject({ actorId: 'u-owner', after: { via: 'office_pin', relayedBy: 'u-box', requestedBy: 'u-mgr', approvedBy: 'u-owner' } });

    // The owner is alerted for each: who, what, when, approved by whom.
    const alerts = await alertLifecycleAdapter({ store: h.store, now: () => new Date().toISOString() }).alerts(T);
    const a1 = alerts.find((a) => a.alert.alertId === privilegeAlertIdOf(asked.requestId));
    const a2 = alerts.find((a) => a.alert.alertId === privilegeAlertIdOf(approved.requestId));
    expect(a1?.alert.ownerUserId).toBe('u-owner');
    expect(a1?.alert.detail).toContain('u-mgr asked for the cashier role for u-new');
    expect(a1?.alert.detail).toContain(asked.confirmedAt);
    expect(a2?.alert.detail).toContain('u-owner approved the cashier role for u-new');
    expect(a2?.alert.detail).toContain('asked for by u-mgr');
  });

  it('no seal, another key, a changed body — each refused 403 by its code, and nothing is requested', async () => {
    const h = await shop();
    const bare = record('role_request', 'u-mgr', ask('g-2'));
    expect(codeOf(await relay(h, '/v1/identity/box/grants', bare))).toBe('privilege_seal_missing');

    // The till seal key (from the pack key) is NOT the privilege key (OB-732 "B"); nor is any other secret.
    for (const wrong of [privilegeSealKey(TEST_PACK_KEY), privilegeSealKey(TEST_BOX_HISTORY_SEAL_SECRET), privilegeSealKey(randomBytes(32).toString('hex'))]) {
      const r = await relay(h, '/v1/identity/box/grants', sealPrivilegeRecord(wrong, record('role_request', 'u-mgr', ask('g-2'))));
      expect(r.status).toBe(403);
      expect(codeOf(r)).toBe('privilege_seal_does_not_match');
    }
    // Sealed for one role, sent asking for another: the record does not match its seal.
    const sealed = sealPrivilegeRecord(KEY, record('role_request', 'u-mgr', ask('g-2')));
    const changed = { ...sealed, body: { ...sealed.body, roleId: 'store_manager' } };
    expect(codeOf(await relay(h, '/v1/identity/box/grants', changed))).toBe('privilege_seal_does_not_match');
    // Sealed as one person, relayed naming another.
    expect(codeOf(await relay(h, '/v1/identity/box/grants', { ...sealed, userId: 'u-owner' }))).toBe('privilege_seal_does_not_match');
    // An approval sealed for g-9 sent to g-2's door.
    const other = sealPrivilegeRecord(KEY, record('role_grant_approval', 'u-owner', { grantId: 'g-9' }));
    expect(codeOf(await relay(h, '/v1/identity/box/grants/g-2/approve', other))).toBe('privilege_record_does_not_match');
    // A request record on the approve door.
    expect(codeOf(await relay(h, '/v1/identity/box/grants/g-2/approve', sealed))).toBe('privilege_record_does_not_match');

    const pending = await h.request({ method: 'GET', path: '/v1/identity/grants/pending', userId: 'u-owner', tenantId: T });
    expect(JSON.stringify(pending.body)).not.toContain('g-2');
  });

  it('a confirmation older than 300 s, or ahead of head office\'s clock — refused', async () => {
    const h = await shop();
    const stale = record('role_request', 'u-mgr', ask('g-3'), { confirmedAt: new Date(Date.now() - 301_000).toISOString() });
    expect(codeOf(await relay(h, '/v1/identity/box/grants', sealPrivilegeRecord(KEY, stale)))).toBe('privilege_confirmation_stale');
    const ahead = record('role_request', 'u-mgr', ask('g-3'), { confirmedAt: new Date(Date.now() + 120_000).toISOString() });
    expect(codeOf(await relay(h, '/v1/identity/box/grants', sealPrivilegeRecord(KEY, ahead)))).toBe('privilege_confirmation_in_the_future');
  });

  it('a request id used before is refused 409, even under another idempotency key; the same key replays the first answer', async () => {
    const h = await shop();
    const sealed = sealPrivilegeRecord(KEY, record('role_request', 'u-mgr', ask('g-4')));
    const first = await relay(h, '/v1/identity/box/grants', sealed, 'u-box', 'k-first');
    expect(first.status).toBe(202);
    const replay = await relay(h, '/v1/identity/box/grants', sealed, 'u-box', 'k-first');
    expect(replay.status).toBe(202); // the kernel's replay of the same request — one record
    const again = await relay(h, '/v1/identity/box/grants', sealed, 'u-box', 'k-second');
    expect(again.status).toBe(409);
    expect(codeOf(again)).toBe('privilege_request_already_used');
  });

  it('a token that is not a store computer\'s is refused — the owner\'s own token too', async () => {
    const h = await shop();
    const sealed = sealPrivilegeRecord(KEY, record('role_request', 'u-mgr', ask('g-5')));
    const asOwner = await relay(h, '/v1/identity/box/grants', sealed, 'u-owner');
    expect(asOwner.status).toBe(403);
    // The owner holds the relay permission (so he may approve the store computer role, §28) — the route itself refuses
    // any credential that is not a store computer's.
    expect(codeOf(asOwner)).toBe('not_a_store_computer');
    const asMgr = await relay(h, '/v1/identity/box/grants', sealed, 'u-mgr');
    expect(asMgr.status).toBe(403);
    expect(codeOf(asMgr)).toBe('forbidden'); // no store manager's role carries it at all
    // And nothing was requested by either attempt; the store PC's own relay of it still goes through once.
    expect((await relay(h, '/v1/identity/box/grants', sealed)).status).toBe(202);
  });

  it('§28: the requester approving their own request, and an approver lacking what is granted — refused by code', async () => {
    const h = await shop();
    // The owner asks for a cashier role, then tries to approve it himself.
    expect((await relay(h, '/v1/identity/box/grants', sealPrivilegeRecord(KEY, record('role_request', 'u-owner', ask('g-6'))))).status).toBe(202);
    const own = await relay(h, '/v1/identity/box/grants/g-6/approve', sealPrivilegeRecord(KEY, record('role_grant_approval', 'u-owner', { grantId: 'g-6' })));
    expect(own.status).toBe(422);
    expect(codeOf(own)).toBe('approved_by_the_requester');

    // The manager asks for the platform administrator role (IT); the owner does not hold its permissions.
    const asked = await relay(h, '/v1/identity/box/grants', sealPrivilegeRecord(KEY, record('role_request', 'u-mgr', ask('g-7', 'u-it', 'platform_admin'))));
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    const beyond = await relay(h, '/v1/identity/box/grants/g-7/approve', sealPrivilegeRecord(KEY, record('role_grant_approval', 'u-owner', { grantId: 'g-7' })));
    expect(beyond.status).toBe(422);
    expect(codeOf(beyond)).toBe('escalates_beyond_the_approver');

    // The manager (no identity.role.grant at head office) cannot approve through the store PC either.
    const mgr = await relay(h, '/v1/identity/box/grants/g-6/approve', sealPrivilegeRecord(KEY, record('role_grant_approval', 'u-mgr', { grantId: 'g-6' })));
    expect(mgr.status).toBe(403);
    expect(codeOf(mgr)).toBe('acting_person_lacks_authority');
    // Asking for yourself through the store PC is refused as on the person's own route.
    const self = await relay(h, '/v1/identity/box/grants', sealPrivilegeRecord(KEY, record('role_request', 'u-mgr', ask('g-8', 'u-mgr'))));
    expect(codeOf(self)).toBe('granting_to_yourself');
  });

  it('adding a person from the store PC (built in 4b-1) takes a staff id and a name only — a sign-in name is not read', async () => {
    const h = await shop();
    const r = await relay(h, '/v1/identity/box/people', sealPrivilegeRecord(KEY, record('person_provision', 'u-owner', { signInName: 'priya.k', displayName: 'Priya K' })));
    expect(r.status).toBe(400);
    expect(codeOf(r)).toBe('not_readable_as_a_person');
  });

  it('with no privilege-seal key at head office, every relay is refused 503 — never trusted', async () => {
    const h = apiHarness();
    await h.provisionOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-box', 'store_computer', ['S1']);
    const r = await relay(h, '/v1/identity/box/grants', sealPrivilegeRecord(KEY, record('role_request', 'u-mgr', ask('g-10'))));
    expect(r.status).toBe(503);
    expect(codeOf(r)).toBe('privilege_seal_key_not_set');
  });
});
