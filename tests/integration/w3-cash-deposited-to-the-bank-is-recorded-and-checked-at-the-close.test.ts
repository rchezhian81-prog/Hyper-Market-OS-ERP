import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { cashDepositViews, type CashDeposit } from '../../services/finance/src/cash-deposits';
import { monthEvidence } from '../../services/finance/src/independent-evidence';

/**
 * **W3 · M23-FR-03 "reconcile cash, bank … against POS and finance records" — cash deposited to the bank has a record, and
 * the month close checks it against the bank (P-08 · hard rules #2, #3, #6, #10).**
 *
 * Before: the close said "Cash banked: not checked" for ever — nothing recorded a deposit. Now:
 *   • the accountant records a deposit (day, amount, slip number, the shop's name for the account); the same deposit again
 *     is "already recorded"; another deposit under the same id, or the same slip twice, is refused by name; an account
 *     number or a card number is never kept; a cashier cannot record one;
 *   • the close has a "Cash banked" check: deposits recorded for the month against the bank credits naming their slips —
 *     a deposit not in the bank yet is a difference, and the month is refused with it named;
 *   • a wrong deposit is cancelled with a reason — the record stays as evidence, the cancel is its own fact;
 *   • one bank credit answers one deposit, never two.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa3c03';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const CSV = [
  'Date,Reference,Narrative,Debit,Credit',
  '05/09/2026,DS-4471,CASH DEPOSIT BY SELF,,"25,000.00"',
  '15/09/2026,CHQ001,Rent,"20,000.00",',
].join('\n');
const STATEMENT = { statementId: 'HDFC-2026-09', accountRef: 'HDFC-current-1', fromDate: '2026-09-01', toDate: '2026-09-30', openingMinor: 5_000_000, closingMinor: 5_000_000 + 2_500_000 - 2_000_000, csv: CSV };
const DEPOSIT = { depositedOn: '2026-09-05', amountMinor: 2_500_000, slipRef: 'DS-4471', accountRef: 'HDFC-current-1' };

async function shop(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-acct', 'accountant');
  await h.provisionRole(A, 'u-cash', 'cashier', ['store-1']);
  return h;
}
const post = (h: ApiHarness, path: string, body: unknown, key: string, userId = 'u-acct') => h.request({ method: 'POST', path, userId, tenantId: A, idempotencyKey: key, body });
const get = async <T>(h: ApiHarness, path: string, query?: Record<string, string>, userId = 'u-acct') => (await h.request({ method: 'GET', path, userId, tenantId: A, ...(query === undefined ? {} : { query }) })).body as T;
interface Evidence { checks: { name: string; leftMinor: number; rightMinor: number }[]; depositsNotInBank: { depositId: string }[]; notChecked: string[] }

describe('W3 · M23-FR-03: cash deposited to the bank', () => {
  it('is recorded once, refused by name when it clashes, never keeps an account or card number, and is not a cashier\'s to record', async () => {
    const h = await shop();
    const ok = await post(h, '/v1/finance/cash-deposits/dep-1', { ...DEPOSIT, note: 'Saturday takings' }, 'd1');
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body).toMatchObject({ deposit: { depositId: 'dep-1', amountMinor: 2_500_000, recordedBy: 'u-acct' }, alreadyRecorded: false });
    expect((await post(h, '/v1/finance/cash-deposits/dep-1', { ...DEPOSIT, note: 'Saturday takings' }, 'd1-again')).body).toMatchObject({ alreadyRecorded: true });
    expect(codeOf(await post(h, '/v1/finance/cash-deposits/dep-1', { ...DEPOSIT, amountMinor: 1 }, 'd1-other'))).toBe('deposit_id_used');
    expect(codeOf(await post(h, '/v1/finance/cash-deposits/dep-2', DEPOSIT, 'd2-same-slip'))).toBe('slip_already_recorded');
    expect(codeOf(await post(h, '/v1/finance/cash-deposits/dep-3', { ...DEPOSIT, slipRef: 'S-2', accountRef: '50100123456789' }, 'd3'))).toBe('account_number_not_kept');
    expect(codeOf(await post(h, '/v1/finance/cash-deposits/dep-4', { ...DEPOSIT, slipRef: '4111 1111 1111 1111' }, 'd4'))).toBe('looks_like_card_data');
    expect(codeOf(await post(h, '/v1/finance/cash-deposits/dep-5', { ...DEPOSIT, depositedOn: '2026-02-31' }, 'd5'))).toBe('not_readable_as_a_cash_deposit');
    expect((await post(h, '/v1/finance/cash-deposits/dep-6', { ...DEPOSIT, slipRef: 'S-6' }, 'd6', 'u-cash')).status).toBe(403);
    const listed = await get<{ deposits: { depositId: string; state: string }[]; recordedMinor: number; notInBank: number }>(h, '/v1/finance/cash-deposits');
    expect(listed.deposits.map((d) => [d.depositId, d.state])).toEqual([['dep-1', 'not_in_bank']]);
    expect(listed).toMatchObject({ recordedMinor: 2_500_000, notInBank: 1 });
  });

  it('the close checks cash banked against the bank: not in the bank → refused with it named; the statement arrives → it agrees', async () => {
    const h = await shop();
    let e = await get<Evidence>(h, '/v1/finance/periods/2026-09/independent-evidence');
    expect(e.checks.some((c) => c.name.startsWith('Cash banked'))).toBe(false);
    expect(e.notChecked.join(' ')).toMatch(/Cash banked: no cash deposit to the bank is recorded for 2026-09/);

    expect((await post(h, '/v1/finance/cash-deposits/dep-1', DEPOSIT, 'd1')).status).toBe(201);
    e = await get<Evidence>(h, '/v1/finance/periods/2026-09/independent-evidence');
    expect(e.checks).toEqual([expect.objectContaining({ name: 'Cash banked in 2026-09', leftMinor: 2_500_000, rightMinor: 0 })]);
    expect(e.depositsNotInBank).toEqual([{ depositId: 'dep-1', slipRef: 'DS-4471', amountMinor: 2_500_000 }]);

    expect((await post(h, '/v1/finance/bank-statements', STATEMENT, 'bs-1', 'u-owner')).status).toBe(201);
    e = await get<Evidence>(h, '/v1/finance/periods/2026-09/independent-evidence');
    expect(e.checks).toEqual([expect.objectContaining({ name: 'Cash banked in 2026-09', leftMinor: 2_500_000, rightMinor: 2_500_000 })]);
    expect(e.depositsNotInBank).toEqual([]);
    const listed = await get<{ deposits: { state: string; bankLine: { statementId: string; date: string } }[] }>(h, '/v1/finance/cash-deposits', { period: '2026-09' });
    expect(listed.deposits[0]).toMatchObject({ state: 'in_bank', bankLine: { statementId: 'HDFC-2026-09', date: '2026-09-05' } });
  });

  it('a wrong deposit is cancelled with a reason: kept as evidence, out of the check; the slip can then be recorded right', async () => {
    const h = await shop();
    expect((await post(h, '/v1/finance/cash-deposits/dep-1', { ...DEPOSIT, amountMinor: 2_400_000 }, 'd1')).status).toBe(201);
    expect(codeOf(await post(h, '/v1/finance/cash-deposits/dep-1/cancel', {}, 'c0'))).toBe('cancel_needs_a_reason');
    expect(codeOf(await post(h, '/v1/finance/cash-deposits/dep-x/cancel', { reason: 'x' }, 'cx'))).toBe('cash_deposit_unknown');
    const c = await post(h, '/v1/finance/cash-deposits/dep-1/cancel', { reason: 'typed ₹24,000; the slip says ₹25,000' }, 'c1');
    expect(c.status).toBe(201);
    expect((await post(h, '/v1/finance/cash-deposits/dep-1/cancel', { reason: 'again' }, 'c1-again')).body).toMatchObject({ alreadyCancelled: true });
    expect((await post(h, '/v1/finance/cash-deposits/dep-2', DEPOSIT, 'd2')).status).toBe(201);
    const listed = await get<{ deposits: { depositId: string; state: string; cancelled?: { reason: string; by: string } }[]; recordedMinor: number }>(h, '/v1/finance/cash-deposits');
    expect(listed.deposits.map((d) => [d.depositId, d.state])).toEqual([['dep-1', 'cancelled'], ['dep-2', 'not_in_bank']]);
    expect(listed.deposits[0]!.cancelled).toMatchObject({ reason: 'typed ₹24,000; the slip says ₹25,000', by: 'u-acct' });
    expect(listed.recordedMinor).toBe(2_500_000);
    const e = await get<Evidence>(h, '/v1/finance/periods/2026-09/independent-evidence');
    expect(e.checks).toEqual([expect.objectContaining({ leftMinor: 2_500_000 })]);
  });

  it('one bank credit answers one deposit, never two (pure)', () => {
    const d = (id: string, recordedAt: string): CashDeposit => ({ depositId: id, depositedOn: '2026-09-05', amountMinor: 1_000, slipRef: 'DS-1', accountRef: 'A', recordedBy: 'u', recordedAt });
    const statements = [{ statementId: 'S', accountRef: 'A', fromDate: '2026-09-01', toDate: '2026-09-30', openingMinor: 0, closingMinor: 1_000, lines: [{ lineId: 'S:1', date: '2026-09-05', amountMinor: 1_000, reference: 'DS-1' }] }];
    const views = cashDepositViews({ deposits: [d('a', '2026-09-05T10:00:00Z'), d('b', '2026-09-05T11:00:00Z')], cancelled: [], statements });
    expect(views.map((v) => v.state)).toEqual(['in_bank', 'not_in_bank']);
    const e = monthEvidence({ period: '2026-09', tenders: [], batches: [], statements, deposits: views });
    expect(e.checks).toEqual([expect.objectContaining({ leftMinor: 2_000, rightMinor: 1_000 })]);
    // A credit dated before the deposit was paid in is not its credit.
    const early = cashDepositViews({ deposits: [{ ...d('c', 'x'), depositedOn: '2026-09-06' }], cancelled: [], statements });
    expect(early[0]!.state).toBe('not_in_bank');
  });
});
