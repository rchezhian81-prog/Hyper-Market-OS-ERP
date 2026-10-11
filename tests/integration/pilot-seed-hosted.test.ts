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
import { STREAM, effectiveGrants } from '../../services/api/src/adapters';
import { hostedSeedClient, hostedSeedRefusals, publishPilotPack } from '../../db/seed/pilot/hosted';
import { packPayloadOf } from '../../edge/store-edge/src/store-pack-held';
import type { StorePackEnvelope } from '../../services/platform/src/store-packs';
import { readPack } from '../../edge/store-edge/src/store-pack';
import { posPayload, type ScreenInput } from '../../edge/store-edge/src/screen-data';
import {
  applyPilotFoundation, applyPilotCatalogue, applyPilotTradingPartners, applyPilotTransactions,
} from '../../db/seed/pilot/apply';
import { PILOT_FOUNDATION, PILOT_CATALOGUE, PILOT_TRADING_PARTNERS, PILOT_TRANSACTIONS, PILOT_DEMO_TENANT, PILOT_DEMO_SUPPLIER_LOGIN, PILOT_DEMO_BRANCH } from '../../db/seed/pilot/dataset';

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
    // OB-42: the owner's marketing cap is in force for the demo shop — set through the owner's route, once, by the seed.
    const cap = await client.request({ method: 'GET', path: '/v1/service/campaigns/frequency-policy', userId: OWNER, tenantId: PILOT_DEMO_TENANT });
    expect((cap.body as { policy: Record<string, unknown> }).policy).toMatchObject({ capPerWindow: 2, windowDays: 7, setBy: OWNER });
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

describe('demo price list for the demo store box (ADR-0016)', () => {
  it('after the seed, publishing the demo branch pack lands through the real route and carries the demo products', async () => {
    const { store, baseUrl } = await liveApi();
    const client = hostedSeedClient({ baseUrl, idp: IDP, store, operator: 'test-operator', tenantId: PILOT_DEMO_TENANT });
    await applyPilotFoundation(client, PILOT_FOUNDATION, { throwOnError: true });
    await applyPilotCatalogue(client, PILOT_CATALOGUE, OWNER, { throwOnError: true });

    const res = await publishPilotPack(client, OWNER, PILOT_DEMO_BRANCH, '2026-09-28');
    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);

    // What the demo store box pulls: the signed pack, with the seeded products in it.
    const pack = await client.request({ method: 'GET', path: '/v1/catalogue/pack', userId: 'pilot-store-edge', tenantId: PILOT_DEMO_TENANT });
    expect(pack.status).toBe(200);
    expect(JSON.stringify(pack.body)).toContain('prod-soap');

    // Same day, same store: the idempotency key makes a second run the same publish, not a new one.
    const again = await publishPilotPack(client, OWNER, PILOT_DEMO_BRANCH, '2026-09-28');
    expect([200, 201]).toContain(again.status);
  }, 60_000);

  it('PA-06 3b: the demo store computer takes its setup from HEAD OFFICE — the published list feeds the till; the rest is head office\'s record', async () => {
    const { store, baseUrl } = await liveApi();
    const client = hostedSeedClient({ baseUrl, idp: IDP, store, operator: 'test-operator', tenantId: PILOT_DEMO_TENANT });
    await applyPilotFoundation(client, PILOT_FOUNDATION, { throwOnError: true });
    await applyPilotCatalogue(client, PILOT_CATALOGUE, OWNER, { throwOnError: true });
    await applyPilotTradingPartners(client, PILOT_TRADING_PARTNERS, OWNER, { throwOnError: true });
    expect([200, 201]).toContain((await publishPilotPack(client, OWNER, PILOT_DEMO_BRANCH, '2026-09-28')).status);

    // Exactly what the demo store computer asks for, under its own identity (EDGE_STORE_PACK_SOURCE=head-office).
    const res = await client.request({ method: 'GET', path: `/v1/store-packs/${PILOT_DEMO_BRANCH}`, userId: 'pilot-store-edge', tenantId: PILOT_DEMO_TENANT });
    expect(res.status).toBe(200);
    const env = res.body as StorePackEnvelope;
    expect(env).toMatchObject({ tenantId: PILOT_DEMO_TENANT, storeId: PILOT_DEMO_BRANCH });

    // Through the EDGE's own reader and till payload — exactly what the demo box does once it has pulled it.
    const edgePack = readPack(packPayloadOf(env), env.issuedAt);
    expect(edgePack.products.known).toBe(true);
    const till = posPayload({ pack: edgePack } as unknown as ScreenInput);
    expect(till).not.toBeNull();
    const products = (till as { products: Array<{ productId: string; unitPriceMinor: number }> }).products;
    const byId = new Map(products.map((p) => [p.productId, p.unitPriceMinor] as const));
    for (const p of PILOT_CATALOGUE.products) expect(byId.get(p.productId)).toBe(p.price.priceMinor);

    // Honest gaps: no cost (the published pack carries none). Every other section the box reads back is head office's:
    // the approvals waiting (known, even when none wait), the orders, the people from the role catalogue, the store's
    // rules and checklist, the loss-prevention limits, and the warehouse phone's bins and open deliveries. Nobody is
    // named on a screen: each runs as the person who signs in (OB-16, OB-30).
    const sections = env.sections as { products: Record<string, unknown>[] };
    for (const p of sections.products) expect(p).not.toHaveProperty('unitCostMinor');
    expect(edgePack.approvals.known && edgePack.purchaseOrders.known && edgePack.roles.known && edgePack.roleAssignments.known).toBe(true);
    expect(edgePack.managerPolicy.known && edgePack.managerPolicy.value.userId).toBeFalsy();
    expect(edgePack.warehouse.known && edgePack.checklist.known && edgePack.lossPreventionRules.known).toBe(true);
    expect(edgePack.lossPreventionRules.known && edgePack.lossPreventionRules.value.length).toBe(PILOT_FOUNDATION.storeSetup.lossPreventionRules.length);
    // Categories come from the product master, not a guess; stock from the ledger (the seeded receipt).
    expect(sections.products.every((p) => p['categoryId'] !== 'uncategorised')).toBe(true);
    expect(sections.products.some((p) => Number(p['availableMinor']) > 0)).toBe(true);
  }, 60_000);

  it('the store box machine login cannot publish prices (it may only read the pack)', async () => {
    const { store, baseUrl } = await liveApi();
    const client = hostedSeedClient({ baseUrl, idp: IDP, store, operator: 'test-operator', tenantId: PILOT_DEMO_TENANT });
    await applyPilotFoundation(client, PILOT_FOUNDATION, { throwOnError: true });
    const res = await publishPilotPack(client, 'pilot-store-edge', PILOT_DEMO_BRANCH, '2026-09-28');
    expect(res.status).toBe(403);
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
    const { SqlIdempotencyStore } = await import('../../services/kernel/src/idempotency-store');
    const pool = new pg.default.Pool({ connectionString: REAL_DATABASE_URL, max: 4 });
    try {
      const store = new SqlEventStore(pgPoolClient(pool));
      const built = buildRouter(buildSurface({ signingKey: PACK_KEY, migrationTargetKind: 'rehearsal', store }));
      if (!built.ok) throw new Error(built.refusals.map((r) => r.detail).join('; '));
      const s = startHttpServer({
        router: built.router!, authenticate: tokenAuthenticator(IDP),
        access: tenantAccessResolver(store, ROLE_CATALOGUE), entitlements: tenantEntitlementResolver(store),
        // The ledger's own idempotency table, as on the box: a re-run against the SAME ledger — a second process, days
        // later — replays the first run's answers instead of reaching routes that rightly refuse a second GST registration.
        idempotency: new SqlIdempotencyStore(pgPoolClient(pool)), newTraceId: () => 'trace-hosted-seed-pg', port: 0,
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
      // Every seeded person holds exactly their dataset role (+ the genesis owner) — counted on the EFFECTIVE grants
      // (grants minus revocations), so a ledger seeded before OB-36 (box once a cashier) agrees too.
      const effective = (await effectiveGrants(store, PILOT_DEMO_TENANT)).filter((g) => [PILOT_FOUNDATION.genesisOwner, ...PILOT_FOUNDATION.users].some((u) => u.userId === g.userId));
      const expectedRoles = [PILOT_FOUNDATION.genesisOwner, ...PILOT_FOUNDATION.users].map((u) => `${u.userId}:${u.role}`).sort();
      expect([...new Set(effective.map((g) => `${g.userId}:${g.roleId}`))].sort()).toEqual(expectedRoles);
    } finally {
      await pool.end();
    }
  }, 180_000);
});
