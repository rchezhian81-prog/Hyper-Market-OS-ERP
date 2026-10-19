import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { approvedSuppliers, deliveryPlaces } from '../support/approved-supplier';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';

/**
 * **D-10 (R4, OB-227) — a supplier's scorecard is built from its own purchase orders, goods receipts and matched invoices,
 * with no typed figures**, on the real API, in memory and on REAL PostgreSQL, with a cold restart in the middle:
 *
 *   • two orders issued to one supplier, three deliveries (one late, one with goods damaged at the dock), two invoices the
 *     three-way match checked (one line billed above the agreed price);
 *   • the scorecard shows fill rate, on time in full (order lines complete by the issue day plus the contract's lead time),
 *     lead-time reliability, invoice accuracy and rejection rate — each traced to the registers, none typed;
 *   • a supplier with no delivery in the period reads "not rated" (its undelivered order named), never a score;
 *   • a corrected receipt replaces its figure (the damaged line, accepted by a second person, is no longer a rejection)
 *     and a re-sent receipt is counted once;
 *   • the old typed door is closed (410), a cashier cannot read a scorecard (403), and a bad period is refused (400).
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

// The day each step happens on: the clock the whole surface reads (a fake Date that still ticks).
const travel = (iso: string): void => { vi.setSystemTime(Date.parse(iso)); };
const backings: { name: string; harness: () => ApiHarness; restart: (h: ApiHarness) => ApiHarness }[] = [
  { name: 'the in-memory event store', harness: () => apiHarness(), restart: (h) => apiHarness({ store: h.store }) },
];
if (DATABASE_URL !== undefined) {
  const sqlHarness = () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); };
  backings.push({ name: 'real PostgreSQL', harness: sqlHarness, restart: sqlHarness });
}

type Res = { status: number; body: unknown };
type Rating = { kind: 'rated'; bp: number } | { kind: 'not_rated'; because: string };
interface Card {
  fillRate: Rating; onTimeInFull: Rating; leadTimeReliability: Rating; invoiceAccuracy: Rating; rejectionRate: Rating;
  deliveries: number; orderLines: number; orderLinesOnTimeInFull: number; ordersWithNothingReceived: string[]; sources: string[]; summary: string;
}
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
/** 10:00 in the shop (IST) on a day. */
const at = (day: string) => `${day}T04:30:00.000Z`;

describe.each(backings)('a supplier scorecard is built from orders, receipts and invoices — on $name (D-10)', ({ harness, restart }) => {
  it('fill rate · on time in full · lead-time spread · invoice accuracy · rejection rate; not rated with no delivery; a correction counted once', async () => {
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    try {
    travel(at('2026-09-01'));
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-buyer', 'store_manager');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-cash', 'cashier');
    await approvedSuppliers(h, T, 's-1', 's-idle');
    await deliveryPlaces(h, T, 'store-1');
    const req = (method: 'GET' | 'POST', path: string, body?: unknown, userId = 'u-owner', key = `k-${randomUUID()}`, query?: Record<string, string>): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: key } : {}), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    const order = async (poId: string, supplierId: string, lines: { productId: string; orderedQty: number; unitMinor: number }[]) => {
      await ok(req('POST', `/v1/purchase/orders/${poId}`, { supplierId, deliverToLocationId: 'store-1', lines: lines.map((l) => ({ productId: l.productId, orderedQty: l.orderedQty, unitCost: { minor: l.unitMinor, currency: 'INR' } })) }, 'u-buyer'), `order ${poId}`);
      await ok(req('POST', `/v1/purchase/orders/${poId}/approval`, { reason: 'synthetic order' }), `issue ${poId}`);
    };
    const grnBody = (poId: string, day: string, lines: { lineId: string; productId: string; ordered: number; counted: number; unitMinor: number; condition?: string }[]) => ({
      warehouseId: 'store-1', receivedOnDate: day, currency: 'INR', poId,
      lines: lines.map((l) => ({ lineId: l.lineId, productId: l.productId, orderedMinor: l.ordered, countedMinor: l.counted, uom: 'ea', unitCost: { minor: l.unitMinor, currency: 'INR' }, condition: l.condition ?? 'good' })),
    });
    const receive = (grnId: string, poId: string, day: string, lines: Parameters<typeof grnBody>[2]) => { travel(at(day)); return ok(req('POST', `/v1/inventory/goods-receipt/${grnId}`, grnBody(poId, day, lines), 'u-owner', grnId), `receive ${grnId}`); };
    const invoice = async (invoiceId: string, poId: string, lines: { productId: string; quantity: number; unitPriceMinor: number }[]) => {
      const ls = lines.map((l) => ({ ...l, lineTotalMinor: l.quantity * l.unitPriceMinor }));
      await ok(req('POST', `/v1/purchase/invoices/${invoiceId}/capture`, { supplierId: 's-1', poId, declaredTotalMinor: ls.reduce((s, l) => s + l.lineTotalMinor, 0), lines: ls }, 'u-buyer'), `capture ${invoiceId}`);
      await ok(req('POST', `/v1/purchase/invoices/${invoiceId}/match`, {}, 'u-mgr'), `match ${invoiceId}`);
    };
    const card = async (supplierId: string, userId = 'u-owner'): Promise<Card> =>
      ((await ok(req('GET', `/v1/purchase/suppliers/${supplierId}/scorecard`, undefined, userId, undefined, { from: '2026-09-01', to: '2026-09-30' }), `scorecard ${supplierId}`)).body as { scorecard: Card }).scorecard;

    // The contract's lead time is the agreed date: issue day + 7.
    await ok(req('POST', '/v1/purchase/contracts/c-1', { supplierId: 's-1', startsOn: '2026-01-01', endsOn: '2026-12-31', agreedLeadTimeDays: 7 }, 'u-buyer'), 'contract');
    await order('po-1', 's-1', [{ productId: 'p1', orderedQty: 10, unitMinor: 500 }, { productId: 'p2', orderedQty: 4, unitMinor: 1000 }]);
    travel(at('2026-09-02'));
    await order('po-2', 's-1', [{ productId: 'p3', orderedQty: 5, unitMinor: 200 }]);
    await order('po-idle', 's-idle', [{ productId: 'p1', orderedQty: 3, unitMinor: 500 }]);
    await receive('grn-1', 'po-1', '2026-09-05', [{ lineId: 'L1', productId: 'p1', ordered: 10, counted: 10, unitMinor: 500 }, { lineId: 'L2', productId: 'p2', ordered: 4, counted: 2, unitMinor: 1000 }]);
    await receive('grn-3', 'po-2', '2026-09-06', [{ lineId: 'L1', productId: 'p3', ordered: 5, counted: 5, unitMinor: 200 }]);
    // The rest of p2 arrives late (day 11 against an agreed 7), damaged — held back at the dock.
    await receive('grn-2', 'po-1', '2026-09-12', [{ lineId: 'L1', productId: 'p2', ordered: 2, counted: 2, unitMinor: 1000, condition: 'damaged' }]);
    await invoice('inv-1', 'po-1', [{ productId: 'p1', quantity: 10, unitPriceMinor: 500 }, { productId: 'p2', quantity: 4, unitPriceMinor: 1050 }]);
    await invoice('inv-2', 'po-2', [{ productId: 'p3', quantity: 5, unitPriceMinor: 200 }]);

    const first = await card('s-1');
    expect(first.sources).toEqual(['purchase_orders', 'goods_receipts', 'matched_invoices']);
    expect(first.deliveries).toBe(3);
    expect(first.fillRate).toEqual({ kind: 'rated', bp: 10_000 });
    expect(first.onTimeInFull).toEqual({ kind: 'rated', bp: 6_667 }); // p1 and p3 complete by their dates; p2 not
    expect(first.orderLinesOnTimeInFull).toBe(2);
    expect(first.leadTimeReliability).toEqual({ kind: 'rated', bp: 5_088 }); // 4, 4 and 11 days
    expect(first.invoiceAccuracy).toEqual({ kind: 'rated', bp: 6_667 });   // p2 billed above the agreed ₹10.00
    expect(first.rejectionRate).toEqual({ kind: 'rated', bp: 1_053 });     // 2 of 19 held back
    expect(first.summary).toMatch(/billed above the agreed price/);

    // No delivery in the period → "not rated", never a score; the order nobody delivered is named.
    const idle = await card('s-idle');
    expect(idle.fillRate).toEqual({ kind: 'not_rated', because: 'no delivery in the period' });
    expect(idle.onTimeInFull.kind).toBe('not_rated');
    expect(idle.ordersWithNothingReceived).toEqual(['po-idle']);

    // ── A COLD RESTART: the scorecard is rebuilt from the registers ──────────────────────────────────────────────────
    h = restart(h);
    expect(await card('s-1')).toEqual(first);

    // A correction: a second person accepts the damaged line — the dock's figure is replaced, not added to.
    travel(at('2026-09-13'));
    await ok(req('POST', '/v1/inventory/goods-receipt/grn-2/lines/L1/disposition', { disposition: 'accept', reason: 'boxes dented, goods fine' }, 'u-mgr'), 'accept');
    // The same receipt re-sent is one delivery, not two.
    await req('POST', '/v1/inventory/goods-receipt/grn-1', grnBody('po-1', '2026-09-05', [{ lineId: 'L1', productId: 'p1', ordered: 10, counted: 10, unitMinor: 500 }, { lineId: 'L2', productId: 'p2', ordered: 4, counted: 2, unitMinor: 1000 }]), 'u-owner', 'grn-1');
    const corrected = await card('s-1');
    expect(corrected.rejectionRate).toEqual({ kind: 'rated', bp: 0 });
    expect(corrected.deliveries).toBe(3);
    expect(corrected.fillRate).toEqual({ kind: 'rated', bp: 10_000 });
    expect(corrected.onTimeInFull).toEqual({ kind: 'rated', bp: 6_667 }); // still late: a correction does not move the date

    // No typed figures: the old door answers 410 by name and saves nothing; the card is unchanged.
    const typed = await req('POST', '/v1/purchase/suppliers/s-1/receipts/po-1', { orderedOn: '2026-09-01', receivedOn: '2026-09-02', orderedQtyMinor: 1, receivedQtyMinor: 1, agreedValue: { minor: 1, currency: 'INR' }, invoicedValue: { minor: 1, currency: 'INR' } }, 'u-mgr');
    expect(typed.status).toBe(410);
    expect(codeOf(typed)).toBe('typed_delivery_outcome_retired');
    expect(await card('s-1')).toEqual(corrected);

    // Permissions and error paths.
    expect((await req('GET', '/v1/purchase/suppliers/s-1/scorecard', undefined, 'u-cash')).status).toBe(403);
    const badPeriod = await req('GET', '/v1/purchase/suppliers/s-1/scorecard', undefined, 'u-owner', undefined, { from: '2026-09-30', to: '2026-09-01' });
    expect(badPeriod.status).toBe(400);
    expect(codeOf(badPeriod)).toBe('not_readable_as_a_period');
    } finally { vi.useRealTimers(); }
  }, 120_000);
});
