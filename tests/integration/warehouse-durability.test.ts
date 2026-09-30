import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Warehouse durability — bins, in-transit transfers and cycle-count corrections rebuild from the event
// store after a restart (M09-FR-01/03/04, API-04, P-04 "tested recovery", P-08, FND-01 append-only).
//
// warehouse-bins / warehouse-transfers / warehouse-counts each prove their FR behaviour, RBAC and
// per-tenant isolation; replenishment (M09-FR-02) is a stateless advisory (nothing to persist). The one
// property the stateful FRs did not prove is that what was recorded SURVIVES the process restarting: a
// bin's projected contents, a transfer held in-transit (the van is a place), and a blind-count correction
// layered on M08. All three are event-sourced; a restart must replay the log to the SAME truth, and appends
// must continue. This mirrors the restart-rebuild bar the other event-sourced surfaces carry (goods-receipt,
// connector-delivery, facilities, production).

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

// FR-01 bins / movements
const bin = (h: ApiHarness, u: string, binId: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: `/v1/warehouse/bins/${binId}`, userId: u, tenantId: A, idempotencyKey: `bin-${binId}`, body });
const move = (h: ApiHarness, u: string, commandId: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: `/v1/warehouse/movements/${commandId}`, userId: u, tenantId: A, idempotencyKey: `mv-${commandId}`, body });
const readBin = (h: ApiHarness, u: string, binId: string) =>
  h.request({ method: 'GET', path: `/v1/warehouse/bins/${binId}`, userId: u, tenantId: A });
const putAway = (toBinId: string, productId: string, qty: number) =>
  ({ kind: 'put_away', storeId: 'S1', productId, batchId: null, quantityMinor: qty, uom: 'EA', fromBinId: null, toBinId });

// FR-03 transfers
const propose = (h: ApiHarness, u: string, id: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: `/v1/warehouse/transfers/${id}`, userId: u, tenantId: A, idempotencyKey: `tr-${id}`, body });
const dispatch = (h: ApiHarness, u: string, id: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: `/v1/warehouse/transfers/${id}/dispatch`, userId: u, tenantId: A, idempotencyKey: `td-${id}`, body });
const readTransfer = (h: ApiHarness, u: string, id: string) =>
  h.request({ method: 'GET', path: `/v1/warehouse/transfers/${id}`, userId: u, tenantId: A });

// FR-04 blind cycle counts (layered on the M08 ledger)
const seedOnHand = (h: ApiHarness, u: string, productId: string, locationId: string, qty: number) => {
  const movementId = `seed-${productId}-${locationId}`;
  // Received at ₹1.00 a unit — the cloud's own value for any variance (SP-4: the body carries none).
  return h.request({ method: 'POST', path: '/v1/inventory/movements', userId: u, tenantId: A, idempotencyKey: movementId,
    body: { movementId, productId, locationId, kind: 'received', quantityMinor: qty, uom: 'EA', occurredAt: '2026-08-01T00:00:00.000Z', enteredBy: u, unitCostMinor: 100 } });
};
const count = (h: ApiHarness, u: string, countId: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: `/v1/inventory/counts/${countId}`, userId: u, tenantId: A, idempotencyKey: `ct-${countId}`, body });
const readCount = (h: ApiHarness, u: string, productId: string, locationId: string) =>
  h.request({ method: 'GET', path: '/v1/inventory/counts', userId: u, tenantId: A, query: { productId, locationId } });

interface BinBody { occupancyMinor: number; held: { key: string; quantityMinor: number }[] }
interface PositionBody { systemOnHandMinor: number; countCorrectionMinor: number; postedCorrectionMinor: number; correctedOnHandMinor: number }

describe('warehouse durability: bins, in-transit transfers and count corrections rebuild after a restart (M09)', () => {
  it('replays a bin, a transfer held in-transit and a cycle-count correction to the same truth, and keeps appending', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-boss', 'store_manager'); // the separate person who dispatches (§28)

    // FR-01: register a bin and put 30 away.
    expect((await bin(h, 'u-owner', 'B1', { storeId: 'S1', capacityMinor: 100, pickable: true })).status).toBe(201);
    expect((await move(h, 'u-owner', 'm1', putAway('B1', 'P1', 30))).status).toBe(201);

    // FR-03: propose a transfer and a SEPARATE person dispatches it over head office's own 20 at WH → held in-transit.
    await seedOnHand(h, 'u-owner', 'P1', 'WH', 20);
    expect((await propose(h, 'u-owner', 't1', { fromLocationId: 'WH', toLocationId: 'S1', lines: [{ productId: 'P1', batchId: null, quantityMinor: 10, uom: 'EA', unitCost: { minor: 5_000, currency: 'INR' } }] })).status).toBe(201);
    expect((await dispatch(h, 'u-boss', 't1', {})).status).toBe(200);

    // FR-04: a blind count 2 short of the ledger commits an immaterial compensating adjustment — ONE M08 movement (SP-5b) —
    // valued by head office (₹2.00, under the default ₹1 000 threshold), never by the body.
    await seedOnHand(h, 'u-owner', 'PC', 'LOC1', 100);
    expect((await count(h, 'u-owner', 'c1', { productId: 'PC', locationId: 'LOC1', uom: 'EA', countedMinor: 98, reasonCode: 'cycle_count' })).status).toBe(201);

    // Restart: a NEW surface over the SAME persisted event store — every read must rebuild from the log.
    const restarted = apiHarness({ store: h.store });

    // FR-01 rebuilt.
    const b1 = (await readBin(restarted, 'u-owner', 'B1')).body as BinBody;
    expect(b1.occupancyMinor, 'the bin contents did not survive the restart').toBe(30);
    expect(b1.held.find((x) => x.key === 'B1|P1|')?.quantityMinor).toBe(30);

    // FR-03 rebuilt — the transfer is still held in-transit (the van is a place).
    const t1 = await readTransfer(restarted, 'u-owner', 't1');
    expect(t1.status).toBe(200);
    expect((t1.body as { state: string }).state, 'the in-transit transfer did not survive the restart').toBe('in_transit');

    // FR-03 rebuilt (SP-5, F05) — the dispatched 10 are still off the warehouse's on-hand and still on the van.
    const stock = (await restarted.request({ method: 'GET', path: '/v1/inventory/availability', userId: 'u-owner', tenantId: A, query: { productId: 'P1' } })).body as { rows: { locationId: string; onHandMinor: number }[]; inTransit: { transferId: string; quantityMinor: number }[] };
    expect(stock.rows, 'the dispatch\'s stock movement did not survive the restart').toEqual([expect.objectContaining({ locationId: 'WH', onHandMinor: 10 })]);
    expect(stock.inTransit).toEqual([expect.objectContaining({ transferId: 't1', quantityMinor: 10 })]);

    // FR-04 rebuilt (SP-5b, F06) — the count correction is ON the M08 position, posted once, layered on nothing.
    const pos = (await readCount(restarted, 'u-owner', 'PC', 'LOC1')).body as PositionBody;
    expect(pos, 'the count correction did not survive the restart').toMatchObject({ systemOnHandMinor: 98, countCorrectionMinor: 0, postedCorrectionMinor: -2, correctedOnHandMinor: 98 });

    // The rebuilt surface is LIVE, not a read-only replay: a further put-away lands and updates the bin.
    expect((await move(restarted, 'u-owner', 'm2', putAway('B1', 'P1', 20))).status).toBe(201);
    expect(((await readBin(restarted, 'u-owner', 'B1')).body as BinBody).occupancyMinor).toBe(50);
  });
});
