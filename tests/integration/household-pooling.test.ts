import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { storedValueAdapter } from '../../services/api/src/adapters';
import { pgClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import type { ValueMovement } from '../../packages/loyalty/src/stored-value';

// M17-FR-04, API-06 — a household's gift cards and store credit are ONE purse (pooling), and a
// stored-value instrument spent across two channels while they were out of sync is a double-spend
// the cloud must SURFACE, not silently reverse (hard rule #10). Both were tested engines nothing fed
// on the cloud; this proves the wired routes over the real pipeline and real per-tenant RBAC.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const HH = 'HH-PATEL';
const AT = '2026-08-10T10:00:00.000Z';

const DATABASE_URL = process.env['DATABASE_URL'];
const RUN = `r${Date.now().toString(36)}`;
// A unique tenant per run — an append-only database keeps what earlier runs put in it (§35).
const E2E_TENANT = `c${Date.now().toString(16).slice(-7)}-cccc-4ccc-8ccc-${'c'.repeat(12)}`;

const issue = (h: ApiHarness, tenant: string, id: string, over: Record<string, unknown> = {}) =>
  h.request({
    method: 'POST', path: '/v1/stored-value/instruments', userId: 'u-owner', tenantId: tenant,
    idempotencyKey: `iss-${id}`,
    body: { instrumentId: id, kind: 'gift_card', ownerRef: HH, faceValueMinor: 100_000, ...over },
  });

const redeem = (h: ApiHarness, tenant: string, id: string, body: Record<string, unknown>) =>
  h.request({
    method: 'POST', path: `/v1/stored-value/instruments/${id}/redeem`, userId: 'u-owner', tenantId: tenant,
    idempotencyKey: `red-${String(body['movementId'])}`, body,
  });

const householdBalance = (h: ApiHarness, tenant: string, userId = 'u-owner', owner = HH) =>
  h.request({ method: 'GET', path: `/v1/stored-value/households/${owner}/balance`, userId, tenantId: tenant });

const householdDoubleSpends = (h: ApiHarness, tenant: string, userId = 'u-owner', owner = HH) =>
  h.request({ method: 'GET', path: `/v1/stored-value/households/${owner}/double-spends`, userId, tenantId: tenant });

/** Model a redemption committed on an offline lane and later SYNCED up — it bypasses the cloud's
 *  online balance guard exactly as a real synced movement does (the guard already ran on the lane). */
const syncOfflineRedemption = (h: ApiHarness, tenant: string, id: string, m: Partial<ValueMovement> & { movementId: string; deltaMinor: number; channel: ValueMovement['channel'] }) =>
  storedValueAdapter({ store: h.store, now: () => AT }).recordMovement(tenant, id, {
    instrumentId: id, kind: 'redeem', at: AT, capturedOffline: true, ...m,
  });

interface HouseholdBal { readonly balanceMinor: number; readonly instrumentIds: readonly string[]; readonly instrumentCount: number }
interface DoubleSpends { readonly doubleSpends: readonly { instrumentId: string; overspentMinor: number; channels: readonly string[]; movements: readonly unknown[] }[]; readonly anyFound: boolean }

describe('stored-value household pooling + cross-channel double-spend (M17-FR-04, API-06)', () => {
  it('pools one balance across every instrument the household holds', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await issue(h, A, 'GC-1', { faceValueMinor: 100_000 });                       // gift card
    await issue(h, A, 'SC-1', { kind: 'store_credit', faceValueMinor: 50_000 });  // store credit, same owner
    await redeem(h, A, 'GC-1', { movementId: 'r1', amountMinor: 30_000, channel: 'store' });

    const body = (await householdBalance(h, A)).body as HouseholdBal;
    expect(body.balanceMinor).toBe(120_000); // (100,000 − 30,000) + 50,000
    expect(body.instrumentCount).toBe(2);
    expect(body.instrumentIds).toEqual(['GC-1', 'SC-1']);
  });

  it('surfaces a cross-channel double-spend with BOTH movements and both channels named', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await issue(h, A, 'GC-1', { faceValueMinor: 100_000 });

    // Two lanes, offline, each saw the full ₹1,000 and each took ₹800 — legitimate against what each
    // could see, an overdraw once both synced. The cloud never ran a shared guard over them.
    await syncOfflineRedemption(h, A, 'GC-1', { movementId: 'off-store', deltaMinor: -80_000, channel: 'store' });
    await syncOfflineRedemption(h, A, 'GC-1', { movementId: 'off-app', deltaMinor: -80_000, channel: 'app' });

    const body = (await householdDoubleSpends(h, A)).body as DoubleSpends;
    expect(body.anyFound).toBe(true);
    expect(body.doubleSpends).toHaveLength(1);
    const ds = body.doubleSpends[0]!;
    expect(ds.instrumentId).toBe('GC-1');
    expect(ds.overspentMinor).toBe(60_000);           // 100,000 − 160,000 = −60,000
    expect(ds.channels).toEqual(['app', 'store']);     // both, sorted — never one silently discarded
    expect(ds.movements).toHaveLength(2);              // both redemptions kept (hard rule #10)
  });

  it('reports no double-spend for a household within its balance', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await issue(h, A, 'GC-1', { faceValueMinor: 100_000 });
    await redeem(h, A, 'GC-1', { movementId: 'r1', amountMinor: 40_000, channel: 'store' });

    const body = (await householdDoubleSpends(h, A)).body as DoubleSpends;
    expect(body.anyFound).toBe(false);
    expect(body.doubleSpends).toEqual([]);
  });

  it('keeps households tenant-scoped — one tenant cannot read another tenant\'s pool', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.seedOwner(B, 'u-owner');
    await issue(h, A, 'GC-1', { faceValueMinor: 100_000 });

    const inB = (await householdBalance(h, B)).body as HouseholdBal;
    expect(inB.instrumentCount).toBe(0); // the Patel household exists only in tenant A (§35)
    expect(inB.balanceMinor).toBe(0);
  });

  it('gates the double-spend loss surface above the pooled balance (P-04 least privilege)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');
    await issue(h, A, 'GC-1', { faceValueMinor: 100_000 });

    // A cashier serves a customer's pooled balance (loyalty.value.read the cashier holds)…
    expect((await householdBalance(h, A, 'u-cash')).status).toBe(200);
    // …but the double-spend report names money the shop gave away twice — loss data, gated on
    // lp.case.read, which a cashier does not hold. Least privilege, before the fold even runs.
    expect((await householdDoubleSpends(h, A, 'u-cash')).status).toBe(403);
    // The owner (lp.case.read) reads it.
    expect((await householdDoubleSpends(h, A, 'u-owner')).status).toBe(200);
  });
});

// The same flow, end to end against real PostgreSQL — proving the pooled fold, the synced
// double-spend and the RBAC gate hold on the actual database, not only the in-memory reference.
// Skips (never passes quietly) without DATABASE_URL; runs in the "Stage gate suites" CI job.
describe.skipIf(!DATABASE_URL)('stored-value household pooling, end to end on real PostgreSQL (M17-FR-04, API-06)', () => {
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

  it('pools a balance and surfaces a cross-channel double-spend, with RBAC, on real PostgreSQL', async () => {
    const sql = pgClient(client);
    const h = apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) });
    await h.seedOwner(E2E_TENANT, 'u-owner');
    await h.provisionRole(E2E_TENANT, 'u-cash', 'cashier');

    await issue(h, E2E_TENANT, `${RUN}-GC1`, { faceValueMinor: 100_000 });
    await issue(h, E2E_TENANT, `${RUN}-SC1`, { kind: 'store_credit', faceValueMinor: 50_000 });
    // Redeem the store credit (not the gift card) so GC1 stays clean for the double-spend below.
    await redeem(h, E2E_TENANT, `${RUN}-SC1`, { movementId: `${RUN}-r1`, amountMinor: 30_000, channel: 'store' });

    const bal = (await householdBalance(h, E2E_TENANT)).body as HouseholdBal;
    expect(bal.balanceMinor).toBe(120_000);
    expect(bal.instrumentCount).toBe(2);

    // Two offline lanes each took ₹800 against the ₹1,000 they could see; synced, it is a −₹600 overdraw.
    await syncOfflineRedemption(h, E2E_TENANT, `${RUN}-GC1`, { movementId: `${RUN}-off-store`, deltaMinor: -80_000, channel: 'store' });
    await syncOfflineRedemption(h, E2E_TENANT, `${RUN}-GC1`, { movementId: `${RUN}-off-app`, deltaMinor: -80_000, channel: 'app' });

    const ds = (await householdDoubleSpends(h, E2E_TENANT)).body as DoubleSpends;
    expect(ds.anyFound).toBe(true);
    expect(ds.doubleSpends[0]!.channels).toEqual(['app', 'store']);
    expect(ds.doubleSpends[0]!.movements).toHaveLength(2); // both kept — hard rule #10

    // Least privilege holds against the real database too: a cashier is refused the loss surface.
    expect((await householdDoubleSpends(h, E2E_TENANT, 'u-cash')).status).toBe(403);
  });
});
