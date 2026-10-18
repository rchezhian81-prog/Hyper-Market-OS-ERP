// API-02 Tobacco pack health warning (roadmap v2.1 B16 · COTPA 2003 s.7 · OB-140 "A") — the register of the warning
// pictures the government has notified, and each tobacco product's confirmation by a NAMED person that its packs carry
// the picture in force. The rule itself is `packages/product/src/tobacco-warning.ts`; this is its persistence and HTTP
// skin. Where it bites:
//
//   • ACTIVATION — the product publish route refuses to put a tobacco product on sale without a confirmation for the
//     picture in force (`product-master.ts`); it is kept as a draft, so it never reaches the pack.
//   • THE PACK — a tobacco product whose confirmation has expired (a new picture is in force) is left out of the next pack,
//     and a confirmed one carries the last day its confirmation is good, so a till with no network stops on that day.
//
// Append-only (hard rules #2, #6): a picture once recorded is never edited — a correction is a new picture id — and a
// confirmation is a new version of the product record, carried forward on every publish. A confirmation names ONE
// product, ONE picture and the person who gave it; there is no "confirm all" and no override.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  isTobacco, warningStanding, pictureInForce, nextPicture,
  type ProductRecord, type WarningImage, type WarningConfirmation, type TobaccoWarningRecord,
} from '../../../packages/product/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';

export interface TobaccoWarningDeps {
  readonly pictures: (tenantId: string) => Promise<readonly WarningImage[]>;
  readonly recordPicture: (tenantId: string, picture: WarningImage) => Promise<void>;
  readonly product: (tenantId: string, productId: string) => Promise<ProductRecord | undefined>;
  readonly products: (tenantId: string) => Promise<readonly ProductRecord[]>;
  /** A new version of the product master (append-only), idempotent on `key`. */
  readonly publish: (tenantId: string, record: ProductRecord, key: string) => Promise<void>;
  /** The person's name as head office holds it; undefined when it holds none (the id is then the name on the record). */
  readonly personName?: (tenantId: string, userId: string) => Promise<string | undefined>;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now: () => string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (v: unknown): v is string => typeof v === 'string' && DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const text = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() !== '' && v.trim().length <= max ? v.trim() : undefined);
const notReadable = (what: string): never => {
  throw apiError(400, { code: 'not_readable_as_a_warning_record', whatHappened: what, wasItSaved: 'not_saved', nextSafeAction: 'Correct it and send again. Nothing was saved.' });
};

/** A tobacco product's warning record with the picture register as head office now holds it. */
const withPictures = (record: TobaccoWarningRecord | undefined, pictures: readonly WarningImage[]): TobaccoWarningRecord => ({
  images: [...pictures], confirmations: [...(record?.confirmations ?? [])],
});

export function tobaccoWarningRoutes(deps: TobaccoWarningDeps): readonly Route[] {
  return [
    {
      // Record a health-warning picture the government notified. Append-only: the same id with the same facts is the same
      // record (a retry); the same id with different facts is refused — a correction is a NEW picture id. Every tobacco
      // product already confirmed learns the new picture, so its confirmation runs out the day the picture comes in.
      api: 'API-02', method: 'POST', path: '/v1/catalogue/tobacco-warning-pictures/:imageId',
      permission: 'catalogue.tobacco.picture.record', idempotent: true,
      handler: async (ctx) => {
        const imageId = (ctx.params['imageId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const today = deps.now().slice(0, 10);
        if (!/^[A-Za-z0-9._-]{1,40}$/.test(imageId)) notReadable('The picture id must be up to 40 letters, digits, dots, dashes or underscores.');
        if (!isDate(b['effectiveFrom']) || !isDate(b['notifiedOn'])) notReadable('effectiveFrom and notifiedOn must be dates (YYYY-MM-DD).');
        const reference = text(b['reference'], 120) ?? notReadable('reference must name the notification (for example "G.S.R. 458(E)").');
        const evidenceRef = text(b['evidenceRef'], 200) ?? notReadable('evidenceRef must say where the notification itself is kept.');
        if ((b['notifiedOn'] as string) > today) notReadable('A picture cannot be notified in the future — notifiedOn is after today.');
        if ((b['effectiveFrom'] as string) < (b['notifiedOn'] as string)) notReadable('effectiveFrom cannot be before the day it was notified.');
        const pictures = await deps.pictures(ctx.tenantId);
        const held = pictures.find((p) => p.imageId === imageId);
        const facts = { effectiveFrom: b['effectiveFrom'] as string, notifiedOn: b['notifiedOn'] as string, reference, evidenceRef };
        if (held !== undefined) {
          if (held.effectiveFrom === facts.effectiveFrom && held.notifiedOn === facts.notifiedOn && held.reference === reference && held.evidenceRef === evidenceRef) {
            return { status: 200, body: { picture: held, alreadyRecorded: true } };
          }
          throw apiError(409, {
            code: 'picture_already_recorded_differently', whatHappened: `Picture ${imageId} is already recorded with different facts. A recorded picture is never changed.`,
            wasItSaved: 'not_saved', nextSafeAction: 'Record the correct picture under a new id. Nothing was changed.',
          });
        }
        const picture: WarningImage = { imageId, ...facts, recordedBy: ctx.userId, recordedAt: deps.now() };
        await deps.recordPicture(ctx.tenantId, picture);
        const register = [...pictures, picture];
        // Each tobacco product that holds confirmations learns the register — a new version of its record (append-only).
        const stamped: string[] = [];
        for (const p of await deps.products(ctx.tenantId)) {
          if (!isTobacco(p) || p.tobaccoWarning === undefined) continue;
          await deps.publish(ctx.tenantId, { ...p, tobaccoWarning: withPictures(p.tobaccoWarning, register) }, `tobacco-picture-${imageId}`);
          stamped.push(p.productId);
        }
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'tobacco.warning.picture.record', objectType: 'tobacco_warning_picture', objectId: imageId,
          at: deps.now(), origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: null,
          after: { effectiveFrom: facts.effectiveFrom, notifiedOn: facts.notifiedOn, reference }, correlationId: imageId,
        });
        return {
          status: 201,
          body: {
            picture,
            // P-03: who must act, and by when — each of these stops selling on the day the picture comes in unless confirmed.
            productsToConfirmAgain: stamped.sort(),
            detail: stamped.length === 0
              ? `Picture ${imageId} recorded. No tobacco product holds a confirmation yet.`
              : `Picture ${imageId} recorded. ${stamped.length} tobacco product(s) must be confirmed again for it before ${facts.effectiveFrom}, or they come off sale that day.`,
          },
        };
      },
    },
    {
      // The pictures on record, the one in force today and the next one notified.
      api: 'API-02', method: 'GET', path: '/v1/catalogue/tobacco-warning-pictures',
      permission: 'catalogue.pack.read',
      handler: async (ctx) => {
        const pictures = [...(await deps.pictures(ctx.tenantId))].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1));
        const today = deps.now().slice(0, 10);
        return { status: 200, body: { pictures, inForce: pictureInForce(pictures, today) ?? null, next: nextPicture(pictures, today) ?? null, today } };
      },
    },
    {
      // A NAMED person confirms that this tobacco product's packs carry the warning picture — the one in force, or a newly
      // notified one before it comes in. One product, one picture, one person; recorded on the product (a new version).
      api: 'API-02', method: 'POST', path: '/v1/catalogue/products/:productId/tobacco-warning-confirmation',
      permission: 'catalogue.tobacco.warning.confirm', idempotent: true,
      handler: async (ctx) => {
        const productId = (ctx.params['productId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const imageId = text(b['imageId'], 40) ?? notReadable('imageId must name the warning picture the packs carry.');
        const evidenceRef = text(b['evidenceRef'], 200) ?? notReadable('evidenceRef must say what was looked at (a photograph of the pack, a delivery note).');
        const product = await deps.product(ctx.tenantId, productId);
        if (product === undefined) throw notFound(`product ${productId}`);
        if (!isTobacco(product)) {
          throw apiError(422, { code: 'not_a_tobacco_product', whatHappened: `${product.name} is not recorded as tobacco, so it has no health-warning picture to confirm.`, wasItSaved: 'not_saved', nextSafeAction: 'Check the product. Nothing was saved.' });
        }
        const pictures = await deps.pictures(ctx.tenantId);
        const today = deps.now().slice(0, 10);
        const picture = pictures.find((p) => p.imageId === imageId);
        if (picture === undefined) throw notFound(`warning picture ${imageId}`);
        const inForce = pictureInForce(pictures, today);
        // Only the picture in force, or one notified to come in later: confirming an old picture would put back on sale a
        // product whose packs nobody has checked against the current one.
        if (picture.effectiveFrom <= today && inForce?.imageId !== picture.imageId) {
          throw apiError(422, {
            code: 'picture_not_in_force', whatHappened: `Picture ${imageId} has been replaced by ${inForce?.imageId ?? 'a later picture'} — confirming it would not let ${product.name} be sold.`,
            wasItSaved: 'not_saved', nextSafeAction: `Check the packs against picture ${inForce?.imageId ?? 'in force'} and confirm that one. Nothing was saved.`,
          });
        }
        const already = (product.tobaccoWarning?.confirmations ?? []).find((c) => c.imageId === imageId);
        if (already !== undefined) {
          return { status: 200, body: { product, confirmation: already, alreadyConfirmed: true, standing: warningStanding(product.tobaccoWarning, today) } };
        }
        const confirmation: WarningConfirmation = {
          imageId, confirmedBy: ctx.userId, confirmedByName: (await deps.personName?.(ctx.tenantId, ctx.userId)) ?? ctx.userId,
          confirmedAt: deps.now(), evidenceRef,
        };
        const record: ProductRecord = {
          ...product,
          tobaccoWarning: { images: [...pictures], confirmations: [...(product.tobaccoWarning?.confirmations ?? []), confirmation] },
        };
        await deps.publish(ctx.tenantId, record, `tobacco-confirm-${imageId}-${ctx.idempotencyKey ?? productId}`);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'tobacco.warning.confirm', objectType: 'product', objectId: productId,
          at: deps.now(), origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: null,
          after: { imageId, evidenceRef, confirmedBy: confirmation.confirmedBy }, correlationId: `${productId}:${imageId}`,
        });
        const standing = warningStanding(record.tobaccoWarning, today);
        return {
          status: 201,
          body: {
            product: record, confirmation, standing,
            nextSafeAction: record.lifecycle === 'draft'
              ? 'Publish the product again to put it on sale; it reaches the tills on the next catalogue pack.'
              : 'It reaches the tills on the next catalogue pack.',
          },
        };
      },
    },
    {
      // Every tobacco product's standing today — confirmed (and until when), never confirmed, or expired. P-03: the ones
      // that cannot be sold come first.
      api: 'API-02', method: 'GET', path: '/v1/catalogue/tobacco-warning',
      permission: 'catalogue.pack.read',
      handler: async (ctx) => {
        const today = deps.now().slice(0, 10);
        const rows = (await deps.products(ctx.tenantId)).filter(isTobacco).map((p) => {
          const s = warningStanding(p.tobaccoWarning, today);
          return s.sellable
            ? { productId: p.productId, name: p.name, sellable: true, standing: s.reason, picture: s.image.imageId, confirmedBy: s.confirmation.confirmedByName, confirmedAt: s.confirmation.confirmedAt, goodUntil: s.goodUntil ?? null }
            : { productId: p.productId, name: p.name, sellable: false, standing: s.reason, picture: s.image?.imageId ?? null, detail: s.detail };
        }).sort((a, b) => (a.sellable === b.sellable ? (a.productId < b.productId ? -1 : 1) : a.sellable ? 1 : -1));
        return { status: 200, body: { today, products: rows, notSellable: rows.filter((r) => !r.sellable).length } };
      },
    },
  ];
}
