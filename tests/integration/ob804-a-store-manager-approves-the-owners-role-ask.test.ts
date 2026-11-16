import { describe, it, expect } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import type { ApiHarness } from '../support/api-harness';
import { useBackings } from '../support/backings';
import { aBranch } from '../support/a-branch';
import { privilegeSealKey } from '../../packages/identity/src/till-seal';
import { sealPrivilegeRecord, type PrivilegeKind } from '../../packages/identity/src/privilege-seal';
import { tenantAccessResolver } from '../../services/api/src/access';
import { ROLE_CATALOGUE } from '../../services/api/src/roles';

/**
 * **OB-804 A (owner, 16 Nov 2026, in writing) · daily-work defects D-052 and D-034 · §28 · hard rule 5: a role the OWNER asks
 * to give a person is approved by a store manager, in their own session — on head office's real pipeline, in memory and on
 * PostgreSQL, by head office's own routes and by PIN through the store PC's relay.**
 *   • The owner asks to give Receiver / QC to the receiving person; a store manager approves; the person holds it — the
 *     owner is one of the two, and nobody approves their own request.
 *   • A store manager never approves another manager's ask (that is the owner's to decide), never a grant of the owner's
 *     own role, and never their own request. A rejection grants nothing.
 */

let T = 't-ob804';
const PRIVILEGE_SECRET = randomBytes(32).toString('base64url');
const KEY = privilegeSealKey(PRIVILEGE_SECRET);
const codeOf = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } }).error?.code;

async function shop(h: ApiHarness): Promise<ApiHarness> {
  T = randomUUID(); // a fresh shop each test (the PostgreSQL backing is shared)
  await h.provisionOwner(T, 'u-owner');
  await aBranch(h, T, 'u-owner', 'S1');
  await h.provisionRole(T, 'u-mgr', 'store_manager', ['S1']);
  await h.provisionRole(T, 'u-mgr2', 'store_manager', ['S1']);
  await h.provisionRole(T, 'u-wh', 'warehouse_user', ['S1']);
  await h.provisionRole(T, 'u-box', 'store_computer', ['S1']);
  return h;
}

const ask = (h: ApiHarness, by: string, grantId: string, userId: string, roleId: string) =>
  h.request({ method: 'POST', path: '/v1/identity/grants', userId: by, tenantId: T, branchId: 'S1', idempotencyKey: `k-${randomUUID()}`, body: { grantId, userId, roleId, branchScope: ['S1'], reason: 'they receive the deliveries' } });
const decide = (h: ApiHarness, by: string, grantId: string, decision: 'approve' | 'reject') =>
  h.request({ method: 'POST', path: `/v1/identity/grants/${grantId}/${decision}`, userId: by, tenantId: T, branchId: 'S1', idempotencyKey: `k-${randomUUID()}`, body: decision === 'reject' ? { reason: 'not this person' } : {} });
const sealed = (kind: PrivilegeKind, by: string, body: Record<string, unknown>) =>
  sealPrivilegeRecord(KEY, { kind, tenantId: T, userId: by, requestId: randomUUID(), confirmedAt: new Date().toISOString(), via: 'office_pin', body });
const relay = (h: ApiHarness, path: string, body: unknown) =>
  h.request({ method: 'POST', path, userId: 'u-box', tenantId: T, body, idempotencyKey: `k-${randomUUID()}` });
const holds = async (h: ApiHarness, userId: string, roleId: string): Promise<boolean> => {
  const r = await h.request({ method: 'GET', path: '/v1/identity/grants', userId: 'u-owner', tenantId: T });
  return (r.body as { grants: { userId: string; roleId: string }[] }).grants.some((g) => g.userId === userId && g.roleId === roleId);
};

describe.each(useBackings({ privilegeSealSecret: PRIVILEGE_SECRET }))('OB-804 A: a store manager approves a role the owner asked for — on $name', ({ harness }) => {
  it('the owner asks to give Receiver / QC; a store manager approves; the person holds it and may receive goods', async () => {
    const h = await shop(harness());
    expect((await ask(h, 'u-owner', 'g-rqc', 'u-wh', 'receiver_qc')).status).toBe(202);
    expect(await holds(h, 'u-wh', 'receiver_qc')).toBe(false);

    // The manager sees it waiting for them (without the owner's wider read of every request) …
    const view = await h.request({ method: 'GET', path: '/v1/identity/grants', userId: 'u-mgr', tenantId: T, branchId: 'S1' });
    expect((view.body as { pendingForYou: { grantId: string }[] }).pendingForYou.map((g) => g.grantId)).toEqual(['g-rqc']);
    // … the owner cannot approve his own ask …
    expect(codeOf(await decide(h, 'u-owner', 'g-rqc', 'approve'))).toBe('approved_by_the_requester');
    // … and the store manager approves it.
    const ok = await decide(h, 'u-mgr', 'g-rqc', 'approve');
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(await holds(h, 'u-wh', 'receiver_qc')).toBe(true);
    expect((await tenantAccessResolver(h.store, ROLE_CATALOGUE)(T)).can({ userId: 'u-wh', permission: 'inventory.goodsreceipt.read', branchId: 'S1' })).toBe(true);

    // Audited: asked by the owner, approved by the store manager.
    const trail = await h.request({ method: 'GET', path: '/v1/audit/trail', userId: 'u-owner', tenantId: T, query: { objectType: 'user', objectId: 'u-wh' } });
    const rows = (trail.body as { matches: { action: string; actorId: string; after: Record<string, string> }[] }).matches;
    expect(rows.find((r) => r.action === 'role.grant')).toMatchObject({ actorId: 'u-mgr', after: { roleId: 'receiver_qc', requestedBy: 'u-owner', approvedBy: 'u-mgr' } });
  });

  it('on the store PC by PIN: the owner asks, a store manager approves through the relay; the owner is alerted', async () => {
    const h = await shop(harness());
    const asked = await relay(h, '/v1/identity/box/grants', sealed('role_request', 'u-owner', { grantId: 'g-pin', userId: 'u-wh', roleId: 'receiver_qc', branchScope: ['S1'], reason: 'they receive the deliveries' }));
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    const ok = await relay(h, '/v1/identity/box/grants/g-pin/approve', sealed('role_grant_approval', 'u-mgr', { grantId: 'g-pin' }));
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body).toMatchObject({ via: 'office_pin' });
    expect(await holds(h, 'u-wh', 'receiver_qc')).toBe(true);
  });

  it('a store manager never approves another manager\'s ask, a grant of the owner\'s role, or their own ask; a rejection grants nothing', async () => {
    const h = await shop(harness());
    // Another manager's ask is the owner's to decide.
    expect((await ask(h, 'u-mgr2', 'g-m2', 'u-wh', 'receiver_qc')).status).toBe(202);
    const other = await decide(h, 'u-mgr', 'g-m2', 'approve');
    expect(other.status).toBe(403);
    expect(codeOf(other)).toBe('only_the_owners_ask_is_yours');
    expect(codeOf(await decide(h, 'u-mgr', 'g-m2', 'reject'))).toBe('only_the_owners_ask_is_yours');
    expect(await holds(h, 'u-wh', 'receiver_qc')).toBe(false);

    // The owner's own role is never given by a store manager's approval, even when the owner asks.
    expect((await ask(h, 'u-owner', 'g-own', 'u-wh', 'owner')).status).toBe(202);
    const owner = await decide(h, 'u-mgr', 'g-own', 'approve');
    expect(owner.status).toBe(403);
    expect(codeOf(owner)).toBe('role_not_approved_by_a_store_manager');
    expect(await holds(h, 'u-wh', 'owner')).toBe(false);

    // A manager's own ask: never approved by himself.
    expect((await ask(h, 'u-mgr', 'g-self', 'u-wh', 'picker')).status).toBe(202);
    expect((await decide(h, 'u-mgr', 'g-self', 'approve')).status).toBeGreaterThanOrEqual(400);
    expect(await holds(h, 'u-wh', 'picker')).toBe(false);

    // A rejection grants nothing, and a rejected ask is not revived.
    expect((await ask(h, 'u-owner', 'g-no', 'u-wh', 'receiver_qc')).status).toBe(202);
    const no = await decide(h, 'u-mgr', 'g-no', 'reject');
    expect(no.status, JSON.stringify(no.body)).toBe(200);
    expect(no.body).toMatchObject({ state: 'rejected', rejectedBy: 'u-mgr' });
    expect(codeOf(await decide(h, 'u-mgr2', 'g-no', 'approve'))).toBe('grant_request_rejected');
    expect(await holds(h, 'u-wh', 'receiver_qc')).toBe(false);

    // The owner still decides the managers' asks, as before.
    expect((await decide(h, 'u-owner', 'g-m2', 'approve')).status).toBe(201);
    expect(await holds(h, 'u-wh', 'receiver_qc')).toBe(true);
  });
});
