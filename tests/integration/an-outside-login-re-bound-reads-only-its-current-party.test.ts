import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import type { IdentityDirectory } from '../../services/identity/src/identity-directory';
import { STREAM, streamName } from '../../services/api/src/adapters';
import { makeEvent } from '../../packages/contracts/src/event';

/**
 * **Round 14 (verifier G4 · G5 · G6 — OB-76 · P-04 · hard rule #10): an outside party's login, re-bound, reads ONLY its
 * current party; nothing is ever stacked on it; two claims on one login at once — exactly one wins.**
 *
 * The verifier's probe O1: approve login u-l for business customer X, revoke, approve for Y, revoke, approve for X again —
 * the login then read Y's account (the binding was keyed so re-binding to X collapsed onto the old row, and reads took the
 * latest row: silent last-write-wins on a dedup). The supplier read did the same (and `bind()` skipped a login the partner
 * already listed). Probe O4: a cashier role granted on an approved supplier login through the generic grant route (201).
 * Probe O2: two invites / approvals for one login to two parties at the same moment both landed. Now, on the real API (in
 * memory, and with DATABASE_URL on real PostgreSQL):
 *
 *   • G4: X → revoke → Y → revoke → X reads only X (B2B account and supplier statement), never Y; between a revoke and the
 *     next approval the login reads NOBODY's rows (the revoke appends an unbinding); the invite list shows the history;
 *   • G5: the generic grant route refuses any role on an outside login (at the request, and at approval for a request made
 *     before the login became one), refuses an outside-party role itself, and so do an emergency grant and a joiner/mover;
 *   • G6: two invites for one login sent at the same moment — exactly one is recorded, the other a visible 409; two
 *     approvals binding one login to two parties at the same moment — exactly one wins, the other a visible 409.
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
const directory: IdentityDirectory = { issue: async () => ({ result: 'issued', resumed: false }), end: async () => 'ended' } as unknown as IdentityDirectory;
const backings: { name: string; harness: () => ApiHarness }[] = [{ name: 'the in-memory event store', harness: () => apiHarness({ identityDirectory: directory }) }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql), identityDirectory: directory }); } });

type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } } | null)?.error?.code;
const B2B = '/v1/identity/outside-logins/b2b-accounts';
const SUP = '/v1/identity/outside-logins/suppliers';
// A revoke cuts the login's sessions by second; the next approval is a later second (the sessions are new ones).
const nextSecond = () => new Promise((r) => setTimeout(r, 1_100));

async function shop(h: ApiHarness) {
  const T = randomUUID();
  await h.seedOwner(T, 'u-owner');
  await h.provisionRole(T, 'u-acct', 'accountant');
  await h.provisionRole(T, 'u-mgr', 'store_manager');
  await h.enableFeature(T, 'b2b');
  let n = 0;
  const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, key?: string): Promise<Res> =>
    h.request({ method, path, userId, tenantId: T, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: key ?? `k-${n += 1}` }) });
  const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
  // Round 18 (verifier r17 C-2 c): a role's branch scope names a store head office knows.
  await ok(call('POST', '/v1/org/nodes/C1', 'u-owner', { kind: 'company', name: 'SRE Retail' }), 'company');
  await ok(call('POST', '/v1/org/nodes/store-1', 'u-owner', { kind: 'branch', name: 'Store One', parentId: 'C1', companyId: 'C1' }), 'store-1 in the org tree');
  await ok(call('POST', '/v1/b2b/accounts/X', 'u-owner', { creditLimitMinor: 500_000 }), 'account X');
  await ok(call('POST', '/v1/b2b/accounts/Y', 'u-owner', { creditLimitMinor: 100_000 }), 'account Y');
  for (const p of ['SX', 'SY']) await ok(call('POST', `/v1/supplier-portal/partners/${p}`, 'u-owner', { grants: ['view_statement', 'view_orders'], documents: [], requiredDocuments: [], logins: [] }), `partner ${p}`);
  return { T, call, ok };
}
const shopTenant = async (call: (method: 'GET', path: string, userId: string) => Promise<Res>): Promise<{ T: string }> =>
  ({ T: ((await call('GET', '/v1/identity/me', 'u-owner')).body as { tenantId: string }).tenantId });

describe.each(backings)('Round 14 — an outside login re-bound reads only its current party — on $name', ({ harness }) => {
  it('G4: X → revoke → Y → revoke → X reads only X (business customer and supplier); between, nobody\'s rows', async () => {
    const h = harness();
    const { T, call, ok } = await shop(h);
    const approve = async (kind: string, party: string, inv: string, user: string, extra: Record<string, unknown>) => {
      await ok(call('POST', `${kind}/${party}/invites/${inv}`, 'u-owner', { userId: user, displayName: 'Meena Raman', ...extra }), `invite ${inv}`);
      await ok(call('POST', `${kind}/invites/${inv}/approve`, kind === B2B ? 'u-acct' : 'u-mgr', {}, `approve-${inv}`), `approve ${inv}`);
      await nextSecond();
    };
    const revoke = (kind: string, inv: string) => ok(call('POST', `${kind}/invites/${inv}/revoke`, kind === B2B ? 'u-acct' : 'u-mgr', { reason: 'moved' }, `revoke-${inv}`), `revoke ${inv}`);
    const account = async (): Promise<Res> => call('GET', '/v1/b2b-portal/me/account', 'u-l');
    const statement = async (): Promise<Res> => call('GET', '/v1/supplier-portal/me/statement', 'u-s');
    const g = ['view_statement'];

    await approve(B2B, 'X', 'i1', 'u-l', { grants: g });
    expect(JSON.stringify((await account()).body)).toContain('"customerId":"X"');
    await revoke(B2B, 'i1');
    // The revoke ENDS the binding on the ledger (append-only), not only the role.
    const unbound = (await h.store.readStream(T, streamName(STREAM.b2b, 'portal-login', 'u-l'))).map((e) => e.event.type);
    expect(unbound[unbound.length - 1]).toBe('B2BLoginUnbound');
    await approve(B2B, 'Y', 'i2', 'u-l', { grants: g });
    expect(JSON.stringify((await account()).body)).toContain('"customerId":"Y"');
    await revoke(B2B, 'i2');
    await nextSecond();
    // Between a revoke and the next approval: the role is gone (401/403) — and no binding is left for it to read.
    expect((await account()).status).toBeGreaterThanOrEqual(400);
    await approve(B2B, 'X', 'i3', 'u-l', { grants: g });
    const x = await account();
    expect(x.status, JSON.stringify(x.body)).toBe(200);
    expect(JSON.stringify(x.body)).toContain('"customerId":"X"');
    expect(JSON.stringify(x.body)).not.toContain('"customerId":"Y"');
    // One member of staff re-pointing the OB-76 login with the older single-person binding route does not move it: the
    // login reads the party of its approved invite (two people), never the latest binding row.
    expect((await call('POST', '/v1/b2b-portal/customers/Y/logins/u-l', 'u-acct', { grants: g })).status).toBe(201);
    expect(JSON.stringify((await account()).body)).toContain('"customerId":"X"');
    // Y's portal list no longer counts the login; X's does, once.
    const list = (await call('GET', B2B, 'u-acct')).body as { logins: { inviteId: string; partyId: string; state: string; userId: string }[] };
    expect(list.logins.filter((l) => l.userId === 'u-l').map((l) => [l.inviteId, l.partyId, l.state])).toEqual([['i1', 'X', 'revoked'], ['i2', 'Y', 'revoked'], ['i3', 'X', 'approved']]);

    await approve(SUP, 'SX', 's1', 'u-s', {});
    expect(JSON.stringify((await statement()).body)).toContain('"partnerId":"SX"');
    await revoke(SUP, 's1');
    const supUnbound = (await h.store.readStream(T, streamName(STREAM.purchase, 'portal-login', 'u-s'))).map((e) => e.event.type);
    expect(supUnbound[supUnbound.length - 1]).toBe('SupplierLoginUnbound');
    await approve(SUP, 'SY', 's2', 'u-s', {});
    expect(JSON.stringify((await statement()).body)).toContain('"partnerId":"SY"');
    await revoke(SUP, 's2');
    await approve(SUP, 'SX', 's3', 'u-s', {});
    const sx = await statement();
    expect(sx.status, JSON.stringify(sx.body)).toBe(200);
    expect(JSON.stringify(sx.body)).toContain('"partnerId":"SX"');
    expect(JSON.stringify(sx.body)).not.toContain('"partnerId":"SY"');
  }, 60_000);

  it('G5: nothing is stacked on an outside login — not by the grant route, an emergency grant or a joiner/mover; an outside role is never given there', async () => {
    const h = harness();
    const { call, ok } = await shop(h);
    // A request for a staff role made BEFORE the login became an outside party's — refused at its approval.
    await ok(call('POST', '/v1/identity/grants', 'u-mgr', { grantId: 'g-early', userId: 'u-s', roleId: 'cashier', branchScope: ['store-1'], reason: 'help at till' }), 'early request');
    await ok(call('POST', `${SUP}/SX/invites/s1`, 'u-owner', { userId: 'u-s', displayName: 'Meena Raman' }), 'invite');
    // Even while only INVITED, nothing is stacked on it.
    const pendingAsk = await call('POST', '/v1/identity/grants', 'u-mgr', { grantId: 'g-pend', userId: 'u-s', roleId: 'cashier', branchScope: ['store-1'], reason: 'x' });
    expect(codeOf(pendingAsk)).toBe('outside_party_login_holds_only_its_role');
    await ok(call('POST', `${SUP}/invites/s1/approve`, 'u-mgr', {}), 'approve');

    const ask = await call('POST', '/v1/identity/grants', 'u-mgr', { grantId: 'g-o4', userId: 'u-s', roleId: 'cashier', branchScope: ['store-1'], reason: 'help at till' });
    expect(ask.status, JSON.stringify(ask.body)).toBe(422);
    expect(codeOf(ask)).toBe('outside_party_login_holds_only_its_role');
    expect((await call('POST', '/v1/identity/grants/g-o4/approve', 'u-owner', {})).status).toBe(404);
    const early = await call('POST', '/v1/identity/grants/g-early/approve', 'u-owner', {});
    expect(early.status, JSON.stringify(early.body)).toBe(422);
    expect(codeOf(early)).toBe('outside_party_login_holds_only_its_role');
    // An outside-party role is never given through the generic route, to anybody.
    expect(codeOf(await call('POST', '/v1/identity/grants', 'u-mgr', { grantId: 'g-sup', userId: 'u-new', roleId: 'supplier', branchScope: 'all', reason: 'x' }))).toBe('outside_party_login_holds_only_its_role');
    // Emergency grant and joiner/mover: refused before any approval is even asked for.
    const em = await call('POST', '/v1/access/emergency/em-1', 'u-owner', { userId: 'u-s', roleId: 'cashier', branchScope: ['store-1'], reason: 'till down', minutes: 30, approvalId: 'apr-none' });
    expect(codeOf(em), JSON.stringify(em.body)).toBe('outside_party_login_holds_only_its_role');
    const mover = await call('POST', '/v1/access/lifecycle/lc-1', 'u-owner', { event: 'mover', userId: 'u-s', reason: 'moved to stores', grants: [{ userId: 'u-s', roleId: 'cashier', branchScope: ['store-1'] }], approvalId: 'apr-none' });
    expect(codeOf(mover), JSON.stringify(mover.body)).toBe('outside_party_login_holds_only_its_role');

    // What the login holds is still only its own role.
    const access = await call('GET', '/v1/identity/me', 'u-s');
    expect(JSON.stringify(access.body)).not.toContain('pos.sale');
  }, 60_000);

  it('G6: two invites, or two approvals, for one login at the same moment — exactly one wins, the other a visible 409', async () => {
    const h = harness();
    const { call, ok } = await shop(h);
    const g = ['view_statement'];
    const [a, b] = await Promise.all([
      call('POST', `${B2B}/X/invites/c1`, 'u-owner', { userId: 'u-race', displayName: 'Ravi Kumar', grants: g }),
      call('POST', `${B2B}/Y/invites/c2`, 'u-owner', { userId: 'u-race', displayName: 'Ravi Kumar', grants: g }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const losing = a.status === 409 ? a : b;
    expect(['login_claimed_at_the_same_moment', 'login_already_invited']).toContain(codeOf(losing));
    const listed = ((await call('GET', B2B, 'u-acct')).body as { logins: { userId: string }[] }).logins.filter((l) => l.userId === 'u-race');
    expect(listed).toHaveLength(1);

    // Two approvals at once: a ledger written before the per-login guard can hold two OPEN invites for one login (here the
    // second is appended straight onto the ledger, as such a ledger would hold it). Both approved at the same moment —
    // exactly one binds; the other is a visible 409 and grants nothing.
    const { T } = await shopTenant(call);
    await ok(call('POST', `${B2B}/X/invites/e1`, 'u-owner', { userId: 'u-pair', displayName: 'Anitha Devi', grants: g }), 'e1');
    await h.store.appendBatch(T, [{
      stream: STREAM.identity,
      event: makeEvent({
        id: 'outside-login-e2-invited', type: 'OutsideLoginInvited', occurredAt: new Date().toISOString(), idempotencyKey: `outside-login-${T}-e2-invited`, source: 'test/pre-guard-ledger',
        payload: { invite: { inviteId: 'e2', role: 'b2b_customer', partyId: 'Y', userId: 'u-pair', displayName: 'Anitha Devi', grants: g, invitedBy: 'u-owner', invitedAt: new Date().toISOString(), reason: null } },
      }),
    }]);
    const [x, y] = await Promise.all([call('POST', `${B2B}/invites/e1/approve`, 'u-acct', {}), call('POST', `${B2B}/invites/e2/approve`, 'u-acct', {})]);
    // Exactly one wins. The loser is refused visibly either way: 409 when the two meet at the guard, or 422 when the
    // database serialised them and the loser already sees the winner's role on the login. Never two approvals.
    const statuses = [x.status, y.status].sort();
    expect(statuses[0], `${JSON.stringify(x.body)} ${JSON.stringify(y.body)}`).toBe(200);
    const loser = x.status === 200 ? y : x;
    expect([409, 422]).toContain(loser.status);
    expect(codeOf(loser)).toBe(loser.status === 409 ? 'login_claimed_at_the_same_moment' : 'login_already_holds_a_role');
    const pairs = ((await call('GET', B2B, 'u-acct')).body as { logins: { userId: string; partyId: string; state: string }[] }).logins.filter((l) => l.userId === 'u-pair');
    expect(pairs.filter((l) => l.state === 'approved')).toHaveLength(1);
    // The login reads exactly the party whose approval won.
    await nextSecond();
    const won = pairs.find((l) => l.state === 'approved')!.partyId;
    expect(JSON.stringify((await call('GET', '/v1/b2b-portal/me/account', 'u-pair')).body)).toContain(`"customerId":"${won}"`);
  }, 60_000);
});
