import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { financeAdapter } from '../../services/api/src/adapters';

// M23-FR-04 period REOPEN on the live API (§28 / hard rule #2). A signed month does not change on one
// person's say-so: reopening needs an approval by SOMEONE OTHER THAN the requester and a written reason,
// recorded as a NEW append-only fact (never an edit), after which the period is open and RE-CLOSABLE.
//
// The close route itself can't reach a closed state through the real adapter (there is deliberately no
// second control-total source yet — "no month closes until one is fed in"), so the closed precondition is
// seeded via the adapter's real `markClosed` persistence path — the exact event the close route writes on
// success — and reopen is then driven end to end through the API. Gated finance.period.close.

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
  await h.seedOwner(A, 'u-owner');                // finance.period.close + finance.period.read
  await h.provisionRole(A, 'u-cash', 'cashier');  // none
  return h;
}

describe('period reopen (M23-FR-04): §28-approved, append-only, re-closable', () => {
  it('reopens a closed period with a different approver, leaving it OPEN and RE-CLOSABLE — durably', async () => {
    const h = await cast();
    const fin = financeAdapter({ store: h.store, now: NOW });
    await fin.markClosed(A, '2026-08', 'u-signer'); // seed the signed period the close route would write

    expect(stateOf(await periods(h, 'u-owner'), '2026-08')).toBe('closed');

    const r = await reopen(h, 'u-owner', '2026-08', { approvedBy: 'u-approver', reason: 'August VAT restated after a supplier credit note' }, 'ro-1');
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

  it('refuses a self-approval, a missing approver/reason, and an already-open period (§28)', async () => {
    const h = await cast();
    const fin = financeAdapter({ store: h.store, now: NOW });
    await fin.markClosed(A, '2026-08', 'u-signer');

    // The requester cannot approve their own reopen.
    expect(codeOf(await reopen(h, 'u-owner', '2026-08', { approvedBy: 'u-owner', reason: 'because' }, 'ro-self'))).toBe('reopen_refused');
    // Missing approver / reason.
    expect(codeOf(await reopen(h, 'u-owner', '2026-08', { reason: 'x' }, 'ro-noapprover'))).toBe('reopen_needs_approver_and_reason');
    expect(codeOf(await reopen(h, 'u-owner', '2026-08', { approvedBy: 'u-approver' }, 'ro-noreason'))).toBe('reopen_needs_approver_and_reason');
    // Nothing to reopen — 2026-07 was never closed.
    expect(codeOf(await reopen(h, 'u-owner', '2026-07', { approvedBy: 'u-approver', reason: 'x' }, 'ro-open'))).toBe('reopen_refused');
  });

  it('refuses closing an already-closed period, and gates reopen on finance.period.close', async () => {
    const h = await cast();
    const fin = financeAdapter({ store: h.store, now: NOW });
    await fin.markClosed(A, '2026-08', 'u-signer');

    // A period is not closed twice — it is reopened.
    expect(codeOf(await close(h, 'u-owner', '2026-08', { signedBy: 'u-ca' }, 'cl-again'))).toBe('already_closed');

    // A cashier holds no finance.period.close → refused on reopen.
    expect((await reopen(h, 'u-cash', '2026-08', { approvedBy: 'u-approver', reason: 'x' }, 'ro-cash')).status).toBe(403);
  });
});
