import { describe, it, expect } from 'vitest';
import {
  createOwnerSession,
  fingerprintOf,
  OWNER_DECIDE_REFUSALS,
  UnknownBranchError,
  type BranchPayload,
  type OwnerConfig,
} from '../../apps/owner-app/src/owner-session';
import type { SaleFact } from '../../packages/reporting/src/index';
import type { LpException } from '../../packages/loss-prevention/src/index';

// The owner's command centre (docs/design/screens/owner-command-centre.md · M29 · D13 · M02 ·
// M29-FR-02 · §31 · §31.1 · QG-02). `brief.ts` builds the numbers; this is everything that makes
// them safe to ACT on from a phone in another town — where every figure is historical by
// construction and the store has been trading since it left.

const sale = (id: string, total: number, cogs: number, tender = 'cash'): SaleFact => ({
  saleId: id,
  netMinor: Math.round(total / 1.18),
  taxMinor: total - Math.round(total / 1.18),
  totalMinor: total,
  cogsMinor: cogs,
  units: 3,
  tender,
  currency: 'INR',
});

const SALES: SaleFact[] = [
  sale('s1', 118_00, 70_00, 'cash'),
  sale('s2', 295_00, 180_00, 'upi'),
  sale('s3', 59_00, 20_00, 'card'),
];

const OWNER: OwnerConfig = {
  owner: { userId: 'u-owner', branchScope: 'all', authorityLimit: null },
  staleAfterSeconds: 300,
  acknowledgeStaleDecisions: true,
};

const NOW = '2026-08-05T10:00:00.000Z';
const now = () => NOW;
/** Ninety seconds old — inside the 300-second window. */
const FRESH_SYNC = '2026-08-05T09:58:30.000Z';
/** Eleven hours old. The shop has been trading all day since this left. */
const STALE_SYNC = '2026-08-04T23:00:00.000Z';

const branch = (over: Partial<BranchPayload> = {}): BranchPayload => ({
  branchId: 'b1',
  name: 'SRE Hyper Market',
  lastSyncedAt: FRESH_SYNC,
  sales: SALES,
  exceptions: [],
  approvals: [
    { id: 'a1', subjectType: 'purchase_order', subjectRef: 'PO-9912', requestedBy: 'u-buyer', valueMinor: 812_000_00 },
    { id: 'a2', subjectType: 'price_change', subjectRef: 'Toor dal 1kg', requestedBy: 'u-buyer', valueMinor: 45_000 },
  ],
  ...over,
});

const newSession = (payloads: BranchPayload[] = [branch()], config: Partial<OwnerConfig> = {}) =>
  createOwnerSession({ ...OWNER, ...config }, payloads, now);

describe('a decision carries the ground it was made on', () => {
  it('records the freshness and the age into the decision itself', () => {
    // Not a diagnostic. "Approved, on data ninety seconds old" is a different fact from "approved",
    // and only one of them can be defended a year later.
    const outcome = newSession().decide({ requestId: 'a2', decision: 'approved', reasonCode: 'within_policy' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.decision.freshnessAtDecision).toBe('fresh');
    expect(outcome.decision.dataAgeSeconds).toBe(90);
    expect(outcome.decision.acknowledgedStale).toBe(false);
    expect(outcome.decision.request.reason).toBe('within_policy');
  });

  it('refuses a decision on stale data until the owner has been told it is stale', () => {
    const session = newSession([branch({ lastSyncedAt: STALE_SYNC })]);
    expect(session.decide({ requestId: 'a2', decision: 'approved', reasonCode: 'within_policy' }))
      .toEqual({ ok: false, refusal: 'stale_data_not_acknowledged' });
  });

  it('accepts it once acknowledged, and records that it WAS acknowledged', () => {
    // Not a block. An owner who cannot approve anything while travelling telephones instructions
    // instead, and a telephoned approval has no audit trail at all.
    const session = newSession([branch({ lastSyncedAt: STALE_SYNC })]);
    const outcome = session.decide({
      requestId: 'a2', decision: 'approved', reasonCode: 'within_policy', acknowledgeStale: true,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.decision.freshnessAtDecision).toBe('stale');
    expect(outcome.decision.acknowledgedStale).toBe(true);
    expect(outcome.decision.dataAgeSeconds).toBe(11 * 60 * 60);
  });

  it('BLOCKS a decision when nothing has ever synced, acknowledgement or not', () => {
    // `missing` is not old data, it is no data. An acknowledgement of nothing is not informed
    // consent, so there is nothing to acknowledge and no decision to make.
    const session = newSession([branch({ lastSyncedAt: null })]);
    for (const acknowledgeStale of [false, true]) {
      expect(session.decide({ requestId: 'a2', decision: 'approved', reasonCode: 'within_policy', acknowledgeStale }))
        .toEqual({ ok: false, refusal: 'no_data_at_all' });
    }
    expect(session.queued()).toHaveLength(0);
  });

  it('lets a tenant turn the acknowledgement off, but never the missing-data block', () => {
    // Choose-able per tenant: an owner who sits in the office all day may reasonably switch it off.
    const relaxed = newSession([branch({ lastSyncedAt: STALE_SYNC })], { acknowledgeStaleDecisions: false });
    const outcome = relaxed.decide({ requestId: 'a2', decision: 'approved', reasonCode: 'within_policy' });
    expect(outcome.ok).toBe(true);
    // The staleness is still recorded — turning the prompt off does not rewrite what happened.
    if (!outcome.ok) return;
    expect(outcome.decision.freshnessAtDecision).toBe('stale');

    const noData = newSession([branch({ lastSyncedAt: null })], { acknowledgeStaleDecisions: false });
    expect(noData.decide({ requestId: 'a2', decision: 'approved', reasonCode: 'within_policy' }))
      .toEqual({ ok: false, refusal: 'no_data_at_all' });
  });
});

describe('the rules that apply to everybody still apply to the owner', () => {
  it('refuses a reason outside the catalogue', () => {
    expect(newSession().decide({ requestId: 'a2', decision: 'approved', reasonCode: 'fine' }))
      .toEqual({ ok: false, refusal: 'unknown_reason_code' });
  });

  it('will not let the owner APPROVE something "against policy"', () => {
    expect(newSession().decide({ requestId: 'a2', decision: 'approved', reasonCode: 'against_policy' }))
      .toEqual({ ok: false, refusal: 'unknown_reason_code' });
  });

  it('refuses the owner deciding their own request (§28)', () => {
    // The one place separation of duties would be tempting to relax, and the one place it matters
    // most: there is nobody above the owner to catch it.
    const session = newSession([branch({
      approvals: [{ id: 'a9', subjectType: 'write_off', subjectRef: 'W-1', requestedBy: 'u-owner', valueMinor: 10_000 }],
    })]);
    expect(session.decide({ requestId: 'a9', decision: 'approved', reasonCode: 'within_policy' }))
      .toEqual({ ok: false, refusal: 'self_approval_forbidden' });
  });

  it('honours an owner\'s own approval limit — a limit that cannot bind is not a limit', () => {
    const capped = newSession([branch()], {
      owner: { userId: 'u-owner', branchScope: 'all', authorityLimit: { minor: 100_000, currency: 'INR' } },
    });
    expect(capped.decide({ requestId: 'a1', decision: 'approved', reasonCode: 'within_policy' }))
      .toEqual({ ok: false, refusal: 'exceeds_authority' });
    // Rejecting it is still fine. You do not need a budget to say no.
    expect(capped.decide({ requestId: 'a1', decision: 'rejected', reasonCode: 'ask_the_owner_first' }).ok).toBe(true);
  });

  it('refuses a request that is not on this branch\'s list', () => {
    expect(newSession().decide({ requestId: 'nope', decision: 'approved', reasonCode: 'within_policy' }))
      .toEqual({ ok: false, refusal: 'request_not_found' });
  });

  it('refuses the same request twice, so one approval cannot be queued two ways', () => {
    const session = newSession();
    expect(session.decide({ requestId: 'a2', decision: 'approved', reasonCode: 'within_policy' }).ok).toBe(true);
    expect(session.decide({ requestId: 'a2', decision: 'rejected', reasonCode: 'against_policy' }))
      .toEqual({ ok: false, refusal: 'request_not_found' });
    expect(session.queued()).toHaveLength(1);
  });

  it('takes a decided request out of the inbox, so it is not approved twice', () => {
    const session = newSession();
    expect(session.brief().approvals.map((a) => a.id)).toEqual(['a1', 'a2']);
    session.decide({ requestId: 'a1', decision: 'approved', reasonCode: 'within_policy' });
    expect(session.brief().approvals.map((a) => a.id)).toEqual(['a2']);
  });
});

describe('a queued decision can go out of date while it waits (§31.1)', () => {
  const PO = (valueMinor: number) => ({
    id: 'a1', subjectType: 'purchase_order', subjectRef: 'PO-9912',
    requestedBy: 'u-buyer', valueMinor,
  });

  /**
   * The real sequence, because anything less proves nothing: the owner decides on a train, the
   * phone is put away, **new data arrives**, and the session is rebuilt around the queue.
   */
  const decidedOnTheTrain = (thenSaw: number) => {
    const before = newSession([branch({ approvals: [PO(40_000_00)] })]);
    before.decide({ requestId: 'a1', decision: 'approved', reasonCode: 'within_policy' });
    const carried = before.queued();
    expect(carried).toHaveLength(1);
    return createOwnerSession(OWNER, [branch({ approvals: [PO(thenSaw)] })], now, carried);
  };

  it('carries the queue across a rebuild — a decision does not vanish with the screen', () => {
    // On a phone the app is killed constantly. A queue that lived only inside the session would
    // lose three approvals silently, which is the worst way for an approval to disappear.
    expect(decidedOnTheTrain(40_000_00).queued()).toHaveLength(1);
  });

  it('passes a decision through when the request still asks the same question', () => {
    const result = decidedOnTheTrain(40_000_00).reconcileQueued();
    expect(result.stillValid).toHaveLength(1);
    expect(result.needsAnotherLook).toHaveLength(0);
  });

  it('catches a request whose VALUE moved underneath the answer', () => {
    // A ₹40,000 approval quietly applying to a ₹90,000 request is the exact failure a
    // maker-checker exists to prevent.
    const result = decidedOnTheTrain(90_000_00).reconcileQueued();
    expect(result.stillValid).toHaveLength(0);
    expect(result.needsAnotherLook).toHaveLength(1);
    expect(result.needsAnotherLook[0]?.reason).toBe('request_changed');
    expect(result.needsAnotherLook[0]?.nowIs?.valueMinor).toBe(90_000_00);
    // And the owner's own answer is still there, unchanged, to be shown beside it.
    expect(result.needsAnotherLook[0]?.decision.request.status).toBe('approved');
  });

  it('catches a request that was withdrawn or decided by somebody else', () => {
    const before = newSession();
    before.decide({ requestId: 'a2', decision: 'approved', reasonCode: 'within_policy' });
    const after = createOwnerSession(OWNER, [branch({ approvals: [] })], now, before.queued());

    const result = after.reconcileQueued();
    expect(result.needsAnotherLook[0]?.reason).toBe('request_withdrawn');
    expect(result.needsAnotherLook[0]?.nowIs).toBeNull();
  });

  it('never drops a queued decision on its own — it comes back to the owner', () => {
    const session = decidedOnTheTrain(90_000_00);
    session.reconcileQueued();
    session.reconcileQueued();
    expect(session.queued()).toHaveLength(1);
    // Only an explicit act removes it, and only after the owner has been shown it.
    expect(session.discardQueued('a1')).toBe(true);
    expect(session.queued()).toHaveLength(0);
    expect(session.discardQueued('a1')).toBe(false);
  });

  it('keeps a decided request out of the inbox after a rebuild, so it is not decided twice', () => {
    // The queue is what remembers. Without it the rebuilt screen would show the same purchase
    // order as still waiting, and the owner would approve it a second time from a train.
    expect(decidedOnTheTrain(40_000_00).brief().approvals).toHaveLength(0);
  });
});

describe('the fingerprint is a control, so it cannot collide', () => {
  it('distinguishes two requests that concatenate to the same string', () => {
    // ('ab','c') and ('a','bc') are different requests. Plain concatenation says they are one.
    const left = fingerprintOf({ subjectType: 'ab', subjectRef: 'c', requestedBy: 'u', valueMinor: 1 });
    const right = fingerprintOf({ subjectType: 'a', subjectRef: 'bc', requestedBy: 'u', valueMinor: 1 });
    expect(left).not.toBe(right);
  });

  it('notices a value change, which is the whole point', () => {
    const base = { subjectType: 'po', subjectRef: 'PO-1', requestedBy: 'u-buyer' };
    expect(fingerprintOf({ ...base, valueMinor: 40_000_00 }))
      .not.toBe(fingerprintOf({ ...base, valueMinor: 90_000_00 }));
  });

  it('refuses a field carrying the separator rather than mangling it', () => {
    expect(() => fingerprintOf({
      subjectType: `po${String.fromCharCode(31)}x`, subjectRef: 'r', requestedBy: 'u', valueMinor: 1,
    })).toThrow(RangeError);
  });

  it('treats "no value" as a value, not as absent', () => {
    const base = { subjectType: 'po', subjectRef: 'PO-1', requestedBy: 'u-buyer' };
    expect(fingerprintOf({ ...base, valueMinor: null })).not.toBe(fingerprintOf({ ...base, valueMinor: 0 }));
  });
});

describe('any figure drills to the sales behind it (M29-FR-02, QG-02)', () => {
  it('adds up to exactly the KPI it drills — never a sample', () => {
    // A drill-through whose total differs from the figure it drills is a reporting system nobody
    // will trust again, and the disagreement is only ever found by the person being asked to act.
    const session = newSession();
    const kpis = session.brief().kpis;
    expect(session.drill('grossSales').totalMinor).toBe(kpis.grossSalesMinor);
    expect(session.drill('margin').totalMinor).toBe(kpis.marginMinor);
    expect(session.drill('baskets').lines).toHaveLength(kpis.basketCount);
  });

  it('lists every sale, largest contribution first', () => {
    const drill = newSession().drill('grossSales');
    expect(drill.lines.map((l) => l.saleId)).toEqual(['s2', 's1', 's3']);
    expect(drill.lines[0]?.tender).toBe('upi');
  });

  it('says when the COUNT is the answer rather than the money', () => {
    expect(newSession().drill('baskets').countIsTheAnswer).toBe(true);
    expect(newSession().drill('grossSales').countIsTheAnswer).toBe(false);
  });

  it('returns an empty drill for a branch with no sales, not an error', () => {
    const quiet = newSession([branch({ sales: [] })]);
    expect(quiet.drill('grossSales')).toMatchObject({ lines: [], totalMinor: 0 });
  });
});

describe('more than one branch, because the second store is a row and not a rewrite', () => {
  const two = [
    branch(),
    branch({ branchId: 'b2', name: 'SRE Express', lastSyncedAt: null, sales: [], approvals: [] }),
  ];

  it('reports each branch\'s freshness separately, including one that never synced', () => {
    const session = newSession(two);
    expect(session.branches().map((b) => [b.branchId, b.freshness.state]))
      .toEqual([['b1', 'fresh'], ['b2', 'missing']]);
  });

  it('switches branch, and refuses an unknown one instead of blanking the screen', () => {
    // A blank screen looks like a branch with no sales, which is a very different thing from a
    // branch that is not there.
    const session = newSession(two);
    expect(session.viewBranch('b2')).toBe(true);
    expect(session.currentBranchId()).toBe('b2');
    expect(session.viewBranch('b404')).toBe(false);
    expect(session.currentBranchId()).toBe('b2');
  });

  it('shows the branch in view, not a blend of all of them', () => {
    const session = newSession(two);
    expect(session.brief().kpis.basketCount).toBe(3);
    session.viewBranch('b2');
    expect(session.brief().kpis.basketCount).toBe(0);
  });

  it('refuses to build a session with no branches at all', () => {
    expect(() => createOwnerSession(OWNER, [], now)).toThrow(RangeError);
  });

  it('throws a named error when a payload is asked for and is not there', () => {
    expect(() => new UnknownBranchError('b9').message).not.toThrow();
    expect(new UnknownBranchError('b9').name).toBe('UnknownBranchError');
  });
});

describe('the brief still works with the AI off', () => {
  it('produces its headline and numbers with no narrative anywhere in the input', () => {
    // Spec acceptance: the deterministic numbers show whether or not a model answers.
    const brief = newSession().brief();
    expect(brief.headline).toMatch(/3 bills today/);
    expect(brief.kpis.grossSalesMinor).toBe(118_00 + 295_00 + 59_00);
    expect(Object.keys(brief)).not.toContain('narrative');
  });

  it('labels stale numbers in the headline rather than showing them as live', () => {
    const stale = newSession([branch({ lastSyncedAt: STALE_SYNC })]).brief();
    expect(stale.freshness.state).toBe('stale');
    expect(stale.headline).toMatch(/NOT live/i);
  });

  it('groups an alert storm into one line with a count', () => {
    const spike: LpException[] = Array.from({ length: 9 }, (_, i) => ({
      cashierId: 'u-meena', kind: 'void', breach: 'count', observed: 9, limit: 3,
      severity: 'escalate', linkedTxnIds: [`t-${i}`],
    }));
    const brief = newSession([branch({ exceptions: spike })]).brief();
    expect(brief.alerts).toHaveLength(1);
    expect(brief.alerts[0]?.linkedTxnIds).toHaveLength(9);
  });
});

describe('the refusal vocabulary is complete', () => {
  it('lists every refusal the session can actually return', () => {
    // The screen must have words for each of these; a guardrail walks this list against them.
    expect([...OWNER_DECIDE_REFUSALS].sort()).toEqual([
      'exceeds_authority', 'no_data_at_all', 'out_of_scope', 'reason_required',
      'request_not_found', 'self_approval_forbidden', 'stale_data_not_acknowledged',
      'unknown_reason_code',
    ]);
  });
});
