import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// HR/Workforce DURABLE attendance store (M25 follow-on) on the live API. The POST /labour-cost route is a
// stateless what-if; this persists the hours worked (append-only, latest-per-(employee,date), hard rule #2) so
// GET /v1/hr/workforce/labour-cost reads the STORED hours for a day + the stored staff for a branch (with their
// hourly rate) and runs the tested labourCost — REPORTED, never enforced (§29): above-guide is "worth a look",
// a no-sales day is not_meaningful (never a divide-by-zero), and nothing can refuse a roster on cost. Writes
// gated workforce.roster.manage; reads workforce.roster.read.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const putEmployee = (h: ApiHarness, u: string, id: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/hr/workforce/employees/${id}`, userId: u, tenantId: A, idempotencyKey: key, body });
const putAttendance = (h: ApiHarness, u: string, employeeId: string, date: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/hr/workforce/attendance/${employeeId}/${date}`, userId: u, tenantId: A, idempotencyKey: key, body });
const listAttendance = (h: ApiHarness, u: string, query: Record<string, string>) =>
  h.request({ method: 'GET', path: '/v1/hr/workforce/attendance', userId: u, tenantId: A, query });
const labourCost = (h: ApiHarness, u: string, query: Record<string, string>) =>
  h.request({ method: 'GET', path: '/v1/hr/workforce/labour-cost', userId: u, tenantId: A, query });
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

interface LabourView { readonly branchId: string; readonly labourCostMinor: number; readonly salesMinor: number; readonly labourBps: number | 'not_meaningful'; readonly aboveGuide: boolean }

const emp = (over: Record<string, unknown> = {}) => ({ name: 'Kavya', branchId: 'b1', roles: ['cashier'], active: true, hourlyRateMinor: 10000, ...over });
const DAY = '2026-09-14';

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // workforce.roster.manage + read
  await h.provisionRole(A, 'u-cash', 'cashier');       // neither
  return h;
}

describe('durable attendance store (M25 follow-on) — reported labour cost from stored hours', () => {
  it('computes labour cost from the stored hours and staff, flags above-guide, and survives a restart', async () => {
    const h = await cast();
    await putEmployee(h, 'u-mgr', 'E1', emp({ hourlyRateMinor: 10000 }), 'k1'); // ₹100/hr
    expect((await putAttendance(h, 'u-mgr', 'E1', DAY, { hours: 8 }, 'k2')).status).toBe(200);

    // 8h × 10000 = 80000 labour; 80000 / 1,000,000 sales = 800 bps (8%). Guide 500 bps → above.
    const view = (await labourCost(h, 'u-mgr', { branchId: 'b1', date: DAY, salesMinor: '1000000', guideBps: '500' })).body as LabourView;
    expect(view.labourCostMinor).toBe(80000);
    expect(view.labourBps).toBe(800);
    expect(view.aboveGuide).toBe(true);

    // Durable: a restart rebuilds the hours + staff from the event log.
    const restarted = apiHarness({ store: h.store });
    const after = (await labourCost(restarted, 'u-owner', { branchId: 'b1', date: DAY, salesMinor: '1000000', guideBps: '500' })).body as LabourView;
    expect(after.labourCostMinor).toBe(80000);
  });

  it('a no-sales day is not_meaningful, never a divide-by-zero', async () => {
    const h = await cast();
    await putEmployee(h, 'u-mgr', 'E1', emp(), 'k1');
    await putAttendance(h, 'u-mgr', 'E1', DAY, { hours: 8 }, 'k2');
    const view = (await labourCost(h, 'u-mgr', { branchId: 'b1', date: DAY, salesMinor: '0' })).body as LabourView;
    expect(view.labourBps).toBe('not_meaningful');
  });

  it('counts only the branch asked for; the stored hours read back for the day', async () => {
    const h = await cast();
    await putEmployee(h, 'u-mgr', 'E1', emp({ branchId: 'b1' }), 'k1');
    await putEmployee(h, 'u-mgr', 'E2', emp({ branchId: 'b2', hourlyRateMinor: 20000 }), 'k2');
    await putAttendance(h, 'u-mgr', 'E1', DAY, { hours: 8 }, 'k3');
    await putAttendance(h, 'u-mgr', 'E2', DAY, { hours: 8 }, 'k4');

    // Branch b1 sees only E1's 8h × 10000 = 80000 (E2 is in b2).
    const b1 = (await labourCost(h, 'u-mgr', { branchId: 'b1', date: DAY, salesMinor: '1000000' })).body as LabourView;
    expect(b1.labourCostMinor).toBe(80000);
    // Both days' hours are stored and read back.
    const list = (await listAttendance(h, 'u-mgr', { date: DAY })).body as { count: number };
    expect(list.count).toBe(2);
  });

  it('gates writes/reads and refuses a malformed record', async () => {
    const h = await cast();
    await putEmployee(h, 'u-mgr', 'E1', emp(), 'k1');
    expect((await putAttendance(h, 'u-cash', 'E1', DAY, { hours: 8 }, 'k2')).status).toBe(403);
    expect((await labourCost(h, 'u-cash', { branchId: 'b1', date: DAY, salesMinor: '1000000' })).status).toBe(403);
    expect(codeOf(await putAttendance(h, 'u-mgr', 'E1', 'not-a-date', { hours: 8 }, 'k3'))).toBe('not_readable_as_attendance');
    expect(codeOf(await labourCost(h, 'u-mgr', { branchId: 'b1', date: DAY }))).toBe('not_readable_as_a_labour_cost'); // missing salesMinor
  });
});
