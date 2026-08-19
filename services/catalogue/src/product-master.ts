// API-02 Product master authoring (M03-FR-01 / M03-FR-03) — create/publish a product on the cloud, behind
// the tested compliance gate, and hold it in the product-master store the catalogue pack build has waited
// for. A product does not reach the catalogue until it VALIDATES: it needs a name, a SKU, a unit of
// measure, a category and an HSN/tax class, and a regulated item needs its safety content — a food item
// its allergen declaration and country of origin, a packed/weighed item its net quantity, an age-restricted
// item its minimum age (M03-FR-03). The rule is the tested `validateProduct`/`publishProduct` in
// `@sre/product` (the `services-run-on-their-tested-engine` guardrail); this is the persistence + HTTP skin
// around it.
//
// Published products are event-sourced (`ProductPublished`, latest-per-id folded) so a product master
// survives a restart, and a change is a new version, never an overwrite (hard rule #2). Authoring is gated
// `catalogue.pack.publish` — the authority to change what the shop sells; reads are `catalogue.pack.read`.
//
// NOTE (slice boundary): this is the product-master STORE + authoring surface. Feeding these published
// products into the signed catalogue pack (`buildSnapshot`) so they reach the lanes is the deliberate
// next slice — it rewires the working pack-build and is kept separate on purpose.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  publishProduct, NotPublishableError, CategoryNotFoundError,
  type ProductRecord, type Category, type ProductLifecycle,
} from '../../../packages/product/src/index';

export interface ProductMasterDeps {
  /** Append a published product master (latest-per-id). Idempotent on the caller's key. */
  readonly publish: (tenantId: string, record: ProductRecord, key: string) => Promise<void> | void;
  readonly product: (tenantId: string, productId: string) => Promise<ProductRecord | undefined> | ProductRecord | undefined;
  readonly products: (tenantId: string) => Promise<readonly ProductRecord[]> | readonly ProductRecord[];
}

const LIFECYCLES: readonly ProductLifecycle[] = ['draft', 'new', 'active', 'clearance', 'discontinued'];
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strOrNull = (v: unknown): string | null => (v === null ? null : typeof v === 'string' ? v : '');
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Build a ProductRecord from the request body — coerce the shape, and let the ENGINE judge completeness
 * (an empty name/SKU/category/HSN becomes a blocks_publish issue, not a 400 here). */
function readProduct(productId: string, tenantId: string, p: Record<string, unknown>): ProductRecord {
  return {
    productId,
    tenantId,
    sku: str(p['sku']),
    name: str(p['name']),
    baseUom: str(p['baseUom']),
    primaryCategoryId: strOrNull(p['primaryCategoryId']),
    taxClass: strOrNull(p['taxClass']),
    lifecycle: LIFECYCLES.includes(p['lifecycle'] as ProductLifecycle) ? (p['lifecycle'] as ProductLifecycle) : 'draft',
    ...(typeof p['brand'] === 'string' ? { brand: p['brand'] } : {}),
    ...(typeof p['manufacturer'] === 'string' ? { manufacturer: p['manufacturer'] } : {}),
    ...(p['parentProductId'] !== undefined ? { parentProductId: strOrNull(p['parentProductId']) } : {}),
    ...(Array.isArray(p['mrpHistory']) ? { mrpHistory: p['mrpHistory'] as ProductRecord['mrpHistory'] } : {}),
    ...(isObj(p['attributes']) ? { attributes: p['attributes'] as Readonly<Record<string, string>> } : {}),
    ...(isObj(p['safety']) ? { safety: p['safety'] as ProductRecord['safety'] } : {}),
    ...(typeof p['recallBlocked'] === 'boolean' ? { recallBlocked: p['recallBlocked'] } : {}),
  };
}

export function productMasterRoutes(deps: ProductMasterDeps): readonly Route[] {
  return [
    {
      api: 'API-02', method: 'POST', path: '/v1/catalogue/products/:productId/publish',
      permission: 'catalogue.pack.publish', idempotent: true,
      handler: async (ctx) => {
        const productId = ctx.params['productId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (productId.trim() === '' || !isObj(b['product']) || !Array.isArray(b['categories'])) {
          throw apiError(400, {
            code: 'not_readable_as_a_product',
            whatHappened: 'Publishing a product needs a productId in the path, a product object, and the categories[] to validate it against.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send { product: {...}, categories: [...] } with the product id in the URL.',
          });
        }
        const record = readProduct(productId, ctx.tenantId, b['product']);
        // The per-product compliance gate — the SAME tested rule the screen ran, re-run here because a
        // central boundary trusts no client verdict (ADR-0013 control 9): mandatory fields, category, HSN/tax
        // class, MRP/UOM, and a regulated item's safety content (allergen/country-of-origin/min-age).
        let published: ProductRecord;
        try {
          published = publishProduct(record, b['categories'] as Category[]); // draft → 'new' on first publish
        } catch (err) {
          if (err instanceof NotPublishableError) {
            throw apiError(422, {
              code: 'product_not_publishable',
              // The blocking reasons in plain English — the person fixing it is not a programmer.
              whatHappened: `The product cannot be published: ${err.issues.map((i) => i.message).join('; ')}.`,
              wasItSaved: 'not_saved',
              nextSafeAction: 'Fix the blocking fields named above and publish again — nothing was saved and the catalogue is unchanged.',
            });
          }
          if (err instanceof CategoryNotFoundError) {
            throw apiError(422, {
              code: 'unknown_category',
              whatHappened: `The product's category "${err.categoryId}" is not among the categories supplied — a product sits in exactly one place in the hierarchy.`,
              wasItSaved: 'not_saved',
              nextSafeAction: 'Include the product’s category in categories[], or correct primaryCategoryId.',
            });
          }
          throw err;
        }
        // The one re-check a single device CANNOT do (ADR-0013 control 9): SKU uniqueness across the WHOLE
        // tenant. Each device validates the product it holds, but two devices authoring offline each believe
        // their SKU is free — only here, where every product master lives, can a collision be seen. A SKU
        // already held by a DIFFERENT product is refused; re-publishing the SAME product (same id) under its
        // own SKU is not a clash. (Barcodes are enforced one-code-one-item on the barcode route.)
        const clash = (await deps.products(ctx.tenantId)).find(
          (p) => p.sku === published.sku && p.productId !== published.productId,
        );
        if (clash !== undefined) {
          throw apiError(409, {
            code: 'sku_already_in_use',
            whatHappened: `The SKU "${published.sku}" already belongs to product "${clash.productId}" — one SKU names exactly one product, so this publish would make a barcode or shelf label ambiguous.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Give this product its own SKU, or correct the id if this is the same product under a different code — nothing was saved and the catalogue is unchanged.',
          });
        }
        await deps.publish(ctx.tenantId, published, ctx.idempotencyKey ?? productId);
        return { status: 201, body: { product: published } };
      },
    },
    {
      // Read one product master (the latest published version). 404 when the product was never published.
      api: 'API-02', method: 'GET', path: '/v1/catalogue/products/:productId',
      permission: 'catalogue.pack.read',
      handler: async (ctx) => {
        const productId = ctx.params['productId'] ?? '';
        const product = await deps.product(ctx.tenantId, productId);
        if (product === undefined) throw notFound(`product ${productId}`);
        return { status: 200, body: { product } };
      },
    },
    {
      // The current product master — every product's latest published version, for the person curating it.
      api: 'API-02', method: 'GET', path: '/v1/catalogue/products',
      permission: 'catalogue.pack.read',
      handler: async (ctx) => {
        const products = await deps.products(ctx.tenantId);
        return { status: 200, body: { products, count: products.length } };
      },
    },
  ];
}
