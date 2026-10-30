// D-13 (R4, OB-219) — a photo on a shelf check, the planogram score per bay with every gap named, and image recognition
// built as a switched-off link.
//
//   POST /v1/merchandising/shelf-photos/:photoId    { storeId, aisle, rack, bay, mediaType, contentBase64, countIds? }
//        the photo of one bay, kept on the shop's OWN server (head office's store, OB-215) — checked for type ("image type
//        not allowed") and size ("image too large"), against a bay the store's shelf map has. A photo is a record: a re-send
//        is the same photo; a different picture under the same id is refused; nothing is edited.
//   GET  /v1/merchandising/shelf-photos?storeId=     the photos (without their bytes);  GET …/shelf-photos/:photoId  one, with them
//   GET  /v1/merchandising/planogram-compliance/bays?storeId=&staleAfterMinutes=
//        the planogram in force compared with the STAFF counts, scored per bay (aisle, rack, bay) over the facings observed,
//        every gap named ("empty, stock in back", "empty, none in building", "never counted", "counted too long ago", …),
//        each bay's photos listed. "In the building" is head office's own on-hand at the store.
//
// Recognition: the running system composes `SWITCHED_OFF_SHELF_RECOGNITION`, which sends nothing — no photo leaves the shop
// and every score says "counted by staff". A link that is on (only the test stand-in exists) is asked about a bay's photos
// and its answer is shown as a SUGGESTION beside the staff count; the score stays the staff count's. Reads write nothing.

import { createHash } from 'node:crypto';
import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { planogramCompliance, latestCounts, type ShelfCount, type ShelfLocation, type ShelfState } from '../../../packages/merchandising/src/index';
import { scoreByBay, bayKeyOf, type BayScore } from '../../../packages/merchandising/src/bay-compliance';
import type { ShelfImageRecognition, RecognisedFacing } from '../../../packages/merchandising/src/shelf-image-port';
import { inForcePlanogram, shelfMapFor, noShelfMap, noPlanogram, shopZoneOf, type StoredShelfMap, type StoredPlanogram } from './planograms';
import type { ShopCalendarOf } from '../../../packages/calendar/src/shop-clock';

/** The media types a shelf photo may be. */
export const SHELF_PHOTO_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp'] as const);
/** The largest photo kept, in bytes — the ledger's own cap for a stored document (OB-45, 700 KB). */
export const SHELF_PHOTO_MAX_BYTES = 700 * 1024;

export interface StoredShelfPhoto {
  readonly photoId: string;
  readonly storeId: string;
  readonly aisle: number;
  readonly rack: number;
  readonly bay: number;
  readonly bayKey: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly contentBase64: string;
  readonly countIds: readonly string[];
  readonly takenBy: string;
  readonly takenAt: string;
}

export interface ShelfBayComplianceDeps {
  readonly now: () => string;
  /** R16-A (M01-FR-02): the shop's calendar — the plan in force "today" is the shop's today, never the UTC date. */
  readonly calendar?: ShopCalendarOf;
  readonly photos: (tenantId: string, storeId: string) => Promise<readonly StoredShelfPhoto[]>;
  readonly recordPhoto: (tenantId: string, photo: StoredShelfPhoto) => Promise<void>;
  readonly counts: (tenantId: string, storeId: string) => Promise<readonly ShelfCount[]>;
  readonly shelfMap: (tenantId: string, storeId: string) => Promise<StoredShelfMap | undefined>;
  readonly planograms: (tenantId: string, storeId: string) => Promise<readonly StoredPlanogram[]>;
  /** Head office's on-hand per product at the store — what is "in the building". */
  readonly onHandAtStore: (tenantId: string, storeId: string) => Promise<Readonly<Record<string, number>>>;
  /** The recognition link. The running system composes the switched-off one. */
  readonly recognition: ShelfImageRecognition;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isWhole = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/;
const withoutBytes = (p: StoredShelfPhoto): Omit<StoredShelfPhoto, 'contentBase64'> => { const { contentBase64: _c, ...rest } = p; void _c; return rest; };

export function shelfBayComplianceRoutes(deps: ShelfBayComplianceDeps): readonly Route[] {
  return [
    {
      api: 'API-04', method: 'POST', path: '/v1/merchandising/shelf-photos/:photoId',
      permission: 'shelf.count.record', idempotent: true,
      handler: async (ctx) => {
        const photoId = (ctx.params['photoId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const countIds = b['countIds'];
        if (!ID.test(photoId) || !isStr(b['storeId']) || !isWhole(b['aisle']) || !isWhole(b['rack']) || !isWhole(b['bay'])
          || !isStr(b['mediaType']) || !isStr(b['contentBase64'])
          || (countIds !== undefined && !(Array.isArray(countIds) && countIds.every((c) => isStr(c))))) {
          throw apiError(400, {
            code: 'not_readable_as_a_shelf_photo', whatHappened: 'A shelf photo needs { storeId, aisle, rack, bay, mediaType, contentBase64, countIds? }.',
            wasItSaved: 'not_saved', nextSafeAction: 'Take the photo again from the shelf-check screen. Nothing was kept.',
          });
        }
        if (!(SHELF_PHOTO_TYPES as readonly string[]).includes(b['mediaType'] as string)) {
          throw apiError(415, { code: 'image_type_not_allowed', whatHappened: `image type not allowed: ${String(b['mediaType'])} — a shelf photo is ${SHELF_PHOTO_TYPES.join(', ')}.`, wasItSaved: 'not_saved', nextSafeAction: 'Take the photo with the phone camera (JPEG). Nothing was kept.' });
        }
        const bytes = Buffer.from(b['contentBase64'] as string, 'base64');
        if (bytes.length === 0) throw apiError(400, { code: 'not_readable_as_a_shelf_photo', whatHappened: 'The photo is empty.', wasItSaved: 'not_saved', nextSafeAction: 'Take the photo again. Nothing was kept.' });
        if (bytes.length > SHELF_PHOTO_MAX_BYTES) {
          throw apiError(413, { code: 'image_too_large', whatHappened: `image too large: ${bytes.length} bytes — a shelf photo is at most ${SHELF_PHOTO_MAX_BYTES} bytes (700 KB).`, wasItSaved: 'not_saved', nextSafeAction: 'Take a smaller photo (a lower camera setting). Nothing was kept.' });
        }
        const storeId = (b['storeId'] as string).trim();
        const map = await deps.shelfMap(ctx.tenantId, storeId);
        if (map === undefined) noShelfMap(storeId);
        const key = { aisle: b['aisle'] as number, rack: b['rack'] as number, bay: b['bay'] as number };
        if (!map!.locations.some((l) => l.aisle === key.aisle && l.rack === key.rack && l.bay === key.bay)) {
          throw apiError(422, { code: 'no_such_bay', whatHappened: `The shelf map of ${storeId} has no bay ${bayKeyOf(key)}.`, wasItSaved: 'not_saved', nextSafeAction: 'Pick the bay from the shelf map. Nothing was kept.' });
        }
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const prior = (await deps.photos(ctx.tenantId, storeId)).find((p) => p.photoId === photoId);
        if (prior !== undefined) {
          if (prior.sha256 === sha256 && prior.bayKey === bayKeyOf(key)) return { status: 200, body: { photo: withoutBytes(prior), alreadyRecorded: true, sentAnywhere: false } };
          throw apiError(409, { code: 'photo_id_used', whatHappened: `Photo ${photoId} is already kept with a different picture or bay; a photo is never replaced.`, wasItSaved: 'not_saved', nextSafeAction: 'Keep the new photo under a new id.' });
        }
        const photo: StoredShelfPhoto = {
          photoId, storeId, ...key, bayKey: bayKeyOf(key), mediaType: b['mediaType'] as string, bytes: bytes.length, sha256,
          contentBase64: b['contentBase64'] as string, countIds: (countIds as string[] | undefined) ?? [], takenBy: ctx.userId, takenAt: deps.now(),
        };
        await deps.recordPhoto(ctx.tenantId, photo);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'merchandising.shelf_photo.keep', objectType: 'shelf_photo', objectId: photoId, at: photo.takenAt,
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: null,
          after: { storeId, bayKey: photo.bayKey, bytes: String(photo.bytes), sha256 }, correlationId: photoId,
        });
        // Kept here; never handed to the recognition link on the way in.
        return { status: 201, body: { photo: withoutBytes(photo), sentAnywhere: false } };
      },
    },
    {
      api: 'API-04', method: 'GET', path: '/v1/merchandising/shelf-photos',
      permission: 'shelf.count.read',
      handler: async (ctx) => {
        const storeId = (ctx.query['storeId'] ?? '').trim();
        if (storeId === '') throw apiError(400, { code: 'store_required', whatHappened: 'Send ?storeId=….', wasItSaved: 'not_saved', nextSafeAction: 'Name the store.' });
        const photos = (await deps.photos(ctx.tenantId, storeId)).map(withoutBytes);
        return { status: 200, body: { storeId, photos, count: photos.length } };
      },
    },
    {
      api: 'API-04', method: 'GET', path: '/v1/merchandising/shelf-photos/:photoId',
      permission: 'shelf.count.read',
      handler: async (ctx) => {
        const photoId = (ctx.params['photoId'] ?? '').trim();
        const storeId = (ctx.query['storeId'] ?? '').trim();
        const photo = storeId === '' ? undefined : (await deps.photos(ctx.tenantId, storeId)).find((p) => p.photoId === photoId);
        if (photo === undefined) throw notFound(`shelf photo ${photoId}${storeId === '' ? ' (send ?storeId=)' : ` at ${storeId}`}`);
        return { status: 200, body: { photo } };
      },
    },
    {
      api: 'API-04', method: 'GET', path: '/v1/merchandising/planogram-compliance/bays',
      permission: 'planogram.compliance.read',
      handler: async (ctx) => {
        const storeId = (ctx.query['storeId'] ?? '').trim();
        const staleRaw = Number(ctx.query['staleAfterMinutes']);
        const staleAfterMinutes = Number.isSafeInteger(staleRaw) && staleRaw > 0 ? staleRaw : 240;
        if (storeId === '') throw apiError(400, { code: 'store_required', whatHappened: 'The bay score is per store: send ?storeId=….', wasItSaved: 'not_saved', nextSafeAction: 'Name the store. Nothing was changed; this only reads.' });
        const stored = await deps.shelfMap(ctx.tenantId, storeId);
        if (stored === undefined) noShelfMap(storeId);
        const plan = inForcePlanogram(await deps.planograms(ctx.tenantId, storeId), deps.now(), await shopZoneOf(deps.calendar, ctx.tenantId));
        if (plan === undefined) noPlanogram(storeId);
        const map = shelfMapFor(stored!, plan!.assignments);
        const asOf = deps.now();
        const { latest } = latestCounts(await deps.counts(ctx.tenantId, storeId), asOf, staleAfterMinutes);
        const shelfState: ShelfState[] = latest.map((c) => ({ productId: c.productId, locationId: c.locationId, onShelfMinor: c.countedMinor, observedAt: c.at }));
        const backstock = await deps.onHandAtStore(ctx.tenantId, storeId);
        const run = planogramCompliance({ planogram: plan!, map, shelfState, backstock, assignedRole: 'store_manager', asOf, staleAfterMinutes });
        const locations: readonly ShelfLocation[] = stored!.locations;
        const scored = scoreByBay({ planogram: plan!, locations, issues: run.issues, backstock });
        const photos = await deps.photos(ctx.tenantId, storeId);
        const off = deps.recognition.state === 'switched_off';
        const bays: (BayScore & { photos: { photoId: string; takenAt: string; takenBy: string }[]; recognitionSuggestion?: readonly RecognisedFacing[] })[] = [];
        let photosSent = 0;
        for (const b of scored) {
          const own = photos.filter((p) => p.bayKey === b.bayKey).sort((x, y) => x.takenAt.localeCompare(y.takenAt));
          const latestPhoto = own.at(-1);
          let suggestion: readonly RecognisedFacing[] | undefined;
          // Switched off: nothing is sent — the link is never even asked.
          if (!off && latestPhoto !== undefined) {
            suggestion = await deps.recognition.recognise({ photoId: latestPhoto.photoId, mediaType: latestPhoto.mediaType, contentBase64: latestPhoto.contentBase64 });
            photosSent += 1;
          }
          bays.push({ ...b, photos: own.map((p) => ({ photoId: p.photoId, takenAt: p.takenAt, takenBy: p.takenBy })), ...(suggestion === undefined ? {} : { recognitionSuggestion: suggestion }) });
        }
        return {
          status: 200,
          body: {
            storeId, asOf, staleAfterMinutes, planogramId: plan!.planogramId, planogramVersion: plan!.version,
            bays, measuredBy: 'counted by staff',
            recognition: { state: deps.recognition.state, detail: deps.recognition.detail, photosSent, changesTheScore: false },
          },
        };
      },
    },
  ];
}
