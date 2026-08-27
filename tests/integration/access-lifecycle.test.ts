import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Joiner / mover / leaver access-lifecycle decision, end to end (M02-FR-04 · SEC-11 · §28, API-01). Access
// has to track employment reality. A MOVER replaces scope (never accumulates — nobody ends up able to raise
// a stock adjustment AND settle the till it hides in); a LEAVER's owned open items must be reassigned first
// (work owned by nobody is abandoned) and their revocation is a priority sync. The authenticated caller is
// the approver and can never be the requester (§28). A pure decision — it decides, the caller applies.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const grant = (role: string, branch: string[] | 'all' = ['b1']) => ({ userId: 'u-subject', roleId: role, branchScope: branch });
const lifecycle = (h: ApiHarness, u: string, id: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/access/lifecycle/${id}`, userId: u, tenantId: A, idempotencyKey: key ?? `lc-${id}`, body });
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
type Result = { applied: boolean; grants: { roleId: string }[]; removed: { roleId: string }[]; closeSessions: boolean; prioritySync: boolean; blockers: string[] };

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner'); // identity.role.grant
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // not
  await h.provisionRole(A, 'u-cash', 'cashier');       // not
  return h;
}

describe('access lifecycle: a mover replaces scope, a leaver is reassigned first (M02-FR-04 · SEC-11)', () => {
  it('applies a joiner with exactly the access requested', async () => {
    const h = await cast();
    const r = (await lifecycle(h, 'u-owner', 'j1', {
      event: 'joiner', userId: 'u-subject', requestedBy: 'u-hr', reason: 'new cashier starting Monday',
      currentGrants: [], grants: [grant('cashier')],
    })).body as Result;
    expect(r.applied).toBe(true);
    expect(r.grants.map((g) => g.roleId)).toEqual(['cashier']);
    expect(r.removed).toHaveLength(0);
    expect(r.blockers).toHaveLength(0);
  });

  it('a mover REPLACES scope — the old role is removed and sessions close so it takes effect now', async () => {
    const h = await cast();
    const r = (await lifecycle(h, 'u-owner', 'm1', {
      event: 'mover', userId: 'u-subject', requestedBy: 'u-hr', reason: 'moved from fresh counter to cash office',
      currentGrants: [grant('fresh_counter'), grant('cash_office')],
      grants: [grant('cash_office')], // keeps cash office only — fresh counter is dropped
    })).body as Result;
    expect(r.applied).toBe(true);
    expect(r.grants.map((g) => g.roleId)).toEqual(['cash_office']);
    expect(r.removed.map((g) => g.roleId)).toEqual(['fresh_counter']); // never the union of old and new
    expect(r.closeSessions).toBe(true);
    expect(r.prioritySync).toBe(true);
  });

  it('a leaver is blocked while they own open items, and revoked cleanly once they do not', async () => {
    const h = await cast();
    // Blocked: an unapproved PO owned by nobody never gets approved.
    const blocked = (await lifecycle(h, 'u-owner', 'l1', {
      event: 'leaver', userId: 'u-subject', requestedBy: 'u-hr', reason: 'resigned, last day Friday',
      currentGrants: [grant('cash_office')],
      ownedOpenItems: [{ itemId: 'po-42', kind: 'purchase order', description: 'unapproved PO' }],
    })).body as Result;
    expect(blocked.applied).toBe(false);
    expect(blocked.blockers.join(' ')).toContain('reassigned first');
    expect(blocked.grants.map((g) => g.roleId)).toEqual(['cash_office']); // nothing removed while blocked

    // Once reassigned (no owned items), the leaver is fully revoked, sessions close, priority sync.
    const done = (await lifecycle(h, 'u-owner', 'l2', {
      event: 'leaver', userId: 'u-subject', requestedBy: 'u-hr', reason: 'resigned, last day Friday',
      currentGrants: [grant('cash_office')], ownedOpenItems: [],
    })).body as Result;
    expect(done.applied).toBe(true);
    expect(done.grants).toHaveLength(0);
    expect(done.removed.map((g) => g.roleId)).toEqual(['cash_office']);
    expect(done.closeSessions).toBe(true);
    expect(done.prioritySync).toBe(true);
  });

  it('refuses self-approval (§28), is owner-only, and rejects a malformed change', async () => {
    const h = await cast();
    // The requester cannot approve their own access change.
    expect(codeOf(await lifecycle(h, 'u-owner', 's1', { event: 'joiner', userId: 'u-subject', requestedBy: 'u-owner', reason: 'x', currentGrants: [], grants: [grant('cashier')] }))).toBe('self_service_access_refused');
    // Owner-only.
    expect((await lifecycle(h, 'u-mgr', 's2', { event: 'joiner', userId: 'u-subject', requestedBy: 'u-hr', reason: 'x', currentGrants: [], grants: [grant('cashier')] })).status).toBe(403);
    expect((await lifecycle(h, 'u-cash', 's3', { event: 'joiner', userId: 'u-subject', requestedBy: 'u-hr', reason: 'x', currentGrants: [], grants: [grant('cashier')] })).status).toBe(403);
    // Malformed — nothing readable as a lifecycle change.
    expect(codeOf(await lifecycle(h, 'u-owner', 's4', { event: 'promotion', userId: 'u-subject' }))).toBe('not_readable_as_a_lifecycle_change');
  });
});
