import { describe, it, expect } from 'vitest';
import {
  verifyBankChange,
  isPayable,
  BankChangeUnverifiedError,
  detectDuplicateBankAccounts,
  holdersBlockedForDuplicate,
  type BankAccountHolder,
} from '../../packages/bank-controls/src/index';
import { money } from '../../packages/contracts/src/money';
import { requestApproval, decide, type Approver } from '../../packages/approvals/src/index';

// Bank changes need independent verification (maker ≠ approver), and a shared bank
// account across holders is flagged and blocks payment (M06-FR-01 / M15-FR-03).

const AT = '2026-08-02T21:00:00Z';

function approvalFor(subjectRef: string, by = 'finance-9') {
  const req = requestApproval({
    id: subjectRef,
    subjectType: 'bank_change',
    subjectRef,
    requestedBy: 'requester-0',
    value: money(0, 'INR'),
  });
  const approver: Approver = { userId: by, branchScope: 'all', authorityLimit: null };
  const outcome = decide(req, approver, 'approved', 'callback verified', AT);
  if (!outcome.ok) throw new Error('expected approval');
  return outcome.request;
}

function change(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bc-1',
    supplierId: 'sup-1',
    requestedBy: 'purchase-1',
    newAccountRef: 'ACCT-****1234',
    at: AT,
    ...overrides,
  };
}

describe('verifyBankChange', () => {
  it('verifies a change approved independently by a different person', () => {
    const verified = verifyBankChange(change({ approval: approvalFor('bc-1') }));
    expect(verified.status).toBe('verified');
    expect(verified.verifiedBy).toBe('finance-9');
  });

  it('blocks payment when the change is not verified', () => {
    expect(() => verifyBankChange(change())).toThrow(BankChangeUnverifiedError);
  });

  it('rejects a self-approved bank change (creator cannot approve) (§28)', () => {
    const selfApproval = approvalFor('bc-1', 'purchase-1'); // same as requestedBy
    expect(() => verifyBankChange(change({ approval: selfApproval }))).toThrow(
      BankChangeUnverifiedError,
    );
  });

  it('isPayable requires no block and no unverified change', () => {
    expect(isPayable({})).toBe(true);
    expect(isPayable({ blocked: true })).toBe(false);
    expect(isPayable({ hasUnverifiedBankChange: true })).toBe(false);
  });
});

describe('detectDuplicateBankAccounts', () => {
  it('flags an account shared by two distinct holders', () => {
    const holders: BankAccountHolder[] = [
      { holderId: 'sup-1', holderType: 'supplier', accountRef: 'A1' },
      { holderId: 'sup-2', holderType: 'supplier', accountRef: 'A1' }, // shares A1
      { holderId: 'sup-3', holderType: 'supplier', accountRef: 'A2' },
    ];
    const flags = detectDuplicateBankAccounts(holders);
    expect(flags).toHaveLength(1);
    expect(flags[0]?.accountRef).toBe('A1');
    expect(flags[0]?.holders.map((h) => h.holderId)).toEqual(['sup-1', 'sup-2']);
  });

  it('flags a supplier and an employee sharing an account (related-party risk)', () => {
    const flags = detectDuplicateBankAccounts([
      { holderId: 'sup-1', holderType: 'supplier', accountRef: 'X' },
      { holderId: 'emp-7', holderType: 'employee', accountRef: 'X' },
    ]);
    expect(flags).toHaveLength(1);
    const blocked = holdersBlockedForDuplicate(flags);
    expect(blocked.has('sup-1')).toBe(true);
    expect(blocked.has('emp-7')).toBe(true);
  });

  it('does not flag a single holder listing the same account twice', () => {
    const flags = detectDuplicateBankAccounts([
      { holderId: 'sup-1', holderType: 'supplier', accountRef: 'A1' },
      { holderId: 'sup-1', holderType: 'supplier', accountRef: 'A1' },
    ]);
    expect(flags).toEqual([]);
  });

  it('returns no flags when every account is unique', () => {
    const flags = detectDuplicateBankAccounts([
      { holderId: 'sup-1', holderType: 'supplier', accountRef: 'A1' },
      { holderId: 'sup-2', holderType: 'supplier', accountRef: 'A2' },
    ]);
    expect(flags).toEqual([]);
    expect(holdersBlockedForDuplicate(flags).size).toBe(0);
  });
});
