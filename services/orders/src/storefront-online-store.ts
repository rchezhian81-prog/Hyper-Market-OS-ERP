// The online store's display duties and its own-goods rule, on API-07 (R4 · B23 · A26 · OB-211 · OB-223 · P-08).
//
//   • THE SHOP'S DETAILS (legal name, address, GSTIN, return and refund terms, grievance officer name and contact) are set
//     by the owner as VERSIONS — append-only, the latest in force. A detail never set reads "not set", everywhere.
//   • THE ONLINE STORE is published only once every one of them is set. OB-223: the grievance officer is not named yet, so
//     publishing is REFUSED by name ("online listing incomplete: grievance officer name") until he is.
//   • A PRODUCT is published online only when it carries every duty (MRP, price with tax, delivery fee, best-before where it
//     carries one, country of origin, and the shop's details) — else "online listing incomplete: <field>". It still sells
//     in the shop: nothing here reaches the till.
//   • A26 · OB-211: another seller's goods — a concession tenant's included — are refused online by name ("other seller's
//     goods: not sold online"), and the refusal is kept. The GST line reads "TCS (section 52): not applicable: own goods
//     only".
//   • THE CUSTOMER reads, before paying, every duty for every product the shop has published online — each value or
//     "not set" — with the privacy and terms pages linked from every page of the app (static pages, no sign-in).
//   • THE COMPLAINT CLOCK: an online complaint (raised in the app) is acknowledged within 48 hours, and one not resolved
//     within a month is an exception for the owner.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  checkOnlineListing, complaintClock, listingLines, onlineStorePublishable, shopDetailsMissing, NOT_SET, TCS_LINE, OTHER_SELLER_REFUSAL,
  type OnlineDeliveryTerms, type OnlineListingFacts, type OnlineShopDetails,
} from '../../../packages/storefront/src/listing-duties';
import type { RatingSummary } from '../../../packages/storefront/src/ratings';
import type { AuditEntry } from '../../../packages/audit/src/index';

/** One fact on the online listing register — append-only. */
export type OnlineListingRecord =
  | { readonly kind: 'published'; readonly productId: string; readonly by: string; readonly at: string }
  | { readonly kind: 'withdrawn'; readonly productId: string; readonly reason: string; readonly by: string; readonly at: string }
  | { readonly kind: 'refused'; readonly productId: string; readonly refusal: string; readonly missing: readonly string[]; readonly otherSeller?: string; readonly by: string; readonly at: string };

/** The online store's own publication — once every shop detail is set. */
export interface OnlineStorePublication { readonly version: number; readonly detailsVersion: number; readonly by: string; readonly at: string }

/** An online complaint as the clock reads it — a case raised in the app. */
export interface OnlineComplaint { readonly caseId: string; readonly openedAt: string; readonly firstRespondedAt?: string; readonly resolvedAt?: string; readonly state: string }

export interface OnlineStoreDeps {
  readonly shopDetails: (tenantId: string) => Promise<readonly OnlineShopDetails[]>;
  readonly recordShopDetails: (tenantId: string, d: OnlineShopDetails) => Promise<void>;
  /** Every product the shop's published catalogue carries. */
  readonly catalogueProducts: (tenantId: string) => Promise<readonly string[]>;
  /** The listing facts for one product, or undefined when the published catalogue does not carry it. */
  readonly listingFacts: (tenantId: string, productId: string) => Promise<OnlineListingFacts | undefined>;
  readonly deliveryTerms: (tenantId: string) => Promise<OnlineDeliveryTerms>;
  readonly listings: (tenantId: string) => Promise<readonly OnlineListingRecord[]>;
  readonly recordListing: (tenantId: string, r: OnlineListingRecord, key: string) => Promise<void>;
  readonly publications: (tenantId: string) => Promise<readonly OnlineStorePublication[]>;
  readonly recordPublication: (tenantId: string, p: OnlineStorePublication) => Promise<void>;
  /** Cases raised in the customer app (complaints and return requests). */
  readonly onlineComplaints: (tenantId: string) => Promise<readonly OnlineComplaint[]>;
  /** M20-FR-04: the product's stars (average and count, never a name). */
  readonly ratingSummary?: (tenantId: string, productId: string) => Promise<RatingSummary>;
  /** D01-FR-06: the product's current image on the shop's own server, when it has one. */
  readonly imageOf?: (tenantId: string, productId: string) => Promise<{ readonly version: number; readonly mediaType: string } | undefined>;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const DETAIL_KEYS = ['legalName', 'address', 'gstin', 'returnTerms', 'grievanceOfficerName', 'grievanceOfficerContact'] as const;
type DetailKey = (typeof DETAIL_KEYS)[number];
const MAX: Record<DetailKey, number> = { legalName: 200, address: 500, gstin: 15, returnTerms: 2_000, grievanceOfficerName: 120, grievanceOfficerContact: 200 };

const latest = <T extends { readonly version: number }>(xs: readonly T[]): T | undefined => xs.reduce<T | undefined>((b, x) => (b === undefined || x.version > b.version ? x : b), undefined);

/** Whether each product is published online now: its latest published / withdrawn record. */
export function listedNow(records: readonly OnlineListingRecord[]): ReadonlySet<string> {
  const state = new Map<string, boolean>();
  for (const r of [...records].sort((a, b) => a.at.localeCompare(b.at))) {
    if (r.kind === 'published') state.set(r.productId, true);
    else if (r.kind === 'withdrawn') state.set(r.productId, false);
  }
  return new Set([...state.entries()].filter(([, v]) => v).map(([k]) => k));
}

/** OB-234: whether a product may be sold online NOW — or Lane 2's own words for why not. */
export type OnlineSaleVerdict = { readonly soldOnline: true } | { readonly soldOnline: false; readonly refusal: string };

/**
 * OB-234: the same answer the customer's listing gives (`soldOnline`): published online (its latest listing record) AND
 * still carrying every duty. Else Lane 2's wording: "online listing incomplete: <field>", "other seller's goods: not sold
 * online", or "not sold online: not published online yet" / "not sold online: not in the published catalogue".
 */
export async function onlineSaleOf(deps: Pick<OnlineStoreDeps, 'shopDetails' | 'listingFacts' | 'deliveryTerms' | 'listings'>, tenantId: string, productId: string): Promise<OnlineSaleVerdict> {
  const facts = await deps.listingFacts(tenantId, productId);
  if (facts === undefined) return { soldOnline: false, refusal: 'not sold online: not in the published catalogue' };
  const verdict = checkOnlineListing(facts, latest(await deps.shopDetails(tenantId)), await deps.deliveryTerms(tenantId));
  if (!verdict.publishable) return { soldOnline: false, refusal: verdict.refusal };
  if (!listedNow(await deps.listings(tenantId)).has(productId)) return { soldOnline: false, refusal: 'not sold online: not published online yet' };
  return { soldOnline: true };
}

export function onlineStoreRoutes(deps: OnlineStoreDeps): readonly Route[] {
  const details = async (t: string): Promise<OnlineShopDetails | undefined> => latest(await deps.shopDetails(t));
  const detailView = (d: OnlineShopDetails | undefined) => ({
    version: d?.version ?? 0,
    ...Object.fromEntries(DETAIL_KEYS.map((k) => [k, isStr(d?.[k]) ? d![k] : NOT_SET])),
    missing: shopDetailsMissing(d),
    ...(d === undefined ? {} : { setBy: d.setBy, setAt: d.setAt }),
  });
  const verdictFor = async (t: string, productId: string, d: OnlineShopDetails | undefined, terms: OnlineDeliveryTerms) => {
    const facts = await deps.listingFacts(t, productId);
    return facts === undefined ? undefined : { facts, verdict: checkOnlineListing(facts, d, terms) };
  };

  return [
    {
      // The shop's own details every listing carries — each value or "not set" — and what is still missing.
      api: 'API-07', method: 'GET', path: '/v1/online-store/details',
      permission: 'online.store.read',
      handler: async (ctx) => {
        const all = await deps.shopDetails(ctx.tenantId);
        const d = latest(all);
        const pubs = await deps.publications(ctx.tenantId);
        const store = onlineStorePublishable(d);
        return { status: 200, body: {
          details: detailView(d), history: [...all].sort((a, b) => b.version - a.version).map((x) => ({ version: x.version, setBy: x.setBy, setAt: x.setAt })),
          onlineStore: { publishable: store.publishable, ...(store.refusal === undefined ? {} : { refusal: store.refusal }), published: latest(pubs) ?? null },
          tcs: TCS_LINE,
        } };
      },
    },
    {
      // Set the shop's details: a NEW VERSION (a field sent as null is cleared, a field left out is kept). Body: { …, reason }.
      api: 'API-07', method: 'POST', path: '/v1/online-store/details',
      permission: 'online.store.manage', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const problems: string[] = [];
        for (const k of DETAIL_KEYS) {
          const v = b[k];
          if (v === undefined || v === null) continue;
          if (typeof v !== 'string' || v.trim() === '' || v.trim().length > MAX[k]) problems.push(`${k} must be words, at most ${MAX[k]} characters (or null to clear it)`);
        }
        if (!isStr(b['reason'])) problems.push('a reason is needed — the next person reads why the details changed');
        if (problems.length > 0) throw apiError(400, { code: 'not_readable_as_shop_details', whatHappened: `The details were not saved: ${problems.join('; ')}.`, wasItSaved: 'not_saved', nextSafeAction: 'Correct it and send again. Nothing was changed.' });
        const all = await deps.shopDetails(ctx.tenantId);
        const before = latest(all);
        const merged: Record<string, string> = {};
        for (const k of DETAIL_KEYS) {
          const v = b[k];
          const kept = v === null ? undefined : typeof v === 'string' ? v.trim() : before?.[k];
          if (kept !== undefined) merged[k] = kept;
        }
        const d: OnlineShopDetails = { ...merged, version: (before?.version ?? 0) + 1, setBy: ctx.userId, setAt: deps.now() };
        await deps.recordShopDetails(ctx.tenantId, d);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'online_store.details_set', objectType: 'online_store_details', objectId: `v${d.version}`, at: d.setAt,
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: before === undefined ? null : { version: String(before.version) },
          after: { version: String(d.version), stillNotSet: shopDetailsMissing(d).join(', ') || 'nothing' },
          reason: (b['reason'] as string).trim(),
        });
        return { status: 201, body: { details: detailView(d) } };
      },
    },
    {
      // Publish the online store — refused by name while any of the shop's details is not set (OB-223: the grievance officer).
      api: 'API-07', method: 'POST', path: '/v1/online-store/publish',
      permission: 'online.store.manage', idempotent: true,
      handler: async (ctx) => {
        const d = await details(ctx.tenantId);
        const check = onlineStorePublishable(d);
        if (!check.publishable) {
          throw apiError(409, { code: 'online_listing_incomplete', whatHappened: `${check.refusal}. Still not set: ${check.missing.join(', ')}.`, wasItSaved: 'not_saved', nextSafeAction: 'Set every detail on the Online store page, then publish again. The shop keeps trading as before.' });
        }
        const pubs = await deps.publications(ctx.tenantId);
        const held = latest(pubs);
        if (held !== undefined && held.detailsVersion === d!.version) return { status: 200, body: { publication: held, alreadyPublished: true } };
        const p: OnlineStorePublication = { version: (held?.version ?? 0) + 1, detailsVersion: d!.version, by: ctx.userId, at: deps.now() };
        await deps.recordPublication(ctx.tenantId, p);
        return { status: 201, body: { publication: p } };
      },
    },
    {
      // Every catalogue product's online listing: publishable or not (with what is missing), and whether it is listed.
      api: 'API-07', method: 'GET', path: '/v1/online-store/listings',
      permission: 'online.store.read',
      handler: async (ctx) => {
        const d = await details(ctx.tenantId);
        const terms = await deps.deliveryTerms(ctx.tenantId);
        const listed = listedNow(await deps.listings(ctx.tenantId));
        const rows = [];
        for (const productId of await deps.catalogueProducts(ctx.tenantId)) {
          const v = await verdictFor(ctx.tenantId, productId, d, terms);
          if (v === undefined) continue;
          rows.push({
            productId, name: v.facts.name, listed: listed.has(productId), publishable: v.verdict.publishable,
            ...(v.verdict.publishable ? {} : { refusal: v.verdict.refusal, missing: v.verdict.missing }),
            lines: listingLines(v.facts, d, terms).lines,
          });
        }
        return { status: 200, body: { listings: rows, count: rows.length, listedCount: rows.filter((r) => r.listed).length, tcs: TCS_LINE } };
      },
    },
    {
      // Publish a product online, or withdraw it. Body: { action: 'publish' | 'withdraw', reason? }.
      api: 'API-07', method: 'POST', path: '/v1/online-store/listings/:productId',
      permission: 'online.store.manage', idempotent: true,
      handler: async (ctx) => {
        const productId = (ctx.params['productId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (b['action'] !== 'publish' && b['action'] !== 'withdraw') {
          throw apiError(400, { code: 'not_readable_as_a_listing_action', whatHappened: 'A listing change needs { action: "publish" or "withdraw", reason? (needed to withdraw) }.', wasItSaved: 'not_saved', nextSafeAction: 'Nothing was changed.' });
        }
        const at = deps.now();
        const key = `${productId}-${b['action']}-${ctx.idempotencyKey ?? at}`;
        if (b['action'] === 'withdraw') {
          if (!isStr(b['reason'])) throw apiError(400, { code: 'reason_required', whatHappened: 'Withdrawing a product from the online store needs a reason.', wasItSaved: 'not_saved', nextSafeAction: 'Say why, and send again.' });
          await deps.recordListing(ctx.tenantId, { kind: 'withdrawn', productId, reason: (b['reason'] as string).trim(), by: ctx.userId, at }, key);
          return { status: 200, body: { productId, listed: false } };
        }
        const v = await verdictFor(ctx.tenantId, productId, await details(ctx.tenantId), await deps.deliveryTerms(ctx.tenantId));
        if (v === undefined) throw notFound(`product ${productId} in the published catalogue`);
        if (!v.verdict.publishable) {
          // Kept: who tried to list what, and why it was refused (A26: another seller's goods are visible to the owner).
          await deps.recordListing(ctx.tenantId, { kind: 'refused', productId, refusal: v.verdict.refusal, missing: v.verdict.missing, ...(v.verdict.otherSeller === undefined ? {} : { otherSeller: v.verdict.otherSeller }), by: ctx.userId, at }, key);
          throw apiError(422, {
            code: v.verdict.refusal === OTHER_SELLER_REFUSAL ? 'other_sellers_goods' : 'online_listing_incomplete',
            whatHappened: `${v.verdict.refusal}. ${v.verdict.detail}.`,
            wasItSaved: 'not_saved',
            nextSafeAction: v.verdict.refusal === OTHER_SELLER_REFUSAL ? 'Only the shop\'s own goods are sold online. It still sells at the counter.' : `Fill in ${v.verdict.missing.join(', ')}, then publish again. It still sells in the shop.`,
          });
        }
        await deps.recordListing(ctx.tenantId, { kind: 'published', productId, by: ctx.userId, at }, key);
        return { status: 201, body: { productId, listed: true, lines: listingLines(v.facts, await details(ctx.tenantId), await deps.deliveryTerms(ctx.tenantId)).lines } };
      },
    },
    {
      // The 48-hour acknowledgement and one-month resolution clock on every online complaint; past a month is the owner's.
      api: 'API-07', method: 'GET', path: '/v1/online-store/complaints',
      permission: 'online.store.read',
      handler: async (ctx) => {
        const now = deps.now();
        const clocks = (await deps.onlineComplaints(ctx.tenantId)).map((c) => complaintClock({
          caseId: c.caseId, openedAt: c.openedAt, now,
          ...(c.firstRespondedAt === undefined ? {} : { acknowledgedAt: c.firstRespondedAt }),
          ...(c.resolvedAt === undefined ? {} : { resolvedAt: c.resolvedAt }),
        }));
        const ownerExceptions = clocks.filter((c) => c.ownerException);
        return { status: 200, body: {
          complaints: clocks, count: clocks.length,
          acknowledgementOverdue: clocks.filter((c) => c.state === 'acknowledgement_overdue').length,
          ownerExceptions, detail: ownerExceptions.length === 0 ? 'no online complaint is past one month unresolved' : `${ownerExceptions.length} online complaint(s) not resolved within one month — for the owner`,
        } };
      },
    },
    {
      // A26: the GST line for the online store, and every attempt to list another seller's goods (all refused).
      api: 'API-07', method: 'GET', path: '/v1/online-store/tcs',
      permission: 'online.store.read',
      handler: async (ctx) => {
        const refusedOtherSeller = (await deps.listings(ctx.tenantId)).filter((r): r is Extract<OnlineListingRecord, { kind: 'refused' }> => r.kind === 'refused' && r.otherSeller !== undefined);
        return { status: 200, body: { tcs: TCS_LINE, collectedMinor: 0, refusedOtherSellerListings: refusedOtherSeller.map((r) => ({ productId: r.productId, otherSeller: r.otherSeller, by: r.by, at: r.at })), caConfirmation: 'asked: the CA is to confirm "not applicable" in writing' } };
      },
    },
    {
      // THE CUSTOMER, before paying: the shop's details and, for each product the shop has published online and still
      // carries every duty, its lines (each value or "not set"), its stars and whether it has an image. Others: not online.
      api: 'API-07', method: 'GET', path: '/v1/storefront/listing',
      permission: 'storefront.order.read', entitlement: 'customer_app',
      handler: async (ctx) => {
        const d = await details(ctx.tenantId);
        const terms = await deps.deliveryTerms(ctx.tenantId);
        const listed = listedNow(await deps.listings(ctx.tenantId));
        const store = onlineStorePublishable(d);
        const products = [];
        for (const productId of await deps.catalogueProducts(ctx.tenantId)) {
          const v = await verdictFor(ctx.tenantId, productId, d, terms);
          if (v === undefined) continue;
          const on = listed.has(productId) && v.verdict.publishable;
          const shown = listingLines(v.facts, d, terms);
          const image = await deps.imageOf?.(ctx.tenantId, productId);
          products.push({
            productId, name: v.facts.name, soldOnline: on,
            ...(on ? {} : { notOnline: v.verdict.publishable ? 'not published online yet' : v.verdict.refusal }),
            lines: shown.lines,
            ...(shown.goodsMinor === undefined ? {} : { goodsMinor: shown.goodsMinor }),
            ...(shown.deliveryFeeMinor === undefined ? {} : { deliveryFeeMinor: shown.deliveryFeeMinor }),
            ...(shown.totalMinor === undefined ? {} : { totalMinor: shown.totalMinor }),
            ...(deps.ratingSummary === undefined ? {} : { rating: await deps.ratingSummary(ctx.tenantId, productId) }),
            ...(image === undefined ? {} : { image: { version: image.version, mediaType: image.mediaType } }),
          });
        }
        return { status: 200, body: {
          shop: detailView(d), onlineStore: { open: store.publishable && (latest(await deps.publications(ctx.tenantId)) !== undefined), ...(store.refusal === undefined ? {} : { notOpenBecause: store.refusal }) },
          products, pages: { privacy: './privacy.html', terms: './terms.html' },
        } };
      },
    },
  ];
}
