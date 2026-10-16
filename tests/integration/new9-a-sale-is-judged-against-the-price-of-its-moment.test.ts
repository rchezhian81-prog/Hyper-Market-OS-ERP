import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useBackings } from '../support/backings';
import { STREAM, streamName } from '../../services/api/src/adapters';
import { makeEvent } from '../../packages/contracts/src/event';

/**
 * **NEW-9 (verifier, D-7) — each till sale is judged against the price of record IN FORCE AT THE SALE'S TIME.** The
 * verifier's case: the price of record drops from ₹120 to ₹100; the last sale, before the drop, charged ₹120 — right then —
 * and the report held "the till charged MORE than the shop's own price", ranked first as legal exposure. A rise did the
 * same the other way. Now, on the real API in memory and on PostgreSQL: a correct sale made before a price change is never
 * a mismatch (drop or rise); a sale that disagreed with the price of ITS moment is still caught, aged from that sale.
 */

const backings = useBackings();
const DAY = 86_400_000;
type Res = { status: number; body: unknown };
interface Exc { productId: string; surface: string; kind: string; recordMinor: number; surfaceMinor?: number; openSince: string }

describe.each(backings)('NEW-9 — a till sale is judged against the price of its own moment — on $name', ({ harness }) => {
  it('a correct sale before a drop or a rise is no mismatch; a sale wrong at its own time still is', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner'); await h.provisionRole(T, 'u-cash', 'cashier');
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, query?: Record<string, string>): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(body === undefined ? {} : { body, idempotencyKey: randomUUID() }), ...(query === undefined ? {} : { query }) });
    const now = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    const day = (ms: number) => iso(ms).slice(0, 10);
    // The price HISTORY is laid down as head office's own published entries at their times (the route refuses a back-dated
    // entry today, rightly — this is the record of prices that were in force before the test began).
    const price = async (p: string, id: string, minor: number, from: number, to?: number) => {
      await h.store.append(T, streamName(STREAM.pricing, 'list', p), makeEvent({
        id: `price-entry-${p}-${id}`, type: 'PriceListEntryPublished', occurredAt: iso(from), idempotencyKey: `price-entry-${T}-${p}-${id}`, source: 'test/pricing',
        payload: { id, productId: p, scope: 'store', scopeRef: 'S1', price: { minor, currency: 'INR' }, effectiveFrom: iso(from), effectiveTo: to === undefined ? null : iso(to), status: 'active', version: id.endsWith('2') ? 2 : 1 },
      }));
    };
    // GHEE: ₹120 until 4 days ago, then ₹100 (the verifier's drop). JAM: ₹100 until 4 days ago, then ₹120 (a rise).
    // HONEY: ₹100 throughout, and the till charged ₹110 two days ago — wrong at its own time.
    await price('GHEE', 'g1', 12_000, now - 20 * DAY, now - 5 * DAY); await price('GHEE', 'g2', 10_000, now - 4 * DAY);
    await price('JAM', 'j1', 10_000, now - 20 * DAY, now - 5 * DAY); await price('JAM', 'j2', 12_000, now - 4 * DAY);
    await price('HONEY', 'h1', 10_000, now - 20 * DAY);
    const sale = (id: string, productId: string, minor: number, at: number) => call('POST', '/v1/sales', 'u-cash', {
      saleId: id, receiptNumber: `R-${id}`, laneId: 'lane-1', locationId: 'S1', cashierId: 'u-cash', tradingDay: day(at), committedAt: iso(at),
      totalMinor: minor, currency: 'INR', packVersion: 1, lines: [{ productId, quantityMinor: 1, uom: 'ea', unitPriceMinor: minor, lineTotalMinor: minor }],
      tenders: [{ kind: 'cash', amountMinor: minor }],
    });
    expect((await sale('s-ghee', 'GHEE', 12_000, now - 10 * DAY)).status).toBe(202); // right at the time
    expect((await sale('s-jam', 'JAM', 10_000, now - 10 * DAY)).status).toBe(202);   // right at the time
    expect((await sale('s-honey', 'HONEY', 11_000, now - 2 * DAY)).status).toBe(202); // wrong at the time

    const rep = (await call('GET', '/v1/pricing/integrity/ageing', 'u-owner', undefined, { branchId: 'S1' })).body as { exceptions: Exc[] };
    const till = rep.exceptions.filter((e) => e.surface === 'pos');
    expect(till.map((e) => [e.productId, e.kind, e.recordMinor, e.surfaceMinor])).toEqual([['HONEY', 'charged_above_record', 10_000, 11_000]]);
    expect(till[0]!.openSince).toBe(iso(now - 2 * DAY));
    // The two correct sales are no mismatch of any kind at the till.
    expect(rep.exceptions.some((e) => e.surface === 'pos' && (e.productId === 'GHEE' || e.productId === 'JAM'))).toBe(false);

    // HONEY sells right again: the till exception leaves the report by itself.
    expect((await sale('s-honey-2', 'HONEY', 10_000, now - 60_000)).status).toBe(202);
    const after = (await call('GET', '/v1/pricing/integrity/ageing', 'u-owner', undefined, { branchId: 'S1' })).body as { exceptions: Exc[] };
    expect(after.exceptions.filter((e) => e.surface === 'pos')).toEqual([]);
  });
});
