import { describe, it, expect } from 'vitest';
import { InMemoryNumberSeriesStore } from '../../packages/persistence/src/number-series-store';

// The gap-free number-series contract (M01-FR-02). InMemoryNumberSeriesStore is the behavioural
// reference; SqlNumberSeriesStore is proven against a real database (incl. concurrency) separately.

describe('InMemoryNumberSeriesStore (the gap-free series contract)', () => {
  it('allocates a gap-free sequence starting at 1', async () => {
    const s = new InMemoryNumberSeriesStore();
    expect(await s.allocate('t', 'receipt')).toBe(1);
    expect(await s.allocate('t', 'receipt')).toBe(2);
    expect(await s.allocate('t', 'receipt')).toBe(3);
  });

  it('peeks the next number without taking it', async () => {
    const s = new InMemoryNumberSeriesStore();
    expect(await s.peek('t', 'invoice')).toBe(1);
    await s.allocate('t', 'invoice');
    expect(await s.peek('t', 'invoice')).toBe(2);
  });

  it('keeps each series independent per (tenant, doc_type)', async () => {
    const s = new InMemoryNumberSeriesStore();
    await s.allocate('a', 'receipt');
    await s.allocate('a', 'receipt');
    await s.allocate('a', 'invoice');
    expect(await s.peek('a', 'receipt')).toBe(3);
    expect(await s.peek('a', 'invoice')).toBe(2);
    expect(await s.peek('b', 'receipt')).toBe(1); // another tenant is untouched
  });
});
