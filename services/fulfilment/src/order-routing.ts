// API-07 / API-08 — which branch fulfils an online order (D09-FR-01 · M18-FR-03 · R8-1 · OB-300 · P-02 · hard rule #10).
//
//   POST /v1/delivery/locations/:locationId          the manager records a branch or dark store: where it is, what it serves
//   GET  /v1/delivery/locations                      the register
//   POST /v1/storefront/route-order/:orderId         the CUSTOMER's basket, before it is placed: which branch can fulfil it
//   GET  /v1/fulfilment/orders/:orderId/routing      every routing decision made for an order, with its reason
//
// The tested `routeOrder` decides, in its own order of checks: can this place serve the method → is the address in its
// radius → does it hold the WHOLE order now → is there room in the slot. The nearest that passes is chosen and the reason is
// recorded; a full slot falls through to the next branch that can do it. OB-300 (owner, 23 Oct 2026): an online order is
// NEVER split across branches — when no single branch holds every line, the answer is "not routed" with the branches in
// range listed, never two parcels from two shops. Stock is head office's own (on hand less what is held for other orders);
// a slot's room is the branch's own capacity less the orders already routed to it for that slot. Nothing is reserved here:
// the order is placed — and its stock held — at the chosen branch by the storefront's own placement.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { routeOrder, metresBetween, type FulfilmentLocation, type FulfilmentMethod, type LocationStock, type RouteResult, type SlotCapacity } from '../../../packages/orders/src/fulfilment-plan';

/** A branch or dark store as the manager recorded it. */
export interface RoutingLocation extends FulfilmentLocation {
  /** Delivery orders this location can take in one slot. Absent: no limit recorded (the slot's own capacity still binds at placement). */
  readonly capacityPerSlot?: number;
  readonly setBy: string;
  readonly setAt: string;
}

export interface RoutingDecision {
  readonly orderId: string;
  readonly customerRef: string;
  readonly method: FulfilmentMethod;
  readonly slotStartsAt: string | null;
  readonly result: RouteResult;
  readonly at: string;
}

export interface OrderRoutingDeps {
  readonly locations: (tenantId: string) => Promise<readonly RoutingLocation[]>;
  readonly recordLocation: (tenantId: string, l: RoutingLocation) => Promise<void>;
  /** What each location can promise now: on hand less what is held for other orders. */
  readonly availableAt: (tenantId: string, locationId: string, productIds: readonly string[]) => Promise<readonly LocationStock[]>;
  readonly decisions: (tenantId: string, orderId: string) => Promise<readonly RoutingDecision[]>;
  /** Every latest decision routed to a location for a slot (to count the room left). */
  readonly routedTo: (tenantId: string, locationId: string, slotStartsAt: string) => Promise<readonly RoutingDecision[]>;
  readonly recordDecision: (tenantId: string, d: RoutingDecision) => Promise<void>;
  /** Whether an order no longer needs its slot (cancelled). */
  readonly released: (tenantId: string, orderId: string) => Promise<boolean>;
  /** The order as placed, if it has been — who placed it. */
  readonly placedBy: (tenantId: string, orderId: string) => Promise<string | undefined>;
  readonly now: () => string;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isLatLon = (v: unknown): v is Record<string, unknown> & { lat: number; lon: number } => isObj(v) && typeof v['lat'] === 'number' && typeof v['lon'] === 'number'
  && Number.isFinite(v['lat']) && Number.isFinite(v['lon']) && Math.abs(v['lat']) <= 90 && Math.abs(v['lon']) <= 180;
const wholePos = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;
const METHODS: readonly FulfilmentMethod[] = ['pickup', 'scheduled_delivery', 'express_delivery'];

/** What routing a basket needs: who, how, where to, which slot, what. */
export interface RouteRequest {
  readonly orderId: string;
  readonly method: FulfilmentMethod;
  readonly deliverTo?: { readonly lat: number; readonly lon: number };
  readonly slotStartsAt: string | null;
  readonly lines: readonly { readonly productId: string; readonly quantityMinor: number }[];
  readonly expressPromiseMinutes?: number;
}

/** The decision for a basket — or undefined when head office has recorded no branch (routing is not in use yet). */
export interface RouteAnswer {
  readonly result: RouteResult;
  /** The branches that deliver to this address, nearest first (for a delivery) — what "in range" means here. */
  readonly inRangeNearestFirst: readonly string[];
  readonly locations: readonly RoutingLocation[];
}

/**
 * D09-FR-01 · OB-300: run the tested `routeOrder` on head office's own facts — the branches recorded, what each can promise
 * now, each one's room in the slot. Nothing is recorded or reserved here; the caller records the decision it acts on.
 */
export async function decideRoute(deps: Pick<OrderRoutingDeps, 'locations' | 'availableAt' | 'routedTo' | 'released'>, tenantId: string, req: RouteRequest): Promise<RouteAnswer | undefined> {
  const locations = await deps.locations(tenantId);
  if (locations.length === 0) return undefined;
  const productIds = [...new Set(req.lines.map((l) => l.productId))];
  const stock: LocationStock[] = [];
  const slots: SlotCapacity[] = [];
  for (const loc of locations) {
    stock.push(...await deps.availableAt(tenantId, loc.locationId, productIds));
    if (req.slotStartsAt !== null && loc.capacityPerSlot !== undefined) {
      let booked = 0;
      for (const d of await deps.routedTo(tenantId, loc.locationId, req.slotStartsAt)) {
        if (d.orderId !== req.orderId && !(await deps.released(tenantId, d.orderId))) booked += 1;
      }
      slots.push({ slotId: req.slotStartsAt, locationId: loc.locationId, method: req.method, capacity: loc.capacityPerSlot, booked });
    }
  }
  const result = routeOrder({
    orderId: req.orderId, method: req.method, lines: req.lines, locations, stock, slots,
    ...(req.deliverTo === undefined ? {} : { deliverTo: req.deliverTo }),
    ...(req.expressPromiseMinutes === undefined ? {} : { expressPromiseMinutes: req.expressPromiseMinutes }),
  });
  const inRangeNearestFirst = req.deliverTo === undefined ? [] : locations
    .filter((l) => l.acceptsDelivery)
    .map((l) => ({ l, m: metresBetween(l, req.deliverTo!) }))
    .filter((x) => x.m <= x.l.deliveryRadiusMetres)
    .sort((a, b) => a.m - b.m || a.l.locationId.localeCompare(b.l.locationId))
    .map((x) => x.l.locationId);
  return { result, inRangeNearestFirst, locations };
}

/** Keep a routing decision, with its audit line — the one the order was placed (or refused) on. */
export async function keepRoute(deps: Pick<OrderRoutingDeps, 'recordDecision' | 'recordAudit'>, tenantId: string, branchId: string | null, decision: RoutingDecision): Promise<void> {
  await deps.recordDecision(tenantId, decision);
  await deps.recordAudit?.(tenantId, {
    actorId: decision.customerRef, action: 'order.route', objectType: 'online_order', objectId: decision.orderId,
    at: decision.at, origin: { tenantId, branchId }, before: null,
    after: { outcome: decision.result.outcome, locationId: decision.result.locationId ?? '', method: decision.method, detail: decision.result.detail },
    correlationId: decision.orderId,
  });
}

export function orderRoutingRoutes(deps: OrderRoutingDeps): readonly Route[] {
  return [
    {
      // Body: { kind: store | dark_store, lat, lon, acceptsPickup, acceptsDelivery, deliveryRadiusMetres, expressMinutes?, capacityPerSlot? }.
      api: 'API-08', method: 'POST', path: '/v1/delivery/locations/:locationId',
      permission: 'delivery.serviceability.manage', idempotent: true,
      handler: async (ctx) => {
        const locationId = (ctx.params['locationId'] ?? '').trim();
        const b = ctx.body;
        // A courier partner is not a place an order is fulfilled from here — own drivers only (OB-294).
        if (locationId === '' || !isObj(b) || (b['kind'] !== 'store' && b['kind'] !== 'dark_store') || !isLatLon(b)
          || typeof b['acceptsPickup'] !== 'boolean' || typeof b['acceptsDelivery'] !== 'boolean' || !wholePos(b['deliveryRadiusMetres'])
          || (b['expressMinutes'] !== undefined && !wholePos(b['expressMinutes'])) || (b['capacityPerSlot'] !== undefined && !wholePos(b['capacityPerSlot']))
          || (b['kind'] === 'dark_store' && b['acceptsPickup'] === true)) {
          throw apiError(400, {
            code: 'not_readable_as_a_location',
            whatHappened: 'A location needs { kind: store | dark_store, lat, lon, acceptsPickup, acceptsDelivery, deliveryRadiusMetres (whole metres), expressMinutes?, capacityPerSlot? } — a dark store has no shop floor, so it takes no pickup.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the location again. Nothing was changed.',
          });
        }
        const loc: RoutingLocation = {
          locationId, kind: b['kind'], lat: b['lat'] as number, lon: b['lon'] as number, acceptsPickup: b['acceptsPickup'], acceptsDelivery: b['acceptsDelivery'],
          deliveryRadiusMetres: b['deliveryRadiusMetres'] as number,
          ...(b['expressMinutes'] === undefined ? {} : { expressMinutes: b['expressMinutes'] as number }),
          ...(b['capacityPerSlot'] === undefined ? {} : { capacityPerSlot: b['capacityPerSlot'] as number }),
          setBy: ctx.userId, setAt: deps.now(),
        };
        await deps.recordLocation(ctx.tenantId, loc);
        return { status: 200, body: { location: loc } };
      },
    },
    {
      api: 'API-08', method: 'GET', path: '/v1/delivery/locations',
      permission: 'delivery.serviceability.read',
      handler: async (ctx) => ({ status: 200, body: { locations: await deps.locations(ctx.tenantId), asAt: deps.now() } }),
    },
    {
      // The customer's basket before it is placed: which branch can fulfil all of it. Body: { method, deliverTo?: { lat, lon },
      // slotStartsAt?, lines: [{ productId, quantityMinor }], expressPromiseMinutes? }. The decision is recorded with its reason.
      api: 'API-07', method: 'POST', path: '/v1/storefront/route-order/:orderId',
      permission: 'storefront.order.place', entitlement: 'customer_app', idempotent: true,
      handler: async (ctx) => {
        const orderId = (ctx.params['orderId'] ?? '').trim();
        const b = ctx.body;
        const lines = isObj(b) ? b['lines'] : undefined;
        if (orderId === '' || !isObj(b) || !METHODS.includes(b['method'] as FulfilmentMethod) || !Array.isArray(lines) || lines.length === 0 || lines.length > 200
          || !lines.every((l) => isObj(l) && isStr(l['productId']) && wholePos(l['quantityMinor']))
          || (b['method'] !== 'pickup' && !isLatLon(b['deliverTo']))
          || (b['slotStartsAt'] !== undefined && (!isStr(b['slotStartsAt']) || Number.isNaN(Date.parse(b['slotStartsAt']))))
          || (b['expressPromiseMinutes'] !== undefined && !wholePos(b['expressPromiseMinutes']))) {
          throw apiError(400, {
            code: 'not_readable_as_a_routing_request',
            whatHappened: 'Routing needs { method: pickup | scheduled_delivery | express_delivery, deliverTo: { lat, lon } for a delivery, slotStartsAt?, lines: [{ productId, quantityMinor > 0 }], expressPromiseMinutes? }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the basket as the app shows it. Nothing was decided.',
          });
        }
        // An order already placed by somebody else is not theirs to re-route.
        const owner = await deps.placedBy(ctx.tenantId, orderId);
        if (owner !== undefined && owner !== ctx.userId) {
          throw apiError(403, { code: 'not_your_order', whatHappened: `Order "${orderId}" belongs to another customer.`, wasItSaved: 'not_saved', nextSafeAction: 'Nothing was changed.' });
        }
        if (owner !== undefined) {
          const last = (await deps.decisions(ctx.tenantId, orderId)).at(-1);
          throw apiError(409, { code: 'already_placed', whatHappened: `Order "${orderId}" is already placed${last?.result.locationId === undefined ? '' : ` at ${last.result.locationId}`}; it is not re-routed.`, wasItSaved: 'not_saved', nextSafeAction: 'Nothing was changed.' });
        }
        const method = b['method'] as FulfilmentMethod;
        const slotStartsAt = isStr(b['slotStartsAt']) ? new Date(Date.parse(b['slotStartsAt'])).toISOString() : null;
        const want = (lines as { productId: string; quantityMinor: number }[]).map((l) => ({ productId: l.productId, quantityMinor: l.quantityMinor }));
        const answer = await decideRoute(deps, ctx.tenantId, {
          orderId, method, slotStartsAt, lines: want,
          ...(isLatLon(b['deliverTo']) ? { deliverTo: { lat: b['deliverTo'].lat, lon: b['deliverTo'].lon } } : {}),
          ...(wholePos(b['expressPromiseMinutes']) ? { expressPromiseMinutes: b['expressPromiseMinutes'] } : {}),
        });
        if (answer === undefined) {
          throw apiError(409, { code: 'no_locations_recorded', whatHappened: 'Head office has no branch or dark store recorded for routing, so it cannot say which can fulfil this.', wasItSaved: 'not_saved', nextSafeAction: 'Order from the store the app shows. Nothing was decided.' });
        }
        const result = answer.result;
        const decision: RoutingDecision = { orderId, customerRef: ctx.userId, method, slotStartsAt, result, at: deps.now() };
        await keepRoute(deps, ctx.tenantId, ctx.branchId ?? null, decision);
        return {
          status: 200,
          body: {
            orderId, routed: result.routed, outcome: result.outcome, method, ...(result.locationId === undefined ? {} : { locationId: result.locationId }),
            ...(result.distanceMetres === undefined ? {} : { distanceMetres: result.distanceMetres }), detail: result.detail, alternatives: result.alternatives,
            splitAcrossBranches: false,
            nextStep: result.routed ? `Place the order at ${result.locationId} (POST /v1/storefront/orders/${orderId} with locationId ${result.locationId}).` : 'Nothing was reserved. Show the customer the reason and the choices.',
          },
        };
      },
    },
    {
      api: 'API-08', method: 'GET', path: '/v1/fulfilment/orders/:orderId/routing',
      permission: 'order.read',
      handler: async (ctx) => {
        const orderId = (ctx.params['orderId'] ?? '').trim();
        const decisions = await deps.decisions(ctx.tenantId, orderId);
        return { status: 200, body: { orderId, decisions, latest: decisions.at(-1) ?? null, asAt: deps.now() } };
      },
    },
  ];
}
