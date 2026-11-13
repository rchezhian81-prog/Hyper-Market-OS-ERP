import { describe, it, expect } from 'vitest';
import { pageOf, PAGE_LIMITS } from '../../services/kernel/src/paging';

/**
 * U7 (OB-725) · G17 "registers with search, sort and paging": a list that can grow to thousands of rows (the audit trail,
 * import history, price history, requisitions, ESL pushes) is paged by HEAD OFFICE when the page asks for a page — the
 * search, the sort and the page come from the query, and the answer says the total it searched, so the register can say
 * "Showing 21–40 of 312". Without `?page=` a route answers as it always did (every older caller keeps working).
 */
const rows = Array.from({ length: 45 }, (_, i) => ({ id: `r${String(i + 1).padStart(2, '0')}`, who: i % 3 === 0 ? 'Ravi' : 'Meena', amount: (i * 7) % 50 }));
const opts = { search: ['id', 'who'] as const, sort: ['id', 'who', 'amount'] as const };

describe('U7 · head office pages a long list', () => {
  it('without ?page= it does not page (the old answer)', () => {
    expect(pageOf(rows, {}, opts)).toBeUndefined();
  });

  it('pages, searches across the named fields and sorts by an allowed key, saying the total it searched', () => {
    const p1 = pageOf(rows, { page: '1', size: '20' }, opts)!;
    expect(p1.ok).toBe(true);
    if (!p1.ok) return;
    expect(p1.rows).toHaveLength(20);
    expect(p1.paging).toMatchObject({ page: 1, size: 20, total: 45, pages: 3 });
    const p3 = pageOf(rows, { page: '3', size: '20' }, opts)!;
    expect(p3.ok && p3.rows.length).toBe(5);
    const ravi = pageOf(rows, { page: '1', size: '50', search: 'RAVI' }, opts)!;
    expect(ravi.ok && ravi.paging.total).toBe(15);
    const byAmount = pageOf(rows, { page: '1', size: '3', sort: 'amount', dir: 'desc' }, opts)!;
    expect(byAmount.ok && byAmount.rows.map((r) => r.amount)).toEqual([49, 48, 47]);
    const past = pageOf(rows, { page: '9', size: '20' }, opts)!;
    expect(past.ok && past.rows).toEqual([]);
  });

  it('refuses a page it cannot read, by name, never guessing', () => {
    for (const q of [{ page: '0' }, { page: 'x' }, { page: '1', size: String(PAGE_LIMITS.maxSize + 1) }, { page: '1', sort: 'secret' }, { page: '1', dir: 'up' }]) {
      const r = pageOf(rows, q, opts)!;
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.detail).toMatch(/page|size|sort|dir/);
    }
  });
});
