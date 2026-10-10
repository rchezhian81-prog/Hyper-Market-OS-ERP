import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { approvedBody } from '../support/approval-request';

/**
 * **PF-12 (audit, HIGH · M23-FR-02/03/04 · QG-07 · P-08): the month close joins imported INDEPENDENT evidence.**
 *
 * The audit reproduced the close refusing forever — its control totals were an empty list, because nothing outside the
 * system was ever fed in. Now: a bank statement is imported with its provenance (refused when it does not add up to its
 * own balances, when it names an account number, or when imported twice); the provider's settlement file keeps who
 * imported it; and the close compares (1) the card/UPI tenders the tills banked with the provider's settlement lines for
 * those references, and (2) the provider's declared payouts with the bank's credits naming them. All agree → the month
 * closes on a second person's signature. One tender unsettled → the close is refused with the difference named. The
 * files here are synthetic fixtures; no live bank or provider is connected (those stay external gates).
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa1212';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

const cardSale = (saleId: string, ref: string, amountMinor: number, day: string, kind = 'card') => ({
  saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', cashierId: 'u-owner', tradingDay: day, committedAt: `${day}T10:00:00.000Z`,
  totalMinor: amountMinor + 5_000, currency: 'INR', packVersion: 1,
  lines: [{ productId: 'P1', quantityMinor: 1, uom: 'each', unitPriceMinor: amountMinor + 5_000, lineTotalMinor: amountMinor + 5_000 }],
  tenders: [{ kind, amountMinor, ref }, { kind: 'cash', amountMinor: 5_000 }],
});
// The provider's file for those tenders: gross ₹1,500, fee ₹15, net ₹1,485 paid on 3 Sep.
const BATCH = {
  batchId: 'PB-0903', providerId: 'test-acquirer', currency: 'INR', settlementDate: '2026-09-03',
  lines: [{ id: 'l1', ref: 'PAY-1', amountMinor: 100_000 }, { id: 'l2', ref: 'PAY-2', amountMinor: 50_000 }],
  declaredGrossMinor: 150_000, declaredFeesMinor: 1_500, declaredNetMinor: 148_500, sourceName: 'acquirer-2026-09-03.json',
};
// The bank's CSV export for September: the payout arrives naming the batch.
const CSV = [
  'Date,Reference,Narrative,Debit,Credit',
  '03/09/2026,UTR778899 PB-0903,ACQUIRER SETTLEMENT,,"1,485.00"',
  '15/09/2026,CHQ001,Rent,"20,000.00",',
].join('\n');
const STATEMENT = { statementId: 'HDFC-2026-09', accountRef: 'HDFC-current-1', fromDate: '2026-09-01', toDate: '2026-09-30', openingMinor: 5_000_000, closingMinor: 5_000_000 + 148_500 - 2_000_000, sourceName: 'hdfc-sep.csv', csv: CSV };

async function shop(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-acct', 'accountant'); // signs the month; posted nothing into it
  return h;
}
const post = (h: ApiHarness, path: string, body: unknown, key: string, userId = 'u-owner') => h.request({ method: 'POST', path, userId, tenantId: A, idempotencyKey: key, body });
const evidence = async (h: ApiHarness, period: string) =>
  (await h.request({ method: 'GET', path: `/v1/finance/periods/${period}/independent-evidence`, userId: 'u-acct', tenantId: A })).body as {
    agrees: boolean; checks: { name: string; leftMinor: number; rightMinor: number }[]; unsettledTenders: { ref: string }[]; payoutsNotInBank: { batchId: string }[]; notChecked: string[];
  };
const closeWithSignature = async (h: ApiHarness, period: string, key: string) =>
  post(h, `/v1/finance/periods/${period}/close`, await approvedBody(h, A, 'u-owner', 'u-acct', 'period_close', period, {}, { period }), key);

describe('PF-12: the month close compares the books with imported independent evidence', () => {
  it('a bank statement is refused when it does not add up, names an account number, or is imported twice — and keeps who brought it', async () => {
    const h = await shop();
    expect(codeOf(await post(h, '/v1/finance/bank-statements', { ...STATEMENT, closingMinor: 1 }, 'bs-bad'))).toBe('bank_statement_refused');
    expect(codeOf(await post(h, '/v1/finance/bank-statements', { ...STATEMENT, accountRef: '50100123456789' }, 'bs-acct'))).toBe('bank_statement_refused');
    const ok = await post(h, '/v1/finance/bank-statements', STATEMENT, 'bs-1');
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body).toMatchObject({ statementId: 'HDFC-2026-09', lines: 2, provenance: { importedBy: 'u-owner', sourceName: 'hdfc-sep.csv' } });
    expect(codeOf(await post(h, '/v1/finance/bank-statements', STATEMENT, 'bs-1-again'))).toBe('duplicate_statement');
    const listed = (await h.request({ method: 'GET', path: '/v1/finance/bank-statements', userId: 'u-acct', tenantId: A })).body as { statements: unknown[] };
    expect(listed.statements).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toMatch(/\d{9,18}/);
  });

  it('every card/UPI tender settled and every payout in the bank → the month closes on a second person\'s signature', async () => {
    const h = await shop();
    // No evidence at all: nothing was checked, and the month does not close.
    expect(codeOf(await closeWithSignature(h, '2026-09', 'close-empty'))).toBe('nothing_was_checked');
    expect((await post(h, '/v1/sales', cardSale('S1', 'PAY-1', 100_000, '2026-09-01'), 'bank-S1')).status).toBe(202);
    expect((await post(h, '/v1/sales', cardSale('S2', 'PAY-2', 50_000, '2026-09-01', 'upi'), 'bank-S2')).status).toBe(202);
    // The tills' tenders alone: the provider has not been heard from — the difference is named and the month stays open.
    let e = await evidence(h, '2026-09');
    expect(e.agrees).toBe(false);
    expect(e.checks).toEqual([expect.objectContaining({ name: 'Card and UPI takings for 2026-09', leftMinor: 150_000, rightMinor: 0 })]);
    expect(e.unsettledTenders.map((t) => t.ref).sort()).toEqual(['PAY-1', 'PAY-2']);
    expect(codeOf(await closeWithSignature(h, '2026-09', 'close-unsettled'))).toBe('control_total_does_not_agree');

    // The provider's file, then the bank's statement: both comparisons agree.
    const imported = await post(h, '/v1/settlement/batches', BATCH, 'pb-1');
    expect(imported.status, JSON.stringify(imported.body)).toBe(201);
    e = await evidence(h, '2026-09');
    expect(e.checks.find((c) => c.name.startsWith('Provider payouts'))).toMatchObject({ leftMinor: 148_500, rightMinor: 0 });
    expect(e.payoutsNotInBank).toEqual([{ batchId: 'PB-0903', netMinor: 148_500 }]);
    expect((await post(h, '/v1/finance/bank-statements', STATEMENT, 'bs-1')).status).toBe(201);
    e = await evidence(h, '2026-09');
    expect(e.agrees).toBe(true);
    expect(e.checks).toEqual([
      expect.objectContaining({ leftMinor: 150_000, rightMinor: 150_000 }),
      expect.objectContaining({ leftMinor: 148_500, rightMinor: 148_500 }),
    ]);
    expect(e.notChecked.join(' ')).toMatch(/Cash banked/);

    const closed = await closeWithSignature(h, '2026-09', 'close-ok');
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(JSON.stringify(closed.body)).toMatch(/2 control total\(s\) agreed, signed by u-acct/);
  });

  it('a tender settled short is a difference, and the month is refused with it named', async () => {
    const h = await shop();
    expect((await post(h, '/v1/sales', cardSale('S1', 'PAY-1', 100_000, '2026-09-01'), 'bank-S1')).status).toBe(202);
    const short = { ...BATCH, batchId: 'PB-SHORT', lines: [{ id: 'l1', ref: 'PAY-1', amountMinor: 99_000 }], declaredGrossMinor: 99_000, declaredFeesMinor: 0, declaredNetMinor: 99_000 };
    expect((await post(h, '/v1/settlement/batches', short, 'pb-short')).status).toBe(201);
    const refused = await closeWithSignature(h, '2026-09', 'close-short');
    expect(codeOf(refused)).toBe('control_total_does_not_agree');
    expect(JSON.stringify(refused.body)).toMatch(/Card and UPI takings for 2026-09.*difference of -1000/);
  });
});
