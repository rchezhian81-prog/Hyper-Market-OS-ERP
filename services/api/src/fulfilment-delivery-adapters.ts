// OB-288 package "fulfilment and delivery" — head office's wiring for the wave builder (M19-FR-01 · WF-14), the dispatch
// office (M19-FR-03/04 · WF-15), delivery proof that is captured (OB-294 · D09-FR-05), the customer's delivery code and ETA
// (D08-FR-05), branch routing (D09-FR-01 · OB-300), the contribution rule (D09-FR-06 · OB-313), own-fleet settlement and
// the courier link built switched off (D09-FR-06 · OB-294).
//
// Every register here is append-only on its own stream (hard rules #2/#6): a code is issued once (its key is the order); a
// judgement is kept once (its key is the order); a decision, a settlement step, a location, a routing decision and a stop
// index are new records, the latest in force. Nothing here edits or deletes a record. Entry points registered from main.ts:
// `fulfilmentDeliveryRoutes` (routes) and `fulDelDriverRunHooks` (spread into the driver-run relay's deps).

import { createHash, randomInt } from 'node:crypto';
import { makeEvent } from '../../../packages/contracts/src/event';
import { valueAtUnitCost } from '../../../packages/contracts/src/quantity';
import type { EventStore } from '../../../packages/persistence/src/event-store';
import type { Route } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import type { CatalogueDeps } from '../../catalogue/src/index';
import { metresBetween } from '../../../packages/orders/src/fulfilment-plan';
import { paymentPosition } from '../../../packages/orders/src/payment-refunds';
import { resolveServiceabilityPolicy } from '../../../packages/storefront/src/index';
import { wallClockIn } from '../../../packages/calendar/src/trading-day';
import {
  judgeCode, judgeProofLocation, SWITCHED_OFF_COURIER, type CourierPartnerLink, type EtaStamp, type WaveProduct,
} from '../../../packages/fulfilment/src/index';
import type { SlotBooking } from '../../orders/src/delivery-service';
import {
  STREAM, streamName, ordersAdapter, ordersForExport, catalogueAdapter, warehouseAdapter, assignmentsAdapter, fulfilmentWaveAdapter,
  driverRunAdapter, dispatchAdapter, deliveryServiceAdapter, serviceabilityAdapter, syncedGoodsReceiptAdapter, permissionsHeldBy, assignedStoresOf,
} from './adapters';
import { latestRoutes } from '../../fulfilment/src/assignments';
import { latestStops, type DoorProofInput } from '../../fulfilment/src/driver-runs';
import { deliveryControlsRoutes, foldControls, judgeOnce, type ControlsChange, type ContributionDecision, type ContributionRecord, type DeliveryControlsDeps } from '../../fulfilment/src/delivery-controls';
import { deliveryProofRoutes, codeFor, type DeliveryProofDeps, type IssuedCode, type OrderStop, type ProofImage } from '../../fulfilment/src/delivery-proof';
import { waveBuilderRoutes, type CandidateOrder, type WaveBuilderDeps } from '../../fulfilment/src/wave-builder';
import { dispatchBoardRoutes, type DeliveryBooking, type DispatchBoardDeps } from '../../fulfilment/src/dispatch-board';
import { orderRoutingRoutes, type OrderRoutingDeps, type RoutingDecision, type RoutingLocation } from '../../fulfilment/src/order-routing';
import { fleetSettlementRoutes, type FleetSettlementDeps, type FleetSettlementStep } from '../../fulfilment/src/fleet-settlement';

type Recorder = (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;

export interface FulDelInput {
  readonly store: EventStore | undefined;
  readonly now: () => string;
  readonly signer: CatalogueDeps['signer'];
  /** The store's time zone (store setup), so a run date and a slot are the shop's own day and hours. */
  readonly timeZone: (tenantId: string) => Promise<string> | string;
  readonly recordAudit?: Recorder;
  /** The courier-partner link. The running system composes the switched-off one (OB-294); tests may hand in the stand-in. */
  readonly courier?: CourierPartnerLink;
}

const S = {
  controls: streamName(STREAM.delivery, 'controls'),
  contribution: (orderId: string) => streamName(STREAM.delivery, 'contribution', orderId),
  code: (orderId: string) => streamName(STREAM.delivery, 'code', orderId),
  orderStop: (orderId: string) => streamName(STREAM.delivery, 'order-stop', orderId),
  routeStops: (routeId: string) => streamName(STREAM.delivery, 'route-stops', routeId),
  proofImages: (orderId: string) => streamName(STREAM.delivery, 'proof-images', orderId),
  proofImage: (imageId: string) => streamName(STREAM.delivery, 'proof-image', imageId),
  locations: streamName(STREAM.delivery, 'routing-locations'),
  routing: (orderId: string) => streamName(STREAM.delivery, 'routing', orderId),
  routingSlot: (locationId: string, slot: string) => streamName(STREAM.delivery, 'routing-slot', locationId, slot),
  fleet: (routeId: string) => streamName(STREAM.delivery, 'fleet-settlement', routeId),
};

const digest = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 32);
const payloads = async <T>(store: EventStore, tenantId: string, stream: string, type: string): Promise<T[]> =>
  (await store.readStream(tenantId, stream, { type })).map((e) => e.event.payload as T);
const put = async (store: EventStore, tenantId: string, stream: string, type: string, key: string, occurredAt: string, payload: unknown): Promise<void> => {
  const d = digest(key);
  await store.append(tenantId, stream, makeEvent({
    id: `${type}-${d}`, type, occurredAt, idempotencyKey: `${type}-${tenantId}-${d}`, source: 'api/fulfilment', payload: payload as Record<string, unknown>,
  }));
};

const OUT_GOING = new Set(['confirmed', 'picking', 'packed']);
const FINISHED = new Set(['delivered', 'partially_delivered', 'failed', 'returned_to_origin']);

/** Everything the package's routes read, from one event store. Exported for the driver-run hook and the tests. */
export function fulDelDeps(input: { readonly store: EventStore; readonly now: () => string; readonly signer: CatalogueDeps['signer']; readonly timeZone: (tenantId: string) => Promise<string> | string; readonly recordAudit?: Recorder; readonly courier?: CourierPartnerLink }) {
  const { store, now } = input;
  const orders = ordersAdapter({ store, now, holdMinutes: 30 });
  const catalogue = catalogueAdapter({ store, signer: input.signer, now });
  const service = deliveryServiceAdapter({ store, now, timeZone: input.timeZone });
  const assignments = assignmentsAdapter({ store, now });
  const runs = driverRunAdapter({ store, now });
  const costs = syncedGoodsReceiptAdapter({ store, now });
  const audit = input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit };

  const ordersAt = async (tenantId: string, storeId: string): Promise<readonly CandidateOrder[]> =>
    (await ordersForExport(store, tenantId)).filter((o) => o.locationId === storeId).map((o) => ({
      orderId: o.orderId, locationId: o.locationId, lines: o.lines.map((l) => ({ productId: l.productId, quantityMinor: l.quantityMinor })),
      state: o.currentState, placedAt: o.placedAt, ...(o.fulfilment === undefined ? {} : { fulfilment: o.fulfilment }),
    }));
  // The slot booking the storefront made at placement — found by its own key, no scan.
  const bookingOf = async (tenantId: string, orderId: string): Promise<DeliveryBooking | undefined> => {
    const found = await store.findByIdempotencyKey(tenantId, `slot-booking-${tenantId}-${orderId}`);
    if (found === undefined) return undefined;
    const b = found.event.payload as SlotBooking;
    return { slotStartsAt: b.slotStartsAt, slotEndsAt: b.slotEndsAt, ...(b.deliveryLocation === undefined ? {} : { deliveryLocation: b.deliveryLocation }) };
  };
  const packProducts = async (tenantId: string): Promise<readonly WaveProduct[] | undefined> =>
    (await catalogue.currentPack(tenantId))?.snapshot.products.map((p) => ({ productId: p.productId, name: p.name, baseUom: p.baseUom, unitPriceMinor: p.unitPriceMinor }));
  const today = async (tenantId: string): Promise<string> => wallClockIn(now(), await input.timeZone(tenantId)).slice(0, 10);

  const orderValueOf = async (tenantId: string, orderId: string): Promise<number | undefined> => {
    const placed = await orders.placedOrder(tenantId, orderId);
    const products = await packProducts(tenantId);
    if (placed === undefined || products === undefined) return undefined;
    let value = 0;
    for (const l of placed.lines) {
      const p = products.find((x) => x.productId === l.productId);
      if (p === undefined) return undefined;
      value += p.unitPriceMinor * l.quantityMinor;
    }
    return value;
  };
  const feeFor = async (tenantId: string, goodsMinor: number): Promise<number> => {
    const { policy } = resolveServiceabilityPolicy({ schedule: await serviceabilityAdapter({ store, now }).schedule(tenantId), on: await today(tenantId) });
    const fee = policy.deliveryFeeMinor ?? 0;
    return policy.freeDeliveryAboveMinor !== undefined && goodsMinor >= policy.freeDeliveryAboveMinor ? 0 : fee;
  };

  // ── The owner's numbers and the contribution rule ─────────────────────────────────────────────────────────
  const controls: DeliveryControlsDeps = {
    now, ...audit,
    controlsHistory: (t) => payloads<ControlsChange>(store, t, S.controls, 'DeliveryControlsSet'),
    recordControls: (t, c) => put(store, t, S.controls, 'DeliveryControlsSet', `${c.setBy}|${c.setAt}|${JSON.stringify(c.changes)}`, c.setAt, c),
    openDeliveryOrders: async (t, storeId) => (await ordersAt(t, storeId)).filter((o) => o.fulfilment === 'delivery' && OUT_GOING.has(o.state)).map((o) => o.orderId),
    contributionFacts: async (t, orderId) => {
      const placed = await orders.placedOrder(t, orderId);
      if (placed === undefined || placed.fulfilment !== 'delivery') return undefined;
      const products = await packProducts(t);
      let value = 0;
      let margin: number | undefined = 0;
      for (const l of placed.lines) {
        const p = products?.find((x) => x.productId === l.productId);
        const cost = await costs.unitCostMinor(t, l.productId);
        if (p === undefined) { margin = undefined; continue; }
        value += p.unitPriceMinor * l.quantityMinor;
        if (cost === undefined || margin === undefined) { margin = undefined; continue; }
        margin += p.unitPriceMinor * l.quantityMinor - valueAtUnitCost(l.quantityMinor, p.baseUom, cost);
      }
      const booking = await bookingOf(t, orderId);
      const storeAt = (await service.config(t))?.storeLocation;
      const distance = booking?.deliveryLocation === undefined || storeAt === undefined ? undefined : metresBetween(storeAt, booking.deliveryLocation);
      return { orderId, storeId: placed.locationId, orderValueMinor: value, itemsMarginMinor: margin, deliveryFeeMinor: await feeFor(t, value), distanceMetres: distance };
    },
    contributionRecord: async (t, orderId) => (await payloads<ContributionRecord>(store, t, S.contribution(orderId), 'ContributionJudged'))[0],
    // Keyed on the order: the first judgement stands, a second write is the same record.
    recordContribution: (t, r) => put(store, t, S.contribution(r.orderId), 'ContributionJudged', r.orderId, r.at, r),
    decisions: (t, orderId) => payloads<ContributionDecision>(store, t, S.contribution(orderId), 'ContributionDecided'),
    recordDecision: (t, d) => put(store, t, S.contribution(d.orderId), 'ContributionDecided', `${d.orderId}|${d.by}|${d.at}|${d.decision}`, d.at, d),
  };
  const standing = async (t: string, orderId: string) => (await judgeOnce(controls, t, orderId))?.standing ?? 'clear';
  const controlValues = async (t: string) => foldControls(await controls.controlsHistory(t)).values;

  // ── The code, the stop index and the proof images ───────────────────────────────────────────────────────────
  const issuedCode = async (t: string, orderId: string) => (await payloads<IssuedCode>(store, t, S.code(orderId), 'DeliveryCodeIssued'))[0];
  const recordCode = (t: string, c: IssuedCode) => put(store, t, S.code(c.orderId), 'DeliveryCodeIssued', c.orderId, c.issuedAt, c);
  const routeLive = async (t: string, routeId: string, storeId: string | undefined): Promise<boolean> => {
    const stores = storeId === undefined ? await assignedStoresOf({ store }, t, 'route', routeId, []) : [storeId];
    for (const s of stores) {
      const a = latestRoutes(await assignments.routeAssignments(t, s)).find((r) => r.routeId === routeId);
      if (a !== undefined) return a.withdrawn === undefined;
    }
    return false;
  };
  const orderStop = async (t: string, orderId: string): Promise<OrderStop | undefined> => {
    const last = (await payloads<OrderStop & { storeId?: string }>(store, t, S.orderStop(orderId), 'OrderStopIndexed')).at(-1);
    if (last === undefined || !(await routeLive(t, last.routeId, last.storeId))) return undefined;
    return last;
  };
  const proofImages = (t: string, orderRef: string) => payloads<ProofImage>(store, t, S.proofImages(orderRef), 'ProofImageKept');
  const proof: DeliveryProofDeps = {
    now, ...audit,
    placedOrder: async (t, orderId) => {
      const p = await orders.placedOrder(t, orderId);
      return p === undefined ? undefined : { orderId: p.orderId, locationId: p.locationId, ...(p.customerRef === undefined ? {} : { customerRef: p.customerRef }), ...(p.fulfilment === undefined ? {} : { fulfilment: p.fulfilment }) };
    },
    orderState: async (t, orderId) => (await orders.orderState(t, orderId))?.state,
    recordAccessRefusal: async (t, r) => { await orders.recordAccessRefusal(t, r); },
    issuedCode, recordCode, orderStop,
    routeStops: async (t, routeId) => {
      const latest = new Map<string, OrderStop>();
      for (const s of await payloads<OrderStop>(store, t, S.routeStops(routeId), 'OrderStopIndexed')) latest.set(s.stopId, s);
      return [...latest.values()].sort((a, b) => a.sequence - b.sequence);
    },
    finishedStops: async (t, routeId): Promise<readonly EtaStamp[]> =>
      (await runs.stopUpdates(t, routeId)).filter((u) => FINISHED.has(u.state)).map((u) => ({ stopId: u.stopId, at: u.at })),
    doorProof: async (t, orderId) => {
      const at = await orderStop(t, orderId);
      if (at === undefined) return undefined;
      const door = (await runs.stopUpdates(t, at.routeId)).filter((u) => u.stopId === at.stopId && (u.state === 'delivered' || u.state === 'partially_delivered')).at(-1);
      return door === undefined ? undefined : { routeId: door.routeId, stopId: door.stopId, state: door.state, proofKind: door.proofKind, proofCheck: door.proofCheck ?? null, flags: door.governanceFlags, at: door.at };
    },
    proofImages,
    proofImage: async (t, imageId) => (await payloads<ProofImage & { contentBase64: string }>(store, t, S.proofImage(imageId), 'ProofImageFileKept'))[0],
    recordProofImage: async (t, image, contentBase64) => {
      await store.appendBatch(t, [
        { stream: S.proofImage(image.imageId), event: makeEvent({ id: `proof-image-file-${image.imageId}`, type: 'ProofImageFileKept', occurredAt: image.receivedAt, idempotencyKey: `proof-image-file-${t}-${image.imageId}`, source: 'api/fulfilment', payload: { ...image, contentBase64 } }) },
        { stream: S.proofImages(image.orderRef), event: makeEvent({ id: `proof-image-${image.orderRef}-${image.imageId}`, type: 'ProofImageKept', occurredAt: image.receivedAt, idempotencyKey: `proof-image-${t}-${image.orderRef}-${image.imageId}`, source: 'api/fulfilment', payload: image }) },
      ]);
    },
    permissionsOfUser: (t, u) => permissionsHeldBy(store, t, u),
    randomInt: (max) => randomInt(max),
  };

  // ── The proof judged at head office when the phone's stop reaches it (the driver-run relay's hook) ─────────────
  const judgeDoorProof = async (t: string, i: DoorProofInput) => {
    const issued = await issuedCode(t, i.orderRef);
    const address = (await orderStop(t, i.orderRef))?.address ?? (await bookingOf(t, i.orderRef))?.deliveryLocation;
    return {
      code: judgeCode(issued?.code, i.proofKind === 'otp' ? (i.proofCode ?? undefined) : undefined),
      fence: judgeProofLocation({ device: i.deviceFix, address, radiusMetres: (await controlValues(t)).geofenceRadiusMetres }),
    };
  };

  // ── The wave builder ────────────────────────────────────────────────────────────────────────────────────────
  const waves = fulfilmentWaveAdapter({ store, now });
  const warehouse = warehouseAdapter({ store, now });
  const waveBuilder: WaveBuilderDeps = {
    now, ...audit,
    permissionsOfUser: (t, u) => permissionsHeldBy(store, t, u),
    ordersAt, packProducts,
    bins: async (t) => warehouse.bins(t),
    binContents: async (t) => warehouse.contents(t),
    waveAssignments: async (t, s) => assignments.waveAssignments(t, s),
    recordWaveAssignment: async (t, a) => { await assignments.recordWaveAssignment(t, a); },
    wavePacked: async (t, w) => assignments.wavePacked(t, w),
    lineOutcomes: async (t, w) => waves.lineOutcomes(t, w),
    standing,
    slotOf: async (t, orderId) => {
      const b = await bookingOf(t, orderId);
      return b === undefined ? undefined : { startsAt: b.slotStartsAt, endsAt: b.slotEndsAt };
    },
  };

  // ── The dispatch office ─────────────────────────────────────────────────────────────────────────────────────
  const dispatch = dispatchAdapter({ store, now });
  const board: DispatchBoardDeps = {
    now, ...audit,
    permissionsOfUser: (t, u) => permissionsHeldBy(store, t, u),
    ordersAt, bookingOf,
    shopClock: async (t, iso) => wallClockIn(iso, await input.timeZone(t)),
    storeLocation: async (t) => (await service.config(t))?.storeLocation,
    radiusOn: async (t, day) => (await service.policyOn(t, day)).radiusMetres ?? 10_000,
    codOf: async (t, orderId) => {
      const value = await orderValueOf(t, orderId);
      if (value === undefined) return 0;
      const pay = paymentPosition(await orders.orderPayment(t, orderId), await orders.paymentResolution(t, orderId));
      return Math.max(0, value + (await feeFor(t, value)) - pay.paidMinor);
    },
    orderValueOf, standing,
    plan: async (t, d) => dispatch.plan(t, d),
    recordPlan: async (t, d, p, k) => { await dispatch.recordPlan(t, d, p, k); },
    routeAssignments: async (t, s) => assignments.routeAssignments(t, s),
    recordRouteAssignment: async (t, a) => { await assignments.recordRouteAssignment(t, a); },
    routeSettled: async (t, r) => assignments.routeSettled(t, r),
    stopUpdates: async (t, r) => runs.stopUpdates(t, r),
    settlement: async (t, r) => runs.settlement(t, r),
    handover: async (t, r) => runs.handover(t, r),
    recordOrderStop: async (t, s) => {
      const storeId = (await assignedStoresOf({ store }, t, 'route', s.routeId, []))[0];
      const record = { ...s, ...(storeId === undefined ? {} : { storeId }) };
      const key = `${s.orderId}|${s.routeId}|${s.stopId}|${s.plannedArrivalAt}|${s.address === undefined ? '' : `${s.address.lat},${s.address.lon}`}`;
      const d = digest(key);
      await store.appendBatch(t, [
        { stream: S.orderStop(s.orderId), event: makeEvent({ id: `order-stop-${d}`, type: 'OrderStopIndexed', occurredAt: s.assignedAt, idempotencyKey: `order-stop-${t}-${d}`, source: 'api/fulfilment', payload: record }) },
        { stream: S.routeStops(s.routeId), event: makeEvent({ id: `route-stop-index-${d}`, type: 'OrderStopIndexed', occurredAt: s.assignedAt, idempotencyKey: `route-stop-index-${t}-${d}`, source: 'api/fulfilment', payload: record }) },
      ]);
    },
    issueCode: async (t, orderId) => { await codeFor(proof, t, orderId, 'route'); },
    imageCount: async (t, orderId) => (await proofImages(t, orderId)).length,
  };

  // ── Branch routing ──────────────────────────────────────────────────────────────────────────────────────────
  const routing: OrderRoutingDeps = {
    now, ...audit,
    locations: async (t) => {
      const latest = new Map<string, RoutingLocation>();
      for (const l of await payloads<RoutingLocation>(store, t, S.locations, 'RoutingLocationSet')) latest.set(l.locationId, l);
      return [...latest.values()].sort((a, b) => a.locationId.localeCompare(b.locationId));
    },
    recordLocation: (t, l) => put(store, t, S.locations, 'RoutingLocationSet', `${l.locationId}|${l.setAt}|${JSON.stringify(l)}`, l.setAt, l),
    availableAt: async (t, locationId, productIds) => {
      const onHand = await orders.onHand(t, locationId);
      const held = new Map<string, number>();
      for (const r of await orders.outstanding(t, locationId)) held.set(r.productId, (held.get(r.productId) ?? 0) + r.quantityMinor);
      return productIds.map((productId) => ({ locationId, productId, availableMinor: Math.max(0, (onHand.get(productId) ?? 0) - (held.get(productId) ?? 0)) }));
    },
    decisions: (t, orderId) => payloads<RoutingDecision>(store, t, S.routing(orderId), 'OrderRouted'),
    routedTo: async (t, locationId, slot) => {
      const latest = new Map<string, RoutingDecision>();
      for (const d of await payloads<RoutingDecision>(store, t, S.routingSlot(locationId, slot), 'OrderRouted')) latest.set(d.orderId, d);
      const out: RoutingDecision[] = [];
      // Only an order whose LATEST decision still routes it here holds a place.
      for (const d of latest.values()) {
        const last = (await payloads<RoutingDecision>(store, t, S.routing(d.orderId), 'OrderRouted')).at(-1);
        if (last?.result.routed === true && last.result.locationId === locationId && last.slotStartsAt === slot) out.push(last);
      }
      return out;
    },
    recordDecision: async (t, d) => {
      const key = digest(`${d.orderId}|${d.at}|${d.result.outcome}|${d.result.locationId ?? ''}`);
      const entries = [{ stream: S.routing(d.orderId), event: makeEvent({ id: `order-routed-${key}`, type: 'OrderRouted', occurredAt: d.at, idempotencyKey: `order-routed-${t}-${key}`, source: 'api/fulfilment', payload: d }) }];
      if (d.result.routed && d.result.locationId !== undefined && d.slotStartsAt !== null) {
        entries.push({ stream: S.routingSlot(d.result.locationId, d.slotStartsAt), event: makeEvent({ id: `order-routed-slot-${key}`, type: 'OrderRouted', occurredAt: d.at, idempotencyKey: `order-routed-slot-${t}-${key}`, source: 'api/fulfilment', payload: d }) });
      }
      await store.appendBatch(t, entries);
    },
    released: async (t, orderId) => (await orders.orderState(t, orderId))?.state === 'cancelled',
    placedBy: async (t, orderId) => {
      const p = await orders.placedOrder(t, orderId);
      return p === undefined ? undefined : (p.customerRef ?? '(placed at the desk)');
    },
  };

  // ── Own-fleet settlement and the courier link ──────────────────────────────────────────────────────────────
  const fleet: FleetSettlementDeps = {
    now, ...audit,
    courier: input.courier ?? SWITCHED_OFF_COURIER,
    fleetRate: async (t) => (await controlValues(t)).fleetRate,
    routeDriver: async (t, routeId) => {
      for (const s of await assignedStoresOf({ store }, t, 'route', routeId, [])) {
        const a = latestRoutes(await assignments.routeAssignments(t, s)).find((r) => r.routeId === routeId);
        if (a !== undefined) return a.driverId;
      }
      return undefined;
    },
    stopUpdates: async (t, r) => runs.stopUpdates(t, r),
    steps: (t, routeId) => payloads<FleetSettlementStep>(store, t, S.fleet(routeId), 'FleetSettlementStep'),
    recordStep: (t, s) => put(store, t, S.fleet(s.routeId), 'FleetSettlementStep', `${s.routeId}|${s.step}|${s.by}|${s.at}`, s.at, s),
  };

  return { controls, proof, judgeDoorProof, waveBuilder, board, routing, fleet, latestStops };
}

/** The package's routes. With no store (a bare composition) nothing is registered — every route needs the registers. */
export function fulfilmentDeliveryRoutes(input: FulDelInput): readonly Route[] {
  if (input.store === undefined) return [];
  const d = fulDelDeps({ ...input, store: input.store });
  return [
    ...waveBuilderRoutes(d.waveBuilder),
    ...deliveryControlsRoutes(d.controls),
    ...deliveryProofRoutes(d.proof),
    ...dispatchBoardRoutes(d.board),
    ...orderRoutingRoutes(d.routing),
    ...fleetSettlementRoutes(d.fleet),
  ];
}

/** Spread into the driver-run relay's deps: the code and the proof location judged when the phone's stop reaches head office. */
export function fulDelDriverRunHooks(input: Omit<FulDelInput, 'store'> & { readonly store: EventStore }): { readonly judgeDoorProof: ReturnType<typeof fulDelDeps>['judgeDoorProof'] } {
  return { judgeDoorProof: fulDelDeps(input).judgeDoorProof };
}
