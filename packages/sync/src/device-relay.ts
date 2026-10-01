// The ONE contract between a screen or handheld and the store computer for work done on the device
// (P-01, §31, hard rules #1/#6/#10 — SP-2a, audit finding F11).
//
// ── Why this exists ─────────────────────────────────────────────────────────
//
// The manager's screen, the picker's phone and the warehouse handheld each kept a `DeviceOutbox` that
// survived a restart — and nothing ever read it. The manager's did not even do that: its approvals,
// receipts and counts lived in a `new SyncOutbox()` and went with the tab (F11). Every surface had its
// own idea of "saved", none of them reached the box, and the box — the one machine in the shop with
// a disk it can `fsync` and a sync agent that reaches head office — never heard of any of it.
//
// This file is the shared vocabulary that ends that: what a device may hand to the box, how the box
// answers per item, what the box later says about each item's journey, and the five words a screen
// shows for where a piece of work is. It is a contract, so it holds NO transport and NO storage — the
// device side is `device-drain.ts`, the box side is the lane socket's `/lane/outbox` route.
//
// ── The five states a person sees (the owner's words) ───────────────────────
//
//   saved_here      — on this device only; the box has not been reached yet (attempts 0)
//   retrying        — on this device; the box was tried and did not take it (link down, or it could not write)
//   handed_to_box   — the box has it on its disk; it will carry it to head office
//   posted          — the box says head office accepted it
//   refused         — a person must look: the box or head office refused it, with the reason
//
// A refusal is never dropped and never retried blindly (hard rules #6 and #10). A link failure is never
// a refusal — a device offline for a day loses nothing.

import type { DomainEvent } from '../../contracts/src/event';
import type { OutboxItem } from './outbox';

/** The box's routes for device work. Named here so the device and the box cannot drift apart. */
export const DEVICE_OUTBOX_PATH = '/lane/outbox';
export const DEVICE_OUTBOX_STATUS_PATH = '/lane/outbox/status';

/**
 * Which event types a device may hand to the box, and from which surface. An allow-list, not a
 * pass-through: the box relays these to head office under the STORE's credential, so a type nobody
 * reviewed must not be able to ride that credential. Handheld types join in SP-3; receipts and counts
 * from the manager's screen join in SP-2b, each with its own re-verifying cloud route.
 */
export const RELAYABLE_DEVICE_EVENTS: Readonly<Record<string, { readonly surfaces: readonly string[] }>> = Object.freeze({
  ApprovalDecided: { surfaces: ['manager'] },
  // SP-7a (F02): a supplier invoice captured on the buyer's screen — the ERP surface the box serves, so it rides as
  // `manager` like every other screen record. Head office re-verifies the capturer and the approver from their grants.
  SupplierInvoiceCaptured: { surfaces: ['manager'] },
  // SP-2b: a delivery booked in and a blind count captured on the manager's screen. The warehouse handheld joins
  // `StockCounted` in W2 (SP-3), once the LAN device route exists.
  GoodsReceived: { surfaces: ['manager'] },
  // SP-3b (W2): the warehouse handheld's bin-level blind count rides the same type and route as the manager's count.
  StockCounted: { surfaces: ['manager', 'warehouse'] },
  // SP-3b (W3): an adjustment REQUEST from the handheld — recorded pending a supervisor's approval, never posted by the raiser.
  AdjustmentRequested: { surfaces: ['warehouse'] },
  // SP-3a: the warehouse handheld's work, over the box's authenticated DEVICE socket (ADR-0019). A receiving scan
  // is its own type (per scan, not a whole GRN like the manager's `GoodsReceived`) so each rides its own cloud route.
  WarehouseMovementApplied: { surfaces: ['warehouse'] },
  ReceivingScanned: { surfaces: ['warehouse'] },
  // SP-6b: the worker's "delivery complete" — ONE per GRN, behind its scans in the queue; head office assembles the goods
  // receipt from the scans it already holds and folds it into the purchase order. Nothing in it moves stock.
  ReceivingCompleted: { surfaces: ['warehouse'] },
  // SP-8b (F08): the floor's INDENT and its independent RECEIPT, captured on the served Indents screen (the ERP surface the
  // box serves, so they ride as `manager`). Head office re-verifies the requester / receiver from their grants and runs the
  // same indent engine the direct routes run; a refusal (unknown place, wrong item, issuer receiving) dead-letters visibly.
  FloorIndentRequested: { surfaces: ['manager'] },
  FloorIndentReceived: { surfaces: ['manager'] },
  // SP-8c: the back store's ISSUE against the indent, from the warehouse handheld (tap the line → scan bin → scan item → confirm).
  FloorIndentIssued: { surfaces: ['warehouse'] },
  // SP-8c-ii (F08): the shelf count taken on the merchandising screen (the ERP surface the box serves, so it rides as `manager`).
  // Head office re-verifies the COUNTER from their grants and judges the shelf against its own map; a count against a shelf
  // it does not have dead-letters visibly. The refill task's indent rides `FloorIndentRequested` above, from the same screen.
  ShelfCounted: { surfaces: ['manager'] },
});

/**
 * The surfaces a HANDHELD may claim on the device socket (SP-3a). A handheld never speaks as `manager`: the manager's
 * types (an approval decision, a whole receipt, a blind count) would otherwise ride a warehouse device's credential.
 */
export const HANDHELD_SOURCES = Object.freeze(['warehouse', 'picker', 'driver'] as const);
export type HandheldSource = (typeof HANDHELD_SOURCES)[number];
export function isHandheldSource(source: string): source is HandheldSource {
  return (HANDHELD_SOURCES as readonly string[]).includes(source);
}

export function isRelayable(type: string, source: string): boolean {
  const entry = RELAYABLE_DEVICE_EVENTS[type];
  return entry !== undefined && entry.surfaces.includes(source);
}

/** One queued item as the device sends it: its outbox key and the event, exactly as minted. */
export interface RelayItem {
  readonly key: string;
  readonly event: DomainEvent;
}

/** What a device posts: who it is (the surface) and the items, in enqueue order. */
export interface RelayBatch {
  readonly source: string;
  readonly items: readonly RelayItem[];
}

/**
 * The box's answer for ONE item.
 *   accepted  — durable on the box's disk and queued for head office
 *   duplicate — the box already holds this key (a retry after a lost reply lands here — one effect)
 *   refused   — not a record this box relays, or malformed: a person must look; the device dead-letters it
 *   not_saved — the box could not write it durably right now (disk full, etc.): the device keeps it and retries
 */
export type DeviceAckStatus = 'accepted' | 'duplicate' | 'refused' | 'not_saved';

export interface DeviceAck {
  readonly key: string;
  readonly status: DeviceAckStatus;
  readonly reason?: string;
}

export interface RelayReply {
  readonly acks: readonly DeviceAck[];
}

/** Where an item the box accepted has got to, as the box's own pipeline sees it. */
export type BoxItemState = 'pending' | 'posted' | 'refused' | 'unknown';

export interface BoxItemStatus {
  readonly key: string;
  readonly state: BoxItemState;
  readonly attempts: number;
  readonly reason?: string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

export type ReadRelayItem =
  | { readonly ok: true; readonly item: RelayItem }
  | { readonly ok: false; readonly key: string | null; readonly reason: string };

/**
 * Read one posted item strictly. The box relays what it accepts under the store's credential, so a
 * malformed item is REFUSED with its reason (the device dead-letters it for a person), never repaired
 * or guessed at. The key must be the event's own idempotency key: one identity, on the device, on the
 * box and at head office, so a retry anywhere collapses to one effect (§31.1).
 */
export function readRelayItem(v: unknown): ReadRelayItem {
  if (!isObj(v)) return { ok: false, key: null, reason: 'an item must be an object with a key and an event' };
  const key = isStr(v['key']) ? v['key'] : null;
  const e = v['event'];
  if (key === null) return { ok: false, key: null, reason: 'an item needs a non-empty key' };
  if (!isObj(e)) return { ok: false, key, reason: 'an item needs an event object' };
  for (const field of ['id', 'type', 'occurredAt', 'idempotencyKey', 'source'] as const) {
    if (!isStr(e[field])) return { ok: false, key, reason: `the event has no ${field}` };
  }
  if (typeof e['version'] !== 'number' || !Number.isInteger(e['version']) || (e['version'] as number) < 1) {
    return { ok: false, key, reason: 'the event has no version' };
  }
  if (e['idempotencyKey'] !== key) return { ok: false, key, reason: 'the key must be the event\'s own idempotency key' };
  if (!('payload' in e)) return { ok: false, key, reason: 'the event has no payload' };
  const event: DomainEvent = {
    id: e['id'] as string, type: e['type'] as string, occurredAt: e['occurredAt'] as string,
    idempotencyKey: key, source: e['source'] as string, version: e['version'] as number, payload: e['payload'],
  };
  return { ok: true, item: { key, event } };
}

export type ReadRelayBatch =
  | { readonly ok: true; readonly source: string; readonly items: readonly unknown[] }
  | { readonly ok: false; readonly reason: string };

/** Read the envelope: a named source and a list of items (each read separately by `readRelayItem`). */
export function readRelayBatch(v: unknown): ReadRelayBatch {
  if (!isObj(v)) return { ok: false, reason: 'a batch must be an object with a source and items' };
  if (!isStr(v['source'])) return { ok: false, reason: 'a batch needs a source (which screen or handheld sent it)' };
  if (!Array.isArray(v['items'])) return { ok: false, reason: 'a batch needs an items list' };
  return { ok: true, source: v['source'], items: v['items'] as unknown[] };
}

/** The device-side states, in the order a screen lists them. A guardrail binds the screens' words to this. */
export const DEVICE_ITEM_STATES = Object.freeze(['saved_here', 'retrying', 'handed_to_box', 'posted', 'refused'] as const);
export type DeviceItemState = (typeof DEVICE_ITEM_STATES)[number];

/**
 * Where one piece of work is, from the device's own outbox item and — once the box has answered a status
 * query — the box's word on it. The device's `acknowledged` means "the box has it", never "head office
 * has it": only the box's `posted` says that (P-08).
 */
export function deviceItemState(item: OutboxItem, box?: BoxItemStatus): DeviceItemState {
  if (item.state === 'dead_letter') return 'refused';
  if (item.state === 'pending') return item.attempts > 0 ? 'retrying' : 'saved_here';
  if (box?.state === 'posted') return 'posted';
  if (box?.state === 'refused') return 'refused';
  return 'handed_to_box';
}

/** The reason a person should read for an item, wherever it was refused. */
export function deviceItemReason(item: OutboxItem, box?: BoxItemStatus): string | undefined {
  if (item.state === 'dead_letter') return item.reason ?? undefined;
  if (box?.state === 'refused') return box.reason;
  return undefined;
}

/** The items a surface may hand to the box — the allow-list applied on the device side too. */
export function relayableItems<T extends OutboxItem>(items: readonly T[], source: string): T[] {
  return items.filter((i) => isRelayable(i.event.type, source));
}
