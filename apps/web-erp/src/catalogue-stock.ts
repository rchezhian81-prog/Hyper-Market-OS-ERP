// D-018 (OB-800 THE PLAN fix batch 4b · P-07 · P-08): the Products list shows how many of each item we have, without
// opening Stock & counts → Stock ledger → Choose… → Show for every item. ONE read of head office's on-hand for every item
// in the person's own stores (GET /v1/inventory/availability — the same projection from the append-only stock ledger the
// Stock ledger page reads, already limited to the places the person may see), summed per item. Read-only: nothing here
// changes stock. A refused or failed read says why, once, and the list never shows a guessed figure (P-08): an item head
// office has no stock record for reads "none recorded", never 0 pretending to be counted.

export type CatalogueStockState = 'not_loaded' | 'loading' | 'loaded' | 'lost_link' | 'refused';

export interface CatalogueStock {
  state(): CatalogueStockState;
  /** Why the figures are not shown (a refused or failed read), in head office's own words where it gave them. */
  why(): string | undefined;
  /** On-hand summed over the person's places, in the item's minor units; undefined when head office holds no record of it. */
  onHand(productId: string): number | undefined;
  /** When head office projected the figures. */
  asAt(): string | undefined;
  load(): Promise<CatalogueStockState>;
}

interface AvailabilityRow { readonly productId?: unknown; readonly onHandMinor?: unknown }

/** Sum head office's availability rows per item (one row per item per place). Rows that are not readable are skipped. */
export function onHandByProduct(rows: readonly AvailabilityRow[]): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    if (typeof r.productId !== 'string' || r.productId === '' || typeof r.onHandMinor !== 'number' || !Number.isSafeInteger(r.onHandMinor)) continue;
    out.set(r.productId, (out.get(r.productId) ?? 0) + r.onHandMinor);
  }
  return out;
}

const LOST_LINK = 'Head office cannot be reached from this store computer just now, so how many we have is not shown. Nothing was changed.';
const REFUSED = 'Head office did not show how many we have.';

export function openCatalogueStock(fetchFn: typeof fetch | undefined = (globalThis as { fetch?: typeof fetch }).fetch): CatalogueStock {
  let state: CatalogueStockState = 'not_loaded';
  let reason: string | undefined;
  let figures: ReadonlyMap<string, number> = new Map();
  let at: string | undefined;
  let pending: Promise<CatalogueStockState> | undefined;
  const settle = (to: CatalogueStockState, why?: string): CatalogueStockState => { state = to; reason = why; return to; };
  return {
    state: () => state,
    why: () => reason,
    onHand: (productId) => figures.get(productId),
    asAt: () => at,
    load: () => {
      if (state === 'loaded') return Promise.resolve(state);
      if (pending !== undefined) return pending;
      state = 'loading';
      pending = (async (): Promise<CatalogueStockState> => {
        if (fetchFn === undefined) return settle('lost_link', LOST_LINK);
        try {
          const res = await fetchFn('/v1/inventory/availability', { method: 'GET', headers: { accept: 'application/json' }, credentials: 'same-origin' });
          const body = (await res.json().catch(() => ({}))) as { rows?: unknown; asAt?: unknown; error?: { whatHappened?: unknown } };
          if (res.status >= 200 && res.status < 300) {
            figures = onHandByProduct(Array.isArray(body.rows) ? (body.rows as AvailabilityRow[]) : []);
            at = typeof body.asAt === 'string' ? body.asAt : undefined;
            return settle('loaded');
          }
          const said = body.error?.whatHappened;
          return settle('refused', typeof said === 'string' && said !== '' ? said : REFUSED);
        } catch {
          return settle('lost_link', LOST_LINK);
        } finally {
          pending = undefined;
        }
      })();
      return pending;
    },
  };
}
