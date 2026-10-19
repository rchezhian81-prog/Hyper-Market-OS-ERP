import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { UNSET_PAYROLL_LEGAL_SETTINGS, PAYROLL_FIGURE_KEYS, OVERTIME_FLOOR_PERCENT } from '../../packages/payroll/src/index';

/**
 * **R4 Lane 1 — the controls have no override (C15 · C16 · C19 · B20 · B21 · B22).** Each claim the signed sentences make
 * of the form "nothing does this by itself" is held here by reading the code:
 *
 *   • no legal figure is shipped (OB-208): every figure, class and the particulars list start empty, and the new payroll
 *     code carries none of the gap analysis's figures as a number;
 *   • the overtime floor of twice the ordinary rate is the signed sentence, not a setting — no key can lower it;
 *   • the statutory payslip reads the hours, roles, hourly rate and headcount from the record — the route refuses them in
 *     the request;
 *   • nothing is filed on the CPCB portal: the EPR code calls out to nothing;
 *   • take-back stock never reaches saleable stock: the EPR wiring writes only to its own stream and reads the stock
 *     ledger, never appends to it, the sales or the returns;
 *   • no AI is involved in any of it.
 */

const code = (f: string): string => readFileSync(f, 'utf8').split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
const PAY = ['packages/payroll/src/legal-settings.ts', 'packages/payroll/src/contribution-summary.ts', 'packages/payroll/src/overtime.ts', 'packages/payroll/src/minimum-wage.ts', 'packages/payroll/src/payslip-particulars.ts', 'packages/payroll/src/statutory-payslip.ts', 'services/finance/src/statutory-pay.ts'];
const EPR = ['packages/epr/src/packaging-register.ts', 'packages/epr/src/take-back.ts', 'services/compliance/src/epr-store.ts'];
const ADAPTERS = 'services/api/src/r4-pay-epr-adapters.ts';

describe('R4 Lane 1 controls have no override', () => {
  it('no legal figure is shipped: every figure, class and list starts empty (OB-208)', () => {
    for (const k of PAYROLL_FIGURE_KEYS) expect(UNSET_PAYROLL_LEGAL_SETTINGS.figures[k], k).toEqual({ value: null, source: null, confirmation: null });
    expect(UNSET_PAYROLL_LEGAL_SETTINGS.minimumWages).toEqual([]);
    expect(UNSET_PAYROLL_LEGAL_SETTINGS.particulars).toEqual({ particulars: null, source: null, confirmation: null });
    // The gap analysis's figures (12% · 0.75% · 3.25% · ₹15,000 · ₹21,000) appear in none of the new pay code as numbers.
    for (const f of PAY) {
      const src = code(f).replace(/_/g, '');
      for (const n of ['1500000', '2100000', '1200,', '325,', 'Bps: 75', 'DEFAULT_STATUTORY_SCHEDULE']) expect(src.includes(n), `${f} carries "${n}"`).toBe(false);
    }
  });

  it('the overtime floor is the signed sentence, not a setting', () => {
    expect(OVERTIME_FLOOR_PERCENT).toBe(200);
    expect(PAYROLL_FIGURE_KEYS.some((k) => /floor/i.test(k))).toBe(false);
    expect(code('services/finance/src/statutory-pay.ts')).toMatch(/b\['value'\] as number\) < OVERTIME_FLOOR_PERCENT/);
  });

  it('the statutory payslip reads hours, roles, the hourly rate and the headcount from the record, never the request', () => {
    const src = code('services/finance/src/statutory-pay.ts');
    expect(src).toMatch(/b\['hours'\] !== undefined \|\| b\['headcount'\] !== undefined \|\| b\['roles'\] !== undefined \|\| b\['ordinaryHourlyRateMinor'\] !== undefined/);
    expect(src).toMatch(/headcount: staff\.filter\(\(e\) => e\.active\)\.length/);
    expect(src).toMatch(/roles: person\.roles/);
  });

  it('nothing is filed or sent: the lane calls out to nothing', () => {
    for (const f of [...PAY, ...EPR, ADAPTERS]) {
      const src = code(f);
      for (const banned of ['fetch(', 'http.request', 'https.request', "from 'node:http", "from 'node:https", 'XMLHttpRequest', 'cpcb.nic.in', 'eprplastic']) {
        expect(src.includes(banned), `${f} calls out through "${banned}"`).toBe(false);
      }
    }
    expect(code('packages/epr/src/packaging-register.ts')).toMatch(/filing: 'not_filed_by_the_system'/);
  });

  it('take-back stock never reaches saleable stock: the EPR wiring appends only to its own stream', () => {
    const src = code(ADAPTERS);
    const writes = [...src.matchAll(/put\(store, tenantId, ([A-Z_]+|[a-zA-Z.]+),/g)].map((m) => m[1]);
    expect(writes.length).toBeGreaterThan(5);
    expect(new Set(writes)).toEqual(new Set(['LEGAL_STREAM', 'PREPARED_STREAM', 'CONTRIBUTIONS_STREAM', 'EPR_STREAM']));
    expect(src).not.toMatch(/store\.append\(tenantId, STREAM\.(inventory|sales)/);
    expect(src).not.toMatch(/ReturnRecorded|SaleRecorded|forSaleReturns/);
    // The epr store's only way out of take-back stock is a handover to a registered recycler.
    const store = code('services/compliance/src/epr-store.ts');
    expect(store).toMatch(/assertTakeBackLeavesOnlyToARecycler\(to as \{ kind: string \}\)/);
    expect(store).toMatch(/registeredRecycler\(recyclersById/);
  });

  it('no AI is involved: the lane imports nothing from the AI service or packages', () => {
    for (const f of [...PAY, ...EPR, ADAPTERS]) expect(readFileSync(f, 'utf8'), f).not.toMatch(/from '[^']*(services\/ai|packages\/ai)\//);
  });
});
