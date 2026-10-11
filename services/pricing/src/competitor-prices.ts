// Competitor price capture (round 8 · D06-FR-05 "markdown ladder and competitor capture" · M05 · P-02 · P-05 · hard rule #2).
//
// A person who saw a competitor's price — on a shelf visit, on a website, in a flyer — records it here, against one of
// the shop's own products and one of its stores. It is an OBSERVATION, append-only: a re-sent record is the same record,
// a later sighting is a new one, nothing is edited. The comparison read puts beside each product the shop's OWN
// effective price at that store now (the same `resolvePrice` the till's pack is built from) and each competitor's latest
// sighting, with the gap and how old the sighting is.
//
// What it does NOT do: change a price. A gap is information; any change goes through the governed price route
// (`POST /v1/prices/list/:productId/entries/:entryId`, with its MRP / cost / margin-floor checks and §28 approval) by a
// person who holds that permission. No rule here reprices anything by itself.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { resolvePrice, type PriceEntry } from '../../../packages/price-list/src/price-list';

export const COMPETITOR_SOURCES = ['shelf_visit', 'website', 'flyer', 'phone'] as const;
export type CompetitorSource = (typeof COMPETITOR_SOURCES)[number];

export interface CompetitorObservation {
  readonly observationId: string;
  readonly productId: string;
  /** The shop's own store the comparison is for (prices are per store). */
  readonly storeId: string;
  readonly competitor: string;
  readonly priceMinor: number;
  readonly observedAt: string;
  readonly source: CompetitorSource;
  /** A photo or link reference, when the person kept one. */
  readonly evidenceRef?: string;
  /** Pack-size or offer words, when the competitor's item is not the exact same pack. */
  readonly note?: string;
  readonly recordedBy: string;
  readonly recordedAt: string;
}

export interface CompetitorPriceDeps {
  readonly observations: (tenantId: string) => Promise<readonly CompetitorObservation[]> | readonly CompetitorObservation[];
  readonly recordObservation: (tenantId: string, o: CompetitorObservation) => Promise<void> | void;
  /** The shop's own price-list entries for a product (the same register the price route writes). */
  readonly entries: (tenantId: string, productId: string) => Promise<readonly PriceEntry[]> | readonly PriceEntry[];
  /** Whether the product is one the shop has on its master or its published catalogue. */
  readonly productKnown: (tenantId: string, productId: string) => Promise<boolean> | boolean;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isIso = (v: unknown): v is string => isStr(v) && !Number.isNaN(Date.parse(v));
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/;
const same = (a: CompetitorObservation, b: Omit<CompetitorObservation, 'recordedBy' | 'recordedAt'>): boolean =>
  a.productId === b.productId && a.storeId === b.storeId && a.competitor === b.competitor && a.priceMinor === b.priceMinor
  && a.observedAt === b.observedAt && a.source === b.source && a.evidenceRef === b.evidenceRef && a.note === b.note;

export function competitorPriceRoutes(deps: CompetitorPriceDeps): readonly Route[] {
  return [
    {
      // Record one sighting. Body: { productId, storeId, competitor, priceMinor, observedAt, source, evidenceRef?, note? }.
      api: 'API-02', method: 'POST', path: '/v1/prices/competitor/:observationId',
      permission: 'price.change.propose', idempotent: true,
      handler: async (ctx) => {
        const observationId = (ctx.params['observationId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!ID.test(observationId) || !isStr(b['productId']) || !isStr(b['storeId']) || !isStr(b['competitor']) || (b['competitor'] as string).length > 60
          || typeof b['priceMinor'] !== 'number' || !Number.isInteger(b['priceMinor']) || (b['priceMinor'] as number) <= 0
          || !isIso(b['observedAt']) || !COMPETITOR_SOURCES.includes(b['source'] as CompetitorSource)
          || (b['evidenceRef'] !== undefined && !isStr(b['evidenceRef'])) || (b['note'] !== undefined && !(isStr(b['note']) && (b['note'] as string).length <= 200))) {
          throw apiError(400, {
            code: 'not_readable_as_a_competitor_price',
            whatHappened: `A competitor price needs { productId, storeId, competitor (≤ 60 characters), priceMinor (paise, above 0), observedAt (when you saw it), source (${COMPETITOR_SOURCES.join('/')}), evidenceRef?, note? (≤ 200) }.`,
            wasItSaved: 'not_saved', nextSafeAction: 'Say what you saw, where and when.',
          });
        }
        const now = deps.now();
        if (Date.parse(b['observedAt'] as string) > Date.parse(now) + 5 * 60_000) {
          throw apiError(422, { code: 'observed_in_the_future', whatHappened: 'The sighting is dated after now.', wasItSaved: 'not_saved', nextSafeAction: 'Use the time you actually saw the price.' });
        }
        if (!(await deps.productKnown(ctx.tenantId, b['productId'] as string))) {
          throw apiError(422, { code: 'unknown_product', whatHappened: `"${String(b['productId'])}" is not one of this shop's products, so there is nothing to compare it with.`, wasItSaved: 'not_saved', nextSafeAction: 'Record it against the shop\'s own product.' });
        }
        const o: Omit<CompetitorObservation, 'recordedBy' | 'recordedAt'> = {
          observationId, productId: b['productId'] as string, storeId: b['storeId'] as string, competitor: (b['competitor'] as string).trim(),
          priceMinor: b['priceMinor'] as number, observedAt: b['observedAt'] as string, source: b['source'] as CompetitorSource,
          ...(isStr(b['evidenceRef']) ? { evidenceRef: b['evidenceRef'] as string } : {}), ...(isStr(b['note']) ? { note: (b['note'] as string).trim() } : {}),
        };
        const prior = (await deps.observations(ctx.tenantId)).find((x) => x.observationId === observationId);
        if (prior !== undefined) {
          if (same(prior, o)) return { status: 200, body: { observation: prior, alreadyRecorded: true, changesNoPrice: true } };
          throw apiError(409, { code: 'observation_id_used', whatHappened: `Sighting ${observationId} is already recorded with different details; a sighting is never edited.`, wasItSaved: 'not_saved', nextSafeAction: 'Record the new sighting under a new id.' });
        }
        const rec: CompetitorObservation = { ...o, recordedBy: ctx.userId, recordedAt: now };
        await deps.recordObservation(ctx.tenantId, rec);
        return { status: 201, body: { observation: rec, changesNoPrice: true } };
      },
    },
    {
      // The comparison: for each product at a store, the shop's own price now beside each competitor's latest sighting.
      // Query: storeId (required), productId? (one product). Read-only.
      api: 'API-02', method: 'GET', path: '/v1/prices/competitor',
      permission: 'catalogue.pack.read',
      handler: async (ctx) => {
        const storeId = ctx.query['storeId'];
        if (!isStr(storeId)) {
          throw apiError(400, { code: 'store_required', whatHappened: 'The comparison is per store: send ?storeId=… (and ?productId=… for one product).', wasItSaved: 'not_saved', nextSafeAction: 'Name the store.' });
        }
        const only = isStr(ctx.query['productId']) ? ctx.query['productId'] : undefined;
        const now = deps.now();
        const seen = (await deps.observations(ctx.tenantId)).filter((o) => o.storeId === storeId && (only === undefined || o.productId === only));
        const byProduct = new Map<string, Map<string, CompetitorObservation>>();
        for (const o of seen) {
          const forProduct = byProduct.get(o.productId) ?? new Map<string, CompetitorObservation>();
          const held = forProduct.get(o.competitor);
          if (held === undefined || Date.parse(o.observedAt) >= Date.parse(held.observedAt)) forProduct.set(o.competitor, o);
          byProduct.set(o.productId, forProduct);
        }
        const products = [];
        for (const [productId, competitors] of [...byProduct.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
          const ours = resolvePrice(await deps.entries(ctx.tenantId, productId), { productId, at: now, storeId });
          const ourMinor = ours === null ? null : ours.price.minor;
          products.push({
            productId,
            ourPriceMinor: ourMinor,
            ...(ourMinor === null ? { ourPriceNotKnown: 'no effective price for this product at this store today' } : {}),
            competitors: [...competitors.values()].sort((a, b) => a.priceMinor - b.priceMinor || a.competitor.localeCompare(b.competitor)).map((o) => ({
              competitor: o.competitor, priceMinor: o.priceMinor, observedAt: o.observedAt, source: o.source,
              ageDays: Math.floor((Date.parse(now) - Date.parse(o.observedAt)) / 86_400_000),
              observationId: o.observationId, recordedBy: o.recordedBy,
              ...(o.note === undefined ? {} : { note: o.note }),
              // Ours less theirs: positive = the shop is dearer. Not known without our own price — never a zero.
              ...(ourMinor === null ? {} : { gapMinor: ourMinor - o.priceMinor, gapBps: Math.round(((ourMinor - o.priceMinor) * 10_000) / o.priceMinor) }),
            })),
          });
        }
        return { status: 200, body: { storeId, asAt: now, products, count: products.length, changesNoPrice: true, nextSafeAction: 'A price change goes through the price route with its own checks and approval.' } };
      },
    },
  ];
}
