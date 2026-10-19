import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ApiHarness } from '../support/api-harness';
import { backings, openDatabase, closeDatabase, caller, addStaff, confirmFigure, codeOf, TEST_CONTRIBUTION_FIGURES, type Res } from '../support/r4-lane1';

/**
 * **R4 · C19 · OB-208 · OB-209 — EPF and ESI follow the CA's settings and the shop's headcount, and the month's totals
 * reconcile to the payslips (the real API, in memory and on real PostgreSQL, with a cold restart).**
 *
 * Every figure starts "not confirmed" and PF / ESI are not worked out. The CA fills them (synthetic test figures, not the
 * legal rates). With two people, PF (threshold 3) is not deducted and the payslip says why while ESI (threshold 2) is;
 * a third person brings PF in; an inactive person does not count. After a cold restart the payslips are issued, the
 * month's totals are recorded, and a one-paisa difference is an exception. A store manager cannot read or fill the
 * figures; the hours, roles and headcount cannot be sent in the request.
 */

beforeAll(openDatabase);
afterAll(closeDatabase);

const PERIOD = '2030-05';
const BODY = {
  onDate: '2030-05-31', attendance: { calendarDaysInMonth: 31, paidDays: 31 },
  components: [{ code: 'BASIC', monthlyMinor: 800_000, partOfPfWage: true }, { code: 'HRA', monthlyMinor: 400_000 }],
};
type Prepared = { payslip: { statutory: Record<string, number>; statutoryChecks: { contributions: { headcount: number; pf: Record<string, unknown>; esi: Record<string, unknown> }; notChecked: string[] } }; notChecked: string[] };

describe.each(backings())('EPF and ESI follow the headcount and reconcile — on $name (C19)', ({ harness, restart }) => {
  it('not confirmed → not worked out; confirmed → per threshold, said on the payslip; totals reconcile to the paisa', async () => {
    let h: ApiHarness = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-ca', 'chartered_accountant');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    const c = caller(() => h, T);
    const { req, ok } = c;

    // ── As shipped: every figure not confirmed; nobody but the owner and the CA reads or fills them ─────────────────
    const settings = (await ok(req('GET', '/v1/hr/payroll/legal-settings', undefined, 'u-ca'), 'settings')).body as { figures: { key: string; status: string }[]; notConfirmed: string[] };
    expect(settings.figures.filter((f) => f.key.startsWith('pf') || f.key.startsWith('esi')).every((f) => f.status === 'not_confirmed')).toBe(true);
    expect(settings.notConfirmed).toContain('pfHeadcountThreshold');
    expect((await req('GET', '/v1/hr/payroll/legal-settings', undefined, 'u-mgr')).status).toBe(403);
    expect((await req('POST', '/v1/hr/payroll/legal-settings/pfEmployeeRateBps', { value: 1200, source: 's', confirmation: 'c' }, 'u-mgr')).status).toBe(403);

    await addStaff(c, 'e1');
    await addStaff(c, 'e2');
    const prepare = (employeeId: string, body: unknown = BODY): Promise<Res> => req('POST', `/v1/hr/payroll/statutory-payslips/${employeeId}/${PERIOD}`, body);

    const unset = (await ok(prepare('e1'), 'prepare unset')).body as Prepared;
    expect(unset.payslip.statutoryChecks.contributions.pf).toMatchObject({ status: 'not_confirmed', employeeMinor: null });
    expect(unset.payslip.statutoryChecks.contributions.esi).toMatchObject({ status: 'not_confirmed', employeeMinor: null });
    expect(unset.notChecked.some((w) => w.startsWith('PF not worked out: not confirmed by the CA'))).toBe(true);
    expect(unset.payslip.statutory['pfEmployeeMinor']).toBe(0); // nothing taken — and the payslip says why above

    // ── The CA fills the figures ──────────────────────────────────────────────────────────────────────────────────────
    const ca = caller(() => h, T);
    for (const [k, v] of Object.entries(TEST_CONTRIBUTION_FIGURES)) {
      await ok(ca.req('POST', `/v1/hr/payroll/legal-settings/${k}`, { value: v, source: 'TEST FIGURE — synthetic', confirmation: 'CA (test) ref T-1' }, 'u-ca'), k);
    }

    // Two people: below the PF threshold (3), at the ESI threshold (2).
    const two = (await ok(prepare('e1'), 'prepare two')).body as Prepared;
    expect(two.payslip.statutoryChecks.contributions.headcount).toBe(2);
    expect(two.payslip.statutoryChecks.contributions.pf).toMatchObject({ status: 'below_threshold', employeeMinor: 0, why: 'PF not deducted: the shop has 2 people, below the EPF threshold of 3' });
    expect(two.payslip.statutoryChecks.contributions.esi).toMatchObject({ status: 'deducted', employeeMinor: 12_000, employerMinor: 36_000 });

    // A third person brings PF in: 10% / 11% of the ₹8,000 PF wage.
    await addStaff(c, 'e3');
    const three = (await ok(prepare('e1'), 'prepare three')).body as Prepared;
    expect(three.payslip.statutoryChecks.contributions.pf).toMatchObject({ status: 'deducted', employeeMinor: 80_000, employerMinor: 88_000 });
    expect(three.payslip.statutory).toMatchObject({ pfEmployeeMinor: 80_000, esiEmployeeMinor: 12_000, totalEmployeeDeductionMinor: 92_000, netPayMinor: 1_108_000 });
    const e3 = (await ok(prepare('e3', { ...BODY, components: [{ code: 'BASIC', monthlyMinor: 600_000, partOfPfWage: true }] }), 'prepare e3')).body as Prepared;

    // An inactive person does not count toward the headcount.
    await addStaff(c, 'e2', { active: false });
    const back = (await ok(prepare('e2'), 'inactive e2')).body as Prepared;
    expect(back.payslip.statutoryChecks.contributions.headcount).toBe(2);

    // ── A COLD RESTART: the settings and prepared payslips come back from the store ────────────────────────────────
    h = restart(h);
    const check = (await ok(req('GET', `/v1/hr/payroll/statutory-check/${PERIOD}`), 'check')).body as { payslips: { employeeId: string }[]; release: { state: string } };
    expect(check.payslips.map((p) => p.employeeId)).toEqual(['e1', 'e2', 'e3']);
    expect(check.release.state).toBe('on_hold');

    // Issue e1 and e3 (synthetic); the month's totals are not yet recorded.
    await ok(req('POST', `/v1/hr/payroll/payslips/e1/${PERIOD}`, { payslip: three.payslip }), 'issue e1');
    await ok(req('POST', `/v1/hr/payroll/payslips/e3/${PERIOD}`, { payslip: e3.payslip }), 'issue e3');
    const none = (await ok(req('GET', `/v1/hr/payroll/contributions/${PERIOD}`), 'contributions')).body as { status: string; payslipTotals: Record<string, number> };
    expect(none.status).toBe('no_totals_recorded');
    // e1: PF 800 / 880, ESI 120 / 360; e3: PF 600 / 660, ESI on ₹6,000 = 60 / 180.
    expect(none.payslipTotals).toEqual({ pfEmployeeMinor: 140_000, pfEmployerMinor: 154_000, esiEmployeeMinor: 18_000, esiEmployerMinor: 54_000 });

    const totals = { pfEmployeeMinor: 140_000, pfEmployerMinor: 154_000, esiEmployeeMinor: 18_000, esiEmployerMinor: 54_000, reference: 'ECR-2030-05' };
    const rec = (await ok(req('POST', `/v1/hr/payroll/contributions/${PERIOD}/totals`, totals), 'totals')).body as { reconciliation: { status: string } };
    expect(rec.reconciliation.status).toBe('reconciled');
    const off = (await ok(req('POST', `/v1/hr/payroll/contributions/${PERIOD}/totals`, { ...totals, pfEmployerMinor: 154_001, reference: 'ECR-2030-05-rev' }), 'totals off')).body as { reconciliation: { status: string; exceptions: { field: string; differenceMinor: number }[] } };
    expect(off.reconciliation.status).toBe('difference');
    expect(off.reconciliation.exceptions).toEqual([expect.objectContaining({ field: 'pfEmployerMinor', differenceMinor: 1 })]);
    // The difference stays visible after another restart.
    h = restart(h);
    expect(((await req('GET', `/v1/hr/payroll/contributions/${PERIOD}`)).body as { status: string }).status).toBe('difference');
  });

  it('refuses what it cannot read, and anything that would let the request decide the headcount, hours or roles', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-till', 'cashier');
    const c = caller(() => h, T);
    await addStaff(c, 'e1');
    const r = (p: string, b: unknown, u = 'u-owner') => c.req('POST', p, b, u);
    expect(codeOf(await r(`/v1/hr/payroll/statutory-payslips/nobody/${PERIOD}`, BODY))).toBe('not_in_the_staff_directory');
    expect(codeOf(await r(`/v1/hr/payroll/statutory-payslips/e1/${PERIOD}`, { ...BODY, headcount: 50 }))).toBe('statutory_payslip_reads_the_record');
    expect(codeOf(await r(`/v1/hr/payroll/statutory-payslips/e1/${PERIOD}`, { ...BODY, hours: [] }))).toBe('statutory_payslip_reads_the_record');
    expect(codeOf(await r(`/v1/hr/payroll/statutory-payslips/e1/2030-13`, BODY))).toBe('statutory_payslip_needs_period_date_attendance');
    expect(codeOf(await r('/v1/hr/payroll/legal-settings/pfEmployeeRateBps', { value: 12.5 }))).toBe('not_a_payroll_figure');
    expect((await r('/v1/hr/payroll/legal-settings/pfMagic', { value: 1 })).status).toBe(404);
    expect(codeOf(await r(`/v1/hr/payroll/contributions/${PERIOD}/totals`, { pfEmployeeMinor: 1 }))).toBe('not_readable_as_contribution_totals');
    // A cashier holds no payroll permission.
    expect((await r(`/v1/hr/payroll/statutory-payslips/e1/${PERIOD}`, BODY, 'u-till')).status).toBe(403);
    expect((await c.req('GET', `/v1/hr/payroll/contributions/${PERIOD}`, undefined, 'u-till')).status).toBe(403);
    await confirmFigure(c, 'pfEmployeeRateBps', 1000); // the owner may fill on the CA's confirmation
  });
});
