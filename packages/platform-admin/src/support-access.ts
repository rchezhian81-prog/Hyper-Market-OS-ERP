// Controlled, audited support access and the status centre (M33-FR-03/04 / SEC-11).
//
// Support access is the back door that everyone forgets is open. A vendor engineer is
// given admin "to look at one thing" during a busy week, and eighteen months later
// that account still exists, still has full rights, and nobody can say who used it or
// what they did.
//
// The roadmap's rule is absolute: **no perpetual support access** (SEC-11). So:
//
//   • the OWNER approves — not a manager, not another engineer;
//   • the requester is never the approver (§28);
//   • access is TIME-BOXED at the moment it is granted, and expires on its own;
//   • every session is RECORDED — who, why, how long, and what they touched — and
//     the recording is what makes it accountable rather than merely permitted;
//   • least privilege for the specific task: support access grants the scope needed
//     for the stated reason, never blanket admin.
//
// Extending is deliberately impossible: an extension is a NEW request with a NEW
// approval, which is what stops "temporary" becoming permanent by a series of quiet
// nudges. (`packages/identity` enforces the same rule for staff emergency access.)
//
// Pure and deterministic: the timestamp is injected, there is no clock.

import type { SystemHealth } from '../../ops/src/health';

export interface SupportAccessRequest {
  readonly requestId: string;
  /** The support engineer who needs it. */
  readonly requesterId: string;
  readonly requesterName: string;
  /** Specific enough to review afterwards — "investigate" is not a reason. */
  readonly reason: string;
  /** What they actually need, not blanket admin. */
  readonly scopes: readonly string[];
  readonly tenantId: string;
  readonly minutes: number;
  readonly at: string;
}

export interface OwnerApproval {
  readonly subjectRef: string;
  readonly status: 'approved' | 'rejected' | 'pending';
  readonly decidedBy: string;
  /** The owner may cut the requested duration down. They may never extend it here. */
  readonly grantedMinutes?: number;
}

export interface SupportSession {
  readonly sessionId: string;
  readonly requesterId: string;
  readonly requesterName: string;
  readonly approvedBy: string;
  readonly reason: string;
  readonly scopes: readonly string[];
  readonly tenantId: string;
  readonly startedAt: string;
  /** Computed at grant time. Never open-ended, never edited afterwards. */
  readonly expiresAt: string;
  readonly endedAt?: string;
  /** Everything the session did — the record that makes it accountable. */
  readonly actions: readonly SupportAction[];
}

export interface SupportAction {
  readonly at: string;
  readonly action: string;
  readonly target?: string;
}

export class SupportAccessRefusedError extends Error {
  constructor(
    public readonly requestId: string,
    public readonly why: string,
  ) {
    super(`Support access "${requestId}" refused: ${why}`);
    this.name = 'SupportAccessRefusedError';
  }
}

/** Per-tenant limits on how far support access can ever go. */
export interface SupportPolicy {
  readonly maxMinutes: number;
  /** Scopes support may never hold, whatever the reason. */
  readonly forbiddenScopes?: readonly string[];
}

export const DEFAULT_SUPPORT_POLICY: SupportPolicy = {
  maxMinutes: 240,
  // Support diagnoses; it never commits business value. Hard rule #5's principle,
  // applied to humans: the people who fix the system are not the people who approve
  // its money.
  forbiddenScopes: ['payment.commit', 'refund.approve', 'price.commit', 'privilege.grant'],
};

/** Grant time-boxed support access, or refuse it with the reason. */
export function grantSupportAccess(
  request: SupportAccessRequest,
  approval: OwnerApproval | undefined,
  policy: SupportPolicy = DEFAULT_SUPPORT_POLICY,
): SupportSession {
  if (request.reason.trim().length < 15) {
    throw new SupportAccessRefusedError(
      request.requestId,
      'the reason must be specific enough to review afterwards — "investigate" is not a reason',
    );
  }
  if (request.scopes.length === 0) {
    throw new SupportAccessRefusedError(
      request.requestId,
      'no scope was requested; support access is least-privilege for a stated task, never blanket admin',
    );
  }
  const forbidden = request.scopes.filter((s) => (policy.forbiddenScopes ?? []).includes(s));
  if (forbidden.length > 0) {
    throw new SupportAccessRefusedError(
      request.requestId,
      `support may never hold ${forbidden.join(', ')} — the people who fix the system do not approve its money`,
    );
  }
  if (approval === undefined || approval.status !== 'approved') {
    throw new SupportAccessRefusedError(request.requestId, 'the owner has not approved it');
  }
  if (approval.subjectRef !== request.requestId) {
    throw new SupportAccessRefusedError(request.requestId, 'the approval is for a different request');
  }
  if (approval.decidedBy === request.requesterId) {
    throw new SupportAccessRefusedError(
      request.requestId,
      'the person asking for access cannot approve their own (§28)',
    );
  }

  // Checked BEFORE the policy ceiling, so an over-long approval gets the specific
  // reason ("you may not extend") rather than the generic one about the maximum.
  // The owner may cut a request down, never lengthen it beyond what was asked.
  if (approval.grantedMinutes !== undefined && approval.grantedMinutes > request.minutes) {
    throw new SupportAccessRefusedError(
      request.requestId,
      'an approval may shorten the requested time, never extend it — a longer window is a new request',
    );
  }
  const requested = approval.grantedMinutes ?? request.minutes;
  if (requested <= 0 || requested > policy.maxMinutes) {
    throw new SupportAccessRefusedError(
      request.requestId,
      `access must run between 1 and ${policy.maxMinutes} minutes — there is no perpetual support access (SEC-11)`,
    );
  }

  return {
    sessionId: request.requestId,
    requesterId: request.requesterId,
    requesterName: request.requesterName,
    approvedBy: approval.decidedBy,
    reason: request.reason,
    scopes: request.scopes,
    tenantId: request.tenantId,
    startedAt: request.at,
    expiresAt: new Date(Date.parse(request.at) + requested * 60_000)
      .toISOString()
      .replace(/\.\d{3}Z$/, 'Z'),
    actions: [],
  };
}

/** Is the session live? Expiry is a fact about time, not an event someone triggers. */
export function supportSessionActive(session: SupportSession, now: string): boolean {
  if (session.endedAt !== undefined && session.endedAt <= now) return false;
  return now < session.expiresAt;
}

/**
 * Record what a support session did. Actions after expiry are refused — the record
 * cannot show work that the grant did not cover.
 */
export function recordSupportAction(
  session: SupportSession,
  action: SupportAction,
): SupportSession {
  if (!supportSessionActive(session, action.at)) {
    throw new SupportAccessRefusedError(
      session.sessionId,
      'the session has expired; a new request and a new approval are needed',
    );
  }
  return { ...session, actions: [...session.actions, action] };
}

export function endSupportSession(session: SupportSession, at: string): SupportSession {
  return { ...session, endedAt: at };
}

export interface SupportAccessReviewRow {
  readonly sessionId: string;
  readonly requesterName: string;
  readonly approvedBy: string;
  readonly reason: string;
  readonly scopes: readonly string[];
  readonly startedAt: string;
  readonly minutes: number;
  readonly actionCount: number;
  readonly active: boolean;
  /** True when the session was granted but nothing was ever done — worth asking why. */
  readonly unused: boolean;
}

/** Who had support access, when, why, for how long and what they did (M33-FR-03). */
export function supportAccessReview(
  sessions: readonly SupportSession[],
  now: string,
): readonly SupportAccessReviewRow[] {
  return sessions
    .map((session): SupportAccessReviewRow => {
      const end = session.endedAt ?? session.expiresAt;
      return {
        sessionId: session.sessionId,
        requesterName: session.requesterName,
        approvedBy: session.approvedBy,
        reason: session.reason,
        scopes: session.scopes,
        startedAt: session.startedAt,
        minutes: Math.round((Date.parse(end) - Date.parse(session.startedAt)) / 60_000),
        actionCount: session.actions.length,
        active: supportSessionActive(session, now),
        unused: session.actions.length === 0 && !supportSessionActive(session, now),
      };
    })
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

// --- status centre (M33-FR-04) -------------------------------------------------

export interface EntitlementState {
  readonly tenantId: string;
  readonly moduleId: string;
  readonly enabled: boolean;
  /** ISO-8601 date the entitlement lapses; omit for perpetual. */
  readonly expiresOn?: string;
}

export interface StatusCentre {
  readonly tenantId: string;
  readonly health: SystemHealth;
  readonly fleet: { readonly total: number; readonly trading: number; readonly blocked: number };
  readonly activeSupportSessions: number;
  readonly entitlementsExpiringSoon: readonly EntitlementState[];
  /** Plain English for the admin, worst thing first. */
  readonly headline: string;
}

/**
 * The single screen an administrator opens first. It reports **real** health from
 * `packages/ops` rather than a separate cheerful status of its own — a status page
 * that disagrees with reality is worse than no status page.
 */
export function statusCentre(input: {
  readonly tenantId: string;
  readonly health: SystemHealth;
  readonly fleet: { readonly total: number; readonly trading: number; readonly blocked: number };
  readonly supportSessions: readonly SupportSession[];
  readonly entitlements: readonly EntitlementState[];
  readonly now: string;
  readonly entitlementWarnDays?: number;
}): StatusCentre {
  const active = input.supportSessions.filter((s) => supportSessionActive(s, input.now)).length;
  const warnDays = input.entitlementWarnDays ?? 30;
  const cutoff = new Date(Date.parse(input.now) + warnDays * 86_400_000).toISOString().slice(0, 10);
  const expiring = input.entitlements.filter(
    (e) => e.enabled && e.expiresOn !== undefined && e.expiresOn <= cutoff,
  );

  const problems: string[] = [];
  if (input.fleet.blocked > 0) problems.push(`${input.fleet.blocked} device(s) cannot trade`);
  if (input.health.status !== 'ok') problems.push(input.health.summary);
  if (active > 0) problems.push(`${active} support session(s) currently open`);
  if (expiring.length > 0) {
    problems.push(`${expiring.length} entitlement(s) expiring within ${warnDays} days`);
  }

  return {
    tenantId: input.tenantId,
    health: input.health,
    fleet: input.fleet,
    activeSupportSessions: active,
    entitlementsExpiringSoon: expiring,
    headline: problems.length === 0 ? 'Everything normal' : problems.join(' · '),
  };
}
