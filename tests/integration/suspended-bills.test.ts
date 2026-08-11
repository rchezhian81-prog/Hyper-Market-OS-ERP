import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// M15-FR-01 / M12-FR-02: parked (suspended) bills on the live API. A recall is a CLAIM that succeeds once
// and refuses afterwards (two lanes resuming one bill is a double charge); a bill belongs to its lane and
// store; an abandoned bill is kept with who and why; and the manager gets the parked-bill report at close.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const line = (lineId: string) => ({ lineId, productId: `prod-${lineId}`, description: 'item', unitPriceMinor: 5000, quantityMinor: 1000, uom: 'ea', taxBps: 500, voided: false });
const BASKET = { storeId: 'store-1', laneId: 'lane-1', cashierId: 'u-cash', tradingDay: '2026-08-11', currency: 'INR', lines: [line('l1'), line('l2')], at: '2026-08-11T10:00:00Z' };

const park = (h: ApiHarness, u: string, id: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/pos/suspended-bills/${id}`, userId: u, tenantId: A, idempotencyKey: key, body });
const resume = (h: ApiHarness, u: string, id: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/pos/suspended-bills/${id}/resume`, userId: u, tenantId: A, idempotencyKey: key, body });
const abandon = (h: ApiHarness, u: string, id: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/pos/suspended-bills/${id}/abandon`, userId: u, tenantId: A, idempotencyKey: key, body });
const stale = (h: ApiHarness, u: string, at: string) =>
  h.request({ method: 'GET', path: '/v1/pos/suspended-bills/stale', userId: u, tenantId: A, query: { at } });

describe('suspended (parked) bills (M15-FR-01 / M12-FR-02)', () => {
  it('parks a basket, recalls it once, and refuses a second recall (double-charge guard)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    expect(((await park(h, 'u-owner', 'b1', BASKET, 'sb-park')).body as { state: string }).state).toBe('suspended');

    const r1 = (await resume(h, 'u-owner', 'b1', { byUserId: 'u-owner', onLaneId: 'lane-1', storeId: 'store-1', at: '2026-08-11T10:05:00Z' }, 'sb-res1')).body as { state: string };
    expect(r1.state).toBe('resumed');

    // Second recall of the same bill is refused — resuming again would charge the customer twice.
    expect((await resume(h, 'u-owner', 'b1', { byUserId: 'u-owner', onLaneId: 'lane-1', storeId: 'store-1', at: '2026-08-11T10:06:00Z' }, 'sb-res2')).status).toBe(422);
  });

  it('refuses a cross-lane recall by default', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await park(h, 'u-owner', 'b2', BASKET, 'sb-park2'); // parked on lane-1
    // Recall attempted on lane-2 with cross-lane recall not allowed.
    expect((await resume(h, 'u-owner', 'b2', { byUserId: 'u-owner', onLaneId: 'lane-2', storeId: 'store-1', at: '2026-08-11T10:05:00Z' }, 'sb-xlane')).status).toBe(422);
  });

  it('abandons a parked bill only with a reason, and reports what is still parked', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await park(h, 'u-owner', 'b3', BASKET, 'sb-park3');
    await park(h, 'u-owner', 'b4', { ...BASKET, lines: [line('x1')] }, 'sb-park4');

    expect((await abandon(h, 'u-owner', 'b3', { byUserId: 'u-owner', reason: '' }, 'sb-ab-noreason')).status).toBe(422); // valid shape, business refusal: needs a reason
    expect(((await abandon(h, 'u-owner', 'b3', { byUserId: 'u-owner', reason: 'customer left' }, 'sb-ab')).body as { state: string }).state).toBe('abandoned');

    // Only b4 is still parked (b3 abandoned).
    const report = (await stale(h, 'u-owner', '2026-08-11T15:00:00Z')).body as { count: number; bills: { billId: string }[] };
    expect(report.count).toBe(1);
    expect(report.bills[0]!.billId).toBe('b4');
  });

  it('refuses an empty basket / malformed request and gates on the permissions', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');
    expect((await park(h, 'u-owner', 'b5', { ...BASKET, lines: [] }, 'sb-empty')).status).toBe(422); // empty_basket
    expect((await park(h, 'u-owner', 'b6', { laneId: 'lane-1' }, 'sb-bad')).status).toBe(400);
    expect((await park(h, 'u-cash', 'b7', BASKET, 'sb-rbac')).status).toBe(403);
    expect((await stale(h, 'u-cash', '2026-08-11T15:00:00Z')).status).toBe(403);
  });
});
