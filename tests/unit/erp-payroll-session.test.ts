import { describe, it, expect } from 'vitest';
import {
  createPayrollSession, PAYROLL_COPY, COPY_KEYS,
  type PayrollPorts, type PayrollConfig, type EmployeeInput,
} from '../../apps/web-erp/src/payroll-session';
import { foldPayRun, type PayRunAggregate, type PayRunEvent } from '../../packages/payroll/src/pay-run';
import { bilingualGaps } from '../../packages/ui/src/index';

/**
 * **Payroll operator screen — the security-conscious session model (owner directive 14 Aug 2026; §28; P-04).**
 *
 * Payroll is the most sensitive surface in the shop, so this model carries the controls the directive
 * demands: least-privilege visibility, masked identifiers, maker ≠ checker, a locked run that cannot be
 * silently changed, no state change while offline, and a refusal to pay a negative net.
 */

const MAKER = 'u-hr';
const CHECKER = 'u-finance';

const emp = (over: Partial<EmployeeInput> = {}): EmployeeInput => ({
  employeeId: 'E-1', name: 'Asha', department: 'Grocery',
  grossMinor: 30_000_00, totalDeductionsMinor: 3_600_00, netPayMinor: 26_400_00,
  bankAccount: '123456789012', bankIfsc: 'HDFC0001234', pan: 'ABCDE1234F', uan: '100987654321', aadhaar: '234512345678',
  ...over,
});

/** A run in a given lifecycle state, built from real events so maker/checker are set the engine's way. */
const runIn = (state: 'draft' | 'submitted' | 'approved' | 'locked'): PayRunAggregate | undefined => {
  const events: PayRunEvent[] = [{ kind: 'drafted', payPeriod: '2026-08', by: MAKER, at: '2026-08-31T00:00:00.000Z', netTotalMinor: 26_400_00, employeeCount: 1 }];
  if (state !== 'draft') events.push({ kind: 'submitted', by: MAKER, at: '2026-08-31T01:00:00.000Z' });
  if (state === 'approved' || state === 'locked') events.push({ kind: 'approved', by: CHECKER, at: '2026-08-31T02:00:00.000Z' });
  if (state === 'locked') events.push({ kind: 'locked', at: '2026-08-31T03:00:00.000Z' });
  return foldPayRun('PR-1', events);
};

const ports = (over: Partial<PayrollPorts> = {}): PayrollPorts => ({
  mayView: () => true,
  run: () => runIn('draft'),
  employees: () => [emp()],
  totals: () => undefined,
  online: () => true,
  // Fresh re-auth by default, so inc1 sensitive actions (approve/lock) are not blocked unless a test opts out.
  reauthAgeSeconds: () => 5,
  payPeriod: '2026-08',
  ...over,
});

/** `online` is a live port; the helper threads it in as such (and keeps the old call shape). */
const session = (
  cfg: Partial<PayrollConfig> & { readonly online?: boolean } = {},
  portsOver: Partial<PayrollPorts> = {},
) => {
  const { online, ...config } = cfg;
  return createPayrollSession(
    { userId: MAKER, demo: false, reauthFreshWithinSeconds: 120, ...config },
    ports({ ...(online === undefined ? {} : { online: () => online }), ...portsOver }),
  );
};

describe('least privilege — a user without the payroll permission sees NOTHING', () => {
  it('leaks no employees, no totals, no names, and refuses every action', () => {
    const s = session({}, { mayView: () => false });
    const v = s.view('en');
    expect(v.mayView).toBe(false);
    expect(v.employees).toEqual([]);
    expect(v.totals).toEqual({ count: 0, grossMinor: 0, totalDeductionsMinor: 0, netMinor: 0 });
    expect(v.screenState.tone).toBe('error');
    expect(s.can('submit').refusal).toBe('not_permitted');
    expect(s.can('approve').refusal).toBe('not_permitted');
  });
});

describe('sensitive identifiers are masked, always', () => {
  it('never renders a raw bank account, PAN, UAN or Aadhaar', () => {
    const raw = emp();
    const row = session().view('en').employees[0]!;
    expect(row.masked.bankAccountMasked).toBe('XXXXXXXX9012');
    expect(row.masked.aadhaarMasked).toBe('XXXX XXXX 5678');
    const blob = JSON.stringify(row);
    for (const secret of [raw.bankAccount, raw.pan, raw.uan, raw.aadhaar]) {
      expect(blob, `raw ${secret} leaked into the presented row`).not.toContain(secret);
    }
  });
});

describe('negative / zero net pay is a blocking exception', () => {
  it('flags an employee who cannot be paid and refuses to submit the run', () => {
    const s = session({}, { employees: () => [emp({ employeeId: 'E-neg', netPayMinor: 0 }), emp({ employeeId: 'E-ok' })] });
    const v = s.view('en');
    expect(v.blockingExceptionCount).toBe(1);
    const flagged = v.employees.find((e) => e.employeeId === 'E-neg')!;
    expect(flagged.exceptions).toContain('negative_or_zero_net');
    expect(flagged.status.tone).toBe('error');
    // The ones needing attention come first.
    expect(v.employees[0]!.employeeId).toBe('E-neg');
    expect(s.can('submit').refusal).toBe('has_blocking_exceptions');
  });

  it('flags a missing bank account the same way', () => {
    const s = session({}, { employees: () => [emp({ bankAccount: '' })] });
    expect(s.view('en').employees[0]!.exceptions).toContain('missing_bank_account');
    expect(s.can('submit').refusal).toBe('has_blocking_exceptions');
  });
});

describe('maker ≠ checker (§28)', () => {
  it('the submitter cannot approve their own run', () => {
    const asMaker = session({ userId: MAKER }, { run: () => runIn('submitted') });
    expect(asMaker.can('approve').refusal).toBe('self_approval');
  });
  it('a different person can approve it', () => {
    const asChecker = session({ userId: CHECKER }, { run: () => runIn('submitted') });
    const out = asChecker.can('approve');
    expect(out.ok).toBe(true);
    expect(out.resultingState).toBe('approved');
  });
});

describe('online-first — offline blocks every state change', () => {
  it('refuses submit, approve, lock and reverse while offline', () => {
    for (const [action, state, user] of [['submit', 'draft', MAKER], ['approve', 'submitted', CHECKER], ['lock', 'approved', CHECKER]] as const) {
      const s = session({ userId: user, online: false }, { run: () => runIn(state) });
      expect(s.can(action).refusal, `${action} was allowed offline`).toBe('offline');
    }
  });
  it('allows the same actions once back online', () => {
    expect(session({ userId: MAKER, online: true }, { run: () => runIn('draft') }).can('submit').ok).toBe(true);
  });
});

describe('a locked run is final — corrected by reversal, never a silent edit', () => {
  it('cannot be submitted or re-approved, only reversed with a reason', () => {
    const s = session({ userId: CHECKER }, { run: () => runIn('locked') });
    expect(s.view('en').stage).toBe('locked');
    expect(s.view('en').screenState.tone).toBe('idle'); // locked is deliberate, not an error
    expect(s.can('submit').refusal).toBe('not_in_draft');
    expect(s.can('reverse').refusal).toBe('reason_required');
    const out = s.can('reverse', { reason: 'wrong overtime for two staff' });
    expect(out.ok).toBe(true);
    expect(out.resultingState).toBe('reversed');
  });
});

describe('nobody named at the desk', () => {
  it('refuses to act under no name even with the permission', () => {
    expect(session({ userId: null }).can('submit').refusal).toBe('nobody_named');
    expect(session({ userId: null }).view('en').nobodyNamed).toBe(true);
  });
});

describe('demo flag + bilingual + department summary', () => {
  it('carries the demo flag through so the shell can mark it', () => {
    expect(session({ demo: true }).view('en').demo).toBe(true);
  });
  it('summarises by department and renders in Tamil', () => {
    const s = session({}, { employees: () => [emp({ employeeId: 'E-1', department: 'Grocery' }), emp({ employeeId: 'E-2', department: 'Chill' })] });
    const depts = s.view('en').departments;
    expect(depts.map((d) => d.department)).toEqual(['Chill', 'Grocery']);
    const en = s.view('en').employees[0]!.status.label;
    const ta = s.view('ta').employees[0]!.status.label;
    expect(ta).not.toBe(en);
  });
  it('has an English and a Tamil word for every key (bilingualGaps)', () => {
    const gaps = bilingualGaps(PAYROLL_COPY, COPY_KEYS);
    expect(gaps.en).toEqual([]);
    expect(gaps.ta).toEqual([]);
  });
});

// ── inc2: locked-run artifacts (bank file + journal) and the re-auth gate ────────────────────────────────

/** A balanced totals for the default locked run (net 26,400): gross = net + employee deductions. */
const BALANCED_TOTALS = {
  grossMinor: 28_400_00, pfEmployeeMinor: 1_800_00, pfEmployerMinor: 1_800_00,
  esiEmployeeMinor: 0, esiEmployerMinor: 0, professionalTaxMinor: 200_00, tdsMinor: 0, netMinor: 26_400_00,
};

describe('a locked run surfaces the bank-file summary and a balanced journal', () => {
  it('reconciles the bank-file total against the run net — and carries no account numbers', () => {
    const s = session({ userId: CHECKER }, { run: () => runIn('locked'), totals: () => BALANCED_TOTALS });
    const art = s.view('en').lockedArtifacts!;
    expect(art).toBeDefined();
    expect(art.bankFile.recordCount).toBe(1);
    expect(art.bankFile.totalNetMinor).toBe(26_400_00);
    expect(art.bankFile.reconciledWithRun).toBe(true);
    // The summary is count + total only; no masked/raw account fields on it.
    expect(new Set(Object.keys(art.bankFile))).toEqual(new Set(['recordCount', 'totalNetMinor', 'reconciledWithRun']));
    expect(art.journal.available).toBe(true);
    expect(art.journal.balanced).toBe(true);
    expect(art.journal.totalDebitMinor).toBe(art.journal.totalCreditMinor);
    expect(art.reconciled).toBe(true);
  });

  it('flags an UNBALANCED journal as a reconciliation failure, never a silent pass', () => {
    const unbalanced = { ...BALANCED_TOTALS, netMinor: 25_000_00 }; // net no longer = gross - deductions
    const s = session({ userId: CHECKER }, { run: () => runIn('locked'), totals: () => unbalanced });
    const art = s.view('en').lockedArtifacts!;
    expect(art.journal.available).toBe(true);
    expect(art.journal.balanced).toBe(false);
    expect(art.reconciled).toBe(false);
  });

  it('says the journal is unavailable when the run totals were not provided', () => {
    const s = session({ userId: CHECKER }, { run: () => runIn('locked'), totals: () => undefined });
    expect(s.view('en').lockedArtifacts!.journal.available).toBe(false);
  });

  it('shows no locked artifacts before the run is locked', () => {
    expect(session({}, { run: () => runIn('draft') }).view('en').lockedArtifacts).toBeUndefined();
  });
});

describe('re-authentication (MFA) gates every sensitive action', () => {
  const stale = { reauthAgeSeconds: () => 999 };
  const fresh = { reauthAgeSeconds: () => 3 };
  const never = { reauthAgeSeconds: () => undefined };

  it('refuses approve / lock / reverse without a fresh re-auth', () => {
    expect(session({ userId: CHECKER }, { run: () => runIn('submitted'), ...stale }).can('approve').refusal).toBe('needs_reauth');
    expect(session({ userId: CHECKER }, { run: () => runIn('approved'), ...never }).can('lock').refusal).toBe('needs_reauth');
    expect(session({ userId: CHECKER }, { run: () => runIn('locked'), ...stale }).can('reverse', { reason: 'x' }).refusal).toBe('needs_reauth');
  });

  it('refuses bank-file / bulk-payslip / export without a fresh re-auth', () => {
    for (const action of ['generateBankFile', 'bulkPayslipDownload', 'export'] as const) {
      expect(session({ userId: CHECKER }, { run: () => runIn('locked'), ...stale }).can(action).refusal, action).toBe('needs_reauth');
    }
  });

  it('allows the locked-run artifacts once re-authenticated AND the run is locked', () => {
    const s = session({ userId: CHECKER }, { run: () => runIn('locked'), ...fresh });
    expect(s.can('generateBankFile').ok).toBe(true);
    expect(s.view('en').reauthFresh).toBe(true);
  });

  it('refuses the bank file when re-authenticated but the run is NOT locked', () => {
    const s = session({ userId: CHECKER }, { run: () => runIn('approved'), ...fresh });
    expect(s.can('generateBankFile').refusal).toBe('not_locked');
  });

  it('does NOT require re-auth for submit (it prepares, it does not release)', () => {
    expect(session({ userId: MAKER }, { run: () => runIn('draft'), ...never }).can('submit').ok).toBe(true);
  });

  it('offline still beats a fresh re-auth — no release while offline', () => {
    expect(session({ userId: CHECKER, online: false }, { run: () => runIn('locked'), ...fresh }).can('generateBankFile').refusal).toBe('offline');
  });
});
