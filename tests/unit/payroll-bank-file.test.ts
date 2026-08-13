import { describe, it, expect } from 'vitest';
import {
  buildBankFile,
  InvalidBankFileInput,
  type BankPaymentLine,
} from '../../packages/payroll/src/index';

const LINES: BankPaymentLine[] = [
  { employeeId: 'e1', employeeName: 'Asha R', bankAccountNo: '123456789012', ifsc: 'HDFC0001234', netPayMinor: 1_444_000 },
  { employeeId: 'e2', employeeName: 'Karthik, Jr', bankAccountNo: '987654321098', ifsc: 'ICIC0005678', netPayMinor: 2_320_000 },
];

describe('buildBankFile — only from a locked run, only payable lines', () => {
  it('builds the file with a control total and rupee amounts', () => {
    const f = buildBankFile({ payRunState: 'locked', payPeriod: '2026-08', lines: LINES });
    expect(f.recordCount).toBe(2);
    expect(f.totalNetMinor).toBe(3_764_000);
    expect(f.paymentType).toBe('NEFT');
    expect(f.confirmWithBank).toBe(true);
    // CSV: header + 2 rows; amounts in rupees; a name with a comma is quoted.
    const rows = f.csv.split('\n');
    expect(rows[0]).toBe('Beneficiary Name,Account Number,IFSC,Amount,Payment Type,Remarks');
    expect(rows[1]).toContain('14440.00');
    expect(rows[2]).toContain('"Karthik, Jr"');
  });

  it('refuses to build from a run that is not locked', () => {
    for (const state of ['draft', 'submitted', 'approved', 'reversed'] as const) {
      expect(() => buildBankFile({ payRunState: state, payPeriod: '2026-08', lines: LINES })).toThrow(InvalidBankFileInput);
    }
  });

  it('refuses a bad IFSC, a bad account, a non-positive amount and a duplicate account', () => {
    expect(() => buildBankFile({ payRunState: 'locked', payPeriod: '2026-08', lines: [{ ...LINES[0]!, ifsc: 'nope' }] })).toThrow(/IFSC/);
    expect(() => buildBankFile({ payRunState: 'locked', payPeriod: '2026-08', lines: [{ ...LINES[0]!, bankAccountNo: '12' }] })).toThrow(/account number/);
    expect(() => buildBankFile({ payRunState: 'locked', payPeriod: '2026-08', lines: [{ ...LINES[0]!, netPayMinor: 0 }] })).toThrow(/net amount/);
    const dup: BankPaymentLine[] = [LINES[0]!, { ...LINES[1]!, bankAccountNo: LINES[0]!.bankAccountNo }];
    expect(() => buildBankFile({ payRunState: 'locked', payPeriod: '2026-08', lines: dup })).toThrow(/more than once/);
  });

  it('refuses an empty run', () => {
    expect(() => buildBankFile({ payRunState: 'locked', payPeriod: '2026-08', lines: [] })).toThrow(InvalidBankFileInput);
  });
});
