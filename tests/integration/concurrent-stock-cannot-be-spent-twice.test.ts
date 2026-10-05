import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { InMemoryEventStore, SqlEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { auditTrailAdapter } from '../../services/api/src/adapters';
import { AuditTrail, InMemoryAuditStore } from '../../packages/audit/src/index';

/**
 * **SF-04 · FUL-02 · PA-11 — the same write guard on stock, on promises and on the audit chain (Wave 2a-ii · M08-FR-02 ·
 * M08-FR-03 · M09-FR-03 · M18-FR-02 · M20-FR-02 · M34-FR-01 · SEC-07 · hard rule #10 · P-08).**
 *
 * The audit's harness dispatched two transfers of 70 against 100 and both returned 200 (source −40, two in transit);
 * promised the last unit to two orders, and "4 + 4" of one product as 8 promised with 4 held; and forked the audit
 * chain under two adapter instances. Each is now a compare-and-append under a key — the source location's stock, the
 * location's promises, the tenant's chain. The first half drives the real API surface over the in-memory store; the
 * second half runs the SAME scenarios on real PostgreSQL through the transactional pool client (the wiring main.ts
 * uses) — the audit asked for the last-unit race on the database. Without DATABASE_URL that half skips, never passes.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const LINE = (qty: number) => ({ productId: 'P1', batchId: null, quantityMinor: qty, uom: 'EA', unitCost: { minor: 5_000, currency: 'INR' } });
interface Promised { outcome: string; lines: { productId: string; requestedMinor: number; promisedMinor: number; outcome: string }[] }
interface Availability { rows: { productId: string; locationId: string; onHandMinor: number }[]; inTransit: { transferId: string }[] }

// ── SF-04: a warehouse with one product at WH, two branches to send it to ────────────────────────────────────
function stockLab(h: ApiHarness, t: string) {
  const req = (method: 'POST' | 'GET', path: string, userId: string, idempotencyKey?: string, body?: Record<string, unknown>) =>
    h.request({ method, path, userId, tenantId: t, ...(idempotencyKey === undefined ? {} : { idempotencyKey }), ...(body === undefined ? {} : { body }) });
  return {
    seed: async (qty: number) => {
      await h.seedOwner(t, 'u-owner');
      await h.provisionRole(t, 'u-boss', 'store_manager');
      const node = (id: string, body: Record<string, unknown>) => req('POST', `/v1/org/nodes/${id}`, 'u-owner', `org-${id}`, body);
      await node('C1', { kind: 'company', name: 'SRE Retail' });
      await node('WH', { kind: 'warehouse', name: 'Central warehouse', parentId: 'C1', companyId: 'C1' });
      await node('S1', { kind: 'branch', name: 'Store 1', parentId: 'C1', companyId: 'C1' });
      await node('S2', { kind: 'branch', name: 'Store 2', parentId: 'C1', companyId: 'C1' });
      await req('POST', '/v1/inventory/movements', 'u-owner', 'seed', { movementId: 'seed', productId: 'P1', locationId: 'WH', kind: 'received', quantityMinor: qty, uom: 'EA', occurredAt: '2026-08-01T00:00:00.000Z', enteredBy: 'u-owner' });
    },
    propose: (id: string, to: string, qty: number) => req('POST', `/v1/warehouse/transfers/${id}`, 'u-owner', `tr-${id}`, { fromLocationId: 'WH', toLocationId: to, lines: [LINE(qty)] }),
    dispatch: (id: string, key = `td-${id}`) => req('POST', `/v1/warehouse/transfers/${id}/dispatch`, 'u-boss', key, {}),
    availability: async () => (await req('GET', '/v1/inventory/availability', 'u-owner')).body as Availability,
  };
}

// ── FUL-02: a shelf with one product at L1 ───────────────────────────────────────────────────────────────────
function orderLab(h: ApiHarness, t: string) {
  return {
    seed: async (product: string, qty: number) => {
      await h.seedOwner(t, 'u-owner');
      await h.request({ method: 'POST', path: '/v1/inventory/movements', userId: 'u-owner', tenantId: t, idempotencyKey: `mv-${product}`, body: { movementId: `mv-${product}`, productId: product, locationId: 'L1', kind: 'received', quantityMinor: qty, uom: 'EA', occurredAt: '2026-08-01T00:00:00.000Z', enteredBy: 'u-owner' } });
    },
    promise: (orderId: string, lines: { productId: string; quantityMinor: number }[]) =>
      h.request({ method: 'POST', path: `/v1/orders/${orderId}/promise`, userId: 'u-owner', tenantId: t, idempotencyKey: `p-${orderId}`, body: { lines, locationId: 'L1' } }),
    reservations: async (orderId: string) =>
      ((await h.request({ method: 'GET', path: `/v1/orders/${orderId}`, userId: 'u-owner', tenantId: t })).body as { reservations: { productId: string; quantityMinor: number }[] }).reservations,
  };
}

// ── PA-11: the audit chain under two adapter instances over ONE store ────────────────────────────────────────
const auditEntry = (n: number, t: string) => ({
  actorId: 'u-owner', action: 'price.change', objectType: 'price' as const, objectId: `P-${n}`, at: `2026-10-05T10:00:${String(n).padStart(2, '0')}.000Z`,
  origin: { tenantId: t, branchId: 'b1' }, before: { priceMinor: '100' }, after: { priceMinor: String(100 + n) }, correlationId: `c-${n}`,
});
async function chainVerdict(store: EventStore, t: string) {
  const records = await auditTrailAdapter({ store }).records(t);
  const seed = new InMemoryAuditStore();
  for (const r of records) seed.append(r);
  return { records, verdict: new AuditTrail(seed).verify() };
}

// ── The scenarios, written once, run on both stores ──────────────────────────────────────────────────────────
/** The loser's acceptable answers. In memory both dispatches read the stock before either appends, so the loser is always
 *  the guard's 409. On the database the first transaction may COMMIT before the second reads the stock, and then the
 *  second is refused on the true figure (70 against 30 — a plain 422). Either way the stock leaves once. */
type LoserAnswers = readonly { status: number; code: string }[];
const ONLY_THE_GUARD: LoserAnswers = [{ status: 409, code: 'concurrent_change' }];
const GUARD_OR_TRUE_FIGURE: LoserAnswers = [...ONLY_THE_GUARD, { status: 422, code: 'transfer_refused' }];

async function twoTransfersOfTheSameStock(h: ApiHarness, t: string, loserAnswers: LoserAnswers): Promise<void> {
  const lab = stockLab(h, t);
  await lab.seed(100);
  expect((await lab.propose('t1', 'S1', 70)).status).toBe(201);
  expect((await lab.propose('t2', 'S2', 70)).status).toBe(201);
  const [a, b] = await Promise.all([lab.dispatch('t1'), lab.dispatch('t2')]);
  const [won, lost] = a.status === 200 ? [a, b] : [b, a];
  expect(won.status).toBe(200);
  expect(loserAnswers).toContainEqual({ status: lost.status, code: codeOf(lost) });
  const loser = lost === a ? 't1' : 't2';
  const after = await lab.availability();
  expect(after.rows).toEqual([expect.objectContaining({ productId: 'P1', locationId: 'WH', onHandMinor: 30 })]);
  expect(after.inTransit).toHaveLength(1);
  // decided again on fresh figures: 70 against 30 is a plain refusal, not a race
  const retry = await lab.dispatch(loser, `td-${loser}-again`);
  expect(retry.status).toBe(422);
  expect(codeOf(retry)).toBe('transfer_refused');
  expect((await lab.availability()).rows[0]!.onHandMinor).toBe(30);
}

async function theLastUnitPromisedTwice(h: ApiHarness, t: string): Promise<void> {
  const lab = orderLab(h, t);
  await lab.seed('LAST1', 1);
  const [a, b] = await Promise.all([lab.promise('o1', [{ productId: 'LAST1', quantityMinor: 1 }]), lab.promise('o2', [{ productId: 'LAST1', quantityMinor: 1 }])]);
  expect([a.status, b.status]).toEqual([200, 200]);
  expect([(a.body as Promised).outcome, (b.body as Promised).outcome].sort()).toEqual(['cannot_promise', 'promised']);
  expect((await lab.reservations('o1')).length + (await lab.reservations('o2')).length).toBe(1);
}

async function twoWritersOneChain(store: EventStore, t: string): Promise<void> {
  const one = auditTrailAdapter({ store });
  const two = auditTrailAdapter({ store });
  const sealed = await Promise.all(Array.from({ length: 20 }, (_, n) => (n % 2 === 0 ? one : two).recordAudit(t, auditEntry(n, t))));
  expect(new Set(sealed.map((s) => s.sequence)).size).toBe(20);
  // a THIRD instance started afterwards (a restart) folds the tail it finds and continues the one chain
  const later = await auditTrailAdapter({ store }).recordAudit(t, auditEntry(20, t));
  expect(later.sequence).toBe(21);
  const { records, verdict } = await chainVerdict(store, t);
  expect(records).toHaveLength(21);
  expect(verdict.intact, JSON.stringify(verdict.findings)).toBe(true);
  expect(verdict.recordsChecked).toBe(21);
}

describe('SF-04 — two different transfers cannot spend the same stock', () => {
  it('70 + 70 against 100 at the same moment: one dispatches, the other is a named 409; the source holds 30, one in transit; the loser, retried, is refused for the stock that is left', async () => {
    await twoTransfersOfTheSameStock(apiHarness(), A, ONLY_THE_GUARD);
  });

  it('two transfers that both fit dispatch one after another', async () => {
    const lab = stockLab(apiHarness(), A);
    await lab.seed(100);
    await lab.propose('t1', 'S1', 40);
    await lab.propose('t2', 'S2', 40);
    expect((await lab.dispatch('t1')).status).toBe(200);
    expect((await lab.dispatch('t2')).status).toBe(200);
    expect((await lab.availability()).rows[0]!.onHandMinor).toBe(20);
  });
});

describe('FUL-02 — the last unit is promised once, and duplicate lines are one line', () => {
  it('two orders for the last unit at the same moment: both are answered 200, exactly one is promised, the other told the truth; one reservation holds', async () => {
    await theLastUnitPromisedTwice(apiHarness(), A);
  });

  it('a basket that names the same product twice is ONE line of the summed quantity — promised against what there is, held once', async () => {
    const lab = orderLab(apiHarness(), A);
    await lab.seed('MILK5', 5);
    const res = await lab.promise('o3', [{ productId: 'MILK5', quantityMinor: 4 }, { productId: 'MILK5', quantityMinor: 4 }]);
    expect(res.status).toBe(200);
    expect((res.body as Promised).lines).toEqual([expect.objectContaining({ productId: 'MILK5', requestedMinor: 8, promisedMinor: 5, outcome: 'partially_promised' })]);
    expect(await lab.reservations('o3')).toEqual([expect.objectContaining({ productId: 'MILK5', quantityMinor: 5 })]);
    // and the stock the promise took is exactly what the order holds — a second order sees nothing left
    expect(((await lab.promise('o4', [{ productId: 'MILK5', quantityMinor: 1 }])).body as Promised).outcome).toBe('cannot_promise');
  });

  it('a line that is not a positive whole quantity is refused by name — nothing reserved', async () => {
    const lab = orderLab(apiHarness(), A);
    await lab.seed('MILK5', 5);
    const bad = await lab.promise('o5', [{ productId: 'MILK5', quantityMinor: 0 }]);
    expect(bad.status).toBe(400);
    expect(codeOf(bad)).toBe('not_readable_as_order_lines');
  });
});

describe('PA-11 — the audit chain does not fork under two adapter instances', () => {
  it('two instances over one store, twenty concurrent records, then a restarted third: every sequence unique, the chain verifies intact', async () => {
    await twoWritersOneChain(new InMemoryEventStore(), A);
  });
});

// ── The same three races on real PostgreSQL — the proof the audit asked for ─────────────────────────────────
const DATABASE_URL = process.env['DATABASE_URL'];
// A unique tenant per case — an append-only database keeps what earlier runs put in it (§35).
const freshTenant = (): string => `d${Date.now().toString(16).slice(-6)}${Math.floor(Math.random() * 16).toString(16)}-dddd-4ddd-8ddd-${'d'.repeat(12)}`;

describe.skipIf(!DATABASE_URL)('SF-04 · FUL-02 · PA-11 on real PostgreSQL (Wave 2a-ii)', () => {
  let pool: Pool;
  beforeAll(async () => {
    // The TRANSACTIONAL pool client — the wiring main.ts uses; a guarded append refuses a client without one.
    pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
    const dir = 'db/migrations';
    await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
  });
  afterAll(async () => { await pool.end(); });

  const harness = () => { const sql = pgPoolClient(pool); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); };

  it('SF-04: two transfers of 70 against 100 — one lands, the other is refused by name (the guard, or the true figure once the first committed); the source holds 30 on the database', async () => {
    await twoTransfersOfTheSameStock(harness(), freshTenant(), GUARD_OR_TRUE_FIGURE);
  });

  it('FUL-02: the last unit promised by two orders at once — one promised, one told the truth, one hold on the database', async () => {
    await theLastUnitPromisedTwice(harness(), freshTenant());
  });

  it('PA-11: two adapter instances and a restarted third over one database — one chain, every sequence unique, verified intact', async () => {
    const store = new SqlEventStore(pgPoolClient(pool));
    const t = freshTenant();
    await store.registerTenant(t, 'tests');
    await twoWritersOneChain(store, t);
  });
});
