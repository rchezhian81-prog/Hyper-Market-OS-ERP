import { describe, it, expect } from 'vitest';
import { createReplenishmentSession, heldReorderSettingsOf, REPLENISHMENT_COPY } from '../../apps/web-erp/src/replenishment-session';

/** OB-630: the store computer's copy of the reorder settings is shown only when head office cannot be reached, as a copy. */

const V1 = { storeId: 'store-1', productId: 'RICE', version: 1, maxLevel: 50_000, reason: 'r', setBy: 'u', setAt: 't' };
const held = { storeId: 'store-1', products: [{ current: V1, history: [V1] }], receivedAt: '2026-11-01T02:00:00.000Z' };
const viewer = { userId: 'u-b', permissions: ['inventory.availability.read'] };
const answering = (answer: () => Response | Promise<Response>) => (async () => answer()) as unknown as typeof globalThis.fetch;

describe('OB-630 — the reorder copy', () => {
  it('every word has a Tamil twin', () => { expect(Object.keys(REPLENISHMENT_COPY.ta).sort()).toEqual(Object.keys(REPLENISHMENT_COPY.en).sort()); });
  it('is read from the buying payload only when whole', () => {
    expect(heldReorderSettingsOf({ reorderSettings: { storeId: 'store-1', products: [] }, reorderSettingsReceivedAt: 't' })).toEqual({ storeId: 'store-1', products: [], receivedAt: 't' });
    expect(heldReorderSettingsOf({ reorderSettings: { storeId: 'store-1', products: [] } })).toBeUndefined();
    expect(heldReorderSettingsOf(null)).toBeUndefined();
  });
  it('head office unreachable: the copy, with when it was received; another store: no copy', async () => {
    const down = answering(() => { throw new TypeError('network'); });
    const s = createReplenishmentSession({ viewer, held, fetch: down });
    expect(await s.parameters('store-1')).toEqual({ result: 'ok', value: { storeId: 'store-1', products: held.products, copyFrom: held.receivedAt } });
    expect(await s.parameters('store-2')).toEqual({ result: 'lost_link' });
  });
  it('head office answers or refuses: never the copy', async () => {
    const up = createReplenishmentSession({ viewer, held, fetch: answering(() => ({ ok: true, status: 200, json: async () => ({ storeId: 'store-1', products: [] }) }) as unknown as Response) });
    expect(await up.parameters('store-1')).toEqual({ result: 'ok', value: { storeId: 'store-1', products: [] } });
    const no = createReplenishmentSession({ viewer, held, fetch: answering(() => ({ ok: false, status: 403, json: async () => ({ error: { code: 'forbidden', whatHappened: 'no' } }) }) as unknown as Response) });
    expect((await no.parameters('store-1')).result).toBe('refused');
  });
});
