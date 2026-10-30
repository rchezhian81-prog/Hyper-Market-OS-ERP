import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { r3OpsBackings } from '../support/r3-ops-backings';
import type { ApiHarness } from '../support/api-harness';
import { posAdapter } from '../../services/api/src/adapters';
import type { IncomingSale, SaleException } from '../../services/pos/src/sale-intake';

/**
 * **OB-612 (owner, 30 Oct 2026 · round 16, R16-A): the bill findings (`GET /v1/sales/exceptions`) are only those of the
 * branches the caller may see — server-derived, as OB-601 did for the handheld findings — and a branch outside them is
 * refused by name, never emptied.**
 *
 * Before round 16 the route returned every open finding of the whole business to anyone holding `pos.exception.read`: a
 * store manager of one store read another store's bill findings. Here two stores' bills (and one bill no store can be found
 * for) are banked with a finding each, head office restarts cold, and: the store manager of B1 sees B1's only (also when he
 * asks for B1), is refused B2 by name (403 `scope_not_held`), and never sees the unplaced bill's; the owner (company-wide)
 * sees all three, or one store's when he names it; a cashier reads none (403). In memory and on real PostgreSQL.
 */

const backings = r3OpsBackings();
const AT = '2026-10-29T06:00:00.000Z';
const sale = (saleId: string, locationId: string | undefined): IncomingSale => ({
  saleId, receiptNumber: `R-${saleId}`, laneId: `lane-${saleId}`, cashierId: 'u-cash', tradingDay: '2026-10-29', committedAt: AT, totalMinor: 100_00, currency: 'INR',
  packVersion: 999, lines: [{ productId: 'p-oil', quantityMinor: 1, uom: 'ea', unitPriceMinor: 100_00 }], tenders: [{ kind: 'cash', amountMinor: 100_00 }],
  ...(locationId === undefined ? {} : { locationId }),
} as unknown as IncomingSale);
const finding = (saleId: string): SaleException => ({ kind: 'price_differs_from_catalogue', severity: 'material', saleId, productId: 'p-oil', differenceMinor: -5_00, detail: `bill ${saleId}: charged below the catalogue`, ownerAction: 'Check the price.' });

describe.each(backings)('the bill findings are the caller\'s own stores\' (OB-612) — on $name', ({ harness, restart }) => {
  it('a store manager sees his store\'s, is refused another by name; the owner sees every store\'s, or the one he names', async () => {
    const tenant = randomUUID();
    let h: ApiHarness = harness();
    await h.seedOwner(tenant, 'u-owner');
    const pos = posAdapter({ store: h.store, now: () => AT });
    for (const [id, loc] of [['S-B1', 'B1'], ['S-B2', 'B2'], ['S-X', undefined]] as const) {
      await pos.bankSale(tenant, sale(id, loc));
      await pos.recordExceptions(tenant, [finding(id)]);
    }

    h = restart(h); // ── COLD RESTART: the stores are head office's own answer from the stored bills ────────────────────
    await h.provisionRole(tenant, 'u-m1', 'store_manager', ['B1']);
    await h.provisionRole(tenant, 'u-cash', 'cashier', ['B1']);
    const read = (userId: string, query?: Record<string, string>) => h.request({ method: 'GET', path: '/v1/sales/exceptions', userId, tenantId: tenant, ...(userId === 'u-owner' ? {} : { branchId: 'B1' }), ...(query === undefined ? {} : { query }) });
    const bills = async (userId: string, query?: Record<string, string>): Promise<string[]> => {
      const r = await read(userId, query);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return ((r.body as { material: { saleId: string }[] }).material).map((f) => f.saleId).sort();
    };

    expect(await bills('u-m1')).toEqual(['S-B1']);
    expect(await bills('u-m1', { branchId: 'B1' })).toEqual(['S-B1']);
    const refused = await read('u-m1', { branchId: 'B2' });
    expect(refused.status).toBe(403);
    expect((refused.body as { error: { code: string; whatHappened: string } }).error).toMatchObject({ code: 'scope_not_held', whatHappened: expect.stringContaining('"B2"') });
    expect(await bills('u-owner')).toEqual(['S-B1', 'S-B2', 'S-X']);
    expect(await bills('u-owner', { branchId: 'B2' })).toEqual(['S-B2']);
    expect(((await read('u-owner', { branchId: 'B2' })).body as { branchId: string | null }).branchId).toBe('B2');
    expect((await read('u-cash')).status).toBe(403);
  }, 60_000);
});
