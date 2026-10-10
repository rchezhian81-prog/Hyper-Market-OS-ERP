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
//   • ISSUE AN ENROLMENT CODE (SP-3a · ADR-0019) — for a registered HANDHELD: a one-time code, shown once to the
//     admin, kept here only as a hash with its expiry. The store box compares a typed code against the hash and
//     mints the device its own credential; a blocked or retired device cannot be issued one.
//
// The current fleet is a PROJECTION of that append-only log (latest state per deviceId), so it survives a
// restart. `GET /v1/platform/devices` lists it; `POST …/fleet-health` runs the tested fleetSummary +
// evaluateDevice over the STORED fleet against a supplied version policy — refusing a policy that would
// itself brick the fleet before it reports (A-10). Writes are gated platform.device.manage; reads
// platform.health.read.

import type { Route } from '../../kernel/src/index';
import { apiError, assertBranchInScope, narrowScope, type RequestContext } from '../../kernel/src/index';
import {
  evaluateDevice, fleetSummary, validateVersionPolicy, InvalidVersionError, UnsafeVersionPolicyError,
  type Device, type DeviceKind, type DeviceStatus, type VersionPolicy,
} from '../../../packages/platform-admin/src/devices';
import { mintEnrolmentCode, enrolmentCodeHash } from '../../../packages/platform-admin/src/device-enrolment';
import type { AuditEntry } from '../../../packages/audit/src/index';

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

/** The kinds of device a person carries onto the shop floor — the only kinds that may enrol on the box's device socket. */
export const ENROLLABLE_KINDS: readonly DeviceKind[] = ['handheld', 'mobile'];
/** How long an issued enrolment code stays usable unless the admin says otherwise: a shift and a night. */
export const DEFAULT_ENROLMENT_MINUTES = 24 * 60;
export const MAX_ENROLMENT_MINUTES = 7 * 24 * 60;

/** One append-only entry in a device's life. A single event type carries all four shapes (discriminated). */
export interface DeviceRegistryEvent {
  readonly kind: 'registered' | 'status' | 'reported' | 'enrolment';
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
  // enrolment (SP-3a): the code's HASH and expiry — never the code
  readonly codeHash?: string;
  readonly expiresAt?: string;
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
    } else if (cur !== undefined && e.kind === 'enrolment' && e.codeHash !== undefined && e.expiresAt !== undefined) {
      // The latest code supersedes any earlier one: a re-issue is how a lost code is invalidated.
      byId.set(e.deviceId, { ...cur, enrolment: { codeHash: e.codeHash, expiresAt: e.expiresAt, issuedAt: e.at } });
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
  /** Seal an enrolment-code issue on the audit trail (M34): who issued a credential for which device, never the code. */
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  /** Random bytes for the code. Injected so a test can pin the code; production uses `node:crypto`. */
  readonly randomBytes?: (n: number) => Buffer;
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

/** PA-01-r1: the devices of the caller's branches (narrowed to ?branchId= when asked; another branch refused by name). */
async function fleetInScope(ctx: Pick<RequestContext, 'scope' | 'tenantId' | 'query'>, deps: DeviceRegistryDeps) {
  const asked = ctx.query['branchId'];
  const scope = narrowScope(ctx, typeof asked === 'string' && asked !== '' ? [asked] : undefined);
  return (await deps.fleet(ctx.tenantId)).filter((d) => scope === 'all' || scope.includes(d.branchId));
}

export function deviceRegistryRoutes(deps: DeviceRegistryDeps): readonly Route[] {
  return [
    {
      // The stored fleet — the real machines the shop has registered. Read-only.
      api: 'API-10', method: 'GET', path: '/v1/platform/devices',
      permission: 'platform.health.read',
      handler: async (ctx) => {
        const devices = await fleetInScope(ctx, deps); // PA-01-r1
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
        const fleet = await fleetInScope(ctx, deps); // PA-01-r1: the caller's branches' devices only
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
        // PA-01-r1: registered only at a branch the caller holds; a device on file at another branch is not moved.
        assertBranchInScope(ctx, b['branchId'] as string);
        const existing = (await deps.fleet(ctx.tenantId)).find((d) => d.deviceId === deviceId);
        if (existing !== undefined) assertBranchInScope(ctx, existing.branchId);
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
        const knownDevice = (await deps.fleet(ctx.tenantId)).find((d) => d.deviceId === deviceId);
        const known = knownDevice !== undefined;
        if (knownDevice !== undefined) assertBranchInScope(ctx, knownDevice.branchId); // PA-01-r1
        if (!known) {
          throw apiError(404, { code: 'device_not_registered', whatHappened: `No device "${deviceId}" is registered, so its status cannot be changed.`, wasItSaved: 'not_saved', nextSafeAction: 'Register the device first, then change its status.' });
        }
        const at = deps.now();
        await deps.recordDeviceEvent(ctx.tenantId, { kind: 'status', deviceId, status: b['status'], reason: b['reason'] as string, by: ctx.userId, at }, ctx.idempotencyKey ?? `${deviceId}-status-${at}`);
        return { status: 200, body: { deviceId, status: b['status'], at } };
      },
    },
    {
      // Issue a one-time ENROLMENT CODE for a registered handheld (SP-3a · ADR-0019). The code is returned ONCE, in
      // this response, to the admin who holds `platform.device.manage`; only its hash is kept, with its expiry. A
      // re-issue supersedes the earlier code. Refused for a device nobody registered, a device that is not a handheld
      // (a till or a printer never enrols on the device socket), or a device that is blocked or retired. Body:
      // { validForMinutes? } (5 minutes … 7 days; default a day). Idempotent on the caller's key.
      api: 'API-10', method: 'POST', path: '/v1/platform/devices/:deviceId/enrolment',
      permission: 'platform.device.manage', idempotent: true,
      handler: async (ctx) => {
        const deviceId = (ctx.params['deviceId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const minutes = b['validForMinutes'];
        if (deviceId === '' || (minutes !== undefined && !(Number.isInteger(minutes) && (minutes as number) >= 5 && (minutes as number) <= MAX_ENROLMENT_MINUTES))) {
          throw apiError(400, { code: 'not_readable_as_an_enrolment_request', whatHappened: 'Issuing an enrolment code needs a deviceId in the path and, optionally, { validForMinutes } between 5 and 10080.', wasItSaved: 'not_saved', nextSafeAction: 'Send which device, and for how long the code should stay usable.' });
        }
        const device = (await deps.fleet(ctx.tenantId)).find((d) => d.deviceId === deviceId);
        if (device !== undefined) assertBranchInScope(ctx, device.branchId); // PA-01-r1
        if (device === undefined) {
          throw apiError(404, { code: 'device_not_registered', whatHappened: `No device "${deviceId}" is registered, so no enrolment code can be issued for it.`, wasItSaved: 'not_saved', nextSafeAction: 'Register the handheld first, then issue its code.' });
        }
        if (!ENROLLABLE_KINDS.includes(device.kind)) {
          throw apiError(422, { code: 'device_kind_cannot_enrol', whatHappened: `${deviceId} is a ${device.kind}; only a handheld or a mobile enrols on the store computer's device socket.`, wasItSaved: 'not_saved', nextSafeAction: 'Issue codes for handhelds and mobiles only. Nothing was changed.' });
        }
        if (device.status !== 'registered') {
          throw apiError(409, { code: 'device_not_active', whatHappened: `${deviceId} is ${device.status}; a ${device.status} device cannot be issued an enrolment code.`, wasItSaved: 'not_saved', nextSafeAction: 'Reinstate the device first if that is intended. Nothing was changed.' });
        }
        const at = deps.now();
        const validFor = (minutes as number | undefined) ?? DEFAULT_ENROLMENT_MINUTES;
        const expiresAt = new Date(Date.parse(at) + validFor * 60_000).toISOString();
        const code = mintEnrolmentCode(deps.randomBytes);
        const codeHash = enrolmentCodeHash(code);
        await deps.recordDeviceEvent(ctx.tenantId, { kind: 'enrolment', deviceId, codeHash, expiresAt, by: ctx.userId, at }, ctx.idempotencyKey ?? `${deviceId}-enrolment-${at}`);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'device.enrolment.issue', objectType: 'device', objectId: deviceId,
          at, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: null,
          // The hash and the expiry — never the code (hard rule #4).
          after: { kind: device.kind, label: device.label, codeHash, expiresAt },
          correlationId: deviceId,
        });
        return { status: 201, body: { deviceId, code, expiresAt, issuedAt: at } };
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
        const reporting = (await deps.fleet(ctx.tenantId)).find((d) => d.deviceId === deviceId);
        if (reporting !== undefined) assertBranchInScope(ctx, reporting.branchId); // PA-01-r1
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
