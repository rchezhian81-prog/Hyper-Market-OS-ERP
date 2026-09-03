// API-08 Dispatch planning & run assignment (M19-FR-03/04 / D08 / D09) — turning today's confirmed orders
// into routes somebody can drive, on the live API over the tested `packages/fulfilment` routing engine.
//
// Until this, nothing dispatched, and `reconcileRun` was given an empty assignment list — so **every
// delivery a driver actually made came back as one nobody had dispatched**, goods out of the building
// against orders no run could account for. This wires the plan, persists it, and (in the fulfilment adapter)
// feeds `reconcileRun` the order ids each run is answerable for.
//
// Stated plainly, because the alternative is a lie: the plan is a **draft a dispatcher confirms**, built on
// STRAIGHT-LINE distances (no map, no roads, no traffic) — every result carries `distancesAre:'straight_line'`
// and ETAs marked as estimates. What it guarantees instead is that **every order goes somewhere**: on a route
// or on the unplanned list with a named reason (no coordinates / out of area / no driver), never silently
// dropped. Windows beat geography — a stop is never moved into a later slot for a shorter route.
//
// A driver going off the road is a FULL re-plan (`reassign`), not a patch that appends their stops to whoever
// has room. Plan/reassign gated `delivery.dispatch.manage`; reading the stored plan reads `delivery.run.read`.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  planDispatch, reassign,
  type DispatchPlan, type DeliverableOrder, type DispatchDriver, type RoutingPolicy,
} from '../../../packages/fulfilment/src/index';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function readLocation(v: unknown): { readonly lat: number; readonly lon: number } | undefined {
  if (!isObj(v) || !isNum(v['lat']) || !isNum(v['lon'])) return undefined;
  return { lat: v['lat'] as number, lon: v['lon'] as number };
}

function readOrder(v: unknown): DeliverableOrder | undefined {
  if (!isObj(v) || !isStr(v['orderId']) || !isStr(v['slotId']) || !isStr(v['slotStartsAt']) || !isStr(v['slotEndsAt']) || !isStr(v['area']) || !isInt(v['codMinor'])) return undefined;
  if (v['location'] !== undefined && readLocation(v['location']) === undefined) return undefined;
  if (v['orderValueMinor'] !== undefined && !isInt(v['orderValueMinor'])) return undefined;
  const location = v['location'] === undefined ? undefined : readLocation(v['location']);
  return {
    orderId: v['orderId'] as string, slotId: v['slotId'] as string, slotStartsAt: v['slotStartsAt'] as string,
    slotEndsAt: v['slotEndsAt'] as string, area: v['area'] as string, codMinor: v['codMinor'] as number,
    ...(location !== undefined ? { location } : {}),
    ...(isInt(v['orderValueMinor']) ? { orderValueMinor: v['orderValueMinor'] as number } : {}),
  };
}

function readDriver(v: unknown): DispatchDriver | undefined {
  if (!isObj(v) || !isStr(v['driverId']) || !isInt(v['maxStops']) || (v['maxStops'] as number) < 0 || !isStr(v['availableFrom']) || !isStr(v['availableUntil'])) return undefined;
  return { driverId: v['driverId'] as string, maxStops: v['maxStops'] as number, availableFrom: v['availableFrom'] as string, availableUntil: v['availableUntil'] as string };
}

function readPolicy(v: unknown): RoutingPolicy | undefined {
  if (!isObj(v)) return undefined;
  const store = readLocation(v['storeLocation']);
  if (store === undefined || !isNum(v['radiusMetres']) || (v['radiusMetres'] as number) < 0
    || !isNum(v['averageSpeedKmh']) || (v['averageSpeedKmh'] as number) <= 0 || !isNum(v['serviceMinutesPerStop']) || (v['serviceMinutesPerStop'] as number) < 0) {
    return undefined;
  }
  let contributionRule: { readonly maxCostShareBps: number } | undefined;
  if (v['contributionRule'] !== undefined) {
    if (!isObj(v['contributionRule']) || !isInt((v['contributionRule'] as Record<string, unknown>)['maxCostShareBps'])) return undefined;
    contributionRule = { maxCostShareBps: (v['contributionRule'] as Record<string, unknown>)['maxCostShareBps'] as number };
  }
  return {
    storeLocation: store, radiusMetres: v['radiusMetres'] as number, averageSpeedKmh: v['averageSpeedKmh'] as number,
    serviceMinutesPerStop: v['serviceMinutesPerStop'] as number,
    ...(contributionRule !== undefined ? { contributionRule } : {}),
  };
}

function readAll<T>(v: unknown, read: (x: unknown) => T | undefined): readonly T[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: T[] = [];
  for (const item of v) {
    const one = read(item);
    if (one === undefined) return undefined;
    out.push(one);
  }
  return out;
}

/** Read { orders[], drivers[], policy } — the shared body of plan and reassign. */
function readInputs(b: Record<string, unknown>): { orders: readonly DeliverableOrder[]; drivers: readonly DispatchDriver[]; policy: RoutingPolicy } | undefined {
  const orders = readAll(b['orders'], readOrder);
  const drivers = readAll(b['drivers'], readDriver);
  const policy = readPolicy(b['policy']);
  if (orders === undefined || drivers === undefined || policy === undefined) return undefined;
  return { orders, drivers, policy };
}

const badInputs = () => apiError(400, {
  code: 'not_readable_as_a_dispatch',
  whatHappened: 'A dispatch needs { orders[] } (orderId, slotId, slotStartsAt, slotEndsAt, area, codMinor, optional location{lat,lon}), { drivers[] } (driverId, maxStops, availableFrom, availableUntil) and a { policy } (storeLocation{lat,lon}, radiusMetres, averageSpeedKmh, serviceMinutesPerStop).',
  wasItSaved: 'not_saved',
  nextSafeAction: 'Send today’s confirmed orders, the drivers on shift, and the tenant’s routing policy.',
});

export interface DispatchDeps {
  /** The stored plan for a run date, if one has been made. Latest plan/reassign wins. */
  readonly plan: (tenantId: string, runDate: string) => Promise<DispatchPlan | undefined> | DispatchPlan | undefined;
  /** Persist a plan for a run date (append-only; a re-plan supersedes). */
  readonly recordPlan: (tenantId: string, runDate: string, plan: DispatchPlan, key: string) => Promise<void> | void;
  readonly now: () => string;
}

export function dispatchRoutes(deps: DispatchDeps): readonly Route[] {
  return [
    {
      // PLAN — draft today's routes. Every order is routed or on the unplanned list with a reason.
      api: 'API-08', method: 'POST', path: '/v1/delivery/dispatch/:runDate/plan',
      permission: 'delivery.dispatch.manage', idempotent: true,
      handler: async (ctx) => {
        const runDate = ctx.params['runDate'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const input = readInputs(b);
        if (input === undefined) throw badInputs();
        const plan = planDispatch({ runDate, ...input });
        await deps.recordPlan(ctx.tenantId, runDate, plan, ctx.idempotencyKey ?? `plan-${runDate}-${deps.now()}`);
        return { status: 200, body: { runDate, plan } };
      },
    },
    {
      // REASSIGN — a driver is off the road: a FULL re-plan without them (not a patch). Supersedes the plan.
      api: 'API-08', method: 'POST', path: '/v1/delivery/dispatch/:runDate/reassign',
      permission: 'delivery.dispatch.manage', idempotent: true,
      handler: async (ctx) => {
        const runDate = ctx.params['runDate'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const input = readInputs(b);
        if (input === undefined) throw badInputs();
        if (!isStr(b['withoutDriverId'])) {
          throw apiError(400, { code: 'reassign_needs_a_driver', whatHappened: 'A reassignment needs the { withoutDriverId } who has gone off the road.', wasItSaved: 'not_saved', nextSafeAction: 'Send the driver to re-plan without.' });
        }
        const plan = reassign({ runDate, ...input, withoutDriverId: b['withoutDriverId'] as string });
        await deps.recordPlan(ctx.tenantId, runDate, plan, ctx.idempotencyKey ?? `reassign-${runDate}-${deps.now()}`);
        return { status: 200, body: { runDate, plan } };
      },
    },
    {
      // READ the stored plan for a run date.
      api: 'API-08', method: 'GET', path: '/v1/delivery/dispatch/:runDate',
      permission: 'delivery.run.read',
      handler: async (ctx) => {
        const runDate = ctx.params['runDate'] ?? '';
        const plan = await deps.plan(ctx.tenantId, runDate);
        if (plan === undefined) {
          throw apiError(404, { code: 'no_dispatch_plan', whatHappened: `No dispatch has been planned for ${runDate}.`, wasItSaved: 'not_saved', nextSafeAction: 'Plan it with POST /v1/delivery/dispatch/' + runDate + '/plan.' });
        }
        return { status: 200, body: { runDate, plan, asAt: deps.now() } };
      },
    },
  ];
}
