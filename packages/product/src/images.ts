// Product images on the shop's own server (R4 · D01-FR-06 · OB-215 · OB-60).
//
// OB-215: an image is stored on the shop's OWN server — nothing bought, no outside service. It is checked before it is
// kept: the TYPE from the file's own first bytes (a JPEG, PNG or WebP photo — never an SVG or anything that can carry a
// script), agreeing with the type the uploader declared ("image type not allowed"), and its SIZE ("image too large").
// A new image of a product is a NEW VERSION; the earlier one is kept (append-only). The app works the same without one.
//
// Pure and deterministic. The bytes are judged here; where they are kept is the caller's port (`ProductImageStore`).

export const ALLOWED_IMAGE_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp'] as const);
export type ProductImageType = (typeof ALLOWED_IMAGE_TYPES)[number];

/**
 * The largest image kept: 700 KB — a product photo for a phone screen, not a print original. It also keeps an upload,
 * base64-encoded in its request, under the API's 1 MiB body limit.
 */
export const MAX_IMAGE_BYTES = 716_800;

export const IMAGE_TYPE_NOT_ALLOWED = 'image type not allowed';
export const IMAGE_TOO_LARGE = 'image too large';

/** What the file's own first bytes say it is (never the name or the declared type). */
export function sniffImageType(bytes: Uint8Array): ProductImageType | undefined {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return undefined;
}

export type ImageCheck =
  | { readonly ok: true; readonly mediaType: ProductImageType; readonly bytes: number }
  | { readonly ok: false; readonly code: 'image_type_not_allowed' | 'image_too_large' | 'image_empty'; readonly refusal: string; readonly detail: string };

export function checkProductImage(declaredType: unknown, bytes: Uint8Array): ImageCheck {
  if (bytes.length === 0) return { ok: false, code: 'image_empty', refusal: IMAGE_TYPE_NOT_ALLOWED, detail: 'the file is empty' };
  if (bytes.length > MAX_IMAGE_BYTES) return { ok: false, code: 'image_too_large', refusal: IMAGE_TOO_LARGE, detail: `the image is ${bytes.length} bytes; at most ${MAX_IMAGE_BYTES} (700 KB) is kept` };
  const sniffed = sniffImageType(bytes);
  if (sniffed === undefined || typeof declaredType !== 'string' || !(ALLOWED_IMAGE_TYPES as readonly string[]).includes(declaredType) || declaredType !== sniffed) {
    return { ok: false, code: 'image_type_not_allowed', refusal: IMAGE_TYPE_NOT_ALLOWED, detail: `only a JPEG, PNG or WebP photo is kept${sniffed !== undefined && declaredType !== sniffed ? ` (the file is ${sniffed}, but was sent as ${String(declaredType)})` : ''}` };
  }
  return { ok: true, mediaType: sniffed, bytes: bytes.length };
}

/** One kept version of a product's image — the metadata; the bytes live in the store under `imageId`. */
export interface ProductImageVersion {
  readonly productId: string;
  readonly version: number;
  readonly imageId: string;
  readonly mediaType: ProductImageType;
  readonly bytes: number;
  readonly sha256: string;
  readonly setBy: string;
  readonly setAt: string;
}

/** Where image bytes are kept on the shop's own server. Content-addressed: the same bytes are kept once. */
export interface ProductImageStore {
  put(tenantId: string, imageId: string, mediaType: ProductImageType, bytes: Uint8Array): Promise<void>;
  get(tenantId: string, imageId: string): Promise<{ readonly mediaType: ProductImageType; readonly bytes: Uint8Array } | undefined>;
}

/** A store held in this process — for tests and a bare composition. */
export function inMemoryProductImageStore(): ProductImageStore {
  const held = new Map<string, { mediaType: ProductImageType; bytes: Uint8Array }>();
  return {
    put: async (t, id, mediaType, bytes) => { if (!held.has(`${t}/${id}`)) held.set(`${t}/${id}`, { mediaType, bytes: Uint8Array.from(bytes) }); },
    get: async (t, id) => held.get(`${t}/${id}`),
  };
}

/** The product's current image: its highest version, or undefined (the app then shows none — and works the same). */
export function currentImage(versions: readonly ProductImageVersion[], productId: string): ProductImageVersion | undefined {
  return versions.filter((v) => v.productId === productId).reduce<ProductImageVersion | undefined>((best, v) => (best === undefined || v.version > best.version ? v : best), undefined);
}

// ── The app content completeness score (D01-FR-06) ─────────────────────────────────────────────────────────────────

export interface AppContentForScore {
  readonly nameTa?: string;
  readonly descriptionEn?: string;
  readonly descriptionTa?: string;
  readonly synonyms?: readonly string[];
  readonly hasImage: boolean;
}

export const APP_CONTENT_PARTS = Object.freeze(['Tamil name', 'English description', 'Tamil description', 'synonyms', 'image'] as const);

/** How complete a product's app content is — the share of the five parts present, and which are missing. */
export function appContentCompleteness(c: AppContentForScore): { readonly scorePercent: number; readonly missing: readonly string[] } {
  const missing: string[] = [];
  const blank = (s: string | undefined): boolean => s === undefined || s.trim() === '';
  if (blank(c.nameTa)) missing.push('Tamil name');
  if (blank(c.descriptionEn)) missing.push('English description');
  if (blank(c.descriptionTa)) missing.push('Tamil description');
  if (c.synonyms === undefined || c.synonyms.length === 0) missing.push('synonyms');
  if (!c.hasImage) missing.push('image');
  return { scorePercent: Math.round(((APP_CONTENT_PARTS.length - missing.length) * 100) / APP_CONTENT_PARTS.length), missing };
}
