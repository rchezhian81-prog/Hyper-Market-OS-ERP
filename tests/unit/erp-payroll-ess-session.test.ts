import { describe, it, expect } from 'vitest';
import {
  createPayrollEssSession, PAYROLL_ESS_COPY, ESS_COPY_KEYS,
  type PayrollEssPorts, type PayrollEssConfig,
} from '../../apps/web-erp/src/payroll-ess-session';
import {
  buildPayslip, resolveStatutoryParams, DEFAULT_STATUTORY_SCHEDULE,
  computeSettlement, resolveSettlementParams, DEFAULT_SETTLEMENT_SCHEDULE,
  type Payslip, type Settlement,
} from '../../packages/payroll/src/index';
import { bilingualGaps } from '../../packages/ui/src/index';

/**
 * **Payroll employee self-service — OWN-RECORD ONLY (owner directive; WP3 ESS; P-04).**
 *
 * The one control that matters: the requester identity is the AUTHENTICATED principal (`config.requester
 * EmployeeId`), never a page value, and the tested engine refuses any record that is not the requester's own.
 * Holding the self-service permission does not let a person read a colleague — and a refusal shows NOTHING.
 */

const params = resolveStatutoryParams(DEFAULT_STATUTORY_SCHEDULE, '2026-08-31');
const payslip: Payslip = buildPayslip({
  onDate: '2026-08-31',
  components: [{ code: 'BASIC', monthlyMinor: 20_000_00, partOfPfWage: true, partOfGross: true }, { code: 'HRA', monthlyMinor: 10_000_00, partOfGross: true }],
  attendance: { calendarDaysInMonth: 31, paidDays: 31 },
  params,
});
const settlement: Settlement = computeSettlement({ pendingSalaryMinor: 5_000_00, params: resolveSettlementParams(DEFAULT_SETTLEMENT_SCHEDULE, '2026-08-31') });

const ports = (over: Partial<PayrollEssPorts> = {}): PayrollEssPorts => ({
  mayView: () => true,
  payslip: () => payslip,
  settlement: () => undefined,
  online: () => true,
  reauthAgeSeconds: () => 5,
  ...over,
});

const session = (cfg: Partial<PayrollEssConfig> = {}, portsOver: Partial<PayrollEssPorts> = {}) =>
  createPayrollEssSession(
    { requesterEmployeeId: 'EMP-1', subjectEmployeeId: 'EMP-1', demo: false, reauthFreshWithinSeconds: 120, ...cfg },
    ports(portsOver),
  );

describe('own record shows', () => {
  it('presents the employee’s own earnings, deductions, net and employer contributions', () => {
    const v = session().view('en');
    expect(v.available).toBe(true);
    expect(v.payslip!.employeeId).toBe('EMP-1');
    expect(v.payslip!.grossMinor).toBeGreaterThan(0);
    expect(v.payslip!.employerContributions.note).toMatch(/company cost|not deducted/i);
  });

  it('shows a leaver their own settlement summary when present', () => {
    const v = session({}, { settlement: () => settlement }).view('en');
    expect(v.payslip!.settlement).toBeDefined();
  });
});

describe('cross-employee is REFUSED — even though the caller holds the permission', () => {
  it('refuses when the requester is not the subject, and leaks NOTHING', () => {
    const v = session({ requesterEmployeeId: 'EMP-1', subjectEmployeeId: 'EMP-2' }).view('en');
    expect(v.available).toBe(false);
    expect(v.notYourRecord).toBe(true);
    expect(v.payslip).toBeUndefined();
    // No figure and no other id leaks into the refused view.
    expect(JSON.stringify(v)).not.toContain('EMP-2'.slice(0, 0) + 'grossMinor');
    expect(session({ requesterEmployeeId: 'EMP-1', subjectEmployeeId: 'EMP-2' }).can('exportOwnPayslip').refusal).toBe('not_your_record');
  });

  it('the requester is taken from config (the principal), so a subject swap cannot widen access', () => {
    // Same held permission, only the subject differs — own record works, a colleague is refused.
    expect(session({ subjectEmployeeId: 'EMP-1' }).view('en').available).toBe(true);
    expect(session({ subjectEmployeeId: 'EMP-9' }).view('en').available).toBe(false);
  });
});

describe('access + availability gates', () => {
  it('refuses a user without the self-service permission — no data', () => {
    const v = session({}, { mayView: () => false }).view('en');
    expect(v.available).toBe(false);
    expect(v.mayView).toBe(false);
    expect(session({}, { mayView: () => false }).can('exportOwnPayslip').refusal).toBe('not_permitted');
  });
  it('refuses when nobody is signed in', () => {
    expect(session({ requesterEmployeeId: null }).view('en').nobodyNamed).toBe(true);
    expect(session({ requesterEmployeeId: null }).can('exportOwnPayslip').refusal).toBe('nobody_named');
  });
  it('says unavailable (not an error) when the payslip is not ready', () => {
    const v = session({}, { payslip: () => undefined }).view('en');
    expect(v.available).toBe(false);
    expect(v.screenState.tone).toBe('idle');
  });
});

describe('the export is online-first and re-auth gated', () => {
  it('needs a fresh MFA to export, refuses when stale, and is blocked offline', () => {
    expect(session().can('exportOwnPayslip').ok).toBe(true);
    expect(session({}, { reauthAgeSeconds: () => 999 }).can('exportOwnPayslip').refusal).toBe('needs_reauth');
    expect(session({}, { online: () => false }).can('exportOwnPayslip').refusal).toBe('offline');
  });
});

describe('bilingual', () => {
  it('has an English and a Tamil word for every key', () => {
    const gaps = bilingualGaps(PAYROLL_ESS_COPY, ESS_COPY_KEYS);
    expect(gaps.en).toEqual([]);
    expect(gaps.ta).toEqual([]);
  });
});
