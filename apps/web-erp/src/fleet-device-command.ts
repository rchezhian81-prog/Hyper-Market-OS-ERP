// The device-fleet WRITE PATH from the screen (M33-FR-02/04, A-10, §31, P-01, P-04, P-05) — turning the
// fleet manager's "register / block / retire / bring-back this device" decision into a durable, deduplicated
// command the sync agent later delivers to the durable device registry
// (`POST /v1/platform/devices/:id/register` and `…/:id/status`). The screen already SHOWS the fleet
// (`createFleetSession.view`); this is the missing half — the action that actually changes it.
//
// Like every ERP governance action (the GST-returns approve/submit pattern), the button commits a
// deterministic command to the offline OUTBOX rather than calling the network inline: a click survives a
// reload and a lost connection (§31, hard rule #1 — a person's action never blocks on a network call), and
// the drain is idempotent. This is a GOVERNANCE command, not a fact-that-happened like a sale: blocking or
// retiring a device changes central privilege state, and the registry stamps who did it and gates on
// `platform.device.manage`. So the request carries the REQUESTING MANAGER's identity, and — exactly as the
// GST-returns approve/submit command is deliberately NOT relayed under the store's own token — its cloud
// delivery must carry that manager's authority, never the store service identity (decided in the sync-drain
// increment). No AI is involved (hard rule #5): a person asks; the deterministic registry commits.
//
// Dedupe identity is the change + device + the device's OBSERVED status: a double-click or reload collapses
// to one command (§31.1), while a genuine re-request after the device has moved to a new status is a
// distinct, legitimate command.

import { makeEvent, type DomainEvent } from '../../../packages/contracts/src/event';
import type { SyncOutbox, OutboxState } from '../../../packages/sync/src/outbox';

/** The event type the outbox command carries — the device-registry write-path identity. */
export const DEVICE_CHANGE_EVENT = 'DeviceRegistryChangeRequested';

/** The four changes this screen can request. `register` adds a device; the rest move an existing one. */
export type DeviceChangeKind = 'register' | 'block' | 'retire' | 'reinstate';
export const DEVICE_CHANGE_KINDS: readonly DeviceChangeKind[] = ['register', 'block', 'retire', 'reinstate'];

/** The device kinds the registry accepts (mirrors services/platform/src/device-registry.ts). */
export type DeviceKind = 'pos_lane' | 'handheld' | 'scale' | 'printer' | 'kiosk' | 'mobile';
export const DEVICE_KINDS: readonly DeviceKind[] = ['pos_lane', 'handheld', 'scale', 'printer', 'kiosk', 'mobile'];

/** The identity fields a REGISTER needs — the registry's `register` route body (label + kind + branch). */
export interface DeviceRegisterDetails {
  readonly branchId: string;
  readonly kind: DeviceKind;
  readonly label: string;
  readonly appVersion?: string;
}

/**
 * The command payload the sync agent delivers to the registry. Carries the requesting manager (checked at the
 * write boundary against `platform.device.manage`, and stamped as who did it), the device's observed status
 * (so a re-request after it moves is a distinct command), and — per change kind — either the register details
 * or the reason a status change is being made (the append-only history that explains why a lane stopped).
 */
export interface DeviceChangePayload {
  readonly deviceId: string;
  readonly change: DeviceChangeKind;
  /** Who asked — the authenticated manager, checked at the API boundary and recorded (P-04/P-05). */
  readonly requestedBy: string;
  /** The device's registry status when the request was made (`unregistered` when it is not yet in the fleet). */
  readonly observedStatus: string;
  /** Present for a `register` — the new device's identity. */
  readonly register?: DeviceRegisterDetails;
  /** Present for `block` / `retire` / `reinstate` — why (append-only history, never a silent change). */
  readonly reason?: string;
}
export type DeviceChangeCommand = DomainEvent<typeof DEVICE_CHANGE_EVENT, DeviceChangePayload>;

/** The registry status a change moves a device TO — or `null` for a register (a different route). */
export function statusForChange(change: DeviceChangeKind): 'blocked' | 'retired' | 'registered' | null {
  switch (change) {
    case 'register': return null;
    case 'block': return 'blocked';
    case 'retire': return 'retired';
    case 'reinstate': return 'registered';
  }
}

/**
 * Is this change allowed for a device in this observed status? A pure, total guard the session re-runs before
 * queuing (so a stale button can never queue something the registry would refuse) and the tests pin directly.
 *
 * - register:  only a device NOT already in the fleet (`unregistered`).
 * - block:     only a device currently trading (`registered`).
 * - retire:    a `registered` or `blocked` device (a retired one is terminal here).
 * - reinstate: a `blocked` or `retired` device (bring it back to `registered`).
 */
export function deviceChangeAllowed(
  change: DeviceChangeKind,
  observedStatus: string,
): { readonly ok: true } | { readonly ok: false; readonly reason: 'already_registered' | 'unknown_device' | 'not_actionable' } {
  if (change === 'register') {
    return observedStatus === 'unregistered' ? { ok: true } : { ok: false, reason: 'already_registered' };
  }
  if (observedStatus === 'unregistered') return { ok: false, reason: 'unknown_device' };
  const allowedFrom: Readonly<Record<Exclude<DeviceChangeKind, 'register'>, readonly string[]>> = {
    block: ['registered'],
    retire: ['registered', 'blocked'],
    reinstate: ['blocked', 'retired'],
  };
  return allowedFrom[change].includes(observedStatus) ? { ok: true } : { ok: false, reason: 'not_actionable' };
}

/**
 * The dedupe identity of a device command. Keyed on the change, the device AND its observed status, so a
 * double-click or a reload collapses to one command (§31.1), while a genuine re-request after the device has
 * moved (e.g. block, then later retire) is a distinct, legitimate command.
 */
export function deviceChangeKey(deviceId: string, change: DeviceChangeKind, observedStatus: string): string {
  return `device-change|${change}|${deviceId}|${observedStatus}`;
}

/** Build the (deterministic) outbox command for a device change. `at` is the caller's clock. */
export function buildDeviceChangeCommand(input: {
  readonly deviceId: string;
  readonly change: DeviceChangeKind;
  readonly observedStatus: string;
  readonly requestedBy: string;
  readonly at: string;
  readonly register?: DeviceRegisterDetails;
  readonly reason?: string;
}): DeviceChangeCommand {
  const key = deviceChangeKey(input.deviceId, input.change, input.observedStatus);
  return makeEvent({
    id: key, // one key ⇒ one command, so a duplicate collapses on the idempotency key
    type: DEVICE_CHANGE_EVENT,
    occurredAt: input.at,
    idempotencyKey: key,
    source: 'web-erp/fleet',
    payload: {
      deviceId: input.deviceId,
      change: input.change,
      requestedBy: input.requestedBy,
      observedStatus: input.observedStatus,
      ...(input.register !== undefined ? { register: input.register } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    },
  });
}

/** Why a device change could not be queued — worded by the shell. */
export type DeviceChangeRefusal =
  | 'already_registered' | 'unknown_device' | 'not_actionable'
  | 'missing_details' | 'missing_reason' | 'already_queued';
export type DeviceChangeResult =
  | { readonly ok: true; readonly key: string; readonly state: OutboxState }
  | { readonly ok: false; readonly refusal: DeviceChangeRefusal };

/** A register detail set is complete only with a non-blank branch, a known kind and a non-blank label. */
function registerDetailsComplete(details: DeviceRegisterDetails | undefined): details is DeviceRegisterDetails {
  return details !== undefined
    && details.branchId.trim() !== ''
    && details.label.trim() !== ''
    && DEVICE_KINDS.includes(details.kind);
}

/**
 * Validate a device change against the observed status and queue a durable command if it holds.
 *
 * Nothing is queued unless the registry would accept it: a register for a device already in the fleet, a block
 * on a device nobody registered, a status change with no stated reason — all are refused here. A change already
 * queued for this exact device+status collapses rather than doubling. The API re-checks everything (permission,
 * device existence, status transition) at the write boundary.
 */
export function queueDeviceChange(
  outbox: SyncOutbox,
  input: {
    readonly deviceId: string;
    readonly change: DeviceChangeKind;
    readonly observedStatus: string;
    readonly requestedBy: string;
    readonly at: string;
    readonly register?: DeviceRegisterDetails;
    readonly reason?: string;
  },
): DeviceChangeResult {
  const allowed = deviceChangeAllowed(input.change, input.observedStatus);
  if (!allowed.ok) return { ok: false, refusal: allowed.reason };

  if (input.change === 'register') {
    if (!registerDetailsComplete(input.register)) return { ok: false, refusal: 'missing_details' };
  } else if (input.reason === undefined || input.reason.trim() === '') {
    return { ok: false, refusal: 'missing_reason' };
  }

  const key = deviceChangeKey(input.deviceId, input.change, input.observedStatus);
  if (outbox.find(key) !== undefined) return { ok: false, refusal: 'already_queued' };

  const item = outbox.enqueue(buildDeviceChangeCommand({
    deviceId: input.deviceId,
    change: input.change,
    observedStatus: input.observedStatus,
    requestedBy: input.requestedBy,
    at: input.at,
    ...(input.change === 'register' ? { register: input.register } : {}),
    ...(input.change !== 'register' ? { reason: input.reason } : {}),
  }));
  return { ok: true, key: item.key, state: item.state };
}
