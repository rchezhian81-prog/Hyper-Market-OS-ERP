// Floor devices — electronic shelf labels, RFID readers, IoT sensors and CCTV event sources (R8-4 · R8-5 · R8-6 · R8-7 ·
// D14-FR-05 "ESL, RFID, CCTV-event and IoT readiness" · §8.2 "event/API adapters, feature flags, privacy and security
// review" · OB-316 · P-04 · P-08 · hard rules #2, #5, #6 and #10).
//
// The hardware and its vendors are OUTSIDE parties (EXTERNAL): nothing here talks to a real label, reader, sensor or
// camera. What is built is the vendor-neutral PORT every one of them will plug into, and the rules that have to be right
// whatever the vendor:
//
//   • A DEVICE IS REGISTERED BEFORE IT IS BELIEVED. Each one is named at one branch, bound to the one thing it watches (a
//     label to its product and shelf place, a reader to its stock location, a sensor to its equipment, a camera to the
//     lanes it looks at), and carries its own public key. An event batch is believed only when that device's signature
//     verifies over exactly these bytes (`deviceBatchMessage`) — the gateway that carries it vouches for nothing.
//   • EVERY KIND SITS BEHIND ITS OWN ROLLOUT SWITCH, OFF BY DEFAULT (OB-316): `esl`, `rfid`, `iot`, `cctv`. A switch
//     nobody set is off, so a device fitted before the owner says go is heard and refused by name, never acted on.
//   • ONLY THE FIELDS A KIND IS ALLOWED ARE KEPT. Each event is read against a strict list; anything else — above all a
//     video, an image, a face or a number plate from a camera — refuses that event by name (privacy by design, OB-217:
//     CCTV is metadata and a reference, never footage).
//   • A READING IS AN OBSERVATION, NEVER A LEDGER EDIT (hard rule #2). An RFID count is compared with the book stock and a
//     difference is a VARIANCE for a person; an ESL echo is a price the shelf was seen showing; a sensor reading feeds the
//     facilities monitor exactly as a hand-written reading does. Nothing here moves stock, money or a price (hard rule #5).
//   • NOTHING IS A FAKE ZERO (P-08). A count that cannot be compared (no book stock known, a weighed product) says why.
//
// Pure and deterministic: no clock, no I/O, no cryptography (the signature check lives with the service, node:crypto).

/** The kinds of floor device this port takes. */
export type FloorDeviceKind = 'esl_label' | 'rfid_reader' | 'iot_sensor' | 'cctv_source';
export const FLOOR_DEVICE_KINDS: readonly FloorDeviceKind[] = Object.freeze(['esl_label', 'rfid_reader', 'iot_sensor', 'cctv_source']);

/** OB-316: the rollout switch each kind sits behind — off until somebody switches it on for the branch, with a reason. */
export const FLOOR_DEVICE_SWITCH: Readonly<Record<FloorDeviceKind, string>> = Object.freeze({
  esl_label: 'esl', rfid_reader: 'rfid', iot_sensor: 'iot', cctv_source: 'cctv',
});

/** The one event type each kind may send. */
export const FLOOR_EVENT_TYPE: Readonly<Record<FloorDeviceKind, FloorEventType>> = Object.freeze({
  esl_label: 'esl.echo', rfid_reader: 'rfid.read', iot_sensor: 'iot.reading', cctv_source: 'cctv.event',
});
export type FloorEventType = 'esl.echo' | 'rfid.read' | 'iot.reading' | 'cctv.event';

/** Said on every device record and every reply: nothing here has been run against a real device yet. */
export const HARDWARE_NOT_VERIFIED = 'built with a stand-in, not verified on hardware';

/**
 * Engineering ceilings that stop one faulty device flooding head office — not business numbers the owner sets. A batch
 * larger than this is refused whole; a device sending more than the per-minute ceiling is told to slow down (429) and
 * nothing in that batch is kept, so it can send it again.
 */
export const FLOOR_EVENTS_PER_BATCH = 200;
export const FLOOR_EVENTS_PER_MINUTE = 600;

/** What a device is bound to — the one thing it watches. */
export type FloorDeviceBinding =
  | { readonly kind: 'esl_label'; readonly productId: string; readonly shelfAddress: string }
  | { readonly kind: 'rfid_reader'; readonly locationId: string }
  | { readonly kind: 'iot_sensor'; readonly assetId: string }
  | { readonly kind: 'cctv_source'; readonly cameraId: string; readonly laneIds: readonly string[] };

export interface FloorDeviceRegistration {
  readonly deviceId: string;
  readonly branchId: string;
  readonly label: string;
  /** The vendor's name as the shop knows it — "stand-in" until a real one is contracted. */
  readonly vendor: string;
  /** The device's own Ed25519 public key (SPKI PEM). Never a secret: the private half never leaves the device. */
  readonly publicKey: string;
  readonly binding: FloorDeviceBinding;
}

export type FloorDeviceStatus = 'active' | 'blocked' | 'retired';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const isId = (v: unknown): v is string => typeof v === 'string' && ID.test(v.trim());
const isText = (v: unknown, max = 120): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= max;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isTime = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(v) && !Number.isNaN(Date.parse(v));
const isWhole = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const PEM = /^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\s*$/;

export type Read<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: string; readonly detail: string };
const no = (code: string, detail: string): { readonly ok: false; readonly code: string; readonly detail: string } => ({ ok: false, code, detail });

/** Read a registration body. The key's TYPE (Ed25519) is checked by the service, which has the cryptography. */
export function readFloorDeviceRegistration(deviceId: string, body: unknown): Read<FloorDeviceRegistration> {
  if (!isId(deviceId)) return no('not_a_device_id', 'A device id is 1–80 letters, digits, dots, dashes, colons or underscores.');
  if (!isObj(body)) return no('not_readable_as_a_floor_device', 'Send { kind, branchId, label, vendor, publicKey, and what it is bound to }.');
  const kind = body['kind'];
  if (typeof kind !== 'string' || !(FLOOR_DEVICE_KINDS as readonly string[]).includes(kind)) {
    return no('not_a_floor_device_kind', `A floor device is one of ${FLOOR_DEVICE_KINDS.join(', ')}.`);
  }
  if (!isId(body['branchId']) || !isText(body['label']) || !isText(body['vendor'], 80)) {
    return no('not_readable_as_a_floor_device', 'A floor device needs its branch, a label people know it by, and the vendor.');
  }
  if (typeof body['publicKey'] !== 'string' || !PEM.test(body['publicKey'])) {
    return no('device_key_not_given', 'A floor device carries its own public key (PEM, "BEGIN PUBLIC KEY"): its events are believed only when they verify against it.');
  }
  let binding: FloorDeviceBinding;
  if (kind === 'esl_label') {
    if (!isId(body['productId']) || !isText(body['shelfAddress'], 60)) return no('device_binding_not_given', 'An electronic shelf label is bound to the product it shows and its shelf place (productId, shelfAddress).');
    binding = { kind, productId: body['productId'].trim(), shelfAddress: body['shelfAddress'].trim() };
  } else if (kind === 'rfid_reader') {
    if (!isId(body['locationId'])) return no('device_binding_not_given', 'An RFID reader is bound to the stock location it reads (locationId).');
    binding = { kind, locationId: body['locationId'].trim() };
  } else if (kind === 'iot_sensor') {
    if (!isId(body['assetId'])) return no('device_binding_not_given', 'An IoT sensor is bound to the monitored equipment it sits in (assetId).');
    binding = { kind, assetId: body['assetId'].trim() };
  } else {
    const lanes = body['laneIds'];
    if (!isId(body['cameraId']) || !Array.isArray(lanes) || lanes.length === 0 || lanes.length > 20 || !lanes.every(isId)) {
      return no('device_binding_not_given', 'A CCTV event source names its camera (cameraId) and the till lanes it looks at (laneIds, 1–20).');
    }
    binding = { kind: 'cctv_source', cameraId: body['cameraId'].trim(), laneIds: [...new Set((lanes as string[]).map((l) => l.trim()))].sort() };
  }
  return {
    ok: true,
    value: {
      deviceId: deviceId.trim(), branchId: body['branchId'].trim(), label: body['label'].trim(), vendor: body['vendor'].trim(),
      publicKey: body['publicKey'], binding,
    },
  };
}

// ── what a device sends ─────────────────────────────────────────────────────────────────────────────────────────────

export type FloorEvent =
  | { readonly type: 'esl.echo'; readonly eventId: string; readonly at: string; readonly productId: string; readonly displayedPriceMinor: number; readonly batteryPercent?: number }
  | { readonly type: 'rfid.read'; readonly eventId: string; readonly at: string; readonly productId: string; readonly countedUnits: number }
  | { readonly type: 'iot.reading'; readonly eventId: string; readonly at: string; readonly tenthsC: number }
  | { readonly type: 'cctv.event'; readonly eventId: string; readonly at: string; readonly from: string; readonly to: string; readonly eventKind: string };

/** The only fields each type may carry. Anything else refuses the event by name — nothing unreviewed is kept. */
export const FLOOR_EVENT_FIELDS: Readonly<Record<FloorEventType, readonly string[]>> = Object.freeze({
  'esl.echo': ['eventId', 'type', 'at', 'productId', 'displayedPriceMinor', 'batteryPercent'],
  'rfid.read': ['eventId', 'type', 'at', 'productId', 'countedUnits'],
  'iot.reading': ['eventId', 'type', 'at', 'tenthsC'],
  'cctv.event': ['eventId', 'type', 'at', 'from', 'to', 'eventKind'],
});

/** Fields that mean a camera tried to send footage or identify a person — named in the refusal (OB-217, privacy). */
export const CCTV_FORBIDDEN_FIELDS: readonly string[] = Object.freeze([
  'video', 'clip', 'file', 'content', 'contentBase64', 'data', 'url', 'link', 'frames', 'frame', 'image', 'snapshot', 'thumbnail', 'stream',
  'face', 'faceId', 'faceTemplate', 'personId', 'personName', 'plate', 'numberPlate', 'biometric', 'trackId',
]);

/** How far ahead of head office's clock an event may claim to be (a device clock a little fast is not a fraud). */
export const FLOOR_EVENT_CLOCK_SKEW_MS = 5 * 60_000;

/** Read one event a device of `kind` sent, judged at `now`. Refusals are by name, per event; the rest of the batch stands. */
export function readFloorEvent(kind: FloorDeviceKind, raw: unknown, now: string): Read<FloorEvent> {
  if (!isObj(raw)) return no('not_readable_as_a_device_event', 'An event is an object with eventId, type and at.');
  const type = FLOOR_EVENT_TYPE[kind];
  if (raw['type'] !== type) return no('wrong_event_type_for_device', `A ${kind.replace(/_/g, ' ')} sends ${type} events only.`);
  if (type === 'cctv.event') {
    const footage = CCTV_FORBIDDEN_FIELDS.filter((f) => raw[f] !== undefined);
    if (footage.length > 0) {
      return no('footage_or_identity_not_kept', `A camera event is kept as metadata only — no footage and nothing that identifies a person — so ${footage.join(', ')} is refused (OB-217). The footage stays on the recorder.`);
    }
  }
  const extra = Object.keys(raw).filter((k) => !FLOOR_EVENT_FIELDS[type].includes(k));
  if (extra.length > 0) return no('field_not_allowed', `${type} carries only ${FLOOR_EVENT_FIELDS[type].join(', ')}; ${extra.join(', ')} is not kept.`);
  if (!isId(raw['eventId']) || !isTime(raw['at'])) return no('not_readable_as_a_device_event', 'An event needs its own id (eventId) and when it happened (at, a time with its zone).');
  if (Date.parse(raw['at']) > Date.parse(now) + FLOOR_EVENT_CLOCK_SKEW_MS) return no('event_in_the_future', 'The event is timed after head office\'s clock — the device\'s clock may be wrong.');
  const base = { eventId: raw['eventId'].trim(), at: new Date(Date.parse(raw['at'])).toISOString() };
  switch (type) {
    case 'esl.echo': {
      const battery = raw['batteryPercent'];
      if (!isId(raw['productId']) || !isWhole(raw['displayedPriceMinor']) || (battery !== undefined && !(isWhole(battery) && battery <= 100))) {
        return no('not_readable_as_an_esl_echo', 'An ESL echo says which product it shows, the price it now displays in whole paise, and may say its battery (0–100).');
      }
      return { ok: true, value: { type, ...base, productId: raw['productId'].trim(), displayedPriceMinor: raw['displayedPriceMinor'], ...(battery === undefined ? {} : { batteryPercent: battery as number }) } };
    }
    case 'rfid.read':
      if (!isId(raw['productId']) || !isWhole(raw['countedUnits'])) return no('not_readable_as_an_rfid_read', 'An RFID read says which product and how many units the reader counted (a whole number).');
      return { ok: true, value: { type, ...base, productId: raw['productId'].trim(), countedUnits: raw['countedUnits'] } };
    case 'iot.reading':
      if (typeof raw['tenthsC'] !== 'number' || !Number.isSafeInteger(raw['tenthsC']) || Math.abs(raw['tenthsC']) > 2_000) {
        return no('not_readable_as_a_sensor_reading', 'A sensor reading is a temperature in tenths of a degree (83 is 8.3°C), a whole number between −200.0 and 200.0°C.');
      }
      return { ok: true, value: { type, ...base, tenthsC: raw['tenthsC'] } };
    case 'cctv.event':
      if (!isTime(raw['from']) || !isTime(raw['to']) || typeof raw['eventKind'] !== 'string' || !/^[a-z][a-z_]{0,39}$/.test(raw['eventKind'])) {
        return no('not_readable_as_a_camera_event', 'A camera event says what kind it is (eventKind, lower-case words joined by _) and the time it covers (from, to).');
      }
      if (Date.parse(raw['from']) > Date.parse(raw['to'])) return no('camera_period_backwards', 'A camera event\'s "from" must be on or before its "to".');
      return { ok: true, value: { type, ...base, from: new Date(Date.parse(raw['from'])).toISOString(), to: new Date(Date.parse(raw['to'])).toISOString(), eventKind: raw['eventKind'] } };
  }
}

/** Stable JSON: object keys sorted at every level, so a device and head office sign and check the same bytes. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

/** The exact bytes a device signs for one batch: its id and the events as sent, canonical. */
export function deviceBatchMessage(deviceId: string, events: readonly unknown[]): string {
  return `sre-floor-device/1\n${deviceId}\n${canonicalJson(events)}`;
}

/** Is there room for `incoming` more events from this device this minute? `recent` are the arrival times already kept. */
export function admitBatch(input: { readonly recent: readonly string[]; readonly incoming: number; readonly now: string; readonly perMinute?: number; readonly perBatch?: number }):
  { readonly admitted: true } | { readonly admitted: false; readonly code: 'batch_too_large' | 'device_sending_too_fast'; readonly retryAfterSeconds: number; readonly detail: string } {
  const perBatch = input.perBatch ?? FLOOR_EVENTS_PER_BATCH;
  const perMinute = input.perMinute ?? FLOOR_EVENTS_PER_MINUTE;
  if (input.incoming > perBatch) return { admitted: false, code: 'batch_too_large', retryAfterSeconds: 0, detail: `At most ${perBatch} events in one batch — send them in smaller batches.` };
  const since = Date.parse(input.now) - 60_000;
  const lastMinute = input.recent.filter((t) => Date.parse(t) > since).length;
  if (lastMinute + input.incoming > perMinute) {
    return { admitted: false, code: 'device_sending_too_fast', retryAfterSeconds: 60, detail: `This device sent ${lastMinute} events in the last minute; the ceiling is ${perMinute}. Nothing in this batch was kept — send it again in a minute.` };
  }
  return { admitted: true };
}

// ── what an event means ─────────────────────────────────────────────────────────────────────────────────────────────

/** Book stock at a location, as the stock ledger says, in whole units — or why it cannot be compared. */
export type BookUnits = { readonly known: true; readonly units: number } | { readonly known: false; readonly why: string };

export interface RfidCountObservation {
  readonly state: 'agrees' | 'variance' | 'not_comparable';
  readonly countedUnits: number;
  readonly bookUnits: number | null;
  /** counted − book; null when not comparable. */
  readonly differenceUnits: number | null;
  readonly detail: string;
}

/**
 * An RFID count against the book (R8-5). The count is an OBSERVATION: it never changes the stock (hard rule #2). A
 * difference is a variance for a person to count and, if real, correct through the ordinary count route.
 */
export function rfidCountObservation(countedUnits: number, book: BookUnits): RfidCountObservation {
  if (!book.known) {
    return { state: 'not_comparable', countedUnits, bookUnits: null, differenceUnits: null, detail: `the reader counted ${countedUnits}; it cannot be compared with the book because ${book.why}` };
  }
  const differenceUnits = countedUnits - book.units;
  if (differenceUnits === 0) return { state: 'agrees', countedUnits, bookUnits: book.units, differenceUnits, detail: `the reader counted ${countedUnits}, the book says ${book.units} — they agree` };
  return {
    state: 'variance', countedUnits, bookUnits: book.units, differenceUnits,
    detail: `the reader counted ${countedUnits}, the book says ${book.units} (${differenceUnits > 0 ? '+' : ''}${differenceUnits}) — a variance for a person to count; the stock was NOT changed`,
  };
}

/** A till exception at a lane, as the loss-prevention record holds it. */
export interface LaneException {
  readonly ref: string;
  readonly laneId: string;
  readonly at: string;
  readonly kind: string;
  readonly cashierId: string;
  readonly valueMinor: number;
  readonly detail: string;
}

export interface CameraEventFact {
  readonly eventId: string;
  readonly deviceId: string;
  readonly cameraId: string;
  readonly laneIds: readonly string[];
  readonly from: string;
  readonly to: string;
  readonly eventKind: string;
}

export interface CameraLink {
  readonly eventId: string;
  readonly cameraId: string;
  readonly from: string;
  readonly to: string;
  readonly eventKind: string;
  /** The till exceptions at a lane this camera looks at, inside the period the event covers. */
  readonly exceptions: readonly LaneException[];
  /** The reference an investigator puts on a case (`POST /v1/loss-prevention/cases/:caseId/cctv/:evidenceId`). */
  readonly cctvReference: { readonly cameraId: string; readonly from: string; readonly to: string };
}

/**
 * Link camera events to till exceptions (R8-7): an exception at a lane the camera looks at, timed inside the period the
 * camera event covers. No window is invented — the camera says the period. Nothing is blamed on anyone: a link is a
 * place to look, and a person opens a case from it.
 */
export function linkCameraEvents(events: readonly CameraEventFact[], exceptions: readonly LaneException[]): readonly CameraLink[] {
  return [...events]
    .sort((a, b) => a.from.localeCompare(b.from) || a.eventId.localeCompare(b.eventId))
    .map((e) => {
      const from = Date.parse(e.from);
      const to = Date.parse(e.to);
      const hits = exceptions
        .filter((x) => e.laneIds.includes(x.laneId) && Date.parse(x.at) >= from && Date.parse(x.at) <= to)
        .sort((a, b) => a.at.localeCompare(b.at) || a.ref.localeCompare(b.ref));
      return { eventId: e.eventId, cameraId: e.cameraId, from: e.from, to: e.to, eventKind: e.eventKind, exceptions: hits, cctvReference: { cameraId: e.cameraId, from: e.from, to: e.to } };
    });
}
