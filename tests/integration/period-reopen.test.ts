import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { approvedRequestId, askForApproval, decide } from '../support/approval-request';
import { approvalRequestsAdapter, financeAdapter } from '../../services/api/src/adapters';
import { financeRoutes, type FinanceDeps, type ControlTotalCheck } from '../../services/finance/src/index';

// M23-FR-04 period CLOSE/REOPEN §28 on the live API (hard rule #2). A signed month does not change on one
// person's say-so, and it is not certified by a name typed in a box: signing a close and approving a re-open
// are each an approval GIVEN in the signer's own session (ADR-0024 · 2b-vi-b-2, kinds `period_close` /
// `period_reopen`) by someone who holds `finance.period.sign` (the owner or the accountant/CA), who is not
// the one doing it and did not post into the month; a typed name is refused by name. Reopen is recorded as a NEW append-only fact (never an
// edit), after which the period is open and RE-CLOSABLE.
//
// The close route cannot reach a closed state through the real adapter (there is deliberately no second
// control-total source yet — "no month closes until one is fed in"), so: (a) the reopen precondition is
// seeded via the adapter's real `markClosed`, and reopen is driven end-to-end through the API; (b) the
// close-signer gate is exercised by driving the close route handler over a stub whose control totals
// reconcile — the only way to reach the success path where the signer authority is checked.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = () => '2026-09-04T00:00:00.000Z';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

const reopen = (h: ApiHarness, u: string, period: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/finance/periods/${period}/reopen`, userId: u, tenantId: A, idempotencyKey: key, body });
const close = (h: ApiHarness, u: string, period: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/finance/periods/${period}/close`, userId: u, tenantId: A, idempotencyKey: key, body });
const periods = (h: ApiHarness, u: string) =>
  h.request({ method: 'GET', path: '/v1/finance/periods', userId: u, tenantId: A });

const stateOf = (res: { body: unknown }, period: string): string | undefined =>
  (res.body as { periods: { period: string; state: string }[] }).periods.find((p) => p.period === period)?.state;

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');                    // finance.period.close + finance.period.sign + read
  await h.provisionRole(A, 'u-approver', 'accountant'); // finance.period.sign (may sign/approve, not close)
  await h.provisionRole(A, 'u-cash', 'cashier');        // none
  return h;
}

describe('period reopen (M23-FR-04): §28-approved by a genuine authority, append-only, re-closable', () => {
  it('reopens a closed period with a genuinely-authorised different approver, leaving it OPEN and RE-CLOSABLE — durably', async () => {
    const h = await cast();
    const fin = financeAdapter({ store: h.store, now: NOW });
    await fin.markClosed(A, '2026-08', 'u-signer'); // seed the signed period the close route would write

    expect(stateOf(await periods(h, 'u-owner'), '2026-08')).toBe('closed');

    const reason = 'August VAT restated after a supplier credit note';
    const approvalId = await approvedRequestId(h, A, 'u-owner', 'u-approver', { kind: 'period_reopen', subjectRef: '2026-08', details: { reason, period: '2026-08' } });
    const r = await reopen(h, 'u-owner', '2026-08', { reason, approvalId }, 'ro-1');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ state: 'open', reopenedBy: 'u-owner', approvedBy: 'u-approver' });
    expect(stateOf(await periods(h, 'u-owner'), '2026-08')).toBe('open'); // open again

    // The whole point of the rework: a reopened period can be closed AGAIN (a new close fact, not collapsed).
    await fin.markClosed(A, '2026-08', 'u-signer-2');
    expect(stateOf(await periods(h, 'u-owner'), '2026-08')).toBe('closed');

    // Durable across a restart.
    const h2 = apiHarness({ store: h.store });
    expect(stateOf(await periods(h2, 'u-owner'), '2026-08')).toBe('closed');
  });

  it('refuses a typed approver, and an approver who does not genuinely hold the authority', async () => {
    const h = await cast();
    const fin = financeAdapter({ store: h.store, now: NOW });
    await fin.markClosed(A, '2026-08', 'u-signer');
    const reason = 'restated after a credit note';

    // The audit's case: a name typed in the box — even of a real accountant — is not their approval.
    expect(codeOf(await reopen(h, 'u-owner', '2026-08', { approvedBy: 'u-approver', reason }, 'ro-typed'))).toBe('approver_named_without_approval');
    // A cashier (no finance.period.sign) cannot approve it at all.
    const asked = ((await askForApproval(h, A, 'u-owner', { kind: 'period_reopen', subjectRef: '2026-08', details: { reason, period: '2026-08' } })).body as { requestId: string }).requestId;
    expect((await decide(h, A, 'u-cash', asked)).status).toBe(403);
    // Still waiting → refused by name.
    expect(codeOf(await reopen(h, 'u-owner', '2026-08', { reason, approvalId: asked }, 'ro-waiting'))).toBe('approval_still_waiting');
    expect(stateOf(await periods(h, 'u-owner'), '2026-08')).toBe('closed'); // nothing reopened
  });

  it('refuses a self-approval, no approval, no reason, another reason, and an already-open period (§28)', async () => {
    const h = await cast();
    const fin = financeAdapter({ store: h.store, now: NOW });
    await fin.markClosed(A, '2026-08', 'u-signer');
    const reason = 'because the supplier credit note arrived late';

    // The requester cannot approve their own reopen (even though u-owner holds the authority).
    const own = ((await askForApproval(h, A, 'u-owner', { kind: 'period_reopen', subjectRef: '2026-08', details: { reason, period: '2026-08' } })).body as { requestId: string }).requestId;
    expect(codeOf(await decide(h, A, 'u-owner', own))).toBe('self_approval');
    // No approval / no reason.
    expect(codeOf(await reopen(h, 'u-owner', '2026-08', { reason }, 'ro-noapprover'))).toBe('reopen_needs_approval');
    expect(codeOf(await reopen(h, 'u-owner', '2026-08', {}, 'ro-noreason'))).toBe('reopen_needs_a_reason');
    // An approval of one reason does not reopen the month for another.
    expect((await decide(h, A, 'u-approver', own)).status).toBe(201);
    expect(codeOf(await reopen(h, 'u-owner', '2026-08', { reason: 'a different story', approvalId: own }, 'ro-other'))).toBe('approval_does_not_match');
    // Nothing to reopen — 2026-07 was never closed (and the approval is not spent by the refusal).
    const july = await approvedRequestId(h, A, 'u-owner', 'u-approver', { kind: 'period_reopen', subjectRef: '2026-07', details: { reason: 'x', period: '2026-07' } });
    expect(codeOf(await reopen(h, 'u-owner', '2026-07', { reason: 'x', approvalId: july }, 'ro-open'))).toBe('reopen_refused');
  });

  it('refuses closing an already-closed period, and gates reopen on finance.period.close', async () => {
    const h = await cast();
    const fin = financeAdapter({ store: h.store, now: NOW });
    await fin.markClosed(A, '2026-08', 'u-signer');

    // A period is not closed twice — it is reopened.
    expect(codeOf(await close(h, 'u-owner', '2026-08', {}, 'cl-again'))).toBe('already_closed');

    // A cashier holds no finance.period.close → refused on reopen (route-level, before the body is read).
    expect((await reopen(h, 'u-cash', '2026-08', { reason: 'x' }, 'ro-cash')).status).toBe(403);
  });
});

// The close route's success path is reachable only with reconciling control totals, which the real adapter
// deliberately does not produce (OA-12). Drive the handler over a stub to prove the signer gate — the signature
// itself is a real approval in the real engine, given by a real signed-in person.
describe('period close signer authority (M23-FR-04, §28)', () => {
  const reconciling: readonly ControlTotalCheck[] = [
    { name: 'Output GST', leftMinor: 123_45, rightMinor: 123_45, leftDerivation: 'sales ledger', rightDerivation: 'filed GSTR-1' },
  ];
  const closeRoute = (deps: FinanceDeps) =>
    financeRoutes(deps).find((r) => r.method === 'POST' && r.path === '/v1/finance/periods/:period/close')!;
  let h: ApiHarness;
  const stub = (over: Partial<FinanceDeps> = {}): FinanceDeps => ({
    periodStates: () => new Map(), nextOpenPeriod: () => '2026-08', appendJournal: () => {},
    controlTotals: () => reconciling, postersIn: () => [], markClosed: () => {}, markReopened: () => {},
    approvals: approvalRequestsAdapter({ store: h.store, now: NOW }), now: NOW, ...over,
  });
  const signature = async (signer: string) =>
    approvedRequestId(h, A, 'u-owner', signer, { kind: 'period_close', subjectRef: '2026-08', details: { period: '2026-08' } });
  const fresh = async () => {
    h = apiHarness();
    await h.seedOwner(A, 'u-owner');                   // closes
    await h.provisionRole(A, 'u-ca', 'accountant');    // signs
    await h.provisionRole(A, 'u-notca', 'store_manager'); // may not sign
  };
  async function callClose(deps: FinanceDeps, body: unknown, userId = 'u-owner'): Promise<{ status: number; code?: string }> {
    try {
      const res = await closeRoute(deps).handler({ tenantId: A, userId, branchId: null, params: { period: '2026-08' }, query: {}, body, traceId: 't' });
      return { status: res.status };
    } catch (e) {
      const err = e as { status: number; body?: { code?: string } };
      return { status: err.status, code: err.body?.code };
    }
  }

  it('closes when the signer signed in their own session (and did not post) — once', async () => {
    await fresh();
    let signed: string | undefined;
    const approvalId = await signature('u-ca');
    const res = await callClose(stub({ markClosed: (_t, _p, s) => { signed = s; } }), { approvalId });
    expect(res.status).toBe(200);
    expect(signed).toBe('u-ca');
    expect((await callClose(stub(), { approvalId })).code).toBe('approval_already_used');
  });

  it('refuses a typed signer, no signature, and a signer without the period-sign authority', async () => {
    await fresh();
    expect((await callClose(stub(), { signedBy: 'u-ca' })).code).toBe('approver_named_without_approval');
    expect((await callClose(stub(), {})).code).toBe('not_signed');
    const asked = ((await askForApproval(h, A, 'u-owner', { kind: 'period_close', subjectRef: '2026-08', details: { period: '2026-08' } })).body as { requestId: string }).requestId;
    expect((await decide(h, A, 'u-notca', asked)).status).toBe(403);
    expect(codeOf(await decide(h, A, 'u-owner', asked))).toBe('self_approval'); // the closer never signs their own close
  });

  it('still refuses a signer who posted into the month (§28 segregation), and leaves the signature unspent', async () => {
    await fresh();
    const approvalId = await signature('u-ca');
    // u-ca holds the authority, but posted into the month — the engine refuses the self-certification.
    expect((await callClose(stub({ postersIn: () => ['u-ca'] }), { approvalId })).code).toBe('closed_by_whoever_posted');
    expect((await callClose(stub(), { approvalId })).status).toBe(200);
  });
});
