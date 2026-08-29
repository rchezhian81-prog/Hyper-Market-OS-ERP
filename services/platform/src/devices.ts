// Device, terminal and application-version control (M33-FR-02/FR-04 · A-10 · §33 · §35) — the tested
// `packages/platform-admin/src/devices.ts` engine, on the cloud. It exists for one disaster shape the
// roadmap names as mobile-safety finding A-10: a broken release ships, every till upgrades, the shop
// cannot sell. The defences are all about keeping a way back — the server supports current AND previous,
// a minimum floor (never the latest) forces only the genuinely-too-old to move, a broken release can be
// killed remotely to move its devices back, an unregistered device cannot trade — and one rule over all:
// a kill or upgrade NEVER interrupts a sale in progress; it is delivered between baskets.
//
// Both routes run `validateVersionPolicy` FIRST, so a decision can never be handed back from a policy
// that would itself brick the fleet (a minimum newer than current, or a floor that removes the rollback
// target — A-10). Stateless: the caller supplies the device record (or none) and the policy; the durable
// device registry and the remote-kill WRITE path are the follow-on.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  evaluateDevice, validateVersionPolicy, fleetSummary, InvalidVersionError, UnsafeVersionPolicyError,
  type Device, type VersionPolicy, type DeviceKind, type DeviceStatus,
} from '../../../packages/platform-admin/src/devices';

export interface DeviceDeps {
  readonly now: () => string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isNonNegInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const KINDS: readonly DeviceKind[] = ['pos_lane', 'handheld', 'scale', 'printer', 'kiosk', 'mobile'];
const STATUSES: readonly DeviceStatus[] = ['registered', 'blocked', 'retired'];
const isKind = (v: unknown): v is DeviceKind => typeof v === 'string' && (KINDS as readonly string[]).includes(v);
const isStatus = (v: unknown): v is DeviceStatus => typeof v === 'string' && (STATUSES as readonly string[]).includes(v);
const strArray = (v: unknown): readonly string[] | undefined =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;

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

function readDevice(v: unknown): Device | undefined {
  if (!isObj(v) || !isStr(v['deviceId']) || !isStr(v['tenantId']) || !isStr(v['branchId'])
    || !isKind(v['kind']) || !isStr(v['label']) || !isStatus(v['status'])) return undefined;
  if (v['appVersion'] !== undefined && !isStr(v['appVersion'])) return undefined;
  if (v['lastSeenAt'] !== undefined && !isStr(v['lastSeenAt'])) return undefined;
  if (v['integrityCompromised'] !== undefined && !isBool(v['integrityCompromised'])) return undefined;
  return {
    deviceId: v['deviceId'] as string, tenantId: v['tenantId'] as string, branchId: v['branchId'] as string,
    kind: v['kind'], label: v['label'] as string, status: v['status'],
    ...(isStr(v['appVersion']) ? { appVersion: v['appVersion'] } : {}),
    ...(isStr(v['lastSeenAt']) ? { lastSeenAt: v['lastSeenAt'] } : {}),
    ...(isBool(v['integrityCompromised']) ? { integrityCompromised: v['integrityCompromised'] } : {}),
  };
}

// A policy that would brick the fleet is refused before any decision is handed back (A-10) — as is a
// version string this system cannot compare. Nothing is stored either way.
const guardPolicy = (policy: VersionPolicy): void => {
  try {
    validateVersionPolicy(policy);
  } catch (e) {
    if (e instanceof UnsafeVersionPolicyError) {
      throw apiError(422, { code: 'unsafe_version_policy', whatHappened: e.message, wasItSaved: 'not_saved', nextSafeAction: 'Fix the policy so the current and previous versions keep a rollback path, then send it again. Nothing was changed.' });
    }
    if (e instanceof InvalidVersionError) {
      throw apiError(422, { code: 'version_not_comparable', whatHappened: e.message, wasItSaved: 'not_saved', nextSafeAction: 'Send versions as numbers like 1.4.2. Nothing was changed.' });
    }
    throw e;
  }
};

export function deviceRoutes(deps: DeviceDeps): readonly Route[] {
  return [
    {
      // What may this device do right now (M33-FR-02 / A-10)? mayTrade is the only field the lane acts on
      // immediately; a kill or upgrade is deferred to the next idle moment so a sale is never interrupted.
      // A device absent from the body reads as UNREGISTERED (a till nobody registered is a till nobody is
      // accountable for). A rooted device, a blocked one, and one that will not say its version are all
      // refused. Read/decision only — nothing is registered or moved.
      api: 'API-10', method: 'POST', path: '/v1/platform/devices/evaluate',
      permission: 'platform.health.read', idempotent: true,
      handler: async (ctx) => {
        const b = ctx.body;
        if (!isObj(b)) throw apiError(400, { code: 'not_readable_as_a_device_check', whatHappened: 'A device check needs a { policy } and an optional { device } (absent means unregistered).', wasItSaved: 'not_saved', nextSafeAction: 'Send the version policy and, if you have it, the device record.' });
        const policy = readPolicy(b['policy']);
        if (policy === undefined) throw apiError(400, { code: 'not_readable_as_a_device_check', whatHappened: 'The policy needs a currentVersion and a minimumSupportedVersion (and optionally previousVersion and killedVersions[]).', wasItSaved: 'not_saved', nextSafeAction: 'Send a well-formed version policy.' });
        const device = b['device'] === undefined || b['device'] === null ? undefined : readDevice(b['device']);
        if (b['device'] !== undefined && b['device'] !== null && device === undefined) {
          throw apiError(400, { code: 'not_readable_as_a_device_check', whatHappened: 'The device needs a deviceId, tenantId, branchId, kind, label and status; appVersion/lastSeenAt/integrityCompromised are optional.', wasItSaved: 'not_saved', nextSafeAction: 'Correct the device record, or omit it to check an unregistered device.' });
        }
        guardPolicy(policy);
        try {
          return { status: 200, body: evaluateDevice(device, policy) };
        } catch (e) {
          if (e instanceof InvalidVersionError) throw apiError(422, { code: 'version_not_comparable', whatHappened: e.message, wasItSaved: 'not_saved', nextSafeAction: 'Send the device version as numbers like 1.4.2.' });
          throw e;
        }
      },
    },
    {
      // The fleet at a glance for the status centre (M33-FR-04): how many are trading, how many blocked or
      // must upgrade, which have gone SILENT (not reported in — silence is a signal, not health), and the
      // spread by version. Silence is judged against the server clock, not a figure the caller supplies.
      api: 'API-10', method: 'POST', path: '/v1/platform/devices/fleet-summary',
      permission: 'platform.health.read', idempotent: true,
      handler: async (ctx) => {
        const b = ctx.body;
        if (!isObj(b) || !Array.isArray(b['devices'])) throw apiError(400, { code: 'not_readable_as_a_fleet', whatHappened: 'A fleet summary needs { devices[], policy, optional silentAfterMinutes }.', wasItSaved: 'not_saved', nextSafeAction: 'Send the fleet and the version policy.' });
        const policy = readPolicy(b['policy']);
        const devices = b['devices'].map(readDevice);
        if (policy === undefined || devices.some((d) => d === undefined) || (b['silentAfterMinutes'] !== undefined && !isNonNegInt(b['silentAfterMinutes']))) {
          throw apiError(400, { code: 'not_readable_as_a_fleet', whatHappened: 'Each device must be well-formed, the policy present, and silentAfterMinutes (when given) a whole number.', wasItSaved: 'not_saved', nextSafeAction: 'Correct the fleet and send it again.' });
        }
        guardPolicy(policy);
        try {
          const summary = isNonNegInt(b['silentAfterMinutes'])
            ? fleetSummary(devices as Device[], policy, deps.now(), b['silentAfterMinutes'])
            : fleetSummary(devices as Device[], policy, deps.now());
          return { status: 200, body: { ...summary, asAt: deps.now() } };
        } catch (e) {
          if (e instanceof InvalidVersionError) throw apiError(422, { code: 'version_not_comparable', whatHappened: e.message, wasItSaved: 'not_saved', nextSafeAction: 'One device reports a version this system cannot compare — send it as numbers like 1.4.2.' });
          throw e;
        }
      },
    },
  ];
}
