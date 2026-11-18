import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ApiHarness } from '../support/api-harness';
import { r3OpsBackings, tenantClient } from '../support/r3-ops-backings';
import { buildStorePackSections } from '../../services/api/src/store-pack-builder';
import { readPack } from '../../edge/store-edge/src/store-pack';
import { todayFigures, managerPayload, type ScreenInput } from '../../edge/store-edge/src/screen-data';
import { directoryPayload } from '../../edge/store-edge/src/screen-directory';
import { branchOf } from '../../edge/store-edge/src/screen-navigation';

/**
 * **Batch 15 (owner's gap audit, 18 Nov 2026): the daily store pack carries the low-stock list, the suppliers' names and the
 * store's town** — on the real API, in memory and on PostgreSQL, with a cold restart:
 *   • before any reorder point is set the list is sent with `levelsSet: 0` — the Today card then says "no reorder levels set
 *     yet", never "0 low";
 *   • an item with a reorder point and less stock than it is on the list; one with only a maximum level is not counted;
 *     another store's settings are not this store's;
 *   • a supplier recorded at head office arrives by NAME (and nothing else from its record);
 *   • the town is an optional store-setup answer: refused when it is not one plain line, and carried when the store has one.
 */
const backings = r3OpsBackings();

describe.each(backings)('Batch 15 — low stock, supplier names and the town ride the store pack — on $name', ({ harness, restart }) => {
  it('levels not set; then this store\'s low items; suppliers by name; the town only when set', async () => {
    let h: ApiHarness = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    const { req, ok } = tenantClient(() => h, T);
    const now = (): string => new Date().toISOString();
    const sections = (): Promise<Record<string, unknown>> => buildStorePackSections({
      store: h.store, now, signer: undefined as never, settings: async () => undefined, storeName: async () => undefined, storeTown: async () => undefined,
    }, T, 'S-A');

    expect((await sections())['lowStock']).toEqual({ levelsSet: 0, items: [] });

    await ok(req('POST', '/v1/replenishment/parameters/S-A/RICE', { maxLevel: 50_000, reorderPoint: 10_000, reason: 'festival season' }), 'RICE');
    await ok(req('POST', '/v1/replenishment/parameters/S-A/OIL', { maxLevel: 40, reason: 'only a maximum' }), 'OIL');
    await ok(req('POST', '/v1/replenishment/parameters/S-B/DAL', { maxLevel: 40, reorderPoint: 30, reason: 'another store' }), 'S-B');
    await ok(req('POST', '/v1/purchase/suppliers/sup-aachi', { name: 'Aachi Masala Foods' }), 'supplier');

    h = restart(h); // ── COLD RESTART ──

    const after = await sections();
    // RICE: no stock at S-A → 0 on hand, at or below 10 000. OIL has no reorder point. DAL is S-B's.
    expect(after['lowStock']).toEqual({ levelsSet: 1, items: [{ productId: 'RICE', onHandMinor: 0, reorderPoint: 10_000 }] });
    expect(after['suppliers']).toEqual([{ supplierId: 'sup-aachi', name: 'Aachi Masala Foods' }]);
    expect(JSON.stringify(after['suppliers'])).not.toMatch(/bank|account|gstin|phone/i);

    // The town: an optional setup answer, a plain line — refused otherwise; the pack carries it only when set.
    const put = (value: string) => h.request({ method: 'PUT', path: '/v1/platform/setup/store.town', userId: 'u-owner', tenantId: T, idempotencyKey: `k-${randomUUID()}`, body: { value } });
    const refused = await put('Tiruppur\nNorth');
    expect(refused.status).toBe(422);
    expect(JSON.stringify(refused.body)).toMatch(/one line of at most 60 characters/);
    await ok(put('Tiruppur'), 'town');
    expect((after['policies'] as Record<string, unknown> | undefined)?.['branchTown']).toBeUndefined(); // no store settings → no policies section at all

    // With store settings and the town held, the policies carry it (and only then).
    const SETTINGS_S_A = { storeId: 'S-A', warehouseId: null, tradingDayCutoff: '02:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 0, handoverToleranceMinor: 0, cashVarianceToleranceMinor: 0, privacySlaDays: 15, version: 1, setBy: 'u-owner', setAt: now() };
    const withTown = await buildStorePackSections({ store: h.store, now, signer: undefined as never, settings: async () => SETTINGS_S_A, storeName: async () => 'SRE Hyper Market', storeTown: async () => ' Tiruppur ' }, T, 'S-A');
    expect((withTown['policies'] as Record<string, unknown>)['branchTown']).toBe('Tiruppur');
    const noTown = await buildStorePackSections({ store: h.store, now, signer: undefined as never, settings: async () => SETTINGS_S_A, storeName: async () => 'SRE Hyper Market', storeTown: async () => '' }, T, 'S-A');
    expect('branchTown' in (noTown['policies'] as Record<string, unknown>)).toBe(false);

    // The store computer reads all three: the Low stock card, the list, the supplier names and the town.
    const town = 'Tiruppur';
    const receivedAt = now();
    const pack = readPack({ ...after, version: 1, policies: { tradingDayCutoff: '00:00', storeId: 'S-A', branchId: 'S-A', branchName: 'SRE Hyper Market', branchTown: town } }, receivedAt);
    const input = { pack, sales: [], tradingDay: receivedAt.slice(0, 10), now: receivedAt, unreadableRecords: 0, outbox: { pending: () => [], depth: () => 0 } } as unknown as ScreenInput;
    expect(todayFigures(input)['lowStock']).toMatchObject({ known: true, value: 1 });
    expect(branchOf(pack)).toEqual({ name: 'SRE Hyper Market', town: 'Tiruppur' });
    expect(directoryPayload(pack, null).suppliers).toEqual([{ id: 'sup-aachi', name: 'Aachi Masala Foods' }]);
    expect(managerPayload(input)['lowStockList']).toMatchObject({ levelsSet: 1, asAt: receivedAt, items: [{ productId: 'RICE' }] });
  }, 120_000);
});
