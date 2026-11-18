import { describe, it, expect } from 'vitest';
import { isFirstLabel, relabelTaskRoutes, type RelabelTask, type RelabelTaskDeps } from '../../services/pricing/src/relabel-tasks';
import { relabelWords } from '../../apps/web-erp/src/relabel-session';

// D-026 (owner, 18 Nov 2026, under OB-801): the first price load must not make every shelf-label task "due now" at once.
// A price-list entry that is the item's FIRST price in this system at the store is a "first label": part of ONE "first
// price load" batch with its count, never "due now" on its own. A manager's "Change price", and any later price, is due as
// before. Nothing is deleted or rewritten; the tasks stay open until a person closes them.

const NOW = '2026-11-18T06:00:00.000Z';
const task = (productId: string, priceMinor: number, raisedAt: string, because: RelabelTask['because'] = 'price_list_entry'): RelabelTask => ({
  taskId: `relabel-br-1-${productId}-not-on-plan-${priceMinor}-${raisedAt.slice(0, 10)}`, branchId: 'br-1', productId, locationId: null, priceMinor,
  dueAt: '2026-11-17T18:30:00.000Z', because, sourceRef: `x:${productId}`, raisedAt,
});

function routes(tasks: RelabelTask[]) {
  const deps: RelabelTaskDeps = {
    tasks: () => Promise.resolve(tasks), done: () => Promise.resolve([]), recordTask: () => Promise.resolve(), recordDone: () => Promise.resolve(),
    shelfPlaces: () => Promise.resolve([]), recordObservationAs: () => Promise.resolve({ status: 201, body: {} }), now: () => NOW,
  };
  const list = relabelTaskRoutes(deps).find((r) => r.method === 'GET' && r.path === '/v1/pricing/relabel-tasks')!;
  return () => list.handler({ tenantId: 't', userId: 'u-mgr', query: {}, params: {}, scope: 'all', permissions: [] } as unknown as Parameters<typeof list.handler>[0]);
}

describe('D-026 — the first price load is one batch, not a flood of "due now"', () => {
  it('a first price-list entry per item is a first label; a later price, or a manager\'s Change price, is not', () => {
    const load = ['soap', 'salt', 'dal'].map((p) => task(p, 3_000, '2026-11-17T10:00:00.000Z'));
    const later = task('soap', 3_500, '2026-11-18T05:00:00.000Z');
    const change = task('rice', 6_000, '2026-11-18T05:00:00.000Z', 'price_change');
    const all = [...load, later, change];
    expect(load.every((t) => isFirstLabel(t, all))).toBe(true);
    expect(isFirstLabel(later, all)).toBe(false);
    expect(isFirstLabel(change, all)).toBe(false);
  });

  it('the list counts the first load as ONE batch; none of it is "due now"; a later price is due as before', async () => {
    const load = Array.from({ length: 9 }, (_, i) => task(`p${i}`, 1_000 + i, '2026-11-17T10:00:00.000Z'));
    const later = task('p0', 1_500, '2026-11-18T05:00:00.000Z');
    const body = (await routes([...load, later])()).body as { tasks: { taskId: string; firstLabel: boolean; dueNow: boolean }[]; open: number; firstLoad: { open: number }; dueNow: number };
    expect(body.firstLoad).toEqual({ open: 8 }); // p0's first label is replaced by its later price
    expect(body.dueNow).toBe(1);
    expect(body.tasks.find((r) => r.taskId === later.taskId)).toMatchObject({ firstLabel: false, dueNow: true });
    expect(body.tasks.filter((r) => r.firstLabel).every((r) => !r.dueNow)).toBe(true);
    expect(body.tasks).toHaveLength(10); // nothing deleted
    expect(body.open).toBe(9); // still open until a person checks them
  });

  it('the page has the words for the batch, in English and Tamil', () => {
    for (const k of ['firstLoadH', 'firstLoadCount', 'firstLoadLead', 'firstLabel', 'firstLoadShow']) {
      expect(relabelWords('en', k)).not.toBe(k);
      expect(relabelWords('ta', k)).not.toBe(relabelWords('en', k));
    }
  });
});
