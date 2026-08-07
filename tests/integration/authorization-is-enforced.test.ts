import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHmac } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { InMemoryEventStore, SqlEventStore } from '../../packages/persistence/src/event-store';
import { pgClient } from '../../packages/persistence/src/pg-client';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { makeEvent } from '../../packages/contracts/src/event';
import {
  buildRouter, handle, MemoryIdempotencyStore, SqlIdempotencyStore, type HttpRequest,
} from '../../services/kernel/src/index';
import { tokenAuthenticator } from '../../services/identity/src/index';
import { buildSurface } from '../../services/api/src/main';
import { tenantAccessResolver, seedGenesisOwner } from '../../services/api/src/access';
import { ROLE_CATALOGUE, OWNER_ROLE_ID } from '../../services/api/src/roles';
import { STREAM } from '../../services/api/src/adapters';

/**
 * Authorization is REAL and per-tenant on the actual API surface (M02-FR-02, SEC-03, P-04).
 *
 * The production composition root used to wire `new AccessControl([], [])` — a global, empty table
 * that authorised nothing and was never rebuilt from anyone's grants. The whole least-privilege
 * apparatus was inert on the live surface, and no test drove an authenticated-AND-authorized request
 * against it, so nothing saw the hole. This is that test: it builds the real surface, authenticates
 * with the real token verifier, and authorises with the real per-tenant resolver — then proves the
 * whole matrix. It also proves the genesis bootstrap that stops a provisioned-but-ungranted tenant
 * being a permanent 403.
 */

const IDP_KEY = 'authorization-is-enforced-idp-signing-key-000000';
const PACK_KEY = 'authorization-is-enforced-pack-signing-key-00000';
const ISS = 'https://idp.sre.test';
const AUD = 'sre-retail-os';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const AT = '2026-08-07T10:00:00.000Z';

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');

function mint(o: {
  sub: string; tenant: string; branch?: string; expSecondsFromNow?: number;
  key?: string; iss?: string; aud?: string; alg?: string;
}): string {
  const header = b64({ alg: o.alg ?? 'HS256', typ: 'JWT' });
  const payload = b64({
    sub: o.sub, tenant_id: o.tenant,
    ...(o.branch === undefined ? {} : { branch_id: o.branch }),
    iss: o.iss ?? ISS, aud: o.aud ?? AUD,
    exp: Math.floor(Date.now() / 1000) + (o.expSecondsFromNow ?? 3600),
  });
  const sig = createHmac('sha256', o.key ?? IDP_KEY).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

const bearer = (token: string, extra: Record<string, string> = {}): Record<string, string> =>
  ({ authorization: `Bearer ${token}`, ...extra });

/** Provision an owner directly (as tenant provisioning would seed the initial admin set). */
async function appendOwnerGrant(store: InMemoryEventStore | SqlEventStore, tenant: string, userId: string): Promise<void> {
  await store.append(tenant, STREAM.identity, makeEvent({
    id: `grant-${userId}`, type: 'RoleGranted', occurredAt: AT,
    idempotencyKey: `grant-${tenant}-${userId}`, source: 'test/provision',
    payload: {
      userId, roleId: OWNER_ROLE_ID, branchScope: 'all',
      request: { grantId: userId, userId, roleId: OWNER_ROLE_ID, branchScope: 'all', requestedBy: 'test', approvedBy: 'test', requestedAt: AT },
    },
  }));
}

function kernelFor(store: InMemoryEventStore | SqlEventStore, idempotency: MemoryIdempotencyStore | SqlIdempotencyStore): Parameters<typeof handle>[0] {
  const built = buildRouter(buildSurface({ signingKey: PACK_KEY, migrationTargetKind: 'rehearsal', store }));
  if (!built.ok) throw new Error(`surface malformed: ${built.refusals.map((r) => r.detail).join('; ')}`);
  return {
    router: built.router!,
    authenticate: tokenAuthenticator({ secret: IDP_KEY, issuer: ISS, audience: AUD }),
    access: tenantAccessResolver(store, ROLE_CATALOGUE),
    idempotency,
    newTraceId: () => 'trace-authz',
  };
}

const GET_ME: Omit<HttpRequest, 'headers'> = { method: 'GET', path: '/v1/identity/me' };
const grantBody = (o: { grantId: string; userId: string; requestedBy: string; approvedBy: string; roleId?: string }): Record<string, unknown> =>
  ({ grantId: o.grantId, userId: o.userId, roleId: o.roleId ?? 'cashier', branchScope: 'all', requestedBy: o.requestedBy, approvedBy: o.approvedBy, requestedAt: AT });

describe('authorization is enforced on the real API surface (in-memory)', () => {
  it('a genesis-seeded owner performs an authenticated + authorized request (200)', async () => {
    const store = new InMemoryEventStore();
    expect(await seedGenesisOwner(store, OWNER_ROLE_ID, A, 'u-owner', AT)).toBe('seeded');
    const k = kernelFor(store, new MemoryIdempotencyStore());

    const res = await handle(k, { ...GET_ME, headers: bearer(mint({ sub: 'u-owner', tenant: A })) });
    expect(res.status).toBe(200);
    expect((res.body as { permissions: string[] }).permissions).toContain('identity.role.grant');
  });

  it('an authenticated but UNAUTHORIZED user is refused (403)', async () => {
    const store = new InMemoryEventStore();
    await appendOwnerGrant(store, A, 'u-owner-1');
    await appendOwnerGrant(store, A, 'u-owner-2');
    const k = kernelFor(store, new MemoryIdempotencyStore());

    // Establish a cashier via a proper two-person grant.
    const granted = await handle(k, {
      method: 'POST', path: '/v1/identity/grants',
      body: grantBody({ grantId: 'g1', userId: 'u-cash', requestedBy: 'u-owner-1', approvedBy: 'u-owner-2' }),
      headers: bearer(mint({ sub: 'u-owner-1', tenant: A }), { 'idempotency-key': 'k-g1' }),
    });
    expect(granted.status).toBe(201);

    // The cashier does not hold identity.role.grant → forbidden, before the body is even read.
    const denied = await handle(k, {
      method: 'POST', path: '/v1/identity/grants',
      body: grantBody({ grantId: 'g2', userId: 'u-x', requestedBy: 'u-cash', approvedBy: 'u-owner-2' }),
      headers: bearer(mint({ sub: 'u-cash', tenant: A }), { 'idempotency-key': 'k-g2' }),
    });
    expect(denied.status).toBe(403);
  });

  it('rejects unauthenticated, malformed, expired, wrong-key, alg-none and wrong-issuer tokens (401)', async () => {
    const store = new InMemoryEventStore();
    await seedGenesisOwner(store, OWNER_ROLE_ID, A, 'u-owner', AT);
    const k = kernelFor(store, new MemoryIdempotencyStore());
    const status = async (headers: Record<string, string>): Promise<number> => (await handle(k, { ...GET_ME, headers })).status;

    expect(await status({})).toBe(401); // no Authorization header
    expect(await status(bearer('not-a-three-part-token'))).toBe(401);
    expect(await status(bearer(mint({ sub: 'u-owner', tenant: A, expSecondsFromNow: -3600 })))).toBe(401);
    expect(await status(bearer(mint({ sub: 'u-owner', tenant: A, key: 'a-different-key-that-is-long-enough-000000' })))).toBe(401);
    expect(await status(bearer(mint({ sub: 'u-owner', tenant: A, alg: 'none' })))).toBe(401);
    expect(await status(bearer(mint({ sub: 'u-owner', tenant: A, iss: 'https://evil.example' })))).toBe(401);
  });

  it('is per-tenant: an owner in tenant A has no authority in tenant B (403)', async () => {
    const store = new InMemoryEventStore();
    await seedGenesisOwner(store, OWNER_ROLE_ID, A, 'u-owner', AT); // owner in A only
    const k = kernelFor(store, new MemoryIdempotencyStore());

    // Same user, but a token scoped to tenant B, where they hold nothing. The resolver reads B's
    // grants (none) → denied. Authority never leaks across the tenant boundary.
    const res = await handle(k, { ...GET_ME, headers: bearer(mint({ sub: 'u-owner', tenant: B })) });
    expect(res.status).toBe(403);
  });

  it('maker-checker: a self-approved grant is refused (422); a two-person grant succeeds (201)', async () => {
    const store = new InMemoryEventStore();
    await appendOwnerGrant(store, A, 'u-owner-1');
    await appendOwnerGrant(store, A, 'u-owner-2');
    const k = kernelFor(store, new MemoryIdempotencyStore());

    const selfApproved = await handle(k, {
      method: 'POST', path: '/v1/identity/grants',
      body: grantBody({ grantId: 'gs', userId: 'u-cash', requestedBy: 'u-owner-1', approvedBy: 'u-owner-1' }),
      headers: bearer(mint({ sub: 'u-owner-1', tenant: A }), { 'idempotency-key': 'k-self' }),
    });
    expect(selfApproved.status).toBe(422);

    const twoPerson = await handle(k, {
      method: 'POST', path: '/v1/identity/grants',
      body: grantBody({ grantId: 'gok', userId: 'u-cash', requestedBy: 'u-owner-1', approvedBy: 'u-owner-2' }),
      headers: bearer(mint({ sub: 'u-owner-1', tenant: A }), { 'idempotency-key': 'k-ok' }),
    });
    expect(twoPerson.status).toBe(201);
  });

  it('genesis is once-only: a second seed is refused and never grants the intruder', async () => {
    const store = new InMemoryEventStore();
    expect(await seedGenesisOwner(store, OWNER_ROLE_ID, A, 'u-owner', AT)).toBe('seeded');
    expect(await seedGenesisOwner(store, OWNER_ROLE_ID, A, 'u-intruder', AT)).toBe('already_bootstrapped');
    const k = kernelFor(store, new MemoryIdempotencyStore());

    const res = await handle(k, { ...GET_ME, headers: bearer(mint({ sub: 'u-intruder', tenant: A })) });
    expect(res.status).toBe(403);
  });
});

const DATABASE_URL = process.env['DATABASE_URL'];
const DB_TENANT = `c${Date.now().toString(16).slice(-7)}-cccc-4ccc-8ccc-${'c'.repeat(12)}`;

describe.skipIf(!DATABASE_URL)('authorization end-to-end: app → API → authorization → database (real PostgreSQL)', () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    const sql = pgClient(client);
    const dir = 'db/migrations';
    await runMigrations(sql, readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
  });
  afterAll(async () => { await client.end(); });

  it('an authorized write reaches the ledger; an unauthorized one does not', async () => {
    const store = new SqlEventStore(pgClient(client));
    await appendOwnerGrant(store, DB_TENANT, 'u-owner-1');
    await appendOwnerGrant(store, DB_TENANT, 'u-owner-2');
    const k = kernelFor(store, new SqlIdempotencyStore(pgClient(client)));

    const ok = await handle(k, {
      method: 'POST', path: '/v1/identity/grants',
      body: grantBody({ grantId: 'db-ok', userId: 'u-cash', requestedBy: 'u-owner-1', approvedBy: 'u-owner-2' }),
      headers: bearer(mint({ sub: 'u-owner-1', tenant: DB_TENANT }), { 'idempotency-key': 'k-db-ok' }),
    });
    expect(ok.status).toBe(201);

    // The cashier's grant is genuinely in the append-only ledger — read it back through the store.
    const grants = await store.readStream(DB_TENANT, STREAM.identity, { type: 'RoleGranted' });
    expect(grants.some((e) => (e.event.payload as { userId: string }).userId === 'u-cash')).toBe(true);

    // An unauthorized caller's write is refused and nothing new is written.
    const before = grants.length;
    const denied = await handle(k, {
      method: 'POST', path: '/v1/identity/grants',
      body: grantBody({ grantId: 'db-x', userId: 'u-y', requestedBy: 'u-cash', approvedBy: 'u-owner-2' }),
      headers: bearer(mint({ sub: 'u-cash', tenant: DB_TENANT }), { 'idempotency-key': 'k-db-x' }),
    });
    expect(denied.status).toBe(403);
    expect((await store.readStream(DB_TENANT, STREAM.identity, { type: 'RoleGranted' })).length).toBe(before);
  });
});
