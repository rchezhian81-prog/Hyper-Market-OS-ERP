import { describe, it, expect } from 'vitest';
import {
  acceptSignedAccounts, reconcileOpeningBooks, looksLikeABalancingFigure, balanceOfLine,
  NATURAL_SIDE, ONLY_THE_CA_HAS, expectedSide,
  type SignedAccounts, type TrialBalanceLine,
} from '../../packages/migration/src/books-verification';

// MG-06, OB-06, §34 — the migrated opening books against the accounts the CA signed. The last of
// the six external checks, and the one that ties the other five together.

const dr = (accountCode: string, accountName: string, nature: TrialBalanceLine['nature'], debitMinor: number): TrialBalanceLine =>
  ({ accountCode, accountName, nature, debitMinor, creditMinor: 0 });
const cr = (accountCode: string, accountName: string, nature: TrialBalanceLine['nature'], creditMinor: number): TrialBalanceLine =>
  ({ accountCode, accountName, nature, debitMinor: 0, creditMinor });

const LINES: readonly TrialBalanceLine[] = [
  dr('1000', 'Stock on hand', 'asset', 5_000_000),
  dr('1100', 'Trade debtors', 'asset', 800_000),
  dr('1200', 'Bank current account', 'asset', 1_200_000),
  dr('1300', 'Cash in hand', 'asset', 150_000),
  dr('1400', 'Prepayments', 'asset', 100_000),
  dr('1500', 'Fixtures net of depreciation', 'asset', 2_000_000),
  { ...dr('3100', 'Drawings', 'equity', 300_000), contra: true },
  cr('2000', 'Trade creditors', 'liability', 3_000_000),
  cr('2100', 'GST payable', 'liability', 800_000),
  cr('2200', 'Provision for audit fee', 'liability', 100_000),
  cr('3000', "Proprietor's capital", 'equity', 5_650_000),
];

/** Depreciation, provisions, prepayments and drawings live only in the CA's books. */
const CA_ONLY = ['1400', '1500', '2200', '3100'];

const accounts = (over: Partial<SignedAccounts> = {}): SignedAccounts => ({
  entity: 'SRE Hyper Market', periodEnd: '2026-03-31',
  preparedBy: 'R. Krishnamurthy & Co', signedOn: '2026-07-18', membershipNumber: 'ICAI-214477',
  lines: LINES, ...over,
});

const reconcile = (over: Partial<Parameters<typeof reconcileOpeningBooks>[0]> = {}) =>
  reconcileOpeningBooks({
    accounts: accounts(), opening: LINES, cutoverDate: '2026-04-01',
    caOnlyAccountCodes: CA_ONLY, ...over,
  });

const line = (r: ReturnType<typeof reconcile>, code: string) => r.lines.find((l) => l.accountCode === code)!;

describe('a balancing figure is refused by name', () => {
  it('catches the account whatever it was called this time', () => {
    for (const name of [
      'Suspense', 'Suspense A/c', 'Opening Difference', 'Difference in Opening Balance',
      'Balancing figure', 'Diff A/c', 'Diff-A/C', 'To Balance', 'Unreconciled items', 'Plug',
    ]) {
      expect(looksLikeABalancingFigure(name)).toBe(true);
    }
  });

  it('does not catch an ordinary account that happens to mention a difference', () => {
    for (const name of ['Exchange rate differences', 'Rounding adjustments', 'Price difference on purchases']) {
      expect(looksLikeABalancingFigure(name)).toBe(false);
    }
  });

  it('REFUSES opening books that carry one', () => {
    const r = reconcile({
      opening: [...LINES, cr('9999', 'Suspense A/c', 'liability', 45_000)],
    });
    expect(r.accepted).toBe(false);
    expect(r.refusedBecause).toBe('a_balancing_figure_was_used');
    expect(r.detail).toContain('the difference given a name rather than found');
    expect(r.detail).toContain('nobody will know what it was');
  });

  it('refuses BEFORE the balance check, so a plugged book never reports as balancing', () => {
    // This is the whole point. Post the difference to Suspense and the trial balance closes
    // perfectly — a set of books that balances and is wrong, with an account nobody ever clears.
    const missingAndPlugged: readonly TrialBalanceLine[] = [
      ...LINES.filter((l) => l.accountCode !== '1100'),
      cr('9999', 'Opening Difference', 'liability', 0),
      dr('9999', 'Opening Difference', 'liability', 800_000),
    ].filter((l) => balanceOfLine(l) !== 0);

    expect(missingAndPlugged.reduce((t, l) => t + balanceOfLine(l), 0)).toBe(0); // it balances
    const r = reconcile({ opening: missingAndPlugged });
    expect(r.refusedBecause).toBe('a_balancing_figure_was_used');
    expect(r.balances).toBe(false); // never reported as balancing on the strength of the plug
    expect(r.reconciles).toBe(false);
  });

  it('leaves a suspense account with no balance alone', () => {
    // The name in a chart of accounts is not the problem; a balance sitting in it is.
    const r = reconcile({ opening: [...LINES, { accountCode: '9999', accountName: 'Suspense', nature: 'liability', debitMinor: 0, creditMinor: 0 }] });
    expect(r.accepted).toBe(true);
  });

  it('refuses accounts the CA themselves left a balancing figure in', () => {
    const a = acceptSignedAccounts(accounts({
      lines: [...LINES.filter((l) => l.accountCode !== '2100'), cr('2100', 'GST payable', 'liability', 700_000), cr('9999', 'Suspense', 'liability', 100_000)],
    }));
    expect(a.ok).toBe(false);
    expect(a.refusedBecause).toBe('the_accounts_carry_a_balancing_figure');
    expect(a.detail).toContain('inherited, not created by this migration');
  });
});

describe('what makes the accounts usable as the fixed point', () => {
  it('REFUSES draft accounts, because unsigned figures still change', () => {
    expect(acceptSignedAccounts(accounts({ membershipNumber: undefined })).refusedBecause).toBe('not_signed');
    expect(acceptSignedAccounts(accounts({ signedOn: '' })).refusedBecause).toBe('not_signed');
    expect(acceptSignedAccounts(accounts({ membershipNumber: undefined })).detail)
      .toContain('somebody with a licence at stake');
  });

  it('REFUSES accounts that do not balance', () => {
    const a = acceptSignedAccounts(accounts({ lines: LINES.filter((l) => l.accountCode !== '1300') }));
    expect(a.refusedBecause).toBe('the_accounts_do_not_balance');
    expect(a.detail).toContain('would put that difference into our books permanently');
  });

  it('accepts properly signed accounts and names who signed them', () => {
    const a = acceptSignedAccounts(accounts());
    expect(a.ok).toBe(true);
    expect(a.detail).toContain('ICAI-214477');
    expect(a.detail).toContain('R. Krishnamurthy & Co');
  });

  it('REFUSES a cutover that is not the day after the accounts end', () => {
    // A signed balance sheet is a position at one instant. Everything traded in between is
    // missing from it — so the opening is out by a whole trading period, and looks authoritative.
    const r = reconcile({ cutoverDate: '2026-04-02' });
    expect(r.refusedBecause).toBe('the_accounts_do_not_end_where_the_books_open');
    expect(r.detail).toContain('out by a whole trading period');
    expect(reconcile({ cutoverDate: '2026-04-01' }).accepted).toBe(true);
  });
});

describe('what only the CA has', () => {
  it('names the categories no export will ever contain', () => {
    expect(ONLY_THE_CA_HAS).toContain('depreciation');
    expect(ONLY_THE_CA_HAS).toContain('provision');
    expect(ONLY_THE_CA_HAS).toContain('drawings');
  });

  it('REFUSES an opening that is missing them, rather than reporting a variance', () => {
    // Their absence is not something to investigate: it is exactly the amount by which the books
    // will fail to balance, and exactly what would otherwise end up in suspense.
    const r = reconcile({ opening: LINES.filter((l) => !CA_ONLY.includes(l.accountCode)) });
    expect(r.refusedBecause).toBe('what_only_the_ca_has_is_missing');
    expect(r.detail).toContain('1400, 1500, 2200, 3100');
    expect(r.detail).toContain('no export from the old system will ever contain them');
  });
});

describe('the accounts are the fixed point', () => {
  it('reconciles an opening that matches and balances', () => {
    const r = reconcile();
    expect(r.accepted).toBe(true);
    expect(r.balances).toBe(true);
    expect(r.outOfBalanceByMinor).toBe(0);
    expect(r.reconciles).toBe(true);
    expect(r.ownerAction).toBe('nothing — the opening books match the signed accounts and balance');
  });

  it('points the correction at the opening books, never at the signed accounts', () => {
    // 50,000 sitting in the wrong account. The trial balance still closes, so only the
    // account-by-account comparison against the signed figures finds it.
    const r = reconcile({
      opening: LINES.map((l) => (l.accountCode === '2000' ? cr('2000', 'Trade creditors', 'liability', 2_950_000)
        : l.accountCode === '2100' ? cr('2100', 'GST payable', 'liability', 850_000) : l)),
    });
    expect(r.balances).toBe(true);
    expect(r.reconciles).toBe(false);
    expect(line(r, '2000').status).toBe('differs');
    // Creditors understated by 50,000: opening −2,950,000 against −3,000,000 signed.
    expect(line(r, '2000').differenceMinor).toBe(50_000);
    expect(line(r, '2000').detail).toContain('The accounts are signed, so the opening moves by -50000');
    expect(r.ownerAction).toContain('cannot be adjusted to suit us');
  });

  it('catches accounts that vanished in pairs and left the balance intact', () => {
    // The sneaky one: debtors (800,000 Dr) and GST payable (800,000 Cr) both lost in extraction.
    // The trial balance still closes to zero, so nothing looks wrong at all.
    const r = reconcile({ opening: LINES.filter((l) => l.accountCode !== '1100' && l.accountCode !== '2100') });
    expect(r.balances).toBe(true);
    expect(r.reconciles).toBe(false);
    expect(r.missingFromOpening).toEqual(['1100', '2100']);
    expect(r.ownerAction).toContain('which is why nothing looked wrong');
  });

  it('names an account in the opening that is on no signed account', () => {
    const r = reconcile({
      opening: [...LINES, dr('1600', 'Advance to staff', 'asset', 25_000), cr('2300', 'Sundry payable', 'liability', 25_000)],
    });
    expect(line(r, '1600').status).toBe('not_in_the_accounts');
    expect(line(r, '1600').detail).toContain('or it should not be there');
  });

  it('says where to look when the opening does not balance', () => {
    const r = reconcile({ opening: LINES.filter((l) => l.accountCode !== '1300') });
    expect(r.balances).toBe(false);
    expect(r.outOfBalanceByMinor).toBe(-150_000);
    expect(r.ownerAction).toContain('This is the moment the difference gets posted to Suspense and forgotten');
  });
});

describe('a balance on the wrong side is a question, not a failure', () => {
  const overdrawn: readonly TrialBalanceLine[] = [
    dr('1000', 'Stock on hand', 'asset', 500_000),
    cr('1200', 'Bank current account', 'asset', 500_000),
  ];
  const r = reconcileOpeningBooks({
    accounts: accounts({ lines: overdrawn }), opening: overdrawn, cutoverDate: '2026-04-01',
  });

  it('knows which side each nature normally carries', () => {
    expect(NATURAL_SIDE.asset).toBe('debit');
    expect(NATURAL_SIDE.expense).toBe('debit');
    expect(NATURAL_SIDE.liability).toBe('credit');
    expect(NATURAL_SIDE.income).toBe('credit');
    expect(NATURAL_SIDE.equity).toBe('credit');
  });

  it('flags an overdrawn bank without refusing it', () => {
    // Sometimes right — an overdrawn account is exactly this — and sometimes a sign read backwards
    // on the way in. It gets a sentence against it, not a rejection.
    expect(r.reconciles).toBe(true);
    expect(r.onTheWrongSide).toHaveLength(1);
    expect(r.onTheWrongSide[0]?.accountCode).toBe('1200');
    expect(r.onTheWrongSide[0]?.detail).toContain('an overdrawn bank account is exactly this');
  });

  it('does not flag balances sitting where they belong', () => {
    expect(reconcile().onTheWrongSide).toEqual([]);
  });

  it('knows a contra account is meant to sit the other way round', () => {
    // Drawings is equity and always debit; accumulated depreciation is an asset and always
    // credit. Without this the check fires on every correctly prepared set of books — and a flag
    // that is always on is a flag nobody reads.
    const drawings = LINES.find((l) => l.accountCode === '3100')!;
    expect(drawings.contra).toBe(true);
    expect(expectedSide(drawings)).toBe('debit');
    expect(expectedSide({ ...drawings, contra: false })).toBe('credit');
    expect(reconcile().onTheWrongSide.map((f) => f.accountCode)).not.toContain('3100');
  });

  it('still flags a contra account sitting the wrong way for a contra account', () => {
    const flipped = LINES.map((l) => (l.accountCode === '3100'
      ? { ...cr('3100', 'Drawings', 'equity', 300_000), contra: true }
      : l.accountCode === '3000' ? cr('3000', "Proprietor's capital", 'equity', 5_050_000) : l));
    const r = reconcileOpeningBooks({
      accounts: accounts({ lines: flipped }), opening: flipped, cutoverDate: '2026-04-01',
    });
    expect(r.onTheWrongSide.map((f) => f.accountCode)).toContain('3100');
    expect(r.onTheWrongSide[0]?.detail).toContain('contra account');
  });
});

describe('what the CA\'s accounts cannot prove', () => {
  it('states that they are prepared from the same old system', () => {
    // The bank is an adversary's record; the shelves are the shelves. These accounts carry a
    // signature and double entry, not an independent source. Typed as the literal false.
    const proves: false = reconcile().provesTheAccountsAreRight;
    expect(proves).toBe(false);
  });
});
