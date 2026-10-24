import { describe, it, expect } from 'vitest';
import { useRestartableBackings } from '../support/p3-backings';
import { fulfilmentShop, dayFigures, codeOf, OWNER, DISPATCHER, MANAGER2, PICKER, DRIVER, CASHIER, STORE_ID, DOORS } from '../support/fulfilment-shop';

// D09-FR-06 · M19-FR-04 · OB-313 (owner, 23 Oct 2026: "below the owner's threshold, a new order for that slot or zone
// needs a manager's approval"; the threshold shows "not set" and while it is not set the rule only flags) · OB-294 (own
// drivers only; the courier link built switched off):
//   • an order is judged ONCE, on the numbers in force when head office first sees it; a missing cost rate is "not
//     assessed" — never a zero, never held on a guess;
//   • with rates but no threshold: flag only; with the threshold: an order below it is HELD — kept off the wave and the
//     route — until a manager approves it (with the reason; a cashier cannot); a decline keeps it held;
//   • own-fleet settlement from head office's own stop register at the owner's rate: proposed, approved by a SECOND
//     person, paid with a voucher, every difference said; the courier link is off and sends nothing.
// In memory and on real PostgreSQL, with a cold restart. Synthetic data.

const backings = useRestartableBackings();
type Row = { orderId: string; standing: string; gate: { outcome: string; missing: string[]; assessment: { contributionMinor: number } | null } };

describe.each(backings)('the contribution rule holds an order for a manager, and the fleet is settled (D09-FR-06 · OB-313) — on $name', ({ harness }) => {
  it('not assessed → flag only → held → approved → picked and routed; settlement proposed, approved by another, paid; courier off; a restart', async () => {
    const h = harness();
    const shop = await fulfilmentShop(h);
    const rule = async () => (await shop.ok('GET', '/v1/delivery/contribution', DISPATCHER, undefined, { storeId: STORE_ID })) as { thresholdState: string; thresholdMinor: number | null; orders: Row[] };

    // ORD-1 is first seen before the owner has entered any number: not assessed (no delivery rates) — kept as judged.
    await shop.placeConfirmed('c-1', 'ORD-1', [['RICE', 1]], 1, DOORS.near);
    let r = await rule();
    expect(r.thresholdState).toBe('not_set');
    expect(r.orders).toEqual([expect.objectContaining({ orderId: 'ORD-1', standing: 'not_assessed', gate: expect.objectContaining({ missing: ['delivery_rates'] }) })]);

    // The owner enters the delivery cost rates (only the owner). ORD-2: it loses money — but with no threshold, a flag only.
    expect((await shop.call('POST', '/v1/delivery/controls', DISPATCHER, { costPerDropMinor: 30_00 })).status).toBe(403);
    await shop.ok('POST', '/v1/delivery/controls', OWNER, { costPerDropMinor: 30_00, costPerKmMinor: 5_00 });
    await shop.placeConfirmed('c-2', 'ORD-2', [['RICE', 1]], 1, DOORS.near);
    r = await rule();
    const o2 = r.orders.find((o) => o.orderId === 'ORD-2')!;
    expect(o2.standing).toBe('flag_only');
    expect(o2.gate.assessment!.contributionMinor).toBeLessThan(0);
    expect(r.orders.find((o) => o.orderId === 'ORD-1')!.standing).toBe('not_assessed'); // judged once, on the numbers of its day

    // The owner sets his threshold. ORD-3 is below it: HELD for a manager — not offered for a wave, not planned.
    await shop.ok('POST', '/v1/delivery/controls', OWNER, { contributionThresholdMinor: 10_00 });
    await shop.placeConfirmed('c-3', 'ORD-3', [['DAL', 1]], 1, DOORS.mid);
    r = await rule();
    expect(r.thresholdMinor).toBe(10_00);
    expect(r.orders[0]).toMatchObject({ orderId: 'ORD-3', standing: 'held' }); // the held ones first
    const cand = await shop.ok('GET', '/v1/fulfilment/wave-candidates', DISPATCHER, undefined, { storeId: STORE_ID });
    expect((cand['held'] as { orderId: string }[]).map((o) => o.orderId)).toEqual(['ORD-3']);
    const blocked = await shop.call('POST', '/v1/fulfilment/waves/W-1/build', DISPATCHER, { storeId: STORE_ID, pickerId: PICKER, orderIds: ['ORD-3'] });
    expect((blocked.body as { error: { refused: { reason: string }[] } }).error.refused[0]!.reason).toBe('held_for_manager');
    const plan1 = await shop.ok('POST', `/v1/delivery/dispatch/${shop.runDate}/plan-from-orders`, DISPATCHER, dayFigures(shop));
    expect(plan1['held']).toEqual([{ orderId: 'ORD-3', standing: 'held' }]);
    expect(JSON.stringify((plan1['plan'] as { routes: unknown }).routes)).not.toContain('ORD-3');

    // A cashier cannot decide; a reason is required; an order that is not held cannot be decided on.
    expect((await shop.call('POST', '/v1/delivery/contribution/ORD-3/decision', CASHIER, { decision: 'approve', reason: 'regular customer' })).status).toBe(403);
    expect(codeOf(await shop.call('POST', '/v1/delivery/contribution/ORD-3/decision', DISPATCHER, { decision: 'approve', reason: 'ok' }))).toBe('not_readable_as_a_contribution_decision');
    expect(codeOf(await shop.call('POST', '/v1/delivery/contribution/ORD-2/decision', DISPATCHER, { decision: 'approve', reason: 'regular customer' }))).toBe('not_held');
    // A decline keeps it held; an approval releases it.
    await shop.ok('POST', '/v1/delivery/contribution/ORD-3/decision', DISPATCHER, { decision: 'decline', reason: 'too far for one packet' });
    expect((await rule()).orders.find((o) => o.orderId === 'ORD-3')!.standing).toBe('declined');
    expect((await shop.ok('POST', '/v1/delivery/contribution/ORD-3/decision', MANAGER2, { decision: 'approve', reason: 'regular customer, keep them' }))['standing']).toBe('approved');
    const plan2 = await shop.ok('POST', `/v1/delivery/dispatch/${shop.runDate}/plan-from-orders`, DISPATCHER, dayFigures(shop));
    expect(plan2['held']).toEqual([]);
    const route = (plan2['plan'] as { routes: { routeId: string; stops: { stopId: string; orderId: string }[] }[] }).routes[0]!;
    expect(route.stops.map((s) => s.orderId).sort()).toEqual(['ORD-1', 'ORD-2', 'ORD-3']);

    // ── Own-fleet settlement for the run, from head office's own stop register.
    await shop.ok('POST', `/v1/delivery/dispatch/${shop.runDate}/routes/${encodeURIComponent(route.routeId)}/assign`, DISPATCHER, { storeId: STORE_ID });
    const enc = encodeURIComponent(route.routeId);
    for (const s of route.stops.slice(0, 2)) {
      for (const state of ['out_for_delivery', 'delivered']) {
        await shop.ok('POST', `/v1/delivery/routes/${enc}/stops/${encodeURIComponent(s.stopId)}/synced`, OWNER, {
          routeId: route.routeId, stopId: s.stopId, driverId: DRIVER, orderRef: s.orderId, state, codExpectedMinor: 0, codCollectedMinor: 0, codMethod: null,
          proofKind: state === 'delivered' ? 'otp' : null, proofCode: state === 'delivered' ? '0000' : null, geofenceMismatch: false, failureReason: null, contributionFlag: null, currency: 'INR', occurredAt: new Date().toISOString(),
        });
      }
    }
    expect(codeOf(await shop.call('POST', `/v1/delivery/fleet-settlements/${enc}`, DISPATCHER, {}))).toBe('fleet_rate_not_set');
    await shop.ok('POST', '/v1/delivery/controls', OWNER, { fleetRate: { basis: 'per_drop', rateMinor: 40_00 } });
    const proposed = await shop.ok('POST', `/v1/delivery/fleet-settlements/${enc}`, DISPATCHER, {});
    expect(proposed).toMatchObject({ stage: 'proposed', proposed: { drops: 2, amountMinor: 80_00, driverId: DRIVER, by: DISPATCHER } });
    expect(codeOf(await shop.call('POST', `/v1/delivery/fleet-settlements/${enc}/approve`, DISPATCHER, {}))).toBe('cannot_approve_own_proposal');
    expect((await shop.call('POST', `/v1/delivery/fleet-settlements/${enc}/paid`, MANAGER2, { amountMinor: 80_00, voucherRef: 'PV-1' })).status).toBe(409); // not approved yet
    expect((await shop.ok('POST', `/v1/delivery/fleet-settlements/${enc}/approve`, MANAGER2, {}))['stage']).toBe('approved');
    const paid = await shop.ok('POST', `/v1/delivery/fleet-settlements/${enc}/paid`, MANAGER2, { amountMinor: 75_00, voucherRef: 'PV-1' });
    expect(paid).toMatchObject({ stage: 'paid', paidMinor: 75_00, differenceMinor: -5_00 }); // a short payment is said, never balanced away
    expect(paid['books']).toMatch(/not posted here/);
    expect((await shop.call('POST', `/v1/delivery/fleet-settlements/${enc}/approve`, CASHIER, {})).status).toBe(403);

    // ── The courier link: off — own drivers only — and nothing is sent.
    expect(await shop.ok('GET', '/v1/delivery/courier-link', DISPATCHER)).toMatchObject({ on: false, partner: 'none' });
    expect(codeOf(await shop.call('POST', '/v1/delivery/courier/ORD-3/hand-off', DISPATCHER, { area: 'Slot', codMinor: 0 }))).toBe('courier_link_off');

    // ── A cold restart: the same judgements and the same settlement.
    const again = harness(h);
    const read = async (path: string, query?: Record<string, string>) => (await again.request({ method: 'GET', path, userId: DISPATCHER, tenantId: shop.t, ...(query === undefined ? {} : { query }) })).body as Record<string, unknown>;
    expect((await read('/v1/delivery/contribution', { storeId: STORE_ID }))['orders']).toEqual((await rule()).orders);
    const s2 = await read(`/v1/delivery/fleet-settlements/${enc}`);
    expect(s2).toMatchObject({ stage: 'paid', paidMinor: 75_00, differenceMinor: -5_00, rate: { basis: 'per_drop', rateMinor: 40_00 } });
  }, 90_000);
});
