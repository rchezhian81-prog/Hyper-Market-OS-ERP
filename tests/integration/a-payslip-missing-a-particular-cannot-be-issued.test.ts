import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ApiHarness } from '../support/api-harness';
import { backings, openDatabase, closeDatabase, caller, addStaff, codeOf, whatOf } from '../support/r4-lane1';
import { payslipLateSweep } from '../../services/api/src/r4-pay-epr-adapters';

/**
 * **R4 · C15 · OB-208 · OB-209 — the statutory digital payslip (the real API, in memory and on real PostgreSQL, with a
 * cold restart).** "Every payslip carries each particular on the CA's list. One missing a listed particular cannot be
 * issued ('payslip particular missing: <name>'). A payslip not issued by the pay date reaches the owner as an exception.
 * An employee sees only their own payslip. Until the CA fills the list, each particular shows 'not confirmed' on the
 * payslip and nothing is guessed."
 *
 * Time-independent: the late payslips have a pay date long past (2025); the on-time one a pay date far ahead (2099).
 */

beforeAll(openDatabase);
afterAll(closeDatabase);

const PERIOD = '2025-03';
const body = (onDate: string) => ({
  onDate, attendance: { calendarDaysInMonth: 31, paidDays: 31 },
  components: [{ code: 'BASIC', monthlyMinor: 1_200_000, partOfPfWage: true }],
});
const LIST = ['employerName', 'employeeName', 'payPeriod', 'payDate', 'grossWages', 'deductions', 'netPay', 'hoursWorked'];
type Issued = { particulars: { listStatus: string; lines: { key: string; status: string; value?: string }[]; missing: string[] } };

describe.each(backings())('a payslip missing a particular cannot be issued — on $name (C15)', ({ harness, restart }) => {
  it('not confirmed → every particular "not confirmed"; confirmed → a missing one refused by name; only my own; late ones reach the owner', async () => {
    let h: ApiHarness = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-ca', 'chartered_accountant');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    for (const e of ['e1', 'e2', 'e3']) await h.provisionRole(T, e, 'cashier'); // each employee signs in as themselves
    const c = caller(() => h, T);
    const { req, ok } = c;
    for (const e of ['e1', 'e2', 'e3']) await addStaff(c, e);
    await ok(req('POST', `/v1/hr/workforce/attendance/e1/${PERIOD}-03`, { hours: 8 }), 'hours');
    const prepare = async (e: string, onDate: string) => ((await ok(req('POST', `/v1/hr/payroll/statutory-payslips/${e}/${PERIOD}`, body(onDate)), `prepare ${e}`)).body as { payslip: unknown }).payslip;
    const p1 = await prepare('e1', '2025-03-31');
    const p2 = await prepare('e2', '2099-12-31');
    await prepare('e3', '2025-03-31');

    // ── The CA has not filled the list: e1 is issued and every particular reads "not confirmed" ─────────────────────
    const first = (await ok(req('POST', `/v1/hr/payroll/payslips/e1/${PERIOD}`, { payslip: p1 }), 'issue e1')).body as Issued;
    expect(first.particulars.listStatus).toBe('not_confirmed');
    expect(first.particulars.lines.every((l) => l.status === 'not_confirmed')).toBe(true);

    // An employee sees only their own payslip: e1 sees theirs, with the hours worked and "not confirmed" particulars …
    const mine = (await ok(req('GET', '/v1/hr/payroll/my-payslip', undefined, 'e1'), 'e1 my payslip')).body as { issued: boolean; view: { employeeId: string; statutoryNotes: { hoursWorked: { date: string; workedMinutes: number }[]; particulars: { status: string }[] } } };
    expect(mine.issued).toBe(true);
    expect(mine.view.employeeId).toBe('e1');
    expect(mine.view.statutoryNotes.hoursWorked).toEqual([{ date: `${PERIOD}-03`, workedMinutes: 480 }]);
    expect(mine.view.statutoryNotes.particulars.every((p) => p.status === 'not_confirmed')).toBe(true);
    // … e2 sees none of it, and cannot read e1's through the HR route.
    expect(((await ok(req('GET', '/v1/hr/payroll/my-payslip', undefined, 'e2'), 'e2 my payslip')).body as { issued: boolean }).issued).toBe(false);
    expect((await req('GET', '/v1/hr/payroll/payslips/e1', undefined, 'e2')).status).toBe(403);

    // ── The CA confirms the list ─────────────────────────────────────────────────────────────────────────────────────
    expect((await req('POST', '/v1/hr/payroll/legal-settings/payslip-particulars', { particulars: LIST, source: 's', confirmation: 'c' }, 'u-mgr')).status).toBe(403);
    expect(codeOf(await req('POST', '/v1/hr/payroll/legal-settings/payslip-particulars', { particulars: ['employerName', 'shoeSize'] }, 'u-ca'))).toBe('not_a_particulars_list');
    await ok(req('POST', '/v1/hr/payroll/legal-settings/payslip-particulars', { particulars: LIST, source: 'Code on Wages rules (test)', confirmation: 'CA (test) ref P-1' }, 'u-ca'), 'list');

    // A COLD RESTART: the list comes back from the store.
    h = restart(h);
    const missing = await req('POST', `/v1/hr/payroll/payslips/e2/${PERIOD}`, { payslip: p2, particulars: { employerName: 'SRE Hyper Market (test)' } });
    expect(missing.status).toBe(422);
    expect(codeOf(missing)).toBe('payslip_particular_missing');
    expect(whatOf(missing)).toBe('payslip particular missing: Name of the employee');
    // A plain preview payslip (no statutory checks) does not carry the hours worked.
    const plain = (await ok(req('POST', '/v1/hr/payroll/payslip', body('2099-12-31')), 'plain')).body;
    expect(whatOf(await req('POST', `/v1/hr/payroll/payslips/e2/${PERIOD}`, { payslip: plain, particulars: { employerName: 'SRE', employeeName: 'Staff e2' } }))).toBe('payslip particular missing: Hours actually worked');
    expect(codeOf(await req('POST', `/v1/hr/payroll/payslips/e2/${PERIOD}`, { payslip: p2, particulars: { netPay: '1' } }))).toBe('not_readable_as_payslip_particulars');
    expect(((await ok(req('GET', '/v1/hr/payroll/my-payslip', undefined, 'e2'), 'e2 still none')).body as { issued: boolean }).issued).toBe(false);
    const done = (await ok(req('POST', `/v1/hr/payroll/payslips/e2/${PERIOD}`, { payslip: p2, particulars: { employerName: 'SRE Hyper Market (test)', employeeName: 'Staff e2', uan: '100200300400' } }), 'issue e2')).body as Issued;
    // The EPF number is kept masked — the last four only, never the whole number (C7).
    const uan = done.particulars.lines.find((l) => l.key === 'uan')!.value!;
    expect(uan.endsWith('0400')).toBe(true);
    expect(uan).not.toContain('100200300400');
    expect(JSON.stringify((await h.store.readStream(T, 'payroll\u001fpayslips')).map((e) => e.event.payload))).not.toContain('100200300400');
    expect(done.particulars.listStatus).toBe('confirmed');
    expect(done.particulars.lines.filter((l) => l.status === 'carried').map((l) => l.key).sort()).toEqual([...LIST].sort());

    // ── The pay-date clock: e1 issued after its pay date, e3 never issued; e2's pay date is ahead ────────────────────
    expect((await req('GET', '/v1/hr/payroll/payslip-exceptions', undefined, 'u-mgr', { period: PERIOD })).status).toBe(403);
    const late = (await ok(req('GET', '/v1/hr/payroll/payslip-exceptions', undefined, 'u-owner', { period: PERIOD }), 'late')).body as { exceptions: { employeeId: string; kind: string }[] };
    expect(late.exceptions.map((e) => [e.employeeId, e.kind])).toEqual([['e1', 'issued_after_pay_date'], ['e3', 'not_issued_by_pay_date']]);
    // On the alert worker's timer (no person presses anything) the sweep raises both, once.
    const sweep = payslipLateSweep({ store: h.store, now: () => new Date().toISOString() });
    expect(await sweep(T, new Date().toISOString())).toBe(2);
    expect(await sweep(T, new Date().toISOString())).toBe(0);
    const raised = (await ok(req('POST', '/v1/hr/payroll/payslip-exceptions/raise', { period: PERIOD }), 'raise')).body as { raised: number; alreadyOpen: number; owners: number };
    expect(raised).toMatchObject({ raised: 0, alreadyOpen: 2, owners: 1 });
    // Raised once: a second sweep finds them already open.
    expect(((await ok(req('POST', '/v1/hr/payroll/payslip-exceptions/raise', { period: PERIOD }), 'raise again')).body as { raised: number; alreadyOpen: number })).toMatchObject({ raised: 0, alreadyOpen: 2 });
    const inbox = (await ok(req('GET', '/v1/platform/alerts/inbox'), 'owner inbox')).body as { alerts: { alert: { alertId: string; detail: string } }[] };
    const ids = inbox.alerts.map((a) => a.alert.alertId).filter((id) => id.startsWith('payslip-late:')).sort();
    expect(ids).toEqual([`payslip-late:${PERIOD}:e1`, `payslip-late:${PERIOD}:e3`]);
    expect(inbox.alerts.find((a) => a.alert.alertId.endsWith(':e3'))!.alert.detail).toBe(`e3's payslip for ${PERIOD} was not issued by the pay date 2025-03-31`);
  });
});
