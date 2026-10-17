import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { approvedBody, askForApproval, decide } from '../support/approval-request';
import { actionDetails } from '../../services/identity/src/approval-requests';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { auditTrailAdapter } from '../../services/api/src/adapters';

/**
 * **R2 addendum C20 · owner decision OB-165 "A" (verifier lanes34 NEW-6): the Internal Committee can be kept staffed.**
 *   • the OWNER adds or removes a member — the `internal_committee` role ONLY — and a SECOND PERSON confirms it through
 *     the maker-checker engine; without that confirmation nothing changes; the owner cannot confirm his own;
 *   • the act is on the audit trail (role.grant / role.revoke, who asked, who confirmed);
 *   • the owner can never hold the role — not through this route, a role grant or emergency access — and a committee
 *     member is never given the owner role;
 *   • nobody else can use the route (403), and OB-157 stands: the owner still reads no complaint.
 * In-memory and, with DATABASE_URL, real PostgreSQL. Synthetic data only.
 */

const MFA = { amr: ['pwd', 'mfa'], authTimeFromNowSeconds: 0 } as const;
const codeOf = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } }).error?.code;

async function cast(h: ApiHarness, t: string) {
  await h.seedOwner(t, 'u-owner');
  await h.provisionRole(t, 'u-owner2', 'owner');
  await h.provisionRole(t, 'u-mgr', 'store_manager');
  await h.provisionRole(t, 'u-ic', 'internal_committee');
  await h.provisionRole(t, 'u-acct', 'accountant');
  await h.provisionRole(t, 'u-new', 'cashier');
  const change = (changeId: string, body: Record<string, unknown>, userId = 'u-owner') =>
    h.request({ method: 'POST', path: `/v1/identity/internal-committee/changes/${changeId}`, userId, tenantId: t, idempotencyKey: `cc-${changeId}-${randomUUID()}`, body, ...MFA });
  const confirmed = async (changeId: string, body: Record<string, unknown>, checker = 'u-mgr') =>
    change(changeId, await approvedBody(h, t, 'u-owner', checker, 'posh_committee_change', changeId, body, { changeId }));
  const complaints = (userId: string) => h.request({ method: 'GET', path: '/v1/hr/posh/complaints', userId, tenantId: t });
  return { change, confirmed, complaints };
}

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });
const backings: { name: string; harness: () => ApiHarness }[] = [{ name: 'the in-memory event store', harness: () => apiHarness() }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });

describe.each(backings)('OB-165 — Internal Committee membership: the owner changes it, a second person confirms — on $name', ({ harness }) => {
  it('adds a member only with a second person\'s confirmation, audits it, and removes the member the same way', async () => {
    const h = harness();
    const t = randomUUID();
    const s = await cast(h, t);
    const add = { action: 'add', userId: 'u-new', reason: 'synthetic: a member left, a replacement joins' };

    // No confirmation, nothing changes.
    expect(codeOf(await s.change('C1', add))).toBe('committee_change_needs_a_second_person');
    expect((await s.complaints('u-new')).status).toBe(403);
    // The owner cannot confirm his own change.
    const asked = await askForApproval(h, t, 'u-owner', { kind: 'posh_committee_change', subjectRef: 'C1', details: actionDetails(add, { changeId: 'C1' }) });
    expect(asked.status).toBe(201);
    expect((await decide(h, t, 'u-owner', (asked.body as { requestId: string }).requestId)).status).not.toBe(201);

    // Confirmed by the store manager: the person is on the committee and reads the register.
    const added = await s.confirmed('C1', add);
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ userId: 'u-new', action: 'add', roleId: 'internal_committee', requestedBy: 'u-owner', approvedBy: 'u-mgr' });
    expect((await s.complaints('u-new')).status).toBe(200);
    // Sent again: already a member — nothing is granted twice.
    expect((await s.change('C1', add)).body).toMatchObject({ alreadyMember: true });

    const trail = await auditTrailAdapter({ store: h.store }).records(t);
    const grant = trail.find((r) => r.action === 'role.grant' && r.objectId === 'u-new' && r.correlationId === 'C1');
    expect(grant).toMatchObject({ actorId: 'u-owner', objectType: 'user', after: expect.objectContaining({ roleId: 'internal_committee', requestedBy: 'u-owner', approvedBy: 'u-mgr' }) });

    // Removed the same way: the person's access to the register ends at once.
    const remove = { action: 'remove', userId: 'u-new', reason: 'synthetic: left the committee' };
    expect(codeOf(await s.change('C2', remove))).toBe('committee_change_needs_a_second_person');
    expect((await s.complaints('u-new')).status).toBe(200);
    const removed = await s.confirmed('C2', remove);
    expect(removed.status).toBe(201);
    expect((await s.complaints('u-new')).status).toBe(403);
    expect((await auditTrailAdapter({ store: h.store }).records(t)).some((r) => r.action === 'role.revoke' && r.objectId === 'u-new' && r.correlationId === 'C2')).toBe(true);
    // Their other role is untouched.
    expect((await h.request({ method: 'GET', path: '/v1/hr/workforce/my-roster', userId: 'u-new', tenantId: t })).status).not.toBe(403);
  });

  it('r2final NEW-5 / OB-167: the person joining or leaving never confirms it; the confirmer is a store manager', async () => {
    const h = harness();
    const t = randomUUID();
    const s = await cast(h, t);
    await h.provisionRole(t, 'u-mgr2', 'store_manager');
    // The verifier's case: the owner asks to add store manager u-mgr, and u-mgr confirms his own appointment.
    const self = await s.confirmed('V1', { action: 'add', userId: 'u-mgr', reason: 'synthetic' }, 'u-mgr');
    expect(self.status).toBe(422);
    expect(codeOf(self)).toBe('committee_change_confirmed_by_its_subject');
    expect((await s.complaints('u-mgr')).status).toBe(403);
    // A second OWNER confirming is not a store manager confirming (OB-167).
    const owner2 = await s.confirmed('V2', { action: 'add', userId: 'u-new', reason: 'synthetic' }, 'u-owner2');
    expect(codeOf(owner2)).toBe('committee_change_needs_a_store_manager');
    expect((await s.complaints('u-new')).status).toBe(403);
    // Another store manager confirms u-mgr's appointment: it applies.
    const ok = await s.confirmed('V3', { action: 'add', userId: 'u-mgr', reason: 'synthetic' }, 'u-mgr2');
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ userId: 'u-mgr', approvedBy: 'u-mgr2' });
    // Leaving: u-mgr cannot confirm his own removal either; u-mgr2 can.
    expect(codeOf(await s.confirmed('V4', { action: 'remove', userId: 'u-mgr', reason: 'synthetic' }, 'u-mgr'))).toBe('committee_change_confirmed_by_its_subject');
    expect((await s.complaints('u-mgr')).status).toBe(200);
    expect((await s.confirmed('V5', { action: 'remove', userId: 'u-mgr', reason: 'synthetic' }, 'u-mgr2')).status).toBe(201);
    expect((await s.complaints('u-mgr')).status).toBe(403);
    // Nothing refused reached the audit trail as an access change.
    const trail = await auditTrailAdapter({ store: h.store }).records(t);
    expect(trail.filter((r) => (r.action === 'role.grant' || r.action === 'role.revoke') && ['V1', 'V2', 'V4'].includes(r.correlationId ?? ''))).toEqual([]);
  });

  it('OB-182: a store manager who also holds the owner role cannot confirm — refused by name, before the approval is used up', async () => {
    const h = harness();
    const t = randomUUID();
    const s = await cast(h, t);
    // A person who holds BOTH roles (the owner, made a store manager too), and a second owner who is also a store manager.
    await h.provisionRole(t, 'u-both', 'owner');
    await h.provisionRole(t, 'u-both', 'store_manager');
    await h.provisionRole(t, 'u-owner', 'store_manager');
    const add = { action: 'add', userId: 'u-new', reason: 'synthetic: a replacement joins' };
    const body = await approvedBody(h, t, 'u-owner', 'u-both', 'posh_committee_change', 'B1', add, { changeId: 'B1' });
    const refused = await s.change('B1', body);
    expect(refused.status).toBe(422);
    expect(codeOf(refused)).toBe('committee_change_confirmed_by_an_owner');
    const words = (refused.body as { error: { whatHappened: string; nextSafeAction: string } }).error;
    expect(words.whatHappened).toBe('u-both confirmed this change but holds the owner role. An Internal Committee change is confirmed by a store manager who is not an owner (owner decision OB-182).');
    expect(words.nextSafeAction).toContain('Nobody\'s access changed.');
    expect((await s.complaints('u-new')).status).toBe(403);
    // The approval was NOT used up by the refusal: it is still "approved", with nothing named as having used it.
    const mine = ((await h.request({ method: 'GET', path: '/v1/approvals/requests', userId: 'u-owner', tenantId: t })).body as { mine: { requestId: string; status: string; usedBy?: string }[] }).mine;
    const approval = mine.find((r) => r.requestId === body['approvalId'])!;
    expect(approval).toMatchObject({ status: 'approved' });
    expect(approval.usedBy).toBeUndefined();
    // A second owner who is also made a store manager: refused the same way.
    await h.provisionRole(t, 'u-owner2', 'store_manager');
    expect(codeOf(await s.confirmed('B2', { action: 'add', userId: 'u-new', reason: 'synthetic' }, 'u-owner2'))).toBe('committee_change_confirmed_by_an_owner');
    // A store manager who is not an owner confirms: it applies.
    const ok = await s.confirmed('B3', add, 'u-mgr');
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ userId: 'u-new', approvedBy: 'u-mgr' });
    expect((await s.complaints('u-new')).status).toBe(200);
    // Nothing refused reached the audit trail as an access change.
    const trail = await auditTrailAdapter({ store: h.store }).records(t);
    expect(trail.filter((r) => (r.action === 'role.grant' || r.action === 'role.revoke') && ['B1', 'B2'].includes(r.correlationId ?? ''))).toEqual([]);
  });

  it('the owner never holds the role; nobody else may use the route; the route gives no other role; OB-157 stands', async () => {
    const h = harness();
    const t = randomUUID();
    const s = await cast(h, t);
    // The owner adding himself, or another owner, is refused — before anybody is asked to confirm.
    expect(codeOf(await s.change('S1', { action: 'add', userId: 'u-owner', reason: 'synthetic' }))).toBe('owner_never_on_the_internal_committee');
    expect(codeOf(await s.change('S2', { action: 'add', userId: 'u-owner2', reason: 'synthetic' }))).toBe('owner_never_on_the_internal_committee');
    // ...and even with a confirmation in hand.
    expect(codeOf(await s.confirmed('S3', { action: 'add', userId: 'u-owner2', reason: 'synthetic' }))).toBe('owner_never_on_the_internal_committee');
    // Only the internal_committee role.
    expect(codeOf(await s.change('S4', { action: 'add', userId: 'u-new', roleId: 'store_manager', reason: 'synthetic' }))).toBe('only_the_internal_committee_role_here');
    // Nobody but the owner may make the change — not the manager, a committee member or the accountant.
    for (const who of ['u-mgr', 'u-ic', 'u-acct']) {
      expect((await s.change(`N-${who}`, { action: 'add', userId: 'u-new', reason: 'synthetic' }, who)).status, who).toBe(403);
    }
    // The general grant route does not give the committee role, and never gives a member the owner role.
    const viaGrant = await h.request({ method: 'POST', path: '/v1/identity/grants', userId: 'u-mgr', tenantId: t, idempotencyKey: 'g1', ...MFA, body: { grantId: 'g1', userId: 'u-new', roleId: 'internal_committee', branchScope: 'all', reason: 'synthetic' } });
    expect(codeOf(viaGrant)).toBe('committee_membership_has_its_own_route');
    const ownerToMember = await h.request({ method: 'POST', path: '/v1/identity/grants', userId: 'u-mgr', tenantId: t, idempotencyKey: 'g2', ...MFA, body: { grantId: 'g2', userId: 'u-ic', roleId: 'owner', branchScope: 'all', reason: 'synthetic' } });
    expect(codeOf(ownerToMember)).toBe('owner_never_on_the_internal_committee');
    // Not even an emergency grant puts the owner on the committee.
    const emergencyBody = { userId: 'u-owner', roleId: 'internal_committee', branchScope: 'all', reason: 'synthetic: wants to read the register urgently', minutes: 30 };
    const emergency = await h.request({ method: 'POST', path: '/v1/access/emergency/e1', userId: 'u-mgr', tenantId: t, idempotencyKey: 'e1', body: await approvedBody(h, t, 'u-mgr', 'u-owner', 'emergency_access', 'e1', emergencyBody, { grantId: 'e1' }) });
    expect(codeOf(emergency)).toBe('owner_never_on_the_internal_committee');
    // OB-157: the owner reads no complaint.
    expect((await s.complaints('u-owner')).status).toBe(403);
  });
});
