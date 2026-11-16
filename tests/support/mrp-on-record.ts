// Head office's own MRP for a product (the product master's `mrpHistory`), put on record through the ordinary product publish
// route — what `POST /v1/prices/changes` judges a price by (D-019 · the MRP ceiling is the lower of the recorded MRP and the
// one sent; with none on record the MRP sent needs a second person's approval). Tests that change a price put the item's MRP
// on record first, exactly as a shop does when it lists an item, rather than relying on the figure the request sends.

interface HarnessLike {
  request(r: { method: 'POST'; path: string; userId: string; tenantId: string; idempotencyKey: string; body: unknown }): Promise<{ status: number; body: unknown }>;
}

/** The product's MRP from `from` (default 1 Jan 2026, before any day a test trades), published as `by` (who holds
 *  `catalogue.pack.publish` — the owner). A 0% tax class and a plain test category are recorded alongside. */
export async function mrpOnRecord(
  h: HarnessLike, tenantId: string, by: string, productId: string, mrpMinor: number,
  opts: { readonly from?: string; readonly name?: string } = {},
): Promise<void> {
  const post = async (path: string, body: unknown, key: string) => {
    const r = await h.request({ method: 'POST', path, userId: by, tenantId, idempotencyKey: key, body });
    if (r.status >= 300) throw new Error(`${path} was refused: ${r.status} ${JSON.stringify(r.body)}`);
  };
  await post('/v1/catalogue/tax-classes/0401/rates/2017-07-01', { rateBps: 0 }, `mrp-on-record-tax-${tenantId}`);
  await post(`/v1/catalogue/products/${encodeURIComponent(productId)}/publish`, {
    product: {
      sku: `${productId}-SKU`, name: opts.name ?? `Synthetic ${productId}`, baseUom: 'ea', primaryCategoryId: 'mrp-test', taxClass: '0401', lifecycle: 'active',
      mrpHistory: [{ value: { minor: mrpMinor, currency: 'INR' }, effectiveFrom: opts.from ?? '2026-01-01' }],
      safety: { countryOfOrigin: 'India' },
    },
    categories: [{ categoryId: 'mrp-test', name: 'MRP test items', parentId: null }],
  }, `mrp-on-record-${tenantId}-${productId}-${mrpMinor}-${opts.from ?? ''}`);
}
