// U7 (OB-725) · G17 "registers with search, sort and paging": a long list paged by HEAD OFFICE when the page asks for a
// page. The search runs across the fields the route names, the sort is one of the keys the route allows, the page is
// 1-based, and the answer says the total it searched so a register can say "Showing 21–40 of 312". A route calls this
// only when `?page=` is present: without it the route answers as it always did, so every older caller keeps working.
// Pure — no clock, no I/O.

import { apiError } from './errors';

export const PAGE_LIMITS = Object.freeze({ defaultSize: 20, maxSize: 200 });

export interface PagingOptions<K extends string> {
  /** The fields a search looks in (case-insensitive, any field containing the words). */
  readonly search: readonly K[];
  /** The keys a page may sort by. */
  readonly sort: readonly K[];
}

export interface Paging {
  readonly page: number;
  readonly size: number;
  readonly total: number;
  readonly pages: number;
  readonly search: string | null;
  readonly sort: string | null;
  readonly dir: 'asc' | 'desc';
}

export type PageResult<T> =
  | { readonly ok: true; readonly rows: readonly T[]; readonly paging: Paging }
  | { readonly ok: false; readonly detail: string };

const WHOLE = /^[0-9]+$/;

/** Page `rows` as the query asks, or `undefined` when the query asks for no page (the route answers as before). */
export function pageOf<T extends Record<string, unknown>, K extends string>(rows: readonly T[], query: Readonly<Record<string, string | undefined>>, opts: PagingOptions<K>): PageResult<T> | undefined {
  if (query['page'] === undefined) return undefined;
  const rawPage = query['page'] ?? '';
  const rawSize = query['size'] ?? String(PAGE_LIMITS.defaultSize);
  if (!WHOLE.test(rawPage) || Number(rawPage) < 1) return { ok: false, detail: 'page must be a whole number from 1' };
  if (!WHOLE.test(rawSize) || Number(rawSize) < 1 || Number(rawSize) > PAGE_LIMITS.maxSize) return { ok: false, detail: `size must be a whole number from 1 to ${PAGE_LIMITS.maxSize}` };
  const sort = query['sort'];
  if (sort !== undefined && sort !== '' && !(opts.sort as readonly string[]).includes(sort)) return { ok: false, detail: `sort must be one of ${opts.sort.join(', ')}` };
  const dir = query['dir'] ?? 'asc';
  if (dir !== 'asc' && dir !== 'desc') return { ok: false, detail: 'dir must be asc or desc' };
  const page = Number(rawPage);
  const size = Number(rawSize);
  const words = (query['search'] ?? '').trim().toLocaleLowerCase();
  const found = words === '' ? [...rows] : rows.filter((r) => opts.search.some((k) => String(r[k] ?? '').toLocaleLowerCase().includes(words)));
  if (sort !== undefined && sort !== '') {
    const sign = dir === 'desc' ? -1 : 1;
    found.sort((a, b) => {
      const x = a[sort]; const y = b[sort];
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * sign;
      return String(x ?? '').localeCompare(String(y ?? ''), 'en', { numeric: true }) * sign;
    });
  }
  const total = found.length;
  return {
    ok: true,
    rows: found.slice((page - 1) * size, page * size),
    paging: { page, size, total, pages: Math.max(1, Math.ceil(total / size)), search: words === '' ? null : words, sort: sort === undefined || sort === '' ? null : sort, dir },
  };
}

/**
 * Page `rows` for a route, or `undefined` when no page was asked for. A page that cannot be read is refused by name
 * (400, nothing changed) — never guessed.
 */
export function pageOrRefuse<T extends Record<string, unknown>, K extends string>(rows: readonly T[], query: Readonly<Record<string, string | undefined>>, opts: PagingOptions<K>): { readonly rows: readonly T[]; readonly paging: Paging } | undefined {
  const r = pageOf(rows, query, opts);
  if (r === undefined) return undefined;
  if (!r.ok) {
    throw apiError(400, {
      code: 'not_readable_as_a_page',
      whatHappened: `The page asked for could not be read: ${r.detail}.`,
      wasItSaved: 'not_saved',
      nextSafeAction: `Ask again with ?page= from 1 and ?size= up to ${PAGE_LIMITS.maxSize}${opts.sort.length > 0 ? `, sorting by ${opts.sort.join(', ')}` : ''}. Nothing was changed.`,
    });
  }
  return { rows: r.rows, paging: r.paging };
}
