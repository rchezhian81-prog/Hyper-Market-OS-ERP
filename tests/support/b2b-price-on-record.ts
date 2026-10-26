// OB-361 (owner, 24–25 Oct 2026, in writing): a B2B quotation takes NO typed price — each line is priced from the
// customer's contract or the shop's price list, and an item with neither is refused. Tests that quote a business customer
// therefore put the item on the price list first: a CUSTOMER-scope price-list entry (the price-list engine's highest
// precedence, so it applies whatever store the quotation names), through the ordinary price-list route.

import { shopDateIn } from '../../packages/calendar/src/shop-clock';
/** Strip the typed price from quotation lines — the record prices them now (OB-361). */
export function unpriced<T extends { readonly unitPriceMinor?: number }>(lines: readonly T[]): Omit<T, 'unitPriceMinor'>[] {
  return lines.map((l) => Object.fromEntries(Object.entries(l).filter(([k]) => k !== 'unitPriceMinor')) as Omit<T, 'unitPriceMinor'>);
}

/** The price-list route call that puts `productId` on `customerId`'s price list at `priceMinor` from today. */
export function customerListPrice(productId: string, customerId: string, priceMinor: number): { readonly path: string; readonly body: Record<string, unknown> } {
  return {
    path: `/v1/prices/list/${encodeURIComponent(productId)}/entries/b2b-${encodeURIComponent(customerId)}-${encodeURIComponent(productId)}-${priceMinor}`,
    body: {
      scope: 'customer', scopeRef: customerId, priceMinor, currency: 'INR', mrpMinor: priceMinor, costMinor: Math.floor(priceMinor * 0.8),
      marginFloorBps: 0, effectiveFrom: shopDateIn(new Date().toISOString()),
    },
  };
}

type Post = (path: string, body: Record<string, unknown>) => Promise<{ readonly status: number; readonly body: unknown }>;

/**
 * Put every line's price on the customer's price list (through the price-list route, as `post` sends it — idempotent per
 * product, customer and price) and hand back the lines WITHOUT their typed price, ready to quote. Anything that is not a
 * list of lines is handed back as it is (a malformed body stays malformed).
 */
export async function onThePriceList(post: Post, customerId: string, lines: unknown): Promise<unknown> {
  if (!Array.isArray(lines)) return lines;
  for (const l of lines as { productId?: unknown; unitPriceMinor?: unknown }[]) {
    if (typeof l?.productId !== 'string' || typeof l.unitPriceMinor !== 'number') continue;
    const e = customerListPrice(l.productId, customerId, l.unitPriceMinor);
    const r = await post(e.path, e.body);
    if (r.status >= 300) throw new Error(`could not put ${l.productId} on ${customerId}'s price list: ${r.status} ${JSON.stringify(r.body)}`);
  }
  return (lines as unknown[]).map((l) => (l !== null && typeof l === 'object' ? unpriced([l as { unitPriceMinor?: number }])[0] : l));
}

interface HarnessLike {
  request(r: { method: 'POST'; path: string; userId: string; tenantId: string; idempotencyKey: string; body: unknown }): Promise<{ status: number; body: unknown }>;
}

/** `onThePriceList`'s poster over an API harness, posting as the owner. */
export function harnessPriceList(h: HarnessLike, tenantId: string, by = 'u-owner'): Post {
  return (path, body) => h.request({ method: 'POST', path, userId: by, tenantId, idempotencyKey: `pl-${tenantId}-${path}`, body });
}
