// The product content editor's reads and product images (R4 · D01-FR-06 · OB-215 · OB-60 · OB-74).
//
//   • The app description and synonyms are edited through the existing content route (`POST /v1/catalogue/products/:id/
//     content`, a new product version each time). This adds what the editor page needs beside it: every VERSION of the app
//     content with who changed it and when, and the COMPLETENESS score — the five app parts and the product record's own
//     checks — naming what is missing. The content reaches the customer app on the next store publish.
//   • An IMAGE is kept on the shop's own server (OB-215 — nothing bought, no outside service): checked for type (from the
//     file's own bytes) and size first ("image type not allowed", "image too large"), kept content-addressed, and recorded
//     as a NEW VERSION — the earlier one stays. The customer app shows the current one; with none it works the same.

import { createHash } from 'node:crypto';
import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import type { Category, ProductRecord, AppContent } from '../../../packages/product/src/product';
import { completeness } from '../../../packages/product/src/completeness';
import {
  checkProductImage, currentImage, appContentCompleteness, MAX_IMAGE_BYTES,
  type ProductImageStore, type ProductImageVersion,
} from '../../../packages/product/src/images';

export interface AppContentVersion { readonly version: number; readonly content: AppContent; readonly by?: string; readonly at: string }

export interface ProductContentImageDeps {
  readonly product: (tenantId: string, productId: string) => Promise<ProductRecord | undefined>;
  /** Every published version of the product's app content, oldest first (a version only where the content changed). */
  readonly contentHistory: (tenantId: string, productId: string) => Promise<readonly AppContentVersion[]>;
  readonly categories: (tenantId: string) => Promise<readonly Category[]>;
  readonly imageVersions: (tenantId: string, productId: string) => Promise<readonly ProductImageVersion[]>;
  readonly recordImageVersion: (tenantId: string, v: ProductImageVersion) => Promise<void>;
  readonly imageStore: ProductImageStore;
  readonly now: () => string;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** The base64 text of an image at the size limit, with room for padding. */
const MAX_BASE64 = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4;

export function productContentImageRoutes(deps: ProductContentImageDeps): readonly Route[] {
  const productOr404 = async (t: string, id: string): Promise<ProductRecord> => {
    const p = await deps.product(t, id);
    if (p === undefined) throw notFound(`product ${id}`);
    return p;
  };
  const imageBody = async (t: string, productId: string) => {
    const cur = currentImage(await deps.imageVersions(t, productId), productId);
    if (cur === undefined) throw apiError(404, { code: 'no_image', whatHappened: `Product ${productId} has no image. The app shows it without one.`, wasItSaved: 'not_saved', nextSafeAction: 'Nothing to do — an image is optional.' });
    const held = await deps.imageStore.get(t, cur.imageId);
    if (held === undefined) throw apiError(500, { code: 'image_bytes_missing', whatHappened: `Image version ${cur.version} of ${productId} is recorded but its file is not on the shop's server.`, wasItSaved: 'not_saved', nextSafeAction: 'Upload the image again; report this to the administrator.' });
    return { status: 200, body: { productId, version: cur.version, mediaType: held.mediaType, bytes: held.bytes.length, contentBase64: Buffer.from(held.bytes).toString('base64') } };
  };

  return [
    {
      // The editor page's read: the app content now, every version of it, the image, and what is missing.
      api: 'API-02', method: 'GET', path: '/v1/catalogue/products/:productId/app-content',
      permission: 'catalogue.pack.read',
      handler: async (ctx) => {
        const productId = ctx.params['productId'] ?? '';
        const p = await productOr404(ctx.tenantId, productId);
        const images = await deps.imageVersions(ctx.tenantId, productId);
        const cur = currentImage(images, productId);
        const c = p.appContent ?? {};
        const app = appContentCompleteness({ ...c, hasImage: cur !== undefined });
        const record = completeness(p, await deps.categories(ctx.tenantId));
        return { status: 200, body: {
          productId, name: p.name, content: c,
          history: [...(await deps.contentHistory(ctx.tenantId, productId))].reverse(),
          image: cur === undefined ? null : { version: cur.version, mediaType: cur.mediaType, bytes: cur.bytes, setBy: cur.setBy, setAt: cur.setAt },
          imageHistory: [...images].sort((a, b) => b.version - a.version).map((v) => ({ version: v.version, mediaType: v.mediaType, bytes: v.bytes, setBy: v.setBy, setAt: v.setAt })),
          completeness: {
            app: { scorePercent: app.scorePercent, missing: app.missing },
            record: record.knowable ? { scorePercent: record.percent, missing: record.checks.filter((x) => !x.done).map((x) => x.label) } : { notKnowable: record.why },
          },
          reachesTheApp: 'on the next store publish',
        } };
      },
    },
    {
      // Upload a product image: { mediaType: image/jpeg | image/png | image/webp, contentBase64 }. A new version each time.
      api: 'API-02', method: 'POST', path: '/v1/catalogue/products/:productId/images',
      permission: 'catalogue.pack.publish', idempotent: true,
      handler: async (ctx) => {
        const productId = ctx.params['productId'] ?? '';
        await productOr404(ctx.tenantId, productId);
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const text = b['contentBase64'];
        if (typeof text !== 'string' || text === '' || !BASE64.test(text)) {
          throw apiError(400, { code: 'not_readable_as_an_image', whatHappened: 'An image needs { mediaType, contentBase64 } — the photo\'s bytes in base64.', wasItSaved: 'not_saved', nextSafeAction: 'Choose the photo again. Nothing was kept.' });
        }
        if (text.length > MAX_BASE64) throw apiError(413, { code: 'image_too_large', whatHappened: `image too large: at most ${MAX_IMAGE_BYTES} bytes (700 KB) is kept.`, wasItSaved: 'not_saved', nextSafeAction: 'Use a smaller photo. Nothing was kept.' });
        const bytes = new Uint8Array(Buffer.from(text, 'base64'));
        const check = checkProductImage(b['mediaType'], bytes);
        if (!check.ok) {
          throw apiError(check.code === 'image_too_large' ? 413 : 415, { code: check.code === 'image_empty' ? 'image_type_not_allowed' : check.code, whatHappened: `${check.refusal}: ${check.detail}.`, wasItSaved: 'not_saved', nextSafeAction: check.code === 'image_too_large' ? 'Use a smaller photo. Nothing was kept.' : 'Use a JPEG, PNG or WebP photo. Nothing was kept.' });
        }
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const versions = await deps.imageVersions(ctx.tenantId, productId);
        const cur = currentImage(versions, productId);
        if (cur !== undefined && cur.sha256 === sha256) return { status: 200, body: { image: cur, unchanged: true } };
        const imageId = `img-${sha256.slice(0, 40)}`;
        await deps.imageStore.put(ctx.tenantId, imageId, check.mediaType, bytes);
        const v: ProductImageVersion = { productId, version: (cur?.version ?? 0) + 1, imageId, mediaType: check.mediaType, bytes: check.bytes, sha256, setBy: ctx.userId, setAt: deps.now() };
        await deps.recordImageVersion(ctx.tenantId, v);
        return { status: 201, body: { image: v, replaced: cur === undefined ? null : cur.version } };
      },
    },
    {
      // The current image, for the editor page.
      api: 'API-02', method: 'GET', path: '/v1/catalogue/products/:productId/image',
      permission: 'catalogue.pack.read',
      handler: async (ctx) => imageBody(ctx.tenantId, ctx.params['productId'] ?? ''),
    },
    {
      // The current image, for the customer app — from the shop's own server.
      api: 'API-07', method: 'GET', path: '/v1/storefront/products/:productId/image',
      permission: 'storefront.order.read', entitlement: 'customer_app',
      handler: async (ctx) => imageBody(ctx.tenantId, ctx.params['productId'] ?? ''),
    },
  ];
}
