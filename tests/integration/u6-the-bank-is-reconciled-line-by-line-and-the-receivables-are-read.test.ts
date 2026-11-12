import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

/**
 * **U6 · M23-FR-03 · M23-FR-01 · QG-07 · P-08, on the real API:** the bank statement the accountant imported is read line by
 * line — the provider payout and the cash deposit matched, the rent debit unmatched with its value — an exception is raised
 * on the unmatched line for a named owner and resolved with a reason (both kept as facts, audited, once); a cashier is
 * refused by name; and every credit customer's receivables are read beside the finance ledger's figure.
 */
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa6406';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const post = (h: ApiHarness, path: string, body: unknown, key: string, userId = 'u-acct') => h.request({ method: 'POST', path, userId, tenantId: A, idempotencyKey: key, body });
const get = (h: ApiHarness, path: string, userId = 'u-acct', query?: Readonly<Record<string, string>>) => h.request({ method: 'GET', path, userId, tenantId: A, ...(query === undefined ? {} : { query }) });

const BATCH = {
  batchId: 'PB-0903', providerId: 'test-acquirer', currency: 'INR', settlementDate: '2026-09-03',
  lines: [{ id: 'l1', ref: 'PAY-1', amountMinor: 100_000 }], declaredGrossMinor: 100_000, declaredFeesMinor: 1_000, declaredNetMinor: 99_000, sourceName: 'acquirer.json',
};
const CSV = [
  'Date,Reference,Narrative,Debit,Credit',
  '03/09/2026,UTR778899 PB-0903,ACQUIRER SETTLEMENT,,990.00',
  '05/09/2026,DEP SLIP-77,CASH DEPOSIT,,200.00',
  '15/09/2026,CHQ001,Rent,"20,000.00",',
].join('\n');
const STATEMENT = { statementId: 'HDFC-2026-09', accountRef: 'HDFC-current-1', fromDate: '2026-09-01', toDate: '2026-09-30', openingMinor: 5_000_000, closingMinor: 5_000_000 + 99_000 + 20_000 - 2_000_000, sourceName: 'hdfc-sep.csv', csv: CSV };

async function shop(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-acct', 'accountant');
  await h.provisionRole(A, 'u-cash', 'cashier');
  expect((await post(h, '/v1/settlement/batches', BATCH, 'batch')).status).toBe(201);
  expect((await post(h, '/v1/finance/bank-statements', STATEMENT, 'stmt')).status).toBe(201);
  expect((await post(h, '/v1/finance/cash-deposits/dep-1', { depositedOn: '2026-09-05', amountMinor: 20_000, slipRef: 'SLIP-77', accountRef: 'HDFC-current-1' }, 'dep')).status).toBe(201);
  return h;
}

interface Read { statement: { statementId: string } | null; lines: { lineId: string; amountMinor: number; match: { kind: string; state?: string; overdue?: boolean; outcome?: string } }[]; totals: { matched: number; unmatched: number; unmatchedMinor: number; openExceptions: number } | null; statementAddsUp: boolean | null; exceptions: { exceptionId: string; state: string }[] }

describe('U6: the bank is reconciled line by line, and the receivables are read beside the ledger', () => {
  it('matches the payout and the deposit, leaves the rent unmatched with its value; raises and resolves an exception as facts; refuses a cashier and a matched line', async () => {
    const h = await shop();
    const first = (await get(h, '/v1/finance/bank-reconciliation')).body as Read;
    expect(first.statement?.statementId).toBe('HDFC-2026-09');
    // The bank's CSV gives each line its number under the statement: HDFC-2026-09:1 … :3.
    const [L1, L2, L3] = first.lines.map((l) => l.lineId) as [string, string, string];
    expect(first.lines.map((l) => [l.lineId, l.match.kind])).toEqual([['HDFC-2026-09:1', 'provider_payout'], ['HDFC-2026-09:2', 'cash_deposit'], ['HDFC-2026-09:3', 'unmatched']]);
    void L2;
    expect(first.totals).toMatchObject({ matched: 2, unmatched: 1, unmatchedMinor: -2_000_000, openExceptions: 0 });
    expect(first.statementAddsUp).toBe(true);
    // The cashier has no business here: refused by name, nothing read.
    expect((await get(h, '/v1/finance/bank-reconciliation', 'u-cash')).status).toBe(403);
    // A matched line takes no exception; the unmatched rent does, owned by the accountant, raised by the owner.
    expect(codeOf(await post(h, '/v1/finance/bank-reconciliation/exceptions/bx-1', { statementId: 'HDFC-2026-09', lineId: L1, ownerUserId: 'u-acct' }, 'bx-matched', 'u-owner'))).toBe('line_already_matched');
    const raised = await post(h, '/v1/finance/bank-reconciliation/exceptions/bx-1', { statementId: 'HDFC-2026-09', lineId: L3, ownerUserId: 'u-acct', note: 'no bill for this rent yet' }, 'bx-1', 'u-owner');
    expect(raised.status, JSON.stringify(raised.body)).toBe(201);
    expect(raised.body).toMatchObject({ exception: { amountMinor: -2_000_000, ownerUserId: 'u-acct', raisedBy: 'u-owner' }, alreadyRaised: false });
    expect((await post(h, '/v1/finance/bank-reconciliation/exceptions/bx-1', { statementId: 'HDFC-2026-09', lineId: L3, ownerUserId: 'u-acct', note: 'no bill for this rent yet' }, 'bx-1-again', 'u-owner')).body).toMatchObject({ alreadyRaised: true });
    expect((await post(h, '/v1/finance/bank-reconciliation/exceptions/bx-9', { statementId: 'HDFC-2026-09', lineId: L3, ownerUserId: 'u-acct' }, 'bx-cash', 'u-cash')).status).toBe(403);
    const open = (await get(h, '/v1/finance/bank-reconciliation', 'u-acct', { statementId: 'HDFC-2026-09' })).body as Read;
    expect(open.lines[2]!.match).toMatchObject({ kind: 'exception', state: 'open' });
    expect(open.totals).toMatchObject({ unmatched: 0, openExceptions: 1 });
    expect(open.exceptions).toEqual([expect.objectContaining({ exceptionId: 'bx-1', state: 'open' })]);
    // Resolved with a reason, by the accountant — once; the second answer is the first, not a second fact.
    expect(codeOf(await post(h, '/v1/finance/bank-reconciliation/exceptions/bx-1/resolve', { outcome: 'matched_by_hand' }, 'rs-no-reason'))).toBe('resolve_needs_a_reason');
    const done = await post(h, '/v1/finance/bank-reconciliation/exceptions/bx-1/resolve', { outcome: 'matched_by_hand', reason: 'September rent, bill RENT-09', matchedTo: 'RENT-09' }, 'rs-1');
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    expect((await post(h, '/v1/finance/bank-reconciliation/exceptions/bx-1/resolve', { outcome: 'bank_error', reason: 'other' }, 'rs-2')).body).toMatchObject({ resolved: { outcome: 'matched_by_hand', by: 'u-acct' }, alreadyResolved: true });
    const after = (await get(h, '/v1/finance/bank-reconciliation')).body as Read;
    expect(after.lines[2]!.match).toMatchObject({ kind: 'exception', state: 'resolved', outcome: 'matched_by_hand' });
    expect(after.totals).toMatchObject({ openExceptions: 0 });
    // The audit trail holds both acts.
    const trail = (await get(h, '/v1/audit/trail', 'u-owner', { objectType: 'bank_reconciliation_exception', objectId: 'bx-1' })).body as { matches: { action: string }[] };
    const actions = trail.matches.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['bank.reconciliation.exception.raise', 'bank.reconciliation.exception.resolve']));
  });

  it('with no statement imported the read says so (no lines, no totals) — never a balanced zero; an unknown statement is refused by name', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-acct', 'accountant');
    const r = (await get(h, '/v1/finance/bank-reconciliation')).body as Read;
    expect([r.statement, r.lines, r.totals, r.statementAddsUp]).toEqual([null, [], null, null]);
    expect(codeOf(await get(h, '/v1/finance/bank-reconciliation', 'u-acct', { statementId: 'nope' }))).toBe('statement_unknown');
  });

  it('every credit customer\'s receivables are read beside the finance ledger\'s figure, aged from the due date, the difference visible', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-acct', 'accountant');
    await h.provisionRole(A, 'u-cash', 'cashier');
    await h.enableFeature(A, 'b2b');
    const inv = (customerId: string, invoiceId: string, body: unknown) => h.request({ method: 'POST', path: `/v1/b2b/collections/${customerId}/invoices/${invoiceId}`, userId: 'u-owner', tenantId: A, idempotencyKey: `inv-${invoiceId}`, body });
    const ledger = (customerId: string, movementId: string, amountMinor: number) => h.request({ method: 'POST', path: `/v1/b2b/accounts/${customerId}/receivables`, userId: 'u-owner', tenantId: A, idempotencyKey: `ar-${movementId}`, body: { movementId, kind: 'invoice', amountMinor, ref: movementId } });
    // CUST1: the collections register and the ledger agree. CUST2: the register asks for ₹2,000 the ledger holds ₹1,800 of.
    expect((await inv('CUST1', 'inv-1', { number: 'INV-1', issuedOn: '2026-07-21', dueOn: '2026-08-20', grossMinor: 100_000 })).status).toBe(201);
    expect((await ledger('CUST1', 'ar-1', 100_000)).status).toBe(201);
    expect((await inv('CUST2', 'inv-2', { number: 'INV-2', issuedOn: '2026-04-01', dueOn: '2026-05-01', grossMinor: 200_000, disputed: true, disputeReason: 'short delivery' })).status).toBe(201);
    expect((await ledger('CUST2', 'ar-2', 180_000)).status).toBe(201);
    const empty = (await get(h, '/v1/finance/receivables', 'u-cash'));
    expect(empty.status).toBe(403);
    const v = (await get(h, '/v1/finance/receivables')).body as { customers: { customerId: string; outstandingMinor: number; financeOutstandingMinor: number; agrees: boolean; disputedMinor: number }[]; totals: { customers: number; outstandingMinor: number }; agrees: boolean | null; leftDerivation: string };
    expect(v.totals).toMatchObject({ customers: 2, outstandingMinor: 300_000, financeOutstandingMinor: 280_000, differenceMinor: 20_000 });
    // the differing customer first, the difference visible, never netted away
    expect(v.customers.map((c) => [c.customerId, c.outstandingMinor, c.financeOutstandingMinor, c.agrees])).toEqual([['CUST2', 200_000, 180_000, false], ['CUST1', 100_000, 100_000, true]]);
    expect(v.customers[0]).toMatchObject({ disputedMinor: 200_000 });
    expect(v.agrees).toBe(false);
    expect(v.leftDerivation).toMatch(/due date/);
  });
});
