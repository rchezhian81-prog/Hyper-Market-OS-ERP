// U7 (OB-726) · the long lists are paged by head office. The chrome's register (window.sreOffice.table with a `loader`)
// asks for one page as `{ page (0-based), size, search, sort (the column's key, or null), dir }` and shows `{ rows, total }`
// exactly as given. Head office reads `?page=` from 1, `size` (up to 200), `search`, `sort` (its own field name) and `dir`,
// and answers one page with `paging.total` beside it (services/kernel/src/paging.ts). These two helpers translate.

export interface RegisterAsk {
  readonly page: number;
  readonly size: number;
  readonly search: string;
  readonly sort: string | null;
  readonly dir: 'asc' | 'desc';
}

/**
 * Head office's query for one page. `sortKeys` maps a register column key to head office's field; a column head office
 * cannot sort by is left out, so head office's own order stands — never a sort the browser pretends to have done.
 */
export function pagedQuery(ask: RegisterAsk, sortKeys: Readonly<Record<string, string>>): string {
  const q = new URLSearchParams({ page: String(Math.max(0, Math.trunc(ask.page)) + 1), size: String(ask.size) });
  const search = ask.search.trim();
  if (search !== '') q.set('search', search);
  const field = ask.sort === null ? undefined : sortKeys[ask.sort];
  if (field !== undefined) { q.set('sort', field); q.set('dir', ask.dir); }
  return q.toString();
}

/** One page and the total from head office's answer; undefined when the answer is not a page (an older head office). */
export function pagedAnswer(body: unknown, rowsKey: string): { readonly rows: readonly unknown[]; readonly total: number } | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const b = body as Record<string, unknown>;
  const rows = b[rowsKey];
  const paging = b['paging'];
  if (!Array.isArray(rows) || paging === null || typeof paging !== 'object') return undefined;
  const total = (paging as Record<string, unknown>)['total'];
  return typeof total === 'number' && Number.isInteger(total) && total >= 0 ? { rows, total } : undefined;
}
