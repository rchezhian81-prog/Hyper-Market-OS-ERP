import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ApiHarness } from '../support/api-harness';
import { r3OpsBackings, tenantClient } from '../support/r3-ops-backings';
import { buildStorePackSections } from '../../services/api/src/store-pack-builder';
import { readPack } from '../../edge/store-edge/src/store-pack';
import { buyingPayload } from '../../edge/store-edge/src/screen-data';

/**
 * **OB-630 (owner, 1 Nov 2026): the reorder settings ride each store computer's daily store pack** — read from head office's
 * own register (M09-FR-02), on the real API, in memory and on PostgreSQL, with a cold restart:
 *   • before any is set the pack carries this store's settings EMPTY (told: none kept yet — not "never told");
 *   • a product's settings set at this store reach the pack in force with every earlier version (who, when, why), and
 *     those set for ANOTHER store do not;
 *   • the store computer hands that copy to the Buying page with WHEN it received it, so the Reorder tab can say
 *     "copy from <time>" when head office cannot be reached (P-08).
 */
const backings = r3OpsBackings();

describe.each(backings)('OB-630 — the store pack carries this store\'s reorder settings — on $name', ({ harness, restart }) => {
  it('empty before; this store\'s settings with their history after; another store\'s never; the Buying page gets the copy and its time', async () => {
    let h: ApiHarness = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    const { req, ok } = tenantClient(() => h, T);
    const now = (): string => new Date().toISOString();
    const sections = (): Promise<Record<string, unknown>> => buildStorePackSections({ store: h.store, now, signer: undefined as never, settings: async () => undefined, storeName: async () => undefined }, T, 'S-A');

    const before = await sections();
    expect(before['reorderSettings']).toMatchObject({ storeId: 'S-A', products: [] });

    await ok(req('POST', '/v1/replenishment/parameters/S-A/RICE', { maxLevel: 50_000, reorderPoint: 10_000, reason: 'festival season' }), 'RICE v1');
    await ok(req('POST', '/v1/replenishment/parameters/S-A/RICE', { maxLevel: 60_000, reorderPoint: 12_000, reason: 'sells faster now' }), 'RICE v2');
    await ok(req('POST', '/v1/replenishment/parameters/S-B/OIL', { maxLevel: 40, reason: 'another store' }), 'S-B');

    h = restart(h); // ── COLD RESTART ──

    const after = await sections();
    const settings = after['reorderSettings'] as { storeId: string; products: { current: { productId: string; version: number; maxLevel: number; reason: string; setBy: string }; history: { version: number }[] }[] };
    expect(settings.products.map((p) => p.current.productId)).toEqual(['RICE']); // S-B's settings are not this store's
    expect(settings.products[0]!.current).toMatchObject({ version: 2, maxLevel: 60_000, reason: 'sells faster now', setBy: 'u-owner' });
    expect(settings.products[0]!.history.map((v) => v.version)).toEqual([1, 2]);

    // the store computer reads the copy into the Buying page's payload, with when it received it
    const receivedAt = now();
    const pack = readPack({ ...after, version: 1, lossPreventionRules: [], policies: { tradingDayCutoff: '00:00', storeId: 'S-A', branchId: 'S-A' }, buyingPolicy: { quantityToleranceBps: 0, priceToleranceBps: 0, immaterialMinor: 0, approvers: [] } }, receivedAt);
    const payload = buyingPayload({ pack, sales: [], tradingDay: receivedAt.slice(0, 10), now: receivedAt } as unknown as Parameters<typeof buyingPayload>[0]);
    expect(payload?.['reorderSettings']).toEqual(settings);
    expect(payload?.['reorderSettingsReceivedAt']).toBe(receivedAt);
  }, 120_000);
});
