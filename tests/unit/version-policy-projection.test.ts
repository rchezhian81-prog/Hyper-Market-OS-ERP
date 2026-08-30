import { describe, it, expect } from 'vitest';
import { projectVersionPolicy, type VersionPolicyEvent } from '../../services/platform/src/version-policy';
import type { VersionPolicy } from '../../packages/platform-admin/src/devices';

// The version-policy fold (M33 remote kill): the latest set wins; none set yet reads as undefined.

const ev = (policy: VersionPolicy, at: string): VersionPolicyEvent => ({ policy, by: 'u-owner', at });

describe('projectVersionPolicy', () => {
  it('reads as undefined when nothing has ever been set — not-set is not an empty policy', () => {
    expect(projectVersionPolicy([])).toBeUndefined();
  });

  it('returns the only policy when one is set', () => {
    const p: VersionPolicy = { currentVersion: '2.0.0', minimumSupportedVersion: '1.9.0' };
    expect(projectVersionPolicy([ev(p, '2026-08-30T05:00:00Z')])).toEqual(p);
  });

  it('the latest set wins — a later change supersedes an earlier one', () => {
    const first: VersionPolicy = { currentVersion: '2.0.0', minimumSupportedVersion: '1.9.0' };
    const second: VersionPolicy = { currentVersion: '2.1.0', previousVersion: '2.0.0', minimumSupportedVersion: '2.0.0', killedVersions: ['1.9.9'] };
    expect(projectVersionPolicy([ev(first, '2026-08-30T05:00:00Z'), ev(second, '2026-08-30T06:00:00Z')])).toEqual(second);
  });

  it('carries the withdrawn (killed) list through the fold', () => {
    const p: VersionPolicy = { currentVersion: '2.1.0', previousVersion: '2.0.0', minimumSupportedVersion: '2.0.0', killedVersions: ['2.0.5', '2.0.6'] };
    expect(projectVersionPolicy([ev(p, '2026-08-30T07:00:00Z')])?.killedVersions).toEqual(['2.0.5', '2.0.6']);
  });
});
