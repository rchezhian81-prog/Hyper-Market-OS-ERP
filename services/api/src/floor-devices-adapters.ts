// OB-288 P6 — store floor devices: head office's wiring (R8-4 ESL · R8-5 RFID · R8-6 IoT · R8-7 CCTV events · D14-FR-05 ·
// D06-FR-06 · owner decisions OB-217 and OB-316).
//
//   1. The FLOOR-DEVICE register and its ingestion door (services/platform/src/device-events.ts) over the event store:
//      registrations and status changes, every event a device sent with what it became, every refused batch, and every
//      price push to the labels — all append-only (hard rules #2 and #6).
//   2. The signature check is node:crypto Ed25519 against the key the device was registered with. The gateway that
//      carries a batch is a MACHINE identity (`floor_device_gateway`, hard rule #4) and vouches for nothing.
//   3. ESL push on a price change (R8-4): the price routes are wrapped in place — after a price is recorded for stores,
//      every active label of that product at a branch whose `esl` switch is on is sent the new price through the vendor
//      port. The ONLY vendor adapter in this build is the stand-in (`StandInEslVendor`): it records the command and never
//      calls anyone. The till price is never touched here.
//   4. What an event becomes is done by the routes that already own it: an ESL echo is a price-integrity observation
//      (D-7), a sensor reading is a facilities reading (M26-FR-02, so a breach holds the room's stock), an RFID count is
//      compared with the stock ledger's own on-hand, and camera events are joined to the loss-prevention record.
//
// Composition: `floorDevicesSurface(surface, …)` is the one line in `main.ts`. A route it needs that is missing throws at
// start-up: a control that silently does nothing is the failure P-08 forbids.

import { createPublicKey, verify as verifySignature } from 'node:crypto';
import { InMemoryEventStore, type EventStore } from '../../../packages/persistence/src/event-store';
import type { Route, RequestContext, HandlerResult } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import type { ShopCalendarOf } from '../../../packages/calendar/src/shop-clock';
import { makeEvent } from '../../../packages/contracts/src/event';
import { decideRollout, type RolloutChange } from '../../../packages/platform/src/rollout';
import type { BookUnits, LaneException } from '../../../packages/integration/src/floor-devices';
import {
  floorDeviceRoutes, pushEslOnPriceChange,
  type FloorDeviceDeps, type FloorDeviceLogEntry, type StoredFloorEvent, type RefusedFloorBatch, type EslPush, type EslVendorPort,
} from '../../platform/src/device-events';
import type { TillActivity } from '../../pos/src/loss-prevention';
import { selfCheckoutBasketRoutes, type SelfCheckoutBasketDeps, type SelfCheckoutBasketRecord } from '../../pos/src/self-checkout-baskets';
import { basketSummary } from '../../../packages/self-checkout/src/basket-evidence';
import { STREAM, streamName, effectiveGrants, orgStructureAdapter, inventoryAdapter, productMasterAdapter, permissionsHeldBy } from './adapters';
import { ROLLOUT_STREAM } from './saas-rollout-adapters';
import { FLOOR_DEVICE_GATEWAY_ROLE_ID } from './roles';

type Recorder = (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
export interface FloorDevicesInput {
  readonly store?: EventStore;
  readonly now: () => string;
  /** The label vendor. Absent → the stand-in (the only adapter in this build; no live vendor is ever called). */
  readonly eslVendor?: EslVendorPort;
  readonly recordAudit?: Recorder;
  /** R16-A (M01-FR-02): the shop's calendar — the CCTV links of a day are the SHOP's day. */
  readonly calendar?: ShopCalendarOf;
}

const DEVICES_STREAM = streamName(STREAM.platform, 'floor-devices');
const EVENTS_STREAM = streamName(STREAM.platform, 'floor-device-events');
const REFUSALS_STREAM = streamName(STREAM.platform, 'floor-device-refusals');
const PUSHES_STREAM = streamName(STREAM.platform, 'esl-pushes');
const LP_ACTIVITY_STREAM = streamName(STREAM.lossPrevention, 'activity');
const SCO_BASKETS_STREAM = streamName(STREAM.lossPrevention, 'self-checkout-baskets');

/** R8-3 · R8-7: the self-checkout baskets the store computers relayed, kept once each (append-only). */
export function selfCheckoutBasketAdapter(input: { readonly store: EventStore; readonly now: () => string }): SelfCheckoutBasketDeps {
  const { store, now } = input;
  return {
    now,
    baskets: (t) => payloads<SelfCheckoutBasketRecord>(store, t, SCO_BASKETS_STREAM, 'SelfCheckoutBasketKept'),
    recordBasket: async (t, r) => {
      await store.append(t, SCO_BASKETS_STREAM, makeEvent({ id: `sco-basket-${safeKey(r.activityId)}`, type: 'SelfCheckoutBasketKept', occurredAt: r.at, idempotencyKey: `sco-basket-${t}-${safeKey(r.activityId)}`, source: 'api/pos', payload: r as unknown as Record<string, unknown> }));
    },
    permissionsOf: (t, u) => permissionsHeldBy(store, t, u),
  };
}

/**
 * The stand-in ESL vendor (EXTERNAL until a vendor is contracted): it keeps every command it was given, in memory, and
 * says it took it. It never opens a connection. Tests read `sent`; a real adapter replaces it behind the same port.
 */
export class StandInEslVendor implements EslVendorPort {
  readonly name = 'stand-in (no vendor connected — built with a stand-in, not verified on hardware)';
  readonly sent: { readonly pushId: string; readonly deviceId: string; readonly productId: string; readonly priceMinor: number }[] = [];
  /** Labels this stand-in pretends cannot be reached — for a test of a label that did not take the price. */
  readonly unreachable = new Set<string>();
  async push(c: { readonly pushId: string; readonly deviceId: string; readonly vendor: string; readonly productId: string; readonly shelfAddress: string; readonly priceMinor: number }): Promise<{ readonly accepted: boolean; readonly detail: string }> {
    if (this.unreachable.has(c.deviceId)) return { accepted: false, detail: `stand-in: label ${c.deviceId} did not answer` };
    this.sent.push({ pushId: c.pushId, deviceId: c.deviceId, productId: c.productId, priceMinor: c.priceMinor });
    return { accepted: true, detail: `stand-in: price ${c.priceMinor} queued for label ${c.deviceId} at ${c.shelfAddress} — nothing was sent to real hardware` };
  }
}

const payloads = async <T>(store: EventStore, tenantId: string, stream: string, type: string): Promise<T[]> =>
  (await store.readStream(tenantId, stream, { type })).map((e) => e.event.payload as T);
const safeKey = (s: string): string => s.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 180);

/** A route's handler on the surface, found when it is called (so a wrap applied later is the one run). */
const handlerOf = (surface: readonly Route[], method: string, path: string) => (ctx: RequestContext): Promise<HandlerResult> => {
  const r = surface.find((x) => x.method === method && x.path === path);
  if (r === undefined) throw new Error(`the floor-device wiring cannot find ${method} ${path}`);
  return Promise.resolve(r.handler(ctx));
};

function wrap(surface: Route[], method: string, path: string, around: (inner: Route['handler']) => Route['handler']): void {
  const at = surface.findIndex((r) => r.method === method && r.path === path);
  if (at < 0) throw new Error(`the floor-device wiring cannot find ${method} ${path} — the ESL push it adds would silently not happen`);
  surface[at] = { ...surface[at]!, handler: around(surface[at]!.handler) };
}

/** Is this an Ed25519 public key in SPKI PEM? */
export function keyIsEd25519(pem: string): boolean {
  try { return createPublicKey(pem).asymmetricKeyType === 'ed25519'; } catch { return false; }
}

/** Does the base64 signature verify over the message with this Ed25519 key? Any malformed input is "no". */
export function verifiesWith(pem: string, message: string, signatureBase64: string): boolean {
  try { return verifySignature(null, Buffer.from(message, 'utf8'), createPublicKey(pem), Buffer.from(signatureBase64, 'base64')); } catch { return false; }
}

export function floorDevicesAdapter(input: { readonly store: EventStore; readonly now: () => string; readonly eslVendor: EslVendorPort; readonly recordAudit?: Recorder }, surface: readonly Route[]): FloorDeviceDeps {
  const { store, now } = input;
  const observe = handlerOf(surface, 'POST', '/v1/pricing/integrity/observations/:observationId');
  const reading = handlerOf(surface, 'POST', '/v1/facilities/equipment/:assetId/readings/:readingId');
  return {
    now,
    log: (t) => payloads<FloorDeviceLogEntry>(store, t, DEVICES_STREAM, 'FloorDeviceLogged'),
    recordLog: async (t, entry) => {
      const id = entry.entry === 'registered' ? `registered-${entry.registration.deviceId}` : `status-${entry.deviceId}-${entry.at}`;
      await store.append(t, DEVICES_STREAM, makeEvent({ id: `floor-device-${safeKey(id)}`, type: 'FloorDeviceLogged', occurredAt: entry.at, idempotencyKey: `floor-device-${t}-${safeKey(id)}`, source: 'api/platform', payload: entry as unknown as Record<string, unknown> }));
    },
    events: (t) => payloads<StoredFloorEvent>(store, t, EVENTS_STREAM, 'FloorDeviceEventKept'),
    recordEvents: async (t, events) => {
      // One write for the batch; each event idempotent on its device and its own id (a re-send is one fact).
      await store.appendBatch(t, events.map((e) => ({
        stream: EVENTS_STREAM,
        event: makeEvent({ id: `floor-event-${safeKey(`${e.deviceId}-${e.eventId}`)}`, type: 'FloorDeviceEventKept', occurredAt: e.receivedAt, idempotencyKey: `floor-event-${t}-${safeKey(`${e.deviceId}-${e.eventId}`)}`, source: 'api/platform', payload: e as unknown as Record<string, unknown> }),
      })));
    },
    refusedBatches: (t) => payloads<RefusedFloorBatch>(store, t, REFUSALS_STREAM, 'FloorDeviceBatchRefused'),
    recordRefusedBatch: async (t, r) => {
      await store.append(t, REFUSALS_STREAM, makeEvent({ id: `floor-refusal-${safeKey(r.batchRef)}-${safeKey(r.at)}`, type: 'FloorDeviceBatchRefused', occurredAt: r.at, idempotencyKey: `floor-refusal-${t}-${safeKey(r.batchRef)}-${safeKey(r.code)}`, source: 'api/platform', payload: r as unknown as Record<string, unknown> }));
    },
    pushes: (t) => payloads<EslPush>(store, t, PUSHES_STREAM, 'EslPriceSent'),
    recordPush: async (t, p) => {
      await store.append(t, PUSHES_STREAM, makeEvent({ id: `esl-push-${safeKey(p.pushId)}`, type: 'EslPriceSent', occurredAt: p.at, idempotencyKey: `esl-push-${t}-${safeKey(p.pushId)}`, source: 'api/platform', payload: p as unknown as Record<string, unknown> }));
    },
    branches: async (t) => (await orgStructureAdapter({ store, now }).nodes(t)).filter((n) => n.kind === 'branch').map((n) => ({ branchId: n.nodeId, status: n.status })),
    // OB-316: the branch-wide setting decides for a floor device (devices are not till lanes); nobody set → off.
    switchOn: async (t, key, branchId) => {
      const d = decideRollout(await payloads<RolloutChange>(store, t, ROLLOUT_STREAM, 'RolloutSwitchSet'), key, { branchId });
      return { on: d.on, detail: d.detail };
    },
    isGateway: async (t, userId) => {
      const roles = (await effectiveGrants(store, t)).filter((g) => g.userId === userId).map((g) => g.roleId);
      return roles.length > 0 && roles.every((r) => r === FLOOR_DEVICE_GATEWAY_ROLE_ID);
    },
    keyIsEd25519,
    verify: verifiesWith,
    recordPriceObservation: async (ctx, o) => {
      // A device clock a little ahead is clamped to head office's — the observation route refuses a future sighting.
      const observedAt = Date.parse(o.observedAt) > Date.parse(now()) ? now() : o.observedAt;
      const res = await observe({ ...ctx, params: { observationId: o.observationId }, body: { branchId: o.branchId, productId: o.productId, surface: 'esl', priceMinor: o.priceMinor, observedAt, shelfAddress: o.shelfAddress, deviceId: o.deviceId } });
      if (res.status >= 300) throw new Error(`the price observation was not recorded (${res.status})`);
    },
    recordSensorReading: async (ctx, r) => {
      const at = Date.parse(r.at) > Date.parse(now()) ? now() : r.at;
      const res = await reading({ ...ctx, params: { assetId: r.assetId, readingId: r.readingId }, body: { tenthsC: r.tenthsC, at, source: 'sensor', recordedBy: r.recordedBy } });
      return { state: String((res.body as { state?: unknown } | null)?.state ?? 'unknown') };
    },
    bookUnits: async (t, locationId, productId): Promise<BookUnits> => {
      const product = await productMasterAdapter({ store, now }).product(t, productId);
      if (product === undefined) return { known: false, why: `head office has no product ${productId}` };
      // Only an each-item is counted in units by a reader; a weighed or measured product is not comparable (P-08).
      if (product.baseUom !== 'ea') return { known: false, why: `${product.name} is sold by ${product.baseUom}, and a reader counts tags, not ${product.baseUom}` };
      const rows = (await inventoryAdapter({ store, now }).availability(t, productId)).filter((r) => r.locationId === locationId);
      if (rows.length === 0) return { known: false, why: `the stock ledger has no movement of ${product.name} at ${locationId} yet` };
      return { known: true, units: rows.reduce((s, r) => s + r.onHandMinor, 0) };
    },
    laneExceptions: async (t, branchId, from, to): Promise<readonly LaneException[]> => {
      const lo = Date.parse(from);
      const hi = Date.parse(to);
      const till = (await payloads<TillActivity>(store, t, LP_ACTIVITY_STREAM, 'TillActivityRecorded'))
        .filter((a) => a.storeId === branchId && a.kind !== 'card_refund_on_machine' && Date.parse(a.at) >= lo && Date.parse(a.at) <= hi)
        .map((a) => ({
          ref: `till-activity:${a.activityId}`, laneId: a.laneId, at: a.at, kind: a.kind, cashierId: a.cashierId, valueMinor: a.valueMinor,
          detail: `${a.kind.replace(/_/g, ' ')} on lane ${a.laneId}${a.billRef === undefined ? '' : `, bill ${a.billRef}`}: ${a.reason}`,
        }));
      // R8-7: a self-checkout basket a colleague was needed for is a place to look as well (its payment alone is not).
      const sco = (await selfCheckoutBasketAdapter({ store, now }).baskets(t))
        .filter((r) => r.storeId === branchId && Date.parse(r.at) >= lo && Date.parse(r.at) <= hi && r.selfCheckout.interventions.some((i) => i.kind !== 'payment'))
        .map((r) => ({ ref: `self-checkout:${r.activityId}`, laneId: r.laneId, at: r.at, kind: 'self_checkout_basket', cashierId: r.cashierId, valueMinor: r.valueMinor, detail: `self-checkout bill ${r.billRef}: ${basketSummary(r.selfCheckout)}` }));
      return [...till, ...sco];
    },
    eslVendor: input.eslVendor,
    ...(input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit }),
  };
}

/** R8-4: a price recorded for stores is pushed to the labels that show it (after the price route has recorded it). */
function eslOnPriceChange(surface: Route[], deps: FloorDeviceDeps, now: () => string): void {
  wrap(surface, 'POST', '/v1/prices/changes', (inner) => async (ctx) => {
    const res = await inner(ctx);
    const b = res.body as { productId?: unknown; priceMinor?: unknown; operativeAt?: unknown } | null;
    if (res.status < 300 && typeof b?.productId === 'string' && Number.isInteger(b.priceMinor) && Array.isArray(b.operativeAt)) {
      const esl = await pushEslOnPriceChange(deps, ctx.tenantId, { productId: b.productId, priceMinor: b.priceMinor as number, branchIds: (b.operativeAt as unknown[]).filter((s): s is string => typeof s === 'string'), by: ctx.userId, sourceRef: `price-change:${b.productId}:${now()}` });
      return { ...res, body: { ...(res.body as Record<string, unknown>), electronicLabels: esl } };
    }
    return res;
  });
  wrap(surface, 'POST', '/v1/prices/list/:productId/entries/:entryId', (inner) => async (ctx) => {
    const res = await inner(ctx);
    const b = res.body as { productId?: unknown; scope?: unknown; scopeRef?: unknown; priceMinor?: unknown; effectiveFrom?: unknown; entryId?: unknown } | null;
    // A store price-list entry that is already in force is pushed now; one dated ahead is pushed by its price change then.
    if (res.status < 300 && b?.scope === 'store' && typeof b.scopeRef === 'string' && typeof b.productId === 'string' && Number.isInteger(b.priceMinor)
      && typeof b.effectiveFrom === 'string' && Date.parse(b.effectiveFrom) <= Date.parse(now())) {
      const esl = await pushEslOnPriceChange(deps, ctx.tenantId, { productId: b.productId, priceMinor: b.priceMinor as number, branchIds: [b.scopeRef], by: ctx.userId, sourceRef: `price-list:${b.productId}:${String(b.entryId)}` });
      return { ...res, body: { ...(res.body as Record<string, unknown>), electronicLabels: esl } };
    }
    return res;
  });
}

/** The one line in main.ts: the floor-device routes, and the ESL push on the existing price routes. */
export function floorDevicesSurface(surface: Route[], raw: FloorDevicesInput): void {
  const input = { store: raw.store ?? new InMemoryEventStore(), now: raw.now, eslVendor: raw.eslVendor ?? new StandInEslVendor(), ...(raw.recordAudit === undefined ? {} : { recordAudit: raw.recordAudit }) };
  const deps = floorDevicesAdapter(input, surface);
  surface.push(...floorDeviceRoutes(raw.calendar === undefined ? deps : { ...deps, calendar: raw.calendar }));
  surface.push(...selfCheckoutBasketRoutes(selfCheckoutBasketAdapter(input)));
  eslOnPriceChange(surface, deps, input.now);
}
