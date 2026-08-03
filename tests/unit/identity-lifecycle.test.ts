import { describe, it, expect } from 'vitest';
import {
  applyLifecycle,
  grantEmergencyAccess,
  emergencyAccessActive,
  revokeEmergencyAccess,
  extendEmergencyAccess,
  emergencyAccessReview,
  SelfServiceAccessError,
  EmergencyAccessError,
  type AccessGrant,
  type EmergencyPolicy,
  type EmergencyRequest,
  type LifecycleApproval,
  type LifecycleRequest,
} from '../../packages/identity/src/index';

// M02-FR-04 — access must track employment reality. The gap between the two is
// where fraud lives: the mover who accumulates scope nobody granted, and the leaver
// whose account is disabled "later".

const AT = '2026-08-03T09:00:00Z';
const APPROVAL: LifecycleApproval = { subjectRef: 'req-1', status: 'approved', decidedBy: 'admin-2' };

const FRESH: AccessGrant = { userId: 'u1', roleId: 'fresh-assistant', branchScope: ['b1'] };
const CASH_OFFICE: AccessGrant = { userId: 'u1', roleId: 'cash-office', branchScope: ['b1'] };

function request(over: Partial<LifecycleRequest> = {}): LifecycleRequest {
  return {
    requestId: 'req-1',
    event: 'mover',
    userId: 'u1',
    requestedBy: 'hr-1',
    reason: 'moved to the cash office',
    at: AT,
    grants: [CASH_OFFICE],
    ...over,
  };
}

describe('joiner — access begins when the job does', () => {
  it('grants exactly the scope that was approved', () => {
    const result = applyLifecycle({
      request: request({ event: 'joiner', reason: 'new starter', grants: [FRESH] }),
      currentGrants: [],
      approval: APPROVAL,
    });
    expect(result.applied).toBe(true);
    expect(result.grants).toEqual([FRESH]);
    expect(result.removed).toEqual([]);
  });

  it('refuses a change nobody approved, or one with no reason', () => {
    const unapproved = applyLifecycle({ request: request({ event: 'joiner' }), currentGrants: [] });
    expect(unapproved.applied).toBe(false);
    expect(unapproved.blockers[0]).toContain('second person');

    const noReason = applyLifecycle({
      request: request({ event: 'joiner', reason: ' ' }),
      currentGrants: [],
      approval: APPROVAL,
    });
    expect(noReason.blockers[0]).toContain('no reason');
  });

  it('refuses a request approved by the person who raised it (§28)', () => {
    expect(() =>
      applyLifecycle({
        request: request({ event: 'joiner' }),
        currentGrants: [],
        approval: { subjectRef: 'req-1', status: 'approved', decidedBy: 'hr-1' },
      }),
    ).toThrow(SelfServiceAccessError);
  });

  it('refuses a joiner or mover that does not say what access to grant', () => {
    const result = applyLifecycle({
      request: request({ event: 'joiner', grants: [] }),
      currentGrants: [],
      approval: APPROVAL,
    });
    expect(result.blockers[0]).toContain('must say what access');
  });
});

describe('mover — replaces scope, never accumulates it (acceptance)', () => {
  it('removes the old role when the new one is granted', () => {
    const result = applyLifecycle({
      request: request(),
      currentGrants: [FRESH],
      approval: APPROVAL,
    });
    expect(result.grants).toEqual([CASH_OFFICE]);
    expect(result.removed).toEqual([FRESH]);
    // The combination nobody granted — raise an adjustment AND settle the till it
    // hides in — can never assemble itself.
    expect(result.grants).toHaveLength(1);
  });

  it('removes the old branch when someone transfers store', () => {
    const result = applyLifecycle({
      request: request({ grants: [{ userId: 'u1', roleId: 'fresh-assistant', branchScope: ['b2'] }] }),
      currentGrants: [FRESH],
      approval: APPROVAL,
    });
    expect(result.removed).toEqual([FRESH]);
    expect(result.grants[0]?.branchScope).toEqual(['b2']);
  });

  it('closes sessions so the new scope takes effect at once, not whenever they log out', () => {
    const moved = applyLifecycle({ request: request(), currentGrants: [FRESH], approval: APPROVAL });
    expect(moved.closeSessions).toBe(true);
    expect(moved.prioritySync).toBe(true);

    // Re-granting exactly what they already have changes nothing and disturbs nobody.
    const noop = applyLifecycle({
      request: request({ grants: [FRESH] }),
      currentGrants: [FRESH],
      approval: APPROVAL,
    });
    expect(noop.removed).toEqual([]);
    expect(noop.closeSessions).toBe(false);
  });
});

describe('leaver — revoked in one act, and never leaving orphans behind', () => {
  it('revokes everything and closes the sessions in the same act (acceptance)', () => {
    const result = applyLifecycle({
      request: request({ event: 'leaver', reason: 'resigned', grants: undefined }),
      currentGrants: [FRESH, CASH_OFFICE],
      approval: APPROVAL,
    });
    expect(result.applied).toBe(true);
    expect(result.grants).toEqual([]);
    expect(result.removed).toEqual([FRESH, CASH_OFFICE]);
    expect(result.closeSessions).toBe(true);
    // An ex-employee's access must not wait behind a queue of sales to reach the store.
    expect(result.prioritySync).toBe(true);
  });

  it('blocks a leaver whose open items would be orphaned, naming them', () => {
    const result = applyLifecycle({
      request: request({ event: 'leaver', reason: 'resigned' }),
      currentGrants: [FRESH],
      approval: APPROVAL,
      ownedOpenItems: [
        { itemId: 'PO-88', kind: 'purchase order', description: 'awaiting approval' },
        { itemId: 'EXC-12', kind: 'exception', description: 'unexplained till variance' },
      ],
    });
    expect(result.applied).toBe(false);
    expect(result.blockers[0]).toContain('purchase order PO-88');
    expect(result.blockers[0]).toContain('exception EXC-12');
    // Access is not silently left in place either — nothing was applied.
    expect(result.grants).toEqual([FRESH]);
  });
});

describe('emergency access — real, necessary, and never quietly permanent (SEC-11)', () => {
  const POLICY: EmergencyPolicy = { maxMinutes: 240, requiresApprovalBy: 'owner' };
  const OWNER: LifecycleApproval = { subjectRef: 'eg-1', status: 'approved', decidedBy: 'owner-1' };

  function emergency(over: Partial<EmergencyRequest> = {}): EmergencyRequest {
    return {
      grantId: 'eg-1',
      userId: 'support-1',
      requestedBy: 'support-1',
      reason: 'till 3 will not close the shift; needs cash-office access to reconcile',
      roleId: 'cash-office',
      branchScope: ['b1'],
      at: AT,
      minutes: 60,
      ...over,
    };
  }

  it('grants access that expires by itself, with the approver and reason on the record', () => {
    const grant = grantEmergencyAccess(
      emergency({ requestedBy: 'manager-1' }),
      OWNER,
      POLICY,
    );
    expect(grant.approvedBy).toBe('owner-1');
    expect(grant.expiresAt).toBe('2026-08-03T10:00:00Z');
    expect(emergencyAccessActive(grant, '2026-08-03T09:59:00Z')).toBe(true);
    // Nobody has to remember to end it.
    expect(emergencyAccessActive(grant, '2026-08-03T10:00:00Z')).toBe(false);
  });

  it('refuses an open-ended or over-long grant', () => {
    expect(() => grantEmergencyAccess(emergency({ requestedBy: 'manager-1', minutes: 0 }), OWNER, POLICY)).toThrow(
      EmergencyAccessError,
    );
    expect(() =>
      grantEmergencyAccess(emergency({ requestedBy: 'manager-1', minutes: 10_000 }), OWNER, POLICY),
    ).toThrow(/no perpetual support access/);
  });

  it('refuses a vague reason — the review has to mean something', () => {
    expect(() =>
      grantEmergencyAccess(emergency({ requestedBy: 'manager-1', reason: 'urgent' }), OWNER, POLICY),
    ).toThrow(/specific enough to review/);
  });

  it('refuses self-approval, no approval, and an approval for something else', () => {
    expect(() => grantEmergencyAccess(emergency(), OWNER, POLICY)).not.toThrow(); // requestedBy support-1, approved by owner-1
    expect(() =>
      grantEmergencyAccess(emergency({ requestedBy: 'owner-1' }), OWNER, POLICY),
    ).toThrow(/cannot approve their own/);
    expect(() => grantEmergencyAccess(emergency(), undefined, POLICY)).toThrow(/explicit approval/);
    expect(() =>
      grantEmergencyAccess(emergency(), { subjectRef: 'eg-9', status: 'approved', decidedBy: 'owner-1' }, POLICY),
    ).toThrow(/different request/);
  });

  it('cannot be extended in place — an extension is a new grant with a new approval', () => {
    expect(() => extendEmergencyAccess()).toThrow(/never extended in place/);
  });

  it('can be ended early, and the record keeps both times', () => {
    const grant = grantEmergencyAccess(emergency({ requestedBy: 'manager-1' }), OWNER, POLICY);
    const revoked = revokeEmergencyAccess(grant, '2026-08-03T09:20:00Z');
    expect(emergencyAccessActive(revoked, '2026-08-03T09:30:00Z')).toBe(false);
    expect(revoked.expiresAt).toBe('2026-08-03T10:00:00Z'); // the original bound is retained
  });

  it('reviews who had elevated access, when, why, for how long and who allowed it', () => {
    const grant = grantEmergencyAccess(emergency({ requestedBy: 'manager-1' }), OWNER, POLICY);
    const early = revokeEmergencyAccess(
      grantEmergencyAccess(
        emergency({ grantId: 'eg-2', requestedBy: 'manager-1', at: '2026-08-01T09:00:00Z', minutes: 120 }),
        { subjectRef: 'eg-2', status: 'approved', decidedBy: 'owner-1' },
        POLICY,
      ),
      '2026-08-01T09:30:00Z',
    );

    const rows = emergencyAccessReview([early, grant], '2026-08-03T09:30:00Z');
    expect(rows.map((r) => r.grantId)).toEqual(['eg-1', 'eg-2']); // newest first
    expect(rows[0]?.minutes).toBe(60);
    expect(rows[0]?.active).toBe(true);
    expect(rows[1]?.minutes).toBe(30); // ended early
    expect(rows[1]?.endedEarly).toBe(true);
    expect(rows[1]?.approvedBy).toBe('owner-1');
  });
});
