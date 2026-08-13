import { describe, it, expect } from 'vitest';
import {
  foldPayRun,
  evaluatePayRunTransition,
  type PayRunEvent,
  type PayRunAggregate,
} from '../../packages/payroll/src/index';

const drafted: PayRunEvent = { kind: 'drafted', payPeriod: '2026-08', by: 'maker', at: '2026-08-28T10:00:00Z', netTotalMinor: 50_000_000, employeeCount: 12 };
const submitted: PayRunEvent = { kind: 'submitted', by: 'maker', at: '2026-08-28T10:05:00Z' };

describe('foldPayRun — append-only lifecycle', () => {
  it('folds draft → submitted → approved → locked', () => {
    const agg = foldPayRun('pr1', [
      drafted, submitted,
      { kind: 'approved', by: 'checker', at: '2026-08-28T11:00:00Z' },
      { kind: 'locked', at: '2026-08-28T11:30:00Z' },
    ])!;
    expect(agg.state).toBe('locked');
    expect(agg.submittedBy).toBe('maker');
    expect(agg.approvedBy).toBe('checker');
    expect(agg.lockedAt).toBe('2026-08-28T11:30:00Z');
    expect(agg.employeeCount).toBe(12);
  });

  it('IGNORES a self-approval in the fold (maker ≠ checker)', () => {
    const agg = foldPayRun('pr2', [drafted, submitted, { kind: 'approved', by: 'maker', at: 't' }])!;
    expect(agg.state).toBe('submitted'); // the self-approval did not apply
    expect(agg.approvedBy).toBeUndefined();
  });

  it('rejects back to draft and reverses only from locked', () => {
    const rejected = foldPayRun('pr3', [drafted, submitted, { kind: 'rejected', by: 'checker', at: 't', reason: 'wrong totals' }])!;
    expect(rejected.state).toBe('draft');
    expect(rejected.submittedBy).toBeUndefined();

    const reversed = foldPayRun('pr4', [
      drafted, submitted, { kind: 'approved', by: 'checker', at: 't1' }, { kind: 'locked', at: 't2' },
      { kind: 'reversed', by: 'owner', reason: 'duplicate run', at: 't3' },
    ])!;
    expect(reversed.state).toBe('reversed');
    expect(reversed.reversedReason).toBe('duplicate run');
  });

  it('ignores events before a draft and out-of-order transitions', () => {
    expect(foldPayRun('pr5', [submitted])).toBeUndefined(); // no draft yet
    const agg = foldPayRun('pr6', [drafted, { kind: 'approved', by: 'checker', at: 't' }])!;
    expect(agg.state).toBe('draft'); // approve before submit ignored
  });
});

describe('evaluatePayRunTransition — the guard', () => {
  const submittedRun: PayRunAggregate = { payRunId: 'x', payPeriod: '2026-08', state: 'submitted', submittedBy: 'maker', detail: '' };
  const approvedRun: PayRunAggregate = { ...submittedRun, state: 'approved', approvedBy: 'checker' };
  const lockedRun: PayRunAggregate = { ...approvedRun, state: 'locked', lockedAt: 't' };

  it('refuses when there is no run', () => {
    expect(evaluatePayRunTransition({ action: 'submit', actor: 'a' })).toMatchObject({ allowed: false, refusal: 'no_pay_run' });
  });

  it('allows submit only from draft', () => {
    const draftRun: PayRunAggregate = { payRunId: 'x', payPeriod: '2026-08', state: 'draft', detail: '' };
    expect(evaluatePayRunTransition({ current: draftRun, action: 'submit', actor: 'maker' }).allowed).toBe(true);
    expect(evaluatePayRunTransition({ current: submittedRun, action: 'submit', actor: 'maker' })).toMatchObject({ allowed: false, refusal: 'not_in_draft' });
  });

  it('enforces maker ≠ checker on approve and reject', () => {
    expect(evaluatePayRunTransition({ current: submittedRun, action: 'approve', actor: 'checker' }).allowed).toBe(true);
    expect(evaluatePayRunTransition({ current: submittedRun, action: 'approve', actor: 'maker' })).toMatchObject({ allowed: false, refusal: 'self_approval' });
    expect(evaluatePayRunTransition({ current: submittedRun, action: 'reject', actor: 'maker' })).toMatchObject({ allowed: false, refusal: 'self_approval' });
    expect(evaluatePayRunTransition({ current: submittedRun, action: 'reject', actor: 'checker' }).allowed).toBe(true);
  });

  it('locks only an approved run and reverses only a locked one with a reason', () => {
    expect(evaluatePayRunTransition({ current: approvedRun, action: 'lock', actor: 'owner' }).allowed).toBe(true);
    expect(evaluatePayRunTransition({ current: submittedRun, action: 'lock', actor: 'owner' })).toMatchObject({ allowed: false, refusal: 'not_approved' });
    expect(evaluatePayRunTransition({ current: lockedRun, action: 'reverse', actor: 'owner', reason: 'fix' }).allowed).toBe(true);
    expect(evaluatePayRunTransition({ current: lockedRun, action: 'reverse', actor: 'owner' })).toMatchObject({ allowed: false, refusal: 'reason_required' });
    expect(evaluatePayRunTransition({ current: approvedRun, action: 'reverse', actor: 'owner', reason: 'x' })).toMatchObject({ allowed: false, refusal: 'not_locked' });
  });
});
