import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ApiHarness } from '../support/api-harness';
import { sentWithApproval } from '../support/approval-request';
import { useRestartableBackings } from '../support/p3-backings';
import { P3, p3Shop, caller, issuedOrder, received, capturedAndMatched, type Call } from '../support/p3-purchase';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/index';

// M06-FR-03 (D03-FR-03 · M23) — supplier rebates, the money the shop has EARNED and not yet collected, with nothing typed
// (OB-288 P3): the basis of an accrual is FOLDED from the supplier's matched invoices for the period it names; finance
// records each rebate receipt as a journal through the accountant's mapping; the outstanding figure is accrued − what the
// LEDGER holds, and finance's reconciliation reads both sides. Recording gated purchase.contract.manage (receipts
// finance.journal.post); reads purchase.commitment.read / finance.period.read. In memory and — with DATABASE_URL — on
// real PostgreSQL, with a cold restart.

const backings = useRestartableBackings();
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
type Accrual = { accrued: { minor: number }; basisAmount: { minor: number }; thresholdMet: boolean; detail: string; basisSources: { invoices: string[] } };
const accrualOf = (res: { body: unknown }): Accrual => (res.body as { accrual: Accrual }).accrual;

const scheme = (over: Record<string, unknown> = {}) =>
  ({ supplierId: 'sup-1', basis: 'purchase_value', rateBp: 300, thresholdMinor: 60_000, startsOn: '2026-01-01', endsOn: '2026-12-31', ...over });
const MAP = { rules: [...DEFAULT_RETAIL_POSTING_MAP.rules, { kind: 'supplier_rebate', legs: [{ account: 'bank_clearing', side: 'debit', component: 'amount' }, { account: 'supplier_rebate_income', side: 'credit', component: 'amount' }] }] };

/** Four bills from sup-1: ₹500 (10 Mar) and ₹300 (20 Mar) matched clean; ₹1,000 (25 Mar) BLOCKED (only 4 of 10 arrived); ₹400 (1 May). */
async function bills(h: ApiHarness, T: string): Promise<Call> {
  await p3Shop(h, T);
  const call = caller(h, T);
  const plan: [string, number, number, string][] = [['a', 10, 5_000, '2026-03-10'], ['b', 6, 5_000, '2026-03-20'], ['c', 10, 10_000, '2026-03-25'], ['d', 8, 5_000, '2026-05-01']];
  for (const [id, qty, unit, date] of plan) {
    const lines = [{ productId: 'rice', qty, unitMinor: unit }];
    await issuedOrder(call, `po-${id}`, lines);
    await received(call, `grn-${id}`, `po-${id}`, id === 'c' ? [{ productId: 'rice', qty: 4, unitMinor: unit }] : lines);
    await capturedAndMatched(call, `inv-${id}`, `po-${id}`, lines, undefined, 'sup-1', date);
  }
  return call;
}

describe.each(backings)('supplier rebates (M06-FR-03) — on $name', ({ harness }) => {
  it('accrues on the matched invoices of the period only — never a typed basis — and finance\'s receipts, journaled, are the received side; a restart reads the same', async () => {
    const h = harness();
    const T = randomUUID();
    const call = await bills(h, T);
    expect((await call('POST', '/v1/purchase/rebate-schemes/rb-1', P3.OWNER, scheme())).status).toBe(201);

    // A typed basis, baseline or "received" is refused by name; a period outside the scheme too.
    expect(codeOf(await call('POST', '/v1/purchase/rebate-schemes/rb-1/accruals/q1', P3.OWNER, { periodFrom: '2026-01-01', periodTo: '2026-03-31', basisAmount: { minor: 9_000_000, currency: 'INR' } }))).toBe('accrual_carries_caller_claims');
    expect(codeOf(await call('POST', '/v1/purchase/rebate-schemes/rb-1/accruals/q1', P3.OWNER, { periodFrom: '2025-12-01', periodTo: '2026-03-31' }))).toBe('period_outside_the_scheme');
    expect((await call('POST', '/v1/purchase/rebate-schemes/rb-1/accruals/q1', P3.CASHIER, { periodFrom: '2026-01-01', periodTo: '2026-03-31' })).status).toBe(403);

    // Q1: the two clean bills (₹800) — the blocked one is not paid for, the May one is outside. 3% = ₹24.
    const q1 = await call('POST', '/v1/purchase/rebate-schemes/rb-1/accruals/q1', P3.OWNER, { periodFrom: '2026-01-01', periodTo: '2026-03-31' });
    expect(q1.status).toBe(201);
    expect(accrualOf(q1)).toMatchObject({ basisAmount: { minor: 80_000 }, accrued: { minor: 2_400 }, thresholdMet: true });
    expect(accrualOf(q1).basisSources.invoices.sort()).toEqual(['inv-a', 'inv-b']);

    // FINANCE records what the supplier paid, as a journal: refused until the accountant maps it; never above what was earned.
    expect(codeOf(await call('POST', '/v1/finance/rebate-receipts/rb-1/receipts/r1', P3.MATCHER, { amountMinor: 2_000, receivedOn: '2026-04-05', reference: 'NEFT-1' }))).toBe('supplier_rebate_not_mapped');
    expect((await h.request({ method: 'PUT', path: '/v1/finance/posting-map', userId: P3.MATCHER, tenantId: T, idempotencyKey: 'map', body: MAP })).status).toBeLessThan(300);
    expect(codeOf(await call('POST', '/v1/finance/rebate-receipts/rb-1/receipts/r9', P3.MATCHER, { amountMinor: 2_401, receivedOn: '2026-04-05', reference: 'NEFT-9' }))).toBe('receipt_exceeds_accrued');
    expect((await call('POST', '/v1/finance/rebate-receipts/rb-1/receipts/r1', P3.BUYER, { amountMinor: 2_000, receivedOn: '2026-04-05', reference: 'NEFT-1' })).status).toBe(403);
    const r1 = await call('POST', '/v1/finance/rebate-receipts/rb-1/receipts/r1', P3.MATCHER, { amountMinor: 2_000, receivedOn: '2026-04-05', reference: 'NEFT-1' });
    expect(r1.status).toBe(201);
    expect(r1.body).toMatchObject({ outstandingMinor: 400, alreadyRecorded: false });
    expect(((await call('POST', '/v1/finance/rebate-receipts/rb-1/receipts/r1', P3.MATCHER, { amountMinor: 2_000, receivedOn: '2026-04-05', reference: 'NEFT-1' })).body as { alreadyRecorded: boolean }).alreadyRecorded).toBe(true);

    // The purchase side reads its "received" from the ledger.
    expect((await call('GET', '/v1/purchase/rebate-schemes/rb-1/accruals', P3.OWNER)).body).toMatchObject({ totalAccruedMinor: 2_400, totalReceivedMinor: 2_000, receivedFrom: 'finance_ledger', outstandingMinor: 400 });
    // Finance's reconciliation: accrued, received, outstanding, and the income the ledger holds — they agree to the paisa.
    const rec = (await call('GET', '/v1/finance/rebate-receipts', P3.MATCHER)).body as { agrees: boolean; lines: { schemeId: string; accruedMinor: number; receivedMinor: number; ledgerMinor: number; outstandingMinor: number }[] };
    expect(rec.agrees).toBe(true);
    expect(rec.lines.find((l) => l.schemeId === 'rb-1')).toMatchObject({ accruedMinor: 2_400, receivedMinor: 2_000, ledgerMinor: 2_000, outstandingMinor: 400 });

    // A cold restart reads the same.
    const again = harness(h);
    expect((await again.request({ method: 'GET', path: '/v1/purchase/rebate-schemes/rb-1/accruals', userId: P3.OWNER, tenantId: T })).body).toMatchObject({ count: 1, outstandingMinor: 400 });
  });

  it('nothing accrues below the threshold (and it says how far short); a growth scheme measures against its baseline period; a volume scheme is not guessed', async () => {
    const h = harness();
    const T = randomUUID();
    const call = await bills(h, T);
    await call('POST', '/v1/purchase/rebate-schemes/rb-hi', P3.OWNER, scheme({ thresholdMinor: 100_000 }));
    const low = await call('POST', '/v1/purchase/rebate-schemes/rb-hi/accruals/q1', P3.OWNER, { periodFrom: '2026-01-01', periodTo: '2026-03-31' });
    expect(accrualOf(low)).toMatchObject({ thresholdMet: false, accrued: { minor: 0 } });
    expect(accrualOf(low).detail).toContain('20000 more to earn anything');

    await call('POST', '/v1/purchase/rebate-schemes/grow', P3.OWNER, scheme({ basis: 'growth_over_baseline', thresholdMinor: 0 }));
    expect(codeOf(await call('POST', '/v1/purchase/rebate-schemes/grow/accruals/q2', P3.OWNER, { periodFrom: '2026-04-01', periodTo: '2026-06-30' }))).toBe('baseline_period_required');
    // Q2 (₹400) against the March baseline (₹800): no growth, nothing earned.
    const grow = await call('POST', '/v1/purchase/rebate-schemes/grow/accruals/q2', P3.OWNER, { periodFrom: '2026-04-01', periodTo: '2026-06-30', baselineFrom: '2026-03-01', baselineTo: '2026-03-31' });
    expect(accrualOf(grow)).toMatchObject({ basisAmount: { minor: 40_000 }, accrued: { minor: 0 } });
    // March against an empty February baseline: all ₹800 is growth → ₹24.
    const growMar = await call('POST', '/v1/purchase/rebate-schemes/grow/accruals/mar', P3.OWNER, { periodFrom: '2026-03-01', periodTo: '2026-03-31', baselineFrom: '2026-02-01', baselineTo: '2026-02-28' });
    expect(accrualOf(growMar).accrued).toEqual({ minor: 2_400, currency: 'INR' });

    await call('POST', '/v1/purchase/rebate-schemes/vol', P3.OWNER, scheme({ basis: 'volume_units' }));
    expect(codeOf(await call('POST', '/v1/purchase/rebate-schemes/vol/accruals/q1', P3.OWNER, { periodFrom: '2026-01-01', periodTo: '2026-03-31' }))).toBe('volume_rebate_basis_undecided');
    expect((await call('POST', '/v1/purchase/rebate-schemes/nope/accruals/a1', P3.OWNER, { periodFrom: '2026-01-01', periodTo: '2026-03-31' })).status).toBe(404);
    expect(codeOf(await call('POST', '/v1/purchase/rebate-schemes/rb-y', P3.OWNER, scheme({ basis: 'made_up' })))).toBe('not_readable_as_a_rebate_scheme');
  });

  it('a scheme\'s approver approves it in their own session — never a typed name, never the person recording it (2b-vi-c-1, PA-03)', async () => {
    const h = harness();
    const T = randomUUID();
    await p3Shop(h, T);
    const call = caller(h, T);
    const approved = (u: string, checker: string, id: string, b: Record<string, unknown>) =>
      sentWithApproval(h, T, u, checker, { kind: 'rebate_scheme', subjectRef: id, pathIds: { schemeId: id } }, b, (body) => call('POST', `/v1/purchase/rebate-schemes/${id}`, u, body) as never);
    expect(codeOf(await call('POST', '/v1/purchase/rebate-schemes/rb-t', P3.BUYER, scheme({ approvedBy: P3.OWNER })))).toBe('approver_named_without_approval');
    const ok = await approved(P3.BUYER, P3.OWNER, 'rb-a', scheme());
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect((ok.body as { scheme: { approvedBy?: string } }).scheme.approvedBy).toBe(P3.OWNER);
    expect(codeOf(await approved(P3.OWNER, P3.OWNER, 'rb-s', scheme()))).toBe('self_approval');
    expect((await approved(P3.OWNER, P3.BUYER, 'rb-m', scheme())).status).toBe(403);
    const plain = await call('POST', '/v1/purchase/rebate-schemes/rb-p', P3.BUYER, scheme());
    expect((plain.body as { scheme: { approvedBy?: string } }).scheme.approvedBy).toBeUndefined();
    expect((await call('GET', '/v1/purchase/rebate-schemes', P3.CASHIER)).status).toBe(403);
  });
});
