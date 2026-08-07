// Named user accounts and session policy (M02-FR-01 / SEC-03 / hard rule #4).
//
// Every action in this system has to be attributable to a real person. That single
// requirement is what makes the audit trail worth having — a trail that says
// "cashier1 approved the refund" when eleven people know that password proves
// nothing at all. Shared logins are the top audit finding in retail (A-17), and they
// never arrive as a decision. They arrive as a convenience: one account for the
// evening shift, one for the new starter until IT sets them up, one called "manager"
// that nobody wants to be the one to remove.
//
// So a generic account cannot be CREATED here, not merely discouraged:
//
//   • an account must belong to a named person with their own contact identity;
//   • usernames that are obviously roles rather than people — "cashier", "manager",
//     "admin", "till2", "temp" — are refused with the reason;
//   • two accounts cannot share a contact identity, because that is a shared login
//     wearing two names.
//
// This module holds NO CREDENTIALS. There is deliberately no password field, no
// hash, no token — credential storage belongs to the identity provider chosen at
// deployment, and a password that never enters this codebase can never be logged by
// it (SEC-04, hard rule #4). What lives here is the policy: who exists, what state
// they are in, and when a session must end.
//
// Pure and deterministic: the timestamp is injected, there is no clock.

export type AccountStatus = 'invited' | 'active' | 'suspended' | 'locked' | 'closed';

/** Identity of a real person — the whole point of a named account. */
export interface PersonIdentity {
  readonly fullName: string;
  /** A contact only this person controls: their own email or mobile. */
  readonly contact: string;
  /** Employee number or equivalent, where the tenant keeps one. */
  readonly employeeRef?: string;
}

export interface UserAccount {
  readonly userId: string;
  readonly tenantId: string;
  readonly username: string;
  readonly person: PersonIdentity;
  readonly status: AccountStatus;
  /** True once the person has enrolled a second factor or a passkey. */
  readonly mfaEnrolled?: boolean;
  /** True when the account holds privileges that require MFA (SEC-03). */
  readonly privileged?: boolean;
  /** ISO-8601 UTC of the last successful sign-in — feeds the access review. */
  readonly lastLoginAt?: string;
  /** Consecutive failed attempts since the last success. */
  readonly failedAttempts?: number;
}

export class SharedAccountError extends Error {
  constructor(
    public readonly username: string,
    public readonly why: string,
  ) {
    super(`"${username}" cannot be created: ${why} (hard rule #4 — no shared logins)`);
    this.name = 'SharedAccountError';
  }
}

export class AccountStateError extends Error {
  constructor(
    public readonly userId: string,
    public readonly status: AccountStatus,
    action: string,
  ) {
    super(`User "${userId}" is ${status} and cannot ${action}`);
    this.name = 'AccountStateError';
  }
}

export class MfaRequiredError extends Error {
  constructor(public readonly userId: string) {
    super(
      `User "${userId}" holds privileged access and must enrol a second factor or passkey first (SEC-03)`,
    );
    this.name = 'MfaRequiredError';
  }
}

/**
 * Usernames that describe a job rather than a person. Per-tenant additions are
 * supported; these are the ones that show up in every retail audit.
 */
export const GENERIC_USERNAMES: readonly string[] = [
  'admin',
  'administrator',
  'cashier',
  'counter',
  'manager',
  'store',
  'staff',
  'user',
  'pos',
  'till',
  'temp',
  'test',
  'guest',
  'shared',
  'common',
  'billing',
  'supervisor',
  'operator',
];

function looksGeneric(username: string, extra: readonly string[]): boolean {
  const normalised = username.toLowerCase().replace(/[^a-z]/g, '');
  return [...GENERIC_USERNAMES, ...extra].some((generic) => normalised === generic);
}

/**
 * Create a named account. Refuses anything that is really a shared login — the
 * acceptance test for M02-FR-01 and the standing guardrail.
 */
export function createAccount(
  account: UserAccount,
  existing: readonly UserAccount[] = [],
  extraGenericNames: readonly string[] = [],
): UserAccount {
  if (account.person.fullName.trim() === '') {
    throw new SharedAccountError(account.username, 'it names no person');
  }
  if (account.person.contact.trim() === '') {
    throw new SharedAccountError(
      account.username,
      'it has no personal contact, so nobody can be reached or held responsible',
    );
  }
  if (looksGeneric(account.username, extraGenericNames)) {
    throw new SharedAccountError(
      account.username,
      'that is a job title, not a person — every action must be attributable to someone by name',
    );
  }
  const clash = existing.find(
    (a) =>
      a.tenantId === account.tenantId &&
      a.userId !== account.userId &&
      a.status !== 'closed' &&
      a.person.contact.trim().toLowerCase() === account.person.contact.trim().toLowerCase(),
  );
  if (clash) {
    throw new SharedAccountError(
      account.username,
      `"${clash.username}" already uses that contact — a second account on one identity is a shared login wearing two names`,
    );
  }
  const duplicateName = existing.find(
    (a) =>
      a.tenantId === account.tenantId &&
      a.userId !== account.userId &&
      a.username.toLowerCase() === account.username.toLowerCase(),
  );
  if (duplicateName) {
    throw new SharedAccountError(account.username, 'that username is already taken');
  }
  return account;
}

/** Privileged accounts cannot go active without a second factor (SEC-03). */
export function activateAccount(account: UserAccount): UserAccount {
  if (account.status === 'closed') {
    throw new AccountStateError(account.userId, account.status, 'be activated');
  }
  if (account.privileged === true && account.mfaEnrolled !== true) {
    throw new MfaRequiredError(account.userId);
  }
  return { ...account, status: 'active', failedAttempts: 0 };
}

// --- sessions ----------------------------------------------------------------

/** Per-tenant session and lockout policy — chosen, never hard-coded. */
export interface SessionPolicy {
  /** Sign out after this many minutes with no activity. */
  readonly idleTimeoutMinutes: number;
  /** Re-authenticate after this long regardless of activity. */
  readonly absoluteTimeoutMinutes: number;
  /** Lock the account after this many consecutive failures. */
  readonly lockoutAfterFailures: number;
  /** A till session is bound to its terminal (§28 "assigned terminal"). */
  readonly bindToDevice?: boolean;
  /** How long an edge may rely on a cached identity before re-checking (§31). */
  readonly offlineIdentityMaxMinutes: number;
}

export interface Session {
  readonly sessionId: string;
  readonly userId: string;
  readonly tenantId: string;
  readonly branchId: string | null;
  readonly deviceId?: string;
  readonly startedAt: string;
  readonly lastActivityAt: string;
  /** True when it was established from a cached identity at the edge (§31). */
  readonly offline?: boolean;
  readonly endedAt?: string;
  readonly endedReason?: SessionEndReason;
}

export type SessionEndReason =
  | 'signed_out'
  | 'idle_timeout'
  | 'absolute_timeout'
  | 'revoked'
  | 'device_mismatch'
  | 'offline_identity_expired';

export interface SessionCheck {
  readonly valid: boolean;
  readonly reason?: SessionEndReason;
  readonly detail: string;
}

function minutesBetween(from: string, to: string): number {
  return (Date.parse(to) - Date.parse(from)) / 60_000;
}

/**
 * Is this session still good? Checked against the clock the caller supplies, so the
 * rule is testable without waiting and identical at the edge and in the cloud.
 */
export function checkSession(
  session: Session,
  policy: SessionPolicy,
  now: string,
  presentedDeviceId?: string,
): SessionCheck {
  if (session.endedAt !== undefined) {
    return { valid: false, reason: session.endedReason ?? 'signed_out', detail: 'the session has ended' };
  }
  if (policy.bindToDevice === true && session.deviceId !== undefined) {
    if (presentedDeviceId !== undefined && presentedDeviceId !== session.deviceId) {
      // A session that moves terminal is either a mistake or a stolen token.
      return {
        valid: false,
        reason: 'device_mismatch',
        detail: `the session belongs to ${session.deviceId}, not ${presentedDeviceId}`,
      };
    }
  }
  if (session.offline === true && minutesBetween(session.startedAt, now) > policy.offlineIdentityMaxMinutes) {
    return {
      valid: false,
      reason: 'offline_identity_expired',
      detail: `an offline identity is trusted for ${policy.offlineIdentityMaxMinutes} minutes, to bound the exposure`,
    };
  }
  if (minutesBetween(session.lastActivityAt, now) > policy.idleTimeoutMinutes) {
    return {
      valid: false,
      reason: 'idle_timeout',
      detail: `no activity for over ${policy.idleTimeoutMinutes} minutes`,
    };
  }
  if (minutesBetween(session.startedAt, now) > policy.absoluteTimeoutMinutes) {
    return {
      valid: false,
      reason: 'absolute_timeout',
      detail: `sessions are re-authenticated every ${policy.absoluteTimeoutMinutes} minutes`,
    };
  }
  return { valid: true, detail: 'active' };
}

/** End a session. Recorded with its reason — sessions are never simply forgotten. */
export function endSession(session: Session, reason: SessionEndReason, at: string): Session {
  return { ...session, endedAt: at, endedReason: reason };
}

/** A failed sign-in. Locks the account once the tenant's threshold is reached. */
export function recordFailedLogin(account: UserAccount, policy: SessionPolicy): UserAccount {
  const failed = (account.failedAttempts ?? 0) + 1;
  return {
    ...account,
    failedAttempts: failed,
    status: failed >= policy.lockoutAfterFailures ? 'locked' : account.status,
  };
}

/** A successful sign-in clears the counter and records the time. */
export function recordSuccessfulLogin(account: UserAccount, at: string): UserAccount {
  if (account.status !== 'active') {
    throw new AccountStateError(account.userId, account.status, 'sign in');
  }
  return { ...account, failedAttempts: 0, lastLoginAt: at };
}

export interface AccessReviewRow {
  readonly userId: string;
  readonly username: string;
  readonly fullName: string;
  readonly status: AccountStatus;
  readonly privileged: boolean;
  readonly mfaEnrolled: boolean;
  readonly lastLoginAt?: string;
  /** Days since the last sign-in; undefined when they have never signed in. */
  readonly daysSinceLogin?: number;
  /** Why this row deserves a second look — empty when nothing does. */
  readonly flags: readonly string[];
}

/**
 * The access review: who exists, what they hold, and who should probably not still
 * have it. Dormant accounts and privileged accounts without MFA are the two that
 * actually get exploited (M02-FR-01 reporting).
 */
export function accessReview(
  accounts: readonly UserAccount[],
  asOf: string,
  dormantAfterDays = 60,
): readonly AccessReviewRow[] {
  return accounts.map((account): AccessReviewRow => {
    const days =
      account.lastLoginAt === undefined
        ? undefined
        : Math.floor(minutesBetween(account.lastLoginAt, asOf) / 1_440);
    const flags: string[] = [];
    if (account.privileged === true && account.mfaEnrolled !== true) {
      flags.push('privileged without a second factor');
    }
    if (account.status === 'active' && account.lastLoginAt === undefined) {
      flags.push('active but has never signed in');
    }
    if (account.status === 'active' && days !== undefined && days >= dormantAfterDays) {
      flags.push(`dormant for ${days} days`);
    }
    if (account.status === 'locked') {
      flags.push('locked out');
    }
    return {
      userId: account.userId,
      username: account.username,
      fullName: account.person.fullName,
      status: account.status,
      privileged: account.privileged === true,
      mfaEnrolled: account.mfaEnrolled === true,
      ...(account.lastLoginAt !== undefined ? { lastLoginAt: account.lastLoginAt } : {}),
      ...(days !== undefined ? { daysSinceLogin: days } : {}),
      flags,
    };
  });
}
