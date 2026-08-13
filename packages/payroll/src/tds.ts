// Payroll — TDS (income-tax deducted at source) monthly engine (WP3 inc3). From an employee's PROJECTED
// annual income it computes the year's income tax under the chosen regime — slabs, standard deduction, the
// section-87A rebate and the 4% health-&-education cess — and spreads the remaining tax across the months
// left, giving this month's TDS. Folded into the payslip's deductions via `tdsMonthlyMinor`.
//
// Income-tax figures change EVERY finance act, so the regime parameters are an **effective-dated,
// configurable** schedule resolved on the pay date the same way the statutory rates are — and every shipped
// number is a `CONFIRM-WITH-CA` constant. The defaults are the FY 2025-26 (AY 2026-27) figures as widely
// published; the exact slabs, the ₹10 rounding of section 288B, and an employee's declared deductions are
// precisely the things a CA confirms before a live run. Exact integer paise. Pure — no clock, no I/O.

import { InvalidStatutorySchedule } from './statutory';

const RUPEE = 100;
const roundRupee = (minor: number): number => Math.round(minor / RUPEE) * RUPEE;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// --- effective-dated regime parameters ---------------------------------------------------------------

export type TaxRegime = 'new' | 'old';

/** One income-tax slab: income up to `uptoMinor` is taxed at `rateBps`; `null` is the open-ended top slab. */
export interface TaxSlab {
  readonly uptoMinor: number | null;
  readonly rateBps: number;
}

export interface RegimeParams {
  readonly slabs: readonly TaxSlab[];
  /** Standard deduction for salaried income, in paise. CONFIRM-WITH-CA. */
  readonly standardDeductionMinor: number;
  /** Section 87A rebate: total taxable income at or below `incomeCeilingMinor` gets up to `maxRebateMinor`. */
  readonly rebate87A: { readonly incomeCeilingMinor: number; readonly maxRebateMinor: number };
}

export interface TdsParams {
  readonly newRegime: RegimeParams;
  readonly oldRegime: RegimeParams;
  /** Health & education cess in basis points on the tax after rebate (4% = 400). CONFIRM-WITH-CA. */
  readonly cessBps: number;
}

export interface TdsScheduleEntry {
  readonly effectiveFrom: string;
  readonly params: TdsParams;
}

// FY 2025-26 (AY 2026-27) — widely-published figures. EVERY value is CONFIRM-WITH-CA before a live run.
export const DEFAULT_TDS_SCHEDULE: readonly TdsScheduleEntry[] = [
  {
    effectiveFrom: '2025-04-01',
    params: {
      cessBps: 400,
      newRegime: {
        // ₹4L nil · 4–8L 5% · 8–12L 10% · 12–16L 15% · 16–20L 20% · 20–24L 25% · >24L 30%
        slabs: [
          { uptoMinor: 40_000_000, rateBps: 0 },
          { uptoMinor: 80_000_000, rateBps: 500 },
          { uptoMinor: 120_000_000, rateBps: 1000 },
          { uptoMinor: 160_000_000, rateBps: 1500 },
          { uptoMinor: 200_000_000, rateBps: 2000 },
          { uptoMinor: 240_000_000, rateBps: 2500 },
          { uptoMinor: null, rateBps: 3000 },
        ],
        standardDeductionMinor: 7_500_000, // ₹75,000
        rebate87A: { incomeCeilingMinor: 120_000_000, maxRebateMinor: 6_000_000 }, // ≤ ₹12L → up to ₹60,000
      },
      oldRegime: {
        // ₹2.5L nil · 2.5–5L 5% · 5–10L 20% · >10L 30%
        slabs: [
          { uptoMinor: 25_000_000, rateBps: 0 },
          { uptoMinor: 50_000_000, rateBps: 500 },
          { uptoMinor: 100_000_000, rateBps: 2000 },
          { uptoMinor: null, rateBps: 3000 },
        ],
        standardDeductionMinor: 5_000_000, // ₹50,000
        rebate87A: { incomeCeilingMinor: 50_000_000, maxRebateMinor: 1_250_000 }, // ≤ ₹5L → up to ₹12,500
      },
    },
  },
];

/** The TDS parameters in force on the pay date — filter/sort/last, refuse a gap (mirrors the GST-rate engine). */
export function resolveTdsParams(schedule: readonly TdsScheduleEntry[], onDate: string): TdsParams {
  if (!ISO_DATE.test(onDate) || Number.isNaN(Date.parse(onDate))) {
    throw new InvalidStatutorySchedule(`the pay date must be YYYY-MM-DD, but reads "${onDate}"`);
  }
  if (schedule.length === 0) throw new InvalidStatutorySchedule('the TDS schedule is empty');
  for (const e of schedule) {
    if (!ISO_DATE.test(e.effectiveFrom) || Number.isNaN(Date.parse(e.effectiveFrom))) {
      throw new InvalidStatutorySchedule(`a TDS schedule entry effectiveFrom is not a date: "${e.effectiveFrom}"`);
    }
  }
  const applicable = [...schedule].filter((e) => e.effectiveFrom <= onDate).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  const inForce = applicable[applicable.length - 1];
  if (inForce === undefined) throw new InvalidStatutorySchedule(`no TDS parameters are in force on ${onDate} — the earliest entry starts later`);
  return inForce.params;
}

// --- the annual tax + monthly TDS --------------------------------------------------------------------

export interface AnnualTaxResult {
  readonly taxableIncomeMinor: number;
  readonly grossTaxMinor: number; // slab tax before rebate/cess
  readonly rebate87AMinor: number;
  readonly taxAfterRebateMinor: number;
  readonly cessMinor: number;
  readonly totalTaxMinor: number;
}

/** Progressive slab tax on a taxable income (exact integer paise; the numerator is summed then divided once). */
function slabTax(taxableIncomeMinor: number, slabs: readonly TaxSlab[]): number {
  let numerator = 0n;
  let lower = 0;
  for (const slab of slabs) {
    const upper = slab.uptoMinor ?? Number.MAX_SAFE_INTEGER;
    if (taxableIncomeMinor > lower) {
      const portion = Math.min(taxableIncomeMinor, upper) - lower;
      numerator += BigInt(portion) * BigInt(slab.rateBps);
    }
    lower = upper;
    if (taxableIncomeMinor <= upper) break;
  }
  return roundRupee(Number(numerator) / 10_000); // ÷10000 (bps → fraction), rounded to the nearest rupee
}

export interface TdsInput {
  /** The projected annual GROSS income in paise (the caller projects it from the monthly earnings). */
  readonly annualGrossIncomeMinor: number;
  readonly regime: TaxRegime;
  readonly params: TdsParams;
  /** Old-regime declared deductions (80C, etc.) in paise — ignored under the new regime. */
  readonly declaredDeductionsMinor?: number;
  /** Tax already deducted earlier in the year, in paise. Default 0. */
  readonly tdsAlreadyDeductedMinor?: number;
  /** Months remaining in the year INCLUDING this one, to spread the balance over. Default 12. */
  readonly monthsRemaining?: number;
}

export interface TdsResult {
  readonly regime: TaxRegime;
  readonly annualTax: AnnualTaxResult;
  readonly tdsAlreadyDeductedMinor: number;
  readonly monthsRemaining: number;
  readonly tdsMonthlyMinor: number;
  readonly confirmWithCa: true;
  readonly detail: string;
}

/**
 * Compute this month's TDS. Taxable income = annual gross − standard deduction − (old regime: declared
 * deductions); the regime slabs give the gross tax; section 87A rebates it to nil where the income is
 * within the ceiling; 4% cess is added; and the balance after tax already deducted is spread over the
 * remaining months. Never negative. Pure. CONFIRM-WITH-CA.
 */
export function computeTds(input: TdsInput): TdsResult {
  const { annualGrossIncomeMinor, regime, params } = input;
  if (!Number.isInteger(annualGrossIncomeMinor) || annualGrossIncomeMinor < 0) {
    throw new InvalidStatutorySchedule('the annual gross income must be a whole, non-negative paise amount');
  }
  const monthsRemaining = input.monthsRemaining ?? 12;
  if (!Number.isInteger(monthsRemaining) || monthsRemaining < 1 || monthsRemaining > 12) {
    throw new InvalidStatutorySchedule('monthsRemaining must be a whole number between 1 and 12');
  }
  const declared = regime === 'old' ? (input.declaredDeductionsMinor ?? 0) : 0;
  if (!Number.isInteger(declared) || declared < 0) {
    throw new InvalidStatutorySchedule('declaredDeductionsMinor must be a whole, non-negative paise amount');
  }
  const tdsAlreadyDeductedMinor = input.tdsAlreadyDeductedMinor ?? 0;
  if (!Number.isInteger(tdsAlreadyDeductedMinor) || tdsAlreadyDeductedMinor < 0) {
    throw new InvalidStatutorySchedule('tdsAlreadyDeductedMinor must be a whole, non-negative paise amount');
  }

  const rp = regime === 'new' ? params.newRegime : params.oldRegime;
  const taxableIncomeMinor = Math.max(0, annualGrossIncomeMinor - rp.standardDeductionMinor - declared);
  const grossTaxMinor = slabTax(taxableIncomeMinor, rp.slabs);
  const rebate87AMinor = taxableIncomeMinor <= rp.rebate87A.incomeCeilingMinor
    ? Math.min(grossTaxMinor, rp.rebate87A.maxRebateMinor)
    : 0;
  const taxAfterRebateMinor = grossTaxMinor - rebate87AMinor;
  const cessMinor = roundRupee((taxAfterRebateMinor * params.cessBps) / 10_000);
  const totalTaxMinor = taxAfterRebateMinor + cessMinor;

  const balance = Math.max(0, totalTaxMinor - tdsAlreadyDeductedMinor);
  const tdsMonthlyMinor = roundRupee(balance / monthsRemaining);

  return {
    regime,
    annualTax: { taxableIncomeMinor, grossTaxMinor, rebate87AMinor, taxAfterRebateMinor, cessMinor, totalTaxMinor },
    tdsAlreadyDeductedMinor,
    monthsRemaining,
    tdsMonthlyMinor,
    confirmWithCa: true,
    detail: `${regime} regime: taxable ${taxableIncomeMinor} → annual tax ${totalTaxMinor}${rebate87AMinor > 0 ? ` (after ₹${rebate87AMinor / 100} rebate)` : ''}; ${tdsMonthlyMinor} this month over ${monthsRemaining} month(s)`,
  };
}
