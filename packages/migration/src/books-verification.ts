// Proving the opening books against the accounts the CA prepared — MG-06, OB-06, §34.
//
// The last of the six external checks, and the one that ties the other five together: **the
// signed closing balance sheet IS the opening position.** Stock, debtors, creditors, cash and tax
// all appear on it, each already proved by its own evidence — so if the migrated opening trial
// balance agrees with the signed accounts line by line, every earlier check has agreed too.
//
// It is also, honestly, **the weakest of the six as independent evidence**, and saying so matters.
// The bank statement is an adversary's record. A supplier's statement is a counterparty's. A
// physical count is the shelves themselves. The CA's accounts are none of those: they were
// *prepared* from the same old system we are migrating, by somebody reading the same reports. What
// they add is not an independent source — it is a **professional signature and the discipline of
// double entry**, which is a different kind of strength and not a substitute for the other five.
//
// What this module refuses, and why:
//
//   • **A BALANCING FIGURE IS REFUSED BY NAME.** When an opening trial balance does not balance,
//     the universal move is to post the difference to Suspense, or "Opening Difference", or
//     "Diff A/c", and open anyway. The books then balance perfectly and are wrong, and that
//     account is **never cleared** — it is still there years later, and by then nobody alive knows
//     what it was. It is the same failure as a commission rate derived from the gap it explains:
//     the arithmetic is made to close by naming the hole rather than finding it.
//
//   • **DRAFT ACCOUNTS ARE NOT ACCOUNTS.** Unsigned figures can still change, and the whole reason
//     to reconcile to the CA's numbers is that somebody has put their name and membership number
//     against them. The same distinction as a filed return's acknowledgement.
//
//   • **THE ACCOUNTS MUST END WHERE THE BOOKS OPEN.** A signed balance sheet is a position at one
//     instant. If the cutover is not the day after the accounts' period end there is a gap the
//     accounts do not cover, and using them as the opening position is out by a whole trading
//     period while looking authoritative.
//
//   • **WHAT ONLY THE CA HAS MUST ARRIVE.** Depreciation, provisions, accruals, prepayments,
//     drawings and the year-end journals exist **only** in the CA's books — no ERP extract will
//     ever contain them. Migrate without them and the books open incomplete by exactly their
//     value, which is the difference that then gets forced into suspense. So they are named up
//     front and their absence is a refusal, not a variance.
//
// Pure and deterministic: no I/O, no clock. Money is integer minor units (§29.1).

export type AccountNature = 'asset' | 'liability' | 'equity' | 'income' | 'expense';

/** Which side an account of each nature normally carries its balance on. */
export const NATURAL_SIDE: Readonly<Record<AccountNature, 'debit' | 'credit'>> = {
  asset: 'debit',
  expense: 'debit',
  liability: 'credit',
  equity: 'credit',
  income: 'credit',
};

export interface TrialBalanceLine {
  readonly accountCode: string;
  readonly accountName: string;
  readonly nature: AccountNature;
  readonly debitMinor: number;
  readonly creditMinor: number;
  /**
   * A contra account — one that deliberately sits on the opposite side to its nature.
   *
   * Drawings is equity and always debit. Accumulated depreciation and provision for doubtful debts
   * are assets and always credit. Without this, the wrong-side check fires on every correctly
   * prepared set of books, and a flag that is always on is a flag nobody reads.
   */
  readonly contra?: boolean;
}

/** The side a line is expected to carry its balance on, contra accounts included. */
export const expectedSide = (l: TrialBalanceLine): 'debit' | 'credit' => {
  const natural = NATURAL_SIDE[l.nature];
  return l.contra === true ? (natural === 'debit' ? 'credit' : 'debit') : natural;
};

/** Debit-positive balance for a line. One convention throughout, so the totals sum to zero. */
export const balanceOfLine = (l: TrialBalanceLine): number => l.debitMinor - l.creditMinor;

export interface SignedAccounts {
  readonly entity: string;
  /** The date the accounts are drawn to — a position at one instant. */
  readonly periodEnd: string;
  readonly preparedBy: string;
  readonly signedOn?: string;
  /**
   * The preparer's professional membership number.
   *
   * What makes these accounts evidence rather than a working file: somebody with a licence at
   * stake has put their name to them.
   */
  readonly membershipNumber?: string;
  readonly lines: readonly TrialBalanceLine[];
}

/**
 * Account names that mean *"we could not make it balance."*
 *
 * Deliberately a name test rather than a value test: the account is created precisely so the
 * difference has somewhere to go, and it is always called one of these things.
 */
const A_BALANCING_FIGURE =
  /\b(suspense|balancing[ -]?figure|opening[ -]?difference|difference[ -]?in[ -]?opening|to[ -]?balance|unreconciled|plug)\b|\bdiff(erence)?[ -]?a\/?c\b/i;

export const looksLikeABalancingFigure = (accountName: string): boolean =>
  A_BALANCING_FIGURE.test(accountName);

export type AccountsRefusal =
  | 'not_signed'
  | 'the_accounts_do_not_balance'
  | 'the_accounts_carry_a_balancing_figure'
  | 'no_lines';

export interface AccountsAcceptance {
  readonly ok: boolean;
  readonly refusedBecause?: AccountsRefusal;
  readonly detail: string;
}

/**
 * Accept the signed accounts as the fixed point, or refuse them with a reason.
 *
 * Runs on its own before any comparison — the same shape as `assertNonProduction`,
 * `acceptRouteTerms` and `acceptFiledReturn`.
 */
export function acceptSignedAccounts(accounts: SignedAccounts): AccountsAcceptance {
  if (accounts.membershipNumber === undefined || accounts.membershipNumber.trim() === ''
    || accounts.signedOn === undefined || accounts.signedOn.trim() === '') {
    return {
      ok: false,
      refusedBecause: 'not_signed',
      detail: `the accounts to ${accounts.periodEnd} are not signed. Draft figures still change, and the entire reason to reconcile to them is that somebody with a licence at stake has put their name and membership number against them`,
    };
  }

  if (accounts.lines.length === 0) {
    return { ok: false, refusedBecause: 'no_lines', detail: `the accounts to ${accounts.periodEnd} carry no lines` };
  }

  const carried = accounts.lines.filter((l) => looksLikeABalancingFigure(l.accountName) && balanceOfLine(l) !== 0);
  if (carried.length > 0) {
    return {
      ok: false,
      refusedBecause: 'the_accounts_carry_a_balancing_figure',
      detail: `the signed accounts themselves carry ${carried.map((l) => `${l.accountName} at ${balanceOfLine(l)}`).join(', ')}. That difference is inherited, not created by this migration — but it cannot become an opening balance without the owner and the CA deciding what it is, because after cutover nobody will ever be able to work it out`,
    };
  }

  const out = accounts.lines.reduce((t, l) => t + balanceOfLine(l), 0);
  if (out !== 0) {
    return {
      ok: false,
      refusedBecause: 'the_accounts_do_not_balance',
      detail: `the signed accounts are out by ${out}. A trial balance that does not balance is not a position — using it as the opening one would put that difference into our books permanently`,
    };
  }

  return {
    ok: true,
    detail: `accounts to ${accounts.periodEnd} accepted — signed ${accounts.signedOn} by ${accounts.preparedBy} (${accounts.membershipNumber}), balancing at ${accounts.lines.reduce((t, l) => t + l.debitMinor, 0)}`,
  };
}

export type LineStatus = 'agrees' | 'differs' | 'missing_from_the_opening' | 'not_in_the_accounts';

export interface LineComparison {
  readonly accountCode: string;
  readonly accountName: string;
  readonly status: LineStatus;
  readonly accountsBalanceMinor: number;
  readonly openingBalanceMinor: number;
  /** opening − accounts. The accounts are the fixed point, so the sign points at the correction. */
  readonly differenceMinor: number;
  readonly detail: string;
}

export interface WrongSideFlag {
  readonly accountCode: string;
  readonly accountName: string;
  readonly nature: AccountNature;
  readonly balanceMinor: number;
  readonly detail: string;
}

export type OpeningBooksRefusal =
  | AccountsRefusal
  | 'the_accounts_do_not_end_where_the_books_open'
  | 'a_balancing_figure_was_used'
  | 'what_only_the_ca_has_is_missing';

export interface OpeningBooksReconciliation {
  readonly cutoverDate: string;
  readonly accepted: boolean;
  readonly refusedBecause?: OpeningBooksRefusal;
  readonly lines: readonly LineComparison[];
  /** Debits less credits in the migrated opening. Must be zero, and never made zero. */
  readonly outOfBalanceByMinor: number;
  readonly balances: boolean;
  /** Accounts on the signed accounts that never reached the opening books. */
  readonly missingFromOpening: readonly string[];
  /** Balances sitting on the side their nature does not expect. Flagged for explanation, not refused. */
  readonly onTheWrongSide: readonly WrongSideFlag[];
  readonly reconciles: boolean;
  /**
   * Typed as the literal `false`. The CA prepared these accounts **from the same old system** —
   * they carry a signature and the discipline of double entry, not an independent source. The
   * bank, the suppliers and the shelves are the independent evidence; this confirms they were
   * assembled correctly, not that they were true.
   */
  readonly provesTheAccountsAreRight: false;
  readonly detail: string;
  readonly ownerAction: string;
}

/** Accounts that exist only in the CA's books, and that no ERP extract will ever contain. */
export const ONLY_THE_CA_HAS: readonly string[] = [
  'depreciation', 'provision', 'accrual', 'prepayment', 'drawings', 'year-end journal',
];

function addDays(from: string, n: number): string {
  const [y = 0, m = 1, d = 1] = from.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Reconcile the migrated opening trial balance against the signed accounts.
 *
 * The accounts are the fixed point. Where the two differ it is the opening books that move — and
 * they move by being **corrected**, never by a line that absorbs the remainder.
 */
export function reconcileOpeningBooks(input: {
  readonly accounts: SignedAccounts;
  readonly opening: readonly TrialBalanceLine[];
  /** The date the new books open. Must be the day after the accounts' period end. */
  readonly cutoverDate: string;
  /**
   * Account codes that can only come from the CA — depreciation, provisions, drawings and the
   * year-end journals. Named up front, because their absence looks exactly like a small variance
   * and is in fact the whole reason the books will not balance.
   */
  readonly caOnlyAccountCodes?: readonly string[];
  readonly toleranceMinor?: number;
}): OpeningBooksReconciliation {
  const tolerance = input.toleranceMinor ?? 0;

  const empty = (detail: string, refusedBecause: OpeningBooksRefusal): OpeningBooksReconciliation => ({
    cutoverDate: input.cutoverDate, accepted: false, refusedBecause, lines: [],
    outOfBalanceByMinor: 0, balances: false, missingFromOpening: [], onTheWrongSide: [],
    reconciles: false, provesTheAccountsAreRight: false, detail, ownerAction: detail,
  });

  const acceptance = acceptSignedAccounts(input.accounts);
  if (!acceptance.ok) return empty(acceptance.detail, acceptance.refusedBecause!);

  const opensOn = addDays(input.accounts.periodEnd, 1);
  if (input.cutoverDate !== opensOn) {
    return empty(
      `the accounts are drawn to ${input.accounts.periodEnd} and the books open on ${input.cutoverDate}, not ${opensOn}. A signed balance sheet is a position at one instant — everything traded in between is missing from it, so using it as the opening position is out by a whole trading period while looking entirely authoritative`,
      'the_accounts_do_not_end_where_the_books_open',
    );
  }

  // The refusal this module exists for. Checked before the balance, so that a set of books which
  // balances only because of the plug is never reported as balancing.
  const plugs = input.opening.filter((l) => looksLikeABalancingFigure(l.accountName) && balanceOfLine(l) !== 0);
  if (plugs.length > 0) {
    return empty(
      `the opening books carry ${plugs.map((l) => `${l.accountName} at ${balanceOfLine(l)}`).join(', ')}. That is the difference given a name rather than found. The books balance and they are wrong, and that account is never cleared — it will still be there in five years and nobody will know what it was. Find the difference`,
      'a_balancing_figure_was_used',
    );
  }

  const caOnly = input.caOnlyAccountCodes ?? [];
  const openingCodes = new Set(input.opening.map((l) => l.accountCode));
  const caOnlyMissing = caOnly.filter((c) => !openingCodes.has(c)).sort();
  if (caOnlyMissing.length > 0) {
    return empty(
      `${caOnlyMissing.join(', ')} are in the signed accounts and not in the opening books. Depreciation, provisions, accruals and drawings exist only in the CA's books — no export from the old system will ever contain them, so their absence is not a variance to investigate: it is exactly the amount by which the books will fail to balance, and exactly what would end up in suspense`,
      'what_only_the_ca_has_is_missing',
    );
  }

  const byCode = new Map<string, { acc?: TrialBalanceLine; open?: TrialBalanceLine }>();
  for (const l of input.accounts.lines) byCode.set(l.accountCode, { ...byCode.get(l.accountCode), acc: l });
  for (const l of input.opening) byCode.set(l.accountCode, { ...byCode.get(l.accountCode), open: l });

  const lines: LineComparison[] = [];
  for (const accountCode of [...byCode.keys()].sort()) {
    const { acc, open } = byCode.get(accountCode)!;
    const accountsBalanceMinor = acc === undefined ? 0 : balanceOfLine(acc);
    const openingBalanceMinor = open === undefined ? 0 : balanceOfLine(open);
    const differenceMinor = openingBalanceMinor - accountsBalanceMinor;
    const accountName = acc?.accountName ?? open?.accountName ?? accountCode;

    const status: LineStatus = acc === undefined ? 'not_in_the_accounts'
      : open === undefined ? 'missing_from_the_opening'
        : Math.abs(differenceMinor) <= tolerance ? 'agrees' : 'differs';

    lines.push({
      accountCode, accountName, status, accountsBalanceMinor, openingBalanceMinor, differenceMinor,
      detail: status === 'agrees'
        ? `${accountName}: agrees at ${accountsBalanceMinor}`
        : status === 'missing_from_the_opening'
          ? `${accountName}: ${accountsBalanceMinor} on the signed accounts and nothing in the opening books`
          : status === 'not_in_the_accounts'
            ? `${accountName}: ${openingBalanceMinor} in the opening books and not on the signed accounts at all — either it arose after the year end, or it should not be there`
            : `${accountName}: signed at ${accountsBalanceMinor}, opening at ${openingBalanceMinor}. The accounts are signed, so the opening moves by ${-differenceMinor}`,
    });
  }

  const outOfBalanceByMinor = input.opening.reduce((t, l) => t + balanceOfLine(l), 0);
  const balances = outOfBalanceByMinor === 0;

  // A balance on the unexpected side is not automatically wrong — an overdrawn bank account is a
  // credit balance on an asset, and it is real. It needs a sentence against it, not a refusal.
  const onTheWrongSide: WrongSideFlag[] = input.opening
    .filter((l) => {
      const b = balanceOfLine(l);
      return b !== 0 && (expectedSide(l) === 'debit' ? b < 0 : b > 0);
    })
    .map((l) => ({
      accountCode: l.accountCode, accountName: l.accountName, nature: l.nature,
      balanceMinor: balanceOfLine(l),
      detail: `${l.accountName} is ${l.nature === 'asset' || l.nature === 'expense' ? 'an' : 'a'} ${l.nature}${l.contra === true ? ' contra account' : ''} carrying a ${expectedSide(l) === 'debit' ? 'credit' : 'debit'} balance. Sometimes right — an overdrawn bank account is exactly this — and sometimes a sign read backwards on the way in. It needs a sentence against it either way`,
    }));

  const differing = lines.filter((l) => l.status !== 'agrees');
  const missingFromOpening = lines.filter((l) => l.status === 'missing_from_the_opening').map((l) => l.accountCode);
  const reconciles = balances && differing.length === 0;

  return {
    cutoverDate: input.cutoverDate,
    accepted: true,
    lines,
    outOfBalanceByMinor,
    balances,
    missingFromOpening,
    onTheWrongSide,
    reconciles,
    provesTheAccountsAreRight: false,
    detail: reconciles
      ? `the opening books at ${input.cutoverDate} agree with the accounts signed to ${input.accounts.periodEnd}, account by account, and balance`
      : `${differing.length} account(s) differ from the signed accounts${balances ? ' and the opening balances' : `, and the opening is out by ${outOfBalanceByMinor}`}`,
    ownerAction: !balances
      ? `the opening books are out by ${outOfBalanceByMinor}. This is the moment the difference gets posted to Suspense and forgotten — the software refuses that, so the number has to be found. ${differing.length > 0 ? `${differing.length} account(s) already differ from the signed accounts, which is where to look first` : 'Every account matches the signed accounts, so the difference is in an account that is not on them'}`
      : missingFromOpening.length > 0
        ? `${missingFromOpening.length} account(s) on the signed accounts never reached the opening books: ${missingFromOpening.join(', ')}. They balance to zero between them, which is why nothing looked wrong`
        : differing.length > 0
          ? `${differing.length} account(s) differ from what the CA signed. The accounts carry a signature and cannot be adjusted to suit us, so each one is a correction to the opening books — each listed with the amount and the direction`
          : reconciles
            ? 'nothing — the opening books match the signed accounts and balance'
            : 'the opening books balance but do not match the signed accounts account for account',
  };
}
