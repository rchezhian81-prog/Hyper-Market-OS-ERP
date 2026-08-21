import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// M04-FR-02/03 shelf counting on the live API — the producer planogram compliance always needed. A count
// is a blind observation (the counter is the authenticated user, no expected quantity is accepted or
// returned), append-only, and the reads report how stale each facing is and which need counting worst
// first (never-counted before long-ago). Recording gated shelf.count.record; reads shelf.count.read.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const STORE = 'BR1';
const KNOWN = ['loc1', 'loc2'];

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

const record = (h: ApiHarness, u: string, countId: string, body: Record<string, unknown>, key: string) =>
  h.request({ method: 'POST', path: `/v1/merchandising/shelf-counts/${countId}`, userId: u, tenantId: A, idempotencyKey: key, body });
const latest = (h: ApiHarness, u: string) =>
  h.request({ method: 'GET', path: '/v1/merchandising/shelf-counts', userId: u, tenantId: A, query: { storeId: STORE } });
const worklist = (h: ApiHarness, u: string, planned: unknown[], key: string) =>
  h.request({ method: 'POST', path: '/v1/merchandising/shelf-counts/worklist', userId: u, tenantId: A, idempotencyKey: key, body: { storeId: STORE, planned } });

const cnt = (over: Record<string, unknown> = {}) =>
  ({ storeId: STORE, locationId: 'loc1', productId: 'p1', countedMinor: 5, knownLocationIds: KNOWN, ...over });

type Latest = { latest: { productId: string; locationId: string; countedMinor: number; countedBy: string }[]; ages: { productId: string; stale: boolean }[] };

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // shelf.count.record + read
  await h.provisionRole(A, 'u-cash', 'cashier');       // neither
  return h;
}

describe('shelf counting: blind, append-only, staleness-aware (M04-FR-02/03)', () => {
  it('records a blind count signed by the user, and reads it back fresh with no expected quantity', async () => {
    const h = await cast();
    const res = await record(h, 'u-mgr', 'c1', cnt({ countedMinor: 7 }), 'k1');
    expect(res.status).toBe(201);
    // The count carries the counter (from login) and NOT any expected quantity.
    const count = (res.body as { count: Record<string, unknown> }).count;
    expect(count).toMatchObject({ productId: 'p1', locationId: 'loc1', countedMinor: 7, countedBy: 'u-mgr' });
    expect(Object.keys(count)).not.toContain('expectedMinor');

    const l = (await latest(h, 'u-owner')).body as Latest;
    expect(l.latest.find((c) => c.productId === 'p1')?.countedMinor).toBe(7);
    expect(l.ages.find((a) => a.productId === 'p1')?.stale).toBe(false); // just counted → fresh
  });

  it('refuses a negative count and a count against a shelf the shop does not have', async () => {
    const h = await cast();
    expect(codeOf(await record(h, 'u-mgr', 'c1', cnt({ countedMinor: -3 }), 'k1'))).toBe('a_negative_count_is_not_a_count');
    expect(codeOf(await record(h, 'u-mgr', 'c2', cnt({ locationId: 'ghost' }), 'k2'))).toBe('this_shop_has_no_such_shelf');
    // A missing count or store is not readable at all.
    expect(codeOf(await record(h, 'u-mgr', 'c3', { storeId: STORE, locationId: 'loc1', productId: 'p1', knownLocationIds: KNOWN }, 'k3'))).toBe('not_readable_as_a_shelf_count');
  });

  it('the worklist puts a never-counted facing first and leaves a freshly-counted one off', async () => {
    const h = await cast();
    await record(h, 'u-mgr', 'c1', cnt({ productId: 'p1', locationId: 'loc1', countedMinor: 4 }), 'k1');
    // Two facings are planned; only (p1,loc1) has been counted (and it is fresh).
    const wl = (await worklist(h, 'u-owner', [
      { productId: 'p1', locationId: 'loc1' },
      { productId: 'p2', locationId: 'loc2' },
    ], 'k2')).body as { worklist: { productId: string; lastCountedAt: string | null; stale: boolean }[]; count: number };
    // Only the never-counted facing needs work; the fresh one is not on the list.
    expect(wl.worklist.map((w) => w.productId)).toEqual(['p2']);
    expect(wl.worklist[0]).toMatchObject({ lastCountedAt: null, stale: true });
  });

  it('gates recording and reading, and survives a restart (counts rebuild from the event store)', async () => {
    const h = await cast();
    // A cashier can neither record nor read shelf counts.
    expect((await record(h, 'u-cash', 'c1', cnt(), 'k1')).status).toBe(403);
    expect((await latest(h, 'u-cash')).status).toBe(403);
    await record(h, 'u-mgr', 'c1', cnt({ countedMinor: 9 }), 'k2');

    const restarted = apiHarness({ store: h.store });
    const l = (await latest(restarted, 'u-owner')).body as Latest;
    expect(l.latest.find((c) => c.productId === 'p1')?.countedMinor).toBe(9);
  });
});
