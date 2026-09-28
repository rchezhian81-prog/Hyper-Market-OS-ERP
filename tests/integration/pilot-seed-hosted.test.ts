// Pilot seed — HOSTED client (demo-pilot stand-up, runbook §8). Proves the client the hosted demo box
// seeds with drives the REAL surface over a REAL socket: every applier lands, through real token
// verification, RBAC, entitlements and idempotency; the identity hooks record the operator; and it
// refuses anything but the synthetic demo tenant.

import { describe, it, expect, afterAll } from 'vitest';
import { InMemoryEventStore } from '../../packages/persistence/src/event-store';
import { buildRouter, startHttpServer, MemoryIdempotencyStore, type RunningServer } from '../../services/kernel/src/index';
import { tokenAuthenticator } from '../../services/identity/src/index';
import { buildSurface } from '../../services/api/src/main';
import { tenantAccessResolver, tenantEntitlementResolver } from '../../services/api/src/access';
import { ROLE_CATALOGUE } from '../../services/api/src/roles';
import { STREAM } from '../../services/api/src/adapters';
import { hostedSeedClient, hostedSeedRefusals } from '../../db/seed/pilot/hosted';
import {
  applyPilotFoundation, applyPilotCatalogue, applyPilotTradingPartners, applyPilotTransactions,
} from '../../db/seed/pilot/apply';
import {
  PILOT_FOUNDATION, PILOT_CATALOGUE, PILOT_TRADING_PARTNERS, PILOT_TRANSACTIONS, PILOT_DEMO_TENANT,
  PILOT_DEMO_SUPPLIER_LOGIN,
} from '../../db/seed/pilot/dataset';

// Constructed, never a literal, so the secret scanner does not trip on obviously-fake test material.
const IDP = {
  secret: ['hosted', 'seed', 'test', 'idp', 'key'].join('-').padEnd(48, '0'),
  issuer: 'https://pilot-idp.test',
  audience: 'sre-retail-os-api',
};
const PACK_KEY = ['hosted', 'seed', 'test', 'pack', 'key'].join('-').padEnd(48, '0');
const OWNER = PILOT_FOUNDATION.genesisOwner.userId;

const running: RunningServer[] = [];
afterAll(async () => { for (const s of running) await s.stop(); });

/** The production surface on a real port, composed as main() composes it (auth, RBAC, entitlements). */
async function liveApi(): Promise<{ store: InMemoryEventStore; baseUrl: string }> {
  const store = new InMemoryEventStore();
  const built = buildRouter(buildSurface({ signingKey: PACK_KEY, migrationTargetKind: 'rehearsal', store }));
  if (!built.ok) throw new Error(built.refusals.map((r) => r.detail).join('; '));
  const s = startHttpServer({
    router: built.router!,
    authenticate: tokenAuthenticator(IDP),
    access: tenantAccessResolver(store, ROLE_CATALOGUE),
    entitlements: tenantEntitlementResolver(store),
    idempotency: new MemoryIdempotencyStore(),
    newTraceId: () => 'trace-hosted-seed',
    port: 0,
    dependenciesReachable: () => true,
  });
  running.push(s);
  if (!s.server.listening) await new Promise<void>((r) => s.server.once('listening', () => r()));
  const { port } = s.server.address() as { port: number };
  return { store, baseUrl: `http://127.0.0.1:${port}` };
}

const failed = (r: { steps: readonly { ok: boolean }[] }) => r.steps.filter((s) => !s.ok);

describe('hosted pilot seed — over a real socket', () => {
  it('lays down the whole synthetic dataset through the live API, and re-running is idempotent', async () => {
    const { store, baseUrl } = await liveApi();
    const client = hostedSeedClient({ baseUrl, idp: IDP, store, operator: 'test-operator', tenantId: PILOT_DEMO_TENANT });

    for (let run = 0; run < 2; run += 1) {
      const foundation = await applyPilotFoundation(client, PILOT_FOUNDATION);
      expect(failed(foundation), JSON.stringify(failed(foundation))).toEqual([]);
      const catalogue = await applyPilotCatalogue(client, PILOT_CATALOGUE, OWNER);
      expect(failed(catalogue), JSON.stringify(failed(catalogue))).toEqual([]);
      const partners = await applyPilotTradingPartners(client, PILOT_TRADING_PARTNERS, OWNER);
      expect(failed(partners), JSON.stringify(failed(partners))).toEqual([]);
      const tx = await applyPilotTransactions(client, PILOT_TRANSACTIONS, OWNER);
      expect(failed(tx), JSON.stringify(failed(tx))).toEqual([]);
    }

    // Each provisioned login landed ONCE, despite two runs, and names the person who ran the seed.
    const grants = await store.readStream(PILOT_DEMO_TENANT, STREAM.identity, { type: 'RoleGranted' });
    const provisioned = grants.filter((g) => g.event.source === 'pilot/seed');
    // The foundation's role logins plus the supplier-portal login the trading-partner step adds.
    expect(provisioned).toHaveLength(PILOT_FOUNDATION.users.length + 1);
    expect(provisioned.map((g) => (g.event.payload as { userId: string }).userId)).toContain(PILOT_DEMO_SUPPLIER_LOGIN);
    for (const g of provisioned) {
      const req = (g.event.payload as { request: { requestedBy: string; approvedBy: string } }).request;
      expect(req.requestedBy).toBe('pilot-seed:test-operator');
      expect(req.approvedBy).toBe('pilot-seed:test-operator');
    }
    expect(grants.filter((g) => g.event.source === 'system/genesis')).toHaveLength(1);
  }, 60_000);

  it('the seeded logins really authenticate through the live API with their role permissions', async () => {
    const { store, baseUrl } = await liveApi();
    const client = hostedSeedClient({ baseUrl, idp: IDP, store, operator: 'test-operator', tenantId: PILOT_DEMO_TENANT });
    await applyPilotFoundation(client, PILOT_FOUNDATION, { throwOnError: true });
    const me = await client.request({ method: 'GET', path: '/v1/identity/me', userId: 'pilot-cashier', tenantId: PILOT_DEMO_TENANT });
    expect(me.status).toBe(200);
    expect((me.body as { permissions: string[] }).permissions).toContain('pos.sale.read');
  });

  it('a client holding the WRONG key is refused by the live API — the seed fails loudly, not silently', async () => {
    const { store, baseUrl } = await liveApi();
    const wrong = hostedSeedClient({
      baseUrl, idp: { ...IDP, secret: 'x'.repeat(48) }, store, operator: 'test-operator', tenantId: PILOT_DEMO_TENANT,
    });
    const report = await applyPilotFoundation(wrong, PILOT_FOUNDATION);
    expect(report.ok).toBe(false);
    expect(report.steps.some((s) => s.status === 401)).toBe(true);
  });
});

describe('hosted pilot seed — refusals', () => {
  const base = { baseUrl: 'http://127.0.0.1:1', idp: IDP, store: new InMemoryEventStore() };

  it('refuses any tenant but the synthetic demo tenant', () => {
    expect(() => hostedSeedClient({ ...base, operator: 'op', tenantId: 'sre-hyper-market' })).toThrow(/not the synthetic demo tenant/);
  });

  it('refuses a production-marked environment and an anonymous operator', () => {
    expect(hostedSeedRefusals({ tenantId: PILOT_DEMO_TENANT, operator: 'op', migrationTargetKind: 'production' }))
      .toEqual([expect.stringMatching(/production/)]);
    expect(hostedSeedRefusals({ tenantId: PILOT_DEMO_TENANT, operator: '  ' })).toEqual([expect.stringMatching(/no operator/)]);
    expect(hostedSeedRefusals({ tenantId: PILOT_DEMO_TENANT, operator: 'op', migrationTargetKind: 'rehearsal' })).toEqual([]);
  });

  it('refuses a call that strays outside the seeded tenant', async () => {
    const client = hostedSeedClient({ ...base, operator: 'op', tenantId: PILOT_DEMO_TENANT });
    await expect(client.request({ method: 'GET', path: '/v1/identity/me', userId: 'u', tenantId: 'other' })).rejects.toThrow(/outside/);
    await expect(client.provisionRole('other', 'u', 'owner')).rejects.toThrow(/outside/);
  });
});

describe('hosted pilot seed — rate limit', () => {
  const reply = (status: number, retryAfter?: string) => ({
    status,
    headers: { get: (n: string) => (n.toLowerCase() === 'retry-after' ? retryAfter ?? null : null) },
    text: async () => '{}',
  });

  it('waits out a 429 (honouring Retry-After) and then succeeds', async () => {
    const statuses = [429, 429, 200];
    const waits: number[] = [];
    const client = hostedSeedClient({
      baseUrl: 'http://api', idp: IDP, store: new InMemoryEventStore(), operator: 'op', tenantId: PILOT_DEMO_TENANT,
      fetch: async () => reply(statuses.shift()!, '2'),
      sleep: async (ms) => { waits.push(ms); },
    });
    const res = await client.request({ method: 'GET', path: '/v1/identity/me', userId: 'u', tenantId: PILOT_DEMO_TENANT });
    expect(res.status).toBe(200);
    expect(waits).toEqual([2000, 2000]);
  });

  it('gives up after the retry budget and reports the 429 (no silent success)', async () => {
    const client = hostedSeedClient({
      baseUrl: 'http://api', idp: IDP, store: new InMemoryEventStore(), operator: 'op', tenantId: PILOT_DEMO_TENANT,
      fetch: async () => reply(429), sleep: async () => {}, maxRateLimitRetries: 2,
    });
    const res = await client.request({ method: 'GET', path: '/v1/identity/me', userId: 'u', tenantId: PILOT_DEMO_TENANT });
    expect(res.status).toBe(429);
  });
});

// ── The regression that reached the demo box ─────────────────────────────────
// The ledger's tenant_id is `uuid` (ADR-0003). The demo tenant was once 'pilot-demo', which the
// in-memory store accepted and a real PostgreSQL refused on the very first write. So: the id must be a
// UUID (always checked), and the whole hosted seed is proven against a REAL PostgreSQL when one is set.

describe('the demo tenant id fits the real ledger', () => {
  it('is a UUID — the shape the tenant_id column enforces', () => {
    expect(PILOT_DEMO_TENANT).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

const REAL_DATABASE_URL = process.env['DATABASE_URL'];

describe.skipIf(!REAL_DATABASE_URL)('hosted pilot seed — REAL PostgreSQL ledger', () => {
  it('lays down the whole synthetic dataset into a real ledger, idempotently', async () => {
    const pg = await import('pg');
    const { SqlEventStore } = await import('../../packages/persistence/src/event-store');
    const { pgPoolClient } = await import('../../packages/persistence/src/pg-client');
    const pool = new pg.default.Pool({ connectionString: REAL_DATABASE_URL, max: 4 });
    try {
      const store = new SqlEventStore(pgPoolClient(pool));
      const built = buildRouter(buildSurface({ signingKey: PACK_KEY, migrationTargetKind: 'rehearsal', store }));
      if (!built.ok) throw new Error(built.refusals.map((r) => r.detail).join('; '));
      const s = startHttpServer({
        router: built.router!, authenticate: tokenAuthenticator(IDP),
        access: tenantAccessResolver(store, ROLE_CATALOGUE), entitlements: tenantEntitlementResolver(store),
        idempotency: new MemoryIdempotencyStore(), newTraceId: () => 'trace-hosted-seed-pg', port: 0,
        dependenciesReachable: () => true,
      });
      running.push(s);
      if (!s.server.listening) await new Promise<void>((r) => s.server.once('listening', () => r()));
      const baseUrl = `http://127.0.0.1:${(s.server.address() as { port: number }).port}`;
      const client = hostedSeedClient({ baseUrl, idp: IDP, store, operator: 'pg-test-operator', tenantId: PILOT_DEMO_TENANT });

      for (let run = 0; run < 2; run += 1) {
        for (const report of [
          await applyPilotFoundation(client, PILOT_FOUNDATION),
          await applyPilotCatalogue(client, PILOT_CATALOGUE, OWNER),
          await applyPilotTradingPartners(client, PILOT_TRADING_PARTNERS, OWNER),
          await applyPilotTransactions(client, PILOT_TRANSACTIONS, OWNER),
        ]) expect(failed(report), JSON.stringify(failed(report))).toEqual([]);
      }
      const grants = await store.readStream(PILOT_DEMO_TENANT, STREAM.identity, { type: 'RoleGranted' });
      expect(grants.filter((g) => g.event.source === 'pilot/seed')).toHaveLength(PILOT_FOUNDATION.users.length + 1);
    } finally {
      await pool.end();
    }
  }, 180_000);
});
