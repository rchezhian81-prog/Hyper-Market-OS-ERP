// Joiner, mover, leaver and emergency access (M02-FR-04 / SEC-11).
//
// Access has to track employment reality, and the gap between the two is where
// fraud lives. Two specific failures cause most of it, and both are addressed here
// as rules rather than as reminders:
//
//   1. THE MOVER WHO ACCUMULATES. Someone transfers from the Fresh counter to the
//      cash office and keeps both. Six months later they can raise a stock
//      adjustment AND settle the till it hides in. Nobody granted that combination —
//      it assembled itself. So a move REPLACES scope; it never adds to it.
//
//   2. THE LEAVER WHO LINGERS. The account is disabled "later", the sessions stay
//      open, and the items they owned — an unapproved purchase order, an open
//      exception — belong to nobody. So a leaver's sessions are closed in the same
//      act as the revocation, and OWNED OPEN ITEMS MUST BE REASSIGNED FIRST. A
//      leaver whose work has no new owner is not finished; it is abandoned.
//
// Emergency access is the third: real, necessary, and the one that quietly becomes
// permanent. So it is TIME-BOUND AT THE MOMENT IT IS GRANTED, expires on its own,
// and cannot be extended silently — an extension is a new grant with a new approval,
// which means it shows up in the review (SEC-11: no perpetual support access).
//
// Revocation is a PRIORITY sync item — an ex-employee's access must not wait behind
// a queue of sales to reach the store (§31).
//
// Pure and deterministic: the timestamp is injected, there is no clock.

export type LifecycleEvent = 'joiner' | 'mover' | 'leaver';

export interface AccessGrant {
  readonly userId: string;
  readonly roleId: string;
  /** Branches this role applies in; 'all' is company-wide. */
  readonly branchScope: readonly string[] | 'all';
}

export interface LifecycleRequest {
  readonly requestId: string;
  readonly event: LifecycleEvent;
  readonly userId: string;
  readonly requestedBy: string;
  readonly reason: string;
  readonly at: string;
  /** For a joiner or a mover: the access they should hold AFTER the change. */
  readonly grants?: readonly AccessGrant[];
}

export interface LifecycleApproval {
  readonly subjectRef: string;
  readonly status: 'approved' | 'rejected' | 'pending';
  readonly decidedBy: string;
}

/** Something the person owns that would be orphaned by their departure. */
export interface OwnedItem {
  readonly itemId: string;
  readonly kind: string;
  readonly description: string;
}

export interface LifecycleResult {
  readonly requestId: string;
  readonly event: LifecycleEvent;
  readonly userId: string;
  readonly applied: boolean;
  /** The access held after the change — for a leaver, always empty. */
  readonly grants: readonly AccessGrant[];
  /** Grants that were removed by this change. */
  readonly removed: readonly AccessGrant[];
  /** Sessions to close as part of the same act. */
  readonly closeSessions: boolean;
  /** True when revocation must jump the sync queue (§31). */
  readonly prioritySync: boolean;
  readonly blockers: readonly string[];
  readonly at: string;
}

export class SelfServiceAccessError extends Error {
  constructor(public readonly requestId: string) {
    super(
      `Request "${requestId}" cannot be granted by the person who asked for it (§28) — access changes need a second person`,
    );
    this.name = 'SelfServiceAccessError';
  }
}

function key(grant: AccessGrant): string {
  return `${grant.roleId}:${grant.branchScope === 'all' ? 'all' : [...grant.branchScope].sort().join(',')}`;
}

/**
 * Apply a joiner, mover or leaver. Returns what the person holds afterwards, what
 * was taken away, and whether sessions must close — it decides, the caller applies.
 */
export function applyLifecycle(input: {
  readonly request: LifecycleRequest;
  readonly currentGrants: readonly AccessGrant[];
  readonly approval?: LifecycleApproval;
  /** Open items the person owns — checked for a leaver. */
  readonly ownedOpenItems?: readonly OwnedItem[];
}): LifecycleResult {
  const { request, currentGrants, approval } = input;
  const blockers: string[] = [];

  if (request.reason.trim() === '') {
    blockers.push('no reason was given for the access change');
  }
  if (approval === undefined || approval.status !== 'approved') {
    blockers.push('an access change needs a second person’s approval (§28)');
  } else if (approval.subjectRef !== request.requestId) {
    blockers.push('the approval is for a different request');
  } else if (approval.decidedBy === request.requestedBy) {
    throw new SelfServiceAccessError(request.requestId);
  }

  const base = {
    requestId: request.requestId,
    event: request.event,
    userId: request.userId,
    at: request.at,
  };

  if (request.event === 'leaver') {
    const owned = input.ownedOpenItems ?? [];
    if (owned.length > 0) {
      // Not pedantry: an unapproved purchase order owned by nobody never gets
      // approved, and an exception owned by nobody never gets explained.
      blockers.push(
        `${owned.length} open item(s) still owned by this person must be reassigned first: ${owned
          .map((i) => `${i.kind} ${i.itemId}`)
          .join(', ')}`,
      );
    }
    const applied = blockers.length === 0;
    return {
      ...base,
      applied,
      grants: applied ? [] : currentGrants,
      removed: applied ? currentGrants : [],
      closeSessions: applied,
      prioritySync: applied,
      blockers,
      at: request.at,
    };
  }

  const target = request.grants ?? [];
  if (target.length === 0) {
    blockers.push(`a ${request.event} must say what access the person should hold`);
  }

  const applied = blockers.length === 0;
  if (!applied) {
    return {
      ...base,
      applied: false,
      grants: currentGrants,
      removed: [],
      closeSessions: false,
      prioritySync: false,
      blockers,
      at: request.at,
    };
  }

  // A mover REPLACES their scope. Old branches and roles are removed in the same
  // act, so nobody ever holds the union of where they used to be and where they are.
  const targetKeys = new Set(target.map(key));
  const removed = currentGrants.filter((g) => !targetKeys.has(key(g)));

  return {
    ...base,
    applied: true,
    grants: target,
    removed,
    // A mover's sessions close so the new scope takes effect immediately rather
    // than at whatever moment their current session happens to end.
    closeSessions: request.event === 'mover' && removed.length > 0,
    prioritySync: removed.length > 0,
    blockers: [],
    at: request.at,
  };
}

// --- emergency access ---------------------------------------------------------

export interface EmergencyRequest {
  readonly grantId: string;
  readonly userId: string;
  readonly requestedBy: string;
  /** What they need and why — reviewed afterwards, so it must be specific. */
  readonly reason: string;
  readonly roleId: string;
  readonly branchScope: readonly string[] | 'all';
  readonly at: string;
  /** How long it is needed for. Bounded by policy. */
  readonly minutes: number;
}

export interface EmergencyPolicy {
  /** The longest a single emergency grant may run. */
  readonly maxMinutes: number;
  /** Emergency access always needs the owner (or a named approver role). */
  readonly requiresApprovalBy: string;
}

export interface EmergencyGrant {
  readonly grantId: string;
  readonly userId: string;
  readonly roleId: string;
  readonly branchScope: readonly string[] | 'all';
  readonly reason: string;
  readonly requestedBy: string;
  readonly approvedBy: string;
  readonly grantedAt: string;
  /** ISO-8601 UTC — computed at grant time, never open-ended. */
  readonly expiresAt: string;
  /** Set when it was ended early. Expiry needs no action. */
  readonly revokedAt?: string;
}

export class EmergencyAccessError extends Error {
  constructor(
    public readonly grantId: string,
    public readonly why: string,
  ) {
    super(`Emergency access "${grantId}" refused: ${why}`);
    this.name = 'EmergencyAccessError';
  }
}

/**
 * Grant time-bound emergency access. The expiry is computed NOW and stored — it
 * does not depend on anyone remembering to end it (SEC-11).
 */
export function grantEmergencyAccess(
  request: EmergencyRequest,
  approval: LifecycleApproval | undefined,
  policy: EmergencyPolicy,
): EmergencyGrant {
  if (request.reason.trim().length < 10) {
    throw new EmergencyAccessError(
      request.grantId,
      'the reason must be specific enough to review afterwards',
    );
  }
  if (request.minutes <= 0 || request.minutes > policy.maxMinutes) {
    throw new EmergencyAccessError(
      request.grantId,
      `it must run between 1 and ${policy.maxMinutes} minutes — there is no perpetual support access`,
    );
  }
  if (approval === undefined || approval.status !== 'approved') {
    throw new EmergencyAccessError(request.grantId, 'it needs an explicit approval');
  }
  if (approval.subjectRef !== request.grantId) {
    throw new EmergencyAccessError(request.grantId, 'the approval is for a different request');
  }
  if (approval.decidedBy === request.requestedBy) {
    throw new EmergencyAccessError(
      request.grantId,
      'the person asking for elevated access cannot approve their own (§28)',
    );
  }

  return {
    grantId: request.grantId,
    userId: request.userId,
    roleId: request.roleId,
    branchScope: request.branchScope,
    reason: request.reason,
    requestedBy: request.requestedBy,
    approvedBy: approval.decidedBy,
    grantedAt: request.at,
    expiresAt: new Date(Date.parse(request.at) + request.minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}

/** Is this grant live right now? Expiry is a fact about time, not an event. */
export function emergencyAccessActive(grant: EmergencyGrant, now: string): boolean {
  if (grant.revokedAt !== undefined && grant.revokedAt <= now) return false;
  return now < grant.expiresAt;
}

/** End a grant early — recorded, never erased. */
export function revokeEmergencyAccess(grant: EmergencyGrant, at: string): EmergencyGrant {
  return { ...grant, revokedAt: at };
}

/**
 * Extending emergency access is a NEW grant with a NEW approval, never a change to
 * the old one — which is precisely what stops "temporary" access becoming permanent
 * by a series of quiet nudges (SEC-11).
 */
export function extendEmergencyAccess(): never {
  throw new EmergencyAccessError(
    '(extension)',
    'emergency access is never extended in place — request a new grant, which needs a new approval and appears in the review',
  );
}

export interface EmergencyReviewRow {
  readonly grantId: string;
  readonly userId: string;
  readonly approvedBy: string;
  readonly reason: string;
  readonly grantedAt: string;
  readonly expiresAt: string;
  readonly minutes: number;
  readonly endedEarly: boolean;
  readonly active: boolean;
}

/** Who had elevated access, when, why, for how long, and who allowed it. */
export function emergencyAccessReview(
  grants: readonly EmergencyGrant[],
  now: string,
): readonly EmergencyReviewRow[] {
  return grants
    .map((grant): EmergencyReviewRow => {
      const end = grant.revokedAt ?? grant.expiresAt;
      return {
        grantId: grant.grantId,
        userId: grant.userId,
        approvedBy: grant.approvedBy,
        reason: grant.reason,
        grantedAt: grant.grantedAt,
        expiresAt: grant.expiresAt,
        minutes: Math.round((Date.parse(end) - Date.parse(grant.grantedAt)) / 60_000),
        endedEarly: grant.revokedAt !== undefined,
        active: emergencyAccessActive(grant, now),
      };
    })
    .sort((a, b) => b.grantedAt.localeCompare(a.grantedAt));
}
