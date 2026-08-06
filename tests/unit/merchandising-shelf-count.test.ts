import { describe, it, expect } from 'vitest';
import {
  countingWorklist, latestCounts, recordShelfCount, SHELF_COUNT_REFUSALS,
  type ShelfCount,
} from '../../packages/merchandising/src/index';
import * as merchandising from '../../packages/merchandising/src/shelf-count';

/**
 * **The producer that never existed (M04-FR-03).**
 *
 * `planogramCompliance` was written and tested the day the module was created, and it needs one
 * thing nothing in this system has ever produced: how many of an item are on the shelf right now.
 * Its `?? 0` then turned every uncounted facing into an empty one — the loudest alarm it has,
 * fired on every product in the shop, sending staff to full shelves on day one.
 *
 * The counting itself is blind, like every other count in this product, and a shelf quantity is
 * treated as an **observation with a time** rather than a fact.
 */

const NOW = '2026-08-06T10:00:00.000Z';
const SHELVES = ['L-A1', 'L-B3'];

const input = (over: Partial<Parameters<typeof recordShelfCount>[0]> = {}) => ({
  storeId: 'store-1', locationId: 'L-A1', productId: 'rice',
  countedMinor: 12, countedBy: 'u-merch', at: NOW, knownLocationIds: SHELVES,
  ...over,
});

describe('a shelf count is counted blind', () => {
  it('takes the figure and nothing else — there is no expected quantity to accept', () => {
    // Absence as a control. The function's own input has no field for what the facing should hold,
    // so a view cannot render one early even by accident.
    const keys = Object.keys(input());
    expect(keys.filter((k) => /expect|should|target|planned|capacity/i.test(k))).toEqual([]);
  });

  it('exports no function that returns what a shelf is supposed to hold', () => {
    // What the facing should hold is the planogram's business, applied AFTER the count.
    const exported = Object.keys(merchandising);
    expect(exported.filter((k) => /expected|capacityFor|shouldHold/i.test(k))).toEqual([]);
  });

  it('records what somebody counted, with their name and the time', () => {
    const outcome = recordShelfCount(input());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.count).toEqual({
      storeId: 'store-1', locationId: 'L-A1', productId: 'rice',
      countedMinor: 12, countedBy: 'u-merch', at: NOW,
    });
  });
});

describe('what a count refuses, and why', () => {
  it('refuses a negative count — a shelf cannot hold less than nothing', () => {
    const outcome = recordShelfCount(input({ countedMinor: -1 }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('a_negative_count_is_not_a_count');
  });

  it('refuses a fraction — half a tin on a shelf is a damaged tin, a different job', () => {
    const outcome = recordShelfCount(input({ countedMinor: 2.5 }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('a_count_needs_a_whole_number');
  });

  it('refuses an unsigned count — it will be asked about later', () => {
    const outcome = recordShelfCount(input({ countedBy: '   ' }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('nobody_signed_this_count');
  });

  it('refuses a shelf this shop does not have, so a typo is not a phantom facing', () => {
    const outcome = recordShelfCount(input({ locationId: 'L-TYPO' }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('this_shop_has_no_such_shelf');
    expect(outcome.detail).toContain('L-TYPO');
  });

  it('accepts ZERO — an empty facing is a real and important answer', () => {
    expect(recordShelfCount(input({ countedMinor: 0 })).ok).toBe(true);
  });

  it('gives every refusal a sentence somebody can act on', () => {
    expect(SHELF_COUNT_REFUSALS).toHaveLength(4);
    const seen = new Set<string>();
    for (const bad of [
      input({ countedMinor: -1 }), input({ countedMinor: 2.5 }),
      input({ countedBy: '' }), input({ locationId: 'L-TYPO' }),
    ]) {
      const outcome = recordShelfCount(bad);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) continue;
      seen.add(outcome.refusal);
      expect(outcome.detail.length, `${outcome.refusal} says too little to help`).toBeGreaterThan(30);
    }
    expect([...seen].sort()).toEqual([...SHELF_COUNT_REFUSALS].sort());
  });
});

describe('counts are append-only, and the newest one wins', () => {
  const counts: ShelfCount[] = [
    { storeId: 'store-1', locationId: 'L-A1', productId: 'rice', countedMinor: 20, countedBy: 'a', at: '2026-08-06T09:00:00.000Z' },
    { storeId: 'store-1', locationId: 'L-A1', productId: 'rice', countedMinor: 4, countedBy: 'b', at: '2026-08-06T09:50:00.000Z' },
    { storeId: 'store-1', locationId: 'L-B3', productId: 'oil', countedMinor: 9, countedBy: 'a', at: '2026-08-05T09:00:00.000Z' },
  ];

  it('reads the latest observation per facing without discarding the earlier one', () => {
    // "We counted it at nine and again at two" is the record that explains a variance. Overwriting
    // the nine o'clock reading destroys the only evidence of what changed in between.
    const { latest } = latestCounts(counts, NOW, 120);
    expect(latest.find((c) => c.productId === 'rice')?.countedMinor).toBe(4);
    expect(counts, 'the input was mutated').toHaveLength(3);
  });

  it('says how long ago each facing was looked at', () => {
    const { ages } = latestCounts(counts, NOW, 120);
    expect(ages.find((a) => a.productId === 'rice')?.minutesAgo).toBe(10);
    expect(ages.find((a) => a.productId === 'rice')?.stale).toBe(false);
    expect(ages.find((a) => a.productId === 'oil')?.stale).toBe(true);
  });

  it('is idempotent on a replayed batch', () => {
    const once = latestCounts(counts, NOW, 120).latest;
    const twice = latestCounts([...counts, ...counts], NOW, 120).latest;
    expect(twice).toEqual(once);
  });

  it('treats an unreadable time as stale, which is the safe direction', () => {
    // The worst outcome is somebody being asked to count it again.
    const { ages } = latestCounts(
      [{ storeId: 'store-1', locationId: 'L-A1', productId: 'rice', countedMinor: 1, countedBy: 'a', at: 'nonsense' }],
      NOW, 120,
    );
    expect(ages[0]?.stale).toBe(true);
    expect(ages[0]?.minutesAgo).toBeNull();
  });
});

describe('the counting worklist puts never-counted first', () => {
  it('lists a facing nobody has ever counted before one counted a long time ago', () => {
    // A never-counted facing is one the compliance report can say NOTHING about, and a report that
    // covers most of the shop is one people trust for the whole shop.
    const list = countingWorklist({
      planned: [
        { productId: 'rice', locationId: 'L-A1' },
        { productId: 'oil', locationId: 'L-B3' },
      ],
      counts: [
        { storeId: 'store-1', locationId: 'L-B3', productId: 'oil', countedMinor: 9, countedBy: 'a', at: '2026-08-01T09:00:00.000Z' },
      ],
      asOf: NOW,
      staleAfterMinutes: 120,
    });
    expect(list.map((r) => r.productId)).toEqual(['rice', 'oil']);
    expect(list[0]?.lastCountedAt).toBeNull();
    expect(list[1]?.minutesAgo).toBeGreaterThan(120);
  });

  it('leaves a freshly counted facing off the list entirely', () => {
    const list = countingWorklist({
      planned: [{ productId: 'rice', locationId: 'L-A1' }],
      counts: [
        { storeId: 'store-1', locationId: 'L-A1', productId: 'rice', countedMinor: 9, countedBy: 'a', at: '2026-08-06T09:55:00.000Z' },
      ],
      asOf: NOW,
      staleAfterMinutes: 120,
    });
    expect(list).toEqual([]);
  });
});
