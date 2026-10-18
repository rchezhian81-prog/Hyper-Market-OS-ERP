import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ApiHarness } from '../support/api-harness';
import { r3OpsBackings, tenantClient } from '../support/r3-ops-backings';

/**
 * D-19 (R3, OB-148 "A", signed sentence OB-190) — on the real API, in memory and on PostgreSQL, with a cold restart:
 * "The till, app and delivery all charge the same shelf price. Channel prices are built but switched off. Switching one on
 * needs a second person's approval, and a report lists any price difference between channels."
 */
const backings = r3OpsBackings();
const GROCERY = { categoryId: 'grocery', name: 'Grocery', parentId: null };
const FROM = '2030-01-01';
const AT = '2030-06-01T10:00:00.000Z';
const entry = (scope: string, scopeRef: string, priceMinor: number) => ({ scope, scopeRef, priceMinor, mrpMinor: 12_000, costMinor: 1, marginFloorBps: 0, currency: 'INR', effectiveFrom: FROM });

describe.each(backings)('channel prices are built, switched off, and switched on only by a second person — on $name (D-19)', ({ harness, restart }) => {
  it('one shelf price everywhere → refused while off → second person switches on → difference reported → off again restores the shelf price', async () => {
    let h: ApiHarness = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-till', 'cashier');
    const { req, ok, code } = tenantClient(() => h, T);
    await ok(req('POST', '/v1/catalogue/tax-classes/04061000/rates/2017-07-01', { rateBps: 500 }), 'tax');
    await ok(req('POST', '/v1/catalogue/products/p-ghee/publish', { product: { sku: 'SKU-GHEE', name: 'Ghee 1L', baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '04061000', lifecycle: 'draft' }, categories: [GROCERY] }), 'publish');
    await ok(req('POST', '/v1/prices/list/p-ghee/entries/shelf', entry('store', 'S-A', 10_000)), 'shelf price');
    const resolve = async (q: Record<string, string>) => ((await req('GET', '/v1/prices/list/p-ghee/resolve', undefined, 'u-owner', { at: AT, storeId: 'S-A', ...q })).body as { priceMinor: number; scope: string }).priceMinor;
    const report = async () => (await req('GET', '/v1/prices/channel-differences', undefined, 'u-owner', { storeId: 'S-A', at: AT })).body as { differences: { productId: string; channel: string; shelfPriceMinor: number; channelPriceMinor: number }[]; dormantEntries: { entryId: string; switch: string }[]; samePriceEverywhere: boolean };

    // ── switched off by default: one price everywhere; a channel or zone price is refused ───────────────────────
    const state = (await req('GET', '/v1/prices/channel-pricing')).body as { switches: { subject: string; state: string }[]; samePriceEverywhere: boolean };
    expect(state.samePriceEverywhere).toBe(true);
    expect(state.switches).toEqual([{ subject: 'channel:app', state: 'off' }, { subject: 'channel:delivery', state: 'off' }, { subject: 'zone', state: 'off' }]);
    expect(code(await req('POST', '/v1/prices/list/p-ghee/entries/app-1', entry('channel', 'app', 9_000)))).toBe('channel_pricing_switched_off');
    await ok(req('POST', '/v1/prices/zones/Z-CBE/stores/S-A', {}), 'zone register');
    expect((await req('POST', '/v1/prices/zones/Z-X/stores/S-A', {}, 'u-mgr')).status).toBe(403);
    expect(code(await req('POST', '/v1/prices/list/p-ghee/entries/zone-1', entry('zone', 'Z-CBE', 9_500)))).toBe('channel_pricing_switched_off');
    for (const channel of ['app', 'delivery', 'store']) expect(await resolve({ channel })).toBe(10_000);
    expect(await report()).toMatchObject({ differences: [], samePriceEverywhere: true });

    // ── switching ON needs a second person ──────────────────────────────────────────────────────────────────────
    expect((await req('POST', '/v1/prices/channel-pricing/requests/rq-x', { subject: 'channel:app', to: 'on', reason: 'x' }, 'u-till')).status).toBe(403);
    const asked = await ok(req('POST', '/v1/prices/channel-pricing/requests/rq-1', { subject: 'channel:app', to: 'on', reason: 'app launch offer' }, 'u-mgr'), 'ask');
    expect(asked.status).toBe(202);
    expect(code(await req('POST', '/v1/prices/list/p-ghee/entries/app-1', entry('channel', 'app', 9_000)))).toBe('channel_pricing_switched_off'); // still off: asked is not approved
    expect((await req('POST', '/v1/prices/channel-pricing/requests/rq-1/approve', { reason: 'ok' }, 'u-mgr')).status).toBe(403); // the asker cannot approve (no authority, and not a second person)
    await ok(req('POST', '/v1/prices/channel-pricing/requests/rq-own', { subject: 'channel:delivery', to: 'on', reason: 'delivery' }), 'owner asks');
    expect(code(await req('POST', '/v1/prices/channel-pricing/requests/rq-own/approve', { reason: 'mine' }))).toBe('self_approval');

    h = restart(h); // ── COLD RESTART ──────────────────────────────────────────────────────────────────────────

    expect(((await req('GET', '/v1/prices/channel-pricing')).body as { switches: { subject: string; state: string }[] }).switches.every((s) => s.state === 'off')).toBe(true);
    await ok(req('POST', '/v1/prices/channel-pricing/requests/rq-1/approve', { reason: 'checked the offer' }), 'second person approves');
    expect(((await req('GET', '/v1/prices/channel-pricing')).body as { switches: { subject: string; state: string }[] }).switches.find((s) => s.subject === 'channel:app')!.state).toBe('on');
    // MRP is still the ceiling at every scope.
    expect(code(await req('POST', '/v1/prices/list/p-ghee/entries/app-hi', entry('channel', 'app', 13_000)))).toBe('price_above_mrp');
    await ok(req('POST', '/v1/prices/list/p-ghee/entries/app-1', entry('channel', 'app', 9_000)), 'app price');
    expect(await resolve({ channel: 'app' })).toBe(9_000);
    expect(await resolve({ channel: 'delivery' })).toBe(10_000); // delivery's switch is still off
    expect(await resolve({})).toBe(10_000); // the till: the shelf price
    const diff = await report();
    expect(diff.samePriceEverywhere).toBe(false);
    expect(diff.differences).toEqual([{ productId: 'p-ghee', channel: 'app', shelfPriceMinor: 10_000, channelPriceMinor: 9_000, entryId: 'app-1' }]);

    // ── switching OFF is immediate and restores one price; the entry stays on file, listed as dormant ───────────
    await ok(req('POST', '/v1/prices/channel-pricing/requests/rq-2', { subject: 'channel:app', to: 'off', reason: 'offer over' }, 'u-mgr'), 'off');
    expect(await resolve({ channel: 'app' })).toBe(10_000);
    const after = await report();
    expect(after.differences).toEqual([]);
    expect(after.dormantEntries).toEqual([expect.objectContaining({ entryId: 'app-1', switch: 'channel:app' })]);
    expect(((await req('GET', '/v1/prices/list/p-ghee/history')).body as { entries: { id: string }[] }).entries.map((e) => e.id)).toContain('app-1'); // append-only
  }, 60_000);
});
