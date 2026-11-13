import { describe, it, expect } from 'vitest';
import { pagedQuery, pagedAnswer } from '../../apps/web-erp/src/register-paging';
import { createRequisitionsSession } from '../../apps/web-erp/src/requisitions-session';

// U7 (OB-726) · the long lists are paged by head office. The chrome's register hands a loader
// `{ page (0-based), size, search, sort (column key | null), dir }`; head office reads `?page=` from 1, `size`, `search`,
// `sort` (its own field name) and `dir`, and answers one page with `paging.total`. These helpers translate both ways.

describe('the register asks head office for one page', () => {
  it('turns the register\'s ask into head office\'s query — page from 1, the column\'s own field, no sort it cannot do', () => {
    const keys = { id: 'requisitionId', lines: 'lines' };
    expect(pagedQuery({ page: 0, size: 10, search: '', sort: null, dir: 'asc' }, keys)).toBe('page=1&size=10');
    expect(pagedQuery({ page: 2, size: 10, search: ' rice ', sort: 'id', dir: 'desc' }, keys)).toBe('page=3&size=10&search=rice&sort=requisitionId&dir=desc');
    // A column head office cannot sort by is not sent at all (its own order stands), never guessed.
    expect(pagedQuery({ page: 0, size: 10, search: '', sort: 'by', dir: 'asc' }, keys)).toBe('page=1&size=10');
  });

  it('reads one page and the total from head office\'s answer, or nothing when the answer is not a page', () => {
    expect(pagedAnswer({ requisitions: [{ a: 1 }], paging: { total: 31 } }, 'requisitions')).toEqual({ rows: [{ a: 1 }], total: 31 });
    expect(pagedAnswer({ requisitions: [{ a: 1 }] }, 'requisitions')).toBeUndefined();
    expect(pagedAnswer(null, 'requisitions')).toBeUndefined();
  });

  it('the Requisitions session reads one page of the worklist, and says why when it cannot', async () => {
    const asked: string[] = [];
    const fetch = (async (path: string) => {
      asked.push(path);
      return new Response(JSON.stringify({ requisitions: [{ requisitionId: 'r3', lines: [] }], count: 3, paging: { page: 2, size: 2, total: 3, pages: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof globalThis.fetch;
    const s = createRequisitionsSession({ viewer: { userId: 'u-read', permissions: ['purchase.commitment.read'] }, fetch });
    const out = await s.page({ page: 1, size: 2, search: '', sort: 'id', dir: 'asc' });
    expect(asked).toEqual(['/v1/purchase/requisitions?page=2&size=2&sort=requisitionId&dir=asc']);
    expect(out).toEqual({ result: 'ok', value: { rows: [{ requisitionId: 'r3', lines: [] }], total: 3 } });
    const nobody = createRequisitionsSession({ viewer: undefined, fetch });
    expect(await nobody.page({ page: 0, size: 10, search: '', sort: null, dir: 'asc' })).toEqual({ result: 'invalid', why: 'nobody' });
  });
});
