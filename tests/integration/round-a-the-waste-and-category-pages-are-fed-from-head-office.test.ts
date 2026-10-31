import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ApiHarness } from '../support/api-harness';
import { r3OpsBackings, tenantClient } from '../support/r3-ops-backings';
import { buildStorePackSections } from '../../services/api/src/store-pack-builder';
import { readPack } from '../../edge/store-edge/src/store-pack';
import { wastePayload, categoryPolicyPayload } from '../../edge/store-edge/src/screen-data';

/**
 * **Screen gap audit (31 Oct 2026) Round A — the Waste and Category rules pages are fed from head office's own registers,
 * on the real API, in memory and on PostgreSQL, with a cold restart.**
 *
 * Before: the store pack never carried the write-offs or the categories, so both pages stayed empty forever, and the empty
 * Waste page said "No material losses" — "all clear" for a register nobody had read (P-08). Now:
 *   • before anything is recorded the pack carries both lists EMPTY (told, nothing yet — not "never told");
 *   • a write-off head office committed at this store reaches the pack as the page's review row (type, quantity, value,
 *     whether it needed a second person, who raised it) — and one at ANOTHER store does not;
 *   • every category on head office's list reaches the Category rules page with NO rules (head office keeps no dated rule
 *     set for a category — nothing is invented), so the page flags it "no rules in force".
 * Synthetic data only.
 */
const backings = r3OpsBackings();
const TODAY = new Date().toISOString().slice(0, 10);

describe.each(backings)('Round A — the Waste and Category rules pages are fed from head office — on $name', ({ harness, restart }) => {
  it('empty lists before anything is recorded; this store\'s write-offs and every category after; another store\'s write-off never', async () => {
    let h: ApiHarness = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    const { req, ok } = tenantClient(() => h, T);
    const now = (): string => new Date().toISOString();
    const sections = (): Promise<Record<string, unknown>> => buildStorePackSections({ store: h.store, now, signer: undefined as never, settings: async () => undefined, storeName: async () => undefined }, T, 'S-A');

    // ── nothing recorded yet: both lists are sent, empty ──
    const before = await sections();
    expect(before['wasteWriteOffs']).toEqual([]);
    expect(before['categoryPolicyCategories']).toEqual([]);

    // ── head office's records: a category, stock with a cost at two stores, one write-off at each ──
    await ok(req('POST', '/v1/catalogue/categories/grocery', { name: 'Grocery', parentId: null }), 'category');
    for (const [id, place] of [['rcv-a', 'S-A'], ['rcv-b', 'S-B']] as const) {
      await ok(req('POST', '/v1/inventory/movements', { movementId: id, productId: 'OIL', locationId: place, kind: 'received', quantityMinor: 10, uom: 'each', occurredAt: `${TODAY}T03:00:00.000Z`, enteredBy: 'u-owner', unitCostMinor: 5_000 }), id);
    }
    await ok(req('POST', '/v1/inventory/write-off/W-A', { productId: 'OIL', locationId: 'S-A', qty: 2, uom: 'each', lossType: 'damage', reasonCode: 'damage' }, 'u-mgr'), 'write-off at S-A');
    await ok(req('POST', '/v1/inventory/write-off/W-B', { productId: 'OIL', locationId: 'S-B', qty: 1, uom: 'each', lossType: 'expiry', reasonCode: 'expiry' }, 'u-mgr'), 'write-off at S-B');

    h = restart(h); // ── COLD RESTART ──

    const after = await sections();
    const rows = after['wasteWriteOffs'] as { id: string; productId: string; lossType: string; qtyRemoved: number; valueMinor: number; requiredApproval: boolean; raisedBy: string }[];
    expect(rows.map((r) => r.id)).toEqual(['W-A']); // S-B's loss is not this store's
    expect(rows[0]).toMatchObject({ productId: 'OIL', lossType: 'damage', qtyRemoved: 2, valueMinor: 10_000, raisedBy: 'u-mgr' });
    expect(typeof rows[0]!.requiredApproval).toBe('boolean');
    expect(after['categoryPolicyCategories']).toEqual([{ categoryId: 'grocery', name: 'Grocery', history: [] }]);

    // ── the store computer reads them into the two pages' payloads ──
    const pack = readPack({ ...after, version: 1, lossPreventionRules: [], policies: { tradingDayCutoff: '00:00', storeId: 'S-A', branchId: 'S-A' } }, now());
    const input = { pack, sales: [], tradingDay: TODAY, now: now() } as unknown as Parameters<typeof wastePayload>[0];
    expect(wastePayload(input)?.['rows']).toEqual(rows);
    expect((categoryPolicyPayload(input)?.['categories'] as { categoryId: string }[]).map((c) => c.categoryId)).toEqual(['grocery']);
  }, 120_000);
});
