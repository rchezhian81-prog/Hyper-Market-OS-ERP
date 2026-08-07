import { describe, it, expect } from 'vitest';
import { ConfigStore } from '../../packages/config/src/index';

// Config is versioned and rollback is non-destructive (M01-FR-03): rollback
// creates a NEW version restoring a prior value; the history is never edited.

const AT = '2026-08-02T10:00:00Z';

describe('ConfigStore', () => {
  it('records each change as the next immutable version', () => {
    const store = new ConfigStore<number>();
    const v1 = store.set('pos.max_discount_pct', 10, 'owner', 'initial', AT);
    const v2 = store.set('pos.max_discount_pct', 15, 'owner', 'festival', AT);
    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
    expect(store.current('pos.max_discount_pct')?.value).toBe(15);
    expect(Object.isFrozen(v2)).toBe(true);
    expect(store.history('pos.max_discount_pct')).toHaveLength(2);
  });

  it('rolls back by creating a new version that restores a prior value', () => {
    const store = new ConfigStore<number>();
    store.set('flag', 10, 'a', 'v1', AT);
    store.set('flag', 15, 'a', 'v2', AT);
    const v3 = store.rollback('flag', 1, 'owner', 'revert festival price', AT);
    expect(v3.version).toBe(3);
    expect(v3.value).toBe(10); // restored v1's value
    expect(v3.rolledBackFrom).toBe(1);
    expect(store.current('flag')?.value).toBe(10);
    // history preserved — nothing deleted or edited
    expect(store.history('flag').map((v) => v.version)).toEqual([1, 2, 3]);
  });

  it('reads and writes do not expose the internal history array', () => {
    const store = new ConfigStore<number>();
    store.set('k', 1, 'a', 'r', AT);
    expect(store.history('k')).not.toBe(store.history('k'));
  });

  it('validates inputs', () => {
    const store = new ConfigStore<number>();
    expect(() => store.set('', 1, 'a', 'r', AT)).toThrow(RangeError);
    expect(() => store.set('k', 1, 'a', '', AT)).toThrow(RangeError);
    expect(() => store.set('k', 1, 'a', 'r', 'not-a-date')).toThrow(RangeError);
    expect(() => store.rollback('missing', 1, 'a', 'r', AT)).toThrow(RangeError);
  });

  it('rejects rollback to an unknown version', () => {
    const store = new ConfigStore<number>();
    store.set('k', 1, 'a', 'r', AT);
    expect(() => store.rollback('k', 9, 'a', 'r', AT)).toThrow(RangeError);
  });
});
