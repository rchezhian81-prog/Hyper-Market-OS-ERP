import { describe, it, expect } from 'vitest';
import {
  revokeSession,
  isSessionRevoked,
  decideTokenSession,
  authEvent,
  authEventsFor,
  type RevocationEntry,
} from '../../packages/identity/src/index';

/**
 * Session revocation and auth audit (M02 / M20 / M22, Item 1 slice 1e). A verified token is good
 * until it expires — but a sign-out or admin revocation must cut it SHORT, refused before expiry.
 * Revocation is append-only and tenant-scoped; login/step-up/revoke are recorded as append-only
 * audit events.
 */

const NOW_MS = Date.parse('2026-09-25T10:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

describe('session revocation (SEC-03 / SEC-11)', () => {
  it('a revoked session reads as revoked, tenant-scoped and per-session', () => {
    const revocations: RevocationEntry[] = [
      revokeSession({ sessionId: 's1', tenantId: 't-sre', reason: 'signed_out', revokedBy: 'cust-99', now: iso(NOW_MS) }),
    ];
    expect(isSessionRevoked(revocations, 't-sre', 's1')).toBe(true);
    expect(isSessionRevoked(revocations, 't-rival', 's1')).toBe(false); // other tenant
    expect(isSessionRevoked(revocations, 't-sre', 's2')).toBe(false); // other session
  });

  it('decideTokenSession refuses a revoked session BEFORE its token expires', () => {
    const revocations = [
      revokeSession({ sessionId: 's1', tenantId: 't-sre', reason: 'admin_revoked', revokedBy: 'owner-1', now: iso(NOW_MS - 1000) }),
    ];
    // Token is still valid for another hour, but the session was revoked.
    const d = decideTokenSession({ sessionId: 's1', tenantId: 't-sre', tokenExpMs: NOW_MS + 3600_000, nowMs: NOW_MS, revocations });
    expect(d.verdict).toBe('revoked');
    expect(d.reason).toBe('admin_revoked');
  });

  it('an unrevoked, unexpired session is active', () => {
    const d = decideTokenSession({ sessionId: 's1', tenantId: 't-sre', tokenExpMs: NOW_MS + 3600_000, nowMs: NOW_MS, revocations: [] });
    expect(d.verdict).toBe('active');
  });

  it('an unrevoked but expired token is expired', () => {
    const d = decideTokenSession({ sessionId: 's1', tenantId: 't-sre', tokenExpMs: NOW_MS - 1000, nowMs: NOW_MS, revocations: [] });
    expect(d.verdict).toBe('expired');
  });

  it('revocation takes precedence over expiry (the stronger fact is reported)', () => {
    const revocations = [
      revokeSession({ sessionId: 's1', tenantId: 't-sre', reason: 'security', revokedBy: 'sec-team', now: iso(NOW_MS - 5000) }),
    ];
    const d = decideTokenSession({ sessionId: 's1', tenantId: 't-sre', tokenExpMs: NOW_MS - 1000, nowMs: NOW_MS, revocations });
    expect(d.verdict).toBe('revoked');
    expect(d.reason).toBe('security');
  });

  it("a revocation in another tenant never cuts off this tenant's session (OB-01)", () => {
    const revocations = [
      revokeSession({ sessionId: 's1', tenantId: 't-rival', reason: 'admin_revoked', revokedBy: 'x', now: iso(NOW_MS) }),
    ];
    const d = decideTokenSession({ sessionId: 's1', tenantId: 't-sre', tokenExpMs: NOW_MS + 1000, nowMs: NOW_MS, revocations });
    expect(d.verdict).toBe('active');
  });

  it('revocation is append-only — a second revocation does not erase the first', () => {
    const first = revokeSession({ sessionId: 's1', tenantId: 't-sre', reason: 'signed_out', revokedBy: 'cust-99', now: iso(NOW_MS) });
    const second = revokeSession({ sessionId: 's1', tenantId: 't-sre', reason: 'admin_revoked', revokedBy: 'owner-1', now: iso(NOW_MS + 1000) });
    const revocations = [first, second];
    expect(revocations).toHaveLength(2);
    expect(isSessionRevoked(revocations, 't-sre', 's1')).toBe(true);
  });
});

describe('auth audit events', () => {
  it('records login / step-up / revoke as append-only facts, scoped by tenant + subject', () => {
    const events = [
      authEvent({ eventId: 'e1', tenantId: 't-sre', subject: 'cust-99', kind: 'login', at: iso(NOW_MS), detail: 'otp login', amr: ['otp'] }),
      authEvent({ eventId: 'e2', tenantId: 't-sre', subject: 'cust-99', kind: 'step_up', at: iso(NOW_MS + 60_000), detail: 'bank details', sessionId: 's1' }),
      authEvent({ eventId: 'e3', tenantId: 't-sre', subject: 'other', kind: 'login', at: iso(NOW_MS), detail: 'x' }),
      authEvent({ eventId: 'e4', tenantId: 't-rival', subject: 'cust-99', kind: 'login', at: iso(NOW_MS), detail: 'x' }),
    ];
    const mine = authEventsFor(events, 't-sre', 'cust-99');
    expect(mine.map((e) => e.eventId)).toEqual(['e1', 'e2']); // order preserved, others excluded
    expect(mine[0]?.amr).toEqual(['otp']);
    expect(mine[1]?.sessionId).toBe('s1');
  });

  it('a login_refused / step_up_refused is recorded too (P-08 — a refusal is evidence)', () => {
    const events = [
      authEvent({ eventId: 'e1', tenantId: 't-sre', subject: 'cust-99', kind: 'login_refused', at: iso(NOW_MS), detail: 'wrong otp' }),
      authEvent({ eventId: 'e2', tenantId: 't-sre', subject: 'cust-99', kind: 'session_revoked', at: iso(NOW_MS + 1000), detail: 'signed out', sessionId: 's1' }),
    ];
    expect(authEventsFor(events, 't-sre', 'cust-99').map((e) => e.kind)).toEqual(['login_refused', 'session_revoked']);
  });
});
