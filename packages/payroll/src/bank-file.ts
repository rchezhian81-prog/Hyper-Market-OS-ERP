// Payroll — the salary bank-transfer file (WP3 inc5). The output that actually moves money: a locked pay
// run's per-employee net pay becomes the bulk-salary upload a bank ingests (NEFT/IMPS/RTGS). Two hard
// constraints, because this file is a payment instruction:
//   • **Only from a LOCKED run.** A file cannot be produced from a draft, a submitted or even an approved
//     run — it must be locked (approved and final). This ties the payment to the maker-checker lifecycle.
//   • **Every line must be a payable instruction.** A blank name, a malformed account number or IFSC, a
//     non-positive amount, or the SAME account twice is refused with the reason — a bad line in a bulk file
//     is a payment that fails, bounces, or pays the wrong person.
// A control total (record count + sum of net) travels with the file so the bank upload and the payroll
// agree before anyone releases the batch. Exact integer paise; the file renders rupees to two decimals.
//
// The exact column layout differs by bank; this produces a widely-supported generic layout and marks it
// `confirmWithBank` — the real template is confirmed against the store's bank before a live upload. Pure.

import type { PayRunState } from './pay-run';

const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const ACCOUNT = /^\d{9,18}$/;

export type BankPaymentType = 'NEFT' | 'IMPS' | 'RTGS';

/** One employee's net pay to disburse. */
export interface BankPaymentLine {
  readonly employeeId: string;
  readonly employeeName: string;
  readonly bankAccountNo: string;
  readonly ifsc: string;
  readonly netPayMinor: number;
}

export interface BankFileRow {
  readonly beneficiaryName: string;
  readonly accountNumber: string;
  readonly ifsc: string;
  readonly amountMinor: number;
  readonly paymentType: BankPaymentType;
  readonly remarks: string;
}

export interface BankFile {
  readonly payPeriod: string;
  readonly valueDate?: string;
  readonly paymentType: BankPaymentType;
  readonly recordCount: number;
  readonly totalNetMinor: number;
  readonly rows: readonly BankFileRow[];
  /** The upload as CSV text (header + one row per employee). */
  readonly csv: string;
  readonly confirmWithBank: true;
  readonly detail: string;
}

export class InvalidBankFileInput extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidBankFileInput';
  }
}

/** CSV-escape a field: quote it and double any inner quotes if it contains a comma, quote or newline. */
function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

const rupees = (minor: number): string => (minor / 100).toFixed(2);

/**
 * Build the salary bank-transfer file from a LOCKED pay run's net-pay lines. Refuses unless the run is
 * locked; refuses any line that is not a payable instruction (blank name, bad account/IFSC, non-positive
 * amount) and any duplicate account, naming every problem at once. Carries a control total. Pure.
 */
export function buildBankFile(input: {
  readonly payRunState: PayRunState;
  readonly payPeriod: string;
  readonly lines: readonly BankPaymentLine[];
  readonly valueDate?: string;
  readonly paymentType?: BankPaymentType;
}): BankFile {
  if (input.payRunState !== 'locked') {
    throw new InvalidBankFileInput(`a bank file can only be produced from a LOCKED pay run — this run is ${input.payRunState}; approve and lock it first`);
  }
  if (input.lines.length === 0) {
    throw new InvalidBankFileInput('the pay run has no net-pay lines to disburse');
  }

  const paymentType: BankPaymentType = input.paymentType ?? 'NEFT';
  const problems: string[] = [];
  const seenAccounts = new Set<string>();
  for (const [i, line] of input.lines.entries()) {
    const where = `line ${i + 1} (${line.employeeId || 'no id'})`;
    if (typeof line.employeeName !== 'string' || line.employeeName.trim() === '') problems.push(`${where}: the beneficiary name is blank`);
    if (!ACCOUNT.test(line.bankAccountNo)) problems.push(`${where}: the bank account number must be 9–18 digits`);
    if (!IFSC.test(line.ifsc)) problems.push(`${where}: the IFSC is malformed`);
    if (!Number.isInteger(line.netPayMinor) || line.netPayMinor <= 0) problems.push(`${where}: the net amount must be a positive whole paise value`);
    if (ACCOUNT.test(line.bankAccountNo)) {
      if (seenAccounts.has(line.bankAccountNo)) problems.push(`${where}: account ${line.bankAccountNo} appears more than once — one payment per account`);
      seenAccounts.add(line.bankAccountNo);
    }
  }
  if (problems.length > 0) {
    throw new InvalidBankFileInput(`the bank file has ${problems.length} problem(s) and must not be uploaded: ${problems.join('; ')}`);
  }

  const rows: BankFileRow[] = input.lines.map((line) => ({
    beneficiaryName: line.employeeName,
    accountNumber: line.bankAccountNo,
    ifsc: line.ifsc,
    amountMinor: line.netPayMinor,
    paymentType,
    remarks: `SAL ${input.payPeriod}`,
  }));
  const totalNetMinor = rows.reduce((s, r) => s + r.amountMinor, 0);

  const header = 'Beneficiary Name,Account Number,IFSC,Amount,Payment Type,Remarks';
  const body = rows.map((r) => [csvField(r.beneficiaryName), r.accountNumber, r.ifsc, rupees(r.amountMinor), r.paymentType, csvField(r.remarks)].join(','));
  const csv = [header, ...body].join('\n');

  return {
    payPeriod: input.payPeriod,
    ...(input.valueDate !== undefined ? { valueDate: input.valueDate } : {}),
    paymentType,
    recordCount: rows.length,
    totalNetMinor,
    rows,
    csv,
    confirmWithBank: true,
    detail: `${rows.length} payment(s) totalling ₹${rupees(totalNetMinor)} for ${input.payPeriod} (${paymentType})`,
  };
}
