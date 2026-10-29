import { describe, it, expect, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { r3OpsBackings, tenantClient } from '../support/r3-ops-backings';
import type { ApiHarness } from '../support/api-harness';
import { certifyFoodHandler } from '../support/food-handler';
import { ownerApprovedSetting } from '../support/owner-approved-setting';
import { shopDateTimeOf } from '../../packages/calendar/src/shop-day';
import { pinTheEveningClock } from '../support/evening-clock';

/**
 * **OB-607 outside the screens (owner, 29 Oct 2026 · round 15, R15-A) — head office's printed food label and its roster-gap
 * messages show the SHOP's clock, in the tenant's own calendar (`locale.time_zone`), on the live API.**
 *
 * Before round 15 both were the UTC clock of the ISO text: a cake made at 19:30 UTC (01:00 in the shop) and good for 48
 * hours printed "USE BY … 19:30"; a shift starting 00:30 UTC was named "00:30" in the gap message for the shop's 06:00.
 * The clock is pinned to an evening UTC moment (tests/support/evening-clock.ts) — the shop is already on the next day. The
 * run is committed and the roster stored, then head office restarts cold; the shop's zone is then changed (owner-approved)
 * and both follow it. In memory and on real PostgreSQL. Synthetic data only.
 */

const backings = r3OpsBackings();
const GOOD = { productName: 'Synthetic coffee cake', netQuantity: '180 g', packerDetails: 'SRE Hyper Market, Tamil Nadu', priceMinor: 120_00, allergens: ['milk'], vegClass: 'veg' };
const SHIFT = { branchId: 'b1', startsAt: '2026-11-02T00:30:00.000Z', endsAt: '2026-11-02T08:30:00.000Z', requiredRoles: [{ role: 'opener', count: 1 }] };
const evening = pinTheEveningClock();
afterAll(() => { vi.useRealTimers(); });

describe.each(backings)('a label and a roster gap read the shop\'s clock — on $name', ({ harness, restart }) => {
  it('USE BY and the gap\'s hour are the shop\'s clock, in the tenant\'s zone, after a cold restart', async () => {
    const tenant = randomUUID(); // a fresh shop per backing — the PostgreSQL database outlives the run
    let h: ApiHarness = harness();
    await h.seedOwner(tenant, 'u-owner');
    await certifyFoodHandler(h.store, tenant, 'u-owner');
    const { req, ok, code } = tenantClient(() => h, tenant);
    await ok(req('POST', '/v1/production/departments/cafe', {}), 'cafe enabled');
    await ok(req('POST', '/v1/inventory/movements', { movementId: 'mv-F', productId: 'FLOUR', locationId: 'KITCHEN', kind: 'received', quantityMinor: 500, uom: 'g', occurredAt: '2026-10-27T00:00:00.000Z', enteredBy: 'u-owner' }), 'stock');
    await ok(req('POST', '/v1/production/recipes/r-cake', {
      departmentId: 'cafe', outputProductId: 'CAKE', outputQuantityMinor: 1, outputUom: 'ea',
      inputs: [{ productId: 'FLOUR', quantityMinor: 100, uom: 'g' }], shelfLifeHours: 48, expectedYieldBp: 10_000, yieldToleranceBp: 500,
    }), 'recipe');
    await ok(req('POST', '/v1/production/runs/run-L', { recipeId: 'r-cake', batches: 1, actualOutputMinor: 1, outputBatchId: 'CAKE-L1', locationId: 'KITCHEN' }), 'run');
    await ok(req('POST', '/v1/hr/workforce/shifts/SH-1', SHIFT), 'shift stored');

    h = restart(h); // ── COLD RESTART: the label is judged on the stored run, the gap on the stored roster ─────────────
    const runs = (await ok(req('GET', '/v1/production/runs'), 'runs')).body as { runs: { runId: string; expiresAt: string }[] };
    const expiresAt = runs.runs.find((r) => r.runId === 'run-L')!.expiresAt;
    expect(Date.parse(expiresAt)).toBeGreaterThanOrEqual(Date.parse(evening.at) + 48 * 3_600_000);

    const label = async () => ((await ok(req('POST', '/v1/production/runs/run-L/label', GOOD), 'label')).body as { lines: string[] }).lines;
    const useBy = (await label()).find((l) => l.startsWith('USE BY '));
    expect(useBy).toBe(`USE BY ${shopDateTimeOf(expiresAt, 'Asia/Kolkata')}`);
    expect(useBy).not.toBe(`USE BY ${expiresAt.slice(0, 16).replace('T', ' ')}`); // never the UTC clock of the ISO text

    const gapsNow = async () => ((await ok(req('GET', '/v1/hr/workforce/roster-gaps'), 'gaps')).body as { gaps: { detail: string }[] }).gaps.map((g) => g.detail);
    expect(await gapsNow()).toEqual(['2026-11-02 06:00 has NOBODY rostered as opener']);
    const whatIf = await ok(req('POST', '/v1/hr/workforce/roster-gaps', { shifts: [{ shiftId: 'SH-W', ...SHIFT }], assignments: [], employees: [] }), 'what-if');
    expect((whatIf.body as { gaps: { detail: string }[] }).gaps[0]!.detail).toBe('2026-11-02 06:00 has NOBODY rostered as opener');

    // The shop's zone is the TENANT's (owner-approved), not a constant: both follow it.
    expect((await ownerApprovedSetting(h, tenant, 'locale.time_zone', { value: 'Asia/Dubai' })).status).toBe(200);
    expect((await label()).find((l) => l.startsWith('USE BY '))).toBe(`USE BY ${shopDateTimeOf(expiresAt, 'Asia/Dubai')}`);
    expect(await gapsNow()).toEqual(['2026-11-02 04:30 has NOBODY rostered as opener']);

    // The error paths are unchanged: a cashier may not print a label (403), nor read the roster's gaps.
    await h.provisionRole(tenant, 'u-cash', 'cashier');
    const refused = await req('POST', '/v1/production/runs/run-L/label', GOOD, 'u-cash');
    expect(refused.status).toBe(403);
    expect((await req('GET', '/v1/hr/workforce/roster-gaps', undefined, 'u-cash')).status).toBe(403);
    expect(code(await req('POST', '/v1/production/runs/run-L/label', { ...GOOD, vegClass: undefined }))).toBe('incomplete_label');
  }, 60_000);
});
