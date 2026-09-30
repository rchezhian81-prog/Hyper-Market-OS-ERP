import { describe, expect, it } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Temporary audit reproductions. These assert the OBSERVED defects at the pinned commit;
// passing means the gap is reproduced, not that this is acceptable intended behavior.
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = 'audit-owner';
const GHOST = 'never-provisioned-approver';
const request = (h: ApiHarness, path: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path, body, idempotencyKey: key, tenantId: TENANT, userId: USER });
const read = (h: ApiHarness, path: string, query?: Readonly<Record<string, string>>) =>
  h.request({ method: 'GET', path, query, tenantId: TENANT, userId: USER });

async function setup() {
  const h = apiHarness();
  await h.seedOwner(TENANT, USER);
  expect((await request(h, '/v1/inventory/movements', {
    movementId: 'audit-opening', productId: 'P1', locationId: 'WH', kind: 'received',
    quantityMinor: 20, uom: 'EA', occurredAt: '2026-08-01T00:00:00.000Z',
    enteredBy: USER, unitCostMinor: 100,
  }, 'audit-opening')).status).toBe(202);
  return h;
}

describe('AUDIT observations: warehouse mutations do not reach commerce stock', () => {
  it('accepts an unprovisioned approver and a receipt by the requester, but transfer leaves stock and valuation at source', async () => {
    const h = await setup();
    expect((await request(h, '/v1/warehouse/transfers/T1', {
      fromLocationId: 'WH', toLocationId: 'FLOOR',
      lines: [{ productId: 'P1', batchId: null, quantityMinor: 10, uom: 'EA', unitCost: { minor: 100, currency: 'INR' } }],
    }, 'propose')).status).toBe(201);
    const dispatch = await request(h, '/v1/warehouse/transfers/T1/dispatch', {
      approvedBy: GHOST,
      available: [{ productId: 'P1', batchId: null, quantityMinor: 20, state: 'on_hand' }],
    }, 'dispatch');
    expect(dispatch.status).toBe(200);
    expect(dispatch.body).toMatchObject({ state: 'in_transit', approvedBy: GHOST });
    expect((await request(h, '/v1/warehouse/transfers/T1/receive', {
      counted: [{ productId: 'P1', batchId: null, quantityMinor: 10 }],
    }, 'receive')).status).toBe(200);
    expect((await read(h, '/v1/warehouse/transfers/T1')).body).toMatchObject({ state: 'received', requestedBy: USER });
    const availability = (await read(h, '/v1/inventory/availability')).body as { rows: unknown[] };
    expect(availability.rows).toHaveLength(1);
    expect(availability.rows[0]).toMatchObject({ productId: 'P1', locationId: 'WH', onHandMinor: 20 });
    const valuation = (await read(h, '/v1/inventory/valuation')).body as { rows: unknown[]; totalValueMinor: number };
    expect(valuation.rows).toHaveLength(1);
    expect(valuation.rows[0]).toMatchObject({ productId: 'P1', locationId: 'WH' });
    expect(valuation.totalValueMinor).toBe(2000);
  });

  it('accepts a caller-supplied fictitious available quantity larger than actual stock', async () => {
    const h = await setup();
    expect((await request(h, '/v1/warehouse/transfers/T2', {
      fromLocationId: 'WH', toLocationId: 'FLOOR',
      lines: [{ productId: 'P1', batchId: null, quantityMinor: 100, uom: 'EA', unitCost: { minor: 100, currency: 'INR' } }],
    }, 'propose-overdraw')).status).toBe(201);
    const dispatch = await request(h, '/v1/warehouse/transfers/T2/dispatch', {
      approvedBy: GHOST,
      available: [{ productId: 'P1', batchId: null, quantityMinor: 100, state: 'on_hand' }],
    }, 'dispatch-overdraw');
    expect(dispatch.status).toBe(200);
    expect(dispatch.body).toMatchObject({ state: 'in_transit' });
  });

  it('accepts a material count under an unprovisioned approver but changes only the count-specific view', async () => {
    const h = await setup();
    const counted = await request(h, '/v1/inventory/counts/C1', {
      productId: 'P1', locationId: 'WH', uom: 'EA', countedMinor: 15,
      reasonCode: 'cycle_count', valuePerUnitMinor: 100, thresholdMinor: 100, approvedBy: GHOST,
    }, 'count');
    expect(counted.status).toBe(201);
    expect(counted.body).toMatchObject({ expectedMinor: 20, countedMinor: 15, varianceMinor: -5, adjusted: true, requiredApproval: true });
    expect((await read(h, '/v1/inventory/counts', { productId: 'P1', locationId: 'WH' })).body)
      .toMatchObject({ systemOnHandMinor: 20, correctedOnHandMinor: 15 });
    const availability = (await read(h, '/v1/inventory/availability')).body as { rows: unknown[] };
    expect(availability.rows[0]).toMatchObject({ productId: 'P1', locationId: 'WH', onHandMinor: 20 });
    expect((await read(h, '/v1/inventory/valuation')).body).toMatchObject({ totalValueMinor: 2000 });
  });

  it('allows the counter to lower the claimed cost to zero and bypass approval entirely', async () => {
    const h = await setup();
    const counted = await request(h, '/v1/inventory/counts/C2', {
      productId: 'P1', locationId: 'WH', uom: 'EA', countedMinor: 0,
      reasonCode: 'cycle_count', valuePerUnitMinor: 0, thresholdMinor: 1,
    }, 'zero-cost-count');
    expect(counted.status).toBe(201);
    expect(counted.body).toMatchObject({ varianceMinor: -20, valueMinor: 0, adjusted: true, requiredApproval: false });
  });
});
