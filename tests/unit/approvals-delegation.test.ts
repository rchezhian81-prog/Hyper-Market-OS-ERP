import { describe, it, expect } from 'vitest';
import { money } from '../../packages/contracts/src/money';
import { requestApproval, type Approver } from '../../packages/approvals/src/approvals';
import {
  grantDelegation,
  effectiveAuthority,
  decideWithDelegation,
  reviewDelegations,
  type Delegation,
} from '../../packages/approvals/src/delegation';

// M02-FR-03 remainder: delegation. The control that stops the shared login.

const MANAGER: Approver = {
  userId: 'u-manager', branchScope: ['b-main'], authorityLimit: money(100_000, 'INR'),
};
const OWNER: Approver = { userId: 'u-owner', branchScope: 'all', authorityLimit: null };

const delegation = (over: Partial<Delegation> = {}): Delegation => ({
  delegationId: 'dg-1',
  fromUserId: 'u-manager',
  toUserId: 'u-supervisor',
  fromDate: '2026-08-01',
  untilDate: '2026-08-14',
  subjectTypes: ['refund'],
  valueCap: money(50_000, 'INR'),
  branchScope: ['b-main'],
  reason: 'annual leave, 1–14 August',
  authorisedBy: 'u-owner',
  ...over,
});

function grant(over: Partial<Parameters<typeof grantDelegation>[0]> = {}) {
  return grantDelegation({
    delegation: delegation(), granter: MANAGER, today: '2026-07-28', ...over,
  });
}

describe('delegation exists to stop the shared login (M02-FR-03)', () => {
  it('grants a time-boxed, capped, authorised delegation', () => {
    const r = grant();
    expect(r.created).toBe(true);
    expect(r.detail).toContain('authorised by u-owner');
  });

  it('REFUSES an open-ended delegation', () => {
    const r = grant({ delegation: delegation({ untilDate: '' }) });
    expect(r.refusal).toBe('open_ended');
    // "Until further notice" is a permanent escalation nobody remembers granting.
    expect(r.detail).toContain('nobody remembers granting');
  });

  it('refuses one that outlasts the absence it covers', () => {
    const r = grant({ delegation: delegation({ untilDate: '2027-08-14' }) });
    expect(r.refusal).toBe('too_long');
    expect(r.detail).toContain('permanent change of who holds authority');
  });

  it('REFUSES a self-authorised delegation', () => {
    const r = grant({ delegation: delegation({ authorisedBy: 'u-manager' }) });
    expect(r.refusal).toBe('not_authorised');
    expect(r.detail).toContain('unsupervised');
  });

  it('refuses one with no reason on it', () => {
    expect(grant({ delegation: delegation({ reason: '  ' }) }).refusal).toBe('no_reason');
  });

  it('REFUSES lending more authority than you hold', () => {
    const tooMuch = grant({ delegation: delegation({ valueCap: money(200_000, 'INR') }) });
    expect(tooMuch.refusal).toBe('exceeds_granter_authority');

    // And an UNCAPPED delegation from a capped approver grants more, not the same.
    const uncapped = grant({ delegation: delegation({ valueCap: null }) });
    expect(uncapped.refusal).toBe('exceeds_granter_authority');
    expect(uncapped.detail).toContain('set a cap at or below it');
  });

  it('lets an unlimited approver delegate without a cap — witnessed by a SECOND person', () => {
    // Even the owner cannot authorise their own delegation. The second custodian
    // (D4, Mr Sivakumar) signs it, which is the point of separation of duties.
    expect(grant({
      delegation: delegation({
        fromUserId: 'u-owner', valueCap: null, branchScope: undefined, authorisedBy: 'u-custodian',
      }),
      granter: OWNER,
    }).created).toBe(true);

    // Self-authorised, it is refused — no matter how senior.
    expect(grant({
      delegation: delegation({
        fromUserId: 'u-owner', valueCap: null, branchScope: undefined, authorisedBy: 'u-owner',
      }),
      granter: OWNER,
    }).refusal).toBe('not_authorised');
  });

  it('refuses a delegation that WIDENS branch scope', () => {
    const r = grant({ delegation: delegation({ branchScope: ['b-main', 'b-other'] }) });
    expect(r.refusal).toBe('widens_branch_scope');
    expect(r.detail).toContain('it never widens');
  });

  it('refuses an empty subject list rather than reading it as "everything"', () => {
    expect(grant({ delegation: delegation({ subjectTypes: [] }) }).refusal).toBe('no_subject_types');
  });

  it('refuses delegating to yourself, and refuses backwards dates', () => {
    expect(grant({ delegation: delegation({ toUserId: 'u-manager' }) }).refusal).toBe('self_delegation');
    expect(grant({ delegation: delegation({ fromDate: '2026-08-14', untilDate: '2026-08-01' }) }).refusal)
      .toBe('backwards_dates');
  });

  it('REFUSES A CHAIN — two hops in, nobody can say who was accountable', () => {
    const r = grant({
      delegation: delegation({ delegationId: 'dg-2', fromUserId: 'u-supervisor', toUserId: 'u-cashier' }),
      granter: { userId: 'u-supervisor', branchScope: ['b-main'], authorityLimit: money(50_000, 'INR') },
      existing: [delegation()],
      today: '2026-08-05',
    });
    expect(r.refusal).toBe('chain_forbidden');
  });
});

describe('effective authority: own first, delegated only where there is none', () => {
  const live = [delegation()];

  it('uses a person\'s OWN authority where they have it', () => {
    const a = effectiveAuthority({
      userId: 'u-manager', subjectType: 'refund', own: MANAGER, delegations: live, today: '2026-08-05',
    });
    expect(a.source).toBe('own_authority');
    expect(a.onBehalfOf).toBeUndefined();
  });

  it('grants delegated authority inside the window, and NAMES whose it is', () => {
    const a = effectiveAuthority({
      userId: 'u-supervisor', subjectType: 'refund', delegations: live, today: '2026-08-05',
    });
    expect(a.source).toBe('delegated');
    expect(a.onBehalfOf).toBe('u-manager');
    expect(a.authorityLimit).toEqual(money(50_000, 'INR'));
    // The decision goes in the delegate's own name (hard rule #4).
    expect(a.detail).toContain("recorded in u-supervisor's own name");
  });

  it('STOPS ON ITS OWN when the window closes', () => {
    const a = effectiveAuthority({
      userId: 'u-supervisor', subjectType: 'refund', delegations: live, today: '2026-08-20',
    });
    expect(a.source).toBe('none');
    expect(a.detail).toContain('it stopped on its own, which is the point of an end date');
  });

  it('does not grant before it starts, or for a subject it does not cover', () => {
    expect(effectiveAuthority({
      userId: 'u-supervisor', subjectType: 'refund', delegations: live, today: '2026-07-20',
    }).source).toBe('none');

    expect(effectiveAuthority({
      userId: 'u-supervisor', subjectType: 'price_change', delegations: live, today: '2026-08-05',
    }).source).toBe('none');
  });

  it('ignores a revoked delegation', () => {
    expect(effectiveAuthority({
      userId: 'u-supervisor', subjectType: 'refund',
      delegations: [delegation({ revokedOn: '2026-08-03' })], today: '2026-08-05',
    }).source).toBe('none');
  });
});

describe('delegation NEVER launders separation of duties', () => {
  const request = requestApproval({
    id: 'ap-1', subjectType: 'refund', subjectRef: 'RF-1',
    requestedBy: 'u-cashier', branchId: 'b-main', value: money(30_000, 'INR'),
  });

  const authority = effectiveAuthority({
    userId: 'u-supervisor', subjectType: 'refund', delegations: [delegation()], today: '2026-08-05',
  });

  it('approves within the delegated cap, in the DELEGATE\'S OWN NAME', () => {
    const r = decideWithDelegation({
      request, decidedBy: 'u-supervisor', decision: 'approved',
      reason: 'wrong size, unopened', authority, at: '2026-08-05T11:00:00Z',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Never the absent manager's name.
    expect(r.request.decidedBy).toBe('u-supervisor');
    expect(r.request.onBehalfOf).toBe('u-manager');
    expect(r.request.delegationId).toBe('dg-1');
  });

  it('still refuses SELF-approval', () => {
    const r = decideWithDelegation({
      request, decidedBy: 'u-cashier', decision: 'approved',
      reason: 'mine', authority, at: '2026-08-05T11:00:00Z',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal).toBe('self_approval_forbidden');
  });

  it('REFUSES A DELEGATION FROM THE MAKER — a self-approval with an extra step', () => {
    // The loophole somebody will actually try: delegate to the person whose requests
    // need approving, then have them approve on the maker's own authority.
    const laundered = effectiveAuthority({
      userId: 'u-supervisor', subjectType: 'refund',
      delegations: [delegation({ fromUserId: 'u-cashier' })], today: '2026-08-05',
    });
    const r = decideWithDelegation({
      request, decidedBy: 'u-supervisor', decision: 'approved',
      reason: 'fine', authority: laundered, at: '2026-08-05T11:00:00Z',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal).toBe('delegation_to_maker_forbidden');
    expect(r.detail).toContain('a self-approval with an extra step');
  });

  it('escalates rather than widening when the value exceeds the delegated cap', () => {
    const big = requestApproval({
      id: 'ap-2', subjectType: 'refund', subjectRef: 'RF-2',
      requestedBy: 'u-cashier', branchId: 'b-main', value: money(80_000, 'INR'),
    });
    const r = decideWithDelegation({
      request: big, decidedBy: 'u-supervisor', decision: 'approved',
      reason: 'large return', authority, at: '2026-08-05T11:00:00Z',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal).toBe('exceeds_authority');
    expect(r.detail).toContain('escalate rather than widen it');
  });

  it('refuses a branch outside the delegated scope, and an unreasoned decision', () => {
    const elsewhere = requestApproval({
      id: 'ap-3', subjectType: 'refund', subjectRef: 'RF-3',
      requestedBy: 'u-cashier', branchId: 'b-other', value: money(10_000, 'INR'),
    });
    const scoped = decideWithDelegation({
      request: elsewhere, decidedBy: 'u-supervisor', decision: 'approved',
      reason: 'ok', authority, at: '2026-08-05T11:00:00Z',
    });
    expect(scoped.ok).toBe(false);
    if (!scoped.ok) expect(scoped.refusal).toBe('out_of_scope');

    const silent = decideWithDelegation({
      request, decidedBy: 'u-supervisor', decision: 'approved',
      reason: '   ', authority, at: '2026-08-05T11:00:00Z',
    });
    expect(silent.ok).toBe(false);
    if (!silent.ok) expect(silent.refusal).toBe('reason_required');
  });

  it('refuses somebody with no authority at all', () => {
    const none = effectiveAuthority({
      userId: 'u-cleaner', subjectType: 'refund', delegations: [], today: '2026-08-05',
    });
    const r = decideWithDelegation({
      request, decidedBy: 'u-cleaner', decision: 'approved',
      reason: 'sure', authority: none, at: '2026-08-05T11:00:00Z',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal).toBe('no_authority');
  });
});

describe('the standing-delegations review catches the one nobody revoked', () => {
  it('surfaces a March delegation still live in August', () => {
    const rows = reviewDelegations({
      delegations: [
        delegation({ delegationId: 'dg-march', fromDate: '2026-03-01', untilDate: '2026-12-31' }),
        delegation({ delegationId: 'dg-now', untilDate: '2026-08-08' }),
      ],
      today: '2026-08-04',
    });
    // Soonest to lapse first, so the decisions needed today are at the top.
    expect(rows[0]?.delegationId).toBe('dg-now');
    expect(rows[0]?.state).toBe('expiring');
    expect(rows[0]?.detail).toContain('renew it or let it lapse, but decide');
    expect(rows[1]?.state).toBe('active');
  });

  it('says an expired one grants nothing', () => {
    const rows = reviewDelegations({ delegations: [delegation()], today: '2026-09-01' });
    expect(rows[0]?.state).toBe('expired');
    expect(rows[0]?.detail).toContain('it stopped on its own');
  });

  it('reports a revoked one plainly', () => {
    const rows = reviewDelegations({
      delegations: [delegation({ revokedOn: '2026-08-03' })], today: '2026-08-04',
    });
    expect(rows[0]?.state).toBe('revoked');
  });
});
