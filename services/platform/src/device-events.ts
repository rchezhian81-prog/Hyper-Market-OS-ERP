// API-11 Floor devices — electronic shelf labels, RFID readers, IoT sensors and CCTV event sources (R8-4 · R8-5 · R8-6 ·
// R8-7 · D14-FR-05 · D06-FR-06 · M26-FR-02 · M15 · §8.2 · OB-217 · OB-316 · P-04 · P-08 · hard rules #2, #4, #5, #6, #10).
//
// Head office's side of the vendor-neutral device port (packages/integration/src/floor-devices.ts has the rules). The
// devices and their vendors are EXTERNAL: every adapter behind this is a stand-in, and every reply says so
// (`HARDWARE_NOT_VERIFIED`). No live vendor is ever called.
//
//   POST /v1/devices/floor/:deviceId                register a device at a branch, bound to what it watches, with its own
//                                                   public key (platform.device.manage). One record per id, never forked.
//   POST /v1/devices/floor/:deviceId/status         block, retire or reinstate it, with a reason — a new event, the history
//                                                   kept (retired is final).
//   GET  /v1/devices/floor?branchId=                the devices, each with its switch, when it was last heard and what was
//                                                   refused — silence and refusals shown, never hidden (P-08).
//   GET  /v1/devices/floor/exceptions?branchId=     every refused batch and refused event, kept (hard rule #6).
//   POST /v1/devices/floor/:deviceId/events         the ingestion door (device.event.ingest). Called ONLY by the store's
//                                                   floor-device gateway, a machine identity (hard rule #4) — and even then
//                                                   a batch is believed only when the DEVICE's own signature verifies, the
//                                                   device is registered and active at a branch in the gateway's scope, and
//                                                   its kind's rollout switch is ON there (OB-316). Rate-limited per device.
//   GET  /v1/devices/esl/pushes?branchId=           each price push to the labels and whether every label has echoed it
//                                                   back (`pushEslPrice`): only then is the shelf known to match the till.
//   POST /v1/devices/esl/pushes/:pushId/retry       push the SAME price again to the labels that have not confirmed — never
//                                                   a new price: a price is only ever changed through the price routes.
//   GET  /v1/devices/rfid/variances?branchId=       RFID counts that differ from the book stock — for a person to count.
//   GET  /v1/devices/cctv/links?branchId=&day=      camera events joined to till exceptions at the lanes each camera looks
//                                                   at, inside the period the camera event covers. A place to look, never an
//                                                   accusation; the case is opened by a person.
//
// What each event becomes (never a ledger edit, hard rule #2; nothing commits a price, stock or money, hard rule #5):
//   esl.echo     → a price OBSERVATION on the `esl` surface (D-7's price-integrity ageing then ranks a shelf showing less
//                  than the till first), and the confirmation a push waits for.
//   rfid.read    → a COUNT OBSERVATION against the book stock: agrees, a variance, or not comparable (and why).
//   iot.reading  → a facilities READING, source `sensor`, through the same route a hand-written reading takes — so a breach
//                  holds the room's stock exactly as it would from a probe (M26-FR-02, PA-07).
//   cctv.event   → camera METADATA only (no footage, nothing that identifies a person — OB-217).

import type { Route, RequestContext, HandlerResult } from '../../kernel/src/index';
import { apiError, notFound, assertBranchInScope, ApiError } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { shopClock, shopDateIn, type ShopCalendarOf } from '../../../packages/calendar/src/shop-clock';
import {
  readFloorDeviceRegistration, readFloorEvent, deviceBatchMessage, admitBatch, rfidCountObservation, linkCameraEvents,
  FLOOR_DEVICE_SWITCH, HARDWARE_NOT_VERIFIED,
  type FloorDeviceRegistration, type FloorDeviceStatus, type FloorEvent, type BookUnits, type LaneException,
  type RfidCountObservation, type CameraEventFact,
} from '../../../packages/integration/src/floor-devices';
import { pushEslPrice, type EslPushResult } from '../../../packages/self-checkout/src/price-integrity';

/** A registered device as head office holds it — the registration plus its latest status. */
export interface FloorDeviceRecord extends FloorDeviceRegistration {
  readonly status: FloorDeviceStatus;
  readonly registeredBy: string;
  readonly registeredAt: string;
  readonly statusReason?: string;
}

export type FloorDeviceLogEntry =
  | { readonly entry: 'registered'; readonly registration: FloorDeviceRegistration; readonly by: string; readonly at: string }
  | { readonly entry: 'status'; readonly deviceId: string; readonly status: FloorDeviceStatus; readonly reason: string; readonly by: string; readonly at: string };

/** One event a device sent, as kept — with what it became. */
export interface StoredFloorEvent {
  readonly deviceId: string;
  readonly branchId: string;
  readonly kind: FloorDeviceRegistration['binding']['kind'];
  readonly eventId: string;
  readonly receivedAt: string;
  readonly relayedBy: string;
  /** The event as read (absent when it could not be read at all). */
  readonly event?: FloorEvent;
  readonly outcome:
    | { readonly state: 'recorded'; readonly detail: string; readonly rfid?: RfidCountObservation & { readonly locationId: string; readonly productId: string }; readonly facilities?: { readonly assetId: string; readonly state: string } }
    | { readonly state: 'refused'; readonly code: string; readonly detail: string };
}

/** A whole batch refused before any event in it was read — kept so a device that cannot get through is visible. */
export interface RefusedFloorBatch {
  readonly batchRef: string;
  readonly deviceId: string;
  readonly branchId: string | null;
  readonly code: string;
  readonly detail: string;
  readonly events: number;
  readonly at: string;
  readonly relayedBy: string;
}

/** A price push to the labels of one product at one branch, and what each label's vendor adapter said. */
export interface EslPush {
  readonly pushId: string;
  readonly branchId: string;
  readonly productId: string;
  readonly priceMinor: number;
  readonly because: 'price_change' | 'retry';
  readonly sourceRef: string;
  readonly by: string;
  readonly at: string;
  readonly commands: readonly { readonly deviceId: string; readonly accepted: boolean; readonly detail: string }[];
  readonly adapter: string;
  readonly retryOf?: string;
}

/**
 * The ESL vendor port. Every implementation in this build is a STAND-IN that records the command and answers; a real
 * vendor plugs in here once one is contracted and certified (EXTERNAL). It never changes the till price.
 */
export interface EslVendorPort {
  readonly name: string;
  push(command: { readonly pushId: string; readonly deviceId: string; readonly vendor: string; readonly productId: string; readonly shelfAddress: string; readonly priceMinor: number }): Promise<{ readonly accepted: boolean; readonly detail: string }>;
}

export interface FloorDeviceDeps {
  readonly now: () => string;
  /** R16-A (M01-FR-02): the shop's calendar — a camera event belongs to the SHOP's day it happened on, never its UTC date. */
  readonly calendar?: ShopCalendarOf;
  readonly log: (tenantId: string) => Promise<readonly FloorDeviceLogEntry[]>;
  readonly recordLog: (tenantId: string, entry: FloorDeviceLogEntry) => Promise<void>;
  readonly events: (tenantId: string) => Promise<readonly StoredFloorEvent[]>;
  /** Keep a batch's events in ONE write (each idempotent by device and event id). */
  readonly recordEvents: (tenantId: string, events: readonly StoredFloorEvent[]) => Promise<void>;
  readonly refusedBatches: (tenantId: string) => Promise<readonly RefusedFloorBatch[]>;
  readonly recordRefusedBatch: (tenantId: string, refusal: RefusedFloorBatch) => Promise<void>;
  readonly pushes: (tenantId: string) => Promise<readonly EslPush[]>;
  readonly recordPush: (tenantId: string, push: EslPush) => Promise<void>;
  /** The branches head office knows, with their state. */
  readonly branches: (tenantId: string) => Promise<readonly { readonly branchId: string; readonly status: string }[]>;
  /** OB-316: is this rollout switch on for the branch (branch-wide setting; a switch nobody set is off)? */
  readonly switchOn: (tenantId: string, key: string, branchId: string) => Promise<{ readonly on: boolean; readonly detail: string }>;
  /** Is the caller the floor-device gateway's own machine identity (and nothing else)? */
  readonly isGateway: (tenantId: string, userId: string) => Promise<boolean>;
  /** Is this an Ed25519 public key (SPKI PEM)? */
  readonly keyIsEd25519: (publicKeyPem: string) => boolean;
  /** Does the signature (base64) verify over the message with the key? */
  readonly verify: (publicKeyPem: string, message: string, signatureBase64: string) => boolean;
  /** Record a price a label was seen showing (the price-integrity observation route). */
  readonly recordPriceObservation: (ctx: RequestContext, observation: { readonly observationId: string; readonly branchId: string; readonly productId: string; readonly priceMinor: number; readonly observedAt: string; readonly shelfAddress: string; readonly deviceId: string }) => Promise<void>;
  /** Record a sensor reading through the facilities route; 404 when the equipment is not registered. */
  readonly recordSensorReading: (ctx: RequestContext, reading: { readonly assetId: string; readonly readingId: string; readonly tenthsC: number; readonly at: string; readonly recordedBy: string }) => Promise<{ readonly state: string }>;
  /** Book stock of a product at a location in whole units, or why it cannot be compared. */
  readonly bookUnits: (tenantId: string, locationId: string, productId: string) => Promise<BookUnits>;
  /** Till exceptions at the branch's lanes between two instants (loss-prevention record). */
  readonly laneExceptions: (tenantId: string, branchId: string, from: string, to: string) => Promise<readonly LaneException[]>;
  readonly eslVendor: EslVendorPort;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES: readonly FloorDeviceStatus[] = ['active', 'blocked', 'retired'];

/** The fleet: each registration with its latest status, in id order. */
export function floorDevices(log: readonly FloorDeviceLogEntry[]): readonly FloorDeviceRecord[] {
  const byId = new Map<string, FloorDeviceRecord>();
  for (const e of log) {
    if (e.entry === 'registered') {
      if (!byId.has(e.registration.deviceId)) byId.set(e.registration.deviceId, { ...e.registration, status: 'active', registeredBy: e.by, registeredAt: e.at });
    } else {
      const d = byId.get(e.deviceId);
      if (d !== undefined && d.status !== 'retired') byId.set(e.deviceId, { ...d, status: e.status, statusReason: e.reason });
    }
  }
  return [...byId.values()].sort((a, b) => a.deviceId.localeCompare(b.deviceId));
}

const branchQuery = (ctx: RequestContext): string => {
  const branchId = (ctx.query['branchId'] ?? '').trim();
  if (branchId === '') throw apiError(400, { code: 'branch_not_given', whatHappened: 'Say which branch (?branchId=).', wasItSaved: 'not_saved', nextSafeAction: 'Send the branch. Nothing was changed; this only reads.' });
  assertBranchInScope(ctx, branchId);
  return branchId;
};

/**
 * The labels whose LATEST echo since the push shows the pushed price, and each label's latest battery. A label that
 * echoed the price and later shows another one is no longer confirmed — the shelf is what it shows now.
 */
function confirmations(push: EslPush, events: readonly StoredFloorEvent[]): { readonly confirmedBy: readonly string[]; readonly battery: ReadonlyMap<string, number> } {
  const latest = new Map<string, { at: number; priceMinor: number }>();
  const battery = new Map<string, { at: number; percent: number }>();
  const since = Date.parse(push.at);
  for (const e of events) {
    if (e.kind !== 'esl_label' || e.branchId !== push.branchId || e.outcome.state !== 'recorded' || e.event?.type !== 'esl.echo') continue;
    if (e.event.productId !== push.productId) continue;
    const at = Date.parse(e.event.at);
    if (e.event.batteryPercent !== undefined && at >= (battery.get(e.deviceId)?.at ?? -Infinity)) battery.set(e.deviceId, { at, percent: e.event.batteryPercent });
    if (at >= since && at >= (latest.get(e.deviceId)?.at ?? -Infinity)) latest.set(e.deviceId, { at, priceMinor: e.event.displayedPriceMinor });
  }
  return {
    confirmedBy: [...latest.entries()].filter(([, v]) => v.priceMinor === push.priceMinor).map(([d]) => d),
    battery: new Map([...battery.entries()].map(([d, v]) => [d, v.percent] as const)),
  };
}

/** One push, judged now: which labels confirmed, and whether the shelf is known to match the till (`pushEslPrice`). */
export function judgePush(push: EslPush, events: readonly StoredFloorEvent[]): EslPushResult & { readonly push: EslPush } {
  const { confirmedBy, battery } = confirmations(push, events);
  const result = pushEslPrice({
    productId: push.productId, branchId: push.branchId, priceMinor: push.priceMinor,
    devices: push.commands.map((c) => ({ deviceId: c.deviceId, ...(battery.has(c.deviceId) ? { batteryPercent: battery.get(c.deviceId)! } : {}) })),
    confirmedBy,
  });
  return { ...result, push };
}

/**
 * Push a price to every active label of the product at each branch whose `esl` switch is on (R8-4). Called after the
 * price route has recorded the change — it never makes one. A branch with the switch off, or with no labels for the
 * product, is said and skipped. Idempotent per source and branch.
 */
export async function pushEslOnPriceChange(deps: FloorDeviceDeps, tenantId: string, input: { readonly productId: string; readonly priceMinor: number; readonly branchIds: readonly string[]; readonly by: string; readonly sourceRef: string }): Promise<readonly { readonly branchId: string; readonly pushed: boolean; readonly detail: string; readonly pushId?: string }[]> {
  const fleet = floorDevices(await deps.log(tenantId));
  const known = new Map((await deps.pushes(tenantId)).map((p) => [p.pushId, p] as const));
  const out: { branchId: string; pushed: boolean; detail: string; pushId?: string }[] = [];
  for (const branchId of [...new Set(input.branchIds)].sort()) {
    const labels = fleet.filter((d) => d.branchId === branchId && d.status === 'active' && d.binding.kind === 'esl_label' && d.binding.productId === input.productId);
    if (labels.length === 0) { out.push({ branchId, pushed: false, detail: 'no electronic labels show this product here — the paper label is the shelf control (a relabel task covers it)' }); continue; }
    const sw = await deps.switchOn(tenantId, FLOOR_DEVICE_SWITCH.esl_label, branchId);
    if (!sw.on) { out.push({ branchId, pushed: false, detail: `electronic labels are switched off here (${sw.detail}) — nothing was sent to them` }); continue; }
    const pushId = `esl-${input.sourceRef}-${branchId}`.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 120);
    if (known.has(pushId)) { out.push({ branchId, pushed: true, pushId, detail: 'already pushed for this price change' }); continue; }
    const push = await send(deps, tenantId, { pushId, branchId, productId: input.productId, priceMinor: input.priceMinor, because: 'price_change', sourceRef: input.sourceRef, by: input.by, labels });
    out.push({ branchId, pushed: true, pushId, detail: `${push.commands.filter((c) => c.accepted).length} of ${push.commands.length} label(s) took the price; each must echo it back before the shelf is known to match` });
  }
  return out;
}

async function send(deps: FloorDeviceDeps, tenantId: string, input: { readonly pushId: string; readonly branchId: string; readonly productId: string; readonly priceMinor: number; readonly because: EslPush['because']; readonly sourceRef: string; readonly by: string; readonly labels: readonly FloorDeviceRecord[]; readonly retryOf?: string }): Promise<EslPush> {
  const commands: { deviceId: string; accepted: boolean; detail: string }[] = [];
  for (const d of input.labels) {
    if (d.binding.kind !== 'esl_label') continue;
    try {
      const r = await deps.eslVendor.push({ pushId: input.pushId, deviceId: d.deviceId, vendor: d.vendor, productId: input.productId, shelfAddress: d.binding.shelfAddress, priceMinor: input.priceMinor });
      commands.push({ deviceId: d.deviceId, accepted: r.accepted, detail: r.detail });
    } catch (e) {
      // A vendor that cannot be reached is a label that did not take the price — said, never assumed (P-08).
      commands.push({ deviceId: d.deviceId, accepted: false, detail: `the label vendor could not be reached: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  const push: EslPush = {
    pushId: input.pushId, branchId: input.branchId, productId: input.productId, priceMinor: input.priceMinor, because: input.because,
    sourceRef: input.sourceRef, by: input.by, at: deps.now(), commands, adapter: deps.eslVendor.name,
    ...(input.retryOf === undefined ? {} : { retryOf: input.retryOf }),
  };
  await deps.recordPush(tenantId, push);
  await deps.recordAudit?.(tenantId, {
    actorId: input.by, action: 'devices.esl.push', objectType: 'esl_push', objectId: push.pushId, at: push.at,
    origin: { tenantId, branchId: push.branchId }, before: null,
    after: { productId: push.productId, priceMinor: String(push.priceMinor), labels: String(commands.length), accepted: String(commands.filter((c) => c.accepted).length), adapter: push.adapter },
    correlationId: push.pushId,
  });
  return push;
}

export function floorDeviceRoutes(deps: FloorDeviceDeps): readonly Route[] {
  const deviceOf = async (tenantId: string, deviceId: string): Promise<FloorDeviceRecord | undefined> => floorDevices(await deps.log(tenantId)).find((d) => d.deviceId === deviceId);

  /** Refuse a whole batch: kept on the exceptions list first, then the caller told by name. */
  const refuseBatch = async (ctx: RequestContext, deviceId: string, branchId: string | null, status: number, code: string, detail: string, events: number, retryAfterSeconds?: number): Promise<never> => {
    await deps.recordRefusedBatch(ctx.tenantId, { batchRef: `${deviceId}:${ctx.idempotencyKey ?? deps.now()}`, deviceId, branchId, code, detail, events, at: deps.now(), relayedBy: ctx.userId });
    throw apiError(status, {
      code, whatHappened: detail, wasItSaved: 'not_saved',
      nextSafeAction: 'None of this batch\'s events were kept; the refusal is on the device exceptions list. Fix the cause and send the batch again.',
    }, retryAfterSeconds);
  };

  /** What one event becomes. Throws nothing: a refusal is an outcome, kept with the event. */
  const dispatch = async (ctx: RequestContext, device: FloorDeviceRecord, event: FloorEvent): Promise<StoredFloorEvent['outcome']> => {
    const b = device.binding;
    if (event.type === 'esl.echo' && b.kind === 'esl_label') {
      if (event.productId !== b.productId) return { state: 'refused', code: 'label_shows_another_product', detail: `this label is registered for ${b.productId} at ${b.shelfAddress}, but it says it shows ${event.productId} — re-register it if it was moved` };
      await deps.recordPriceObservation({ ...ctx, userId: `floor-device:${device.deviceId}` }, {
        observationId: `esl:${device.deviceId}:${event.eventId}`, branchId: device.branchId, productId: event.productId,
        priceMinor: event.displayedPriceMinor, observedAt: event.at, shelfAddress: b.shelfAddress, deviceId: device.deviceId,
      });
      return { state: 'recorded', detail: `the label at ${b.shelfAddress} shows ${event.displayedPriceMinor} — recorded as a price observation (D-7)` };
    }
    if (event.type === 'rfid.read' && b.kind === 'rfid_reader') {
      const obs = rfidCountObservation(event.countedUnits, await deps.bookUnits(ctx.tenantId, b.locationId, event.productId));
      return { state: 'recorded', detail: obs.detail, rfid: { ...obs, locationId: b.locationId, productId: event.productId } };
    }
    if (event.type === 'iot.reading' && b.kind === 'iot_sensor') {
      try {
        const r = await deps.recordSensorReading({ ...ctx, userId: `floor-device:${device.deviceId}` }, {
          assetId: b.assetId, readingId: `iot-${device.deviceId}-${event.eventId}`.replace(/[^A-Za-z0-9._:-]/g, '_'), tenthsC: event.tenthsC, at: event.at, recordedBy: `floor-device:${device.deviceId}`,
        });
        return { state: 'recorded', detail: `${(event.tenthsC / 10).toFixed(1)}°C recorded on ${b.assetId} as a sensor reading — the room is ${r.state}`, facilities: { assetId: b.assetId, state: r.state } };
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return { state: 'refused', code: 'equipment_not_known', detail: `head office has no monitored equipment ${b.assetId} — register its range on the facilities page, then the sensor's readings are kept` };
        throw e;
      }
    }
    if (event.type === 'cctv.event' && b.kind === 'cctv_source') {
      return { state: 'recorded', detail: `camera ${b.cameraId}: ${event.eventKind} from ${event.from} to ${event.to} — metadata only, no footage` };
    }
    return { state: 'refused', code: 'wrong_event_type_for_device', detail: `a ${b.kind.replace(/_/g, ' ')} does not send ${event.type}` };
  };

  return [
    {
      api: 'API-11', method: 'POST', path: '/v1/devices/floor/:deviceId',
      permission: 'platform.device.manage', idempotent: true,
      handler: async (ctx) => {
        const read = readFloorDeviceRegistration(ctx.params['deviceId'] ?? '', ctx.body);
        if (!read.ok) throw apiError(400, { code: read.code, whatHappened: read.detail, wasItSaved: 'not_saved', nextSafeAction: 'Correct the device\'s details and send again. Nothing was registered.' });
        const reg = read.value;
        assertBranchInScope(ctx, reg.branchId);
        if (!deps.keyIsEd25519(reg.publicKey)) {
          throw apiError(400, { code: 'device_key_not_ed25519', whatHappened: 'The device\'s public key is not an Ed25519 key — the only kind this port checks signatures with.', wasItSaved: 'not_saved', nextSafeAction: 'Send the device\'s Ed25519 public key (the vendor\'s setup tool shows it). Nothing was registered.' });
        }
        const branch = (await deps.branches(ctx.tenantId)).find((x) => x.branchId === reg.branchId);
        if (branch === undefined || branch.status === 'closed') {
          throw apiError(404, { code: 'unknown_branch', whatHappened: `Head office has no ${branch === undefined ? '' : 'open '}branch "${reg.branchId}".`, wasItSaved: 'not_saved', nextSafeAction: 'Choose a branch from the organisation register. Nothing was registered.' });
        }
        const before = await deviceOf(ctx.tenantId, reg.deviceId);
        if (before !== undefined) {
          throw apiError(409, { code: 'device_already_registered', whatHappened: `Device ${reg.deviceId} is already registered (${before.binding.kind.replace(/_/g, ' ')} at ${before.branchId}, ${before.status}). One record per device — never a second.`, wasItSaved: 'not_saved', nextSafeAction: 'A device that moved or got a new key is retired and registered again under a new id. Nothing was changed.' });
        }
        const at = deps.now();
        await deps.recordLog(ctx.tenantId, { entry: 'registered', registration: reg, by: ctx.userId, at });
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'devices.floor.register', objectType: 'floor_device', objectId: reg.deviceId, at,
          origin: { tenantId: ctx.tenantId, branchId: reg.branchId }, before: null,
          after: { kind: reg.binding.kind, branchId: reg.branchId, vendor: reg.vendor, label: reg.label }, correlationId: reg.deviceId,
        });
        const sw = await deps.switchOn(ctx.tenantId, FLOOR_DEVICE_SWITCH[reg.binding.kind], reg.branchId);
        return {
          status: 201,
          body: {
            device: { ...reg, status: 'active', registeredBy: ctx.userId, registeredAt: at }, switchKey: FLOOR_DEVICE_SWITCH[reg.binding.kind], switchOn: sw.on,
            switchDetail: sw.on ? sw.detail : `${sw.detail} — its events are refused until the owner's rollout switch is on for this branch (OB-316)`,
            hardware: HARDWARE_NOT_VERIFIED,
          },
        };
      },
    },
    {
      api: 'API-11', method: 'POST', path: '/v1/devices/floor/:deviceId/status',
      permission: 'platform.device.manage', idempotent: true,
      handler: async (ctx) => {
        const deviceId = (ctx.params['deviceId'] ?? '').trim();
        const b = isObj(ctx.body) ? ctx.body : {};
        if (!STATUSES.includes(b['status'] as FloorDeviceStatus) || !isStr(b['reason'])) {
          throw apiError(400, { code: 'not_readable_as_a_device_status', whatHappened: 'A status change is { status: active | blocked | retired, reason }.', wasItSaved: 'not_saved', nextSafeAction: 'Send the status and the reason. Nothing was changed.' });
        }
        const device = await deviceOf(ctx.tenantId, deviceId);
        if (device === undefined) throw notFound(`floor device ${deviceId}`);
        assertBranchInScope(ctx, device.branchId);
        if (device.status === 'retired') throw apiError(409, { code: 'device_retired', whatHappened: `Device ${deviceId} is retired — that is final, and its history is kept.`, wasItSaved: 'not_saved', nextSafeAction: 'Register the device again under a new id. Nothing was changed.' });
        const at = deps.now();
        const status = b['status'] as FloorDeviceStatus;
        await deps.recordLog(ctx.tenantId, { entry: 'status', deviceId, status, reason: (b['reason'] as string).trim().slice(0, 300), by: ctx.userId, at });
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'devices.floor.status', objectType: 'floor_device', objectId: deviceId, at,
          origin: { tenantId: ctx.tenantId, branchId: device.branchId }, before: { status: device.status }, after: { status },
          reason: (b['reason'] as string).trim().slice(0, 300), correlationId: `${deviceId}:${at}`,
        });
        return { status: 200, body: { deviceId, status, before: device.status } };
      },
    },
    {
      api: 'API-11', method: 'GET', path: '/v1/devices/floor',
      permission: 'platform.health.read',
      handler: async (ctx) => {
        const branchId = branchQuery(ctx);
        const [fleet, events] = await Promise.all([deps.log(ctx.tenantId).then(floorDevices), deps.events(ctx.tenantId)]);
        const here = fleet.filter((d) => d.branchId === branchId);
        const switches = new Map<string, { on: boolean; detail: string }>();
        for (const key of new Set(here.map((d) => FLOOR_DEVICE_SWITCH[d.binding.kind]))) switches.set(key, await deps.switchOn(ctx.tenantId, key, branchId));
        const devices = here.map((d) => {
          const mine = events.filter((e) => e.deviceId === d.deviceId);
          const kept = mine.filter((e) => e.outcome.state === 'recorded');
          const sw = switches.get(FLOOR_DEVICE_SWITCH[d.binding.kind])!;
          return {
            deviceId: d.deviceId, kind: d.binding.kind, label: d.label, vendor: d.vendor, binding: d.binding, status: d.status,
            switchKey: FLOOR_DEVICE_SWITCH[d.binding.kind], switchOn: sw.on, switchDetail: sw.detail,
            lastHeardAt: mine.map((e) => e.receivedAt).sort().at(-1) ?? null,
            heard: mine.length === 0 ? 'never heard from — check it is fitted and its gateway is running' : `${kept.length} event(s) kept, ${mine.length - kept.length} refused`,
            hardware: HARDWARE_NOT_VERIFIED,
          };
        });
        return { status: 200, body: { branchId, devices, count: devices.length, hardware: HARDWARE_NOT_VERIFIED, asAt: deps.now() } };
      },
    },
    {
      api: 'API-11', method: 'GET', path: '/v1/devices/floor/exceptions',
      permission: 'platform.health.read',
      handler: async (ctx) => {
        const branchId = branchQuery(ctx);
        const fleet = floorDevices(await deps.log(ctx.tenantId));
        const ids = new Set(fleet.filter((d) => d.branchId === branchId).map((d) => d.deviceId));
        const batches = (await deps.refusedBatches(ctx.tenantId)).filter((r) => r.branchId === branchId || (r.branchId === null && ids.has(r.deviceId)));
        const events = (await deps.events(ctx.tenantId)).filter((e) => e.branchId === branchId && e.outcome.state === 'refused')
          .map((e) => ({ deviceId: e.deviceId, eventId: e.eventId, receivedAt: e.receivedAt, ...(e.outcome.state === 'refused' ? { code: e.outcome.code, detail: e.outcome.detail } : {}) }));
        return { status: 200, body: { branchId, refusedBatches: batches, refusedEvents: events, count: batches.length + events.length, asAt: deps.now() } };
      },
    },
    {
      api: 'API-11', method: 'POST', path: '/v1/devices/floor/:deviceId/events',
      permission: 'device.event.ingest', idempotent: true,
      handler: async (ctx): Promise<HandlerResult> => {
        const deviceId = (ctx.params['deviceId'] ?? '').trim();
        // Only the gateway's own machine identity carries device events — never a person's session (hard rule #4).
        if (!(await deps.isGateway(ctx.tenantId, ctx.userId))) {
          throw apiError(403, { code: 'not_the_device_gateway', whatHappened: 'Device events are carried only by the store\'s floor-device gateway, a machine identity — never a person\'s sign-in.', wasItSaved: 'not_saved', nextSafeAction: 'Nothing was kept. The gateway sends these; people read them on the device pages.' });
        }
        const b = isObj(ctx.body) ? ctx.body : {};
        const events = b['events'];
        if (!Array.isArray(events) || events.length === 0 || !isStr(b['signature'])) {
          throw apiError(400, { code: 'not_readable_as_a_device_batch', whatHappened: 'A device batch is { events: [ … ], signature } — the device\'s own signature over the events.', wasItSaved: 'not_saved', nextSafeAction: 'Send the batch as the device signed it. Nothing was kept.' });
        }
        const device = await deviceOf(ctx.tenantId, deviceId);
        if (device === undefined) return refuseBatch(ctx, deviceId, null, 404, 'device_not_registered', `Device ${deviceId} is not registered — an unknown device is never believed.`, events.length);
        assertBranchInScope(ctx, device.branchId);
        if (device.status !== 'active') return refuseBatch(ctx, deviceId, device.branchId, 403, `device_${device.status}`, `Device ${deviceId} is ${device.status}${device.statusReason === undefined ? '' : ` (${device.statusReason})`} — its events are not kept.`, events.length);
        if (!deps.verify(device.publicKey, deviceBatchMessage(deviceId, events), b['signature'] as string)) {
          return refuseBatch(ctx, deviceId, device.branchId, 403, 'device_signature_not_verified', `The batch does not verify against device ${deviceId}'s registered key — it did not come from that device as sent, so none of it is believed.`, events.length);
        }
        const key = FLOOR_DEVICE_SWITCH[device.binding.kind];
        const sw = await deps.switchOn(ctx.tenantId, key, device.branchId);
        if (!sw.on) return refuseBatch(ctx, deviceId, device.branchId, 409, 'feature_switched_off', `${device.binding.kind.replace(/_/g, ' ')}s are switched off at ${device.branchId} (rollout switch "${key}": ${sw.detail}). The owner switches it on per branch (OB-316).`, events.length);
        const all = await deps.events(ctx.tenantId);
        const mine = all.filter((e) => e.deviceId === deviceId);
        const now = deps.now();
        const admit = admitBatch({ recent: mine.map((e) => e.receivedAt), incoming: events.length, now });
        if (!admit.admitted) return refuseBatch(ctx, deviceId, device.branchId, admit.code === 'batch_too_large' ? 413 : 429, admit.code, admit.detail, events.length, admit.retryAfterSeconds > 0 ? admit.retryAfterSeconds : undefined);

        const seen = new Set(mine.map((e) => e.eventId));
        const kept: StoredFloorEvent[] = [];
        const duplicates: string[] = [];
        for (const raw of events) {
          const read = readFloorEvent(device.binding.kind, raw, now);
          const rawId = isObj(raw) && isStr(raw['eventId']) ? (raw['eventId'] as string).trim().slice(0, 80) : `unreadable-${kept.length + duplicates.length + 1}`;
          const eventId = read.ok ? read.value.eventId : rawId;
          if (seen.has(eventId)) { duplicates.push(eventId); continue; }
          seen.add(eventId);
          const base = { deviceId, branchId: device.branchId, kind: device.binding.kind, eventId, receivedAt: now, relayedBy: ctx.userId };
          if (!read.ok) { kept.push({ ...base, outcome: { state: 'refused', code: read.code, detail: read.detail } }); continue; }
          kept.push({ ...base, event: read.value, outcome: await dispatch(ctx, device, read.value) });
        }
        if (kept.length > 0) await deps.recordEvents(ctx.tenantId, kept);
        const refused = kept.filter((e) => e.outcome.state === 'refused').map((e) => ({ eventId: e.eventId, code: e.outcome.state === 'refused' ? e.outcome.code : '', detail: e.outcome.detail }));
        return {
          status: 200,
          body: {
            deviceId, kind: device.binding.kind, accepted: kept.length - refused.length, refused, duplicates,
            outcomes: kept.map((e) => ({ eventId: e.eventId, state: e.outcome.state, detail: e.outcome.detail })), hardware: HARDWARE_NOT_VERIFIED,
          },
        };
      },
    },
    {
      api: 'API-11', method: 'GET', path: '/v1/devices/esl/pushes',
      permission: 'price.integrity.audit',
      handler: async (ctx) => {
        const branchId = branchQuery(ctx);
        const [pushes, events] = await Promise.all([deps.pushes(ctx.tenantId), deps.events(ctx.tenantId)]);
        const judged = pushes.filter((p) => p.branchId === branchId).sort((a, b) => b.at.localeCompare(a.at)).map((p) => judgePush(p, events));
        return {
          status: 200,
          body: {
            branchId, pushes: judged, notConfirmed: judged.filter((j) => !j.safeToChangeAtTill).length,
            rule: 'A shelf is known to match the till only once every label has echoed the new price back; until then the price-integrity check treats it as unconfirmed.',
            hardware: HARDWARE_NOT_VERIFIED, asAt: deps.now(),
          },
        };
      },
    },
    {
      api: 'API-11', method: 'POST', path: '/v1/devices/esl/pushes/:pushId/retry',
      permission: 'price.integrity.audit', idempotent: true,
      handler: async (ctx) => {
        const pushId = (ctx.params['pushId'] ?? '').trim();
        const [pushes, events, log] = await Promise.all([deps.pushes(ctx.tenantId), deps.events(ctx.tenantId), deps.log(ctx.tenantId)]);
        const push = pushes.find((p) => p.pushId === pushId);
        if (push === undefined) throw notFound(`ESL push ${pushId}`);
        assertBranchInScope(ctx, push.branchId);
        const judged = judgePush(push, events);
        if (judged.unconfirmed.length === 0) return { status: 200, body: { pushId, retried: false, detail: 'every label already confirmed this price — nothing to send', result: judged } };
        const sw = await deps.switchOn(ctx.tenantId, FLOOR_DEVICE_SWITCH.esl_label, push.branchId);
        if (!sw.on) throw apiError(409, { code: 'feature_switched_off', whatHappened: `Electronic labels are switched off at ${push.branchId} (${sw.detail}).`, wasItSaved: 'not_saved', nextSafeAction: 'Nothing was sent. The paper label and its relabel task are the shelf control.' });
        const labels = floorDevices(log).filter((d) => judged.unconfirmed.includes(d.deviceId) && d.status === 'active');
        const retryId = `${pushId}-r${pushes.filter((p) => p.retryOf === pushId).length + 1}`;
        const again = await send(deps, ctx.tenantId, { pushId: retryId, branchId: push.branchId, productId: push.productId, priceMinor: push.priceMinor, because: 'retry', sourceRef: push.sourceRef, by: ctx.userId, labels, retryOf: pushId });
        return { status: 201, body: { pushId: retryId, retryOf: pushId, retried: true, sentTo: again.commands.map((c) => c.deviceId), priceMinor: push.priceMinor, detail: 'the same price was sent again to the labels that had not confirmed — never a new price', hardware: HARDWARE_NOT_VERIFIED } };
      },
    },
    {
      api: 'API-11', method: 'GET', path: '/v1/devices/rfid/variances',
      permission: 'inventory.availability.read',
      handler: async (ctx) => {
        const branchId = branchQuery(ctx);
        // The LATEST count per location and product decides whether a variance is still open.
        const latest = new Map<string, StoredFloorEvent>();
        for (const e of await deps.events(ctx.tenantId)) {
          if (e.branchId !== branchId || e.outcome.state !== 'recorded' || e.outcome.rfid === undefined) continue;
          const k = `${e.outcome.rfid.locationId}\u0000${e.outcome.rfid.productId}`;
          const cur = latest.get(k);
          if (cur === undefined || (cur.event?.at ?? '') <= (e.event?.at ?? '')) latest.set(k, e);
        }
        const rows = [...latest.values()].map((e) => ({ deviceId: e.deviceId, eventId: e.eventId, countedAt: e.event?.at ?? e.receivedAt, ...(e.outcome.state === 'recorded' ? e.outcome.rfid! : {}) }))
          .sort((a, b) => String(a.locationId).localeCompare(String(b.locationId)) || String(a.productId).localeCompare(String(b.productId)));
        const variances = rows.filter((r) => r.state === 'variance');
        return {
          status: 200,
          body: {
            branchId, variances, notComparable: rows.filter((r) => r.state === 'not_comparable'), agreeing: rows.filter((r) => r.state === 'agrees').length,
            rule: 'An RFID count is an observation: a difference is for a person to count and correct through the ordinary count — the stock is never changed by a reader.',
            hardware: HARDWARE_NOT_VERIFIED, asAt: deps.now(),
          },
        };
      },
    },
    {
      api: 'API-11', method: 'GET', path: '/v1/devices/cctv/links',
      permission: 'lp.case.read',
      handler: async (ctx) => {
        const branchId = branchQuery(ctx);
        const day = (ctx.query['day'] ?? '').trim();
        if (!DAY.test(day)) throw apiError(400, { code: 'day_not_given', whatHappened: 'Say which day (?day=YYYY-MM-DD).', wasItSaved: 'not_saved', nextSafeAction: 'Send the day. Nothing was changed; this only reads.' });
        const fleet = new Map(floorDevices(await deps.log(ctx.tenantId)).map((d) => [d.deviceId, d] as const));
        const zone = (await shopClock(deps.calendar).calendar(ctx.tenantId)).timeZone;
        const cameraEvents: CameraEventFact[] = [];
        for (const e of await deps.events(ctx.tenantId)) {
          const d = fleet.get(e.deviceId);
          if (e.branchId !== branchId || e.outcome.state !== 'recorded' || e.event?.type !== 'cctv.event' || d?.binding.kind !== 'cctv_source') continue;
          // R16-A: the SHOP's days the event spans (an event from 19:30 UTC is on the shop's next day), never the UTC dates.
          if (shopDateIn(e.event.from, zone) > day || shopDateIn(e.event.to, zone) < day) continue;
          cameraEvents.push({ eventId: e.eventId, deviceId: e.deviceId, cameraId: d.binding.cameraId, laneIds: d.binding.laneIds, from: e.event.from, to: e.event.to, eventKind: e.event.eventKind });
        }
        const from = cameraEvents.map((e) => e.from).sort()[0];
        const to = cameraEvents.map((e) => e.to).sort().at(-1);
        const exceptions = from === undefined || to === undefined ? [] : await deps.laneExceptions(ctx.tenantId, branchId, from, to);
        const links = linkCameraEvents(cameraEvents, exceptions);
        return {
          status: 200,
          body: {
            branchId, day, links, withExceptions: links.filter((l) => l.exceptions.length > 0).length,
            rule: 'A link is a place to look, never an accusation: open a case from it and add the clip as a CCTV reference (camera, from, to). No footage is kept here.',
            openVia: 'POST /v1/loss-prevention/cases/:caseId, then POST /v1/loss-prevention/cases/:caseId/cctv/:evidenceId with the link\'s cctvReference',
            hardware: HARDWARE_NOT_VERIFIED, asAt: deps.now(),
          },
        };
      },
    },
  ];
}
