import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { STREAM } from '../../services/api/src/adapters';
import { makeEvent } from '../../packages/contracts/src/event';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';

/**
 * **SF-02 — each delivery is judged against what is LEFT on its order (Wave 3 · M06-FR-04 · M07-FR-01 · M07-FR-03 ·
 * hard rule #10).**
 *
 * The audit received 60 and then another 60 against an order of 100: both were 201, the second 60 all sellable with
 * nothing held and called "40 short", and the order showed 120 received and −20 open. A receipt is now measured by the
 * order's remaining quantity (ordered − already received − cancelled): the second delivery is 40 as ordered and 20 HELD
 * for a second person; the original 100 is kept on the record beside what remained. Two receipts written at the same
 * moment cannot both spend the same remainder — the write is guarded on the order, and the loser is refused by name.
 * The scenarios run over the in-memory store and, with DATABASE_URL, on real PostgreSQL.
 */

const AT = '2026-10-09T06:00:00.000Z';
const POLICY = { excessToleranceBp: 500, shortageToleranceBp: 200, nearExpiryDays: 7 };
const cost = (minor: number) => ({ minor, currency: 'INR' });
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

interface Grn {
  availableMinor: number; heldMinor: number; governanceFlags: string[];
  orderPosition?: Record<string, { ordered: number; receivedBefore: number; cancelled: number; remaining: number }>;
  captured: { discrepancies: { kind: string; quantityMinor: number }[] };
}
interface Order { order: { receivedByProduct: Record<string, number> }; openCommitment: { fullyReceived: boolean; lines: { productId: string; openQty: number }[] } | null }

function lab(h: ApiHarness, t: string) {
  const req = (method: 'POST' | 'GET', path: string, userId: string, idempotencyKey?: string, body?: unknown, query?: Record<string, string>) =>
    h.request({ method, path, userId, tenantId: t, ...(idempotencyKey === undefined ? {} : { idempotencyKey }), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
  return {
    /** The cast, the product master (p1 untracked), the tenant's tolerances, and an ISSUED order of 100 × p1. */
    seed: async (poId: string, ordered: number) => {
      await h.seedOwner(t, 'u-owner');
      await h.provisionRole(t, 'u-mgr', 'store_manager');
      await h.store.append(t, STREAM.catalogue, makeEvent({
        id: `pack-${t}-1`, type: 'CataloguePublished', occurredAt: AT, idempotencyKey: `catalogue-${t}-v1`, source: 'test/catalogue',
        payload: { snapshot: { tenantId: t, version: 1, builtAt: AT, scope: { tenantId: t, storeId: 'store-1' }, barcodes: [],
          products: [{ productId: 'p1', sku: 'p1', name: 'Toor dal 1kg', unitPriceMinor: 16_000, taxBps: 0, status: 'active', uom: 'each', batchTracked: false, handling: 'ambient' }] } },
      }));
      expect((await req('POST', '/v1/inventory/receipt-policy', 'u-owner', 'k-policy', POLICY)).status).toBe(201);
      expect((await req('POST', `/v1/purchase/orders/${poId}`, 'u-mgr', `po-${poId}`, { supplierId: 'sup-1', lines: [{ productId: 'p1', orderedQty: ordered, unitCost: cost(5000) }] })).status).toBe(201);
      expect((await req('POST', `/v1/purchase/orders/${poId}/approval`, 'u-owner', `po-${poId}-ok`, { reason: 'within budget' })).status).toBe(200);
    },
    receive: (grnId: string, poId: string, counted: number, key = `k-${grnId}`) => req('POST', `/v1/inventory/goods-receipt/${grnId}`, 'u-mgr', key, {
      warehouseId: 'wh1', receivedOnDate: '2026-10-09', currency: 'INR', poId,
      lines: [{ lineId: 'L1', productId: 'p1', orderedMinor: counted, countedMinor: counted, uom: 'each', unitCost: cost(5000), condition: 'good' }],
    }),
    cancel: (poId: string, qty: number) => req('POST', `/v1/purchase/orders/${poId}/cancellations`, 'u-owner', `c-${poId}`, { cancellationId: 'c1', reason: 'supplier cannot supply the rest', cancelledByProduct: { p1: qty } }),
    order: async (poId: string) => (await req('GET', `/v1/purchase/orders/${poId}`, 'u-owner')).body as Order,
    onHand: async () => ((await req('GET', '/v1/inventory/availability', 'u-owner', undefined, undefined, { productId: 'p1' })).body as { rows: { onHandMinor: number }[] }).rows.reduce((s, r) => s + r.onHandMinor, 0),
  };
}
const grnOf = (res: { body: unknown }): Grn => (res.body as { grn: Grn }).grn;

// ── The scenarios, written once, run on both stores ──────────────────────────────────────────────────────────
async function sixtyThenForty(h: ApiHarness, t: string): Promise<void> {
  const l = lab(h, t);
  await l.seed('po-1', 100);
  const first = await l.receive('grn-1', 'po-1', 60);
  expect(first.status).toBe(201);
  expect(grnOf(first).orderPosition).toEqual({ p1: { ordered: 100, receivedBefore: 0, cancelled: 0, remaining: 100 } });
  const second = await l.receive('grn-2', 'po-1', 40);
  expect(second.status).toBe(201);
  // judged against the 40 that remained: complete, nothing short, nothing held
  expect(grnOf(second)).toMatchObject({ availableMinor: 40, heldMinor: 0, governanceFlags: [] });
  expect(grnOf(second).orderPosition).toEqual({ p1: { ordered: 100, receivedBefore: 60, cancelled: 0, remaining: 40 } });
  expect(grnOf(second).captured.discrepancies).toEqual([]);
  const po = await l.order('po-1');
  expect(po.order.receivedByProduct).toEqual({ p1: 100 });
  expect(po.openCommitment).toMatchObject({ fullyReceived: true, lines: [expect.objectContaining({ openQty: 0 })] });
}

async function sixtyThenSixty(h: ApiHarness, t: string): Promise<void> {
  const l = lab(h, t);
  await l.seed('po-2', 100);
  expect((await l.receive('grn-1', 'po-2', 60)).status).toBe(201);
  const second = await l.receive('grn-2', 'po-2', 60);
  expect(second.status).toBe(201);
  // THE AUDIT'S CASE: 40 as ordered, 20 over — HELD for a second person, never sellable on the receiver's say-so
  expect(grnOf(second)).toMatchObject({ availableMinor: 40, heldMinor: 20 });
  expect(grnOf(second).captured.discrepancies.map((d) => [d.kind, d.quantityMinor])).toEqual([['excess', 20]]);
  expect(grnOf(second).orderPosition?.['p1']).toEqual({ ordered: 100, receivedBefore: 60, cancelled: 0, remaining: 40 });
  expect(await l.onHand()).toBe(100);
  const po = await l.order('po-2');
  expect(po.order.receivedByProduct).toEqual({ p1: 100 }); // never 120
  expect(po.openCommitment?.lines).toEqual([expect.objectContaining({ productId: 'p1', openQty: 0 })]); // never −20
}

async function aCancelledRemainder(h: ApiHarness, t: string): Promise<void> {
  const l = lab(h, t);
  await l.seed('po-3', 100);
  expect((await l.receive('grn-1', 'po-3', 60)).status).toBe(201);
  expect((await l.cancel('po-3', 40)).status).toBe(200);
  const late = await l.receive('grn-2', 'po-3', 10);
  expect(late.status).toBe(201);
  // nothing is left on the order: every unit that came is excess, held, and the record says why
  expect(grnOf(late)).toMatchObject({ availableMinor: 0, heldMinor: 10 });
  expect(grnOf(late).governanceFlags).toContain('nothing_left_on_order');
  expect(grnOf(late).orderPosition?.['p1']).toEqual({ ordered: 100, receivedBefore: 60, cancelled: 40, remaining: 0 });
  expect((await l.order('po-3')).order.receivedByProduct).toEqual({ p1: 60 });
  expect(await l.onHand()).toBe(60);
}

/** Two deliveries of 60 recorded at the same moment against an order of 100. */
async function twoReceiptsAtOnce(h: ApiHarness, t: string, onTheDatabase: boolean): Promise<void> {
  const l = lab(h, t);
  await l.seed('po-4', 100);
  const [a, b] = await Promise.all([l.receive('grn-a', 'po-4', 60), l.receive('grn-b', 'po-4', 60)]);
  const statuses = [a.status, b.status].sort();
  if (statuses[0] === 201 && statuses[1] === 201) {
    // Only on the database: the first committed before the second read the order, so the second was judged on the TRUE
    // remainder (40 + 20 held) — sequential, not a race.
    expect(onTheDatabase).toBe(true);
    expect([grnOf(a).heldMinor, grnOf(b).heldMinor].sort()).toEqual([0, 20]);
  } else {
    expect(statuses).toEqual([201, 409]);
    const lost = a.status === 409 ? a : b;
    expect(codeOf(lost)).toBe('concurrent_change');
    // booked again, it is judged against what is left now
    const again = await l.receive(lost === a ? 'grn-a' : 'grn-b', 'po-4', 60, 'k-again');
    expect(again.status).toBe(201);
    expect(grnOf(again)).toMatchObject({ availableMinor: 40, heldMinor: 20 });
  }
  // Either way: the order received exactly 100, and 100 are on the shelf with 20 held.
  expect((await l.order('po-4')).order.receivedByProduct).toEqual({ p1: 100 });
  expect(await l.onHand()).toBe(100);
}

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('SF-02 — a delivery is judged against what is left on its order', () => {
  it('60 then 40 against 100: the second is complete, nothing short; the order is fully received', async () => {
    await sixtyThenForty(apiHarness(), A);
  });
  it('60 then 60 against 100 (the audit\'s case): the second is 40 as ordered and 20 HELD; the order shows 100 received, 0 open — never 120 / −20', async () => {
    await sixtyThenSixty(apiHarness(), A);
  });
  it('a cancelled remainder: nothing left on the order, so a late delivery is all held and says why', async () => {
    await aCancelledRemainder(apiHarness(), A);
  });
  it('two deliveries of 60 at the same moment: one lands, the other is refused by name; booked again it is 40 + 20 held', async () => {
    await twoReceiptsAtOnce(apiHarness(), A, false);
  });
});

// ── The same on real PostgreSQL ──────────────────────────────────────────────────────────────────────────────
const DATABASE_URL = process.env['DATABASE_URL'];
const freshTenant = (): string => `e${Date.now().toString(16).slice(-6)}${Math.floor(Math.random() * 16).toString(16)}-eeee-4eee-8eee-${'e'.repeat(12)}`;

describe.skipIf(!DATABASE_URL)('SF-02 on real PostgreSQL', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
    const dir = 'db/migrations';
    await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
  });
  afterAll(async () => { await pool.end(); });
  const harness = () => { const sql = pgPoolClient(pool); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); };

  it('60 then 60 against 100: 40 as ordered, 20 held; the order shows 100 received', async () => {
    await sixtyThenSixty(harness(), freshTenant());
  });
  it('two deliveries of 60 at the same moment: the order never receives more than 100', async () => {
    await twoReceiptsAtOnce(harness(), freshTenant(), true);
  });
});
