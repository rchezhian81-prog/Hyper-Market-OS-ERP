// Payroll — the accounting journal + cost-centre posting (WP3 inc6). A locked pay run is not finished when
// the bank file is made: the books must record it. This turns a run's totals into a BALANCED double-entry
// journal — the salary expense (optionally split across cost-centres) and the employer's own PF/ESI cost on
// the debit side; the net pay owed and each statutory payable (PF, ESI, PT, TDS) on the credit side.
//
// One invariant governs everything: **total debits === total credits**. It is asserted, and a run whose net
// does not equal gross minus its deductions makes the journal fail to balance and is REFUSED — a payroll
// that posts an unbalanced journal has quietly corrupted the books. Like every other output, it is produced
// only from a LOCKED run. Exact integer paise. Pure and deterministic.

import type { PayRunState } from './pay-run';

export type DrCr = 'debit' | 'credit';

export interface JournalLine {
  readonly account: string;
  readonly drcr: DrCr;
  readonly amountMinor: number;
  /** Cost-centre tag for a split salary-expense line. */
  readonly costCentre?: string;
}

export interface PayrollJournal {
  readonly payPeriod: string;
  readonly lines: readonly JournalLine[];
  readonly totalDebitMinor: number;
  readonly totalCreditMinor: number;
  readonly balanced: true;
  readonly confirmWithCa: true;
  readonly detail: string;
}

/** A run's aggregated money, the input to the posting. */
export interface PayrollTotals {
  readonly grossMinor: number;
  readonly pfEmployeeMinor: number;
  readonly pfEmployerMinor: number;
  readonly esiEmployeeMinor: number;
  readonly esiEmployerMinor: number;
  readonly professionalTaxMinor: number;
  readonly tdsMinor: number;
  readonly netMinor: number;
}

export interface CostCentreGross {
  readonly code: string;
  readonly grossMinor: number;
}

export class InvalidPayrollJournal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPayrollJournal';
  }
}

const TOTAL_FIELDS: readonly (keyof PayrollTotals)[] = [
  'grossMinor', 'pfEmployeeMinor', 'pfEmployerMinor', 'esiEmployeeMinor', 'esiEmployerMinor', 'professionalTaxMinor', 'tdsMinor', 'netMinor',
];

/**
 * Build the balanced double-entry payroll journal for a LOCKED pay run. The salary expense is one debit
 * line, or one per cost-centre when a breakdown is given (which must sum to gross). Employer PF/ESI are
 * debits; net pay and each statutory payable are credits. Zero lines are omitted. Throws
 * `InvalidPayrollJournal` if the run is not locked, an amount is not a whole non-negative paise value, a
 * cost-centre split does not sum to gross, or the debits and credits do not balance. Pure.
 */
export function buildPayrollJournal(input: {
  readonly payRunState: PayRunState;
  readonly payPeriod: string;
  readonly totals: PayrollTotals;
  readonly costCentres?: readonly CostCentreGross[];
}): PayrollJournal {
  if (input.payRunState !== 'locked') {
    throw new InvalidPayrollJournal(`a payroll journal can only be posted from a LOCKED pay run — this run is ${input.payRunState}`);
  }
  const t = input.totals;
  for (const f of TOTAL_FIELDS) {
    if (!Number.isInteger(t[f]) || t[f] < 0) throw new InvalidPayrollJournal(`${f} must be a whole, non-negative paise amount`);
  }

  const lines: JournalLine[] = [];

  // Debit — salary expense, split by cost-centre if given.
  if (input.costCentres !== undefined && input.costCentres.length > 0) {
    let sum = 0;
    for (const cc of input.costCentres) {
      if (!Number.isInteger(cc.grossMinor) || cc.grossMinor < 0) throw new InvalidPayrollJournal(`cost-centre "${cc.code}" gross must be a whole, non-negative paise amount`);
      sum += cc.grossMinor;
      if (cc.grossMinor > 0) lines.push({ account: 'Salaries & Wages', drcr: 'debit', amountMinor: cc.grossMinor, costCentre: cc.code });
    }
    if (sum !== t.grossMinor) throw new InvalidPayrollJournal(`the cost-centre gross (${sum}) does not sum to the run gross (${t.grossMinor})`);
  } else if (t.grossMinor > 0) {
    lines.push({ account: 'Salaries & Wages', drcr: 'debit', amountMinor: t.grossMinor });
  }
  // Debit — employer's own statutory cost.
  if (t.pfEmployerMinor > 0) lines.push({ account: 'Employer PF Contribution', drcr: 'debit', amountMinor: t.pfEmployerMinor });
  if (t.esiEmployerMinor > 0) lines.push({ account: 'Employer ESI Contribution', drcr: 'debit', amountMinor: t.esiEmployerMinor });

  // Credit — what is owed out.
  if (t.netMinor > 0) lines.push({ account: 'Net Pay Payable', drcr: 'credit', amountMinor: t.netMinor });
  const pfPayable = t.pfEmployeeMinor + t.pfEmployerMinor;
  if (pfPayable > 0) lines.push({ account: 'PF Payable', drcr: 'credit', amountMinor: pfPayable });
  const esiPayable = t.esiEmployeeMinor + t.esiEmployerMinor;
  if (esiPayable > 0) lines.push({ account: 'ESI Payable', drcr: 'credit', amountMinor: esiPayable });
  if (t.professionalTaxMinor > 0) lines.push({ account: 'Professional Tax Payable', drcr: 'credit', amountMinor: t.professionalTaxMinor });
  if (t.tdsMinor > 0) lines.push({ account: 'TDS Payable', drcr: 'credit', amountMinor: t.tdsMinor });

  const totalDebitMinor = lines.filter((l) => l.drcr === 'debit').reduce((s, l) => s + l.amountMinor, 0);
  const totalCreditMinor = lines.filter((l) => l.drcr === 'credit').reduce((s, l) => s + l.amountMinor, 0);
  if (totalDebitMinor !== totalCreditMinor) {
    // The usual cause: the supplied net does not equal gross − (PF + ESI + PT + TDS) employee shares.
    throw new InvalidPayrollJournal(`the journal does not balance: debits ${totalDebitMinor} ≠ credits ${totalCreditMinor} — check that net = gross − (employee PF + ESI + PT + TDS)`);
  }

  return {
    payPeriod: input.payPeriod,
    lines,
    totalDebitMinor,
    totalCreditMinor,
    balanced: true,
    confirmWithCa: true,
    detail: `${input.payPeriod}: ${lines.length} lines, debits = credits = ${totalDebitMinor}`,
  };
}
