import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { setApprovedCreditLimit } from '../support/approved-credit-limit';
import { STREAM } from '../../services/api/src/adapters';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import type { DirectoryPerson, IdentityDirectory } from '../../services/identity/src/identity-directory';

/**
 * **OB-76 "A" (owner, 12 Oct 2026, in writing, "Staff invite + 2nd approves") — logins for outside parties: a business
 * customer (`b2b_customer`), an app customer (`customer`) and a supplier (`supplier`) (M22-FR-04 · M20 · M24-FR-01 · §28 ·
 * §35 · M02-FR-01 · SEC-03 · hard rules #4 #6).**
 *
 * On the real head-office API (in memory and, with DATABASE_URL, on real PostgreSQL), with a FAKE identity server (no real
 * credentials anywhere):
 *
 *   • the generic grant route still refuses all three roles — since round 14 at the request itself
 *     (`outside_party_login_holds_only_its_role`);
 *   • a member of staff who MANAGES the party invites a named person's login bound to the party's record; a DIFFERENT person
 *     who also manages it approves; the inviter cannot approve, nor can someone without that party's right (403), nor can
 *     a staff login, a shared name, an unknown party or (for an app customer) a login that is not the customer's record;
 *   • both names are on the record and on the `RoleGranted` the access resolver folds;
 *   • the login reads ONLY its own party's rows (business customer: its account, another customer's refused and recorded;
 *     supplier: its own statement; app customer: its own orders) and none of the staff routes;
 *   • the sign-in is given the way the people route gives one: second factor required to ask, a one-time password shown
 *     once (a replay withholds it), never stored, and the person listed with the people;
 *   • revoke: the sign-in is ended at the identity server, the role taken away, the login refused at once; a re-send is one;
 *   • a pending invite can be rejected with a reason; a second head-office instance (a restart) reads the same records.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });

interface FakeDirectory extends IdentityDirectory { readonly issued: DirectoryPerson[]; readonly ended: string[] }
const fakeDirectory = (): FakeDirectory => {
  const issued: DirectoryPerson[] = [];
  const ended: string[] = [];
  return {
    issued, ended,
    issue: async (p) => { issued.push(p); return { result: 'issued', resumed: false }; },
    end: async (userId) => { ended.push(userId); return 'ended'; },
  };
};
type Factory = (directory: IdentityDirectory, same?: ApiHarness) => ApiHarness;
const backings: { name: string; harness: Factory }[] = [{ name: 'the in-memory event store', harness: (d, same) => apiHarness({ identityDirectory: d, ...(same === undefined ? {} : { store: same.store }) }) }];
if (DATABASE_URL !== undefined) {
  backings.push({ name: 'real PostgreSQL', harness: (d) => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql), identityDirectory: d }); } });
}

type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const PASSWORD = /^[2-9A-HJ-NP-Z]{4}(-[2-9A-HJ-NP-Z]{4}){3}$/;

describe.each(backings)('OB-76 — an outside party\'s login is invited by one person and approved by another — on $name', ({ harness }) => {
  it('invites, approves (a different person), binds to the party\'s own record, gives the sign-in once, and revokes — for all three kinds', async () => {
    const directory = fakeDirectory();
    const h = harness(directory);
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-acct', 'accountant');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-cash', 'cashier');
    await h.provisionRole(T, 'u-admin', 'platform_admin');
    await h.enableFeature(T, 'b2b');
    await h.enableFeature(T, 'customer_app');
    let n = 0;
    const call = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown, opts: { key?: string; query?: Record<string, string>; hh?: ApiHarness; authTimeFromNowSeconds?: number } = {}): Promise<Res> =>
      (opts.hh ?? h).request({ method, path, userId, tenantId: T, ...(body === undefined ? {} : { body }), ...(opts.query === undefined ? {} : { query: opts.query }), ...(opts.authTimeFromNowSeconds === undefined ? {} : { authTimeFromNowSeconds: opts.authTimeFromNowSeconds }), ...(method === 'GET' ? {} : { idempotencyKey: opts.key ?? `k-${n += 1}` }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    const B2B = '/v1/identity/outside-logins/b2b-accounts';
    const SUP = '/v1/identity/outside-logins/suppliers';
    const CUS = '/v1/identity/outside-logins/customers';

    // ── The parties' own records ─────────────────────────────────────────────────────────────────────────────────────
    await ok(setApprovedCreditLimit(h, T, 'u-owner', 'CATERER', { creditLimitMinor: 500_000 }, { checker: 'u-acct' }), 'caterer account'); // OB-360
    await ok(setApprovedCreditLimit(h, T, 'u-owner', 'CANTEEN', { creditLimitMinor: 100_000 }, { checker: 'u-acct' }), 'canteen account');
    await ok(call('POST', '/v1/b2b/accounts/CATERER/receivables', 'u-owner', { movementId: 'ar-1', kind: 'invoice', amountMinor: 70_000, ref: 'INV-C1' }), 'caterer invoice');
    await ok(call('POST', '/v1/supplier-portal/partners/SUP1', 'u-owner', { grants: ['view_statement', 'view_orders'], documents: [], requiredDocuments: [], logins: [] }), 'supplier partner');
    await ok(call('POST', '/v1/customers/cust-anita/points', 'u-owner', { movementId: 'pm-1', kind: 'earn', points: 10 }), 'customer record');

    // ── The generic grant route still refuses every outside-party role — since round 14 (verifier G5) already when it is
    //    ASKED for, by name (only the two-person outside-login invite gives these roles); nothing waits for approval ─────
    for (const roleId of ['b2b_customer', 'customer', 'supplier']) {
      const asked = await call('POST', '/v1/identity/grants', 'u-mgr', { grantId: `g-${roleId}`, userId: `u-x-${roleId.replace('_', '-')}`, roleId, branchScope: 'all', reason: 'portal' });
      expect([asked.status, codeOf(asked)], roleId).toEqual([422, 'outside_party_login_holds_only_its_role']);
      expect((await call('POST', `/v1/identity/grants/g-${roleId}/approve`, 'u-owner', {})).status, roleId).toBe(404);
    }

    // ── Business customer: invited by the owner (b2b.account.manage), approved by the accountant (b2b.account.manage) ─────
    const invite = { userId: 'u-caterer', displayName: 'Meena Raman', grants: ['view_statement', 'view_invoices'], reason: 'caterer\'s accounts clerk' };
    expect((await call('POST', `${B2B}/CATERER/invites/inv-cat`, 'u-cash', invite)).status, 'a cashier may not invite').toBe(403);
    expect((await call('POST', `${SUP}/SUP1/invites/inv-x`, 'u-acct', { userId: 'u-sup-x', displayName: 'Ravi Kumar' })).status, 'the accountant does not manage suppliers').toBe(403);
    expect(codeOf(await call('POST', `${B2B}/NOBODY/invites/inv-nobody`, 'u-owner', invite)), 'no such account').toBe('party_record_unknown');
    expect(codeOf(await call('POST', `${B2B}/CATERER/invites/inv-staff`, 'u-owner', { ...invite, userId: 'u-mgr' })), 'a staff login').toBe('login_already_holds_a_role');
    expect(codeOf(await call('POST', `${B2B}/CATERER/invites/inv-shared`, 'u-owner', { ...invite, displayName: 'Store Account' })), 'a shared name').toBe('shared_or_generic_sign_in');
    expect(codeOf(await call('POST', `${B2B}/CATERER/invites/inv-nogrants`, 'u-owner', { userId: 'u-caterer', displayName: 'Meena Raman' })), 'grants needed').toBe('not_readable_as_an_outside_login');
    const invited = await call('POST', `${B2B}/CATERER/invites/inv-cat`, 'u-owner', invite, { key: 'inv-cat' });
    expect(invited.status, JSON.stringify(invited.body)).toBe(201);
    expect((await call('POST', `${B2B}/CATERER/invites/inv-cat`, 'u-owner', invite, { key: 'inv-cat' })).status, 'a replay answers the first').toBe(201);
    expect((await call('POST', `${B2B}/CATERER/invites/inv-cat`, 'u-owner', invite)).body).toMatchObject({ alreadyInvited: true });
    // Invited is not granted: the login reads nothing yet.
    expect((await call('GET', '/v1/b2b-portal/me/account', 'u-caterer')).status).toBe(403);
    // The inviter cannot approve; a person without the party's right cannot; the second manager can.
    expect(codeOf(await call('POST', `${B2B}/invites/inv-cat/approve`, 'u-owner', {}))).toBe('approved_by_the_inviter');
    expect((await call('POST', `${B2B}/invites/inv-cat/approve`, 'u-mgr', {})).status, 'the store manager does not manage B2B accounts').toBe(403);
    expect(codeOf(await call('POST', `${B2B}/invites/inv-cat/sign-in`, 'u-acct', { signInName: 'meena.r' })), 'no sign-in before approval').toBe('invite_invited');
    const approved = await ok(call('POST', `${B2B}/invites/inv-cat/approve`, 'u-acct', {}, { key: 'appr-cat' }), 'approve caterer');
    expect((approved.body as { login: Record<string, unknown> }).login).toMatchObject({ state: 'approved', invitedBy: 'u-owner', approvedBy: 'u-acct', partyId: 'CATERER', role: 'b2b_customer' });
    expect((await call('POST', `${B2B}/invites/inv-cat/approve`, 'u-acct', {})).body).toMatchObject({ alreadyApproved: true });
    // Both names on the RoleGranted the access resolver folds — exactly one grant.
    const grants = (await h.store.readStream(T, STREAM.identity, { type: 'RoleGranted' })).map((e) => e.event.payload as { userId: string; roleId: string; request: { requestedBy: string; approvedBy: string }; provenance?: { kind: string; partyId: string } }).filter((g) => g.userId === 'u-caterer');
    expect(grants.map((g) => [g.roleId, g.request.requestedBy, g.request.approvedBy, g.provenance?.kind, g.provenance?.partyId])).toEqual([['b2b_customer', 'u-owner', 'u-acct', 'outside_party_login', 'CATERER']]);

    // The login reads ITS OWN account — and nothing else, never a staff route.
    const account = await ok(call('GET', '/v1/b2b-portal/me/account', 'u-caterer'), 'caterer reads its account');
    expect(account.body).toMatchObject({ customerId: 'CATERER' });
    const probe = await call('GET', '/v1/b2b-portal/me/account', 'u-caterer', undefined, { query: { customerId: 'CANTEEN' } });
    expect([probe.status, codeOf(probe)]).toEqual([403, 'not_your_data']);
    expect((await call('POST', '/v1/b2b/accounts/CATERER', 'u-caterer', { creditLimitMinor: 9_999_999 })).status, 'no staff authority').toBe(403);

    // ── The sign-in: the people pattern — second factor needed, the one-time password shown once, never stored ───────────
    expect((await call('POST', `${B2B}/invites/inv-cat/sign-in`, 'u-acct', { signInName: 'meena.r' }, { authTimeFromNowSeconds: -3_600 })).status, 'a stale sign-in is not enough').toBe(403);
    expect(codeOf(await call('POST', `${B2B}/invites/inv-cat/sign-in`, 'u-acct', { signInName: 'meena.r', password: 'x'.repeat(12) }))).toBe('password_is_never_sent');
    const signIn = await call('POST', `${B2B}/invites/inv-cat/sign-in`, 'u-acct', { signInName: 'meena.r' }, { key: 'si-cat' });
    expect(signIn.status, JSON.stringify(signIn.body)).toBe(201);
    const otp = (signIn.body as { oneTimePassword: string }).oneTimePassword;
    expect(otp).toMatch(PASSWORD);
    expect(directory.issued.map((p) => [p.userId, p.username, p.displayName, p.secondFactor])).toEqual([['u-caterer', 'meena.r', 'Meena Raman', true]]);
    const replay = await call('POST', `${B2B}/invites/inv-cat/sign-in`, 'u-acct', { signInName: 'meena.r' }, { key: 'si-cat' });
    expect(JSON.stringify(replay.body)).not.toContain(otp);
    expect(codeOf(await call('POST', `${B2B}/invites/inv-cat/sign-in`, 'u-acct', { signInName: 'meena.r' }))).toBe('person_already_has_a_sign_in');
    const ledger = JSON.stringify((await h.store.readStream(T, STREAM.identity)).map((e) => e.event.payload));
    expect(ledger).not.toContain(otp);
    const people = (await ok(call('GET', '/v1/identity/people', 'u-admin'), 'people')).body as { people: { userId: string; state: string; requestedBy: string }[] };
    expect(people.people.find((p) => p.userId === 'u-caterer')).toMatchObject({ state: 'issued', requestedBy: 'u-acct' });

    // ── Supplier: invited by the store manager (supplier.portal.manage), approved by the owner ────────────────────────
    await ok(call('POST', `${SUP}/SUP1/invites/inv-sup`, 'u-mgr', { userId: 'u-sup-ravi', displayName: 'Ravi Kumar' }), 'invite supplier');
    expect((await call('GET', '/v1/supplier-portal/me/statement', 'u-sup-ravi')).status).toBe(403);
    await ok(call('POST', `${SUP}/invites/inv-sup/approve`, 'u-owner', {}), 'approve supplier');
    const statement = await ok(call('GET', '/v1/supplier-portal/me/statement', 'u-sup-ravi'), 'supplier statement');
    expect(statement.body).toMatchObject({ partnerId: 'SUP1' });
    expect((await call('GET', '/v1/b2b-portal/me/account', 'u-sup-ravi')).status, 'a supplier is not a business customer').toBe(403);
    // A supplier invite cannot be approved through the business-customer route (another kind's invite is unknown there).
    expect(codeOf(await call('POST', `${B2B}/invites/inv-sup/approve`, 'u-acct', {}))).toBe('outside_login_invite_unknown');

    // ── App customer: the login IS the customer record; invited by the store manager, approved by the owner ────────────
    expect(codeOf(await call('POST', `${CUS}/cust-anita/invites/inv-anita-x`, 'u-mgr', { userId: 'u-someone', displayName: 'Anita Das' }))).toBe('customer_login_is_the_customer_record');
    await ok(call('POST', `${CUS}/cust-anita/invites/inv-anita`, 'u-mgr', { displayName: 'Anita Das' }), 'invite customer');
    expect(codeOf(await call('POST', `${CUS}/cust-anita/invites/inv-anita-2`, 'u-owner', { displayName: 'Anita Das' })), 'one open invite per login').toBe('login_already_invited');
    await ok(call('POST', `${CUS}/invites/inv-anita/approve`, 'u-owner', {}), 'approve customer');
    expect((await ok(call('GET', '/v1/storefront/orders', 'cust-anita'), 'customer orders')).body).toMatchObject({ orders: [] });
    expect((await call('GET', '/v1/b2b-portal/me/account', 'cust-anita')).status).toBe(403);

    // ── Reject a pending invite, with the reason ─────────────────────────────────────────────────────────────────────
    await ok(call('POST', `${B2B}/CANTEEN/invites/inv-can`, 'u-acct', { userId: 'u-canteen', displayName: 'Joseph Paul', grants: ['view_invoices'] }), 'invite canteen');
    expect(codeOf(await call('POST', `${B2B}/invites/inv-can/reject`, 'u-owner', {}))).toBe('rejection_needs_a_reason');
    await ok(call('POST', `${B2B}/invites/inv-can/reject`, 'u-owner', { reason: 'not their accounts clerk' }), 'reject canteen');
    expect(codeOf(await call('POST', `${B2B}/invites/inv-can/approve`, 'u-acct', {}))).toBe('invite_rejected');

    // ── Revoke: the sign-in ended at the identity server, the role gone, the login refused at once ────────────────────────
    expect(codeOf(await call('POST', `${B2B}/invites/inv-cat/revoke`, 'u-acct', {}))).toBe('revocation_needs_a_reason');
    const revoked = await ok(call('POST', `${B2B}/invites/inv-cat/revoke`, 'u-acct', { reason: 'the clerk left the caterer' }, { key: 'rev-cat' }), 'revoke');
    expect((revoked.body as { login: Record<string, unknown> }).login).toMatchObject({ state: 'revoked', revokedBy: 'u-acct', invitedBy: 'u-owner', approvedBy: 'u-acct' });
    expect(directory.ended).toEqual(['u-caterer']);
    expect([401, 403]).toContain((await call('GET', '/v1/b2b-portal/me/account', 'u-caterer')).status);
    expect((await call('POST', `${B2B}/invites/inv-cat/revoke`, 'u-acct', { reason: 'the clerk left the caterer' })).body).toMatchObject({ alreadyRevoked: true });
    expect(codeOf(await call('POST', `${B2B}/invites/inv-cat/approve`, 'u-acct', {}))).toBe('invite_revoked');
    expect((await h.store.readStream(T, STREAM.identity, { type: 'RoleRevoked' })).map((e) => (e.event.payload as { userId: string; roleId: string }).userId)).toEqual(['u-caterer']);

    // ── A restart: a second head-office instance reads the same records ───────────────────────────────────────────────
    const again = harness(directory, h);
    const list = (await ok(call('GET', B2B, 'u-owner', undefined, { hh: again }), 'list after restart')).body as { logins: { inviteId: string; state: string; invitedBy: string; approvedBy?: string; rejectedBy?: string }[] };
    expect(list.logins.map((l) => [l.inviteId, l.state, l.invitedBy, l.approvedBy ?? l.rejectedBy ?? null]).sort()).toEqual([
      ['inv-can', 'rejected', 'u-acct', 'u-owner'], ['inv-cat', 'revoked', 'u-owner', 'u-acct'],
    ]);
    expect((await call('GET', '/v1/supplier-portal/me/statement', 'u-sup-ravi', undefined, { hh: again })).status).toBe(200);
    expect((await call('GET', SUP, 'u-acct', undefined, { hh: again })).status, 'the accountant may not list supplier logins').toBe(403);
  }, 90_000);
});
