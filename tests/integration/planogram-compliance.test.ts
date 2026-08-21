import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// M04-FR-03 planogram compliance on the live API — the CONSUMER of the shelf-count producer. The
// recorded counts (M04-FR-02) are folded into the plan and turned into the right task: an EMPTY facing
// with stock in the stockroom is an urgent refill, told apart from an empty facing with none (a
// reorder). An UNCOUNTED facing is never_counted — not a breach, not compliant — and the compliance
// percentage is taken over the observed facings only, so a figure nobody earned is never quoted (P-08).
// A self-inconsistent plan is a 422, not a shortage. Gated planogram.compliance.read.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const STORE = 'BR1';
const KNOWN = ['loc1', 'loc2', 'loc3'];

const loc = (locationId: string, aisle: number) => ({ locationId, aisle, rack: 1, bay: 1, shelf: 1, position: 1 });
const asn = (productId: string, locationId: string, capacityMinor: number) => ({ productId, locationId, capacityMinor, primary: true });

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

// Record a blind count through the producer (the observation the compliance run reads).
const count = (h: ApiHarness, u: string, id: string, productId: string, locationId: string, countedMinor: number) =>
  h.request({ method: 'POST', path: `/v1/merchandising/shelf-counts/${id}`, userId: u, tenantId: A, idempotencyKey: id,
    body: { storeId: STORE, locationId, productId, countedMinor, knownLocationIds: KNOWN } });

const compliance = (h: ApiHarness, u: string, body: Record<string, unknown>, key = 'pc1') =>
  h.request({ method: 'POST', path: '/v1/merchandising/planogram-compliance', userId: u, tenantId: A, idempotencyKey: key,
    body: { planogram: { planogramId: 'PG-1', storeId: STORE, version: 1, effectiveFrom: '2026-08-01T00:00:00Z', createdBy: 'u-owner', assignments: body['assignments'] }, assignedRole: 'shelf_filler', ...body } });

type Result = {
  issues: { productId: string; finding: string; detail: string }[];
  tasks: { productId: string; priority: string; quantityMinor: number; availableMinor: number }[];
  complianceBp: number; notObserved: number; wholePlanObserved: boolean;
};

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // shelf.count.record + planogram.compliance.read
  await h.provisionRole(A, 'u-cash', 'cashier');       // neither
  return h;
}

describe('planogram compliance: recorded counts drive refill vs reorder (M04-FR-03)', () => {
  it('turns the counts into the three findings: urgent refill, compliant, reorder', async () => {
    const h = await cast();
    await count(h, 'u-mgr', 'c1', 'p1', 'loc1', 0); // empty, stock in the building
    await count(h, 'u-mgr', 'c2', 'p2', 'loc2', 5); // full (capacity 5) → compliant
    await count(h, 'u-mgr', 'c3', 'p3', 'loc3', 0); // empty, none in the building → reorder

    const res = await compliance(h, 'u-owner', {
      assignments: [asn('p1', 'loc1', 10), asn('p2', 'loc2', 5), asn('p3', 'loc3', 8)],
      locations: [loc('loc1', 1), loc('loc2', 2), loc('loc3', 3)],
      backstock: { p1: 20, p3: 0 },
    });
    expect(res.status).toBe(200);
    const r = res.body as Result;

    // p1: the most expensive out-of-stock — empty with 20 in the stockroom → one urgent refill task.
    expect(r.tasks).toHaveLength(1);
    expect(r.tasks[0]).toMatchObject({ productId: 'p1', priority: 'urgent', quantityMinor: 10, availableMinor: 20 });
    expect(r.issues.find((i) => i.productId === 'p1')?.finding).toBe('empty_shelf');
    expect(r.issues.find((i) => i.productId === 'p1')?.detail).toContain('stockroom');
    // p3: empty with none in the building — a reorder, NOT a task for a shelf-filler.
    expect(r.issues.find((i) => i.productId === 'p3')?.finding).toBe('empty_shelf');
    expect(r.issues.find((i) => i.productId === 'p3')?.detail).toContain('reorder');
    // p2 is compliant → no issue, no task.
    expect(r.issues.find((i) => i.productId === 'p2')).toBeUndefined();
    // Compliance over the three observed facings: only p2 is compliant → 3333 bp.
    expect(r.complianceBp).toBe(3333);
    expect(r.notObserved).toBe(0);
    expect(r.wholePlanObserved).toBe(true);
  });

  it('an uncounted facing is never_counted — left out of the percentage, not called empty', async () => {
    const h = await cast();
    await count(h, 'u-mgr', 'c1', 'p1', 'loc1', 8); // fresh, 8/10 → compliant
    // p2 is on the plan but nobody has counted it.
    const r = (await compliance(h, 'u-owner', {
      assignments: [asn('p1', 'loc1', 10), asn('p2', 'loc2', 5)],
      locations: [loc('loc1', 1), loc('loc2', 2)],
      backstock: { p2: 4 },
    })).body as Result;

    const p2 = r.issues.find((i) => i.productId === 'p2');
    expect(p2?.finding).toBe('never_counted'); // not an empty shelf — an unchecked one
    expect(r.notObserved).toBe(1);
    expect(r.wholePlanObserved).toBe(false);
    // Over the one observed facing (p1, compliant) — never-counted p2 is not folded in as a breach.
    expect(r.complianceBp).toBe(10_000);
    expect(r.tasks).toHaveLength(0); // never-counted raises no refill task; count it first
  });

  it('a self-inconsistent plan is refused 422 (a shelf the store has not mapped)', async () => {
    const h = await cast();
    const res = await compliance(h, 'u-owner', {
      assignments: [asn('p1', 'ghost', 10)], // no such location in the map
      locations: [loc('loc1', 1)],
      backstock: {},
    });
    expect(res.status).toBe(422);
    expect(codeOf(res)).toBe('the_plan_is_inconsistent');
  });

  it('gates the read, and folds counts recorded before a restart (durable stream)', async () => {
    const h = await cast();
    // A cashier cannot run a compliance read.
    expect((await compliance(h, 'u-cash', {
      assignments: [asn('p1', 'loc1', 10)], locations: [loc('loc1', 1)], backstock: {},
    })).status).toBe(403);

    await count(h, 'u-mgr', 'c1', 'p1', 'loc1', 3); // 3/10 → below minimum, refill

    const restarted = apiHarness({ store: h.store });
    const r = (await compliance(restarted, 'u-owner', {
      assignments: [asn('p1', 'loc1', 10)], locations: [loc('loc1', 1)], backstock: { p1: 50 },
    })).body as Result;
    // The count survived the restart and drove a task — capped at the facing (bring 7), not the 50 spare.
    expect(r.tasks).toHaveLength(1);
    expect(r.tasks[0]).toMatchObject({ productId: 'p1', quantityMinor: 7 });
    expect(r.issues.find((i) => i.productId === 'p1')?.finding).toBe('below_minimum');
  });
});
