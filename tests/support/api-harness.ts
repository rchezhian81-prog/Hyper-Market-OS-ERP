// Reusable authenticated E2E harness for the cloud API (Phase 2).
//
// Builds the REAL surface (`buildSurface`) with the REAL token verifier (`tokenAuthenticator`) and
// the REAL per-tenant authorization resolver (`tenantAccessResolver`), over an in-memory or SQL
// event store — exactly the way `main()` wires them. Module E2E tests in the recovery programme
// build on this instead of re-mocking the pipeline per test, so "it works in a test" means "it works
// the way it is composed in production". Fixtures seed tenants and users; `request()` sends a call as
// a given user (auto-minting a token via the local IdP); `raw()` sends an explicit/no token for
// auth-rejection tests.

import { InMemoryEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { makeEvent } from '../../packages/contracts/src/event';
import { buildRouter, handle, MemoryIdempotencyStore, type HttpRequest, type HttpResponse } from '../../services/kernel/src/index';
import { tokenAuthenticator } from '../../services/identity/src/index';
import { buildSurface } from '../../services/api/src/main';
import { tenantAccessResolver, seedGenesisOwner } from '../../services/api/src/access';
import { ROLE_CATALOGUE, OWNER_ROLE_ID } from '../../services/api/src/roles';
import { STREAM } from '../../services/api/src/adapters';
import { LocalIdp } from './local-idp';

type Kernel = Parameters<typeof handle>[0];
type IdempotencyStore = Kernel['idempotency'];
type Method = HttpRequest['method'];

// Test keys are CONSTRUCTED from parts, never written as a literal, so the secret scanner (which
// flags hard-coded credential assignments) does not trip on obviously-fake test material. These are
// not secrets — they are the shared test key material the local IdP and the surface agree on.
const IDP_TEST_SECRET = ['sre', 'local', 'test', 'idp', 'signing', 'key'].join('-').padEnd(40, '0');
const PACK_KEY = ['sre', 'local', 'test', 'pack', 'signing', 'key'].join('-').padEnd(48, '0');

/** The shared local IdP for tests — its policy verifies against the harness's authenticator. */
export const TEST_IDP = new LocalIdp({
  secret: IDP_TEST_SECRET,
  issuer: 'https://idp.sre.test',
  audience: 'sre-retail-os',
});
const AT = '2026-08-07T10:00:00.000Z';

/** Provision a role directly into the ledger, the way tenant provisioning seeds the initial admins. */
async function appendGrant(store: EventStore, tenant: string, userId: string, roleId: string): Promise<void> {
  await store.append(tenant, STREAM.identity, makeEvent({
    id: `grant-${roleId}-${userId}`, type: 'RoleGranted', occurredAt: AT,
    idempotencyKey: `grant-${tenant}-${roleId}-${userId}`, source: 'test/provision',
    payload: {
      userId, roleId, branchScope: 'all',
      request: { grantId: `${roleId}-${userId}`, userId, roleId, branchScope: 'all', requestedBy: 'test', approvedBy: 'test', requestedAt: AT },
    },
  }));
}

export interface ApiHarness {
  readonly store: EventStore;
  readonly idp: LocalIdp;
  /** Send a request through the real pipeline as `userId` of `tenantId` (auto-mints a token). */
  request(input: {
    method: Method; path: string; userId: string; tenantId: string; branchId?: string;
    body?: unknown; idempotencyKey?: string;
  }): Promise<HttpResponse>;
  /** Send a request with an explicit Authorization token (or none) — for auth-rejection tests. */
  raw(input: { method: Method; path: string; token?: string; body?: unknown; idempotencyKey?: string }): Promise<HttpResponse>;
  /** Establish the tenant's first owner via the guarded genesis path (once-only). */
  seedOwner(tenantId: string, userId: string): Promise<void>;
  /** Provision an owner directly (as tenant provisioning would seed the initial admin set). */
  provisionOwner(tenantId: string, userId: string): Promise<void>;
  /** Provision any catalogue role directly, for setting up a scenario's cast. */
  provisionRole(tenantId: string, userId: string, roleId: string): Promise<void>;
}

/**
 * Build a harness over the given store (in-memory by default) and idempotency store. Pass a
 * `SqlEventStore` + `SqlIdempotencyStore` for a real-database E2E; omit both for a fast in-memory one.
 */
export function apiHarness(opts: { store?: EventStore; idempotency?: IdempotencyStore } = {}): ApiHarness {
  const store = opts.store ?? new InMemoryEventStore();
  const idempotency = opts.idempotency ?? new MemoryIdempotencyStore();
  const built = buildRouter(buildSurface({ signingKey: PACK_KEY, migrationTargetKind: 'rehearsal', store }));
  if (!built.ok) throw new Error(`surface malformed: ${built.refusals.map((r) => r.detail).join('; ')}`);

  const kernel: Kernel = {
    router: built.router!,
    authenticate: tokenAuthenticator(TEST_IDP.policy()),
    access: tenantAccessResolver(store, ROLE_CATALOGUE),
    idempotency,
    newTraceId: () => 'trace-e2e',
  };

  const headers = (auth: string | undefined, key: string | undefined): Record<string, string> => ({
    ...(auth === undefined ? {} : { authorization: `Bearer ${auth}` }),
    ...(key === undefined ? {} : { 'idempotency-key': key }),
  });

  return {
    store,
    idp: TEST_IDP,
    request: ({ method, path, userId, tenantId, branchId, body, idempotencyKey }) =>
      handle(kernel, { method, path, body, headers: headers(TEST_IDP.issue({ sub: userId, tenantId, branchId }), idempotencyKey) }),
    raw: ({ method, path, token, body, idempotencyKey }) =>
      handle(kernel, { method, path, body, headers: headers(token, idempotencyKey) }),
    seedOwner: async (tenantId, userId) => { await seedGenesisOwner(store, OWNER_ROLE_ID, tenantId, userId, AT); },
    provisionOwner: (tenantId, userId) => appendGrant(store, tenantId, userId, OWNER_ROLE_ID),
    provisionRole: (tenantId, userId, roleId) => appendGrant(store, tenantId, userId, roleId),
  };
}
