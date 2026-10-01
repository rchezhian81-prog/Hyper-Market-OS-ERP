// API-08 — the DRIVER handheld's work, relayed by the store box (M19-FR-03 · M19-FR-04 · M23 · §28 · §31 — SP-3c-ii, audit
// finding F11's driver half; ADR-0019).
//
// A driver carries somebody's groceries and somebody's cash through streets where the signal comes and goes. Every stop's
// outcome — departed, at the door, delivered with proof and the cash taken, partly delivered, failed with a reason, sent out
// again, returned — is decided locally by the tested `RouteSession`, queued on the PHONE, handed to the box over the
// authenticated device socket when the phone is back on the shop wifi, and relayed HERE under the store's sync credential.
// So are the end-of-shift settlement and the counted cash handover. Until this file existed the driver's queue reached
// nobody (F11): a phone that died after four stops left ₹6,000 with somebody and no record anywhere.
//
// These routes make the phone's facts head office's facts the way the warehouse and picker handhelds' became so:
//
//   • they trust the FACT (which stop went which way, how much cash, what kind of proof — the key is the phone's own, so a
//     re-sent outcome is ONE record, §31.1) and keep an append-only ROUTE REGISTER: a stop that failed, was reattempted and
//     then delivered is three things that happened, and all three are kept;
//   • they re-verify the DRIVER named by the device from THEIR grants and FLAG a breach on the record — never a silent apply,
//     never a silent drop (hard rules #4/#10); the relay (the box) is recorded beside them, never as the actor;
//   • a stop's outcome is mapped onto the ORDER's own delivery lifecycle through the SAME state machine the direct route runs
//     (`/v1/delivery/orders/:orderId/transition`): the step the order can take from where head office has it is recorded in
//     the driver's name; a step it cannot take is recorded on the route register and SAID (`order_state_disagrees`), never
//     applied blindly and never dropped;
//   • the SETTLEMENT and the HANDOVER are compared with the stops head office holds — expected, collected and held cash are
//     derived here from the register beside the phone's figures, and a disagreement is said; a material handover variance is
//     flagged for the cash office (M14/M23), because a control that only ever reports success is not a control;
//   • COD is cash or UPI (hard rule #3): a stop that names any other method cannot be read, and is dead-lettered by name.
//
// Recording gated `delivery.stop.sync` (the box's hop); the read `delivery.run.read`. The delivery feature's routes (M36-FR-01).

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { canTransitionDelivery, transitionDelivery, type DeliveryEvent, type DeliveryState } from '../../../packages/fulfilment/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import type { DeliveryStateRecord } from './index';

export const STOP_STATES: readonly DeliveryState[] = ['assigned', 'picked_up', 'out_for_delivery', 'attempted', 'delivered', 'partially_delivered', 'failed', 'returned_to_origin'];
const STEPS: readonly DeliveryEvent[] = ['pick_up', 'depart', 'arrive', 'deliver', 'deliver_partial', 'fail', 'reattempt', 'rto'];
/** COD methods the shop may hold (hard rule #3): cash or UPI, never a card. */
export const COD_METHODS = Object.freeze(['cash', 'upi'] as const);

export const DRIVER_RUN_SYNC_FLAGS = Object.freeze([
  'driver_unknown', 'driver_lacks_authority',
  // The order, as head office has it, cannot take the step the phone's stop describes — recorded here, not applied there.
  'order_state_disagrees',
  // Goods handed over with no proof kind named — the phone refuses this itself, so a payload saying it is one to look at.
  'delivered_without_proof_kind',
  // Said by the phone, repeated here so the review screen sees it without opening the stop.
  'geofence_mismatch', 'contribution_flagged',
  // The settlement's figures are not the ones head office's own stop register supports.
  'stops_disagree',
  // The settlement itself found exceptions (short / over / uncollected / unexpected) — visible, never buried.
  'has_exceptions',
  // The handover's "recorded" figure is not what head office's stop register holds.
  'recorded_disagrees',
  // The counted cash differs from the recorded cash by at least the tenant's tolerance: the cash office decides.
  'cash_office_review',
] as const);
export type DriverRunSyncFlag = (typeof DRIVER_RUN_SYNC_FLAGS)[number];

/** The permission a person must hold to have delivered in their own name. */
const DRIVE_PERMISSION = 'delivery.attempt.record';

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonNegInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isIso = (v: unknown): v is string => isStr(v) && !Number.isNaN(Date.parse(v));
const optStr = (v: unknown): string | null => (isStr(v) ? v : null);

type Permissions = (tenantId: string, userId: string) => Promise<readonly string[] | undefined> | readonly string[] | undefined;

/** One stop outcome as head office keeps it — the phone's fact, the relay beside it, the flags on it, the order step it caused. */
export interface RouteStopUpdate {
  readonly routeId: string;
  readonly stopId: string;
  readonly driverId: string;
  readonly orderRef: string;
  readonly state: DeliveryState;
  readonly codExpectedMinor: number;
  readonly codCollectedMinor: number;
  readonly codMethod: 'cash' | 'upi' | null;
  readonly proofKind: string | null;
  readonly geofenceMismatch: boolean;
  readonly failureReason: string | null;
  readonly contributionFlag: string | null;
  readonly currency: string;
  readonly relayedBy: string;
  readonly at: string;
  /** The lifecycle step recorded on the order, or why none was. */
  readonly orderStep: { readonly event: DeliveryEvent; readonly from: DeliveryState; readonly to: DeliveryState } | 'already_there' | 'disagrees' | 'no_proof_kind';
  readonly governanceFlags: readonly DriverRunSyncFlag[];
}

/** The route's end-of-shift settlement as head office keeps it: the phone's figures beside the figures ITS register supports. */
export interface RouteSettlementRecord {
  readonly routeId: string;
  readonly driverId: string;
  readonly expectedMinor: number;
  readonly collectedMinor: number;
  readonly cashHeldMinor: number;
  readonly matchedCount: number;
  readonly exceptionCount: number;
  readonly currency: string;
  readonly relayedBy: string;
  readonly at: string;
  readonly fromStops: RouteCash;
  readonly governanceFlags: readonly DriverRunSyncFlag[];
}

/** The counted cash handover as head office keeps it. */
export interface CashHandoverRecord {
  readonly routeId: string;
  readonly driverId: string;
  readonly countedMinor: number;
  readonly recordedMinor: number;
  readonly varianceMinor: number;
  readonly material: boolean;
  readonly reasonCode: string | null;
  readonly currency: string;
  readonly relayedBy: string;
  readonly at: string;
  readonly fromStops: RouteCash;
  readonly governanceFlags: readonly DriverRunSyncFlag[];
}

/** The cash a route should account for, by head office's own stop register. */
export interface RouteCash {
  readonly expectedMinor: number;
  readonly collectedMinor: number;
  readonly cashHeldMinor: number;
}

export interface SyncedDriverRunDeps {
  readonly permissionsOfUser: Permissions;
  /** Every stop outcome recorded for a route, oldest first (append-only history — a stop may appear more than once). */
  readonly stopUpdates: (tenantId: string, routeId: string) => Promise<readonly RouteStopUpdate[]> | readonly RouteStopUpdate[];
  readonly recordStopUpdate: (tenantId: string, update: RouteStopUpdate) => Promise<void> | void;
  readonly settlement: (tenantId: string, routeId: string) => Promise<RouteSettlementRecord | undefined> | RouteSettlementRecord | undefined;
  readonly recordSettlement: (tenantId: string, record: RouteSettlementRecord) => Promise<void> | void;
  readonly handover: (tenantId: string, routeId: string) => Promise<CashHandoverRecord | undefined> | CashHandoverRecord | undefined;
  readonly recordHandover: (tenantId: string, record: CashHandoverRecord) => Promise<void> | void;
  /** The order's own append-only lifecycle (the same register the direct transition route writes). */
  readonly deliveryState: (tenantId: string, orderId: string) => Promise<readonly DeliveryStateRecord[]> | readonly DeliveryStateRecord[];
  readonly recordDeliveryTransition: (tenantId: string, record: DeliveryStateRecord) => Promise<void> | void;
  readonly now: () => string;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}

/** The latest outcome per stop, in first-seen order — the register folded to the route as it stands. */
export function latestStops(history: readonly RouteStopUpdate[]): readonly RouteStopUpdate[] {
  const latest = new Map<string, RouteStopUpdate>();
  for (const u of history) latest.set(u.stopId, u);
  return [...latest.values()];
}

/**
 * The cash the route should account for, from head office's stop register — the same arithmetic the phone's `settle()`
 * runs: a full delivery expects the order's whole COD; a partial delivery reconciles to what was actually taken.
 */
export function cashFromStops(history: readonly RouteStopUpdate[]): RouteCash {
  let expectedMinor = 0;
  let collectedMinor = 0;
  for (const s of latestStops(history)) {
    if (s.state === 'delivered') { expectedMinor += s.codExpectedMinor; collectedMinor += s.codCollectedMinor; }
    else if (s.state === 'partially_delivered') { expectedMinor += s.codCollectedMinor; collectedMinor += s.codCollectedMinor; }
  }
  return { expectedMinor, collectedMinor, cashHeldMinor: collectedMinor };
}

/** The order's current state by its own register: the `to` of the latest record, else the machine's start. */
export function currentOrderState(history: readonly DeliveryStateRecord[]): DeliveryState {
  return history.length === 0 ? 'assigned' : history[history.length - 1]!.to;
}

/** The ONE lifecycle event that takes the order from `from` to `to`, or undefined when no single step does. */
export function stepBetween(from: DeliveryState, to: DeliveryState): DeliveryEvent | undefined {
  return STEPS.find((e) => canTransitionDelivery(from, e) && transitionDelivery(from, e) === to);
}

/** Re-verify the named driver from THEIR grants (§28): flags, never a silent trust of the relay's word. */
async function verifyDriver(permissionsOfUser: Permissions, tenantId: string, driverId: string): Promise<DriverRunSyncFlag[]> {
  const permissions = await permissionsOfUser(tenantId, driverId);
  if (permissions === undefined) return ['driver_unknown'];
  return permissions.includes(DRIVE_PERMISSION) ? [] : ['driver_lacks_authority'];
}

interface RelayedStop {
  readonly driverId: string; readonly orderRef: string; readonly state: DeliveryState; readonly codExpectedMinor: number;
  readonly codCollectedMinor: number; readonly codMethod: 'cash' | 'upi' | null; readonly proofKind: string | null;
  readonly geofenceMismatch: boolean; readonly failureReason: string | null; readonly contributionFlag: string | null;
  readonly currency: string; readonly at: string;
}

/** The stop as the phone queued it (`DeliveryStopUpdated`), read strictly; undefined when it cannot be read. */
function readRelayedStop(body: unknown, routeId: string, stopId: string, now: string): RelayedStop | undefined {
  if (!isObj(body)) return undefined;
  if (isStr(body['routeId']) && body['routeId'] !== routeId) return undefined;
  if (isStr(body['stopId']) && body['stopId'] !== stopId) return undefined;
  const state = body['state'];
  if (!isStr(state) || !(STOP_STATES as readonly string[]).includes(state)) return undefined;
  if (!isStr(body['driverId']) || !isStr(body['orderRef']) || !isNonNegInt(body['codExpectedMinor'])) return undefined;
  if (body['codCollectedMinor'] !== undefined && !isNonNegInt(body['codCollectedMinor'])) return undefined;
  const method = body['codMethod'];
  if (method !== undefined && method !== null && !(COD_METHODS as readonly string[]).includes(method as string)) return undefined;
  if (body['geofenceMismatch'] !== undefined && typeof body['geofenceMismatch'] !== 'boolean') return undefined;
  return {
    driverId: body['driverId'], orderRef: body['orderRef'], state: state as DeliveryState,
    codExpectedMinor: body['codExpectedMinor'], codCollectedMinor: isNonNegInt(body['codCollectedMinor']) ? body['codCollectedMinor'] : 0,
    codMethod: method === 'cash' || method === 'upi' ? method : null,
    proofKind: optStr(body['proofKind']), geofenceMismatch: body['geofenceMismatch'] === true,
    failureReason: optStr(body['failureReason']), contributionFlag: optStr(body['contributionFlag']),
    currency: isStr(body['currency']) ? body['currency'] : 'INR',
    at: isIso(body['occurredAt']) ? body['occurredAt'] : isIso(body['at']) ? body['at'] : now,
  };
}

interface RelayedSettlement {
  readonly driverId: string; readonly expectedMinor: number; readonly collectedMinor: number; readonly cashHeldMinor: number;
  readonly matchedCount: number; readonly exceptionCount: number; readonly currency: string; readonly at: string;
}

function readRelayedSettlement(body: unknown, routeId: string, now: string): RelayedSettlement | undefined {
  if (!isObj(body)) return undefined;
  if (isStr(body['routeId']) && body['routeId'] !== routeId) return undefined;
  if (!isStr(body['driverId']) || !isNonNegInt(body['expectedMinor']) || !isNonNegInt(body['collectedMinor']) || !isNonNegInt(body['cashHeldMinor'])
    || !isNonNegInt(body['matchedCount']) || !isNonNegInt(body['exceptionCount'])) return undefined;
  return {
    driverId: body['driverId'], expectedMinor: body['expectedMinor'], collectedMinor: body['collectedMinor'], cashHeldMinor: body['cashHeldMinor'],
    matchedCount: body['matchedCount'], exceptionCount: body['exceptionCount'], currency: isStr(body['currency']) ? body['currency'] : 'INR',
    at: isIso(body['occurredAt']) ? body['occurredAt'] : isIso(body['at']) ? body['at'] : now,
  };
}

interface RelayedHandover {
  readonly driverId: string; readonly countedMinor: number; readonly recordedMinor: number; readonly varianceMinor: number;
  readonly material: boolean; readonly reasonCode: string | null; readonly currency: string; readonly at: string;
}

function readRelayedHandover(body: unknown, routeId: string, now: string): RelayedHandover | undefined {
  if (!isObj(body)) return undefined;
  if (isStr(body['routeId']) && body['routeId'] !== routeId) return undefined;
  if (!isStr(body['driverId']) || !isNonNegInt(body['countedMinor']) || !isNonNegInt(body['recordedMinor']) || !isInt(body['varianceMinor'])
    || typeof body['material'] !== 'boolean') return undefined;
  // The variance is the phone's arithmetic; a payload whose figures do not add up cannot be read.
  if (body['varianceMinor'] !== body['countedMinor'] - body['recordedMinor']) return undefined;
  return {
    driverId: body['driverId'], countedMinor: body['countedMinor'], recordedMinor: body['recordedMinor'], varianceMinor: body['varianceMinor'],
    material: body['material'], reasonCode: optStr(body['reasonCode']), currency: isStr(body['currency']) ? body['currency'] : 'INR',
    at: isIso(body['at']) ? body['at'] : isIso(body['occurredAt']) ? body['occurredAt'] : now,
  };
}

/** The route as a screen reads it: each stop's latest outcome with its history depth, the cash by the register, the settlement, the handover, every flag once. */
export function presentRoute(
  routeId: string, history: readonly RouteStopUpdate[], settlement: RouteSettlementRecord | undefined, handover: CashHandoverRecord | undefined,
): Record<string, unknown> {
  const depth = new Map<string, number>();
  for (const u of history) depth.set(u.stopId, (depth.get(u.stopId) ?? 0) + 1);
  const stops = latestStops(history).map((u) => ({ ...u, outcomesRecorded: depth.get(u.stopId) ?? 1 }));
  const flags = [...new Set([...history.flatMap((u) => u.governanceFlags), ...(settlement?.governanceFlags ?? []), ...(handover?.governanceFlags ?? [])])];
  return { routeId, stops, cash: cashFromStops(history), settlement: settlement ?? null, handover: handover ?? null, flags, stopCount: stops.length };
}

export function syncedDriverRunRoutes(deps: SyncedDriverRunDeps): readonly Route[] {
  return [
    {
      // A stop's outcome from the driver's phone, relayed by the box. Idempotent on (route, stop, state) — the phone's own
      // key — so a re-sent outcome is one record; a NEW outcome for the same stop (failed, then reattempted) is a second.
      api: 'API-08', method: 'POST', path: '/v1/delivery/routes/:routeId/stops/:stopId/synced',
      permission: 'delivery.stop.sync', entitlement: 'delivery', idempotent: true,
      handler: async (ctx) => {
        const routeId = (ctx.params['routeId'] ?? '').trim();
        const stopId = (ctx.params['stopId'] ?? '').trim();
        const now = deps.now();
        const r = routeId === '' || stopId === '' ? undefined : readRelayedStop(ctx.body, routeId, stopId, now);
        if (r === undefined) {
          throw apiError(400, {
            code: 'not_readable_as_a_stop_outcome',
            whatHappened: 'This payload could not be read as a stop outcome from a driver\'s phone — it needs routeId and stopId matching the path, driverId, orderRef, a delivery state, a whole codExpectedMinor, and a COD method of cash or upi (never a card, hard rule #3).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Do not discard it at the store. Keep it in the queue and raise it — an outcome that cannot be read still happened at a door, and may have cash attached.',
          });
        }
        const history = await deps.stopUpdates(ctx.tenantId, routeId);
        const prior = history.find((u) => u.stopId === stopId && u.state === r.state);
        if (prior !== undefined) {
          return { status: 200, body: { routeId, stopId, state: r.state, recorded: true, alreadyRecorded: true, flags: prior.governanceFlags, orderStep: prior.orderStep } };
        }
        const flags: DriverRunSyncFlag[] = await verifyDriver(deps.permissionsOfUser, ctx.tenantId, r.driverId);
        if (r.geofenceMismatch) flags.push('geofence_mismatch');
        if (r.contributionFlag !== null) flags.push('contribution_flagged');

        // The ORDER's own lifecycle, through the same machine the direct route runs. Goods handed over need a proof kind.
        const handsOver = r.state === 'delivered' || r.state === 'partially_delivered';
        const orderHistory = await deps.deliveryState(ctx.tenantId, r.orderRef);
        const from = currentOrderState(orderHistory);
        let orderStep: RouteStopUpdate['orderStep'];
        if (handsOver && r.proofKind === null) {
          flags.push('delivered_without_proof_kind');
          orderStep = 'no_proof_kind';
        } else if (from === r.state) {
          orderStep = 'already_there';
        } else {
          const event = stepBetween(from, r.state);
          if (event === undefined) {
            flags.push('order_state_disagrees');
            orderStep = 'disagrees';
          } else {
            orderStep = { event, from, to: r.state };
            await deps.recordDeliveryTransition(ctx.tenantId, {
              orderId: r.orderRef, from, to: r.state, event, by: r.driverId, at: r.at,
              // The proof itself stays on the phone by design (§31 — a route's worth of doorstep photographs on a queue is a
              // privacy problem). What travels is its KIND and where the evidence is held; both are recorded with the step.
              ...(handsOver ? { proofRef: `${r.proofKind}@handheld:${routeId}/${stopId}` } : {}),
            });
          }
        }

        const update: RouteStopUpdate = {
          routeId, stopId, driverId: r.driverId, orderRef: r.orderRef, state: r.state, codExpectedMinor: r.codExpectedMinor,
          codCollectedMinor: r.codCollectedMinor, codMethod: r.codMethod, proofKind: r.proofKind, geofenceMismatch: r.geofenceMismatch,
          failureReason: r.failureReason, contributionFlag: r.contributionFlag, currency: r.currency, relayedBy: ctx.userId, at: r.at,
          orderStep, governanceFlags: flags,
        };
        await deps.recordStopUpdate(ctx.tenantId, update);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: r.driverId, action: 'delivery.stop.record', objectType: 'delivery_route', objectId: routeId,
          at: now, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: null,
          after: {
            stopId, orderRef: r.orderRef, state: r.state, codExpectedMinor: String(r.codExpectedMinor), codCollectedMinor: String(r.codCollectedMinor),
            codMethod: r.codMethod ?? '', proofKind: r.proofKind ?? '', failureReason: r.failureReason ?? '',
            orderStep: typeof orderStep === 'string' ? orderStep : orderStep.event, relayedBy: ctx.userId, flags: flags.join(','),
          },
          correlationId: routeId,
        });
        // 202: it happened at the door; this records that head office now holds it.
        return { status: 202, body: { routeId, stopId, state: r.state, recorded: true, flags, orderStep } };
      },
    },
    {
      // The route's end-of-shift settlement. Idempotent on the route. Compared with the stops head office holds.
      api: 'API-08', method: 'POST', path: '/v1/delivery/routes/:routeId/settled/synced',
      permission: 'delivery.stop.sync', entitlement: 'delivery', idempotent: true,
      handler: async (ctx) => {
        const routeId = (ctx.params['routeId'] ?? '').trim();
        const now = deps.now();
        const s = routeId === '' ? undefined : readRelayedSettlement(ctx.body, routeId, now);
        if (s === undefined) {
          throw apiError(400, {
            code: 'not_readable_as_a_route_settlement',
            whatHappened: 'This payload could not be read as a route settlement from a driver\'s phone — it needs routeId matching the path, driverId, and whole expectedMinor, collectedMinor, cashHeldMinor, matchedCount and exceptionCount.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Do not discard it at the store. Keep it in the queue and raise it — a settlement that cannot be read is cash nobody has reconciled.',
          });
        }
        const existing = await deps.settlement(ctx.tenantId, routeId);
        if (existing !== undefined) {
          return { status: 200, body: { routeId, recorded: true, alreadyRecorded: true, flags: existing.governanceFlags, fromStops: existing.fromStops } };
        }
        const flags = await verifyDriver(deps.permissionsOfUser, ctx.tenantId, s.driverId);
        const fromStops = cashFromStops(await deps.stopUpdates(ctx.tenantId, routeId));
        if (fromStops.expectedMinor !== s.expectedMinor || fromStops.collectedMinor !== s.collectedMinor || fromStops.cashHeldMinor !== s.cashHeldMinor) flags.push('stops_disagree');
        if (s.exceptionCount > 0) flags.push('has_exceptions');
        const record: RouteSettlementRecord = {
          routeId, driverId: s.driverId, expectedMinor: s.expectedMinor, collectedMinor: s.collectedMinor, cashHeldMinor: s.cashHeldMinor,
          matchedCount: s.matchedCount, exceptionCount: s.exceptionCount, currency: s.currency, relayedBy: ctx.userId, at: s.at, fromStops, governanceFlags: flags,
        };
        await deps.recordSettlement(ctx.tenantId, record);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: s.driverId, action: 'delivery.route.settle', objectType: 'delivery_route', objectId: routeId,
          at: now, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: null,
          after: {
            expectedMinor: String(s.expectedMinor), collectedMinor: String(s.collectedMinor), cashHeldMinor: String(s.cashHeldMinor),
            matchedCount: String(s.matchedCount), exceptionCount: String(s.exceptionCount),
            fromStopsExpectedMinor: String(fromStops.expectedMinor), fromStopsCollectedMinor: String(fromStops.collectedMinor),
            relayedBy: ctx.userId, flags: flags.join(','),
          },
          correlationId: routeId,
        });
        return { status: 202, body: { routeId, recorded: true, flags, fromStops } };
      },
    },
    {
      // The counted cash handover at end of shift. Idempotent on the route. The recorded figure is compared with the stops
      // head office holds; a material variance goes to the cash office — recorded, flagged, never refused.
      api: 'API-08', method: 'POST', path: '/v1/delivery/routes/:routeId/handover/synced',
      permission: 'delivery.stop.sync', entitlement: 'delivery', idempotent: true,
      handler: async (ctx) => {
        const routeId = (ctx.params['routeId'] ?? '').trim();
        const now = deps.now();
        const h = routeId === '' ? undefined : readRelayedHandover(ctx.body, routeId, now);
        if (h === undefined) {
          throw apiError(400, {
            code: 'not_readable_as_a_cash_handover',
            whatHappened: 'This payload could not be read as a cash handover from a driver\'s phone — it needs routeId matching the path, driverId, whole countedMinor and recordedMinor, a varianceMinor equal to counted minus recorded, and material true/false.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Do not discard it at the store. Keep it in the queue and raise it — a handover that cannot be read is cash nobody has signed for.',
          });
        }
        const existing = await deps.handover(ctx.tenantId, routeId);
        if (existing !== undefined) {
          return { status: 200, body: { routeId, recorded: true, alreadyRecorded: true, flags: existing.governanceFlags, fromStops: existing.fromStops } };
        }
        const flags = await verifyDriver(deps.permissionsOfUser, ctx.tenantId, h.driverId);
        const fromStops = cashFromStops(await deps.stopUpdates(ctx.tenantId, routeId));
        if (fromStops.cashHeldMinor !== h.recordedMinor) flags.push('recorded_disagrees');
        if (h.material) flags.push('cash_office_review');
        const record: CashHandoverRecord = {
          routeId, driverId: h.driverId, countedMinor: h.countedMinor, recordedMinor: h.recordedMinor, varianceMinor: h.varianceMinor,
          material: h.material, reasonCode: h.reasonCode, currency: h.currency, relayedBy: ctx.userId, at: h.at, fromStops, governanceFlags: flags,
        };
        await deps.recordHandover(ctx.tenantId, record);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: h.driverId, action: 'delivery.cash.handover', objectType: 'delivery_route', objectId: routeId,
          at: now, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: null,
          after: {
            countedMinor: String(h.countedMinor), recordedMinor: String(h.recordedMinor), varianceMinor: String(h.varianceMinor), material: String(h.material),
            reasonCode: h.reasonCode ?? '', fromStopsCashHeldMinor: String(fromStops.cashHeldMinor), relayedBy: ctx.userId, flags: flags.join(','),
          },
          correlationId: routeId,
        });
        return { status: 202, body: { routeId, recorded: true, flags, fromStops } };
      },
    },
    {
      // The route as head office holds it — for the dispatcher, the cash office and the proofs.
      api: 'API-08', method: 'GET', path: '/v1/delivery/routes/:routeId',
      permission: 'delivery.run.read', entitlement: 'delivery',
      handler: async (ctx) => {
        const routeId = (ctx.params['routeId'] ?? '').trim();
        if (routeId === '') {
          throw apiError(400, { code: 'not_readable_as_a_route_query', whatHappened: 'Reading a route needs its id in the path.', wasItSaved: 'not_saved', nextSafeAction: 'Send /v1/delivery/routes/:routeId. Nothing was changed.' });
        }
        const [history, settlement, handover] = await Promise.all([
          deps.stopUpdates(ctx.tenantId, routeId), deps.settlement(ctx.tenantId, routeId), deps.handover(ctx.tenantId, routeId),
        ]);
        return { status: 200, body: { ...presentRoute(routeId, history, settlement, handover), asAt: deps.now() } };
      },
    },
  ];
}
