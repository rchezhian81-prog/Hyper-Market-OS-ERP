import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Workforce / HR per-tenant isolation, end to end through the real API (M25, P-04, OB-01, hard rule #6).
// The M25 durable stores each hold sensitive STAFF PERSONAL DATA — names and shifts (roster), qualifications
// (certifications), hours worked (attendance) and pay (issued payslips). roster-store / cert-store /
// attendance-store / payslip-store each prove a surface works, with RBAC and a restart, but only ever within
// ONE tenant. This proves the property a shared HR registry must never get wrong: one shop can neither SEE
// another shop's workforce records nor have its own writes bleed into them. A leak here is a staff-data
// breach, not merely a wrong number — so it is proven on the money/personal-data boundary, not assumed.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DAY = '2026-09-14';

// A minimal valid issued payslip (the fields the store validates + employeeSelfView reads).
const PAYSLIP = {
  onDate: '2026-08-31', calendarDaysInMonth: 31, paidDays: 31, lopDays: 0,
  earnings: [{ code: 'basic', earnedMinor: 2000000 }], grossMinor: 2000000, pfWageMinor: 2000000,
  statutory: { pfEmployeeMinor: 240000, esiEmployeeMinor: 0, professionalTaxMinor: 20000, tdsMinor: 0, pfEmployerMinor: 240000, esiEmployerMinor: 0 },
  netPayMinor: 1740000, confirmWithCa: true, detail: 'isolation test payslip',
};

const putEmployee = (h: ApiHarness, u: string, t: string, id: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/hr/workforce/employees/${id}`, userId: u, tenantId: t, idempotencyKey: key, body });
const putShift = (h: ApiHarness, u: string, t: string, id: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/hr/workforce/shifts/${id}`, userId: u, tenantId: t, idempotencyKey: key, body });
const assign = (h: ApiHarness, u: string, t: string, shiftId: string, employeeId: string, role: string, key: string) =>
  h.request({ method: 'POST', path: `/v1/hr/workforce/shifts/${shiftId}/assignments/${employeeId}`, userId: u, tenantId: t, idempotencyKey: key, body: { role } });
const rosterGaps = (h: ApiHarness, u: string, t: string, query: Record<string, string> = {}) =>
  h.request({ method: 'GET', path: '/v1/hr/workforce/roster-gaps', userId: u, tenantId: t, query });
const putCert = (h: ApiHarness, u: string, t: string, id: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/hr/workforce/certifications/${id}`, userId: u, tenantId: t, idempotencyKey: key, body });
const listCerts = (h: ApiHarness, u: string, t: string, query: Record<string, string>) =>
  h.request({ method: 'GET', path: '/v1/hr/workforce/certifications', userId: u, tenantId: t, query });
const taskGate = (h: ApiHarness, u: string, t: string, employeeId: string, query: Record<string, string>) =>
  h.request({ method: 'GET', path: `/v1/hr/workforce/employees/${employeeId}/task-gate`, userId: u, tenantId: t, query });
const putAttendance = (h: ApiHarness, u: string, t: string, employeeId: string, date: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/hr/workforce/attendance/${employeeId}/${date}`, userId: u, tenantId: t, idempotencyKey: key, body });
const listAttendance = (h: ApiHarness, u: string, t: string, query: Record<string, string>) =>
  h.request({ method: 'GET', path: '/v1/hr/workforce/attendance', userId: u, tenantId: t, query });
const labourCost = (h: ApiHarness, u: string, t: string, query: Record<string, string>) =>
  h.request({ method: 'GET', path: '/v1/hr/workforce/labour-cost', userId: u, tenantId: t, query });
const issuePayslip = (h: ApiHarness, u: string, t: string, employeeId: string, period: string, key: string) =>
  h.request({ method: 'POST', path: `/v1/hr/payroll/payslips/${employeeId}/${period}`, userId: u, tenantId: t, idempotencyKey: key, body: { payslip: PAYSLIP } });
const payslipsFor = (h: ApiHarness, u: string, t: string, employeeId: string) =>
  h.request({ method: 'GET', path: `/v1/hr/payroll/payslips/${employeeId}`, userId: u, tenantId: t });

interface Gaps { gapCount: number; shiftsChecked: number }
interface Count { count: number }
interface Labour { labourCostMinor: number }
interface Decision { decision: { allowed: boolean; outcome: string } }

const emp = (over: Record<string, unknown> = {}) => ({ name: 'Asha', branchId: 'b1', roles: ['deli'], active: true, hourlyRateMinor: 10000, ...over });

describe('workforce / HR data is per-tenant isolated: one shop never sees or writes another shop’s staff records (M25)', () => {
  it('tenant A’s roster, certifications, attendance and payslips are invisible and untouchable from tenant B', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.seedOwner(B, 'u-owner-b');

    // Tenant A records a full HR picture: a deli worker, an understaffed shift, a certificate, hours, a payslip.
    expect((await putEmployee(h, 'u-owner', A, 'E1', emp(), 'a-e1')).status).toBe(200);
    await putShift(h, 'u-owner', A, 'S1', { branchId: 'b1', startsAt: '2026-09-20T06:00:00Z', endsAt: '2026-09-20T14:00:00Z', requiredRoles: [{ role: 'cashier', count: 2 }, { role: 'manager', count: 1 }] }, 'a-s1');
    await assign(h, 'u-owner', A, 'S1', 'E1', 'cashier', 'a-as1');
    await putCert(h, 'u-owner', A, 'C1', { employeeId: 'E1', kind: 'food-handling', issuedOn: '2026-01-01', validUntil: '2026-12-31', verifiedBy: 'u-owner' }, 'a-c1');
    await putAttendance(h, 'u-owner', A, 'E1', DAY, { hours: 8 }, 'a-at1');
    expect((await issuePayslip(h, 'u-owner', A, 'E1', '2026-08', 'a-p1')).status).toBe(200);

    // Positive controls: tenant A sees exactly its own HR data.
    expect((await rosterGaps(h, 'u-owner', A)).body as Gaps).toMatchObject({ gapCount: 2, shiftsChecked: 1 });
    expect(((await listCerts(h, 'u-owner', A, { employeeId: 'E1' })).body as Count).count).toBe(1);
    expect(((await listAttendance(h, 'u-owner', A, { date: DAY })).body as Count).count).toBe(1);
    expect(((await labourCost(h, 'u-owner', A, { branchId: 'b1', date: DAY, salesMinor: '1000000' })).body as Labour).labourCostMinor).toBe(80000);
    expect(((await payslipsFor(h, 'u-owner', A, 'E1')).body as Count).count).toBe(1);

    // Tenant B — a legitimate owner of a DIFFERENT shop — sees NONE of tenant A's staff data.
    expect((await rosterGaps(h, 'u-owner-b', B)).body as Gaps, 'tenant B saw tenant A’s roster').toMatchObject({ gapCount: 0, shiftsChecked: 0 });
    expect(((await listCerts(h, 'u-owner-b', B, { employeeId: 'E1' })).body as Count).count, 'tenant B saw tenant A’s certificates').toBe(0);
    expect(((await listAttendance(h, 'u-owner-b', B, { date: DAY })).body as Count).count, 'tenant B saw tenant A’s attendance').toBe(0);
    expect(((await labourCost(h, 'u-owner-b', B, { branchId: 'b1', date: DAY, salesMinor: '1000000' })).body as Labour).labourCostMinor, 'tenant B saw tenant A’s labour cost').toBe(0);
    // B cannot reach A's employee even by id — a decision cannot be made about someone B has no record of.
    expect((await taskGate(h, 'u-owner-b', B, 'E1', { task: 'deli-counter', today: DAY })).status, 'tenant B reached tenant A’s employee').toBe(404);
    // B holds no payslip for A's employee.
    expect(((await payslipsFor(h, 'u-owner-b', B, 'E1')).body as Count).count, 'tenant B saw tenant A’s payslips').toBe(0);

    // B writing under the SAME ids creates B's OWN records; tenant A must stay exactly as it was.
    await putEmployee(h, 'u-owner-b', B, 'E1', emp({ name: 'Someone Else', roles: ['cashier'], hourlyRateMinor: 99999 }), 'b-e1');
    await putAttendance(h, 'u-owner-b', B, 'E1', DAY, { hours: 12 }, 'b-at1');

    // Tenant A's picture is entirely unaffected by B's writes.
    expect((await rosterGaps(h, 'u-owner', A)).body as Gaps).toMatchObject({ gapCount: 2, shiftsChecked: 1 });
    expect(((await listAttendance(h, 'u-owner', A, { date: DAY })).body as Count).count).toBe(1);
    expect(((await labourCost(h, 'u-owner', A, { branchId: 'b1', date: DAY, salesMinor: '1000000' })).body as Labour).labourCostMinor).toBe(80000);
    // A's E1 is still A's deli worker, food-handling-certified — B's same-id E1 is a different person in another shop.
    expect((await taskGate(h, 'u-owner', A, 'E1', { task: 'deli-counter', requiresCertification: 'food-handling', requiresRole: 'deli', today: DAY })).body as Decision)
      .toMatchObject({ decision: { allowed: true, outcome: 'allowed' } });
  });
});
