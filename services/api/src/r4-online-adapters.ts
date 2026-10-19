// R4 Lane 2 — the online store and the customer app. Head office's wiring for B23 · A26 · D-28 · WF-16 · M20-FR-04 ·
// D01-FR-06 (images) · D08 voice (off) · M16-FR-01 SMS code (off). Every register is append-only on its own stream (hard
// rules #2, #6); reads fold the streams; nothing here edits or deletes a record, calls a provider or sends a message.
// One entry point, `r4OnlineRoutes`, is registered from main.ts.

import { createHash } from 'node:crypto';
import { makeEvent } from '../../../packages/contracts/src/event';
import { InMemoryEventStore, type EventStore } from '../../../packages/persistence/src/event-store';
import type { Route } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import type { CatalogueDeps } from '../../catalogue/src/index';
import type { SignedPack } from '../../catalogue/src/pack';
import type { RefundProcessor } from '../../../packages/orders/src/payment-refunds';
import type { OnlineShopDetails, OnlineListingFacts } from '../../../packages/storefront/src/listing-duties';
import type { RatingRecord } from '../../../packages/storefront/src/ratings';
import { ratingSummary } from '../../../packages/storefront/src/ratings';
import { foldOnlineReturn, type OnlineReturnStep, type OnlineReturnView, type ReturnPolicySettings } from '../../../packages/storefront/src/online-returns';
import { resolveServiceabilityPolicy } from '../../../packages/storefront/src/serviceability-schedule';
import type { DigitalReceiptChoice, BankedSaleForCopy } from '../../../packages/receipt/src/digital-copy';
import { currentImage, type ProductImageStore, type ProductImageType, type ProductImageVersion } from '../../../packages/product/src/images';
import type { PlacedOrder, OrderTransition } from '../../orders/src/index';
import type { ServiceCase } from '../../../packages/service-desk/src/index';
import type { Movement } from '../../inventory/src/index';
import type { AppContent, ProductRecord } from '../../../packages/product/src/product';
import type { PackResult } from '../../../packages/fulfilment/src/packing';
import type { IncomingSale } from '../../pos/src/sale-intake';
import { onlineStoreRoutes, onlineSaleOf, type OnlineListingRecord, type OnlineStorePublication, type OnlineStoreDeps, type OnlineSaleVerdict } from '../../orders/src/storefront-online-store';
import { storefrontRatingRoutes } from '../../orders/src/storefront-ratings';
import { onlineReturnRoutes, noProviderRefundProcessor } from '../../orders/src/storefront-online-returns';
import { digitalReceiptRoutes, type MemberAppLink, type ReceiptAccessRefusal } from '../../customer/src/digital-receipts';
import { signupSmsCodeRoutes } from '../../customer/src/signup-sms-code';
import { productContentImageRoutes, type AppContentVersion } from '../../catalogue/src/product-content-images';
import {
  STREAM, streamName, catalogueAdapter, productMasterAdapter, inventoryAdapter, ordersAdapter, approvalRequestsAdapter,
  serviceabilityAdapter, serviceCaseAdapter, loyaltyMembersAdapter, fulfilmentPackingAdapter, categoryRegisterAdapter,
  permissionsHeldBy,
} from './adapters';

type Recorder = (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;

const all = async <T>(store: EventStore, tenantId: string, stream: string, type: string): Promise<T[]> =>
  (await store.readStream(tenantId, stream, { type })).map((e) => e.event.payload as T);
const digest = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 32);
const put = async (store: EventStore, tenantId: string, stream: string, type: string, payload: unknown, at: string, key: string): Promise<void> => {
  const d = digest(`${stream}|${key}`);
  await store.append(tenantId, stream, makeEvent({ id: `${type}-${d}`, type, occurredAt: at, idempotencyKey: `${type}-${tenantId}-${d}`, source: 'api/online-store', payload }));
};

// ── the streams (each its own, append-only) ─────────────────────────────────────────────────────────────────────────
const SHOP_DETAILS = streamName(STREAM.orders, 'online-store', 'shop-details');
const LISTINGS = streamName(STREAM.orders, 'online-store', 'listings');
const PUBLICATIONS = streamName(STREAM.orders, 'online-store', 'publications');
const RATINGS = streamName(STREAM.orders, 'online-store', 'ratings');
const RETURN_POLICY = streamName(STREAM.orders, 'online-returns', 'policy');
const RETURN_STEPS = streamName(STREAM.orders, 'online-returns', 'steps');
const RECEIPT_CHOICES = streamName(STREAM.customer, 'digital-receipts', 'choices');
const RECEIPT_LINKS = streamName(STREAM.customer, 'digital-receipts', 'member-links');
const RECEIPT_REFUSALS = streamName(STREAM.customer, 'digital-receipts', 'refusals');
const IMAGE_VERSIONS = streamName(STREAM.catalogue, 'product-images');
const imageFile = (imageId: string): string => streamName(STREAM.catalogue, 'product-image-files', imageId);
const HOLD_MINUTES = 60;

const DELIVERED = new Set(['delivered', 'collected']);

/** When the order reached the customer — its first transition to delivered or collected. */
export async function deliveredAtOf(store: EventStore, tenantId: string, orderId: string): Promise<string | undefined> {
  const steps = await all<OrderTransition>(store, tenantId, streamName(STREAM.orders, orderId), 'OrderTransitioned');
  return steps.filter((s) => DELIVERED.has(s.to)).map((s) => s.at).sort()[0];
}

/**
 * R4 gap lane "driver" (WF-16): one online return as head office holds it — what the route assignment and the box's pull read
 * to put a booked collection on a driver's route. Undefined when there is no such return.
 */
export async function onlineReturnViewOf(store: EventStore, tenantId: string, returnId: string): Promise<OnlineReturnView | undefined> {
  const steps = (await all<OnlineReturnStep>(store, tenantId, RETURN_STEPS, 'OnlineReturnStep')).filter((s) => s.returnId === returnId);
  return foldOnlineReturn(steps);
}

/**
 * Product images on the SHOP'S OWN SERVER (OB-215): the bytes kept in head office's own database, content-addressed —
 * one append per distinct image, never overwritten. No outside service is called.
 */
export function eventStoreImageStore(store: EventStore): ProductImageStore {
  return {
    put: async (t, imageId, mediaType, bytes) => {
      await store.append(t, imageFile(imageId), makeEvent({
        id: `product-image-file-${imageId}`, type: 'ProductImageFileKept', occurredAt: new Date(0).toISOString(),
        idempotencyKey: `product-image-file-${t}-${imageId}`, source: 'api/catalogue',
        payload: { imageId, mediaType, contentBase64: Buffer.from(bytes).toString('base64') },
      }));
    },
    get: async (t, imageId) => {
      const held = (await all<{ mediaType: ProductImageType; contentBase64: string }>(store, t, imageFile(imageId), 'ProductImageFileKept'))[0];
      return held === undefined ? undefined : { mediaType: held.mediaType, bytes: new Uint8Array(Buffer.from(held.contentBase64, 'base64')) };
    },
  };
}

export interface R4OnlineInput {
  readonly store: EventStore | undefined;
  readonly now: () => string;
  readonly signer: CatalogueDeps['signer'];
  /** The loyalty member key (from the pack signing key) — the desk's app link turns a number into a member code with it. */
  readonly memberKey?: Buffer;
  readonly recordAudit?: Recorder;
  /** WF-16: where a return's refund money moves. Absent → no provider is connected: every refund waits (said). */
  readonly refundProcessor?: RefundProcessor;
  readonly imageStore?: ProductImageStore;
}

/** B23 · A26: the online store's register deps over head office's store — the listing routes and the order route's check. */
function onlineStoreDepsOf(input: { readonly store: EventStore; readonly now: () => string; readonly signer: CatalogueDeps['signer']; readonly recordAudit?: Recorder }): OnlineStoreDeps {
  const { store, now } = input;
  const base = { store, now };
  const catalogue = catalogueAdapter({ store, now, signer: input.signer });
  const master = productMasterAdapter(base);
  const inventory = inventoryAdapter(base);
  const cases = serviceCaseAdapter(base);
  const pack = async (t: string): Promise<SignedPack | undefined> => (await catalogue.currentPack(t)) as SignedPack | undefined;
  const imageVersions = async (t: string, productId?: string): Promise<ProductImageVersion[]> =>
    (await all<ProductImageVersion>(store, t, IMAGE_VERSIONS, 'ProductImageVersioned')).filter((v) => productId === undefined || v.productId === productId);
  const ratings = (t: string): Promise<RatingRecord[]> => all<RatingRecord>(store, t, RATINGS, 'ProductRated');
  // ── B23 / A26: one product's online listing facts, from the published catalogue, the master and the ledgers ──────
  const listingFacts = async (t: string, productId: string): Promise<OnlineListingFacts | undefined> => {
    const p = (await pack(t))?.snapshot.products.find((x) => x.productId === productId);
    if (p === undefined) return undefined;
    const m: ProductRecord | undefined = await master.product(t, productId);
    // A26: whose goods — any stock of this product on the ledger owned by somebody else (a concession tenant, a consignor).
    const moves = await all<Movement>(store, t, STREAM.inventory, 'InventoryMoved');
    const other = moves.find((mv) => mv.productId === productId && mv.ownership !== undefined && mv.ownership !== 'own');
    // The product's department says whether it is food or medicine (head office's own category list, OB-24 "A").
    const regulated = (await categoryRegisterAdapter(base).categories(t)).find((c) => c.categoryId === m?.primaryCategoryId)?.regulated ?? [];
    const carriesDate = p.batchTracked === true || regulated.includes('food') || regulated.includes('drug');
    const dated = (await inventory.batches!(t, productId)).filter((b) => b.onHandMinor > 0 && typeof b.expiry === 'string').map((b) => b.expiry!).sort();
    return {
      productId, name: p.name,
      ...(p.mrpMinor === undefined ? {} : { mrpMinor: p.mrpMinor }),
      sellingPriceMinor: p.unitPriceMinor, taxRateBps: p.taxBps,
      carriesDate, ...(dated[0] === undefined ? {} : { bestBefore: dated[0] }),
      ...(m?.safety?.countryOfOrigin === undefined ? {} : { countryOfOrigin: m.safety.countryOfOrigin }),
      seller: other === undefined ? { own: true } : { own: false, sellerId: other.ownerId ?? other.ownership! },
    };
  };

  return {
    now,
    shopDetails: (t) => all<OnlineShopDetails>(store, t, SHOP_DETAILS, 'OnlineShopDetailsSet'),
    recordShopDetails: (t, d) => put(store, t, SHOP_DETAILS, 'OnlineShopDetailsSet', d, d.setAt, `v${d.version}`),
    catalogueProducts: async (t) => ((await pack(t))?.snapshot.products ?? []).map((p) => p.productId),
    listingFacts,
    deliveryTerms: async (t) => {
      const { policy, source } = resolveServiceabilityPolicy({ schedule: await serviceabilityAdapter(base).schedule(t), on: now().slice(0, 10) });
      // The D08 default carries no fee the owner set — "not set", never a silent zero.
      return source === 'default' ? {} : { ...(policy.deliveryFeeMinor === undefined ? {} : { deliveryFeeMinor: policy.deliveryFeeMinor }), ...(policy.freeDeliveryAboveMinor === undefined ? {} : { freeDeliveryAboveMinor: policy.freeDeliveryAboveMinor }) };
    },
    listings: (t) => all<OnlineListingRecord>(store, t, LISTINGS, 'OnlineListingRecorded'),
    recordListing: (t, r, key) => put(store, t, LISTINGS, 'OnlineListingRecorded', r, r.at, key),
    publications: (t) => all<OnlineStorePublication>(store, t, PUBLICATIONS, 'OnlineStorePublished'),
    recordPublication: (t, p) => put(store, t, PUBLICATIONS, 'OnlineStorePublished', p, p.at, `v${p.version}`),
    onlineComplaints: async (t) => (await cases.serviceCases(t))
      .filter((c: ServiceCase) => c.caseId.startsWith('app-'))
      .map((c) => ({ caseId: c.caseId, openedAt: c.openedAt, state: c.state, ...(c.firstRespondedAt === undefined ? {} : { firstRespondedAt: c.firstRespondedAt }), ...(c.resolvedAt === undefined ? {} : { resolvedAt: c.resolvedAt }) })),
    ratingSummary: async (t, productId) => ratingSummary(await ratings(t), productId),
    imageOf: async (t, productId) => {
      const cur = currentImage(await imageVersions(t, productId), productId);
      return cur === undefined ? undefined : { version: cur.version, mediaType: cur.mediaType };
    },
    ...(input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit }),
  };
}

/**
 * OB-234: the storefront order route's check — whether a product is sold online now (published on the listing register
 * and still carrying every duty), in Lane 2's words when not. Wired beside `storefrontSelfRoutes` in main.ts.
 */
export function onlineListedAdapter(input: { readonly store: EventStore; readonly now: () => string; readonly signer: CatalogueDeps['signer'] }): (tenantId: string, productId: string) => Promise<OnlineSaleVerdict> {
  const deps = onlineStoreDepsOf(input);
  return (tenantId, productId) => onlineSaleOf(deps, tenantId, productId);
}

export function r4OnlineRoutes(input: R4OnlineInput): readonly Route[] {
  const store = input.store ?? new InMemoryEventStore();
  const { now } = input;
  const base = { store, now };
  const catalogue = catalogueAdapter({ store, now, signer: input.signer });
  const master = productMasterAdapter(base);
  const inventory = inventoryAdapter(base);
  const orders = ordersAdapter({ ...base, holdMinutes: HOLD_MINUTES });
  const cases = serviceCaseAdapter(base);
  const imageStore = input.imageStore ?? eventStoreImageStore(store);
  const pack = async (t: string): Promise<SignedPack | undefined> => (await catalogue.currentPack(t)) as SignedPack | undefined;
  const imageVersions = async (t: string, productId?: string): Promise<ProductImageVersion[]> =>
    (await all<ProductImageVersion>(store, t, IMAGE_VERSIONS, 'ProductImageVersioned')).filter((v) => productId === undefined || v.productId === productId);
  const ratings = (t: string): Promise<RatingRecord[]> => all<RatingRecord>(store, t, RATINGS, 'ProductRated');

  return [
    // ── B23 · A26 — the online store's display duties ──
    ...onlineStoreRoutes(onlineStoreDepsOf({ store, now, signer: input.signer, ...(input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit }) })),
    // ── M20-FR-04 — ratings, stars only, buyers only ──
    ...storefrontRatingRoutes({
      now,
      ratings,
      recordRating: (t, r) => put(store, t, RATINGS, 'ProductRated', r, r.at, `${r.productId}|${r.customerRef}|v${r.version}`),
      bought: async (t, customerRef, productId) => {
        for (const o of await orders.ordersForCustomer(t, customerRef)) {
          if (o.customerRef === customerRef && o.lines.some((l) => l.productId === productId) && (await deliveredAtOf(store, t, o.orderId)) !== undefined) return true;
        }
        return false;
      },
    }),
    // ── WF-16 — the online return after delivery ──
    ...onlineReturnRoutes({
      now,
      placedOrder: async (t, orderId) => (await orders.placedOrder(t, orderId)) as PlacedOrder | undefined,
      deliveredAt: (t, orderId) => deliveredAtOf(store, t, orderId),
      categoryOf: async (t, productId) => (await master.product(t, productId))?.primaryCategoryId ?? undefined,
      policies: (t) => all<ReturnPolicySettings>(store, t, RETURN_POLICY, 'OnlineReturnPolicySet'),
      recordPolicy: (t, p) => put(store, t, RETURN_POLICY, 'OnlineReturnPolicySet', p, p.setAt, `v${p.version}`),
      steps: async (t, returnId) => (await all<OnlineReturnStep>(store, t, RETURN_STEPS, 'OnlineReturnStep')).filter((s) => s.returnId === returnId),
      allSteps: (t) => all<OnlineReturnStep>(store, t, RETURN_STEPS, 'OnlineReturnStep'),
      recordStep: (t, s, key) => put(store, t, RETURN_STEPS, 'OnlineReturnStep', s, s.at, key),
      priceOf: async (t, orderId, productId) => {
        // The price this line was CHARGED at: the order's own pack record where it was packed (exact per unit), else the
        // store price published now — said as such on the refund line.
        const packed = (await fulfilmentPackingAdapter(base).pack(t, orderId)) as PackResult | undefined;
        const line = packed?.lines.find((l) => l.productId === productId);
        if (line !== undefined && line.packedMinor > 0 && line.finalPriceMinor % line.packedMinor === 0) return { unitPriceMinor: line.finalPriceMinor / line.packedMinor, basis: 'the price on the order\'s pack record' };
        const p = (await pack(t))?.snapshot.products.find((x) => x.productId === productId);
        return p === undefined ? undefined : { unitPriceMinor: p.unitPriceMinor, basis: 'the store price published now (no pack record for this line)' };
      },
      restock: async (t, m) => {
        const uom = (await pack(t))?.snapshot.products.find((x) => x.productId === m.productId)?.baseUom ?? 'ea';
        await inventory.appendMovement(t, { movementId: m.movementId, productId: m.productId, locationId: m.locationId, kind: 'returned', quantityMinor: m.quantityMinor, uom, occurredAt: m.at, enteredBy: m.by, reason: 'online return received back — sellable' });
      },
      recalled: async (t, productId) => (await pack(t))?.snapshot.products.find((x) => x.productId === productId)?.recallBlock === true || (await master.product(t, productId))?.recallBlocked === true,
      openCase: async (t, c) => { if ((await cases.serviceCase(t, c.caseId)) === undefined) await cases.recordCase(t, c.caseId, c, `${c.state}|opened-in-app`); },
      orderPayment: orders.orderPayment, paymentResolution: orders.paymentResolution,
      orderRefunds: orders.orderRefunds, refundOutcomes: orders.refundOutcomes, recordRefund: orders.recordRefund,
      refundThreshold: orders.refundThreshold,
      approvals: approvalRequestsAdapter(base),
      refundProcessor: input.refundProcessor ?? noProviderRefundProcessor(),
      // R4 gap lane "driver" (WF-16): a collection relayed from the driver's phone re-checks the DRIVER's own grants.
      permissionsOfUser: (t, userId) => permissionsHeldBy(store, t, userId),
      ...(input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit }),
    }),
    // ── D-28 — digital receipts, only for members who ask ──
    ...digitalReceiptRoutes({
      now,
      choices: async (t, c) => (await all<DigitalReceiptChoice>(store, t, RECEIPT_CHOICES, 'DigitalReceiptChoice')).filter((x) => x.customerRef === c),
      recordChoice: (t, c) => put(store, t, RECEIPT_CHOICES, 'DigitalReceiptChoice', c, c.at, `${c.customerRef}|${c.at}|${c.on}`),
      links: (t) => all<MemberAppLink>(store, t, RECEIPT_LINKS, 'MemberAppLinked'),
      recordLink: (t, l) => put(store, t, RECEIPT_LINKS, 'MemberAppLinked', l, l.at, `${l.customerRef}|${l.memberRef}|${l.at}|${l.linked}`),
      ...(input.memberKey === undefined ? {} : { memberKey: input.memberKey }),
      memberHistory: async (t, memberRef) => loyaltyMembersAdapter({ ...base, rule: () => ({ pointsPer100Inr: 0, pointValuePaise: 0 }) }).memberHistory(t, memberRef),
      bankedSalesOf: async (t, memberRef) => (await all<IncomingSale>(store, t, STREAM.sales, 'SaleCommitted')).filter((s) => s.customerRef === memberRef) as unknown as BankedSaleForCopy[],
      productName: async (t, productId) => (await pack(t))?.snapshot.products.find((x) => x.productId === productId)?.name,
      recordRefusal: (t, r: ReceiptAccessRefusal) => put(store, t, RECEIPT_REFUSALS, 'ReceiptAccessRefused', r, r.at, `${r.customerRef}|${r.receiptNumber}|${r.at}`),
    }),
    // ── M16-FR-01 — the SMS code at sign-up, built switched off (OB-222) ──
    ...signupSmsCodeRoutes({ now }),
    // ── D01-FR-06 — the content editor's reads, and product images on the shop's own server (OB-215) ──
    ...productContentImageRoutes({
      now, imageStore,
      product: (t, id) => Promise.resolve(master.product(t, id)),
      contentHistory: async (t, productId) => {
        const out: AppContentVersion[] = [];
        let last = '{}'; // a product with no app content yet has no version of it
        for (const e of await store.readStream(t, streamName(STREAM.catalogue, 'products'), { type: 'ProductPublished' })) {
          const r = e.event.payload as ProductRecord;
          if (r.productId !== productId) continue;
          const c: AppContent = r.appContent ?? {};
          const sig = JSON.stringify({ ...c, setBy: undefined, setAt: undefined });
          if (sig === last) continue;
          last = sig;
          out.push({ version: out.length + 1, content: c, ...(c.setBy === undefined ? {} : { by: c.setBy }), at: e.event.occurredAt });
        }
        return out;
      },
      categories: async (t) => categoryRegisterAdapter(base).categories(t),
      imageVersions: (t, productId) => imageVersions(t, productId),
      recordImageVersion: (t, v) => put(store, t, IMAGE_VERSIONS, 'ProductImageVersioned', v, v.setAt, `${v.productId}|v${v.version}`),
    }),
  ];
}
