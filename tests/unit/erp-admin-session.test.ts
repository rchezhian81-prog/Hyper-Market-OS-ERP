import { describe, it, expect } from 'vitest';
import {
  createAdminSession, GRANT_REFUSAL_KINDS,
  type AdminConfig, type AdminPorts,
} from '../../apps/web-erp/src/admin-session';
import type { SupportSession, Device, VersionPolicy } from '../../packages/platform-admin/src/index';
import type { UserAccount } from '../../packages/identity/src/index';
import type { AuditRecord, LegalHold, RetentionPolicy } from '../../packages/audit/src/index';

/**
 * **Admin and security (M01 · M02 · M33 · M34 · D12).**
 *
 * The design bar is three lines: least privilege by default, no shared logins, and support access
 * that is time-bound and audited — *never standing god-mode*.
 *
 * The controls under test are the ones that had never been reached:
 *
 *   • **an expired grant is not access**, decided from the clock every time it is read;
 *   • **blanket support access cannot be granted at all** — the rule the service's own copy of
 *     this control could not even express, because its request had no scopes;
 *   • a fleet with no version policy is reported as **unenforced**, not as compliant;
 *   • a shop with no retention policy is reported as **undecided**, not as nothing-to-delete;
 *   • a legal hold outranks a retention date, and nothing here deletes anything.
 */

const NOW = '2026-08-06T14:00:00.000Z';

const session = (over: Partial<SupportSession> = {}): SupportSession => ({
  sessionId: 'S-1', requesterId: 'u-eng', requesterName: 'Engineer', approvedBy: 'u-owner',
  reason: 'investigating the duplicate settlement raised in ticket 4471',
  scopes: ['read:settlements'], tenantId: 't1',
  startedAt: '2026-08-06T13:00:00.000Z', expiresAt: '2026-08-06T15:00:00.000Z',
  actions: [],
  ...over,
});

const account = (over: Partial<UserAccount> = {}): UserAccount => ({
  userId: 'u-1', tenantId: 't1', username: 'meena',
  person: { fullName: 'Meena R', email: 'meena@example.com' },
  status: 'active', privileged: false, mfaEnrolled: true,
  lastLoginAt: '2026-08-06T09:00:00.000Z',
  ...over,
} as UserAccount);

const device = (over: Partial<Device> = {}): Device => ({
  deviceId: 'D-1', tenantId: 't1', branchId: 'b1', kind: 'pos', label: 'Lane 1',
  status: 'active', appVersion: '2.0.0', lastSeenAt: NOW,
  ...over,
} as Device);

const POLICY: VersionPolicy = { currentVersion: '2.0.0', minimumSupportedVersion: '1.0.0' };

const CONFIG: AdminConfig = { tenantId: 't1', userId: 'u-admin', now: NOW, dormantAfterDays: 60 };

function ports(over: Partial<AdminPorts> = {}): AdminPorts {
  return {
    accounts: () => [account()],
    roles: () => [],
    assignments: () => [],
    supportSessions: () => [session()],
    devices: () => [device()],
    versionPolicy: () => POLICY,
    auditRecords: () => [],
    retentionPolicies: () => [],
    legalHolds: () => [],
    ...over,
  };
}

const admin = (over: Partial<AdminPorts> = {}, config: Partial<AdminConfig> = {}) =>
  createAdminSession({ ...CONFIG, ...config }, ports(over));

// ── The expiry nothing ever checked ─────────────────────────────────────────

describe('a grant that has expired is not access', () => {
  it('reports a live session as live, with the time it has left', () => {
    const view = admin().support()[0]!;
    expect(view.active).toBe(true);
    expect(view.minutesLeft).toBe(60);
  });

  it('reports an EXPIRED session as not access at all', () => {
    // Nothing in this system ever asked. A session was granted with an `expiresAt` in a response
    // body and no code anywhere read it again — standing access wearing a time limit's clothes.
    const view = admin({
      supportSessions: () => [session({ expiresAt: '2026-08-06T13:30:00.000Z' })],
    }).support()[0]!;
    expect(view.active, 'an expired grant still reads as access').toBe(false);
    expect(view.minutesLeft).toBe(0);
  });

  it('decides it from the CLOCK each time, not from a stored flag', () => {
    // A flag has to be turned off by something, and that something is exactly what did not exist.
    const grant = session({ expiresAt: '2026-08-06T14:30:00.000Z' });
    expect(admin({ supportSessions: () => [grant] }).support()[0]?.active).toBe(true);
    expect(admin({ supportSessions: () => [grant] }, { now: '2026-08-06T15:00:00.000Z' })
      .support()[0]?.active).toBe(false);
  });

  it('treats an ended session as ended even before its expiry', () => {
    const view = admin({
      supportSessions: () => [session({ endedAt: '2026-08-06T13:30:00.000Z' })],
    }).support()[0]!;
    expect(view.active).toBe(false);
  });

  it('puts live sessions at the top — a live one is the most urgent thing here', () => {
    const list = admin({
      supportSessions: () => [
        session({ sessionId: 'S-OLD', expiresAt: '2026-08-06T13:00:00.000Z' }),
        session({ sessionId: 'S-LIVE' }),
      ],
    }).support();
    expect(list[0]?.session.sessionId).toBe('S-LIVE');
    expect(list[0]?.active).toBe(true);
  });
});

// ── The rule the wired copy could not express ───────────────────────────────

describe('support access is least privilege, or it is refused', () => {
  const request = (over: Record<string, unknown> = {}) => ({
    requestId: 'R-1', requesterId: 'u-eng', requesterName: 'Engineer',
    reason: 'investigating the duplicate settlement raised in ticket 4471',
    scopes: ['read:settlements'], tenantId: 't1', minutes: 60, at: NOW,
    ...over,
  }) as never;
  const approval = (over: Record<string, unknown> = {}) =>
    ({ subjectRef: 'R-1', status: 'approved', decidedBy: 'u-owner', ...over }) as never;

  it('grants a scoped, approved, time-bound session', () => {
    const outcome = admin().grant({ request: request(), approval: approval() });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.session.scopes).toEqual(['read:settlements']);
    expect(outcome.view.active).toBe(true);
  });

  it('REFUSES blanket access — the rule the API path could not even state', () => {
    // The copy wired to the API had no `scopes` field at all, so least privilege could not be
    // expressed, let alone enforced.
    const outcome = admin().grant({ request: request({ scopes: [] }), approval: approval() });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('refused_by_policy');
    expect(outcome.detail).toContain('never blanket admin');
  });

  it('refuses an approval that tries to LENGTHEN the window that was asked for', () => {
    const outcome = admin().grant({
      request: request({ minutes: 30 }), approval: approval({ grantedMinutes: 240 }),
    });
    if (outcome.ok) return;
    expect(outcome.detail).toContain('never extend it');
  });

  it('refuses a self-approval', () => {
    const outcome = admin().grant({ request: request(), approval: approval({ decidedBy: 'u-eng' }) });
    if (outcome.ok) return;
    expect(outcome.detail).toContain('cannot approve their own');
  });

  it('refuses a reason that says nothing', () => {
    const outcome = admin().grant({ request: request({ reason: 'investigate' }), approval: approval() });
    if (outcome.ok) return;
    expect(outcome.detail).toContain('not a reason');
  });

  it('refuses with no approval at all', () => {
    const outcome = admin().grant({ request: request() });
    if (outcome.ok) return;
    expect(outcome.detail).toContain('has not approved');
  });

  it('grants nothing when the box does not know who is letting them in', () => {
    const outcome = admin({}, { userId: null }).grant({ request: request(), approval: approval() });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('nobody_is_named_at_this_desk');
    expect(GRANT_REFUSAL_KINDS).toHaveLength(2);
  });
});

// ── Who has access to what ──────────────────────────────────────────────────

describe('who can get in, and who should not be able to', () => {
  it('flags a privileged account with no second factor', () => {
    const rows = admin({
      accounts: () => [account({ userId: 'u-boss', privileged: true, mfaEnrolled: false })],
    }).access();
    expect(rows[0]?.flags.join(' ')).toContain('second factor');
  });

  it('flags an account that has never logged in', () => {
    const rows = admin({ accounts: () => [account({ lastLoginAt: undefined })] }).access();
    expect(rows[0]?.flags.length).toBeGreaterThan(0);
  });

  it('uses the SHOP’s own dormancy window, not a constant', () => {
    const stale = account({ lastLoginAt: '2026-06-01T09:00:00.000Z' });
    expect(admin({ accounts: () => [stale] }, { dormantAfterDays: 30 }).access()[0]?.flags.length)
      .toBeGreaterThan(0);
    expect(admin({ accounts: () => [stale] }, { dormantAfterDays: 365 }).access()[0]?.flags)
      .toEqual([]);
  });
});

// ── The fleet ───────────────────────────────────────────────────────────────

describe('the tills and handhelds this shop runs on', () => {
  it('judges each device against the shop’s own version policy', () => {
    const fleet = admin().fleet();
    expect(fleet.policyKnown).toBe(true);
    expect(fleet.verdicts).toHaveLength(1);
    expect(fleet.summary?.total).toBe(1);
  });

  it('says nothing is being ENFORCED when the shop has set no policy', () => {
    // Judging every device against a minimum version nobody set would report a fleet as
    // compliant with a rule the shop never made.
    const fleet = admin({ versionPolicy: () => undefined }).fleet();
    expect(fleet.policyKnown).toBe(false);
    expect(fleet.summary).toBeUndefined();
    expect(fleet.verdicts).toEqual([]);
  });
});

// ── Retention and legal hold ────────────────────────────────────────────────

describe('what would be deleted, and what a hold stops', () => {
  const record = (over: Partial<AuditRecord> = {}): AuditRecord => ({
    sequence: 1, previousHash: '', hash: 'h1',
    objectType: 'sale', objectId: 'S-1', at: '2020-01-01T00:00:00.000Z',
    actorId: 'u-1', action: 'sale.committed',
    ...over,
  } as unknown as AuditRecord);

  it('reports NOTHING when the shop has set no retention policy at all', () => {
    // Different from nothing being due for deletion: the first is a shop that has never decided,
    // and "nothing to delete" would be reporting a decision nobody made.
    expect(admin({ auditRecords: () => [record()] }).retention()).toBeUndefined();
  });

  it('plans against the shop’s own policy once it has one', () => {
    const plan = admin({
      auditRecords: () => [record()],
      retentionPolicies: () => [{ objectType: 'sale', retainDays: 1, basis: 'ordinary trading record' } as RetentionPolicy],
    }).retention();
    expect(plan?.decisions).toHaveLength(1);
  });

  it('a legal hold outranks an expired retention date', () => {
    const plan = admin({
      auditRecords: () => [record()],
      retentionPolicies: () => [{ objectType: 'sale', retainDays: 1, basis: 'ordinary trading record' } as RetentionPolicy],
      legalHolds: () => [{ holdId: 'H-1', objectType: 'sale', reason: 'dispute' } as unknown as LegalHold],
    }).retention();
    expect(plan?.decisions[0]?.outcome).toBe('legal_hold');
    expect(plan?.decisions[0]?.explanation).toContain('survives the retention date');
  });

  it('keeps a record whose type has no policy, because silence never means discard', () => {
    const plan = admin({
      auditRecords: () => [record({ objectType: 'something_new' })],
      retentionPolicies: () => [{ objectType: 'sale', retainDays: 1, basis: 'ordinary trading record' } as RetentionPolicy],
    }).retention();
    expect(plan?.decisions[0]?.outcome).toBe('no_policy');
  });
});
