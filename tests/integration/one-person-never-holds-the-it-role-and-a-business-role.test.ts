import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { startRealCloud, type RealCloud } from '../support/real-store';
import { InMemoryEventStore } from '../../packages/persistence/src/event-store';
import { seedInitialAdmins } from '../../services/api/src/access';
import { STREAM, streamName } from '../../services/api/src/adapters';
import { makeEvent } from '../../packages/contracts/src/event';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { ROLE_CATALOGUE, STORE_COMPUTER_ROLE_ID, BACKUP_JOB_ROLE_ID, PROVIDER_RELAY_ROLE_ID, PLATFORM_ADMIN_ROLE_ID } from '../../services/api/src/roles';
import {
  dutiesGrantRefusal, dutiesSetRefusal, combinedDuties, dutyOf, MACHINE_ROLE_IDS, SEPARATION_OF_DUTIES_REFUSAL_CODE,
} from '../../services/identity/src/separation-of-duties';

/**
 * **OB-95 "C" (owner, 13 Oct 2026, in writing): one person never holds both the IT/platform role and a business role.**
 *
 * OB-91 refused the IT/platform administrator's FUNCTION the clearing of a store computer's suspicious bill count; a person
 * holding both the IT role and an all-stores business role could still clear it through the business role (verifier r24
 * Q3). The owner chose separation of duties. On the real API (in memory, and on PostgreSQL through the production assembly):
 *
 *   • asking for the IT role for someone who holds a business role — or a business role for someone who holds the IT
 *     role — is refused by name (422 `it_role_and_business_role_on_one_person`) before anybody is asked to approve it;
 *   • judged again at APPROVAL (the person may have been given the other side since it was asked);
 *   • an emergency grant and a joiner/mover change cannot do it either — a live emergency grant counts as held;
 *   • nor the operator's initial admin set (scripts/bootstrap-tenant.ts, scripts/new-shop.ts);
 *   • a person who already holds both (granted before the rule) is named for the owner on the operational health
 *     (`access_separation_of_duties`, degraded);
 *   • on PostgreSQL the refusal is on the audit trail (audit_log, status 422).
 * And verifier r24 NEW-4 (a test gap): head office's OB-91 check reads each grant's OWN scope — a person holding the IT role
 * for all stores and a business role for one store is refused as the IT function, never treated as all-stores business staff.
 */

const OWNER = 'u-owner'; const ASKER = 'u-hr';
interface Reply { readonly status: number; readonly body: unknown }
type Call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown) => Promise<Reply>;
const codeOf = (r: Reply): string | undefined => (r.body as { error?: { code?: string } } | null)?.error?.code;
const whatOf = (r: Reply): string => (r.body as { error?: { whatHappened?: string } } | null)?.error?.whatHappened ?? '';
const ask = (call: Call, grantId: string, userId: string, roleId: string): Promise<Reply> =>
  call('POST', '/v1/identity/grants', ASKER, { grantId, userId, roleId, branchScope: 'all', reason: 'OB-95 proof' });

/** The routes' proof. `lay` puts a grant straight on the ledger (as a seed from before the rule could have). */
async function neverBoth(call: Call, lay: (userId: string, roleId: string) => Promise<void>): Promise<void> {
  await lay('u-mgr', 'store_manager');
  await lay('u-it', PLATFORM_ADMIN_ROLE_ID);
  // A business person is never given the IT role — refused at the request, nothing pending.
  const toBusiness = await ask(call, 'g-mgr-it', 'u-mgr', PLATFORM_ADMIN_ROLE_ID);
  expect(toBusiness.status, JSON.stringify(toBusiness.body)).toBe(422);
  expect(codeOf(toBusiness)).toBe(SEPARATION_OF_DUTIES_REFUSAL_CODE);
  expect(whatOf(toBusiness)).toMatch(/platform_admin is the IT\/platform role, and this person already holds a business role\. .*owner decision OB-95/);
  expect((await call('POST', '/v1/identity/grants/g-mgr-it/approve', OWNER, {})).status).toBe(404);
  // …and the IT person is never given a business role, in the other order.
  const toIt = await ask(call, 'g-it-cash', 'u-it', 'cashier');
  expect(toIt.status).toBe(422);
  expect(codeOf(toIt)).toBe(SEPARATION_OF_DUTIES_REFUSAL_CODE);
  expect(whatOf(toIt)).toMatch(/This person already holds the IT\/platform role, and cashier is a business role/);
  // Judged again at approval: asked while u-later held nothing, approved after they were given the IT role — refused.
  expect((await ask(call, 'g-later-cash', 'u-later', 'cashier')).status).toBe(202);
  await lay('u-later', PLATFORM_ADMIN_ROLE_ID);
  const late = await call('POST', '/v1/identity/grants/g-later-cash/approve', OWNER, {});
  expect(late.status, JSON.stringify(late.body)).toBe(422);
  expect(codeOf(late)).toBe(SEPARATION_OF_DUTIES_REFUSAL_CODE);
  // An emergency grant cannot do it (refused before any approval is looked for), nor a joiner/mover change.
  const emergency = await call('POST', '/v1/access/emergency/e-ob95', ASKER, { userId: 'u-mgr', roleId: PLATFORM_ADMIN_ROLE_ID, branchScope: 'all', reason: 'the store computer is down', minutes: 30 });
  expect(emergency.status, JSON.stringify(emergency.body)).toBe(422);
  expect(codeOf(emergency)).toBe(SEPARATION_OF_DUTIES_REFUSAL_CODE);
  const joiner = await call('POST', '/v1/access/lifecycle/lc-ob95', ASKER, { event: 'joiner', userId: 'u-new', reason: 'new hire', grants: [{ userId: 'u-new', roleId: 'cashier', branchScope: 'all' }, { userId: 'u-new', roleId: PLATFORM_ADMIN_ROLE_ID, branchScope: 'all' }] });
  expect(joiner.status, JSON.stringify(joiner.body)).toBe(422);
  expect(codeOf(joiner)).toBe(SEPARATION_OF_DUTIES_REFUSAL_CODE);
  const mover = await call('POST', '/v1/access/lifecycle/lc-ob95-m', ASKER, { event: 'mover', userId: 'u-it', reason: 'moves to the shop floor too', grants: [{ userId: 'u-it', roleId: PLATFORM_ADMIN_ROLE_ID, branchScope: 'all' }, { userId: 'u-it', roleId: 'store_manager', branchScope: 'all' }] });
  expect(mover.status, JSON.stringify(mover.body)).toBe(422);
  expect(codeOf(mover)).toBe(SEPARATION_OF_DUTIES_REFUSAL_CODE);
  // What is allowed stays allowed: two business roles on one person; the IT role on a person who holds nothing.
  expect((await ask(call, 'g-mgr-cash', 'u-mgr', 'cashier')).status).toBe(202);
  expect((await ask(call, 'g-fresh-it', 'u-fresh', PLATFORM_ADMIN_ROLE_ID)).status).toBe(202);
  // Nothing was granted by any refusal: nobody holds both, so nothing is listed.
  expect(await bothListed(call)).toEqual([]);
  // A person who holds both from before the rule is NAMED for the owner.
  await lay('u-old', 'store_manager');
  await lay('u-old', PLATFORM_ADMIN_ROLE_ID);
  expect(await bothListed(call)).toEqual([expect.stringMatching(/^separation of duties \(owner decision OB-95\): u-old holds the IT\/platform role \(platform_admin\) AND business role\(s\) \(store_manager\)/)]);
}
async function bothListed(call: Call): Promise<string[]> {
  const r = await call('GET', '/v1/platform/operational-health/observed', OWNER);
  expect(r.status).toBe(200);
  return ((r.body as { health: { components: { name: string; status: string; detail: string }[] } }).health.components)
    .filter((c) => c.name === 'access_separation_of_duties').map((c) => { expect(c.status).toBe('degraded'); return c.detail; });
}

describe('OB-95 — the rule itself', () => {
  const R = ROLE_CATALOGUE;
  it('the IT role and a business role never meet, either way round; machines and the business roles among themselves are untouched', () => {
    expect(dutyOf(PLATFORM_ADMIN_ROLE_ID, R)).toBe('it');
    expect(dutyOf('owner', R)).toBe('business');
    expect(dutyOf('store_manager', R)).toBe('business');
    expect(dutyOf('cashier', R)).toBe('business');
    expect(dutyOf('no_such_role', R)).toBeUndefined();
    for (const m of MACHINE_ROLE_IDS) expect(dutyOf(m, R), m).toBeUndefined();
    expect(dutiesGrantRefusal(PLATFORM_ADMIN_ROLE_ID, ['store_manager'], R)).toMatch(/OB-95/);
    expect(dutiesGrantRefusal('owner', [PLATFORM_ADMIN_ROLE_ID], R)).toMatch(/OB-95/);
    expect(dutiesGrantRefusal(PLATFORM_ADMIN_ROLE_ID, [], R)).toBeUndefined();
    expect(dutiesGrantRefusal(PLATFORM_ADMIN_ROLE_ID, [PLATFORM_ADMIN_ROLE_ID], R)).toBeUndefined();
    expect(dutiesGrantRefusal('cashier', ['store_manager', 'owner'], R)).toBeUndefined();
    expect(dutiesGrantRefusal(PLATFORM_ADMIN_ROLE_ID, ['store_computer'], R)).toBeUndefined(); // machines have their own rules
    expect(dutiesSetRefusal(['cashier', PLATFORM_ADMIN_ROLE_ID], R)).toBeDefined();
    expect(combinedDuties([{ userId: 'a', roleId: 'owner' }, { userId: 'a', roleId: PLATFORM_ADMIN_ROLE_ID }, { userId: 'b', roleId: 'owner' }], R))
      .toEqual([{ userId: 'a', itRoles: [PLATFORM_ADMIN_ROLE_ID], businessRoles: ['owner'] }]);
  });
  it('the machine identities named here are the catalogue\'s own (a role id typed twice must stay one control)', () => {
    expect([...MACHINE_ROLE_IDS].sort()).toEqual([STORE_COMPUTER_ROLE_ID, BACKUP_JOB_ROLE_ID, PROVIDER_RELAY_ROLE_ID].sort());
    for (const m of MACHINE_ROLE_IDS) expect(ROLE_CATALOGUE.some((r) => r.id === m), m).toBe(true);
  });
  it('the operator\'s initial admin set is refused when it gives one person both', async () => {
    await expect(seedInitialAdmins(new InMemoryEventStore(), randomUUID(), [{ userId: 'u-1', roleId: 'owner' }, { userId: 'u-1', roleId: PLATFORM_ADMIN_ROLE_ID }], 'operator', new Date().toISOString()))
      .rejects.toThrow(/Initial admin set refused for u-1: .*OB-95/);
    expect(await seedInitialAdmins(new InMemoryEventStore(), randomUUID(), [{ userId: 'u-1', roleId: 'owner' }, { userId: 'u-2', roleId: PLATFORM_ADMIN_ROLE_ID }], 'operator', new Date().toISOString()))
      .toEqual({ outcome: 'seeded', granted: 2 });
  });
});

describe('OB-95 — on the real API (in memory)', () => {
  let h: ApiHarness;
  let call: Call;
  let tenant: string;
  beforeAll(async () => {
    tenant = randomUUID();
    h = apiHarness();
    await h.seedOwner(tenant, OWNER);
    await h.provisionRole(tenant, ASKER, 'store_manager');
    call = (method, path, userId, body) => h.request({ method, path, userId, tenantId: tenant, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }) });
  });
  it('refused at request, at approval, in an emergency and in a joiner/mover change; old combinations are named', async () => {
    await neverBoth(call, (u, r) => h.provisionRole(tenant, u, r, 'all'));
  });
  it('a live emergency grant of the IT role counts as held: a business role is then refused', async () => {
    // Laid on the emergency ledger directly (the route refuses it to a business person, above) for someone with no role.
    await h.store.append(tenant, streamName(STREAM.identity, 'emergency-access'), makeEvent({
      id: 'em-it', type: 'EmergencyAccessRecorded', occurredAt: new Date().toISOString(), idempotencyKey: `em-it-${tenant}`, source: 'test/ob-95',
      payload: { grantId: 'em-it', userId: 'u-em', roleId: PLATFORM_ADMIN_ROLE_ID, branchScope: 'all', requestedBy: OWNER, approvedBy: ASKER, reason: 'test', grantedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
    }));
    const r = await ask(call, 'g-em-cash', 'u-em', 'cashier');
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(codeOf(r)).toBe(SEPARATION_OF_DUTIES_REFUSAL_CODE);
    // …and a joiner/mover change giving them a business role counts it too.
    const joiner = await call('POST', '/v1/access/lifecycle/lc-em', ASKER, { event: 'joiner', userId: 'u-em', reason: 'joins the shop floor', grants: [{ userId: 'u-em', roleId: 'cashier', branchScope: 'all' }] });
    expect(joiner.status, JSON.stringify(joiner.body)).toBe(422);
    expect(codeOf(joiner)).toBe(SEPARATION_OF_DUTIES_REFUSAL_CODE);
  });
  it('NEW-4 · OB-91: the IT role for all stores plus a business role for ONE store is refused as the IT function', async () => {
    // From before OB-95 (laid on the ledger directly): the business grant names one store, the IT grant all.
    await h.provisionRole(tenant, 'u-mixed', PLATFORM_ADMIN_ROLE_ID, 'all');
    await h.provisionRole(tenant, 'u-mixed', 'store_manager', ['S1']);
    const r = await call('POST', '/v1/store-computers/bill-number-refusals/acknowledgements', 'u-mixed', { storeId: 'S1', prefix: 'S1L1-', through: 20_000, reason: 'tries to clear it' });
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(codeOf(r)).toBe('acknowledgement_refused_to_platform_administrator');
  });
});

const DATABASE_URL = process.env['DATABASE_URL'];
describe.skipIf(!DATABASE_URL)('OB-95 — on real PostgreSQL through the production API assembly', () => {
  let cloud: RealCloud;
  let platform: Pool;
  const TENANT = randomUUID();
  let call: Call;
  beforeAll(async () => {
    platform = new Pool({ connectionString: DATABASE_URL, max: 2 });
    cloud = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId: TENANT, owner: OWNER, packSigningKey: ['ob95', 'duties', 'key'].join('-').padEnd(48, '0') });
    await layOnPg(ASKER, 'store_manager');
    call = (method, path, userId, body) => cloud.request({ method, path, userId, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }) });
  }, 120_000);
  afterAll(async () => { await cloud?.stop(); await platform?.end(); });
  // Laid on the ledger directly by the operator, as a seed from before the rule could have (the owner's own role may not
  // hand out platform_admin's — the no-escalation rule — as tests/integration/keycloak-provisioning.test.ts does).
  const layOnPg = async (userId: string, roleId: string): Promise<void> => {
    const at = new Date().toISOString();
    await new SqlEventStore(pgPoolClient(platform)).append(TENANT, STREAM.identity, makeEvent({
      id: `grant-${roleId}-${userId}-${TENANT}`, type: 'RoleGranted', occurredAt: at, idempotencyKey: `grant-${TENANT}-${roleId}-${userId}`, source: 'test/ob-95',
      payload: { userId, roleId, branchScope: 'all', request: { grantId: `${roleId}-${userId}`, userId, roleId, branchScope: 'all', requestedBy: 'operator', approvedBy: 'operator', requestedAt: at } },
    }));
  };
  it('refused at request, at approval, in an emergency and in a joiner/mover change; old combinations are named', async () => {
    await neverBoth(call, layOnPg);
  }, 120_000);
  it('the refusal is on the audit trail (audit_log, 422), and nothing was granted', async () => {
    const key = `k-${randomUUID()}`;
    const r = await cloud.request({ method: 'POST', path: '/v1/identity/grants', userId: ASKER, idempotencyKey: key, body: { grantId: 'g-audit', userId: 'u-mgr', roleId: PLATFORM_ADMIN_ROLE_ID, branchScope: 'all', reason: 'OB-95 audit proof' } });
    expect(r.status).toBe(422);
    const audit = await platform.query('SELECT status, permission FROM audit_log WHERE tenant_id = $1 AND user_id = $2 AND path = $3 AND idempotency_key = $4', [TENANT, ASKER, '/v1/identity/grants', key]);
    expect(audit.rows).toEqual([{ status: 422, permission: 'identity.role.request' }]);
    const kept = await platform.query("SELECT count(*)::int AS n FROM event_ledger WHERE tenant_id = $1 AND type = 'RoleGrantRequested' AND payload->>'grantId' = 'g-audit'", [TENANT]);
    expect(kept.rows[0].n).toBe(0);
  }, 60_000);
});
