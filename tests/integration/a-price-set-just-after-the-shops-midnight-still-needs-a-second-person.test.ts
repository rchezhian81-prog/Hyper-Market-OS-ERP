import { describe, it, expect, afterAll, vi } from 'vitest';
import { apiHarness } from '../support/api-harness';
import { pinTheEveningClock } from '../support/evening-clock';

/**
 * **A price set "from now" just after the shop's midnight is judged on the SHOP's day (M05-FR-01 · OB-291 · M01-FR-02 · §28).**
 *
 * The clock is pinned to an evening UTC moment (tests/support/evening-clock.ts): 01:00 the next morning in the shop, when the
 * UTC date is still the shop's yesterday. Head office's price-change gate read an entry's day from the first ten characters
 * of its instant — the UTC date — so between 00:00 and 05:30 in the shop a price "from now" looked back-dated, the gate
 * stepped aside, and a manager could double a price on their own with no second person (OB-291). And the price basis read
 * "another day" up to 23:59 UTC (05:29 the next shop morning), so a price that started at 01:00 counted as the shop's
 * yesterday's price. Both now go by the shop's calendar. Synthetic data; the real API in memory.
 */

const evening = pinTheEveningClock();
afterAll(() => { vi.useRealTimers(); });

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

describe('a price set just after the shop\'s midnight (OB-291, on the shop\'s day)', () => {
  it('a big move from now still needs a second person, and the basis of the shop\'s yesterday ends at the shop\'s midnight', async () => {
    expect(evening.shopDate > evening.utcDate).toBe(true); // the window this proves: the shop is already on the next day

    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-mgr', 'store_manager'); // sets prices (propose), does NOT hold approve
    const setBy = (entryId: string, body: Record<string, unknown>) =>
      h.request({ method: 'POST', path: `/v1/prices/list/PX/entries/${entryId}`, userId: 'u-mgr', tenantId: A, idempotencyKey: `pe-${entryId}`, body });
    const basis = (query: Record<string, string>) =>
      h.request({ method: 'GET', path: '/v1/prices/list/PX/basis', userId: 'u-mgr', tenantId: A, query: { scope: 'store', scopeRef: 'store-1', ...query } });
    const base = { scope: 'store', scopeRef: 'store-1', mrpMinor: 20_000, costMinor: 5_000, marginFloorBps: 2_000, currency: 'INR' };

    // A healthy first price from this moment (01:00 in the shop) needs nobody else.
    const first = await setBy('e-first', { ...base, priceMinor: 10_000, effectiveFrom: new Date().toISOString() });
    expect(first.status, JSON.stringify(first.body)).toBe(201);

    // Nearly doubling it from a moment later is more than one person may do: refused by name, nothing recorded.
    const doubled = await setBy('e-doubled', { ...base, priceMinor: 19_000, effectiveFrom: new Date(Date.now() + 1_000).toISOString() });
    expect(codeOf(doubled)).toBe('price_change_needs_second_person');
    expect(JSON.stringify(doubled.body)).toContain(`from ${evening.shopDate}`); // said on the shop's date
    const history = (await h.request({ method: 'GET', path: '/v1/prices/list/PX/history', userId: 'u-owner', tenantId: A })).body as { entries: { entryId?: string; id?: string }[] };
    expect(history.entries).toHaveLength(1);

    // The basis of the shop's today is the price running now; of the shop's yesterday, the price at ITS end (the shop's
    // midnight) — before the first price began at 01:00, so none.
    expect((await basis({})).body).toMatchObject({ on: evening.shopDate, currentPriceMinor: 10_000 });
    expect((await basis({ on: evening.utcDate })).body).toMatchObject({ on: evening.utcDate, currentPriceMinor: null });
  });
});
