import { describe, it, expect } from 'vitest';
import {
  syncedDriverRunRoutes, cashFromStops, latestStops, stepBetween, currentOrderState, presentRoute, DRIVER_RUN_SYNC_FLAGS, COD_METHODS,
  FAILURE_REASON_OUTCOMES, attemptFromStop,
  type SyncedDriverRunDeps, type RouteStopUpdate, type RouteSettlementRecord, type CashHandoverRecord,
} from '../../services/fulfilment/src/driver-runs';
import { reconcileRun, type DeliveryAttempt, type DeliveryStateRecord } from '../../services/fulfilment/src/index';
import type { RequestContext, Route } from '../../services/kernel/src/index';
import type { AuditEntry } from '../../packages/audit/src/index';

/**
 * **The driver's stop outcomes, settlement and cash handover become head office's facts — re-verified, once, mapped onto
 * the order's own lifecycle, compared with the stops, and flagged, never silently applied or dropped (SP-3c-ii · F11's
 * driver half · M19-FR-03/04 · M23 · §28 · hard rules #3/#4/#6/#10).**
 */

const NOW = '2026-10-01T18:00:00.000Z';
const A = 'tenant-a';

interface World {
  readonly stops: RouteStopUpdate[];
  readonly settlements: RouteSettlementRecord[];
  readonly handovers: CashHandoverRecord[];
  readonly orders: DeliveryStateRecord[];
  /** The driver's run register (OB-09) — what `/v1/delivery/runs/:driverId` reads. */
  readonly attempts: DeliveryAttempt[];
  readonly audit: AuditEntry[];
  readonly routes: readonly Route[];
}

function world(grants: Record<string, readonly string[] | undefined> = { 'u-driver': ['delivery.attempt.record'], 'u-floor': ['pos.sale.record'] }): World {
  const stops: RouteStopUpdate[] = [];
  const settlements: RouteSettlementRecord[] = [];
  const handovers: CashHandoverRecord[] = [];
  const orders: DeliveryStateRecord[] = [];
  const attempts: DeliveryAttempt[] = [];
  const audit: AuditEntry[] = [];
  const deps: SyncedDriverRunDeps = {
    permissionsOfUser: (_t, userId) => grants[userId],
    stopUpdates: (_t, routeId) => stops.filter((s) => s.routeId === routeId),
    recordStopUpdate: (_t, u) => { stops.push(u); },
    settlement: (_t, routeId) => settlements.find((s) => s.routeId === routeId),
    recordSettlement: (_t, r) => { settlements.push(r); },
    handover: (_t, routeId) => handovers.find((h) => h.routeId === routeId),
    recordHandover: (_t, r) => { handovers.push(r); },
    deliveryState: (_t, orderId) => orders.filter((o) => o.orderId === orderId),
    recordDeliveryTransition: (_t, r) => { orders.push(r); },
    recordAttempt: (_t, a) => { attempts.push(a); },
    recordAudit: (_t, e) => { audit.push(e); },
    now: () => NOW,
  };
  return { stops, settlements, handovers, orders, attempts, audit, routes: syncedDriverRunRoutes(deps) };
}

const route = (w: World, method: string, path: string): Route => {
  const r = w.routes.find((x) => x.method === method && x.path === path);
  if (r === undefined) throw new Error(`no ${method} ${path}`);
  return r;
};
const ctx = (params: Record<string, string>, body: unknown = undefined): RequestContext => ({
  tenantId: A, userId: 'u-box', branchId: null, params, query: {}, body, traceId: 't', idempotencyKey: 'k',
});

const stop = (over: Record<string, unknown> = {}) => ({
  routeId: 'R-1', driverId: 'u-driver', stopId: 's1', orderRef: 'ORD-1', state: 'out_for_delivery', codExpectedMinor: 250_00,
  codCollectedMinor: 0, codMethod: null, proofKind: null, geofenceMismatch: false, failureReason: null, contributionFlag: null, currency: 'INR', ...over,
});
const delivered = (over: Record<string, unknown> = {}) => stop({ state: 'delivered', codCollectedMinor: 250_00, codMethod: 'cash', proofKind: 'otp', ...over });
const settled = (over: Record<string, unknown> = {}) => ({
  routeId: 'R-1', driverId: 'u-driver', expectedMinor: 250_00, collectedMinor: 250_00, cashHeldMinor: 250_00, matchedCount: 1, exceptionCount: 0, currency: 'INR', ...over,
});
const handed = (over: Record<string, unknown> = {}) => ({
  routeId: 'R-1', driverId: 'u-driver', countedMinor: 250_00, recordedMinor: 250_00, varianceMinor: 0, material: false, currency: 'INR', at: NOW, reasonCode: null, ...over,
});

const STOP = '/v1/delivery/routes/:routeId/stops/:stopId/synced';
const SETTLED = '/v1/delivery/routes/:routeId/settled/synced';
const HANDOVER = '/v1/delivery/routes/:routeId/handover/synced';
const post = (w: World, path: string, params: Record<string, string>, body: unknown) => route(w, 'POST', path).handler(ctx(params, body));

describe('the routes and their gates', () => {
  it('are the box\'s hop (delivery.stop.sync), idempotent writes on the delivery feature, with a read for the screens', () => {
    const w = world();
    for (const p of [STOP, SETTLED, HANDOVER]) expect(route(w, 'POST', p)).toMatchObject({ api: 'API-08', permission: 'delivery.stop.sync', entitlement: 'delivery', idempotent: true });
    expect(route(w, 'GET', '/v1/delivery/routes/:routeId')).toMatchObject({ permission: 'delivery.run.read', entitlement: 'delivery' });
    expect([...COD_METHODS]).toEqual(['cash', 'upi']);
    expect(DRIVER_RUN_SYNC_FLAGS).toContain('cash_office_review');
  });

  it('knows the one lifecycle step between two states, and the order\'s current state from its register', () => {
    expect(stepBetween('assigned', 'out_for_delivery')).toBe('depart');
    expect(stepBetween('assigned', 'picked_up')).toBe('pick_up');
    expect(stepBetween('out_for_delivery', 'delivered')).toBe('deliver');
    expect(stepBetween('attempted', 'partially_delivered')).toBe('deliver_partial');
    expect(stepBetween('failed', 'out_for_delivery')).toBe('reattempt');
    expect(stepBetween('failed', 'returned_to_origin')).toBe('rto');
    expect(stepBetween('assigned', 'delivered')).toBeUndefined(); // two steps away: the order was never departed at head office
    expect(stepBetween('delivered', 'failed')).toBeUndefined();
    expect(currentOrderState([])).toBe('assigned');
  });
});

describe('a stop outcome from the phone', () => {
  it('is recorded with the driver re-verified and the relay beside them, and steps the ORDER through its own state machine in the driver\'s name', async () => {
    const w = world();
    const departed = await post(w, STOP, { routeId: 'R-1', stopId: 's1' }, stop());
    expect(departed.status).toBe(202);
    expect(departed.body).toMatchObject({ routeId: 'R-1', stopId: 's1', state: 'out_for_delivery', recorded: true, flags: [], orderStep: { event: 'depart', from: 'assigned', to: 'out_for_delivery' } });
    const done = await post(w, STOP, { routeId: 'R-1', stopId: 's1' }, delivered());
    expect(done.body).toMatchObject({ flags: [], orderStep: { event: 'deliver', from: 'out_for_delivery', to: 'delivered' } });
    expect(w.orders).toEqual([
      expect.objectContaining({ orderId: 'ORD-1', from: 'assigned', to: 'out_for_delivery', event: 'depart', by: 'u-driver' }),
      expect.objectContaining({ orderId: 'ORD-1', from: 'out_for_delivery', to: 'delivered', event: 'deliver', by: 'u-driver', proofRef: 'otp@handheld:R-1/s1' }),
    ]);
    expect(w.stops).toHaveLength(2);
    expect(w.stops[1]).toMatchObject({ codCollectedMinor: 250_00, codMethod: 'cash', relayedBy: 'u-box', governanceFlags: [] });
    expect(w.audit[1]).toMatchObject({ actorId: 'u-driver', action: 'delivery.stop.record', objectType: 'delivery_route', objectId: 'R-1', after: { orderStep: 'deliver', relayedBy: 'u-box' } });
    expect(cashFromStops(w.stops)).toEqual({ expectedMinor: 250_00, collectedMinor: 250_00, cashHeldMinor: 250_00 });
  });

  it('is ONE record however often it is re-sent (route + stop + state), and a NEW outcome for the same stop is a second — failed, reattempted, delivered are three facts', async () => {
    const w = world();
    await post(w, STOP, { routeId: 'R-1', stopId: 's1' }, stop());
    const again = await post(w, STOP, { routeId: 'R-1', stopId: 's1' }, stop());
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ recorded: true, alreadyRecorded: true });
    expect(w.stops).toHaveLength(1);
    expect(w.orders).toHaveLength(1);
    await post(w, STOP, { routeId: 'R-1', stopId: 's1' }, stop({ state: 'failed', failureReason: 'nobody_home' }));
    await post(w, STOP, { routeId: 'R-1', stopId: 's1' }, stop({ state: 'returned_to_origin', failureReason: 'nobody_home' }));
    expect(w.stops.map((s) => s.state)).toEqual(['out_for_delivery', 'failed', 'returned_to_origin']);
    expect(w.orders.map((o) => o.event)).toEqual(['depart', 'fail', 'rto']);
    expect(latestStops(w.stops).map((s) => s.state)).toEqual(['returned_to_origin']);
    expect(cashFromStops(w.stops)).toEqual({ expectedMinor: 0, collectedMinor: 0, cashHeldMinor: 0 });
  });

  it('records and SAYS a stop the order cannot reach from where head office has it — never applies it blindly, never drops it', async () => {
    const w = world();
    // The phone says delivered; head office never saw the departure (the box's order was disturbed, or a dispatcher moved it).
    const res = await post(w, STOP, { routeId: 'R-1', stopId: 's1' }, delivered());
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ flags: ['order_state_disagrees'], orderStep: 'disagrees' });
    expect(w.stops[0]).toMatchObject({ state: 'delivered', governanceFlags: ['order_state_disagrees'] });
    expect(w.orders).toEqual([]); // the order's register is untouched
    // Already where the phone says: nothing to step, nothing to flag.
    const w2 = world();
    w2.orders.push({ orderId: 'ORD-1', from: 'assigned', to: 'out_for_delivery', event: 'depart', by: 'u-dispatcher', at: NOW });
    const same = await post(w2, STOP, { routeId: 'R-1', stopId: 's1' }, stop());
    expect(same.body).toMatchObject({ flags: [], orderStep: 'already_there' });
    expect(w2.orders).toHaveLength(1);
  });

  it('flags — never refuses — an unknown or unauthorised driver, a hand-over with no proof kind (no order step), a geofence mismatch and a contribution flag', async () => {
    const w = world();
    const unknown = await post(w, STOP, { routeId: 'R-1', stopId: 's1' }, stop({ driverId: 'u-stranger' }));
    expect(unknown.body).toMatchObject({ flags: ['driver_unknown'] });
    const lacks = await post(w, STOP, { routeId: 'R-1', stopId: 's2' }, stop({ stopId: 's2', orderRef: 'ORD-2', driverId: 'u-floor' }));
    expect(lacks.body).toMatchObject({ flags: ['driver_lacks_authority'] });
    const noProof = await post(w, STOP, { routeId: 'R-1', stopId: 's1' }, delivered({ proofKind: null, geofenceMismatch: true, contributionFlag: 'cost 20% of value' }));
    expect(noProof.body).toMatchObject({ flags: ['geofence_mismatch', 'contribution_flagged', 'delivered_without_proof_kind'], orderStep: 'no_proof_kind' });
    expect(w.orders.map((o) => o.event)).toEqual(['depart', 'depart']); // no deliver step was written without a proof kind
  });

  it.each([
    ['a card method (hard rule #3)', delivered({ codMethod: 'card' })],
    ['a state nobody defined', stop({ state: 'teleported' })],
    ['a route id that disagrees with the path', stop({ routeId: 'R-9' })],
    ['a stop id that disagrees with the path', stop({ stopId: 's9' })],
    ['no driver', stop({ driverId: '' })],
    ['a fractional expected amount', stop({ codExpectedMinor: 12.5 })],
    ['a negative collected amount', delivered({ codCollectedMinor: -1 })],
    ['not an object', 'delivered'],
  ])('refuses %s as unreadable (400) — the box dead-letters it by name, nothing is recorded', async (_why, body) => {
    const w = world();
    await expect(post(w, STOP, { routeId: 'R-1', stopId: 's1' }, body)).rejects.toMatchObject({ status: 400, body: { code: 'not_readable_as_a_stop_outcome', wasItSaved: 'not_saved' } });
    expect(w.stops).toEqual([]);
    expect(w.orders).toEqual([]);
  });
});

describe('the settlement and the handover from the phone', () => {
  async function delivered250(w: World): Promise<void> {
    await post(w, STOP, { routeId: 'R-1', stopId: 's1' }, stop());
    await post(w, STOP, { routeId: 'R-1', stopId: 's1' }, delivered());
    await post(w, STOP, { routeId: 'R-1', stopId: 's2' }, stop({ stopId: 's2', orderRef: 'ORD-2', codExpectedMinor: 0 }));
    await post(w, STOP, { routeId: 'R-1', stopId: 's2' }, stop({ stopId: 's2', orderRef: 'ORD-2', codExpectedMinor: 0, state: 'failed', failureReason: 'nobody_home' }));
  }

  it('a settlement agreeing with the stops head office holds is recorded with no flags; one that disagrees, or found exceptions, is recorded WITH the flags', async () => {
    const w = world();
    await delivered250(w);
    const ok = await post(w, SETTLED, { routeId: 'R-1' }, settled());
    expect(ok.status).toBe(202);
    expect(ok.body).toMatchObject({ recorded: true, flags: [], fromStops: { expectedMinor: 250_00, collectedMinor: 250_00, cashHeldMinor: 250_00 } });
    expect(w.audit.at(-1)).toMatchObject({ actorId: 'u-driver', action: 'delivery.route.settle', objectId: 'R-1' });
    const w2 = world();
    await delivered250(w2);
    const off = await post(w2, SETTLED, { routeId: 'R-1' }, settled({ expectedMinor: 250_00, collectedMinor: 200_00, cashHeldMinor: 200_00, matchedCount: 0, exceptionCount: 1 }));
    expect(off.body).toMatchObject({ flags: ['stops_disagree', 'has_exceptions'], fromStops: { collectedMinor: 250_00 } });
    expect(w2.settlements[0]?.collectedMinor).toBe(200_00); // the phone's figure kept as the phone said it — beside the register's
    const again = await post(w2, SETTLED, { routeId: 'R-1' }, settled());
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ alreadyRecorded: true });
    expect(w2.settlements).toHaveLength(1);
  });

  it('a counted handover is recorded against the register\'s cash; a recorded figure the stops do not support and a material variance are said — the cash office decides', async () => {
    const w = world();
    await delivered250(w);
    const even = await post(w, HANDOVER, { routeId: 'R-1' }, handed());
    expect(even.status).toBe(202);
    expect(even.body).toMatchObject({ flags: [], fromStops: { cashHeldMinor: 250_00 } });
    expect(w.handovers[0]).toMatchObject({ countedMinor: 250_00, recordedMinor: 250_00, varianceMinor: 0, material: false, relayedBy: 'u-box', governanceFlags: [] });
    const w2 = world();
    await delivered250(w2);
    const short = await post(w2, HANDOVER, { routeId: 'R-1' }, handed({ countedMinor: 100_00, recordedMinor: 240_00, varianceMinor: -140_00, material: true, reasonCode: 'short' }));
    expect(short.body).toMatchObject({ flags: ['recorded_disagrees', 'cash_office_review'] });
    expect(w2.audit.at(-1)).toMatchObject({ action: 'delivery.cash.handover', after: { material: 'true', flags: 'recorded_disagrees,cash_office_review' } });
    const again = await post(w2, HANDOVER, { routeId: 'R-1' }, handed());
    expect(again.status).toBe(200);
    expect(w2.handovers).toHaveLength(1);
  });

  it.each([
    ['a settlement with no driver', SETTLED, settled({ driverId: '' })],
    ['a settlement with a fractional figure', SETTLED, settled({ collectedMinor: 1.5 })],
    ['a handover whose variance is not counted minus recorded', HANDOVER, handed({ varianceMinor: 5 })],
    ['a handover with no material verdict', HANDOVER, handed({ material: 'yes' })],
    ['a handover for another route', HANDOVER, handed({ routeId: 'R-9' })],
  ])('refuses %s as unreadable (400), nothing recorded', async (_why, path, body) => {
    const w = world();
    await expect(post(w, path, { routeId: 'R-1' }, body)).rejects.toMatchObject({ status: 400 });
    expect(w.settlements).toEqual([]);
    expect(w.handovers).toEqual([]);
  });
});

describe('the read', () => {
  it('shows the route as head office holds it: latest outcome per stop with history depth, the cash by the register, the settlement and handover or null, every flag once', async () => {
    const w = world();
    await post(w, STOP, { routeId: 'R-1', stopId: 's1' }, stop({ driverId: 'u-stranger' }));
    await post(w, STOP, { routeId: 'R-1', stopId: 's1' }, delivered({ driverId: 'u-stranger' }));
    const empty = await route(w, 'GET', '/v1/delivery/routes/:routeId').handler(ctx({ routeId: 'R-2' }));
    expect(empty.body).toMatchObject({ routeId: 'R-2', stops: [], settlement: null, handover: null, flags: [], stopCount: 0, cash: { cashHeldMinor: 0 }, asAt: NOW });
    const res = await route(w, 'GET', '/v1/delivery/routes/:routeId').handler(ctx({ routeId: 'R-1' }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      routeId: 'R-1', stopCount: 1, settlement: null, handover: null, flags: ['driver_unknown'], cash: { expectedMinor: 250_00, collectedMinor: 250_00, cashHeldMinor: 250_00 },
      stops: [{ stopId: 's1', state: 'delivered', outcomesRecorded: 2 }],
    });
    expect(presentRoute('R-1', w.stops, undefined, undefined)).toMatchObject({ stopCount: 1 });
    await expect(route(w, 'GET', '/v1/delivery/routes/:routeId').handler(ctx({ routeId: '' }))).rejects.toMatchObject({ status: 400 });
  });
});

describe('OB-09 — the stop joins the driver\'s run register (owner, 2 Oct 2026: Option 2 — partial delivery and "customer had no cash" are run outcomes in their own right)', () => {
  const depart = (w: World, stopId: string, orderRef: string, codExpectedMinor = 250_00) =>
    post(w, STOP, { routeId: 'R-1', stopId }, stop({ stopId, orderRef, state: 'out_for_delivery', codExpectedMinor }));
  const runOf = (w: World, cashHandedInMinor: number) =>
    reconcileRun({ driverId: 'u-driver', runDate: '2026-10-01', assignedOrderIds: ['ORD-1', 'ORD-2', 'ORD-3'], attempts: w.attempts, cashHandedInMinor });

  it('a full delivery, a PARTIAL delivery and a customer who had no cash each become the driver\'s own attempt — exact reason, quantities and cash kept — and the run counts them apart', async () => {
    const w = world();
    const gone = await depart(w, 's1', 'ORD-1');
    expect(gone.body).toMatchObject({ runAttempt: 'not_a_door_outcome', flags: [] });
    const d = await post(w, STOP, { routeId: 'R-1', stopId: 's1' }, delivered());
    expect(d.body).toMatchObject({ flags: [], runAttempt: { attemptId: 'R-1/s1/delivered', outcome: 'delivered', runDate: '2026-10-01' } });
    await depart(w, 's2', 'ORD-2', 300_00);
    const p = await post(w, STOP, { routeId: 'R-1', stopId: 's2' }, stop({ stopId: 's2', orderRef: 'ORD-2', state: 'partially_delivered', codExpectedMinor: 300_00, codCollectedMinor: 120_00, codMethod: 'cash', proofKind: 'photo' }));
    expect(p.body).toMatchObject({ flags: [], orderStep: { event: 'deliver_partial', to: 'partially_delivered' }, runAttempt: { outcome: 'partially_delivered' } });
    await depart(w, 's3', 'ORD-3', 450_00);
    const n = await post(w, STOP, { routeId: 'R-1', stopId: 's3' }, stop({ stopId: 's3', orderRef: 'ORD-3', state: 'failed', codExpectedMinor: 450_00, failureReason: 'customer_had_no_cash' }));
    expect(n.body).toMatchObject({ flags: [], orderStep: { event: 'fail', to: 'failed' }, runAttempt: { attemptId: 'R-1/s3/failed', outcome: 'customer_had_no_cash' } });
    expect(w.attempts).toEqual([
      { attemptId: 'R-1/s1/delivered', orderId: 'ORD-1', driverId: 'u-driver', attemptedAt: NOW, outcome: 'delivered', proofRef: 'otp@handheld:R-1/s1', cashCollectedMinor: 250_00, codExpectedMinor: 250_00 },
      { attemptId: 'R-1/s2/partially_delivered', orderId: 'ORD-2', driverId: 'u-driver', attemptedAt: NOW, outcome: 'partially_delivered', proofRef: 'photo@handheld:R-1/s2', cashCollectedMinor: 120_00, codExpectedMinor: 300_00 },
      { attemptId: 'R-1/s3/failed', orderId: 'ORD-3', driverId: 'u-driver', attemptedAt: NOW, outcome: 'customer_had_no_cash', notes: 'customer_had_no_cash', codExpectedMinor: 450_00 },
    ]);
    // The SAME `reconcileRun` the direct route and the dispatcher read: counted apart, the money held by name.
    const run = runOf(w, 370_00);
    expect(run).toMatchObject({
      attempts: 3, delivered: 1, partiallyDelivered: 1, failed: 1, customerHadNoCash: 1, cashExpectedMinor: 370_00, differenceMinor: 0,
      codUncollectedMinor: 450_00, noCashOrders: ['ORD-3'], partialRemainderMinor: 180_00, partialOrders: ['ORD-2'], outstanding: [], unassigned: [],
    });
    expect(run.detail).toBe('u-driver on 2026-10-01: 1 delivered, 1 partly delivered, 1 failed (1 because the customer had no cash), 0 not attempted, 0 not on the run');
    expect(run.ownerAction).toContain('1 customer(s) had no cash at the door: 45000 of cash-on-delivery is uncollected on ORD-3');
    expect(run.ownerAction).toContain("not u-driver's shortfall");
    // The read shows how each stop joined the run.
    const view = presentRoute('R-1', w.stops, undefined, undefined) as { stops: Array<Record<string, unknown>> };
    expect(view.stops.map((s) => [s['stopId'], (s['runAttempt'] as { outcome?: string }).outcome ?? s['runAttempt']])).toEqual([['s1', 'delivered'], ['s2', 'partially_delivered'], ['s3', 'customer_had_no_cash']]);
    // The audit says it too.
    expect(w.audit.map((e) => e.after?.['runAttempt'])).toEqual(['not_a_door_outcome', 'delivered', 'not_a_door_outcome', 'partially_delivered', 'not_a_door_outcome', 'customer_had_no_cash']);
  });

  it('maps every reason the phone offers onto the run register\'s closed list — the exact word travels as the note; a reason the run has no word for is kept on the stop and SAID, never guessed at', async () => {
    expect(FAILURE_REASON_OUTCOMES).toMatchObject({
      nobody_home: 'nobody_in', customer_refused: 'refused', wrong_address: 'wrong_address', address_not_found: 'could_not_access',
      customer_had_no_cash: 'customer_had_no_cash', goods_damaged: 'damaged_in_transit',
    });
    const w = world();
    const reasons = ['nobody_home', 'customer_refused', 'wrong_address', 'address_not_found', 'goods_damaged'];
    for (const [i, reason] of reasons.entries()) {
      await depart(w, `f${i}`, `ORD-${i}`);
      const r = await post(w, STOP, { routeId: 'R-1', stopId: `f${i}` }, stop({ stopId: `f${i}`, orderRef: `ORD-${i}`, state: 'failed', failureReason: reason }));
      expect(r.body).toMatchObject({ flags: [] });
    }
    expect(w.attempts.map((a) => [a.outcome, a.notes])).toEqual([
      ['nobody_in', 'nobody_home'], ['refused', 'customer_refused'], ['wrong_address', 'wrong_address'], ['could_not_access', 'address_not_found'], ['damaged_in_transit', 'goods_damaged'],
    ]);
    await depart(w, 'x1', 'ORD-9');
    const odd = await post(w, STOP, { routeId: 'R-1', stopId: 'x1' }, stop({ stopId: 'x1', orderRef: 'ORD-9', state: 'failed', failureReason: 'dog_at_the_gate' }));
    expect(odd.body).toMatchObject({ flags: ['run_outcome_unmapped'], runAttempt: 'unmapped' });
    await depart(w, 'x2', 'ORD-10');
    const none = await post(w, STOP, { routeId: 'R-1', stopId: 'x2' }, stop({ stopId: 'x2', orderRef: 'ORD-10', state: 'failed' }));
    expect(none.body).toMatchObject({ flags: ['run_outcome_unmapped'], runAttempt: 'unmapped' });
    expect(w.attempts).toHaveLength(5);
    expect(w.stops.filter((s) => s.runAttempt === 'unmapped').map((s) => s.failureReason)).toEqual(['dog_at_the_gate', null]);
    // The run then shows those orders as not attempted — visible, not reconciled against nothing.
    const run = reconcileRun({ driverId: 'u-driver', runDate: '2026-10-01', assignedOrderIds: ['ORD-9', 'ORD-10'], attempts: w.attempts, cashHandedInMinor: 0 });
    expect(run.outstanding).toEqual(['ORD-10', 'ORD-9']);
  });

  it('a hand-over with no proof kind is refused by the run register too (one flag, not two); a re-sent outcome is ONE attempt; the pure mapper names what is not a door outcome', async () => {
    const w = world();
    await depart(w, 's1', 'ORD-1');
    const bare = await post(w, STOP, { routeId: 'R-1', stopId: 's1' }, delivered({ proofKind: null }));
    expect(bare.body).toMatchObject({ flags: ['delivered_without_proof_kind'], orderStep: 'no_proof_kind', runAttempt: 'refused' });
    expect(w.attempts).toEqual([]);
    const w2 = world();
    await depart(w2, 's1', 'ORD-1');
    await post(w2, STOP, { routeId: 'R-1', stopId: 's1' }, delivered());
    const again = await post(w2, STOP, { routeId: 'R-1', stopId: 's1' }, delivered());
    expect(again.body).toMatchObject({ alreadyRecorded: true, runAttempt: { outcome: 'delivered' } });
    expect(w2.attempts).toHaveLength(1);
    for (const state of ['assigned', 'picked_up', 'out_for_delivery', 'attempted', 'returned_to_origin'] as const) {
      expect(attemptFromStop({ ...stop({ state }), at: NOW } as Parameters<typeof attemptFromStop>[0], 'R-1', 's1')).toBe('not_a_door_outcome');
    }
    // Cash recorded against a door where nothing changed hands: the run register refuses it, the stop is kept and flagged.
    const w3 = world();
    await depart(w3, 's1', 'ORD-1');
    const cashy = await post(w3, STOP, { routeId: 'R-1', stopId: 's1' }, stop({ state: 'failed', failureReason: 'customer_refused', codCollectedMinor: 50_00, codMethod: 'cash' }));
    expect(cashy.body).toMatchObject({ flags: ['run_outcome_refused'], runAttempt: 'refused' });
    expect(w3.attempts).toEqual([]);
  });
});
