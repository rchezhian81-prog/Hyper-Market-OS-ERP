import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Payroll pay-run lifecycle evaluate (WP3 inc4): fold the append-only events and say whether the proposed
// transition is allowed — maker ≠ checker, lock is final, correction-by-reversal. Confidential — owner-gated.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const drafted = { kind: 'drafted', payPeriod: '2026-08', by: 'maker', at: '2026-08-28T10:00:00Z' };
const submitted = { kind: 'submitted', by: 'maker', at: '2026-08-28T10:05:00Z' };

const evalRun = (h: ApiHarness, u: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: '/v1/hr/payroll/pay-run/evaluate', userId: u, tenantId: A, idempotencyKey: key, body });

describe('POST /v1/hr/payroll/pay-run/evaluate', () => {
  it('allows a different person to approve, and refuses the submitter approving their own run', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const events = [drafted, submitted];
    const ok = (await evalRun(h, 'u-owner', { payRunId: 'pr1', events, action: 'approve', actor: 'checker' }, 'r1')).body as { decision: { allowed: boolean } };
    expect(ok.decision.allowed).toBe(true);
    const self = (await evalRun(h, 'u-owner', { payRunId: 'pr1', events, action: 'approve', actor: 'maker' }, 'r2')).body as { decision: { allowed: boolean; refusal: string } };
    expect(self.decision.allowed).toBe(false);
    expect(self.decision.refusal).toBe('self_approval');
  });

  it('requires a reason to reverse a locked run', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const locked = [drafted, submitted, { kind: 'approved', by: 'checker', at: 't1' }, { kind: 'locked', at: 't2' }];
    const noReason = (await evalRun(h, 'u-owner', { payRunId: 'pr2', events: locked, action: 'reverse', actor: 'owner' }, 'r3')).body as { current: { state: string }; decision: { allowed: boolean; refusal: string } };
    expect(noReason.current.state).toBe('locked');
    expect(noReason.decision).toMatchObject({ allowed: false, refusal: 'reason_required' });
    const withReason = (await evalRun(h, 'u-owner', { payRunId: 'pr2', events: locked, action: 'reverse', actor: 'owner', reason: 'duplicate' }, 'r4')).body as { decision: { allowed: boolean } };
    expect(withReason.decision.allowed).toBe(true);
  });

  it('refuses malformed input and gates on the confidential permission', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier'); // no payroll.statutory.read
    expect((await evalRun(h, 'u-owner', { payRunId: 'pr3', events: [drafted] }, 'r5')).status).toBe(400); // no action/actor
    expect((await evalRun(h, 'u-cash', { payRunId: 'pr3', events: [drafted, submitted], action: 'approve', actor: 'checker' }, 'r6')).status).toBe(403);
  });
});
