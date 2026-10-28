import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { P3, p3Shop, caller, issuedOrder, received, capturedAndMatched } from '../support/p3-purchase';
import { askForApproval, decide } from '../support/approval-request';

/**
 * **OB-412 (owner, 27 Oct 2026, in writing: "confirmed as built"), rules 1 and 2, on the real API.**
 *   1. A claim under a scheme Finance has NOT yet approved is shown with a warning (`scheme_not_approved`), not refused.
 *   2. Withdrawing a claim already SENT needs a reason but no second approval. It is a compensating fact: the claim reads
 *      "withdrawn", what it still asked for may be claimed again, and it is never matched or sent again.
 * (Rule 3, the supplier seeing its own sent claims, is proved in `a-rebate-claim-is-approved-by-finance-sent-and-matched`.)
 * In memory and, with DATABASE_URL, on real PostgreSQL. Synthetic data.
 */

const backings = useRestartableBackings();
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const TODAY = new Date().toISOString().slice(0, 10);

interface Ask { kind: string; subjectRef: string; valueMinor: number; details: Record<string, unknown>; summary: string; reason: string }
interface ClaimRow { claimId: string; state: string; unansweredMinor: number; findings: string[]; approvalAsk?: Ask }
interface Register {
  schemes: { schemeId: string; approved: boolean; claimableMinor: number; openClaimedMinor: number; findings: string[] }[];
  claims: ClaimRow[];
}

describe.each(backings)('OB-412 — an unapproved scheme warns, never refuses; a sent claim is withdrawn with a reason alone — on $name', ({ harness }) => {
  it('raises a claim under a scheme Finance has not approved, with the warning; withdraws a sent claim with a reason and no second approval', async () => {
    const h = harness();
    const T = randomUUID();
    await p3Shop(h, T, 'sup-1');
    const call = caller(h, T);
    const reg = async (): Promise<Register> => {
      const r = await call('GET', '/v1/purchase/rebate-claims', P3.BUYER);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body as Register;
    };

    // ₹800 of matched bills from sup-1 → a 3% scheme earns ₹24.
    for (const [id, qty] of [['a', 10], ['b', 6]] as const) {
      const lines = [{ productId: 'rice', qty, unitMinor: 5_000 }];
      await issuedOrder(call, `po-${id}`, lines);
      await received(call, `grn-${id}`, `po-${id}`, lines);
      await capturedAndMatched(call, `inv-${id}`, `po-${id}`, lines, undefined, 'sup-1', TODAY);
    }

    // ── RULE 1: the scheme is recorded WITHOUT Finance's approval. It is shown, with the warning by name.
    const scheme = { supplierId: 'sup-1', basis: 'purchase_value', rateBp: 300, startsOn: `${TODAY.slice(0, 4)}-01-01`, endsOn: `${TODAY.slice(0, 4)}-12-31` };
    const recorded = await call('POST', '/v1/purchase/rebate-schemes/rb-u', P3.OWNER, scheme, 'scheme-rb-u');
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(201);
    expect((await call('POST', '/v1/purchase/rebate-schemes/rb-u/accruals/q', P3.OWNER, { periodFrom: `${TODAY.slice(0, 4)}-01-01`, periodTo: TODAY })).status).toBe(201);
    const before = (await reg()).schemes.find((s) => s.schemeId === 'rb-u')!;
    expect(before).toMatchObject({ approved: false, claimableMinor: 2_400 });
    expect(before.findings).toContain('scheme_not_approved');

    // A claim under it is RAISED (201), not refused, and the scheme still carries the warning.
    const raise = (claimId: string, amountMinor: number) => call('POST', `/v1/purchase/rebate-schemes/rb-u/claims/${claimId}`, P3.BUYER, { amountMinor }, `raise-${randomUUID()}`);
    const raised = await raise('c-1', 1_500);
    expect(raised.status, JSON.stringify(raised.body)).toBe(201);
    const after = await reg();
    expect(after.schemes.find((s) => s.schemeId === 'rb-u')!.findings).toContain('scheme_not_approved');
    expect(after.claims.find((c) => c.claimId === 'c-1')).toMatchObject({ state: 'raised' });

    // ── RULE 2: the claim is approved by Finance and SENT; then withdrawn with a reason, and nothing else.
    const ask = (raised.body as { approvalAsk: Ask }).approvalAsk;
    const asked = await askForApproval(h, T, P3.BUYER, ask);
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    const requestId = (asked.body as { requestId: string }).requestId;
    expect((await decide(h, T, P3.MATCHER, requestId)).status).toBe(201);
    const sent = await call('POST', '/v1/purchase/rebate-claims/c-1/send', P3.BUYER, { sentOn: TODAY, approvalId: requestId }, `send-${randomUUID()}`);
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    expect((await reg()).claims.find((c) => c.claimId === 'c-1')).toMatchObject({ state: 'sent', unansweredMinor: 1_500 });

    // No reason → refused by name. With a reason → withdrawn by the buyer alone: no approval is asked for or named.
    expect(codeOf(await call('POST', '/v1/purchase/rebate-claims/c-1/withdraw', P3.BUYER, {}))).toBe('withdrawal_needs_a_reason');
    const withdrawn = await call('POST', '/v1/purchase/rebate-claims/c-1/withdraw', P3.BUYER, { reason: 'supplier disputes the period; raise again for Q4' });
    expect(withdrawn.status, JSON.stringify(withdrawn.body)).toBe(201);
    const end = await reg();
    expect(end.claims.find((c) => c.claimId === 'c-1')).toMatchObject({ state: 'withdrawn', unansweredMinor: 0 });
    // What it asked for may be claimed again; the withdrawn claim is never sent again.
    expect(end.schemes.find((s) => s.schemeId === 'rb-u')).toMatchObject({ openClaimedMinor: 0, claimableMinor: 2_400 });
    expect(codeOf(await call('POST', '/v1/purchase/rebate-claims/c-1/send', P3.BUYER, { sentOn: TODAY, approvalId: requestId }, `send-${randomUUID()}`))).toBe('claim_withdrawn');
    // Withdrawing it again changes nothing.
    expect((await call('POST', '/v1/purchase/rebate-claims/c-1/withdraw', P3.BUYER, { reason: 'again' })).status).toBeLessThan(300);
    expect((await reg()).claims.filter((c) => c.claimId === 'c-1')).toHaveLength(1);
  });
});
