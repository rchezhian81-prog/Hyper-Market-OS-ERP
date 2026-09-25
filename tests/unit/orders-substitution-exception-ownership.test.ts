import { describe, it, expect } from 'vitest';
import {
  routeException,
  ownerForKind,
  slaStatus,
  claim,
  release,
  reassign,
  escalate,
  sweepEscalations,
  mayApprove,
  resolveException,
  queueFor,
  DEFAULT_SLA,
  type SubstitutionException,
  type OwnedException,
} from '../../packages/orders/src/index';

// M19 / D09 (owner decision) — ownership, SLA and escalation for delivery-substitution exceptions.
// The derived exception (substitution-exceptions.ts) becomes an OWNED item routed to a ROLE queue, with
// an SLA clock, breach-driven escalation and an append-only trail, so nothing disappears when a shift
// ends and a picker can propose but never approve a restricted exception (SoD, §28).

const ex = (over: Partial<SubstitutionException>): SubstitutionException => ({
  orderId: 'o1',
  lineId: 'l1',
  kind: 'refund_due',
  amountMinor: 2_000,
  detail: 'refund of 2000 due to the customer (prepaid)',
  ...over,
});

const route = (over: Partial<SubstitutionException>, opts?: { at?: string; id?: string; proposedBy?: string }): OwnedException =>
  routeException({
    exception: ex(over),
    tenantId: 't1',
    exceptionId: opts?.id ?? 'e1',
    raisedAt: opts?.at ?? '2026-09-25T09:00:00.000Z',
    by: 'system',
    ...(opts?.proposedBy === undefined ? {} : { proposedBy: opts.proposedBy }),
  });

describe('ownerForKind — the owner decision, encoded (M19 / D09)', () => {
  it('sends money exceptions to the finance/payment-reconciliation queue', () => {
    expect(ownerForKind('refund_due')).toBe('finance_recon_queue');
    expect(ownerForKind('collect_adjustment')).toBe('finance_recon_queue');
    expect(ownerForKind('above_cap_charge')).toBe('finance_recon_queue');
  });

  it('sends a short-picked line (the customer got less) to the customer-service desk', () => {
    expect(ownerForKind('policy_short_pick')).toBe('customer_service_desk');
  });
});

describe('routeException — a derived exception becomes an owned, durable, audited item', () => {
  it('routes to the right role queue and records the routing as the first audit event', () => {
    const owned = route({ kind: 'refund_due', amountMinor: 2_000 });
    expect(owned.owner).toBe('finance_recon_queue');
    expect(owned.state).toBe('open');
    expect(owned.assignedTo).toBeUndefined();
    expect(owned.reasonCode).toBe('SUB-REFUND-DUE');
    expect(owned.history).toHaveLength(1);
    expect(owned.history[0]).toMatchObject({ op: 'routed', toOwner: 'finance_recon_queue' });
  });

  it('records the proposing picker but never as the approver', () => {
    const owned = route({ kind: 'policy_short_pick', amountMinor: 0 }, { proposedBy: 'picker-42' });
    expect(owned.proposedBy).toBe('picker-42');
    expect(owned.owner).toBe('customer_service_desk');
  });

  it('honours a caller-supplied reason code over the default', () => {
    const owned = routeException({
      exception: ex({}),
      tenantId: 't1',
      exceptionId: 'e1',
      raisedAt: '2026-09-25T09:00:00.000Z',
      by: 'system',
      reasonCode: 'SUB-CUSTOM-01',
    });
    expect(owned.reasonCode).toBe('SUB-CUSTOM-01');
  });
});

describe('slaStatus — a stale exception is VISIBLE, not silent (P-08)', () => {
  it('reads within-SLA before the clock runs out', () => {
    const owned = route({ kind: 'refund_due' }); // finance SLA = 120m
    const s = slaStatus(owned, DEFAULT_SLA, '2026-09-25T10:00:00.000Z'); // +60m
    expect(s.ageMinutes).toBe(60);
    expect(s.breached).toBe(false);
  });

  it('reads breached once past the owner SLA', () => {
    const owned = route({ kind: 'policy_short_pick' }); // CS desk SLA = 30m
    const s = slaStatus(owned, DEFAULT_SLA, '2026-09-25T09:45:00.000Z'); // +45m
    expect(s.breached).toBe(true);
  });

  it('a resolved item never reads as breached — its clock has stopped', () => {
    const owned = route({ kind: 'policy_short_pick' });
    const r = resolveException({ owned, by: 'cs-1', byRole: 'customer_service_desk', now: '2026-09-25T09:10:00.000Z' });
    const s = slaStatus(r.owned, DEFAULT_SLA, '2026-09-26T09:00:00.000Z'); // a full day later
    expect(s.breached).toBe(false);
  });
});

describe('claim / release / reassign — a queue item is worked, or returns to the role', () => {
  it('a named person claims an open item, which moves to in_progress', () => {
    const owned = route({ kind: 'refund_due' });
    const c = claim(owned, 'fin-anita', '2026-09-25T09:05:00.000Z');
    expect(c.assignedTo).toBe('fin-anita');
    expect(c.state).toBe('in_progress');
    expect(c.history.at(-1)).toMatchObject({ op: 'claimed', by: 'fin-anita' });
  });

  it('release puts a claimed item back into its role queue — it never vanishes on shift end', () => {
    const claimed = claim(route({ kind: 'refund_due' }), 'fin-anita', '2026-09-25T09:05:00.000Z');
    const released = release(claimed, 'fin-anita', '2026-09-25T17:00:00.000Z', 'shift_end');
    expect(released.assignedTo).toBeUndefined();
    expect(released.state).toBe('open');
    expect(released.owner).toBe('finance_recon_queue'); // still owned by the role
    expect(released.history.at(-1)).toMatchObject({ op: 'released', reasonCode: 'shift_end' });
  });

  it('reassign moves the item to a different role queue and clears any personal claim', () => {
    const claimed = claim(route({ kind: 'refund_due' }), 'fin-anita', '2026-09-25T09:05:00.000Z');
    const moved = reassign(claimed, 'duty_manager', 'mgr-ravi', '2026-09-25T09:30:00.000Z', 'needs_manager_sign_off');
    expect(moved.owner).toBe('duty_manager');
    expect(moved.assignedTo).toBeUndefined();
    expect(moved.state).toBe('open');
    expect(moved.history.at(-1)).toMatchObject({ op: 'reassigned', toOwner: 'duty_manager', reasonCode: 'needs_manager_sign_off' });
  });
});

describe('escalate — a breach moves the item up; duty_manager is terminal', () => {
  it('a within-SLA item is left where it is', () => {
    const owned = route({ kind: 'refund_due' }); // finance SLA = 120m
    const r = escalate(owned, DEFAULT_SLA, '2026-09-25T10:00:00.000Z', 'sweeper'); // +60m
    expect(r.escalated).toBe(false);
    expect(r.owned.owner).toBe('finance_recon_queue');
  });

  it('a breached customer-service item escalates to the fulfilment supervisor', () => {
    const owned = route({ kind: 'policy_short_pick' }); // CS desk SLA = 30m
    const r = escalate(owned, DEFAULT_SLA, '2026-09-25T09:45:00.000Z', 'sweeper'); // +45m
    expect(r.escalated).toBe(true);
    expect(r.owned.owner).toBe('fulfilment_supervisor');
    expect(r.owned.history.at(-1)).toMatchObject({ op: 'escalated', toOwner: 'fulfilment_supervisor' });
  });

  it('a breached finance item escalates to the duty manager, which is terminal', () => {
    const owned = route({ kind: 'refund_due' }); // finance SLA = 120m
    const atDuty = escalate(owned, DEFAULT_SLA, '2026-09-25T12:00:00.000Z', 'sweeper'); // +180m
    expect(atDuty.owned.owner).toBe('duty_manager');
    // Past even the duty-manager SLA there is nowhere higher to go — it stays and stays visible.
    const stillDuty = escalate(atDuty.owned, DEFAULT_SLA, '2026-09-26T09:00:00.000Z', 'sweeper');
    expect(stillDuty.escalated).toBe(false);
    expect(stillDuty.owned.owner).toBe('duty_manager');
  });

  it('a resolved item is never escalated', () => {
    const owned = route({ kind: 'policy_short_pick' });
    const r = resolveException({ owned, by: 'cs-1', byRole: 'customer_service_desk', now: '2026-09-25T09:10:00.000Z' });
    const e = escalate(r.owned, DEFAULT_SLA, '2026-09-26T09:00:00.000Z', 'sweeper');
    expect(e.escalated).toBe(false);
  });

  it('sweepEscalations escalates every breached item and reports which ids moved', () => {
    const breached = route({ kind: 'policy_short_pick' }, { id: 'e-breached', at: '2026-09-25T09:00:00.000Z' }); // CS, 30m
    const fresh = route({ kind: 'refund_due' }, { id: 'e-fresh', at: '2026-09-25T09:40:00.000Z' }); // finance, 120m
    const { owneds, escalatedIds } = sweepEscalations([breached, fresh], DEFAULT_SLA, '2026-09-25T09:45:00.000Z', 'sweeper');
    expect(escalatedIds).toEqual(['e-breached']);
    expect(owneds.find((o) => o.exceptionId === 'e-breached')?.owner).toBe('fulfilment_supervisor');
    expect(owneds.find((o) => o.exceptionId === 'e-fresh')?.owner).toBe('finance_recon_queue');
  });
});

describe('separation of duties — a picker proposes but never approves (SoD, §28)', () => {
  it('mayApprove is false for a picker and true for every owner role', () => {
    expect(mayApprove('picker')).toBe(false);
    expect(mayApprove('fulfilment_supervisor')).toBe(true);
    expect(mayApprove('customer_service_desk')).toBe(true);
    expect(mayApprove('finance_recon_queue')).toBe(true);
    expect(mayApprove('duty_manager')).toBe(true);
  });

  it('a picker cannot resolve a restricted exception — and the refusal is RECORDED, not silent', () => {
    const owned = route({ kind: 'refund_due' }, { proposedBy: 'picker-42' });
    const r = resolveException({ owned, by: 'picker-42', byRole: 'picker', now: '2026-09-25T09:10:00.000Z' });
    expect(r.resolved).toBe(false);
    expect(r.refusal).toBe('picker_may_not_approve');
    expect(r.owned.state).toBe('open'); // still open, still owed to someone who can approve
    expect(r.owned.history.at(-1)).toMatchObject({ op: 'resolve_refused', by: 'picker-42' });
  });

  it('an owner role resolves it, and resolving again is refused as already_resolved', () => {
    const owned = route({ kind: 'refund_due' });
    const first = resolveException({ owned, by: 'fin-anita', byRole: 'finance_recon_queue', now: '2026-09-25T09:20:00.000Z', reasonCode: 'REFUND-ISSUED' });
    expect(first.resolved).toBe(true);
    expect(first.owned.state).toBe('resolved');
    expect(first.owned.history.at(-1)).toMatchObject({ op: 'resolved', reasonCode: 'REFUND-ISSUED' });
    const again = resolveException({ owned: first.owned, by: 'fin-anita', byRole: 'finance_recon_queue', now: '2026-09-25T09:30:00.000Z' });
    expect(again.resolved).toBe(false);
    expect(again.refusal).toBe('already_resolved');
  });
});

describe('queueFor — the open worklist for one role in one tenant, worst-first', () => {
  it('shows only open items for that role and tenant, largest money first then oldest', () => {
    const a = route({ kind: 'refund_due', amountMinor: 1_000 }, { id: 'a', at: '2026-09-25T09:00:00.000Z' });
    const b = route({ kind: 'refund_due', amountMinor: 9_000 }, { id: 'b', at: '2026-09-25T09:30:00.000Z' });
    const c = route({ kind: 'refund_due', amountMinor: 9_000 }, { id: 'c', at: '2026-09-25T08:00:00.000Z' }); // same money, older → first
    const other = route({ kind: 'policy_short_pick', amountMinor: 5_000 }, { id: 'd' }); // CS desk, not finance
    const q = queueFor([a, b, c, other], 't1', 'finance_recon_queue');
    expect(q.map((o) => o.exceptionId)).toEqual(['c', 'b', 'a']);
  });

  it('a resolved item leaves the queue; an unresolved one stays even after the working shift ends', () => {
    const owned = route({ kind: 'refund_due' }, { id: 'stays' });
    // A worker claims it, then their shift ends and access is lost → released back to the role queue.
    const claimed = claim(owned, 'fin-anita', '2026-09-25T09:05:00.000Z');
    const afterShift = release(claimed, 'system', '2026-09-25T17:00:00.000Z', 'access_revoked');
    // The next shift still finds it in the finance queue — nothing disappeared.
    const q = queueFor([afterShift], 't1', 'finance_recon_queue');
    expect(q).toHaveLength(1);
    expect(q[0]?.exceptionId).toBe('stays');
  });

  it('does not leak another tenant\'s items into the queue', () => {
    const mine = route({ kind: 'refund_due' }, { id: 'mine' });
    const theirs: OwnedException = { ...route({ kind: 'refund_due' }, { id: 'theirs' }), tenantId: 't2' };
    const q = queueFor([mine, theirs], 't1', 'finance_recon_queue');
    expect(q.map((o) => o.exceptionId)).toEqual(['mine']);
  });
});
