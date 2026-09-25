// Session revocation and auth audit for the customer portal (M02 / M20 / M22, SEC-03, SEC-11).
//
// A verified token is, by itself, good until it expires — that is what makes it fast (no database
// hit per request). But two things must cut a session SHORT of its expiry: a customer signing out,
// and an admin (or a security event) revoking it. A stolen-but-unexpired token, a laptop left logged
// in, an employee who left — none of these can wait for `exp`.
//
// `account.ts` already decides a server-side session's idle / absolute / device / offline expiry
// (`checkSession`). This adds the piece the TOKEN path needs: an explicit, append-only revocation
// list, checked BEFORE expiry, so a revoked session is dead the instant it is revoked. It is
// tenant-scoped (a revocation in one tenant never touches another, OB-01) and append-only — a
// revocation is a fact that is added, never edited away (hard rule #2 / #6).
//
// It also carries the auth AUDIT: login, step-up and revoke are recorded as append-only events, so
// "who signed in, when, how, and who cut them off" is answerable. Pure and deterministic — the clock
// is injected, there is no I/O; the caller persists the entries and events to durable storage.

export type RevocationReason = 'signed_out' | 'admin_revoked' | 'security' | 'credential_change';

export interface RevocationEntry {
  readonly sessionId: string;
  readonly tenantId: string;
  readonly revokedAt: string;
  readonly reason: RevocationReason;
  /** Who revoked it — the subject who signed out, or the admin who cut it off. */
  readonly revokedBy: string;
}

/** Record a revocation. Append-only: the caller adds this to the list, never removes an earlier one. */
export function revokeSession(input: {
  readonly sessionId: string;
  readonly tenantId: string;
  readonly reason: RevocationReason;
  readonly revokedBy: string;
  readonly now: string;
}): RevocationEntry {
  return {
    sessionId: input.sessionId,
    tenantId: input.tenantId,
    revokedAt: input.now,
    reason: input.reason,
    revokedBy: input.revokedBy,
  };
}

/**
 * Is this session revoked, for this tenant?
 *
 * Tenant-scoped: a revocation recorded under another tenant never applies here (OB-01), so a shared
 * session id across tenants — which should not happen, but defence in depth — cannot be cut off
 * across the boundary by accident.
 */
export function isSessionRevoked(
  revocations: readonly RevocationEntry[],
  tenantId: string,
  sessionId: string,
): boolean {
  return revocations.some((r) => r.tenantId === tenantId && r.sessionId === sessionId);
}

export type SessionVerdict = 'active' | 'revoked' | 'expired';

export interface SessionDecision {
  readonly verdict: SessionVerdict;
  readonly reason?: RevocationReason;
  readonly detail: string;
}

/**
 * Decide a token-backed session: **revocation is checked BEFORE expiry**.
 *
 * That order is the whole point — a signed-out or revoked token is refused the instant it is
 * revoked, even though it has not yet expired. A token that is both revoked and expired reports
 * `revoked`, because the earlier, stronger fact is why it is being refused.
 */
export function decideTokenSession(input: {
  readonly sessionId: string;
  readonly tenantId: string;
  readonly tokenExpMs: number;
  readonly nowMs: number;
  readonly revocations: readonly RevocationEntry[];
}): SessionDecision {
  const revocation = input.revocations.find(
    (r) => r.tenantId === input.tenantId && r.sessionId === input.sessionId,
  );
  if (revocation !== undefined) {
    return { verdict: 'revoked', reason: revocation.reason, detail: `session revoked (${revocation.reason})` };
  }
  if (input.nowMs > input.tokenExpMs) {
    return { verdict: 'expired', detail: 'the token has expired' };
  }
  return { verdict: 'active', detail: 'active' };
}

// ── Auth audit ───────────────────────────────────────────────────────────────

export type AuthEventKind =
  | 'login'
  | 'login_refused'
  | 'step_up'
  | 'step_up_refused'
  | 'session_revoked';

export interface AuthAuditEvent {
  readonly eventId: string;
  readonly tenantId: string;
  readonly subject: string;
  readonly kind: AuthEventKind;
  readonly at: string;
  readonly detail: string;
  readonly sessionId?: string;
  /** How the person proved themselves, for a login or step-up. */
  readonly amr?: readonly string[];
}

/** Build an append-only auth audit event — a fact the caller adds to the trail, never edits. */
export function authEvent(input: {
  readonly eventId: string;
  readonly tenantId: string;
  readonly subject: string;
  readonly kind: AuthEventKind;
  readonly at: string;
  readonly detail: string;
  readonly sessionId?: string;
  readonly amr?: readonly string[];
}): AuthAuditEvent {
  return {
    eventId: input.eventId,
    tenantId: input.tenantId,
    subject: input.subject,
    kind: input.kind,
    at: input.at,
    detail: input.detail,
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    ...(input.amr === undefined ? {} : { amr: [...input.amr] }),
  };
}

/**
 * A subject's auth events within one tenant, in the order recorded — what a customer's "recent
 * sign-in activity" view shows, and what an admin reads to see who cut a session off. Tenant-scoped.
 */
export function authEventsFor(
  events: readonly AuthAuditEvent[],
  tenantId: string,
  subject: string,
): readonly AuthAuditEvent[] {
  return events.filter((e) => e.tenantId === tenantId && e.subject === subject);
}
