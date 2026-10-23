// API-08 — the dispatch office: plan the day's routes from the CONFIRMED delivery orders head office holds, hand each route
// to a driver, take a route back when a driver is off the road, and watch every route's doors and cash (M19-FR-03/04 ·
// WF-15 · D08 · D09-FR-05 · OB-294 · OB-313 · §28 · hard rules #2/#6/#10).
//
//   POST /v1/delivery/dispatch/:runDate/plan-from-orders        { storeId, drivers[], averageSpeedKmh, serviceMinutesPerStop }
//   POST /v1/delivery/dispatch/:runDate/routes/:routeId/assign  { storeId } — the planned route, to its driver
//   POST /v1/delivery/dispatch/:runDate/reassign-driver         { storeId, withoutDriverId, reason, drivers[], … }
//   GET  /v1/delivery/dispatch/:runDate/board?storeId=          every route: assigned or not, each door, the proofs, the cash
//
// The orders are head office's own: the store's delivery orders that are confirmed, being picked or packed, whose booked
// slot falls on the run date, each with the address coordinates stored when the slot was booked. Nothing about an order is
// taken from the body. An order the contribution rule holds for a manager (OB-313) is not planned, and is listed by name.
// Distances are straight lines and every plan says so (the tested `planDispatch`); speed and minutes per stop are the
// dispatcher's figures for the day, entered on the screen, never assumed here.
//
// Handing a route to a driver writes the SAME route register the assignment route writes (the box pulls it for the
// driver's phone), re-verifies the driver, refuses a settled route and an order already on another live route, issues each
// order's delivery code (OB-294) and records where each order sits on the route — the index the customer's ETA and the
// proof-location check read. Taking a route back is refused once any door on it has been recorded: goods and cash are then
// in the van, and that is settled, not withdrawn.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { planDispatch, type DispatchPlan, type DeliverableOrder, type DispatchDriver } from '../../../packages/fulfilment/src/index';
import { assignmentDigest, latestRoutes, requireAuthority, DRIVE_PERMISSION, type AssignedRouteStop, type RouteAssignment } from './assignments';
import { cashFromStops, latestStops, type CashHandoverRecord, type RouteSettlementRecord, type RouteStopUpdate } from './driver-runs';
import { mayGoOut, type ContributionStanding } from './delivery-controls';
import type { CandidateOrder } from './wave-builder';
import type { OrderStop } from './delivery-proof';

export interface DeliveryBooking {
  readonly slotStartsAt: string;
  readonly slotEndsAt: string;
  /** The address coordinates stored when the slot was booked. Absent on bookings made before they were kept. */
  readonly deliveryLocation?: { readonly lat: number; readonly lon: number };
}

export interface DispatchBoardDeps {
  readonly permissionsOfUser: (tenantId: string, userId: string) => Promise<readonly string[] | undefined>;
  readonly ordersAt: (tenantId: string, storeId: string) => Promise<readonly CandidateOrder[]>;
  readonly bookingOf: (tenantId: string, orderId: string) => Promise<DeliveryBooking | undefined>;
  /** The shop's wall clock for an instant, `YYYY-MM-DDTHH:MM…` in the store's time zone. */
  readonly shopClock: (tenantId: string, iso: string) => Promise<string>;
  readonly storeLocation: (tenantId: string) => Promise<{ readonly lat: number; readonly lon: number } | undefined>;
  /** The serviceable radius in force on a day (D08). */
  readonly radiusOn: (tenantId: string, day: string) => Promise<number>;
  /** What is still to be collected at the door, in paise (0 when paid in full). */
  readonly codOf: (tenantId: string, orderId: string) => Promise<number>;
  readonly orderValueOf: (tenantId: string, orderId: string) => Promise<number | undefined>;
  readonly standing: (tenantId: string, orderId: string) => Promise<ContributionStanding>;
  readonly plan: (tenantId: string, runDate: string) => Promise<DispatchPlan | undefined>;
  readonly recordPlan: (tenantId: string, runDate: string, plan: DispatchPlan, key: string) => Promise<void>;
  readonly routeAssignments: (tenantId: string, storeId: string) => Promise<readonly RouteAssignment[]>;
  readonly recordRouteAssignment: (tenantId: string, a: RouteAssignment) => Promise<void>;
  readonly routeSettled: (tenantId: string, routeId: string) => Promise<boolean>;
  readonly stopUpdates: (tenantId: string, routeId: string) => Promise<readonly RouteStopUpdate[]>;
  readonly settlement: (tenantId: string, routeId: string) => Promise<RouteSettlementRecord | undefined>;
  readonly handover: (tenantId: string, routeId: string) => Promise<CashHandoverRecord | undefined>;
  readonly recordOrderStop: (tenantId: string, s: OrderStop) => Promise<void>;
  /** Issue the order's delivery code if it has none (OB-294) — once, whoever asks first. */
  readonly issueCode: (tenantId: string, orderId: string) => Promise<void>;
  readonly imageCount: (tenantId: string, orderId: string) => Promise<number>;
  readonly now: () => string;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const OUT_GOING = new Set(['confirmed', 'picking', 'packed']);

function readDrivers(v: unknown): DispatchDriver[] | undefined {
  if (!Array.isArray(v) || v.length === 0 || v.length > 100) return undefined;
  const out: DispatchDriver[] = [];
  const ids = new Set<string>();
  for (const d of v) {
    if (!isObj(d) || !isStr(d['driverId']) || !Number.isInteger(d['maxStops']) || (d['maxStops'] as number) < 1
      || !isStr(d['availableFrom']) || Number.isNaN(Date.parse(d['availableFrom'])) || !isStr(d['availableUntil']) || Number.isNaN(Date.parse(d['availableUntil']))
      || ids.has(d['driverId'])) return undefined;
    ids.add(d['driverId']);
    out.push({ driverId: d['driverId'].trim(), maxStops: d['maxStops'] as number, availableFrom: new Date(Date.parse(d['availableFrom'])).toISOString(), availableUntil: new Date(Date.parse(d['availableUntil'])).toISOString() });
  }
  return out;
}

/** The day's delivery orders for a store, split into those that may be planned and those the contribution rule holds. */
export async function dayOrders(deps: DispatchBoardDeps, tenantId: string, storeId: string, runDate: string): Promise<{
  readonly deliverable: readonly DeliverableOrder[];
  readonly held: readonly { readonly orderId: string; readonly standing: ContributionStanding }[];
  readonly locationOf: ReadonlyMap<string, { readonly lat: number; readonly lon: number }>;
  readonly bookingOf: ReadonlyMap<string, DeliveryBooking>;
}> {
  const deliverable: DeliverableOrder[] = [];
  const held: { orderId: string; standing: ContributionStanding }[] = [];
  const locationOf = new Map<string, { lat: number; lon: number }>();
  const bookings = new Map<string, DeliveryBooking>();
  for (const o of await deps.ordersAt(tenantId, storeId)) {
    if (o.fulfilment !== 'delivery' || !OUT_GOING.has(o.state)) continue;
    const booking = await deps.bookingOf(tenantId, o.orderId);
    if (booking === undefined) continue;
    const opens = await deps.shopClock(tenantId, booking.slotStartsAt);
    if (opens.slice(0, 10) !== runDate) continue;
    bookings.set(o.orderId, booking);
    const standing = await deps.standing(tenantId, o.orderId);
    if (!mayGoOut(standing)) { held.push({ orderId: o.orderId, standing }); continue; }
    const value = await deps.orderValueOf(tenantId, o.orderId);
    if (booking.deliveryLocation !== undefined) locationOf.set(o.orderId, booking.deliveryLocation);
    deliverable.push({
      orderId: o.orderId, slotId: booking.slotStartsAt, slotStartsAt: booking.slotStartsAt, slotEndsAt: booking.slotEndsAt,
      // The phone is told a coarse label, never the address record (§31): the booked window in shop time. The door itself
      // travels on the parcel's label, not on the phone.
      area: `Slot ${opens.slice(11, 16)}–${(await deps.shopClock(tenantId, booking.slotEndsAt)).slice(11, 16)}`,
      ...(booking.deliveryLocation === undefined ? {} : { location: booking.deliveryLocation }),
      codMinor: await deps.codOf(tenantId, o.orderId),
      ...(value === undefined ? {} : { orderValueMinor: value }),
    });
  }
  deliverable.sort((a, b) => a.orderId.localeCompare(b.orderId));
  return { deliverable, held, locationOf, bookingOf: bookings };
}

/** The routes of a run date at a store as the register holds them (latest record per route). */
async function runRoutes(deps: DispatchBoardDeps, tenantId: string, storeId: string, runDate: string): Promise<readonly RouteAssignment[]> {
  return latestRoutes(await deps.routeAssignments(tenantId, storeId)).filter((r) => r.routeId.startsWith(`${runDate}:`));
}

export function dispatchBoardRoutes(deps: DispatchBoardDeps): readonly Route[] {
  const runDateOf = (p: Readonly<Record<string, string>>): string => {
    const runDate = p['runDate'] ?? '';
    if (!DAY.test(runDate)) throw apiError(400, { code: 'bad_run_date', whatHappened: 'The run date is written YYYY-MM-DD.', wasItSaved: 'not_saved', nextSafeAction: 'Send the date again. Nothing was changed.' });
    return runDate;
  };
  const storeIn = (v: unknown): string => {
    if (!isStr(v)) throw apiError(400, { code: 'store_needed', whatHappened: 'Say which store: storeId.', wasItSaved: 'not_saved', nextSafeAction: 'Send the store. Nothing was changed.' });
    return v.trim();
  };
  /** Plan from head office's own orders; the dispatcher's drivers and the day's speed and minutes per stop. */
  const planFor = async (tenantId: string, storeId: string, runDate: string, b: Record<string, unknown>, withoutDriverId?: string) => {
    const drivers = readDrivers(b['drivers']);
    if (drivers === undefined || !isNum(b['averageSpeedKmh']) || b['averageSpeedKmh'] <= 0 || b['averageSpeedKmh'] > 120
      || !isNum(b['serviceMinutesPerStop']) || b['serviceMinutesPerStop'] < 0 || b['serviceMinutesPerStop'] > 120) {
      throw apiError(400, {
        code: 'not_readable_as_a_dispatch',
        whatHappened: 'Planning needs { storeId, drivers: [{ driverId, maxStops (1 or more), availableFrom, availableUntil }], averageSpeedKmh (above 0), serviceMinutesPerStop } — the day\'s figures, from the dispatcher.',
        wasItSaved: 'not_saved',
        nextSafeAction: 'Enter the drivers on shift and the day\'s speed and minutes per stop. Nothing was planned.',
      });
    }
    const storeLocation = await deps.storeLocation(tenantId);
    if (storeLocation === undefined) {
      throw apiError(409, { code: 'delivery_not_set_up', whatHappened: 'Head office has no delivery service on record (where the store is), so no route can be planned from it.', wasItSaved: 'not_saved', nextSafeAction: 'Set up the delivery service first. Nothing was planned.' });
    }
    const day = await dayOrders(deps, tenantId, storeId, runDate);
    const plan = planDispatch({
      runDate, orders: day.deliverable,
      drivers: drivers.filter((d) => d.driverId !== withoutDriverId),
      policy: { storeLocation, radiusMetres: await deps.radiusOn(tenantId, runDate), averageSpeedKmh: b['averageSpeedKmh'] as number, serviceMinutesPerStop: b['serviceMinutesPerStop'] as number },
    });
    if (plan.accountedFor !== day.deliverable.length) throw new Error(`dispatch plan accounted for ${plan.accountedFor} of ${day.deliverable.length} orders`);
    return { plan, held: day.held };
  };

  return [
    {
      api: 'API-08', method: 'POST', path: '/v1/delivery/dispatch/:runDate/plan-from-orders',
      permission: 'delivery.dispatch.manage', entitlement: 'delivery', idempotent: true,
      handler: async (ctx) => {
        const runDate = runDateOf(ctx.params);
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const storeId = storeIn(b['storeId']);
        const { plan, held } = await planFor(ctx.tenantId, storeId, runDate, b);
        await deps.recordPlan(ctx.tenantId, runDate, plan, ctx.idempotencyKey ?? `plan-${runDate}-${deps.now()}`);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'delivery.dispatch.plan', objectType: 'delivery_run', objectId: runDate,
          at: deps.now(), origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: null,
          after: { storeId, routes: String(plan.routes.length), unplanned: plan.unplanned.map((u) => `${u.orderId}:${u.reason}`).join(','), held: held.map((h) => h.orderId).join(',') },
          correlationId: runDate,
        });
        return { status: 200, body: { runDate, storeId, plan, held } };
      },
    },
    {
      api: 'API-08', method: 'POST', path: '/v1/delivery/dispatch/:runDate/routes/:routeId/assign',
      permission: 'delivery.dispatch.manage', entitlement: 'delivery', idempotent: true,
      handler: async (ctx) => {
        const runDate = runDateOf(ctx.params);
        const routeId = (ctx.params['routeId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const storeId = storeIn(b['storeId']);
        const plan = await deps.plan(ctx.tenantId, runDate);
        const planned = plan?.routes.find((r) => r.routeId === routeId);
        if (planned === undefined) {
          throw apiError(404, { code: 'route_not_planned', whatHappened: `No route ${routeId} is on the plan for ${runDate}.`, wasItSaved: 'not_saved', nextSafeAction: 'Plan the day first, then hand each route to its driver. Nothing was assigned.' });
        }
        await requireAuthority(deps, ctx.tenantId, planned.driverId, DRIVE_PERMISSION, 'driver');
        if (await deps.routeSettled(ctx.tenantId, routeId)) {
          throw apiError(409, { code: 'route_already_settled', whatHappened: `Route ${routeId} has already been settled, so it cannot be handed out again.`, wasItSaved: 'not_saved', nextSafeAction: 'Re-plan; a new route gets a new id. Nothing was changed.' });
        }
        const live = (await runRoutes(deps, ctx.tenantId, storeId, runDate)).filter((r) => r.routeId !== routeId && r.withdrawn === undefined);
        const clash: string[] = [];
        for (const r of live) {
          if (await deps.routeSettled(ctx.tenantId, r.routeId)) continue;
          for (const s of r.stops) if (planned.stops.some((p) => p.orderId === s.orderRef)) clash.push(`${s.orderRef} (on ${r.routeId})`);
        }
        if (clash.length > 0) {
          throw apiError(409, { code: 'already_on_a_route', whatHappened: `These orders are already on another driver's live route: ${clash.join(', ')}. An order is never sent twice.`, wasItSaved: 'not_saved', nextSafeAction: 'Take the other route back first (driver off the road), then hand this one out. Nothing was assigned.' });
        }
        const stops: AssignedRouteStop[] = planned.stops.map((s) => ({ stopId: s.stopId, orderRef: s.orderId, area: s.area, codMinor: s.codMinor, ...(s.orderValueMinor === undefined ? {} : { orderValueMinor: s.orderValueMinor }) }));
        const current = latestRoutes(await deps.routeAssignments(ctx.tenantId, storeId)).find((a) => a.routeId === routeId);
        // The same content as the assignment route's digest — and, after a route was taken back, a new record of its own (the
        // register's key is the digest, so handing the same stops out again must not read as the earlier record).
        const digest = assignmentDigest(current?.withdrawn === undefined
          ? { driverId: planned.driverId, stops, contributionRule: null }
          : { driverId: planned.driverId, stops, contributionRule: null, reissuedAfter: current.withdrawn.at });
        const day = await dayOrders(deps, ctx.tenantId, storeId, runDate);
        const now = deps.now();
        // The index the ETA and the proof-location check read — and each order's code, issued once (OB-294).
        const indexStops = async (): Promise<void> => {
          for (const s of planned.stops) {
            const booking = day.bookingOf.get(s.orderId);
            await deps.issueCode(ctx.tenantId, s.orderId);
            await deps.recordOrderStop(ctx.tenantId, {
              orderId: s.orderId, routeId, stopId: s.stopId, runDate, sequence: s.sequence, plannedArrivalAt: s.estimatedArrivalAt,
              // The address coordinates are NOT copied here: the proof-location check reads them from the booking, where they
              // are sealed under the customer's key and erased with them (ADR-0025).
              slotStartsAt: booking?.slotStartsAt ?? planned.startsAt, slotEndsAt: booking?.slotEndsAt ?? planned.estimatedReturnAt, assignedAt: now,
            });
          }
        };
        if (current !== undefined && current.digest === digest && current.withdrawn === undefined) {
          await indexStops();
          return { status: 200, body: { routeId, storeId, driverId: planned.driverId, stopCount: stops.length, assigned: true, alreadyAssigned: true } };
        }
        const record: RouteAssignment = { routeId, storeId, driverId: planned.driverId, stops, assignedBy: ctx.userId, at: now, digest };
        await deps.recordRouteAssignment(ctx.tenantId, record);
        await indexStops();
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'delivery.route.assign', objectType: 'delivery_route', objectId: routeId,
          at: now, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: current === undefined ? null : { driverId: current.driverId, stopCount: String(current.stops.length), withdrawn: String(current.withdrawn !== undefined) },
          after: { storeId, driverId: planned.driverId, stopCount: String(stops.length), codMinor: String(stops.reduce((n, s) => n + s.codMinor, 0)), from: 'dispatch plan' },
          correlationId: routeId,
        });
        return { status: 201, body: { routeId, storeId, driverId: planned.driverId, stopCount: stops.length, assigned: true, replaced: current !== undefined } };
      },
    },
    {
      // A driver is off the road: take back each of their routes for the day that no door has been recorded on (a new,
      // withdrawn record — the assignment stays on the register), then re-plan the day without them (a FULL re-plan).
      api: 'API-08', method: 'POST', path: '/v1/delivery/dispatch/:runDate/reassign-driver',
      permission: 'delivery.dispatch.manage', entitlement: 'delivery', idempotent: true,
      handler: async (ctx) => {
        const runDate = runDateOf(ctx.params);
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const storeId = storeIn(b['storeId']);
        if (!isStr(b['withoutDriverId']) || !isStr(b['reason']) || b['reason'].trim().length < 5) {
          throw apiError(400, { code: 'reassign_needs_a_driver_and_a_reason', whatHappened: 'Taking routes back needs { withoutDriverId, reason } — who is off the road, and why, in a few words.', wasItSaved: 'not_saved', nextSafeAction: 'Send the driver and the reason. Nothing was changed.' });
        }
        const without = (b['withoutDriverId'] as string).trim();
        const theirs = (await runRoutes(deps, ctx.tenantId, storeId, runDate)).filter((r) => r.driverId === without && r.withdrawn === undefined);
        const started: string[] = [];
        for (const r of theirs) if ((await deps.stopUpdates(ctx.tenantId, r.routeId)).length > 0 || (await deps.routeSettled(ctx.tenantId, r.routeId))) started.push(r.routeId);
        if (started.length > 0) {
          throw apiError(409, { code: 'route_started', whatHappened: `${without} has already recorded doors on ${started.join(', ')} — the goods and the cash are in the van, so that route is settled at the end of the shift, not taken back.`, wasItSaved: 'not_saved', nextSafeAction: 'Have the driver return the remaining parcels (back to store) and settle. Nothing was changed.' });
        }
        // Re-plan first: a body that cannot be read changes nothing.
        const { plan, held } = await planFor(ctx.tenantId, storeId, runDate, b, without);
        const now = deps.now();
        const reason = (b['reason'] as string).trim();
        for (const r of theirs) {
          const withdrawn: RouteAssignment = { ...r, assignedBy: ctx.userId, at: now, withdrawn: { by: ctx.userId, at: now, reason }, digest: assignmentDigest({ withdrawn: r.digest, at: now }) };
          await deps.recordRouteAssignment(ctx.tenantId, withdrawn);
          await deps.recordAudit?.(ctx.tenantId, {
            actorId: ctx.userId, action: 'delivery.route.withdraw', objectType: 'delivery_route', objectId: r.routeId,
            at: now, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
            before: { driverId: r.driverId, stopCount: String(r.stops.length) }, after: { withdrawn: 'true', reason }, reason, correlationId: r.routeId,
          });
        }
        await deps.recordPlan(ctx.tenantId, runDate, plan, ctx.idempotencyKey ?? `reassign-${runDate}-${now}`);
        return { status: 200, body: { runDate, storeId, withdrawn: theirs.map((r) => r.routeId), plan, held } };
      },
    },
    {
      api: 'API-08', method: 'GET', path: '/v1/delivery/dispatch/:runDate/board',
      permission: 'delivery.run.read', entitlement: 'delivery',
      handler: async (ctx) => {
        const runDate = runDateOf(ctx.params);
        const storeId = storeIn(ctx.query['storeId']);
        const plan = (await deps.plan(ctx.tenantId, runDate)) ?? null;
        const assigned = new Map((await runRoutes(deps, ctx.tenantId, storeId, runDate)).map((r) => [r.routeId, r] as const));
        const ids = [...new Set([...(plan?.routes.map((r) => r.routeId) ?? []), ...assigned.keys()])].sort();
        const routes: Record<string, unknown>[] = [];
        for (const routeId of ids) {
          const a = assigned.get(routeId);
          const planned = plan?.routes.find((r) => r.routeId === routeId);
          const history = await deps.stopUpdates(ctx.tenantId, routeId);
          const latest = new Map(latestStops(history).map((u) => [u.stopId, u] as const));
          const settled = await deps.routeSettled(ctx.tenantId, routeId);
          const stopIds = planned?.stops.map((s) => ({ stopId: s.stopId, orderRef: s.orderId, sequence: s.sequence, plannedArrivalAt: s.estimatedArrivalAt as string | null, missesTheWindow: s.missesTheWindow, codMinor: s.codMinor }))
            ?? a?.stops.map((s, i) => ({ stopId: s.stopId, orderRef: s.orderRef, sequence: i + 1, plannedArrivalAt: null, missesTheWindow: false, codMinor: s.codMinor })) ?? [];
          const stops = [];
          for (const s of stopIds) {
            const u = latest.get(s.stopId);
            stops.push({
              ...s, state: u?.state ?? 'assigned', at: u?.at ?? null, flags: u?.governanceFlags ?? [],
              proofKind: u?.proofKind ?? null, proofCheck: u?.proofCheck ?? null, imagesKept: await deps.imageCount(ctx.tenantId, s.orderRef),
              codCollectedMinor: u?.codCollectedMinor ?? 0, failureReason: u?.failureReason ?? null,
            });
          }
          routes.push({
            routeId, driverId: a?.driverId ?? planned?.driverId ?? null, slotId: planned?.slotId ?? null, startsAt: planned?.startsAt ?? null,
            status: settled ? 'settled' : a === undefined ? 'not_assigned' : a.withdrawn !== undefined ? 'withdrawn' : 'assigned',
            ...(a?.withdrawn === undefined ? {} : { withdrawn: a.withdrawn }),
            stops, cash: { fromStops: cashFromStops(history), settlement: (await deps.settlement(ctx.tenantId, routeId)) ?? null, handover: (await deps.handover(ctx.tenantId, routeId)) ?? null },
            flags: [...new Set(history.flatMap((u) => u.governanceFlags))],
          });
        }
        const day = await dayOrders(deps, ctx.tenantId, storeId, runDate);
        return { status: 200, body: { runDate, storeId, plan: plan === null ? null : { unplanned: plan.unplanned, distancesAre: plan.distancesAre, contributionFlags: plan.contributionFlags }, routes, held: day.held, asAt: deps.now() } };
      },
    },
  ];
}
