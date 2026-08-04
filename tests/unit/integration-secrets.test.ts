import { describe, it, expect } from 'vitest';
import * as integration from '../../packages/integration/src/index';
import {
  reviewSecrets,
  rotateSecret,
  revokeSecret,
  findUsageSignals,
  type SecretRef,
  type UsageWindow,
} from '../../packages/integration/src/secrets';

// M32-FR-03 acceptance: "no secret appears in the repository (guardrail + secret-scan in CI);
// a credential can be rotated and revoked; sandbox lets a partner integrate without
// production data."

const secret = (over: Partial<SecretRef>): SecretRef => ({
  secretId: 's-pay',
  kind: 'payment_provider',
  vaultRef: 'vault://payments/live#v4',
  version: 4,
  state: 'active',
  createdOn: '2026-01-01',
  owner: 'u-sivakumar',
  protects: 'card payments at every till',
  lastRotatedOn: '2026-07-01',
  rotateEveryDays: 90,
  environment: 'production',
  ...over,
});

describe('this module can only ever hold a REFERENCE, never a secret (hard rule #4)', () => {
  it('exposes nothing that could carry secret material', () => {
    // Absence as a control. Once a secret CAN sit in a variable it will eventually sit in
    // a log line, and a log line is copied into a ticket, a screenshot, a chat.
    const named = Object.keys(integration);
    for (const forbidden of ['revealSecret', 'getSecretValue', 'decryptSecret', 'plaintextFor', 'readVault']) {
      expect(named).not.toContain(forbidden);
    }
  });

  it('carries a vault pointer on every secret it describes', () => {
    expect(secret({}).vaultRef.startsWith('vault://')).toBe(true);
    expect(Object.keys(secret({}))).not.toContain('value');
  });
});

describe('a secret is reported by WHAT IT PROTECTS (M32-FR-03)', () => {
  it('is quiet when everything is owned and current', () => {
    const r = reviewSecrets({ secrets: [secret({})], asAt: '2026-08-04' });
    expect(r.issues).toEqual([]);
  });

  it('names what an overdue rotation puts at risk', () => {
    const r = reviewSecrets({ secrets: [secret({ lastRotatedOn: '2026-01-01' })], asAt: '2026-08-04' });
    expect(r.issues[0]?.finding).toBe('overdue_rotation');
    expect(r.issues[0]?.daysOverdue).toBe(125);
    // "Secret 14 is 400 days old" gets scrolled past. This does not.
    expect(r.issues[0]?.detail).toContain('card payments at every till');
  });

  it('catches one that was never rotated at all', () => {
    const r = reviewSecrets({ secrets: [secret({ lastRotatedOn: undefined, createdOn: '2025-01-01' })], asAt: '2026-08-04' });
    expect(r.issues[0]?.finding).toBe('never_rotated');
  });

  it('warns before the due date', () => {
    const r = reviewSecrets({ secrets: [secret({ lastRotatedOn: '2026-05-15' })], asAt: '2026-08-04' });
    expect(r.issues[0]?.finding).toBe('rotation_due_soon');
  });

  it('flags an unowned secret — nobody\'s job to rotate', () => {
    const r = reviewSecrets({ secrets: [secret({ owner: '  ' })], asAt: '2026-08-04' });
    expect(r.issues.some((i) => i.finding === 'no_owner')).toBe(true);
  });

  it('BLOCKS on a revoked secret a live adapter still points at', () => {
    const r = reviewSecrets({
      secrets: [secret({ state: 'revoked', revokedOn: '2026-08-01' })],
      referencedBy: [{ adapterId: 'adp-razorpay', vaultRef: 'vault://payments/live#v4', environment: 'production' }],
      asAt: '2026-08-04',
    });
    expect(r.issues[0]?.finding).toBe('revoked_still_referenced');
    expect(r.issues[0]?.blocking).toBe(true);
    expect(r.issues[0]?.detail).toContain('everybody believes the rotation was finished');
  });

  it('BLOCKS a sandbox credential wired into production', () => {
    const r = reviewSecrets({
      secrets: [secret({ environment: 'sandbox', vaultRef: 'vault://payments/test#v1' })],
      referencedBy: [{ adapterId: 'adp-razorpay', vaultRef: 'vault://payments/test#v1', environment: 'production' }],
      asAt: '2026-08-04',
    });
    const issue = r.issues.find((i) => i.finding === 'sandbox_in_production');
    expect(issue?.blocking).toBe(true);
    expect(issue?.detail).toContain('not doing what anybody thinks it is');
  });

  it('puts the things that WILL fail above the things that merely should be tidied', () => {
    const r = reviewSecrets({
      secrets: [
        secret({ secretId: 's-old', lastRotatedOn: '2025-01-01' }),
        secret({ secretId: 's-dead', state: 'revoked' }),
      ],
      referencedBy: [{ adapterId: 'adp-x', vaultRef: 'vault://payments/live#v4', environment: 'production' }],
      asAt: '2026-08-04',
    });
    expect(r.issues[0]?.finding).toBe('revoked_still_referenced');
    expect(r.detail).toContain('WILL fail');
  });
});

describe('rotation OVERLAPS; revocation does not (§19.1)', () => {
  it('leaves the previous version valid so unsynced edge devices keep working', () => {
    const r = rotateSecret({
      secret: secret({}), newVaultRef: 'vault://payments/live#v5',
      rotatedBy: 'u-sivakumar', graceDays: 7, at: '2026-08-04T09:00:00Z',
    });
    expect(r.rotated).toBe(true);
    expect(r.next?.version).toBe(5);
    expect(r.next?.state).toBe('active');
    // Superseded, not revoked. That distinction is the whole point.
    expect(r.previous?.state).toBe('superseded');
    expect(r.oldValidUntil).toBe('2026-08-11');
    expect(r.detail).toContain('edge devices that have not synced keep working');
  });

  it('REFUSES a rotation with no overlap and points at revocation instead', () => {
    const r = rotateSecret({
      secret: secret({}), newVaultRef: 'vault://payments/live#v5',
      rotatedBy: 'u-sivakumar', graceDays: 0, at: '2026-08-04T09:00:00Z',
    });
    expect(r.rotated).toBe(false);
    expect(r.outcome).toBe('no_grace_on_rotation');
    expect(r.detail).toContain('accept the breakage deliberately');
  });

  it('refuses a rotation that does not change the reference, or one on a dead secret', () => {
    expect(rotateSecret({
      secret: secret({}), newVaultRef: 'vault://payments/live#v4',
      rotatedBy: 'u-x', graceDays: 7, at: '2026-08-04T09:00:00Z',
    }).outcome).toBe('same_ref');

    expect(rotateSecret({
      secret: secret({ state: 'revoked' }), newVaultRef: 'vault://payments/live#v5',
      rotatedBy: 'u-x', graceDays: 7, at: '2026-08-04T09:00:00Z',
    }).outcome).toBe('not_active');
  });

  it('revokes immediately and NAMES what stops working before it stops', () => {
    const r = revokeSecret({
      secret: secret({}), reason: 'key posted in a support ticket', revokedBy: 'u-security',
      referencedBy: [
        { adapterId: 'adp-razorpay', vaultRef: 'vault://payments/live#v4' },
        { adapterId: 'adp-upi', vaultRef: 'vault://payments/live#v4' },
        { adapterId: 'adp-tally', vaultRef: 'vault://accounting/live#v2' },
      ],
      at: '2026-08-04T09:00:00Z',
    });
    expect(r.revoked.state).toBe('revoked');
    expect(r.breaks).toEqual(['adp-razorpay', 'adp-upi']);
    // The difference between a controlled incident and a morning of confusion.
    expect(r.detail).toContain('STOP WORKING NOW');
    expect(r.detail).toContain('better paid knowingly');
  });

  it('says plainly when nothing is pointing at a revoked secret', () => {
    const r = revokeSecret({
      secret: secret({}), reason: 'no longer used', revokedBy: 'u-security', at: '2026-08-04T09:00:00Z',
    });
    expect(r.breaks).toEqual([]);
    expect(r.detail).toContain('Nothing is currently pointing at it');
  });
});

describe('unusual usage is SURFACED, never auto-blocked', () => {
  const usage = (over: Partial<UsageWindow>): UsageWindow => ({
    identityId: 'svc-partner-a', api: 'API-06 customer', calls: 100, errors: 0,
    onDate: '2026-08-04', ...over,
  });

  it('never takes an action', () => {
    const findings = findUsageSignals({
      current: [usage({ calls: 5_000 })], baseline: [usage({ calls: 100, onDate: '2026-07-28' })],
    });
    // Revoking on a spike kills a payment integration mid-sale, and the spike is
    // usually a promotion.
    expect(findings.every((f) => f.actionTaken === false)).toBe(true);
    expect(findings[0]?.signal).toBe('spike');
    expect(findings[0]?.detail).toContain('NOT blocked');
  });

  it('says nothing about ordinary variation', () => {
    const findings = findUsageSignals({
      current: [usage({ calls: 140 })], baseline: [usage({ calls: 100, onDate: '2026-07-28' })],
    });
    expect(findings).toEqual([]);
  });

  it('notices an integration that WENT QUIET — the alert that never fires', () => {
    const findings = findUsageSignals({
      current: [], baseline: [usage({ calls: 500, onDate: '2026-07-28' })],
    });
    expect(findings[0]?.signal).toBe('silent');
    expect(findings[0]?.detail).toContain('nobody reports the alert that never fires');
  });

  it('notices a caller with no history', () => {
    const findings = findUsageSignals({ current: [usage({ identityId: 'svc-new' })], baseline: [] });
    expect(findings[0]?.signal).toBe('new_caller');
  });

  it('flags an error surge', () => {
    const findings = findUsageSignals({
      current: [usage({ calls: 100, errors: 40 })],
      baseline: [usage({ calls: 100, onDate: '2026-07-28' })],
    });
    expect(findings.some((f) => f.signal === 'error_surge')).toBe(true);
  });
});
