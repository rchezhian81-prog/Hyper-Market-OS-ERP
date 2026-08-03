import { describe, it, expect } from 'vitest';
import {
  createAccount,
  activateAccount,
  checkSession,
  endSession,
  recordFailedLogin,
  recordSuccessfulLogin,
  accessReview,
  SharedAccountError,
  MfaRequiredError,
  AccountStateError,
  type Session,
  type SessionPolicy,
  type UserAccount,
} from '../../packages/identity/src/index';

// M02-FR-01 — every action must be attributable to a real person. Shared logins are
// the top audit finding in retail (A-17), and they never arrive as a decision: they
// arrive as a convenience.

const POLICY: SessionPolicy = {
  idleTimeoutMinutes: 15,
  absoluteTimeoutMinutes: 600,
  lockoutAfterFailures: 5,
  bindToDevice: true,
  offlineIdentityMaxMinutes: 720,
};

function account(over: Partial<UserAccount> = {}): UserAccount {
  return {
    userId: 'u1',
    tenantId: 't1',
    username: 'priya.s',
    person: { fullName: 'Priya S', contact: 'priya@example.com', employeeRef: 'E-101' },
    status: 'invited',
    ...over,
  };
}

describe('createAccount — a generic account cannot be created (acceptance)', () => {
  it('creates a named account for a real person', () => {
    expect(createAccount(account()).username).toBe('priya.s');
  });

  it('refuses a username that is a job title rather than a person', () => {
    for (const username of ['cashier', 'MANAGER', 'till2', 'admin', 'pos_1', 'temp']) {
      expect(() => createAccount(account({ username }))).toThrow(SharedAccountError);
    }
    expect(() => createAccount(account({ username: 'cashier' }))).toThrow(/job title, not a person/);
  });

  it('refuses an account that names nobody or has no personal contact', () => {
    expect(() =>
      createAccount(account({ person: { fullName: '  ', contact: 'x@example.com' } })),
    ).toThrow(/names no person/);
    expect(() =>
      createAccount(account({ person: { fullName: 'Priya S', contact: '' } })),
    ).toThrow(/nobody can be reached or held responsible/);
  });

  it('refuses a second account on one person’s contact — a shared login in disguise', () => {
    const existing = [account({ userId: 'u1', username: 'priya.s' })];
    expect(() =>
      createAccount(
        account({ userId: 'u2', username: 'priya.evening', person: { fullName: 'Evening shift', contact: 'PRIYA@example.com' } }),
        existing,
      ),
    ).toThrow(/shared login wearing two names/);
  });

  it('refuses a duplicate username, and allows a tenant to add its own banned names', () => {
    expect(() =>
      createAccount(
        // A different person, genuinely — so it is the username that clashes.
        account({ userId: 'u2', person: { fullName: 'Priya Second', contact: 'priya2@example.com' } }),
        [account({ userId: 'u1' })],
      ),
    ).toThrow(/already taken/);
    expect(() => createAccount(account({ username: 'frontdesk' }), [], ['frontdesk'])).toThrow(
      SharedAccountError,
    );
  });

  it('lets a closed account’s contact be reused by a genuine new person', () => {
    const closed = [account({ userId: 'u1', status: 'closed' })];
    expect(() =>
      createAccount(account({ userId: 'u2', username: 'priya.new' }), closed),
    ).not.toThrow();
  });

  it('holds no credential field anywhere — nothing to log by accident (hard rule #4)', () => {
    const created = createAccount(account()) as unknown as Record<string, unknown>;
    for (const forbidden of ['password', 'passwordHash', 'secret', 'token', 'pin']) {
      expect(created[forbidden]).toBeUndefined();
    }
  });
});

describe('activateAccount — MFA before privilege (SEC-03)', () => {
  it('activates an ordinary account', () => {
    expect(activateAccount(account()).status).toBe('active');
  });

  it('refuses to activate a privileged account with no second factor', () => {
    expect(() => activateAccount(account({ privileged: true }))).toThrow(MfaRequiredError);
    expect(activateAccount(account({ privileged: true, mfaEnrolled: true })).status).toBe('active');
  });

  it('never reactivates a closed account', () => {
    expect(() => activateAccount(account({ status: 'closed' }))).toThrow(AccountStateError);
  });
});

describe('sessions — expiry, device binding and the offline lane (§31)', () => {
  const START = '2026-08-03T09:00:00Z';

  function session(over: Partial<Session> = {}): Session {
    return {
      sessionId: 's1',
      userId: 'u1',
      tenantId: 't1',
      branchId: 'b1',
      deviceId: 'till-3',
      startedAt: START,
      lastActivityAt: START,
      ...over,
    };
  }

  it('stays valid while it is being used', () => {
    expect(checkSession(session({ lastActivityAt: '2026-08-03T09:10:00Z' }), POLICY, '2026-08-03T09:14:00Z').valid).toBe(true);
  });

  it('expires on inactivity, and again on the absolute limit', () => {
    const idle = checkSession(session(), POLICY, '2026-08-03T09:20:00Z');
    expect(idle.valid).toBe(false);
    expect(idle.reason).toBe('idle_timeout');

    const long = checkSession(
      session({ lastActivityAt: '2026-08-03T19:05:00Z' }),
      POLICY,
      '2026-08-03T19:10:00Z',
    );
    expect(long.reason).toBe('absolute_timeout');
  });

  it('refuses a session presented from another terminal (§28)', () => {
    const moved = checkSession(session(), POLICY, '2026-08-03T09:05:00Z', 'till-7');
    expect(moved.valid).toBe(false);
    expect(moved.reason).toBe('device_mismatch');
    expect(checkSession(session(), POLICY, '2026-08-03T09:05:00Z', 'till-3').valid).toBe(true);
  });

  it('trusts a cached offline identity, but only for a bounded time', () => {
    const offline = session({ offline: true });
    expect(checkSession(offline, POLICY, '2026-08-03T09:05:00Z').valid).toBe(true);
    const stale = checkSession(
      { ...offline, lastActivityAt: '2026-08-03T21:10:00Z' },
      POLICY,
      '2026-08-03T21:15:00Z',
    );
    expect(stale.reason).toBe('offline_identity_expired');
    expect(stale.detail).toContain('bound the exposure');
  });

  it('records why a session ended — sessions are never simply forgotten', () => {
    const ended = endSession(session(), 'revoked', '2026-08-03T10:00:00Z');
    expect(ended.endedReason).toBe('revoked');
    expect(checkSession(ended, POLICY, '2026-08-03T10:01:00Z')).toEqual({
      valid: false,
      reason: 'revoked',
      detail: 'the session has ended',
    });
  });
});

describe('lockout and the access review', () => {
  it('locks the account after the tenant’s number of failures', () => {
    let user = activateAccount(account());
    for (let i = 0; i < 4; i += 1) user = recordFailedLogin(user, POLICY);
    expect(user.status).toBe('active');
    expect(user.failedAttempts).toBe(4);

    user = recordFailedLogin(user, POLICY);
    expect(user.status).toBe('locked');
    expect(() => recordSuccessfulLogin(user, '2026-08-03T10:00:00Z')).toThrow(AccountStateError);
  });

  it('a success clears the counter and records the time', () => {
    const user = recordSuccessfulLogin(
      { ...activateAccount(account()), failedAttempts: 3 },
      '2026-08-03T10:00:00Z',
    );
    expect(user.failedAttempts).toBe(0);
    expect(user.lastLoginAt).toBe('2026-08-03T10:00:00Z');
  });

  it('flags the two things that actually get exploited', () => {
    const rows = accessReview(
      [
        account({ userId: 'u1', status: 'active', privileged: true, mfaEnrolled: false, lastLoginAt: '2026-08-02T10:00:00Z' }),
        account({ userId: 'u2', username: 'old.hand', status: 'active', lastLoginAt: '2026-05-01T10:00:00Z' }),
        account({ userId: 'u3', username: 'never.used', status: 'active' }),
        account({ userId: 'u4', username: 'fine.person', status: 'active', lastLoginAt: '2026-08-03T08:00:00Z' }),
      ],
      '2026-08-03T10:00:00Z',
    );
    expect(rows[0]?.flags).toEqual(['privileged without a second factor']);
    expect(rows[1]?.flags[0]).toContain('dormant for 94 days');
    expect(rows[2]?.flags).toEqual(['active but has never signed in']);
    expect(rows[3]?.flags).toEqual([]);
    expect(rows[3]?.daysSinceLogin).toBe(0);
  });
});
