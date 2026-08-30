// Durable device registry (M33-FR-02/04 · A-10 · §35) — the write path under the stateless device
// decisions. `evaluateDevice`/`fleetSummary` (services/platform/src/devices.ts) are what-ifs the caller
// drives with a supplied device list; this keeps the shop's REAL fleet on the system, append-only, so the
// health view reads what is actually plugged in rather than a figure somebody typed.
//
//   • REGISTER a device — a till nobody registered is a till nobody is accountable for. Registration is
//     an event; re-registering updates its label/version, it never forks a second record.
//   • BLOCK or RETIRE a device — a status change is a new event; the history stays (it is the record that
//     explains why a lane stopped trading). A status change on a device nobody registered is refused.
//   • REPORT IN — a heartbeat updates when the device was last seen and what it is running; silence is
//     then a real signal, not an assumption.
//
// The current fleet is a PROJECTION of that append-only log (latest state per deviceId), so it survives a
// restart. `GET /v1/platform/devices` lists it; `POST …/fleet-health` runs the tested fleetSummary +
// evaluateDevice over the STORED fleet against a supplied version policy — refusing a policy that would
// itself brick the fleet before it reports (A-10). Writes are gated platform.device.manage; reads
// platform.health.read.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  evaluateDevice, fleetSummary, validateVersionPolicy, InvalidVersionError, UnsafeVersionPolicyError,
  type Device, type DeviceKind, type DeviceStatus, type VersionPolicy,
} from '../../../packages/platform-admin/src/devices';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isNonNegInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const KINDS: readonly DeviceKind[] = ['pos_lane', 'handheld', 'scale', 'printer', 'kiosk', 'mobile'];
const isKind = (v: unknown): v is DeviceKind => typeof v === 'string' && (KINDS as readonly string[]).includes(v);
// A status a person may SET: reinstate (registered), block, or retire. (integrity/version verdicts are
// computed by evaluateDevice, never stored as a status.)
const SETTABLE: readonly DeviceStatus[] = ['registered', 'blocked', 'retired'];
const isSettableStatus = (v: unknown): v is DeviceStatus => typeof v === 'string' && (SETTABLE as readonly string[]).includes(v);
const strArray = (v: unknown): readonly string[] | undefined =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;

/** One append-only entry in a device's life. A single event type carries all three shapes (discriminated). */
export interface DeviceRegistryEvent {
  readonly kind: 'registered' | 'status' | 'reported';
  readonly deviceId: string;
  readonly at: string;
  // registered
  readonly branchId?: string;
  readonly deviceKind?: DeviceKind;
  readonly label?: string;
  readonly appVersion?: string;
  readonly by?: string;
  // status
  readonly status?: DeviceStatus;
  readonly reason?: string;
  // reported
  readonly integrityCompromised?: boolean;
}

/**
 * Fold the append-only device log into the current fleet — latest state per deviceId, in event order.
 * Registration creates or refreshes; a status change moves an existing device; a heartbeat updates when it
 * was last seen and what it runs. An event for a device that was never registered is ignored (there is no
 * device to move), so a stray status/heartbeat cannot conjure a phantom till.
 */
export function projectFleet(tenantId: string, events: readonly DeviceRegistryEvent[]): readonly Device[] {
  const byId = new Map<string, Device>();
  for (const e of events) {
    const cur = byId.get(e.deviceId);
    if (e.kind === 'registered') {
      byId.set(e.deviceId, {
        deviceId: e.deviceId, tenantId,
        branchId: e.branchId ?? cur?.branchId ?? '',
        kind: e.deviceKind ?? cur?.kind ?? 'pos_lane',
        label: e.label ?? cur?.label ?? e.deviceId,
        status: 'registered',
        lastSeenAt: e.at,
        ...(e.appVersion !== undefined ? { appVersion: e.appVersion } : cur?.appVersion !== undefined ? { appVersion: cur.appVersion } : {}),
        ...(cur?.integrityCompromised !== undefined ? { integrityCompromised: cur.integrityCompromised } : {}),
      });
    } else if (cur !== undefined && e.kind === 'status' && e.status !== undefined) {
      byId.set(e.deviceId, { ...cur, status: e.status });
    } else if (cur !== undefined && e.kind === 'reported') {
      byId.set(e.deviceId, {
        ...cur, lastSeenAt: e.at,
        ...(e.appVersion !== undefined ? { appVersion: e.appVersion } : {}),
        ...(e.integrityCompromised !== undefined ? { integrityCompromised: e.integrityCompromised } : {}),
      });
    }
  }
  return [...byId.values()].sort((a, b) => (a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0));
}

export interface DeviceRegistryDeps {
  /** The current fleet, projected from the append-only device log (survives restart). */
  readonly fleet: (tenantId: string) => Promise<readonly Device[]> | readonly Device[];
  /** Append one device event. Idempotent on the key (a re-sync is one event, not two). */
  readonly recordDeviceEvent: (tenantId: string, event: DeviceRegistryEvent, key: string) => Promise<void> | void;
  /**
   * The STORED version policy the fleet is judged against when a fleet-health request supplies none — so a
   * durable remote kill actually takes effect on the health read. Optional: absent on the store-less stub,
   * where a fleet-health request must then carry a policy in its body.
   */
  readonly storedPolicy?: (tenantId: string) => Promise<VersionPolicy | undefined> | VersionPolicy | undefined;
  readonly now: () => string;
}

function readPolicy(v: unknown): VersionPolicy | undefined {
  if (!isObj(v) || !isStr(v['currentVersion']) || !isStr(v['minimumSupportedVersion'])) return undefined;
  if (v['previousVersion'] !== undefined && !isStr(v['previousVersion'])) return undefined;
  const killed = v['killedVersions'] === undefined ? undefined : strArray(v['killedVersions']);
  if (v['killedVersions'] !== undefined && killed === undefined) return undefined;
  return {
    currentVersion: v['currentVersion'] as string, minimumSupportedVersion: v['minimumSupportedVersion'] as string,
    ...(isStr(v['previousVersion']) ? { previousVersion: v['previousVersion'] } : {}),
    ...(killed !== undefined ? { killedVersions: killed } : {}),
  };
}

// A policy that would brick the fleet, or a version this system cannot compare, is refused before any
// health is reported (A-10) — the same guard the stateless routes use.
const guardPolicy = (policy: VersionPolicy): void => {
  try {
    validateVersionPolicy(policy);
  } catch (e) {
    if (e instanceof UnsafeVersionPolicyError) throw apiError(422, { code: 'unsafe_version_policy', whatHappened: e.message, wasItSaved: 'not_saved', nextSafeAction: 'Fix the policy so current and previous keep a rollback path, then send it again.' });
    if (e instanceof InvalidVersionError) throw apiError(422, { code: 'version_not_comparable', whatHappened: e.message, wasItSaved: 'not_saved', nextSafeAction: 'Send versions as numbers like 1.4.2.' });
    throw e;
  }
};

export function deviceRegistryRoutes(deps: DeviceRegistryDeps): readonly Route[] {
  return [
    {
      // The stored fleet — the real machines the shop has registered. Read-only.
      api: 'API-10', method: 'GET', path: '/v1/platform/devices',
      permission: 'platform.health.read',
      handler: async (ctx) => {
        const devices = await deps.fleet(ctx.tenantId);
        return { status: 200, body: { devices, count: devices.length, asAt: deps.now() } };
      },
    },
    {
      // The fleet health for the status centre, over the STORED fleet (M33-FR-04). Body: { policy?,
      // silentAfterMinutes? }. The policy comes from the body when supplied; OTHERWISE the STORED version
      // policy is used, so a durable remote kill takes effect here. Refuses a policy that would brick the
      // fleet first, then reports the rollup and each device's live verdict. Read-only.
      api: 'API-10', method: 'POST', path: '/v1/platform/devices/fleet-health',
      permission: 'platform.health.read', idempotent: true,
      handler: async (ctx) => {
        const b = ctx.body;
        // A policy in the body must be well-formed; an ABSENT policy falls back to the stored one.
        const hasBodyPolicy = isObj(b) && b['policy'] !== undefined;
        const bodyPolicy = hasBodyPolicy ? readPolicy(b['policy']) : undefined;
        const silentBad = isObj(b) && b['silentAfterMinutes'] !== undefined && !isNonNegInt(b['silentAfterMinutes']);
        if ((hasBodyPolicy && bodyPolicy === undefined) || silentBad) {
          throw apiError(400, { code: 'not_readable_as_a_fleet_health_request', whatHappened: 'A fleet-health request takes an optional { policy } (currentVersion + minimumSupportedVersion, optional previousVersion/killedVersions[]) and an optional silentAfterMinutes.', wasItSaved: 'not_saved', nextSafeAction: 'Send a well-formed version policy, or set the durable version policy so it can be used.' });
        }
        const policy = bodyPolicy ?? (await deps.storedPolicy?.(ctx.tenantId));
        if (policy === undefined) {
          throw apiError(409, { code: 'no_version_policy', whatHappened: 'No version policy was supplied and none has been set, so the fleet cannot be judged.', wasItSaved: 'not_saved', nextSafeAction: 'Set the version policy first (POST /v1/platform/version-policy), then read fleet health.' });
        }
        guardPolicy(policy);
        const now = deps.now();
        const fleet = await deps.fleet(ctx.tenantId);
        const silentAfter = isObj(b) && isNonNegInt(b['silentAfterMinutes']) ? (b['silentAfterMinutes'] as number) : undefined;
        const summary = silentAfter !== undefined ? fleetSummary(fleet, policy, now, silentAfter) : fleetSummary(fleet, policy, now);
        return {
          status: 200,
          body: { summary, devices: fleet.map((d) => ({ device: d, decision: evaluateDevice(d, policy) })), asAt: now },
        };
      },
    },
    {
      // Register a device (or refresh its label/version). A till nobody registered is a till nobody is
      // accountable for. Append-only: re-registering updates the same record, never forks a second.
      api: 'API-10', method: 'POST', path: '/v1/platform/devices/:deviceId/register',
      permission: 'platform.device.manage', idempotent: true,
      handler: async (ctx) => {
        const deviceId = (ctx.params['deviceId'] ?? '').trim();
        const b = ctx.body;
        if (deviceId === '' || !isObj(b) || !isStr(b['branchId']) || !isKind(b['kind']) || !isStr(b['label'])
          || (b['appVersion'] !== undefined && !isStr(b['appVersion']))) {
          throw apiError(400, { code: 'not_readable_as_a_device', whatHappened: 'Registering a device needs a deviceId in the path and { branchId, kind (pos_lane|handheld|scale|printer|kiosk|mobile), label, appVersion? }.', wasItSaved: 'not_saved', nextSafeAction: 'Send which branch, what kind of device and its label.' });
        }
        const at = deps.now();
        const event: DeviceRegistryEvent = {
          kind: 'registered', deviceId, branchId: b['branchId'] as string, deviceKind: b['kind'], label: b['label'] as string,
          by: ctx.userId, at, ...(isStr(b['appVersion']) ? { appVersion: b['appVersion'] } : {}),
        };
        await deps.recordDeviceEvent(ctx.tenantId, event, ctx.idempotencyKey ?? `${deviceId}-register-${at}`);
        return { status: 201, body: { deviceId, registered: true, branchId: event.branchId, kind: event.deviceKind, label: event.label, at } };
      },
    },
    {
      // Block or retire a device — or reinstate one. A status change is a new event; a device nobody
      // registered cannot be moved (there is nothing to move).
      api: 'API-10', method: 'POST', path: '/v1/platform/devices/:deviceId/status',
      permission: 'platform.device.manage', idempotent: true,
      handler: async (ctx) => {
        const deviceId = (ctx.params['deviceId'] ?? '').trim();
        const b = ctx.body;
        if (deviceId === '' || !isObj(b) || !isSettableStatus(b['status']) || !isStr(b['reason'])) {
          throw apiError(400, { code: 'not_readable_as_a_status_change', whatHappened: 'A status change needs a deviceId in the path and { status (registered|blocked|retired), reason }.', wasItSaved: 'not_saved', nextSafeAction: 'Send the new status and why.' });
        }
        const known = (await deps.fleet(ctx.tenantId)).some((d) => d.deviceId === deviceId);
        if (!known) {
          throw apiError(404, { code: 'device_not_registered', whatHappened: `No device "${deviceId}" is registered, so its status cannot be changed.`, wasItSaved: 'not_saved', nextSafeAction: 'Register the device first, then change its status.' });
        }
        const at = deps.now();
        await deps.recordDeviceEvent(ctx.tenantId, { kind: 'status', deviceId, status: b['status'], reason: b['reason'] as string, by: ctx.userId, at }, ctx.idempotencyKey ?? `${deviceId}-status-${at}`);
        return { status: 200, body: { deviceId, status: b['status'], at } };
      },
    },
    {
      // A device reporting in (heartbeat): update when it was last seen and what it is running, so silence
      // is a real signal. A report for an unregistered device is ignored by the projection, so this is safe
      // to accept idempotently without a lookup.
      api: 'API-10', method: 'POST', path: '/v1/platform/devices/:deviceId/report',
      permission: 'platform.device.manage', idempotent: true,
      handler: async (ctx) => {
        const deviceId = (ctx.params['deviceId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (deviceId === '' || (b['appVersion'] !== undefined && !isStr(b['appVersion'])) || (b['integrityCompromised'] !== undefined && !isBool(b['integrityCompromised']))) {
          throw apiError(400, { code: 'not_readable_as_a_device_report', whatHappened: 'A device report needs a deviceId in the path and optional { appVersion, integrityCompromised }.', wasItSaved: 'not_saved', nextSafeAction: 'Send which version the device is running.' });
        }
        const at = deps.now();
        await deps.recordDeviceEvent(ctx.tenantId, {
          kind: 'reported', deviceId, at,
          ...(isStr(b['appVersion']) ? { appVersion: b['appVersion'] } : {}),
          ...(isBool(b['integrityCompromised']) ? { integrityCompromised: b['integrityCompromised'] } : {}),
        }, ctx.idempotencyKey ?? `${deviceId}-report-${at}`);
        return { status: 202, body: { deviceId, reportedAt: at } };
      },
    },
  ];
}
