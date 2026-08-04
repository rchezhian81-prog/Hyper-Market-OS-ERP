// Device, terminal and application-version control (M33-FR-02 / A-10 / §33 / §35).
//
// This module exists because of one specific disaster shape, which the roadmap calls
// out as mobile-safety finding A-10:
//
//     A broken release ships. Every till in the shop upgrades. The shop cannot sell.
//
// The defences are all about keeping a way back:
//
//   • SERVER SUPPORTS CURRENT AND PREVIOUS VERSION. Always two. A server that only
//     talks to the newest client turns every upgrade into a cliff, and turns a bad
//     release into an outage with no rollback.
//   • A MINIMUM SUPPORTED VERSION forces genuinely-too-old clients to upgrade — but
//     it is a floor, not the latest, so a device one version behind keeps working.
//   • A BROKEN RELEASE CAN BE KILLED REMOTELY. Marking a version dead moves its
//     devices back, rather than requiring someone to visit each lane.
//   • AN UNREGISTERED DEVICE CANNOT TRADE. A till nobody registered is a till nobody
//     is accountable for.
//
// And one rule that overrides all of them: **a kill or an upgrade never interrupts a
// sale in progress**. The device is told at the next safe moment. A lane that stops
// mid-basket to upgrade has turned a software problem into a customer's problem.
//
// Pure and deterministic: no clock, no I/O. Versions are compared numerically, not
// as strings — "1.10.0" is newer than "1.9.0", which string comparison gets wrong.

export type DeviceKind = 'pos_lane' | 'handheld' | 'scale' | 'printer' | 'kiosk' | 'mobile';
export type DeviceStatus = 'registered' | 'blocked' | 'retired';

export interface Device {
  readonly deviceId: string;
  readonly tenantId: string;
  readonly branchId: string;
  readonly kind: DeviceKind;
  readonly label: string;
  readonly status: DeviceStatus;
  readonly appVersion?: string;
  /** ISO-8601 UTC when it last reported in — silence is itself a signal. */
  readonly lastSeenAt?: string;
  /** A rooted or jailbroken device is never trusted with trading (§35). */
  readonly integrityCompromised?: boolean;
}

export interface VersionPolicy {
  /** The version the fleet should be on. */
  readonly currentVersion: string;
  /** The one before it. The server must keep talking to this (A-10). */
  readonly previousVersion?: string;
  /** Below this, a client must upgrade before it may do anything. */
  readonly minimumSupportedVersion: string;
  /** Versions withdrawn because they are broken — devices on them are moved back. */
  readonly killedVersions?: readonly string[];
}

export type DeviceVerdict =
  | 'ok'
  | 'upgrade_required'
  | 'upgrade_available'
  | 'version_killed'
  | 'unregistered'
  | 'blocked'
  | 'integrity_failed'
  | 'no_version_reported';

export interface DeviceDecision {
  readonly deviceId: string;
  readonly verdict: DeviceVerdict;
  /** May this device take a sale right now? */
  readonly mayTrade: boolean;
  /** True only when the device must move before it can carry on. */
  readonly mustUpgrade: boolean;
  /** Where it should move to, when it must or may. */
  readonly targetVersion?: string;
  readonly detail: string;
  /**
   * Never interrupt a sale in progress. When true, the instruction is delivered at
   * the next safe moment — between baskets — not now.
   */
  readonly deferUntilIdle: boolean;
}

export class InvalidVersionError extends Error {
  constructor(public readonly value: string) {
    super(`"${value}" is not a version this system can compare (expected e.g. 1.4.2)`);
    this.name = 'InvalidVersionError';
  }
}

/** Parse a semantic version into comparable parts. Refuses anything ambiguous. */
export function parseVersion(value: string): readonly [number, number, number] {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  if (!m) throw new InvalidVersionError(value);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** −1, 0 or 1. Numeric, so 1.10.0 correctly beats 1.9.0. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l < r) return -1;
    if (l > r) return 1;
  }
  return 0;
}

/**
 * Decide what a device may do. `mayTrade` is the only field the lane acts on
 * immediately; everything else is an instruction for the next safe moment.
 */
export function evaluateDevice(
  device: Device | undefined,
  policy: VersionPolicy,
): DeviceDecision {
  if (device === undefined) {
    return {
      deviceId: '(unknown)',
      verdict: 'unregistered',
      mayTrade: false,
      mustUpgrade: false,
      detail: 'this device is not registered — a till nobody registered is a till nobody is accountable for',
      deferUntilIdle: false,
    };
  }

  const base = { deviceId: device.deviceId };

  if (device.integrityCompromised === true) {
    return {
      ...base,
      verdict: 'integrity_failed',
      mayTrade: false,
      mustUpgrade: false,
      detail: 'the device reports a compromised operating system and is not trusted with trading (§35)',
      deferUntilIdle: false,
    };
  }
  if (device.status !== 'registered') {
    return {
      ...base,
      verdict: 'blocked',
      mayTrade: false,
      mustUpgrade: false,
      detail: `the device is ${device.status}`,
      deferUntilIdle: false,
    };
  }
  if (device.appVersion === undefined) {
    return {
      ...base,
      verdict: 'no_version_reported',
      mayTrade: false,
      mustUpgrade: true,
      targetVersion: policy.currentVersion,
      detail: 'the device has not said which version it is running, so it cannot be trusted to behave',
      deferUntilIdle: false,
    };
  }

  // A killed release is the emergency path: move the device back, but never mid-sale.
  if ((policy.killedVersions ?? []).includes(device.appVersion)) {
    const target = policy.previousVersion ?? policy.currentVersion;
    return {
      ...base,
      verdict: 'version_killed',
      // It keeps trading until it is idle: stopping a lane mid-basket turns a
      // software problem into a customer's problem.
      mayTrade: true,
      mustUpgrade: true,
      targetVersion: target,
      detail: `version ${device.appVersion} has been withdrawn — this lane moves to ${target} as soon as it is between baskets`,
      deferUntilIdle: true,
    };
  }

  if (compareVersions(device.appVersion, policy.minimumSupportedVersion) < 0) {
    return {
      ...base,
      verdict: 'upgrade_required',
      mayTrade: false,
      mustUpgrade: true,
      targetVersion: policy.currentVersion,
      detail: `version ${device.appVersion} is below the minimum supported ${policy.minimumSupportedVersion} and must upgrade before trading`,
      deferUntilIdle: false,
    };
  }

  if (compareVersions(device.appVersion, policy.currentVersion) < 0) {
    // Behind but supported — the whole point of keeping the previous version alive.
    return {
      ...base,
      verdict: 'upgrade_available',
      mayTrade: true,
      mustUpgrade: false,
      targetVersion: policy.currentVersion,
      detail: `version ${device.appVersion} still works; ${policy.currentVersion} is available when convenient`,
      deferUntilIdle: true,
    };
  }

  return {
    ...base,
    verdict: 'ok',
    mayTrade: true,
    mustUpgrade: false,
    detail: `running ${device.appVersion}`,
    deferUntilIdle: false,
  };
}

export class UnsafeVersionPolicyError extends Error {
  constructor(public readonly why: string) {
    super(`This version policy would strand the fleet: ${why}`);
    this.name = 'UnsafeVersionPolicyError';
  }
}

/**
 * Refuse a policy that would break the shop. The commonest way to cause an outage
 * with a config change is to raise the minimum supported version to the newest one:
 * every device a version behind stops trading at once.
 */
export function validateVersionPolicy(policy: VersionPolicy): VersionPolicy {
  parseVersion(policy.currentVersion);
  parseVersion(policy.minimumSupportedVersion);

  if (compareVersions(policy.minimumSupportedVersion, policy.currentVersion) > 0) {
    throw new UnsafeVersionPolicyError(
      `the minimum supported version ${policy.minimumSupportedVersion} is newer than the current ${policy.currentVersion} — nothing could trade`,
    );
  }
  if (policy.previousVersion !== undefined) {
    if (compareVersions(policy.previousVersion, policy.currentVersion) >= 0) {
      throw new UnsafeVersionPolicyError(
        'the "previous" version is not older than the current one',
      );
    }
    if (compareVersions(policy.minimumSupportedVersion, policy.previousVersion) > 0) {
      // A-10: the server supports current AND previous. Cutting off the previous
      // version removes the only rollback target.
      throw new UnsafeVersionPolicyError(
        `the minimum ${policy.minimumSupportedVersion} excludes the previous version ${policy.previousVersion}, which removes the rollback path (A-10)`,
      );
    }
  }
  if ((policy.killedVersions ?? []).includes(policy.currentVersion)) {
    throw new UnsafeVersionPolicyError(
      'the current version is also marked as killed — there would be nothing to move devices on to',
    );
  }
  return policy;
}

export interface FleetSummary {
  readonly total: number;
  readonly trading: number;
  readonly blocked: number;
  readonly mustUpgrade: number;
  /** Devices that have not reported in — silence is a signal, not health. */
  readonly silent: readonly string[];
  readonly byVersion: Readonly<Record<string, number>>;
}

/** The fleet at a glance, for the status centre (M33-FR-04). */
export function fleetSummary(
  devices: readonly Device[],
  policy: VersionPolicy,
  now: string,
  silentAfterMinutes = 60,
): FleetSummary {
  const decisions = devices.map((d) => evaluateDevice(d, policy));
  const byVersion: Record<string, number> = {};
  const silent: string[] = [];

  for (const device of devices) {
    const key = device.appVersion ?? '(not reported)';
    byVersion[key] = (byVersion[key] ?? 0) + 1;
    const seen = device.lastSeenAt === undefined ? undefined : Date.parse(device.lastSeenAt);
    if (
      device.status === 'registered' &&
      (seen === undefined || Date.parse(now) - seen > silentAfterMinutes * 60_000)
    ) {
      silent.push(device.deviceId);
    }
  }

  return {
    total: devices.length,
    trading: decisions.filter((d) => d.mayTrade).length,
    blocked: decisions.filter((d) => !d.mayTrade).length,
    mustUpgrade: decisions.filter((d) => d.mustUpgrade).length,
    silent,
    byVersion,
  };
}
