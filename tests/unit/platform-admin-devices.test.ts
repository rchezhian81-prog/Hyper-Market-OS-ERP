import { describe, it, expect } from 'vitest';
import {
  evaluateDevice,
  validateVersionPolicy,
  compareVersions,
  parseVersion,
  fleetSummary,
  InvalidVersionError,
  UnsafeVersionPolicyError,
  type Device,
  type VersionPolicy,
} from '../../packages/platform-admin/src/index';

// M33-FR-02 / A-10 — the disaster this prevents: a broken release ships, every till
// upgrades, and the shop cannot sell.

const NOW = '2026-08-04T10:00:00Z';

const POLICY: VersionPolicy = {
  currentVersion: '1.10.0',
  previousVersion: '1.9.0',
  minimumSupportedVersion: '1.9.0',
};

function device(over: Partial<Device> = {}): Device {
  return {
    deviceId: 'till-3',
    tenantId: 't1',
    branchId: 'b1',
    kind: 'pos_lane',
    label: 'Lane 3',
    status: 'registered',
    appVersion: '1.10.0',
    lastSeenAt: '2026-08-04T09:58:00Z',
    ...over,
  };
}

describe('version comparison — numeric, not alphabetical', () => {
  it('knows 1.10.0 is newer than 1.9.0', () => {
    // String comparison gets this wrong, and it is the classic upgrade bug.
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
    expect(compareVersions('1.9.0', '1.10.0')).toBe(-1);
    expect(compareVersions('2.0.0', '2.0.0')).toBe(0);
    expect(parseVersion('1.4.2')).toEqual([1, 4, 2]);
  });

  it('refuses a version it cannot compare rather than guessing', () => {
    expect(() => parseVersion('latest')).toThrow(InvalidVersionError);
    expect(() => parseVersion('v1.2')).toThrow(InvalidVersionError);
  });
});

describe('evaluateDevice — keeping a way back (A-10)', () => {
  it('lets a current device trade', () => {
    const decision = evaluateDevice(device(), POLICY);
    expect(decision.verdict).toBe('ok');
    expect(decision.mayTrade).toBe(true);
  });

  it('keeps the PREVIOUS version trading — that is the rollback path', () => {
    const decision = evaluateDevice(device({ appVersion: '1.9.0' }), POLICY);
    expect(decision.verdict).toBe('upgrade_available');
    expect(decision.mayTrade).toBe(true);
    expect(decision.mustUpgrade).toBe(false);
    expect(decision.detail).toContain('still works');
  });

  it('forces a genuinely too-old device to upgrade before trading', () => {
    const decision = evaluateDevice(device({ appVersion: '1.2.0' }), POLICY);
    expect(decision.verdict).toBe('upgrade_required');
    expect(decision.mayTrade).toBe(false);
    expect(decision.targetVersion).toBe('1.10.0');
  });

  it('kills a broken release WITHOUT stopping a sale in progress', () => {
    const decision = evaluateDevice(device({ appVersion: '1.10.0' }), {
      ...POLICY,
      killedVersions: ['1.10.0'],
    });
    expect(decision.verdict).toBe('version_killed');
    expect(decision.mustUpgrade).toBe(true);
    expect(decision.targetVersion).toBe('1.9.0'); // moved BACK, not forward
    // The rule that matters: it keeps trading until it is between baskets.
    expect(decision.mayTrade).toBe(true);
    expect(decision.deferUntilIdle).toBe(true);
  });

  it('refuses an unregistered, blocked or compromised device', () => {
    expect(evaluateDevice(undefined, POLICY).verdict).toBe('unregistered');
    expect(evaluateDevice(undefined, POLICY).detail).toContain('nobody is accountable for');
    expect(evaluateDevice(device({ status: 'blocked' }), POLICY).mayTrade).toBe(false);
    expect(evaluateDevice(device({ status: 'retired' }), POLICY).mayTrade).toBe(false);
    const rooted = evaluateDevice(device({ integrityCompromised: true }), POLICY);
    expect(rooted.verdict).toBe('integrity_failed');
    expect(rooted.mayTrade).toBe(false);
  });

  it('refuses a device that will not say what it is running', () => {
    const decision = evaluateDevice(device({ appVersion: undefined }), POLICY);
    expect(decision.verdict).toBe('no_version_reported');
    expect(decision.mayTrade).toBe(false);
  });
});

describe('validateVersionPolicy — refuse the config change that strands the fleet', () => {
  it('accepts a safe policy', () => {
    expect(validateVersionPolicy(POLICY).currentVersion).toBe('1.10.0');
  });

  it('refuses a minimum newer than the current version — nothing could trade', () => {
    expect(() =>
      validateVersionPolicy({ ...POLICY, minimumSupportedVersion: '2.0.0' }),
    ).toThrow(UnsafeVersionPolicyError);
  });

  it('refuses a minimum that cuts off the previous version — that is the rollback path', () => {
    // The commonest way to cause an outage with a config change.
    expect(() =>
      validateVersionPolicy({ ...POLICY, minimumSupportedVersion: '1.10.0' }),
    ).toThrow(/removes the rollback path/);
  });

  it('refuses killing the version everything is meant to move to', () => {
    expect(() =>
      validateVersionPolicy({ ...POLICY, killedVersions: ['1.10.0'] }),
    ).toThrow(/nothing to move devices on to/);
  });

  it('refuses a "previous" that is not older than the current', () => {
    expect(() =>
      validateVersionPolicy({ ...POLICY, previousVersion: '1.11.0' }),
    ).toThrow(/not older/);
  });
});

describe('fleetSummary — silence is a signal, not health', () => {
  it('counts what trades, what is blocked, and what has gone quiet', () => {
    const summary = fleetSummary(
      [
        device({ deviceId: 'till-1' }),
        device({ deviceId: 'till-2', appVersion: '1.9.0' }),
        device({ deviceId: 'till-3', appVersion: '1.2.0' }),
        device({ deviceId: 'till-4', lastSeenAt: '2026-08-04T06:00:00Z' }),
      ],
      POLICY,
      NOW,
    );
    expect(summary.total).toBe(4);
    expect(summary.trading).toBe(3);
    expect(summary.blocked).toBe(1);
    expect(summary.mustUpgrade).toBe(1);
    expect(summary.silent).toEqual(['till-4']); // 4 hours quiet
    expect(summary.byVersion).toEqual({ '1.10.0': 2, '1.9.0': 1, '1.2.0': 1 });
  });

  it('treats a device that never reported as silent', () => {
    const summary = fleetSummary([device({ lastSeenAt: undefined })], POLICY, NOW);
    expect(summary.silent).toEqual(['till-3']);
  });
});
