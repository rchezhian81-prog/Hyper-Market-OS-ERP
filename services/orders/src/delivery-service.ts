// The delivery service head office stands behind (audit FUL-03 · M18-FR-01 · M20-FR-03 · D08 · OA-11 · P-02 · §31).
//
// The customer app offers delivery slots and checks the distance in the browser — useful to the customer, and nothing
// the shop can rely on: a slot the app thinks is free may be full, a slot it invents may not exist, and a location it
// sends may be twenty kilometres out. So head office holds its OWN configuration — where the store is, how many delivery
// slots a day, across what window, how many orders each, and how much notice it needs — and at placement it decides:
//
//   • the delivery location must be inside the radius in force (the serviceability policy, D08 default 10 km), measured
//     from the store head office has on record — never from a store location the app sends;
//   • the slot must be one head office's own policy offers that day (not closed, not too soon), and it must still have
//     room: the bookings head office holds are counted, under a write guard per slot, so two customers can never both
//     take the last place;
//   • otherwise the order is REFUSED before anything is reserved or charged, with the slots that are still open.
//
// The configuration is append-only (hard rule #2): a change is a new record naming who set it and when; the latest is in
// force. A booking is a fact on its own stream; a cancelled order's booking no longer counts — the slot frees itself.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { distanceMetres, generateDeliverySlots, type Slot, type SlotOffer } from '../../../packages/storefront/src/checkout';
import type { ServiceabilityPolicy } from '../../../packages/storefront/src/checkout';
import { instantOf, wallClockIn } from '../../../packages/calendar/src/trading-day';

/** Head office's own record of how the store delivers. */
export interface DeliveryServiceConfig {
  /** Where the store is — every delivery distance is measured from here. */
  readonly storeLocation: { readonly lat: number; readonly lon: number };
  /** Delivery slots a day, across [windowOpen, windowClose] shop time, `capacityPerSlot` orders each. */
  readonly slotsPerDay: number;
  readonly windowOpen: string;
  readonly windowClose: string;
  readonly capacityPerSlot: number;
  /** Minutes of notice before a slot can be taken (to pick the order). */
  readonly leadMinutes: number;
  readonly setBy: string;
  readonly setAt: string;
}

/** One order's place in a delivery slot. */
export interface SlotBooking {
  readonly orderId: string;
  readonly slotStartsAt: string;
  readonly slotEndsAt: string;
  readonly customerRef: string;
  readonly bookedAt: string;
}

export interface DeliveryServiceDeps {
  readonly config: (tenantId: string) => Promise<DeliveryServiceConfig | undefined> | DeliveryServiceConfig | undefined;
  readonly recordConfig: (tenantId: string, c: DeliveryServiceConfig, key: string) => Promise<void> | void;
  /** The shop's time zone (store setup), so "09:00" is nine in the morning at the store. */
  readonly timeZone: (tenantId: string) => Promise<string> | string;
  /** The serviceability policy in force on a date (radius, minimum, fee) — the D08 default until the owner sets one. */
  readonly policyOn: (tenantId: string, day: string) => Promise<ServiceabilityPolicy> | ServiceabilityPolicy;
  /** The slot's write-guard version, read BEFORE its bookings are counted. */
  readonly slotVersion: (tenantId: string, slotStartsAt: string) => Promise<number> | number;
  readonly bookings: (tenantId: string, slotStartsAt: string) => Promise<readonly SlotBooking[]> | readonly SlotBooking[];
  /** Append a booking under the slot's guard — refused by name (ConcurrencyConflictError) when the slot moved. */
  readonly recordBooking: (tenantId: string, b: SlotBooking, expectedVersion: number) => Promise<void> | void;
  /** Whether an order no longer holds its slot: cancelled, or never placed (a booking whose placement failed). */
  readonly releasedOrder: (tenantId: string, orderId: string, bookedAt: string) => Promise<boolean> | boolean;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const isLatLon = (v: unknown): v is { lat: number; lon: number } => isObj(v) && typeof v['lat'] === 'number' && typeof v['lon'] === 'number'
  && Number.isFinite(v['lat']) && Number.isFinite(v['lon']) && Math.abs(v['lat']) <= 90 && Math.abs(v['lon']) <= 180;
const wholePositive = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;

/** The day's delivery slots from head office's policy, in the shop's time zone. Nothing configured → none. */
export function slotsOn(config: DeliveryServiceConfig, day: string, timeZone: string): readonly Slot[] {
  let from: string; let to: string;
  try {
    from = instantOf(`${day}T${config.windowOpen}`, timeZone);
    to = instantOf(`${day}T${config.windowClose}`, timeZone);
  } catch { return []; }
  return generateDeliverySlots({ windowStartIso: from, windowEndIso: to, slotsPerDay: config.slotsPerDay, capacityPerSlot: config.capacityPerSlot, kind: 'delivery', slotIdPrefix: `slot-${day}` });
}

/** What a placement asks of delivery, read from the order body. */
export interface DeliveryRequest {
  readonly slotStartsAt: string;
  readonly deliveryLocation: { readonly lat: number; readonly lon: number };
}

export function readDeliveryRequest(b: Record<string, unknown>): DeliveryRequest | undefined {
  const slot = b['deliverySlot'];
  const loc = b['deliveryLocation'];
  if (!isObj(slot) || !isStr(slot['startsAt']) || Number.isNaN(Date.parse(slot['startsAt'])) || !isLatLon(loc)) return undefined;
  return { slotStartsAt: new Date(Date.parse(slot['startsAt'])).toISOString(), deliveryLocation: { lat: loc.lat, lon: loc.lon } };
}

const refuse = (status: number, code: string, whatHappened: string, nextSafeAction: string, extra: Record<string, unknown> = {}): never => {
  throw apiError(status, { code, whatHappened, wasItSaved: 'not_saved', nextSafeAction, ...extra } as Parameters<typeof apiError>[1]);
};

/** The slots of a day still open to a new order: offered by the policy, far enough ahead, with room. */
async function openSlots(deps: DeliveryServiceDeps, tenantId: string, config: DeliveryServiceConfig, day: string, timeZone: string): Promise<SlotOffer[]> {
  const earliest = Date.parse(deps.now()) + config.leadMinutes * 60_000;
  const out: SlotOffer[] = [];
  for (const s of slotsOn(config, day, timeZone)) {
    if (Date.parse(s.startsAt) < earliest) continue;
    const taken = await countTaken(deps, tenantId, s.startsAt);
    if (taken < s.capacity) out.push({ slotId: s.slotId, startsAt: s.startsAt, endsAt: s.endsAt, kind: s.kind, remaining: s.capacity - taken });
  }
  return out;
}

async function countTaken(deps: DeliveryServiceDeps, tenantId: string, slotStartsAt: string, exceptOrderId?: string): Promise<number> {
  const byOrder = new Map<string, SlotBooking>();
  for (const b of await deps.bookings(tenantId, slotStartsAt)) if (!byOrder.has(b.orderId)) byOrder.set(b.orderId, b);
  let n = 0;
  for (const b of byOrder.values()) {
    if (b.orderId === exceptOrderId) continue;
    if (!(await deps.releasedOrder(tenantId, b.orderId, b.bookedAt))) n += 1;
  }
  return n;
}

/**
 * Bind a delivery order to head office's own record BEFORE anything is reserved: the location inside the radius, the
 * slot one the policy offers, not too soon, and with room — then the place is booked under the slot's guard. Throws a
 * refusal (nothing reserved, nothing charged) otherwise. Returns the slot and the distance it was judged on.
 */
export async function bindDelivery(
  deps: DeliveryServiceDeps,
  input: { readonly tenantId: string; readonly orderId: string; readonly customerRef: string; readonly request: DeliveryRequest | undefined },
): Promise<{ readonly slot: SlotOffer; readonly distanceMetres: number; readonly radiusMetres: number }> {
  const { tenantId, request } = input;
  const config = await deps.config(tenantId);
  if (config === undefined) {
    refuse(409, 'delivery_not_set_up', 'Head office has no delivery service on record (where the store is, its slots), so it cannot check a delivery address or slot.', 'Choose collection from the store, or ask the shop to set up delivery. Nothing was reserved or charged.');
  }
  if (request === undefined) {
    refuse(400, 'delivery_needs_slot_and_location', 'A delivery order needs the chosen slot { deliverySlot: { startsAt } } and the delivery location { deliveryLocation: { lat, lon } }.', 'Choose a slot and share the delivery location, then send the order again. Nothing was reserved or charged.');
  }
  const timeZone = await deps.timeZone(tenantId);
  const today = wallClockIn(deps.now(), timeZone).slice(0, 10);
  const policy = await deps.policyOn(tenantId, today);
  const radius = policy.radiusMetres ?? 10_000;
  const metres = distanceMetres(config!.storeLocation, request!.deliveryLocation);
  if (metres > radius) {
    refuse(422, 'address_outside_service_area', `We deliver up to ${(radius / 1000).toFixed(1)} km from the store and this address is ${(metres / 1000).toFixed(1)} km away.`, 'You can collect from the store instead. Nothing was reserved or charged.', { distanceMetres: metres, radiusMetres: radius });
  }
  const day = wallClockIn(request!.slotStartsAt, timeZone).slice(0, 10);
  const offered = slotsOn(config!, day, timeZone).find((s) => s.startsAt === request!.slotStartsAt);
  const earliest = Date.parse(deps.now()) + config!.leadMinutes * 60_000;
  if (offered === undefined || Date.parse(offered.startsAt) < earliest) {
    const alternatives = await openSlots(deps, tenantId, config!, day < today ? today : day, timeZone);
    refuse(422, 'slot_closed', offered === undefined
      ? 'The shop does not deliver in that slot.'
      : `That slot starts too soon — the shop needs ${config!.leadMinutes} minutes to pick an order.`,
    'Choose one of the open slots. Nothing was reserved or charged.', { alternatives });
  }
  // Count and book under the slot's guard: two customers can never both take its last place.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const version = await deps.slotVersion(tenantId, offered!.startsAt);
    const mine = (await deps.bookings(tenantId, offered!.startsAt)).find((b) => b.orderId === input.orderId);
    if (mine !== undefined) return { slot: { slotId: offered!.slotId, startsAt: offered!.startsAt, endsAt: offered!.endsAt, kind: 'delivery', remaining: offered!.capacity - await countTaken(deps, tenantId, offered!.startsAt) }, distanceMetres: metres, radiusMetres: radius };
    const taken = await countTaken(deps, tenantId, offered!.startsAt);
    if (taken >= offered!.capacity) {
      const alternatives = (await openSlots(deps, tenantId, config!, day, timeZone)).filter((s) => s.startsAt !== offered!.startsAt);
      refuse(409, 'slot_full', `That delivery slot is full (${offered!.capacity} orders).`, 'Choose one of the open slots. Nothing was reserved or charged.', { alternatives });
    }
    try {
      await deps.recordBooking(tenantId, { orderId: input.orderId, slotStartsAt: offered!.startsAt, slotEndsAt: offered!.endsAt, customerRef: input.customerRef, bookedAt: deps.now() }, version);
      return { slot: { slotId: offered!.slotId, startsAt: offered!.startsAt, endsAt: offered!.endsAt, kind: 'delivery', remaining: offered!.capacity - taken - 1 }, distanceMetres: metres, radiusMetres: radius };
    } catch (err) {
      if (!(err instanceof Error) || err.name !== 'ConcurrencyConflictError') throw err;
    }
  }
  return refuse(409, 'slot_busy', 'Many people are booking that slot right now.', 'Try again in a moment. Nothing was reserved or charged.');
}

function readConfig(b: unknown, setBy: string, setAt: string): DeliveryServiceConfig | undefined {
  if (!isObj(b) || !isLatLon(b['storeLocation']) || !wholePositive(b['slotsPerDay']) || !isStr(b['windowOpen']) || !HHMM.test(b['windowOpen'])
    || !isStr(b['windowClose']) || !HHMM.test(b['windowClose']) || b['windowClose'] <= b['windowOpen'] || !wholePositive(b['capacityPerSlot'])
    || (b['leadMinutes'] !== undefined && !(typeof b['leadMinutes'] === 'number' && Number.isInteger(b['leadMinutes']) && b['leadMinutes'] >= 0))) return undefined;
  const loc = b['storeLocation'] as { lat: number; lon: number };
  return {
    storeLocation: { lat: loc.lat, lon: loc.lon }, slotsPerDay: b['slotsPerDay'] as number, windowOpen: b['windowOpen'] as string,
    windowClose: b['windowClose'] as string, capacityPerSlot: b['capacityPerSlot'] as number, leadMinutes: (b['leadMinutes'] as number | undefined) ?? 60,
    setBy, setAt,
  };
}

export function deliveryServiceRoutes(deps: DeliveryServiceDeps): readonly Route[] {
  return [
    {
      // Set how the store delivers: where it is, its daily slots and their capacity, the notice it needs. Append-only —
      // the latest record is in force, each naming who set it. Body: { storeLocation: { lat, lon }, slotsPerDay,
      // windowOpen "HH:MM", windowClose "HH:MM", capacityPerSlot, leadMinutes? }.
      api: 'API-07', method: 'PUT', path: '/v1/serviceability/delivery-service',
      permission: 'delivery.serviceability.manage', idempotent: true,
      handler: async (ctx) => {
        const c = readConfig(ctx.body, ctx.userId, deps.now());
        if (c === undefined) {
          refuse(400, 'not_readable_as_a_delivery_service', 'The delivery service needs { storeLocation: { lat, lon }, slotsPerDay, windowOpen "HH:MM", windowClose "HH:MM" (after the opening), capacityPerSlot, leadMinutes? } — counts whole and above zero.', 'Send it again. Nothing was changed.');
        }
        await deps.recordConfig(ctx.tenantId, c!, ctx.idempotencyKey ?? `${c!.setAt}`);
        return { status: 200, body: { deliveryService: c } };
      },
    },
    {
      // How the store delivers, as head office has it — and the day's slots with what is left in each.
      api: 'API-07', method: 'GET', path: '/v1/serviceability/delivery-service',
      permission: 'delivery.serviceability.read',
      handler: async (ctx) => {
        const c = await deps.config(ctx.tenantId);
        if (c === undefined) return { status: 200, body: { deliveryService: null, detail: 'no delivery service on record — every delivery order is refused until it is set' } };
        const timeZone = await deps.timeZone(ctx.tenantId);
        const day = typeof ctx.query['day'] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ctx.query['day']) ? ctx.query['day'] : wallClockIn(deps.now(), timeZone).slice(0, 10);
        const slots = [];
        for (const s of slotsOn(c, day, timeZone)) slots.push({ slotId: s.slotId, startsAt: s.startsAt, endsAt: s.endsAt, capacity: s.capacity, taken: await countTaken(deps, ctx.tenantId, s.startsAt) });
        return { status: 200, body: { deliveryService: c, day, timeZone, slots } };
      },
    },
  ];
}
