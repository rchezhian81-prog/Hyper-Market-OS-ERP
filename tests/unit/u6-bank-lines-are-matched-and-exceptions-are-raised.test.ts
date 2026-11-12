import { describe, it, expect } from 'vitest';
import { reconcileBankStatement, exceptionViews, bankReconciliationRoutes, type BankReconciliationDeps, type BankLineException, type BankLineExceptionResolved } from '../../services/finance/src/bank-reconciliation';
import type { BankStatement } from '../../packages/finance/src/bank-statement';
import type { CashDepositView } from '../../services/finance/src/cash-deposits';
import type { SettlementBatch } from '../../services/finance/src/settlement';

/**
 * **U6 · M23-FR-03: every line of an imported bank statement is matched to what the books know, or is an EXCEPTION with its
 * value, owned by a named person and resolved with a reason — never a silent tie-out (P-08, hard rule #10).**
 *
 * The pure engine matches a credit that names a provider payout batch, a credit that names a cash-deposit slip for the same
 * amount (the deposit views already paired it), and leaves the rest unmatched; an exception raised on a line follows it with
 * its state; the routes refuse an exception on a matched line, a second different exception on the same line, and an
 * unknown line, in the three-part words; raising and resolving are recorded as events with a person and a reason.
 */
const STATEMENT: BankStatement = {
  statementId: 'HDFC-2026-09', accountRef: 'HDFC-current-1', fromDate: '2026-09-01', toDate: '2026-09-30', openingMinor: 5_000_000, closingMinor: 5_000_000 + 148_500 + 20_000 - 2_000_000,
  lines: [
    { lineId: 'L1', date: '2026-09-03', amountMinor: 148_500, reference: 'UTR778899 PB-0903', narrative: 'ACQUIRER SETTLEMENT' },
    { lineId: 'L2', date: '2026-09-05', amountMinor: 20_000, reference: 'DEP SLIP-77', narrative: 'CASH DEPOSIT' },
    { lineId: 'L3', date: '2026-09-15', amountMinor: -2_000_000, reference: 'CHQ001', narrative: 'Rent' },
  ],
};
const BATCH: SettlementBatch = { batchId: 'PB-0903', providerId: 'acq', currency: 'INR', settlementDate: '2026-09-03', lines: [{ id: 'l1', ref: 'PAY-1', amountMinor: 150_000 }], declaredGrossMinor: 150_000, declaredFeesMinor: 1_500, declaredNetMinor: 148_500 } as SettlementBatch;
const DEPOSIT: CashDepositView = { depositId: 'dep-1', depositedOn: '2026-09-05', amountMinor: 20_000, slipRef: 'SLIP-77', accountRef: 'HDFC-current-1', recordedBy: 'u-acct', recordedAt: '2026-09-05T10:00:00.000Z', state: 'in_bank', bankLine: { statementId: 'HDFC-2026-09', lineId: 'L2', date: '2026-09-05' } };

describe('the bank reconciliation engine', () => {
  it('matches a payout credit by its batch id and a deposit credit by its slip, and leaves the rent debit unmatched with its value', () => {
    const r = reconcileBankStatement({ statement: STATEMENT, batches: [BATCH], deposits: [DEPOSIT], exceptions: [] });
    expect(r.lines.map((l) => [l.lineId, l.match.kind])).toEqual([['L1', 'provider_payout'], ['L2', 'cash_deposit'], ['L3', 'unmatched']]);
    expect(r.lines[0]!.match).toMatchObject({ kind: 'provider_payout', batchId: 'PB-0903' });
    expect(r.lines[1]!.match).toMatchObject({ kind: 'cash_deposit', depositId: 'dep-1', slipRef: 'SLIP-77' });
    expect(r.totals).toMatchObject({ lines: 3, matched: 2, unmatched: 1, unmatchedMinor: -2_000_000, creditsMinor: 168_500, debitsMinor: -2_000_000, openExceptions: 0 });
    expect(r.statementAddsUp).toBe(true);
  });

  it('an exception raised on a line follows it, open until resolved; overdue once the shop day it was raised on has passed', () => {
    const raised: BankLineException = { exceptionId: 'bx-1', statementId: 'HDFC-2026-09', lineId: 'L3', amountMinor: -2_000_000, ownerUserId: 'u-acct', raisedBy: 'u-owner', raisedAt: '2026-09-16T05:00:00.000Z', raisedOn: '2026-09-16', note: 'no bill for this rent' };
    const open = reconcileBankStatement({ statement: STATEMENT, batches: [BATCH], deposits: [DEPOSIT], exceptions: exceptionViews([raised], [], '2026-09-17') });
    expect(open.lines[2]!.match).toMatchObject({ kind: 'exception', exceptionId: 'bx-1', state: 'open', overdue: true });
    expect(open.totals).toMatchObject({ unmatched: 0, openExceptions: 1, overdueExceptions: 1 });
    const resolved: BankLineExceptionResolved = { exceptionId: 'bx-1', outcome: 'matched_by_hand', reason: 'the landlord\'s rent for September, bill RENT-09', matchedTo: 'RENT-09', by: 'u-acct', at: '2026-09-17T06:00:00.000Z' };
    const done = reconcileBankStatement({ statement: STATEMENT, batches: [BATCH], deposits: [DEPOSIT], exceptions: exceptionViews([raised], [resolved], '2026-09-17') });
    expect(done.lines[2]!.match).toMatchObject({ kind: 'exception', state: 'resolved', outcome: 'matched_by_hand', matchedTo: 'RENT-09' });
    expect(done.totals).toMatchObject({ openExceptions: 0, overdueExceptions: 0 });
  });
});

function fakeDeps(input: { exceptions?: BankLineException[]; resolved?: BankLineExceptionResolved[] } = {}): BankReconciliationDeps & { raised: BankLineException[]; resolved: BankLineExceptionResolved[]; audits: string[] } {
  const raised = input.exceptions ?? []; const resolved = input.resolved ?? []; const audits: string[] = [];
  return {
    raised, resolved, audits,
    statements: async () => [STATEMENT], batches: async () => [BATCH], depositViews: async () => [DEPOSIT],
    exceptionsRaised: async () => raised, exceptionsResolved: async () => resolved,
    recordRaised: async (_t, e) => { raised.push(e); }, recordResolved: async (_t, r) => { resolved.push(r); },
    recordAudit: async (_t, a) => { audits.push(a.action); }, now: () => '2026-09-16T05:00:00.000Z',
  };
}
const ctx = (userId: string, body: unknown, params: Record<string, string> = {}, query: Record<string, string> = {}) => ({ tenantId: 'T', userId, body, params, query, branchId: null }) as never;
const handlerOf = (deps: BankReconciliationDeps, method: string, path: string) => bankReconciliationRoutes(deps).find((r) => r.method === method && r.path === path)!.handler;
const codeOf = async (p: Promise<unknown>): Promise<string> => { try { await p; return 'ok'; } catch (e) { return (e as { body?: { code?: string } }).body?.code ?? String(e); } };

describe('the bank reconciliation routes', () => {
  it('reads the latest statement matched, or the one asked for; an unknown statement is refused by name', async () => {
    const deps = fakeDeps();
    const read = handlerOf(deps, 'GET', '/v1/finance/bank-reconciliation');
    const out = await read(ctx('u-acct', null)) as { status: number; body: { statement: { statementId: string }; lines: unknown[]; totals: { unmatched: number }; statements: unknown[] } };
    expect(out.status).toBe(200);
    expect(out.body.statement.statementId).toBe('HDFC-2026-09');
    expect(out.body.lines).toHaveLength(3);
    expect(out.body.totals.unmatched).toBe(1);
    expect(await codeOf(read(ctx('u-acct', null, {}, { statementId: 'nope' })))).toBe('statement_unknown');
  });

  it('raises an exception on an unmatched line with an owner (recorded, audited, idempotent); refuses a matched line, an unknown line and a second different exception on the line', async () => {
    const deps = fakeDeps();
    const raise = handlerOf(deps, 'POST', '/v1/finance/bank-reconciliation/exceptions/:exceptionId');
    const first = await raise(ctx('u-owner', { statementId: 'HDFC-2026-09', lineId: 'L3', ownerUserId: 'u-acct', note: 'no bill' }, { exceptionId: 'bx-1' })) as { status: number; body: { exception: { amountMinor: number; raisedOn: string } } };
    expect(first.status).toBe(201);
    expect(first.body.exception).toMatchObject({ amountMinor: -2_000_000, ownerUserId: 'u-acct', raisedBy: 'u-owner', raisedOn: '2026-09-16' });
    expect(deps.raised).toHaveLength(1); expect(deps.audits).toEqual(['bank.reconciliation.exception.raise']);
    const again = await raise(ctx('u-owner', { statementId: 'HDFC-2026-09', lineId: 'L3', ownerUserId: 'u-acct', note: 'no bill' }, { exceptionId: 'bx-1' })) as { status: number; body: { alreadyRaised: boolean } };
    expect([again.status, again.body.alreadyRaised]).toEqual([200, true]);
    expect(deps.raised).toHaveLength(1);
    expect(await codeOf(raise(ctx('u-owner', { statementId: 'HDFC-2026-09', lineId: 'L1', ownerUserId: 'u-acct' }, { exceptionId: 'bx-2' })))).toBe('line_already_matched');
    expect(await codeOf(raise(ctx('u-owner', { statementId: 'HDFC-2026-09', lineId: 'L9', ownerUserId: 'u-acct' }, { exceptionId: 'bx-3' })))).toBe('line_unknown');
    expect(await codeOf(raise(ctx('u-owner', { statementId: 'HDFC-2026-09', lineId: 'L3', ownerUserId: 'u-mgr' }, { exceptionId: 'bx-4' })))).toBe('line_already_has_an_exception');
    expect(await codeOf(raise(ctx('u-owner', { statementId: 'HDFC-2026-09', lineId: 'L3' }, { exceptionId: 'bx-5' })))).toBe('not_readable_as_a_bank_exception');
  });

  it('resolves an exception with an outcome and a reason (recorded, audited, once); refuses an unknown one, a missing reason and an outcome it does not know', async () => {
    const deps = fakeDeps({ exceptions: [{ exceptionId: 'bx-1', statementId: 'HDFC-2026-09', lineId: 'L3', amountMinor: -2_000_000, ownerUserId: 'u-acct', raisedBy: 'u-owner', raisedAt: '2026-09-15T05:00:00.000Z', raisedOn: '2026-09-15' }] });
    const resolve = handlerOf(deps, 'POST', '/v1/finance/bank-reconciliation/exceptions/:exceptionId/resolve');
    expect(await codeOf(resolve(ctx('u-acct', { outcome: 'matched_by_hand', reason: 'rent bill RENT-09' }, { exceptionId: 'bx-9' })))).toBe('exception_unknown');
    expect(await codeOf(resolve(ctx('u-acct', { outcome: 'matched_by_hand' }, { exceptionId: 'bx-1' })))).toBe('resolve_needs_a_reason');
    expect(await codeOf(resolve(ctx('u-acct', { outcome: 'whatever', reason: 'x' }, { exceptionId: 'bx-1' })))).toBe('outcome_unknown');
    const done = await resolve(ctx('u-acct', { outcome: 'matched_by_hand', reason: 'rent bill RENT-09', matchedTo: 'RENT-09' }, { exceptionId: 'bx-1' })) as { status: number; body: { resolved: { by: string; outcome: string } } };
    expect(done.status).toBe(201);
    expect(done.body.resolved).toMatchObject({ by: 'u-acct', outcome: 'matched_by_hand', matchedTo: 'RENT-09' });
    expect(deps.audits).toEqual(['bank.reconciliation.exception.resolve']);
    const again = await resolve(ctx('u-acct', { outcome: 'bank_error', reason: 'changed my mind' }, { exceptionId: 'bx-1' })) as { status: number; body: { alreadyResolved: boolean } };
    expect([again.status, again.body.alreadyResolved]).toEqual([200, true]);
    expect(deps.resolved).toHaveLength(1);
  });
});
