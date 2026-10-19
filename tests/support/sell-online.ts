// R4 · OB-234 test support: the online store sells only a product the shop has PUBLISHED online, and only while it
// carries every display duty (B23 · A26). A test that places a storefront order therefore lists its products first,
// through the production routes: the shop's details (synthetic, the grievance officer included) and each product's
// listing. The products themselves must carry an MRP and a country of origin (`ONLINE_READY`), and the shop a delivery
// fee (0 is a fee). Nothing here is a real person, a real GSTIN or a real price.

export type SellOnlineReply = { readonly status: number; readonly body: unknown };
/** A POST as a person who holds `online.store.manage` (the owner or a store manager). */
export type SellOnlinePost = (path: string, body: unknown) => Promise<SellOnlineReply>;

/** Synthetic shop details — every one set, the GSTIN well-shaped but not anybody's. */
export const SYNTHETIC_SHOP_DETAILS = Object.freeze({
  legalName: 'SRE Hyper Market (synthetic test shop)',
  address: '1 Test Street, Coimbatore 641001 (synthetic)',
  gstin: '33ABCDE1234F1Z5',
  returnTerms: 'Unopened goods may be returned within 7 days (synthetic test terms)',
  grievanceOfficerName: 'Test Grievance Officer (synthetic)',
  grievanceOfficerContact: 'grievance@example.test (synthetic)',
});

/** What a product needs on its master record to be listable online: an MRP in force and a country of origin. */
export const onlineReady = (mrpMinor: number) => ({
  mrpHistory: [{ value: { minor: mrpMinor, currency: 'INR' }, effectiveFrom: '2017-01-01' }],
  safety: { countryOfOrigin: 'India' },
});

/** Set the shop's details and publish each product online; fails loudly, naming what is missing, if one is refused. */
export async function sellOnline(post: SellOnlinePost, productIds: readonly string[]): Promise<void> {
  const d = await post('/v1/online-store/details', { ...SYNTHETIC_SHOP_DETAILS, reason: 'test shop details (synthetic)' });
  if (d.status >= 300) throw new Error(`setting the shop's online details was refused: ${d.status} ${JSON.stringify(d.body)}`);
  for (const productId of productIds) {
    const r = await post(`/v1/online-store/listings/${productId}`, { action: 'publish' });
    if (r.status >= 300) throw new Error(`publishing ${productId} online was refused: ${r.status} ${JSON.stringify(r.body)}`);
  }
}

/**
 * For a test whose shop has no catalogue yet: publish one product (0% tax class 0401, the store price as its MRP), the
 * store's pack, a delivery fee of 0 (none charged) from `feeFrom`, and list it online. Each step through the routes.
 */
export async function listableProduct(post: SellOnlinePost, p: { readonly productId: string; readonly storeId: string; readonly priceMinor: number; readonly feeFrom?: string }): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const step = async (path: string, body: unknown) => {
    const r = await post(path, body);
    if (r.status >= 300) throw new Error(`${path} was refused: ${r.status} ${JSON.stringify(r.body)}`);
  };
  await step('/v1/catalogue/tax-classes/0401/rates/2017-07-01', { rateBps: 0 });
  await step(`/v1/catalogue/products/${p.productId}/publish`, {
    product: { sku: `${p.productId}-SKU`, name: `Synthetic ${p.productId}`, baseUom: 'each', primaryCategoryId: 'grocery-test', taxClass: '0401', lifecycle: 'active', ...onlineReady(p.priceMinor) },
    categories: [{ categoryId: 'grocery-test', name: 'Grocery (test)', parentId: null }],
  });
  await step(`/v1/prices/list/${p.productId}/entries/e1`, { scope: 'store', scopeRef: p.storeId, priceMinor: p.priceMinor, mrpMinor: p.priceMinor, costMinor: 1, marginFloorBps: 0, currency: 'INR', effectiveFrom: today });
  await step('/v1/catalogue/pack', { storeId: p.storeId, asOf: today });
  await step(`/v1/serviceability/periods/${p.feeFrom ?? '2025-01-01'}`, { radiusMetres: 10_000, deliveryFeeMinor: 0 });
  await sellOnline(post, [p.productId]);
}
