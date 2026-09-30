import { describe, expect, it } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Audit observations (30 September 2026, pinned at 8f4f6c5) for the warehouse mutations.
//
// F07 — FIXED in SP-4: cases 1, 2 and 4 are now the REGRESSIONS. The dispatch takes its approver from the authenticated
// caller (who cannot be the proposer) and the available stock from head office's own position; a body naming either is
// refused. The direct count takes its value from the cloud's cost and its threshold from the tenant's policy; a body
// naming either, or an approver, is refused; a material variance is HELD and decided by a separate person.
//
// F05 and F06 — FIXED in SP-5 / SP-5b: the assertions that used to be marked OBSERVED DEFECT are now the REGRESSIONS. A
// dispatched transfer takes stock off the source's on-hand and shows it in transit at the destination; a received one
// puts what arrived on-hand there with the value that left the source; an approved count correction is an M08 movement
// that ordinary availability and valuation read. Never restore the old assertions to keep this file green.
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = 'audit-owner';
const BOSS = 'audit-boss';
const GHOST = 'never-provisioned-approver';
const request = (h: ApiHarness, path: string, body: unknown, key: string, userId = USER) =>
  h.request({ method: 'POST', path, body, idempotencyKey: key, tenantId: TENANT, userId });
const read = (h: ApiHarness, path: string, query?: Readonly<Record<string, string>>) =>
  h.request({ method: 'GET', path, query, tenantId: TENANT, userId: USER });
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

async function setup() {
  const h = apiHarness();
  await h.seedOwner(TENANT, USER);
  await h.provisionRole(TENANT, BOSS, 'store_manager'); // a SECOND person who may approve (§28)
  expect((await request(h, '/v1/inventory/movements', {
    movementId: 'audit-opening', productId: 'P1', locationId: 'WH', kind: 'received',
    quantityMinor: 20, uom: 'EA', occurredAt: '2026-08-01T00:00:00.000Z',
    enteredBy: USER, unitCostMinor: 100,
  }, 'audit-opening')).status).toBe(202);
  // SP-5: a transfer's ends must be places head office knows. WH already holds stock; the shop FLOOR is a department of
  // the back store in the org structure (company → warehouse → department).
  expect((await request(h, '/v1/org/nodes/C1', { kind: 'company', name: 'SRE Retail' }, 'org-c1')).status).toBe(201);
  expect((await request(h, '/v1/org/nodes/WH', { kind: 'warehouse', name: 'Back store', parentId: 'C1', companyId: 'C1' }, 'org-wh')).status).toBe(201);
  expect((await request(h, '/v1/org/nodes/FLOOR', { kind: 'department', name: 'Shop floor', parentId: 'WH' }, 'org-floor')).status).toBe(201);
  return h;
}
type Row = { productId: string; locationId: string; onHandMinor: number };
type ValRow = { productId: string; locationId: string; value: { minor: number }; cogs: { minor: number }; transferredOut: { minor: number } };

describe('AUDIT F07 (FIXED, SP-4): approver, available stock and value are head office\'s, never the caller\'s', () => {
  it('a dispatch naming an approver or stock is refused; the proposer cannot dispatch their own; a second person can, over head office\'s stock — [F05 FIXED] stock leaves the source at dispatch, is in transit at the destination, and arrives there with its value on receipt', async () => {
    const h = await setup();
    expect((await request(h, '/v1/warehouse/transfers/T1', {
      fromLocationId: 'WH', toLocationId: 'FLOOR',
      lines: [{ productId: 'P1', batchId: null, quantityMinor: 10, uom: 'EA', unitCost: { minor: 100, currency: 'INR' } }],
    }, 'propose')).status).toBe(201);
    // The old body — a never-provisioned approver and a claimed quantity — is refused by name, and moves nothing.
    const claims = await request(h, '/v1/warehouse/transfers/T1/dispatch', {
      approvedBy: GHOST,
      available: [{ productId: 'P1', batchId: null, quantityMinor: 20, state: 'on_hand' }],
    }, 'dispatch-claims', BOSS);
    expect(claims.status).toBe(400);
    expect(codeOf(claims)).toBe('dispatch_carries_caller_claims');
    // The proposer dispatching is the proposer approving their own (§28) — refused.
    const self = await request(h, '/v1/warehouse/transfers/T1/dispatch', {}, 'dispatch-self', USER);
    expect(self.status).toBe(422);
    expect(codeOf(self)).toBe('transfer_refused');
    expect((await read(h, '/v1/warehouse/transfers/T1')).body).toMatchObject({ state: 'proposed' });
    // A second person dispatches: the approver is that person, the stock checked is head office's 20 at WH — and the
    // value that leaves is head office's own ₹1.00 a unit at WH, recorded on the transfer, never the proposer's figure.
    const dispatch = await request(h, '/v1/warehouse/transfers/T1/dispatch', {}, 'dispatch', BOSS);
    expect(dispatch.status).toBe(200);
    expect(dispatch.body).toMatchObject({ state: 'in_transit', approvedBy: BOSS, posted: ['T1-out-1'], lineCostsMinor: [100], availableChecked: [{ productId: 'P1', quantityMinor: 20, state: 'on_hand', recalled: false }] });
    // REGRESSION (F05, SP-5): at dispatch the stock has LEFT the source's on-hand and is IN TRANSIT at the destination —
    // visible there, deliberately not on-hand there (M08-FR-02).
    let availability = (await read(h, '/v1/inventory/availability')).body as { rows: Row[]; inTransit: unknown[] };
    expect(availability.rows).toEqual([expect.objectContaining({ productId: 'P1', locationId: 'WH', onHandMinor: 10 })]);
    expect(availability.inTransit).toEqual([expect.objectContaining({ transferId: 'T1', productId: 'P1', locationId: 'FLOOR', fromLocationId: 'WH', quantityMinor: 10 })]);
    let valuation = (await read(h, '/v1/inventory/valuation')).body as { rows: ValRow[]; totalValueMinor: number };
    expect(valuation.rows).toEqual([expect.objectContaining({ locationId: 'WH', value: { minor: 1000, currency: 'INR' }, transferredOut: { minor: 1000, currency: 'INR' }, cogs: { minor: 0, currency: 'INR' } })]);

    expect((await request(h, '/v1/warehouse/transfers/T1/receive', {
      counted: [{ productId: 'P1', batchId: null, quantityMinor: 10 }],
    }, 'receive')).body).toMatchObject({ state: 'received', posted: ['T1-recv-1'], discrepancies: [] });
    expect((await read(h, '/v1/warehouse/transfers/T1')).body).toMatchObject({ state: 'received', requestedBy: USER, approvedBy: BOSS, lineCostsMinor: [100] });
    // REGRESSION (F05, SP-5): the received stock is on-hand at the DESTINATION on the same projection every reader folds —
    // WH 10 and FLOOR 10, nothing in transit — and the value followed it: ₹10.00 at each, ₹20.00 in all, none of it COGS.
    availability = (await read(h, '/v1/inventory/availability')).body as { rows: Row[]; inTransit: unknown[] };
    expect(availability.rows).toEqual([
      expect.objectContaining({ productId: 'P1', locationId: 'FLOOR', onHandMinor: 10 }),
      expect.objectContaining({ productId: 'P1', locationId: 'WH', onHandMinor: 10 }),
    ]);
    expect(availability.inTransit).toEqual([]);
    valuation = (await read(h, '/v1/inventory/valuation')).body as { rows: ValRow[]; totalValueMinor: number };
    expect(valuation.rows).toEqual([
      expect.objectContaining({ productId: 'P1', locationId: 'FLOOR', onHandMinor: 10, value: { minor: 1000, currency: 'INR' }, unitCostMinor: 100 }),
      expect.objectContaining({ productId: 'P1', locationId: 'WH', onHandMinor: 10, value: { minor: 1000, currency: 'INR' }, unitCostMinor: 100 }),
    ]);
    expect(valuation.totalValueMinor).toBe(2000);
    expect(valuation.rows.reduce((s, r) => s + r.cogs.minor, 0)).toBe(0);
  });

  it('an over-draw is refused against head office\'s own stock — no caller-supplied quantity can permit it', async () => {
    const h = await setup();
    expect((await request(h, '/v1/warehouse/transfers/T2', {
      fromLocationId: 'WH', toLocationId: 'FLOOR',
      lines: [{ productId: 'P1', batchId: null, quantityMinor: 100, uom: 'EA', unitCost: { minor: 100, currency: 'INR' } }],
    }, 'propose-overdraw')).status).toBe(201);
    const dispatch = await request(h, '/v1/warehouse/transfers/T2/dispatch', {}, 'dispatch-overdraw', BOSS);
    expect(dispatch.status).toBe(422);
    expect(codeOf(dispatch)).toBe('transfer_refused');
    expect((dispatch.body as { error: { whatHappened: string } }).error.whatHappened).toMatch(/only 20 of P1 available to send, not 100/);
    expect((await read(h, '/v1/warehouse/transfers/T2')).body).toMatchObject({ state: 'proposed' });
  });

  it('a material count is HELD — not adjusted on a body approver — until a SECOND person decides it; [F06 FIXED] the approved correction is a ledger movement every reader folds', async () => {
    const h = await setup();
    // ₹1.00 a unit at head office; the tenant sets a low threshold so a five-unit variance (₹5.00) is material.
    expect((await request(h, '/v1/inventory/count-policy', { approvalThresholdMinor: 300 }, 'policy')).status).toBe(201);
    // The old body — a claimed value, threshold and approver — is refused by name.
    const claims = await request(h, '/v1/inventory/counts/C1', {
      productId: 'P1', locationId: 'WH', uom: 'EA', countedMinor: 15,
      reasonCode: 'cycle_count', valuePerUnitMinor: 100, thresholdMinor: 100, approvedBy: GHOST,
    }, 'count-claims');
    expect(claims.status).toBe(400);
    expect(codeOf(claims)).toBe('count_carries_caller_claims');
    // The blind count alone: expected 20, counted 15, valued by head office at ₹5.00 ≥ ₹3.00 → held.
    const counted = await request(h, '/v1/inventory/counts/C1', {
      productId: 'P1', locationId: 'WH', uom: 'EA', countedMinor: 15, reasonCode: 'cycle_count',
    }, 'count');
    expect(counted.status).toBe(201);
    expect(counted.body).toMatchObject({ expectedMinor: 20, countedMinor: 15, varianceMinor: -5, valueMinor: 500, adjusted: false, requiredApproval: true, pendingApproval: true });
    expect((await read(h, '/v1/inventory/counts', { productId: 'P1', locationId: 'WH' })).body)
      .toMatchObject({ systemOnHandMinor: 20, correctedOnHandMinor: 20, pending: 1 });
    // The counter cannot decide their own count; a second person can — and only then does the correction layer on.
    const self = await request(h, '/v1/inventory/counts/C1/decide', { decision: 'approved', reason: 'my own count' }, 'decide-self', USER);
    expect(self.status).toBe(422);
    expect(codeOf(self)).toBe('self_approval');
    // While it waits, nothing has moved: availability and valuation still read 20 / ₹20.00.
    expect(((await read(h, '/v1/inventory/availability')).body as { rows: Row[] }).rows[0]).toMatchObject({ locationId: 'WH', onHandMinor: 20 });
    const approved = await request(h, '/v1/inventory/counts/C1/decide', { decision: 'approved', reason: 'recounted the shelf' }, 'decide', BOSS);
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ decision: 'approved', adjusted: true, approvedBy: BOSS, movementId: 'count:C1' });
    // REGRESSION (F06, SP-5b): the approved correction is ONE compensating movement on the M08 ledger — the count view,
    // ordinary availability and valuation all read 15 / ₹15.00, and the correction is not layered a second time.
    expect((await read(h, '/v1/inventory/counts', { productId: 'P1', locationId: 'WH' })).body)
      .toMatchObject({ systemOnHandMinor: 15, countCorrectionMinor: 0, postedCorrectionMinor: -5, correctedOnHandMinor: 15, pending: 0 });
    const availability = (await read(h, '/v1/inventory/availability')).body as { rows: Row[] };
    expect(availability.rows).toEqual([expect.objectContaining({ productId: 'P1', locationId: 'WH', onHandMinor: 15 })]);
    expect((await read(h, '/v1/inventory/valuation')).body).toMatchObject({ totalValueMinor: 1500 });
    // The movement itself names the count, both people and the reason — the ledger IS the audit for stock (M08-FR-01).
    const moves = (await h.store.readStream(TENANT, 'inventory', { type: 'InventoryMoved' })).map((e) => e.event.payload as Record<string, unknown>);
    expect(moves.find((m) => m['movementId'] === 'count:C1')).toMatchObject({ kind: 'wasted', quantityMinor: 5, locationId: 'WH', enteredBy: USER, approvedBy: BOSS, reason: expect.stringContaining('count C1 (cycle_count): counted 15, expected 20; approved by audit-boss') });
  });

  it('a counter can no longer price a variance at nothing to slip under the threshold — the value is the cloud\'s', async () => {
    const h = await setup();
    expect((await request(h, '/v1/inventory/count-policy', { approvalThresholdMinor: 300 }, 'policy')).status).toBe(201);
    // The zero-cost body is refused outright…
    expect(codeOf(await request(h, '/v1/inventory/counts/C2', {
      productId: 'P1', locationId: 'WH', uom: 'EA', countedMinor: 0,
      reasonCode: 'cycle_count', valuePerUnitMinor: 0, thresholdMinor: 1,
    }, 'zero-cost-count'))).toBe('count_carries_caller_claims');
    // …and the same count sent blind is valued at head office's ₹1.00 × 20 = ₹20.00 → material → held, not adjusted.
    const counted = await request(h, '/v1/inventory/counts/C2', {
      productId: 'P1', locationId: 'WH', uom: 'EA', countedMinor: 0, reasonCode: 'cycle_count',
    }, 'zero-count');
    expect(counted.status).toBe(201);
    expect(counted.body).toMatchObject({ varianceMinor: -20, valueMinor: 2000, adjusted: false, requiredApproval: true, pendingApproval: true, flags: [] });
  });
});
