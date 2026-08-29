import { describe, it, expect } from 'vitest';
import { apiHarness } from '../support/api-harness';

/**
 * **Labour cost as a share of sales, on the cloud (M25-FR-01, §29, P-03).**
 *
 * The last unwired engine in `packages/workforce` — the five decision routes beside it were already
 * live. It is deliberately **reported, never enforced**: a system that refuses a fourth cashier
 * because the ratio looks bad makes queues at Diwali and loses more than it saved. It states the
 * number, names the guide, flags above-guide as *worth a look*, and a manager decides. This drives
 * the pure `labourCost` through the real authenticated surface.
 */

const TENANT = 't-sre';
const STAFF = [
  { employeeId: 'e-1', name: 'Meena', branchId: 'b-main', roles: ['cashier'], active: true, hourlyRateMinor: 9_000 },
  { employeeId: 'e-2', name: 'Ravi', branchId: 'b-main', roles: ['cashier'], active: true, hourlyRateMinor: 12_000 },
];

describe('labour-cost view on the API', () => {
  it('states the ratio and flags it above the guide, without blocking anything', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    const res = await h.request({
      method: 'POST', path: '/v1/hr/workforce/labour-cost', userId: 'u-owner', tenantId: TENANT,
      idempotencyKey: 'lc-1',
      body: { branchId: 'b-main', hours: [{ employeeId: 'e-1', hours: 8 }, { employeeId: 'e-2', hours: 8 }], employees: STAFF, salesMinor: 1_000_000, guideBps: 1_200 },
    });
    expect(res.status).toBe(200);
    const body = res.body as { labourCostMinor: number; labourBps: number; aboveGuide: boolean; detail: string };
    expect(body.labourCostMinor).toBe(168_000); // 9000×8 + 12000×8
    expect(body.labourBps).toBe(1_680);          // 16.8% of ₹10,000
    expect(body.aboveGuide).toBe(true);
    expect(body.detail).toContain('a queue costs more than a cashier');
  });

  it('says the ratio means nothing on a day with no sales — never a divide-by-zero', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    const res = await h.request({
      method: 'POST', path: '/v1/hr/workforce/labour-cost', userId: 'u-owner', tenantId: TENANT,
      idempotencyKey: 'lc-0',
      body: { branchId: 'b-main', hours: [{ employeeId: 'e-1', hours: 8 }], employees: STAFF, salesMinor: 0 },
    });
    expect(res.status).toBe(200);
    const body = res.body as { labourBps: number | string; aboveGuide: boolean };
    expect(body.labourBps).toBe('not_meaningful');
    expect(body.aboveGuide).toBe(false);
  });

  it('refuses an unreadable body without changing anything', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    const res = await h.request({
      method: 'POST', path: '/v1/hr/workforce/labour-cost', userId: 'u-owner', tenantId: TENANT,
      idempotencyKey: 'lc-bad', body: { branchId: 'b-main', salesMinor: 1_000 },
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('not_readable_as_a_labour_cost');
  });

  it('is closed to a caller without the workforce permission', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    const res = await h.request({
      method: 'POST', path: '/v1/hr/workforce/labour-cost', userId: 'u-nobody', tenantId: TENANT,
      idempotencyKey: 'lc-403',
      body: { branchId: 'b-main', hours: [], employees: [], salesMinor: 1_000 },
    });
    expect(res.status).toBe(403);
  });
});
