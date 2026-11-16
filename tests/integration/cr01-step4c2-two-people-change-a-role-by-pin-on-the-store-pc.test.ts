import { describe, it, expect } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import type { ApiHarness } from '../support/api-harness';
import { useBackings } from '../support/backings';
import { aBranch } from '../support/a-branch';
import { privilegeSealKey } from '../../packages/identity/src/till-seal';
import { sealPrivilegeRecord, type PrivilegeKind } from '../../packages/identity/src/privilege-seal';
import { tenantAccessResolver } from '../../services/api/src/access';
import { alertLifecycleAdapter } from '../../services/api/src/adapters';
import { ROLE_CATALOGUE } from '../../services/api/src/roles';

/**
 * **CR-01 step 4c-2 · OI-06 · ADR-0034 · ADR-0033 §2 · OB-740 "B" · OB-809 A: two people change what a role may do on the
 * store PC, each by their own PIN — on head office's real pipeline, in memory and on PostgreSQL.**
 *   • A store manager asks (sealed `role_permission_request`): head office checks the change as them, then records the
 *     approval request (kind `role_permission_change`). Nobody's access changes yet.
 *   • The owner approves (sealed `role_permission_decision`): the very change asked for is applied at once AS the store
 *     manager — one append-only adjustment, audited via office_pin, the owner alerted — and a Warehouse user may read floor
 *     indents from the next request (OB-809 A).
 *   • Refused: the asker approving their own; two store managers (the owner is always one of the two); a never-list
 *     permission; a seal that is stale or reused. Undo is the opposite change, asked and approved the same way.
 */

let T = 't-cr01-4c2';
const PRIVILEGE_SECRET = randomBytes(32).toString('base64url');
const KEY = privilegeSealKey(PRIVILEGE_SECRET);
const ASK = '/v1/identity/box/role-permissions';
const DECIDE = (approvalId: string) => `/v1/identity/box/role-permissions/${approvalId}/decide`;

const codeOf = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const sealed = (kind: PrivilegeKind, by: string, body: Record<string, unknown>, confirmedAt = new Date().toISOString()) =>
  sealPrivilegeRecord(KEY, { kind, tenantId: T, userId: by, requestId: randomUUID(), confirmedAt, via: 'office_pin', body });
const relay = (h: ApiHarness, path: string, body: unknown) =>
  h.request({ method: 'POST', path, userId: 'u-box', tenantId: T, body, idempotencyKey: `k-${randomUUID()}` });
const ask = (h: ApiHarness, by: string, change: Record<string, unknown>) =>
  relay(h, ASK, sealed('role_permission_request', by, { requestId: `rpc-${randomUUID().slice(0, 8)}`, reason: 'they need it every day', ...change }));
const decide = (h: ApiHarness, by: string, approvalId: string, decision: 'approved' | 'rejected', reason = 'checked with the team') =>
  relay(h, DECIDE(approvalId), sealed('role_permission_decision', by, { approvalId, decision, reason }));
const warehouseMay = async (h: ApiHarness): Promise<boolean> =>
  (await tenantAccessResolver(h.store, ROLE_CATALOGUE)(T)).can({ userId: 'u-wh', permission: 'inventory.indent.read', branchId: 'S1' });
const INDENTS = { roleId: 'warehouse_user', permission: 'inventory.indent.read', change: 'add' };

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

describe.each(useBackings({ privilegeSealSecret: PRIVILEGE_SECRET }))('CR-01 step 4c-2: a role changed by two PINs on the store PC — on $name', ({ harness }) => {
  it('the manager asks, the owner approves: applied at once as the manager asked it; audited via office_pin; alerted; the warehouse reads indents', async () => {
    const h = await shop(harness());
    expect(await warehouseMay(h)).toBe(false);

    const asked = await ask(h, 'u-mgr', INDENTS);
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    expect(asked.body).toMatchObject({ via: 'office_pin', approvedBy: 'the owner (in their own session)', change: { roleId: 'warehouse_user', permission: 'inventory.indent.read', change: 'add' } });
    const approvalId = (asked.body as { requestId: string }).requestId;
    expect(approvalId).toMatch(/^areq-/);
    expect(await warehouseMay(h)).toBe(false); // asked, not yet approved: nobody's access changed

    // §28: the asker cannot approve their own; a second store manager cannot either (the owner is always one of the two).
    expect((await decide(h, 'u-mgr', approvalId, 'approved')).status).toBeGreaterThanOrEqual(400);
    expect((await decide(h, 'u-mgr2', approvalId, 'approved')).status).toBeGreaterThanOrEqual(400);
    expect(await warehouseMay(h)).toBe(false);

    const ok = await decide(h, 'u-owner', approvalId, 'approved');
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ approvalId, decided: 'approved', applied: true, roleId: 'warehouse_user', permission: 'inventory.indent.read', change: 'add', via: 'office_pin' });
    expect(await warehouseMay(h)).toBe(true);

    // Recorded as one adjustment, in the manager's name with the owner as the approver.
    const view = await h.request({ method: 'GET', path: '/v1/identity/role-permissions', userId: 'u-owner', tenantId: T });
    expect(view.status, JSON.stringify(view.body)).toBe(200);
    const body = view.body as { roles: { roleId: string; added: string[] }[]; history: { requestedBy: string; approvedBy: string; permission: string }[] };
    expect(body.roles.find((r) => r.roleId === 'warehouse_user')!.added).toEqual(['inventory.indent.read']);
    expect(body.history).toEqual([expect.objectContaining({ requestedBy: 'u-mgr', approvedBy: 'u-owner', permission: 'inventory.indent.read' })]);

    // Audited via the store PC's PIN; the owner alerted for the ask and for the change made.
    const trail = await h.request({ method: 'GET', path: '/v1/audit/trail', userId: 'u-owner', tenantId: T, query: { objectType: 'role', objectId: 'warehouse_user' } });
    const rows = (trail.body as { matches: { action: string; actorId: string; after: Record<string, string> }[] }).matches;
    expect(rows.find((r) => r.action === 'role.permission.adjust')).toMatchObject({ actorId: 'u-mgr', after: { approvedBy: 'u-owner', via: 'office_pin', relayedBy: 'u-box' } });
    const alerts = (await alertLifecycleAdapter({ store: h.store, now: () => new Date().toISOString() }).alerts(T)).map((a) => a.alert.detail);
    expect(alerts.some((d) => d.includes('u-mgr asked to switch on "inventory.indent.read" for the role warehouse_user'))).toBe(true);
    expect(alerts.some((d) => d.includes('u-owner approved switching on "inventory.indent.read" for the role warehouse_user, asked for by u-mgr'))).toBe(true);

    // Decided once: approving the same request again changes nothing more.
    await decide(h, 'u-owner', approvalId, 'approved');
    const again = await h.request({ method: 'GET', path: '/v1/identity/role-permissions', userId: 'u-owner', tenantId: T });
    expect((again.body as { history: unknown[] }).history).toHaveLength(1);

    // Undo is the opposite change, the other way round: the owner asks, a store manager approves.
    const undo = await ask(h, 'u-owner', { ...INDENTS, change: 'remove' });
    expect(undo.status, JSON.stringify(undo.body)).toBe(201);
    const undone = await decide(h, 'u-mgr2', (undo.body as { requestId: string }).requestId, 'approved');
    expect(undone.body).toMatchObject({ applied: true, change: 'remove' });
    expect(await warehouseMay(h)).toBe(false);
  });

  it('a rejection changes nothing; a never-list permission is refused before anything is asked', async () => {
    const h = await shop(harness());
    const asked = await ask(h, 'u-mgr', INDENTS);
    const rejected = await decide(h, 'u-owner', (asked.body as { requestId: string }).requestId, 'rejected');
    expect(rejected.body).toMatchObject({ decided: 'rejected', applied: false });
    expect(await warehouseMay(h)).toBe(false);

    // Who controls roles and approvals is never changed from a screen (ADR-0034 decision 4f) — refused by head office.
    const never = await ask(h, 'u-mgr', { roleId: 'cashier', permission: 'identity.role.adjust', change: 'add' });
    expect(never.status).toBe(422);
    expect(codeOf(never)).toBe('not_changeable_from_a_screen');
    // A machine's role is never changed either.
    expect(codeOf(await ask(h, 'u-mgr', { roleId: 'store_computer', permission: 'inventory.indent.read', change: 'remove' }))).toBe('not_changeable_from_a_screen');
  });

  it('a seal that is stale, reused or not the store computer\'s is refused — nothing asked', async () => {
    const h = await shop(harness());
    const stale = sealed('role_permission_request', 'u-mgr', { requestId: 'rpc-stale', reason: 'x', ...INDENTS }, new Date(Date.now() - 10 * 60_000).toISOString());
    expect(codeOf(await relay(h, ASK, stale))).toBe('privilege_confirmation_stale');
    const once = sealed('role_permission_request', 'u-mgr', { requestId: 'rpc-once', reason: 'x', ...INDENTS });
    expect((await relay(h, ASK, once)).status).toBe(201);
    expect(codeOf(await relay(h, ASK, once))).toBe('privilege_request_already_used');
    const notBox = await h.request({ method: 'POST', path: ASK, userId: 'u-mgr', tenantId: T, body: sealed('role_permission_request', 'u-mgr', { requestId: 'rpc-mgr', reason: 'x', ...INDENTS }), idempotencyKey: `k-${randomUUID()}` });
    expect(notBox.status).toBe(403);
  });
});
