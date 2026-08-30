// The device-fleet DELIVERY step (M33-FR-02/04, A-10, P-04 · P-05 · P-08, hard rule #5 · #6).
//
// This is the final leg of the fleet write path: the manager's queued register/block/retire commands
// (inc-2c-i captured them, inc-2c-ii queued them offline) are delivered to the durable device registry —
// each POSTed to its idempotent route (`POST /v1/platform/devices/:id/register` or `…/:id/status`) **under
// the operator's own session** (an injected port that carries their auth cookie, NEVER a service token, the
// same operator-authenticated pattern ADR-0013 set for product publish). This is deliberate: blocking or
// retiring a device changes central privilege state, and the registry gates on `platform.device.manage` and
// stamps who did it — so a governance command must reach the cloud as the AUTHORISED PERSON, never as the
// store's own identity. There is NO auto-delivery: this runs only when a person triggers it (P-05).
//
// Each delivery attempt transitions the durable outbox honestly (P-08, hard rule #6):
//   • accepted (2xx) → acknowledged (done);
//   • retryable (a timeout/0, a 5xx, or a transient 4xx like 429/401) → left pending, the attempt counted, so
//     a slow link never loses a change;
//   • rejected (a permanent 4xx — 403 not authorised, 404 the device is not registered, 400 a bad request)
//     → dead-lettered with the status, visible for a person, never silently dropped.
//
// The POST body is derived from the command's own payload and the idempotency key is the command's own key,
// so a retry cannot apply a change twice.

import type { SyncOutbox } from '../../../packages/sync/src/outbox';
import { statusForChange, type DeviceChangeCommand } from './fleet-device-command';

/**
 * Map one device-change command to its registry request — the path and body. Pure and exported so the
 * mapping is tested directly, and so the browser delivery port is nothing but an authenticated `fetch`.
 *   • register → `POST …/:id/register` with the device's identity `{ branchId, kind, label, appVersion? }`;
 *   • block/retire/reinstate → `POST …/:id/status` with the target `{ status, reason }`.
 */
export function deviceChangeRequest(command: DeviceChangeCommand): { readonly path: string; readonly body: Record<string, unknown> } {
  const p = command.payload;
  const id = encodeURIComponent(p.deviceId);
  if (p.change === 'register') {
    const r = p.register;
    // A register always carries its identity (the session guards it before queuing); an empty body here would
    // be a bad command the route 400s and the delivery dead-letters, never a silent partial register.
    const body = r === undefined ? {} : { branchId: r.branchId, kind: r.kind, label: r.label, ...(r.appVersion === undefined ? {} : { appVersion: r.appVersion }) };
    return { path: `/v1/platform/devices/${id}/register`, body };
  }
  return { path: `/v1/platform/devices/${id}/status`, body: { status: statusForChange(p.change), reason: p.reason ?? '' } };
}

/**
 * How the delivery reads the cloud's answer. A 0 stands for a network/timeout — retryable, so a lost link
 * never condemns a change. A 401 is retryable (a session that can be refreshed); a 403 is a real refusal (the
 * operator does not hold `platform.device.manage`) and a 404 means the device is not registered — both are
 * rejected, kept for a person, never retried into a loop.
 */
export function classifyDeviceResponse(status: number): 'accepted' | 'retryable' | 'rejected' {
  if (status >= 200 && status < 300) return 'accepted';
  if (status === 0 || status >= 500) return 'retryable';
  if (status === 408 || status === 425 || status === 429 || status === 401) return 'retryable';
  if (status >= 400) return 'rejected'; // incl. 403 not-authorised, 404 device_not_registered, 400 bad request
  return 'retryable';
}

/**
 * Operator-authenticated POST of one device-change command to its idempotent registry route. The
 * implementation carries the operator's session auth and the command's idempotency key, and returns the HTTP
 * status (or 0 for a network/timeout). Injected, so delivery is tested without a network — and so this file,
 * like every screen, never opens a socket itself.
 */
export interface FleetDeliveryPort {
  post(command: DeviceChangeCommand, idempotencyKey: string): Promise<number>;
}

export interface DeviceDeliveryReport {
  readonly delivered: readonly string[];
  readonly held: readonly string[];
  readonly refused: readonly string[];
}

/**
 * Deliver the queued device changes, as the signed-in operator. Sends every pending command through the
 * injected operator-session port and transitions each on its result. Returns what was delivered, held for
 * retry, and refused. There is NO auto-delivery: a caller (an explicit operator action) invokes this.
 *
 * Every pending command is deliverable: the session already guarded the transition and captured a reason when
 * it queued (inc-2c-i). The registry re-checks authority and the device's existence at the write boundary, so
 * a refusal there dead-letters the command for a person rather than being retried forever.
 */
export async function deliverQueuedDeviceChanges(
  outbox: SyncOutbox,
  port: FleetDeliveryPort,
): Promise<DeviceDeliveryReport> {
  const delivered: string[] = [];
  const held: string[] = [];
  const refused: string[] = [];

  for (const item of outbox.pending()) {
    const status = await port.post(item.event as DeviceChangeCommand, item.event.idempotencyKey);
    switch (classifyDeviceResponse(status)) {
      case 'accepted':
        outbox.acknowledge(item.key);
        delivered.push(item.key);
        break;
      case 'retryable':
        outbox.recordFailure(item.key); // stays pending — tried again next time
        held.push(item.key);
        break;
      case 'rejected':
        outbox.deadLetter(item.key, `the device change was refused by the cloud (HTTP ${status}) — kept for review`);
        refused.push(item.key);
        break;
    }
  }
  return { delivered, held, refused };
}
