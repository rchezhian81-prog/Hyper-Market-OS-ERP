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
import { ConcurrencyConflictError } from '../../../packages/persistence/src/event-store';
import { settlePublishCategories, type CategoryRegisterDeps } from './categories';
import {
  publishProduct, NotPublishableError, CategoryNotFoundError, isTobacco, warningStanding, checkVariant,
  type ProductRecord, type ProductLifecycle, type HandlingClass,
} from '../../../packages/product/src/index';
import { liquorReason, LIQUOR_NOT_SOLD } from '../../../packages/restricted-sales/src/liquor';

export interface ProductMasterDeps {
  /**
   * Append a published product master (latest-per-id). Idempotent on the caller's key. With `skuVersion` (from `skuHolder`),
   * the append lands only while the SKU's write guard is still at that version — otherwise `ConcurrencyConflictError`.
   */
  readonly publish: (tenantId: string, record: ProductRecord, key: string, skuVersion?: number) => Promise<void> | void;
  /**
   * GT-05 store volume: which OTHER product holds `sku` now, read by key — not the whole master — with the version of the
   * SKU's write guard, read first. Absent (a bare fake): the route scans `products`.
   */
  readonly skuHolder?: (tenantId: string, sku: string, productId: string) => Promise<{ readonly holder?: string; readonly version: number }>;
  readonly product: (tenantId: string, productId: string) => Promise<ProductRecord | undefined> | ProductRecord | undefined;
  readonly products: (tenantId: string) => Promise<readonly ProductRecord[]> | readonly ProductRecord[];
  /** Head office's own category list (SF-06-b · OB-24 "A") — what every product is judged against. */
  readonly categoryRegister: CategoryRegisterDeps;
  /** Today, for the B16 tobacco-warning check at activation. Absent → the machine's clock. */
  readonly now?: () => string;
}

/** The lifecycles a till sells (the pack maps `new` to active). */
const SELLING: readonly ProductLifecycle[] = ['new', 'active', 'clearance'];

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
    // M19-FR-02: the handling class travels as given; the ENGINE refuses a word off its list (blocks_publish), never coerces it.
    ...(typeof p['handling'] === 'string' ? { handling: p['handling'] as HandlingClass } : {}),
    // HA-3: a product's own cold-chain limits travel as given (numbers only); the ENGINE judges them — whole tenths, ordered, cold class.
    ...(isObj(p['coldChain']) ? {
      coldChain: {
        ...(typeof p['coldChain']['minTenthsC'] === 'number' ? { minTenthsC: p['coldChain']['minTenthsC'] } : {}),
        ...(typeof p['coldChain']['maxTenthsC'] === 'number' ? { maxTenthsC: p['coldChain']['maxTenthsC'] } : {}),
      },
    } : {}),
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
        if (productId.trim() === '' || !isObj(b['product'])) {
          throw apiError(400, {
            code: 'not_readable_as_a_product',
            whatHappened: 'Publishing a product needs a productId in the path and a product object.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send { product: {...} } with the product id in the URL (categories[] optional: the categories you expect head office to hold).',
          });
        }
        // A minimum age the till cannot read is not a restriction. Refuse it HERE rather than publish a product that
        // VALIDATES as age-restricted yet reaches the lane unflagged (E1b · M03-FR-03 → M12-FR-04, P-08): the pack
        // carries `safety.minimumAge` as `regulatedFlags.minimumAge`, and only a positive whole number of years travels.
        const safety = b['product']['safety'];
        const minimumAge = isObj(safety) ? safety['minimumAge'] : undefined;
        if (minimumAge !== undefined && !(typeof minimumAge === 'number' && Number.isInteger(minimumAge) && minimumAge > 0)) {
          throw apiError(400, {
            code: 'not_readable_as_a_product',
            whatHappened: `The minimum age to buy this product must be a whole number of years (for example 18 or 21); it arrived as ${JSON.stringify(minimumAge)}, and a till cannot prompt on an age it cannot read.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send safety.minimumAge as a whole number of years, or leave it out for a product that is not age-restricted. Nothing was saved.',
          });
        }
        const read = readProduct(productId, ctx.tenantId, b['product']);
        // D01-FR-06 (round 8): the app content is authored on its own route; a publish of the record keeps what is there.
        const current = await deps.product(ctx.tenantId, productId);
        // B16 (OB-140 "A"): the tobacco-warning confirmations are authored on their own route by a named person and are
        // carried forward here — never taken from the body, so a publish cannot type a confirmation in.
        const carried: ProductRecord = current?.tobaccoWarning === undefined ? read : { ...read, tobaccoWarning: current.tobaccoWarning };
        const record: ProductRecord = current?.appContent === undefined ? carried : { ...carried, appContent: current.appContent };
        // The categories are head office's OWN list (SF-06-b · OB-24 "A") — never the sender's. An expected category that
        // differs from the list is refused; a missing one is defined only by someone who may define categories, and said.
        const { categories, defined } = await settlePublishCategories(deps.categoryRegister, ctx, b['categories']);
        // B17 (TASMAC · OWNER_DECISIONS D3): liquor is NOT SOLD — refused by name before anything else is judged, so nobody
        // fixes a field on a product that can never be published. Flag, category or HSN; never the product's name.
        const category = categories.find((c) => c.categoryId === record.primaryCategoryId);
        const liquor = liquorReason({ declaredLiquor: record.safety?.liquor === true, categoryKinds: category?.regulated ?? [], hsn: record.taxClass });
        if (liquor !== undefined) {
          throw apiError(422, {
            code: 'liquor_not_sold',
            whatHappened: `${LIQUOR_NOT_SOLD} "${record.name}" cannot be published: ${liquor}.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Do not list it. If it is a non-alcoholic drink, correct its HSN (non-alcoholic beer is 2202) and take the liquor mark off. Nothing was saved.',
          });
        }
        // M03-FR-01 (OB-288 P2): a variant names a one-level parent head office holds and differs from its siblings.
        if ((record.parentProductId ?? '').trim() !== '') {
          const variant = checkVariant(record, await deps.products(ctx.tenantId));
          if (!variant.ok) {
            throw apiError(422, {
              code: variant.refusal!, whatHappened: `The product cannot be published as it stands: ${variant.detail}.`, wasItSaved: 'not_saved',
              nextSafeAction: 'Correct parentProductId (or the attributes that make this variant different) and publish again. Nothing was saved.',
            });
          }
        }
        // The per-product compliance gate — the SAME tested rule the screen ran, re-run here because a
        // central boundary trusts no client verdict (ADR-0013 control 9): mandatory fields, category, HSN/tax
        // class, MRP/UOM, and a regulated item's safety content (allergen/country-of-origin/min-age).
        let published: ProductRecord;
        let activationRefused: ReturnType<typeof warningStanding> | undefined;
        try {
          published = publishProduct(record, categories); // draft → 'new' on first publish
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
        // B16 (COTPA s.7 · OB-140 "A"): a tobacco product is ACTIVATED only with a named person's confirmation that its packs
        // carry the health-warning picture in force today. Without one, a product sent as a draft is kept as a draft (not on
        // sale, never in the pack); one sent to be sold now is refused. There is no override.
        if (isTobacco(published) && SELLING.includes(published.lifecycle)) {
          const standing = warningStanding(published.tobaccoWarning, (deps.now?.() ?? new Date().toISOString()).slice(0, 10));
          if (!standing.sellable) {
            if (read.lifecycle !== 'draft') {
              throw apiError(422, {
                code: 'tobacco_warning_not_confirmed',
                whatHappened: `This tobacco product cannot be put on sale: ${standing.detail}.`,
                wasItSaved: 'not_saved',
                nextSafeAction: 'Save it as a draft, have the person who checked the packs confirm the warning picture (POST /v1/catalogue/products/:productId/tobacco-warning-confirmation), then publish it again. Nothing was saved.',
              });
            }
            published = { ...published, lifecycle: 'draft' };
            activationRefused = standing;
          }
        }
        // The one re-check a single device CANNOT do (ADR-0013 control 9): SKU uniqueness across the WHOLE
        // tenant. Each device validates the product it holds, but two devices authoring offline each believe
        // their SKU is free — only here, where every product master lives, can a collision be seen. A SKU
        // already held by a DIFFERENT product is refused; re-publishing the SAME product (same id) under its
        // own SKU is not a clash. (Barcodes are enforced one-code-one-item on the barcode route.)
        // GT-05: the SKU's holder is read by key (not the whole master), with its guard's version; a publish that loses the
        // guard to a simultaneous one re-reads and is judged again — two products can never both take one SKU.
        for (let attempt = 0; ; attempt += 1) {
          const held = deps.skuHolder === undefined ? undefined : await deps.skuHolder(ctx.tenantId, published.sku, published.productId);
          const clash = held === undefined
            ? (await deps.products(ctx.tenantId)).find((p) => p.sku === published.sku && p.productId !== published.productId)?.productId
            : held.holder;
          if (clash !== undefined) {
            throw apiError(409, {
              code: 'sku_already_in_use',
              whatHappened: `The SKU "${published.sku}" already belongs to product "${clash}" — one SKU names exactly one product, so this publish would make a barcode or shelf label ambiguous.`,
              wasItSaved: 'not_saved',
              nextSafeAction: 'Give this product its own SKU, or correct the id if this is the same product under a different code — nothing was saved and the catalogue is unchanged.',
            });
          }
          try {
            await deps.publish(ctx.tenantId, published, ctx.idempotencyKey ?? productId, held?.version);
          } catch (err) {
            if (err instanceof ConcurrencyConflictError && attempt < 4) continue;
            if (err instanceof ConcurrencyConflictError) {
              throw apiError(409, { code: 'sku_changed_meanwhile', whatHappened: `The SKU "${published.sku}" kept changing while this product was being saved.`, wasItSaved: 'not_saved', nextSafeAction: 'Read the product master and publish again. Nothing was saved.' });
            }
            throw err;
          }
          return {
            status: 201,
            body: {
              product: published, ...(defined.length > 0 ? { categoriesDefined: defined } : {}),
              // B16: said, never silent — the product is saved as a draft and is NOT on sale until its warning is confirmed.
              ...(activationRefused === undefined || activationRefused.sellable ? {} : {
                activation: {
                  refused: true, because: 'tobacco_warning_not_confirmed', standing: activationRefused.reason, detail: activationRefused.detail,
                  nextSafeAction: 'A named person confirms the packs carry the warning picture in force, then publish it again to put it on sale.',
                },
              }),
            },
          };
        }
      },
    },
    {
      // D01-FR-06 (round 8): the customer app's content for a product — a Tamil name, a description in each language and the
      // other words customers search with. A new version of the product (append-only); the record itself is unchanged. Only a
      // product head office has published. A field sent as null is cleared; a field left out is kept.
      api: 'API-02', method: 'POST', path: '/v1/catalogue/products/:productId/content',
      permission: 'catalogue.pack.publish', idempotent: true,
      handler: async (ctx) => {
        const productId = (ctx.params['productId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const current = await deps.product(ctx.tenantId, productId);
        if (current === undefined) throw notFound(`product ${productId}`);
        const problems: string[] = [];
        const text = (k: 'nameTa' | 'descriptionEn' | 'descriptionTa', max: number): string | null | undefined => {
          const v = b[k];
          if (v === undefined || v === null) return v as undefined | null;
          if (typeof v !== 'string' || v.trim() === '' || v.trim().length > max) { problems.push(`${k} must be words, at most ${max} characters`); return undefined; }
          return v.trim();
        };
        const nameTa = text('nameTa', 120);
        const descriptionEn = text('descriptionEn', 1000);
        const descriptionTa = text('descriptionTa', 1000);
        let synonyms: readonly string[] | null | undefined;
        if (b['synonyms'] === null) synonyms = null;
        else if (b['synonyms'] !== undefined) {
          const list = Array.isArray(b['synonyms']) ? b['synonyms'] : [];
          const clean = [...new Set(list.filter((w): w is string => typeof w === 'string').map((w) => w.trim().toLowerCase()).filter((w) => w !== ''))];
          if (!Array.isArray(b['synonyms']) || clean.length !== list.length || clean.length > 20 || clean.some((w) => w.length > 40)) {
            problems.push('synonyms must be a list of up to 20 different words or short phrases, each at most 40 characters');
          } else synonyms = clean;
        }
        if (typeof b['reason'] !== 'string' || b['reason'].trim() === '') problems.push('a reason is needed — the next person reads why the app content changed');
        if (problems.length > 0) {
          throw apiError(400, { code: 'not_readable_as_app_content', whatHappened: `The app content was not saved: ${problems.join('; ')}.`, wasItSaved: 'not_saved', nextSafeAction: 'Correct it and send again. Nothing was changed.' });
        }
        const before = current.appContent ?? {};
        const pick = <T,>(given: T | null | undefined, had: T | undefined): T | undefined => (given === null ? undefined : given === undefined ? had : given);
        const merged = {
          ...(pick(nameTa, before.nameTa) === undefined ? {} : { nameTa: pick(nameTa, before.nameTa)! }),
          ...(pick(descriptionEn, before.descriptionEn) === undefined ? {} : { descriptionEn: pick(descriptionEn, before.descriptionEn)! }),
          ...(pick(descriptionTa, before.descriptionTa) === undefined ? {} : { descriptionTa: pick(descriptionTa, before.descriptionTa)! }),
          ...(pick(synonyms, before.synonyms) === undefined || pick(synonyms, before.synonyms)!.length === 0 ? {} : { synonyms: pick(synonyms, before.synonyms)! }),
          setBy: ctx.userId,
        };
        const record: ProductRecord = { ...current, appContent: merged };
        await deps.publish(ctx.tenantId, record, `content-${ctx.idempotencyKey ?? productId}`);
        return { status: 201, body: { product: record } };
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
        // SF-11 (M03-FR-01 acceptance "a report by category returns the correct set"): `?categoryId=` narrows to the products
        // whose ONE primary category is that category or any category beneath it on head office's list. An id the list does
        // not hold is a 404 — an unknown category is not an empty one.
        const categoryId = ctx.query['categoryId'];
        if (categoryId === undefined || categoryId === '') return { status: 200, body: { products, count: products.length } };
        const categories = await deps.categoryRegister.categories(ctx.tenantId);
        if (!categories.some((c) => c.categoryId === categoryId)) throw notFound(`category ${categoryId}`);
        const within = new Set<string>([categoryId]);
        for (let grew = true; grew;) {
          grew = false;
          for (const c of categories) {
            if (c.parentId !== null && within.has(c.parentId) && !within.has(c.categoryId)) { within.add(c.categoryId); grew = true; }
          }
        }
        const inCategory = products.filter((p) => p.primaryCategoryId !== null && within.has(p.primaryCategoryId));
        return { status: 200, body: { products: inCategory, count: inCategory.length, categoryId, categoriesIncluded: [...within].sort() } };
      },
    },
  ];
}
