// FUL-14 test support: the STORED truth a substitution is decided from — the published price (a catalogue pack), the product
// master's attributes, and what the customer said (recorded with how they were reached). Synthetic data only.

import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM } from '../../services/api/src/adapters';
import type { ApiHarness } from './api-harness';

export interface TruthProduct {
  readonly productId: string;
  readonly name: string;
  readonly priceMinor: number;
  readonly brand?: string;
  readonly categoryId?: string;
  readonly allergens?: readonly string[];
  readonly minimumAge?: number;
}

/** Publish the products: a catalogue pack with their prices, and a product-master record with their attributes. */
export async function seedSubstitutionTruth(h: ApiHarness, tenantId: string, products: readonly TruthProduct[], at = '2026-08-01T00:00:00.000Z'): Promise<void> {
  await h.store.append(tenantId, STREAM.catalogue, makeEvent({
    id: `pack-${tenantId}-sub-truth`, type: 'CataloguePublished', occurredAt: at, idempotencyKey: `catalogue-${tenantId}-sub-truth`, source: 'test/catalogue',
    payload: { snapshot: { tenantId, version: 1, builtAt: at, scope: { tenantId, storeId: 'store-1' }, barcodes: [], products: products.map((p) => ({
      productId: p.productId, sku: p.productId, name: p.name, unitPriceMinor: p.priceMinor, taxBps: 0, status: 'active', baseUom: 'ea',
    })) } },
  }));
  for (const p of products) {
    await h.store.append(tenantId, [STREAM.catalogue, 'products'].join('\u001f'), makeEvent({
      id: `product-${p.productId}`, type: 'ProductPublished', occurredAt: at, idempotencyKey: `product-${tenantId}-${p.productId}-sub-truth`, source: 'test/catalogue',
      payload: {
        productId: p.productId, tenantId, sku: p.productId, name: p.name, primaryCategoryId: p.categoryId ?? null, baseUom: 'ea', taxClass: '0401', lifecycle: 'active',
        ...(p.brand === undefined ? {} : { brand: p.brand }),
        ...(p.allergens === undefined && p.minimumAge === undefined ? {} : { safety: { ...(p.allergens === undefined ? {} : { allergens: p.allergens }), ...(p.minimumAge === undefined ? {} : { minimumAge: p.minimumAge }) } }),
      },
    }));
  }
}

/** The products the substitution suites swap between: milk Rs 50, a cheaper alternative Rs 40, a same-price one, a dear one
 *  Rs 90, and an age-restricted item the policy never swaps in. */
export const SWAP_PRODUCTS: readonly TruthProduct[] = [
  { productId: 'MILK', name: 'Milk 1L', priceMinor: 5_000, brand: 'aavin', categoryId: 'dairy' },
  { productId: 'MILK-ALT', name: 'Milk 1L alt', priceMinor: 4_000, brand: 'arokya', categoryId: 'dairy' },
  { productId: 'MILK-SAME', name: 'Milk 1L same price', priceMinor: 5_000, brand: 'arokya', categoryId: 'dairy' },
  { productId: 'MILK-DEAR', name: 'Milk 1L premium', priceMinor: 9_000, brand: 'arokya', categoryId: 'dairy' },
  { productId: 'BEER', name: 'Beer 330ml', priceMinor: 4_000, categoryId: 'dairy', minimumAge: 21 },
];

/** The bank confirmed the order's online payment (recorded as the checkout answered it). */
export async function paidOnline(h: ApiHarness, tenantId: string, userId: string, orderId: string, amountMinor: number): Promise<void> {
  const res = await h.request({ method: 'POST', path: `/v1/orders/${orderId}/payment`, userId, tenantId, idempotencyKey: `pay-${orderId}`, body: { providerRef: `tok_${orderId}`, amountMinor, result: 'authorised' } });
  if (res.status >= 300) throw new Error(`payment not recorded: ${res.status} ${JSON.stringify(res.body)}`);
}

/** A member of staff records what the customer said about substitutes on this order, and how they reached them. */
export async function recordOrderRules(h: ApiHarness, tenantId: string, userId: string, orderId: string, rules: Record<string, unknown>): Promise<void> {
  const res = await h.request({
    method: 'POST', path: `/v1/orders/${orderId}/substitution-preference`, userId, tenantId, idempotencyKey: `rules-${orderId}-${JSON.stringify(rules)}`,
    body: { rules, contact: { method: 'phone', reference: `call-${orderId}` } },
  });
  if (res.status !== 201) throw new Error(`rules not recorded: ${res.status} ${JSON.stringify(res.body)}`);
}
