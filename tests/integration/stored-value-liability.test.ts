import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { pgClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';

// M17-FR-03 → M23, API-06 — stored-value LIABILITY reconciliation + redemption-VELOCITY flag. Every
// unspent rupee on a gift card is money the shop OWES; the outstanding total folded tenant-wide from the
// movement ledger is reconciled EXACTLY against what the accounts posted, and a gap is named as
// unrecorded debt with its sign. And redemptions coming unusually fast on one instrument are flagged for
// a person (detect-only — blocks nothing). Both were tested engines (`reconcileLiability`, `flagVelocity`)
// that no cloud route called; this proves the wired reads over the real pipeline and real per-tenant RBAC.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const issue = (h: ApiHarness, tenant: string, id: string, over: Record<string, unknown> = {}) =>
  h.request({
    method: 'POST', path: '/v1/stored-value/instruments', userId: 'u-owner', tenantId: tenant,
    idempotencyKey: `iss-${id}`,
    body: { instrumentId: id, kind: 'gift_card', ownerRef: 'HH-1', faceValueMinor: 100_000, ...over },
  });

const redeem = (h: ApiHarness, tenant: string, id: string, movementId: string, amountMinor: number, channel = 'store') =>
  h.request({
    method: 'POST', path: `/v1/stored-value/instruments/${id}/redeem`, userId: 'u-owner', tenantId: tenant,
    idempotencyKey: `red-${movementId}`, body: { movementId, amountMinor, channel },
  });

const liability = (h: ApiHarness, tenant: string, userId: string, posted: string) =>
  h.request({ method: 'GET', path: '/v1/stored-value/liability', userId, tenantId: tenant, query: { posted } });

const velocity = (h: ApiHarness, tenant: string, userId: string, at?: string) =>
  h.request({ method: 'GET', path: '/v1/stored-value/velocity', userId, tenantId: tenant, ...(at === undefined ? {} : { query: { at } }) });

interface LiabRecon {
  outstandingMinor: number; issuedMinor: number; redeemedMinor: number; expiredMinor: number;
  postedLiabilityMinor: number; differenceMinor: number; reconciles: boolean; detail: string;
}
interface VelocityBody { flags: readonly { instrumentId: string; count: number; valueMinor: number; windowMinutes: number }[]; anyFound: boolean }

// Two instruments, one partly spent — outstanding is 120,000 (150,000 issued − 30,000 redeemed).
async function twoCards(h: ApiHarness, tenant: string) {
  await issue(h, tenant, 'GC-1', { faceValueMinor: 100_000 });
  await issue(h, tenant, 'SC-1', { kind: 'store_credit', faceValueMinor: 50_000 });
  await redeem(h, tenant, 'GC-1', 'r1', 30_000);
}

describe('stored-value liability reconciliation + velocity flag (M17-FR-03 / M23, API-06)', () => {
  it('reconciles when the posted liability equals the outstanding folded from movements', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await twoCards(h, A);

    const r = (await liability(h, A, 'u-owner', '120000')).body as LiabRecon;
    expect(r.issuedMinor).toBe(150_000);
    expect(r.redeemedMinor).toBe(30_000);
    expect(r.outstandingMinor).toBe(120_000);
    expect(r.differenceMinor).toBe(0);
    expect(r.reconciles).toBe(true);
  });

  it('names a signed difference as unrecorded debt when the books disagree with the movements', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await twoCards(h, A);

    // The accounts carry 125,000 but only 120,000 is owed to customers → a +5,000 gap.
    const r = (await liability(h, A, 'u-owner', '125000')).body as LiabRecon;
    expect(r.outstandingMinor).toBe(120_000);
    expect(r.differenceMinor).toBe(5_000);
    expect(r.reconciles).toBe(false);
    expect(r.detail).toContain('unrecorded debt');
  });

  it('refuses without a posted figure to compare against (a reconciliation reads, it never guesses)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await twoCards(h, A);
    expect((await liability(h, A, 'u-owner', '')).status).toBe(400);
    // A non-numeric posted figure is refused too, not silently coerced.
    expect((await h.request({ method: 'GET', path: '/v1/stored-value/liability', userId: 'u-owner', tenantId: A, query: { posted: 'lots' } })).status).toBe(400);
  });

  it('flags an instrument redeemed unusually many times, and nothing below the threshold', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await issue(h, A, 'GC-1', { faceValueMinor: 100_000 });
    // Five redemptions in the window (default threshold 5) → flagged. Well within the 100,000 balance.
    for (let n = 1; n <= 5; n++) await redeem(h, A, 'GC-1', `v${n}`, 10_000);

    const flagged = (await velocity(h, A, 'u-owner')).body as VelocityBody;
    expect(flagged.anyFound).toBe(true);
    expect(flagged.flags).toHaveLength(1);
    expect(flagged.flags[0]!.instrumentId).toBe('GC-1');
    expect(flagged.flags[0]!.count).toBe(5);

    // A second card redeemed only four times is NOT flagged — the flag stays specific.
    await issue(h, A, 'GC-2', { faceValueMinor: 100_000 });
    for (let n = 1; n <= 4; n++) await redeem(h, A, 'GC-2', `w${n}`, 10_000);
    const still = (await velocity(h, A, 'u-owner')).body as VelocityBody;
    expect(still.flags.map((f) => f.instrumentId)).toEqual(['GC-1']); // GC-2 (4 redemptions) not flagged
  });

  it('refuses a malformed ?at= rather than silently counting nothing (P-08)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await issue(h, A, 'GC-1', { faceValueMinor: 100_000 });
    expect((await velocity(h, A, 'u-owner', 'not-a-time')).status).toBe(400);
    expect((await velocity(h, A, 'u-owner', '2026-08-07T10:30:00.000Z')).status).toBe(200); // a valid one reads
  });

  it('gates BOTH oversight surfaces above the cashier balance read (P-04 least privilege)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-mgr', 'store_manager'); // lp.case.read
    await h.provisionRole(A, 'u-acct', 'accountant');   // lp.case.read
    await h.provisionRole(A, 'u-cash', 'cashier');       // loyalty.value.read only
    await twoCards(h, A);

    // The cashier can read a card's balance (loyalty.value.read)…
    expect((await h.request({ method: 'GET', path: '/v1/stored-value/instruments/GC-1', userId: 'u-cash', tenantId: A })).status).toBe(200);
    // …but neither the liability reconciliation nor the velocity flag — those are loss/books oversight.
    expect((await liability(h, A, 'u-cash', '120000')).status).toBe(403);
    expect((await velocity(h, A, 'u-cash')).status).toBe(403);
    // Owner, manager and accountant (lp.case.read) read both.
    for (const u of ['u-owner', 'u-mgr', 'u-acct']) {
      expect((await liability(h, A, u, '120000')).status).toBe(200);
      expect((await velocity(h, A, u)).status).toBe(200);
    }
  });

  it('keeps the fold tenant-scoped — one tenant\'s liability is not another\'s', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.seedOwner(B, 'u-owner');
    await twoCards(h, A);

    // Tenant B issued nothing → its outstanding folds to 0, and posted 0 reconciles (§35).
    const inB = (await liability(h, B, 'u-owner', '0')).body as LiabRecon;
    expect(inB.outstandingMinor).toBe(0);
    expect(inB.reconciles).toBe(true);
    // A's is unaffected.
    expect(((await liability(h, A, 'u-owner', '0')).body as LiabRecon).outstandingMinor).toBe(120_000);
  });
});

// The same flows end to end against real PostgreSQL — proving the tenant-wide movement fold, the signed
// reconciliation, the velocity flag and the RBAC gate hold on the actual database, not only in memory.
// Skips (never passes quietly) without DATABASE_URL; runs in the "Stage gate suites" CI job.
const DATABASE_URL = process.env['DATABASE_URL'];
const RUN = `r${Date.now().toString(36)}`;
const E2E_TENANT = `e${Date.now().toString(16).slice(-7)}-eeee-4eee-8eee-${'e'.repeat(12)}`;

describe.skipIf(!DATABASE_URL)('stored-value liability + velocity, end to end on real PostgreSQL (M17-FR-03 / M23, API-06)', () => {
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

  it('reconciles a signed liability gap, flags fast redemptions, and holds RBAC, on real PostgreSQL', async () => {
    const sql = pgClient(client);
    const h = apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) });
    await h.seedOwner(E2E_TENANT, 'u-owner');
    await h.provisionRole(E2E_TENANT, 'u-cash', 'cashier');

    const gc = `${RUN}-GC1`;
    await issue(h, E2E_TENANT, gc, { faceValueMinor: 100_000 });
    // Five redemptions of 10,000 → 50,000 spent, 50,000 outstanding, and five in the window.
    for (let n = 1; n <= 5; n++) await redeem(h, E2E_TENANT, gc, `${RUN}-v${n}`, 10_000);

    const under = (await liability(h, E2E_TENANT, 'u-owner', '40000')).body as LiabRecon;
    expect(under.outstandingMinor).toBe(50_000);
    expect(under.differenceMinor).toBe(-10_000); // books show 40,000, movements say 50,000 owed
    expect(under.reconciles).toBe(false);

    expect(((await liability(h, E2E_TENANT, 'u-owner', '50000')).body as LiabRecon).reconciles).toBe(true);

    const flagged = (await velocity(h, E2E_TENANT, 'u-owner')).body as VelocityBody;
    expect(flagged.anyFound).toBe(true);
    expect(flagged.flags[0]!.instrumentId).toBe(gc);
    expect(flagged.flags[0]!.count).toBe(5);

    // Least privilege holds against the real database too.
    expect((await liability(h, E2E_TENANT, 'u-cash', '50000')).status).toBe(403);
    expect((await velocity(h, E2E_TENANT, 'u-cash')).status).toBe(403);
  });
});
