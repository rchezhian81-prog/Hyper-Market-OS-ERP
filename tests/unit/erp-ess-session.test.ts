import { describe, it, expect } from 'vitest';
import {
  createEssSession, ESS_COPY, COPY_KEYS,
  type EssPorts, type EssRoster, type EssPayslip,
} from '../../apps/web-erp/src/ess-session';
import { bilingualGaps } from '../../packages/ui/src/index';

// Employee self-service (ESS) session model (M25 · §7): an employee's OWN rota + latest payslip, rendered as
// accessible status rows (icon + word + announcement, never colour alone), bilingual EN/TA, read-only.

const ports = (over: Partial<EssPorts> = {}): EssPorts => ({
  mayRead: () => true,
  roster: () => null,
  payslip: () => null,
  ...over,
});

const roster = (over: Partial<EssRoster> = {}): EssRoster => ({
  known: true, active: true, shifts: [{ shiftId: 'S1', role: 'cashier', branchId: 'b1', startsAt: '2026-09-20T06:00:00Z', endsAt: '2026-09-20T14:00:00Z' }], ...over,
});
const payslip = (over: Partial<EssPayslip> = {}): EssPayslip => ({
  issued: true, period: '2026-08', netPayMinor: 1740000,
  deductions: [{ label: 'Provident Fund (your share)', amountMinor: 240000 }], employerTotalMinor: 240000, ...over,
});

describe('createEssSession — my rota + my payslip', () => {
  it('shows a rostered shift and the payslip net pay, each as an accessible status row', () => {
    const s = createEssSession({ userId: 'u-cash' }, ports({ roster: () => roster(), payslip: () => payslip() }));
    const v = s.view('en');
    expect(v.screenState.tone).toBe('ok'); // 'ready'
    // Every rendered row carries a non-empty word AND a non-empty trimmed icon (never colour alone).
    expect(v.rows.length).toBeGreaterThan(0);
    for (const r of v.rows) {
      expect(r.status.label.trim().length).toBeGreaterThan(0);
      expect(r.status.icon.trim().length).toBeGreaterThan(0);
      expect(r.status.announcement.trim().length).toBeGreaterThan(0);
    }
    const shift = v.rows.find((r) => r.section === 'rota');
    expect(shift?.headline).toBe('cashier');
    const net = v.rows.find((r) => r.id === 'pay-net');
    expect(net?.status.label).toContain('17,400.00'); // ₹ grouped
    // The employer contribution is shown as a separate line, not a deduction.
    expect(v.rows.some((r) => r.id === 'pay-employer')).toBe(true);
  });

  it('tells a person with no rota and no payslip that there is nothing yet (empty, not error)', () => {
    const s = createEssSession({ userId: 'u-new' }, ports({ roster: () => roster({ known: false }), payslip: () => payslip({ issued: false }) }));
    const v = s.view('en');
    expect(v.screenState.tone).toBe('idle'); // 'empty', not an error
    expect(v.rows.every((r) => r.id === 'rota-none' || r.id === 'pay-none')).toBe(true);
  });

  it('a leaver is told their record is inactive', () => {
    const s = createEssSession({ userId: 'u-cash' }, ports({ roster: () => roster({ active: false }) }));
    const v = s.view('en');
    expect(v.rows.some((r) => r.id === 'rota-leaver')).toBe(true);
  });

  it('leaks nothing and reads as an error when the user may not use self-service', () => {
    const s = createEssSession({ userId: 'u-cash' }, ports({ mayRead: () => false, roster: () => roster(), payslip: () => payslip() }));
    const v = s.view('en');
    expect(v.screenState.tone).toBe('error');
    expect(v.rows).toEqual([]);
  });

  it('is bilingual — Tamil differs from English, and nobodyNamed when the box was not told who', () => {
    const s = createEssSession({ userId: null }, ports({ roster: () => roster(), payslip: () => payslip() }));
    expect(s.text('ta', 'title')).not.toBe(s.text('en', 'title'));
    expect(s.view('en').nobodyNamed).toBe(true);
  });

  it('has no missing copy in either language (bilingual completeness)', () => {
    const gaps = bilingualGaps(ESS_COPY, COPY_KEYS);
    expect(gaps.en).toEqual([]);
    expect(gaps.ta).toEqual([]);
  });
});
