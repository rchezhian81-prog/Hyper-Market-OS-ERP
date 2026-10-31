// THE CASHIER'S PRODUCTS VIEW — name, price and barcode only (OB-569, owner, 31 Oct 2026 · P-04 least privilege · P-07).
//
// A person who may open Products but holds no right to see costs and suppliers (`supplier.view` — the cashier) is sent,
// by the store computer, each product's id and name, the barcodes and nothing commercial (screen-data `catalogueForViewer`,
// which marks the payload `productFields: 'name_price_barcode'`). The full product-and-pricing session would judge those
// trimmed records as incomplete masters, so this page model shows them as what they are: a list to look an item up by name
// or barcode and read its price. The price is head office's — read item by item through the store computer's relay (the
// same one the full page uses), resolved for today by the same engine the till uses; nothing here writes anything.

import { resolvePrice, type PriceEntry } from '../../../packages/price-list/src/index';
import type { CataloguePriceState } from './browser-entry';

/** The marker the store computer puts on a trimmed Products payload. */
export const NAME_PRICE_BARCODE = 'name_price_barcode';

/** The parts of the price relay this view reads (`openCataloguePriceRelay`). */
export interface CashierPriceRelay {
  state(productId: string): CataloguePriceState;
  why(productId: string): string | undefined;
  load(productId: string): Promise<CataloguePriceState>;
  entries(): readonly PriceEntry[];
}

/** One row: what the cashier sees. `price` is today's price, `null` when head office has none set (or it is not read). */
export interface CashierProductRow {
  readonly productId: string;
  readonly name: string;
  readonly barcodes: readonly string[];
  readonly priceState: CataloguePriceState;
  readonly priceMinor: number | null;
  readonly why?: string;
}

export interface CashierProductView {
  /** Every product, by name; `query` matches a name or a barcode. */
  rows(query: string): readonly CashierProductRow[];
  /** Read this item's price from head office (once; a failed read may be asked again). */
  loadPrice(productId: string): Promise<CataloguePriceState>;
}

interface TrimmedData {
  readonly storeId?: string;
  readonly today?: string;
  readonly products?: readonly { readonly productId?: unknown; readonly name?: unknown }[];
  readonly barcodes?: readonly { readonly barcode: string; readonly productId: string }[];
}

export function createCashierProductView(data: TrimmedData, relay: CashierPriceRelay | undefined): CashierProductView {
  const storeId = data.storeId ?? 'store-1';
  const today = data.today ?? '1970-01-01';
  const barcodesOf = new Map<string, string[]>();
  for (const b of data.barcodes ?? []) barcodesOf.set(b.productId, [...(barcodesOf.get(b.productId) ?? []), b.barcode]);
  const products = (data.products ?? [])
    .flatMap((p) => (typeof p.productId === 'string' ? [{ productId: p.productId, name: typeof p.name === 'string' && p.name !== '' ? p.name : p.productId }] : []))
    .sort((a, b) => a.name.localeCompare(b.name) || a.productId.localeCompare(b.productId));

  const row = (p: { productId: string; name: string }): CashierProductRow => {
    const state = relay === undefined ? 'not_loaded' : relay.state(p.productId);
    const today_ = state === 'loaded' && relay !== undefined
      ? resolvePrice(relay.entries(), { productId: p.productId, at: `${today}T12:00:00.000Z`, storeId })
      : null;
    const why = relay?.why(p.productId);
    return {
      productId: p.productId, name: p.name, barcodes: barcodesOf.get(p.productId) ?? [],
      priceState: state === 'loaded' && today_ === null ? 'none' : state,
      priceMinor: today_ === null ? null : today_.price.minor,
      ...(why === undefined ? {} : { why }),
    };
  };

  return {
    rows: (query) => {
      const q = query.trim().toLowerCase();
      return products
        .filter((p) => q === '' || p.name.toLowerCase().includes(q) || (barcodesOf.get(p.productId) ?? []).some((b) => b.includes(q)))
        .map(row);
    },
    loadPrice: async (productId) => (relay === undefined ? 'not_loaded' : relay.load(productId)),
  };
}
