import { describe, it, expect } from 'vitest';
import {
  grantSupportAccess,
  supportSessionActive,
  recordSupportAction,
  endSupportSession,
  supportAccessReview,
  statusCentre,
  SupportAccessRefusedError,
  DEFAULT_SUPPORT_POLICY,
  type OwnerApproval,
  type SupportAccessRequest,
} from '../../packages/platform-admin/src/index';
import { checkHealth } from '../../packages/ops/src/index';

// M33-FR-03/04 / SEC-11 — support access is the back door everyone forgets is open.
// A vendor engineer gets admin "to look at one thing", and eighteen months later the
// account still exists with full rights and no record of what it did.

const AT = '2026-08-04T10:00:00Z';

function request(over: Partial<SupportAccessRequest> = {}): SupportAccessRequest {
  return {
    requestId: 'sup-1',
    requesterId: 'eng-1',
    requesterName: 'Vendor engineer',
    reason: 'till 3 will not close its shift; need to read the cash-office reconciliation',
    scopes: ['cash.read', 'logs.read'],
    tenantId: 't1',
    minutes: 60,
    at: AT,
    ...over,
  };
}

const OWNER: OwnerApproval = { subjectRef: 'sup-1', status: 'approved', decidedBy: 'owner-1' };

describe('grantSupportAccess — no perpetual back door (SEC-11)', () => {
  it('grants access that expires by itself', () => {
    const session = grantSupportAccess(request(), OWNER);
    expect(session.approvedBy).toBe('owner-1');
    expect(session.expiresAt).toBe('2026-08-04T11:00:00Z');
    expect(supportSessionActive(session, '2026-08-04T10:59:00Z')).toBe(true);
    // Nobody has to remember to close it.
    expect(supportSessionActive(session, '2026-08-04T11:00:00Z')).toBe(false);
  });

  it('refuses a vague reason — the review has to mean something', () => {
    expect(() => grantSupportAccess(request({ reason: 'investigate' }), OWNER)).toThrow(
      /specific enough to review/,
    );
  });

  it('refuses blanket admin — least privilege for a stated task', () => {
    expect(() => grantSupportAccess(request({ scopes: [] }), OWNER)).toThrow(
      /never blanket admin/,
    );
  });

  it('never lets support hold the scopes that move money', () => {
    // The people who fix the system do not approve its money.
    expect(() =>
      grantSupportAccess(request({ scopes: ['cash.read', 'refund.approve'] }), OWNER),
    ).toThrow(/do not approve its money/);
    expect(DEFAULT_SUPPORT_POLICY.forbiddenScopes).toContain('privilege.grant');
  });

  it('refuses without the owner, on self-approval, and for another request', () => {
    expect(() => grantSupportAccess(request(), undefined)).toThrow(/owner has not approved/);
    expect(() =>
      grantSupportAccess(request(), { ...OWNER, status: 'pending' }),
    ).toThrow(SupportAccessRefusedError);
    expect(() =>
      grantSupportAccess(request(), { ...OWNER, decidedBy: 'eng-1' }),
    ).toThrow(/cannot approve their own/);
    expect(() =>
      grantSupportAccess(request(), { ...OWNER, subjectRef: 'sup-OTHER' }),
    ).toThrow(/different request/);
  });

  it('lets the owner shorten the window but never lengthen it', () => {
    const shortened = grantSupportAccess(request(), { ...OWNER, grantedMinutes: 15 });
    expect(shortened.expiresAt).toBe('2026-08-04T10:15:00Z');

    // A longer window is a new request with a new approval — never a quiet nudge.
    // Checked before the policy ceiling, so the reason given is the specific one.
    expect(() =>
      grantSupportAccess(request(), { ...OWNER, grantedMinutes: 120 }),
    ).toThrow(/never extend it/);
    expect(() =>
      grantSupportAccess(request(), { ...OWNER, grantedMinutes: 600 }),
    ).toThrow(/never extend it/);
  });

  it('refuses an open-ended or over-long grant', () => {
    expect(() => grantSupportAccess(request({ minutes: 0 }), OWNER)).toThrow(
      SupportAccessRefusedError,
    );
    expect(() => grantSupportAccess(request({ minutes: 9999 }), OWNER)).toThrow(
      /no perpetual support access/,
    );
  });
});

describe('the session record is what makes it accountable', () => {
  it('records what the session did', () => {
    let session = grantSupportAccess(request(), OWNER);
    session = recordSupportAction(session, {
      at: '2026-08-04T10:05:00Z',
      action: 'read cash reconciliation',
      target: 'till-3',
    });
    expect(session.actions).toHaveLength(1);
    expect(session.actions[0]?.target).toBe('till-3');
  });

  it('refuses to record work after the grant expired', () => {
    const session = grantSupportAccess(request(), OWNER);
    expect(() =>
      recordSupportAction(session, { at: '2026-08-04T12:00:00Z', action: 'read logs' }),
    ).toThrow(/a new request and a new approval/);
  });

  it('reviews who had access, why, for how long and what they did', () => {
    const used = recordSupportAction(grantSupportAccess(request(), OWNER), {
      at: '2026-08-04T10:05:00Z',
      action: 'read logs',
    });
    const unused = endSupportSession(
      grantSupportAccess(
        request({ requestId: 'sup-2', at: '2026-08-03T10:00:00Z' }),
        { ...OWNER, subjectRef: 'sup-2' },
      ),
      '2026-08-03T10:30:00Z',
    );

    const rows = supportAccessReview([unused, used], '2026-08-04T10:30:00Z');
    expect(rows.map((r) => r.sessionId)).toEqual(['sup-1', 'sup-2']); // newest first
    expect(rows[0]?.actionCount).toBe(1);
    expect(rows[0]?.active).toBe(true);
    // Access granted and never used is worth asking about, not ignoring.
    expect(rows[1]?.unused).toBe(true);
    expect(rows[1]?.minutes).toBe(30);
  });
});

describe('statusCentre — never disagrees with reality (M33-FR-04)', () => {
  const healthy = checkHealth(
    {
      lastSyncAt: '2026-08-04T09:58:00Z',
      queueDepth: 0,
      deadLetterCount: 0,
      localStoreWritable: true,
      lastBackupAt: '2026-08-04T03:00:00Z',
    },
    AT,
  );

  it('says everything is normal when it is', () => {
    const centre = statusCentre({
      tenantId: 't1',
      health: healthy,
      fleet: { total: 4, trading: 4, blocked: 0 },
      supportSessions: [],
      entitlements: [{ tenantId: 't1', moduleId: 'cafe', enabled: true }],
      now: AT,
    });
    expect(centre.headline).toBe('Everything normal');
  });

  it('reports real health rather than a cheerful status of its own', () => {
    const degraded = checkHealth(
      { lastSyncAt: '2026-08-04T06:00:00Z', queueDepth: 41, localStoreWritable: true },
      AT,
    );
    const centre = statusCentre({
      tenantId: 't1',
      health: degraded,
      fleet: { total: 4, trading: 3, blocked: 1 },
      supportSessions: [grantSupportAccess(request(), OWNER)],
      entitlements: [
        { tenantId: 't1', moduleId: 'cafe', enabled: true, expiresOn: '2026-08-20' },
      ],
      now: AT,
    });
    expect(centre.headline).toContain('1 device(s) cannot trade');
    expect(centre.headline).toContain('1 support session(s) currently open');
    expect(centre.headline).toContain('1 entitlement(s) expiring within 30 days');
    expect(centre.activeSupportSessions).toBe(1);
    expect(centre.entitlementsExpiringSoon).toHaveLength(1);
  });
});
