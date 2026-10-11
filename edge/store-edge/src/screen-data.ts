// What the store box serves to each of the six screens — §31, P-08, P-02.
//
// Every screen in this product was built to be told the truth, including the truth that the box
// does not know something. This is where that promise is kept: each payload is assembled from what
// the box actually has, and a section it has not got is **absent**, which every screen already
// renders as *not known* with the reason.
//
// ── The one rule, restated because it is the only one that matters here ─────
//
// **Never substitute an empty answer for a missing one.** It is one character of code — `?? []` —
// and it converts "the cloud has never told this box about approvals" into "no approvals are
// waiting". The manager's day close is built to refuse the first and proceed on the second, so
// that one character is the difference between a trading day that locks correctly and one that
// locks on nothing at all.
//
// The screens hold that line. This file has to hold it too, on the other side of the socket, and
// a guardrail checks that no payload builder here contains that idiom.
//
// ── What each screen gets, and from where ───────────────────────────────────
//
//   • the till       — the catalogue pack, so it can scan and price with no line at all
//   • the manager    — exceptions and unsent items projected HERE (the two gates on a day close),
//                      plus approvals, tasks and product costs from the cloud pack
//   • the owner      — the day's figures from this box's own log, with margin only where it can
//                      genuinely be worked out
//   • the picker     — the wave the cloud assigned
//   • the driver     — the route the cloud assigned
//   • the customer   — the published catalogue and the slots that can actually be had
//   • the buyer      — what is on order, what arrived, which invoices are already captured, and
//                      who is allowed to check the buyer's work
//   • the catalogue  — the master records, the tenant's own department rules, what things cost and
//                      every price ever set
//   • merchandising  — the shelf plan, every count ever taken, the stockroom, the range and what
//                      each part of the floor earns
//   • reporting      — the day's sales facts, the outbox, the exception register, and WHICH FACTS
//                      this shop does not record, so a report it cannot run refuses by name
//   • service        — every bill this box holds (not just today's: a receipt from last Tuesday is
//                      the ordinary case), every return already taken, and the shop's own limits
//   • expiry         — every batch and its expiry date, and every recall, so the list and the
//                      backwards trace both work with the cable out

import type { SyncOutbox } from '../../../packages/sync/src/outbox';
import { isUom, normaliseUom } from '../../../packages/contracts/src/quantity';
import { assessChecklist } from '../../../packages/workforce/src/index';
import type { LpRule } from '../../../packages/loss-prevention/src/index';
import { planDispatch, type DispatchPlan } from '../../../packages/fulfilment/src/routing';
import { generateDeliverySlots } from '../../../packages/storefront/src/checkout';
import { ShelfMap, type ShelfLocation } from '../../../packages/merchandising/src/index';
import {
  basketUnits, costTheDay, exceptionsFor, activityFrom, lineCostMinor, salesOn, tenderPartsOf, tradingDaysHeld,
  type LoggedSale,
} from './read-model';
import type { StorePack, PackRoutingPolicy, PackSlot, PackGstReconciliationPolicy, PackCategoryPolicyPolicy, PackGstReturnsPolicy, PackWastePolicy, PackWriteOffCapturePolicy, PackCountsPolicy, PackFleetPolicy, PackProductPublishReviewPolicy, PackDataQualityPolicy, PackOperationsInboxPolicy, PackLossPreventionPolicy, PackSubstitutionExceptionPolicy, PackDayBookPolicy, PackDocumentTemplatePolicy, PackReturnGovernancePolicy, PackCashOfficePolicy, PackRiskAcceptancePolicy, PackDayReopenPolicy, PackStockHealthPolicy, PackStoredValuePolicy, PackIntegrationHealthPolicy, PackGoodsReceiptPolicy, PackSuppliersPolicy, PackIndentsPolicy, PackDataIoPolicy, PackWorkforceInboxPolicy, PackEssPolicy, PackRosteringPolicy, PackChecklistPolicy, PackProductionPolicy, PackFacilitiesPolicy } from './store-pack';
import { DEFAULT_WRITE_OFF_THRESHOLD_MINOR } from '../../../packages/waste/src/waste';
import { packFreshness, type SignedPack } from '../../../services/catalogue/src/pack';

/** The screens this box serves. Named so a route, a test and a payload cannot drift apart. */
export const SCREENS = Object.freeze([
  'pos', 'manager', 'owner', 'picker', 'driver', 'customer', 'buying', 'catalogue', 'merchandising',
  'reporting', 'service', 'expiry', 'finance', 'gst-reconciliation', 'category-policy', 'gst-returns', 'waste', 'write-off-capture', 'counts', 'product-publish-review', 'data-quality', 'operations', 'loss-prevention', 'substitution-exceptions', 'day-book', 'document-templates', 'return-governance', 'cash-office', 'risk-acceptance', 'day-reopen', 'stock-health', 'stored-value', 'integration-health', 'goods-receipt', 'suppliers', 'indents', 'unsellable', 'data-io', 'workforce', 'ess', 'rostering', 'checklist', 'production', 'facilities', 'fleet', 'admin', 'ai', 'migration', 'warehouse', 'warehouse-supervisor', 'approvals',
] as const);
export type ScreenName = (typeof SCREENS)[number];

export interface ScreenInput {
  readonly pack: StorePack;
  readonly sales: readonly LoggedSale[];
  /** Records on the disk that could not be read at all. Surfaced, never silently dropped. */
  readonly unreadableRecords: number;
  /** The store's real outbox — the only honest source for "has everything reached the cloud?". */
  readonly outbox: SyncOutbox;
  readonly now: string;
  readonly tradingDay: string;
  /**
   * The signed catalogue pack this box last pulled from the cloud (SYNC-01), or absent if it holds
   * none yet. It drives the pack-age badge every screen shows — how far behind the cloud this shop's
   * prices/recalls have fallen — computed from the pack's own `builtAt`, not the box's boot clock.
   */
  readonly cataloguePack?: SignedPack;
  /**
   * Card/UPI payments on this box with no final answer (D04-FR-02 · PF-06), read from its payment-attempt log. Absent on
   * a box that takes no card payments. The manager's close list shows each; the box's close refuses over them.
   */
  readonly pendingPayments?: readonly { readonly attemptId: string; readonly laneId: string; readonly billRef: string; readonly kind: 'card' | 'upi'; readonly amountMinor: number; readonly askedAt: string; readonly state: string }[];
}

/**
 * How fresh the catalogue this box last pulled is — surfaced on EVERY screen (SYNC-01, P-08).
 *
 * The honest state matters: a box that has never pulled a pack says `known: false` (its catalogue
 * age is genuinely unknown), not "0 hours old", which would read as fresh. When it holds one, the
 * age is measured from the pack's own cloud `builtAt` via the same `packFreshness` the cloud serves,
 * so "3 hours old" means three hours behind the cloud — never "three hours since this box rebooted".
 */
export function catalogueFreshness(input: ScreenInput): Record<string, unknown> {
  const pack = input.cataloguePack;
  if (pack === undefined) {
    return { known: false };
  }
  const freshness = packFreshness(pack, input.now);
  return {
    known: true,
    version: pack.snapshot.version,
    builtAt: pack.snapshot.builtAt,
    ageHours: freshness.ageHours,
    visibleToStaff: freshness.visibleToStaff,
  };
}

/** Why the till cannot sell a product — the box's own judgement, named for the person who can fix it. */
export type UnsellableWhy = 'recall_block' | 'no_tax_rate' | 'no_status' | 'unknown_uom' | 'not_on_sale';
export interface UnsellableProduct {
  readonly productId: string;
  readonly name: string;
  readonly nameTa?: string;
  readonly why: UnsellableWhy;
  /** The box's own sentence about the record — the same words the till payload has always carried under `excludedProducts`. */
  readonly detail: string;
}
/** The gaps that keep a product OUT of the till's catalogue; a recall and an off-sale status are shipped and refused by name. */
const NOT_SHIPPED_TO_THE_LANE: ReadonlySet<UnsellableWhy> = new Set<UnsellableWhy>(['no_tax_rate', 'no_status', 'unknown_uom']);
/** The statuses a lane may sell (`packages/catalogue`): draft and discontinued are refused at the scan. */
const LANE_SELLS: ReadonlySet<string> = new Set(['active', 'clearance']);

/** Where the till's catalogue came from — named on the payload so a screen (and a test) can say which truth the lane sells from. */
export type TillCatalogueSource = 'head_office' | 'pack_file';

/** One product as the till is judged on and built from — the slice both sources can fill. */
export interface TillProduct {
  readonly productId: string;
  readonly sku?: string;
  readonly name: string;
  readonly nameTa?: string;
  readonly unitPriceMinor: number;
  readonly uom: string;
  readonly barcodes: readonly { readonly code: string; readonly kind: string }[];
  readonly taxBps?: number;
  readonly hsnCode?: string;
  readonly mrpMinor?: number;
  readonly status?: string;
  readonly recallBlock?: boolean;
  readonly batchTracked?: boolean;
  /** `ageRestricted` on the pack file; the master's minimum age fills the number where it knows one. */
  readonly ageRestricted?: boolean;
  readonly regulatedFlags?: Readonly<Record<string, unknown>>;
}

export interface TillCatalogue {
  readonly source: TillCatalogueSource;
  readonly tenantId: string;
  readonly version: number;
  readonly builtAt: string;
  readonly products: readonly TillProduct[];
  readonly scope?: SignedPack['snapshot']['scope'];
  readonly embeddedRules?: SignedPack['snapshot']['embeddedRules'];
  /** SF-01: the switched-on offers head office signed into the pack — the till applies them offline, by its own clock. */
  readonly promotions?: SignedPack['snapshot']['promotions'];
}

/**
 * The catalogue the till is judged on and built from (SP-9-i · F13 · P-02 · M03-FR-03 · M05-FR-01).
 *
 * The signed pack this box PULLED from head office is the one commerce truth and wins whenever the box holds one: a price
 * change, a new barcode or a recall block published at head office reaches the lane on the next pull — not when somebody
 * edits a file on the shop PC. Until SP-9 the pulled pack fed only the pack-age badge and the till priced from the pack
 * FILE's `products`, so "Catalogue updated to v2" in the boot log meant nothing at the scanner (F13). The file's products
 * remain the fallback for a box that has pulled nothing yet (first boot before the first pull, or a box with no cloud at
 * all — the arrangement the one-PC install starts in). Holding neither, the till has no catalogue and says so.
 */
export function tillCatalogue(pack: StorePack, cataloguePack: SignedPack | undefined, now: string): TillCatalogue | undefined {
  if (cataloguePack !== undefined) {
    const snapshot = cataloguePack.snapshot;
    // Barcodes grouped per product. A product with none genuinely has none on head office's catalogue — the empty list is
    // what the snapshot says, not a substitute for a missing section (the barcode register is part of the signed pack).
    const codes = new Map<string, { code: string; kind: string }[]>();
    for (const b of snapshot.barcodes) {
      const list = codes.get(b.productId);
      if (list === undefined) codes.set(b.productId, [{ code: b.code, kind: b.kind }]);
      else list.push({ code: b.code, kind: b.kind });
    }
    const codesOf = (productId: string): readonly { code: string; kind: string }[] => {
      const list = codes.get(productId);
      return list === undefined ? [] : list;
    };
    return {
      source: 'head_office',
      tenantId: snapshot.tenantId,
      version: snapshot.version,
      builtAt: snapshot.builtAt,
      ...(snapshot.scope === undefined ? {} : { scope: snapshot.scope }),
      ...(snapshot.embeddedRules === undefined ? {} : { embeddedRules: snapshot.embeddedRules }),
      ...(snapshot.promotions === undefined ? {} : { promotions: snapshot.promotions }),
      products: snapshot.products.map((p) => ({
        productId: p.productId,
        sku: p.sku,
        name: p.name,
        unitPriceMinor: p.unitPriceMinor,
        uom: p.baseUom,
        barcodes: codesOf(p.productId),
        taxBps: p.taxBps,
        ...(p.hsnCode === undefined ? {} : { hsnCode: p.hsnCode }),
        ...(p.mrpMinor === undefined ? {} : { mrpMinor: p.mrpMinor }),
        status: p.status,
        ...(p.recallBlock === true ? { recallBlock: true } : {}),
        ...(p.batchTracked === true ? { batchTracked: true } : {}),
        ...(p.regulatedFlags === undefined ? {} : { regulatedFlags: p.regulatedFlags }),
      })),
    };
  }
  if (!pack.products.known) return undefined;
  const policies = pack.policies.known ? pack.policies.value : undefined;
  return {
    source: 'pack_file',
    tenantId: policies?.storeId ?? 'store-1',
    version: pack.version,
    builtAt: pack.receivedAt ?? now,
    products: pack.products.value.map((p) => ({
      productId: p.productId,
      name: p.name,
      ...(p.nameTa === undefined ? {} : { nameTa: p.nameTa }),
      unitPriceMinor: p.unitPriceMinor,
      uom: p.uom,
      barcodes: p.barcodes.map((code) => ({ code, kind: 'ean13' })),
      ...(p.taxBps === undefined ? {} : { taxBps: p.taxBps }),
      ...(p.status === undefined ? {} : { status: p.status }),
      ...(p.recallBlock === true ? { recallBlock: true } : {}),
      ...(p.ageRestricted === true ? { ageRestricted: true } : {}),
    })),
  };
}

/**
 * Every product in the pack the till cannot sell, and why (SP-8c-ii · F08 · P-08 · M03-FR-03 · M10-FR-04 · G5c).
 *
 * ONE judgement for two readers: the till payload drops the catalogue gaps from the lane's catalogue by this list, and the
 * "Products nobody can sell" screen shows the same list to the person who can fix it. Recall is judged first — a safety
 * block before a catalogue gap, and from EITHER source (the lane summary or the master), failing safe.
 */
export function unsellableProducts(pack: StorePack, cataloguePack?: SignedPack): readonly UnsellableProduct[] {
  const till = tillCatalogue(pack, cataloguePack, '');
  if (till === undefined) return [];
  const master = new Map((pack.productMaster.known ? pack.productMaster.value : []).map((m) => [m.productId, m] as const));
  const rows: UnsellableProduct[] = [];
  for (const p of till.products) {
    const m = master.get(p.productId);
    const status = p.status ?? m?.lifecycle;
    const named = (why: UnsellableWhy, detail: string): void => {
      rows.push({ productId: p.productId, name: p.name, ...(p.nameTa === undefined ? {} : { nameTa: p.nameTa }), why, detail });
    };
    if (p.recallBlock === true || m?.recallBlocked === true) named('recall_block', 'recall block set on the catalogue — refused at the till by name');
    else if (p.taxBps === undefined) named('no_tax_rate', 'no tax rate on the catalogue');
    else if (status === undefined) named('no_status', 'no status on the catalogue');
    else if (!isUom(normaliseUom(p.uom) ?? p.uom)) named('unknown_uom', `unknown unit of measure "${p.uom}" on the catalogue`);
    else if (!LANE_SELLS.has(status)) named('not_on_sale', `status "${status}" on the catalogue — refused at the till`);
  }
  return rows;
}

/**
 * The "Products nobody can sell" screen's payload (SP-8c-ii · P-08): the list the till payload is built from, with when the
 * box received the catalogue it judged and how many products the till CAN sell, so the list reads against something.
 * `null` when the box was never given a catalogue — the screen then says it cannot say, rather than "all clear".
 */
export function unsellablePayload(input: ScreenInput): Record<string, unknown> | null {
  const till = tillCatalogue(input.pack, input.cataloguePack, input.now);
  if (till === undefined) return null;
  const policies = input.pack.policies.known ? input.pack.policies.value : undefined;
  const rows = unsellableProducts(input.pack, input.cataloguePack);
  return {
    storeId: policies?.storeId ?? 'store-1',
    // The catalogue judged: head office's build time when the lane sells from the pulled pack, else when the box took the file.
    asAt: till.source === 'head_office' ? till.builtAt : (input.pack.receivedAt ?? input.now),
    source: till.source,
    rows: rows.map((r) => ({ productId: r.productId, name: r.name, ...(r.nameTa === undefined ? {} : { nameTa: r.nameTa }), reason: r.why, detail: r.detail })),
    sellableCount: till.products.length - rows.length,
  };
}

/**
 * The till's payload: the catalogue, and nothing else.
 *
 * A lane needs to scan a barcode and price it with no line to anywhere, so this is the one screen
 * whose payload is pure pack. Absent, the shell already says the lane has no price list and cannot
 * scan — which is correct, and is not something to paper over with an empty catalogue that would
 * make every scan an unknown-barcode error instead.
 */
export function posPayload(input: ScreenInput): Record<string, unknown> | null {
  // SP-9-i (F13 · P-02): the catalogue head office published and this box pulled, when it holds one; the pack file until then.
  const till = tillCatalogue(input.pack, input.cataloguePack, input.now);
  if (till === undefined) return null;

  // The master record, where the pack carried one. Recall and lifecycle live there, and the
  // lane-facing summary carries them too — so the two can disagree, and on a SAFETY flag a
  // disagreement must fail one way only: **either source saying blocked means blocked.**
  const master = new Map(
    (input.pack.productMaster.known ? input.pack.productMaster.value : [])
      .map((m) => [m.productId, m] as const),
  );

  const products: Record<string, unknown>[] = [];
  const barcodes: Record<string, unknown>[] = [];
  const excluded: Record<string, unknown>[] = [];
  // **A product the lane cannot judge is not shipped to the lane.**
  //
  // No tax rate means every line of tax on that sale would be invented; no status means the
  // catalogue cannot tell active from discontinued, and `SELLABLE.includes(undefined)` is false,
  // so it would refuse at the scan with a reason nobody can act on. Excluded and COUNTED, the
  // same treatment the tested snapshot builder already gives them — an unknown barcode at the
  // till is at least a question somebody asks, where a wrong tax rate is not.
  //
  // A recalled product is the exception: it is shipped WITH its block rather than excluded, so
  // the lane refuses the scan by name — *this is under recall* — instead of by absence. "Unknown
  // barcode" on a recalled tin is a cashier keying it in by hand.
  //
  // A unit of measure the pricing maths cannot make a Quantity in gets the same treatment (Stage G slice 5c):
  // `"each"` where the engine knows `ea` reached the till and priced as ₹NaN on the line. Excluded, counted, and
  // the till refuses it by name too should one ever arrive another way.
  //
  // SP-8c-ii: the judgement is made ONCE, in `unsellableProducts`, and the "Products nobody can sell" screen reads the
  // same list — so what the till is not given and what the person who can fix it is shown can never disagree.
  const notShipped = new Map(unsellableProducts(input.pack, input.cataloguePack).filter((r) => NOT_SHIPPED_TO_THE_LANE.has(r.why)).map((r) => [r.productId, r] as const));

  for (const p of till.products) {
    const m = master.get(p.productId);
    const recallBlock = p.recallBlock === true || m?.recallBlocked === true;
    const status = p.status ?? m?.lifecycle;
    const minimumAge = m?.safety?.minimumAge;
    const gap = notShipped.get(p.productId);
    if (gap !== undefined) {
      excluded.push({ productId: p.productId, name: p.name, why: gap.detail });
      continue;
    }
    products.push({
      productId: p.productId,
      ...(p.sku === undefined ? {} : { sku: p.sku }),
      name: p.name,
      ...(p.nameTa === undefined ? {} : { nameTa: p.nameTa }),
      baseUom: p.uom,
      unitPriceMinor: p.unitPriceMinor,
      taxBps: p.taxBps ?? 0,
      ...(p.hsnCode === undefined ? {} : { hsnCode: p.hsnCode }),
      ...(p.mrpMinor === undefined ? {} : { mrpMinor: p.mrpMinor }),
      status: status ?? 'discontinued',
      // **The recall block, at last.** The lane's catalogue has refused a recall-blocked scan
      // since it was written — "even offline", the loudest safety claim in this codebase — and
      // the flag had no field to arrive in, so the refusal was unreachable and a recalled batch
      // could be sold at the till.
      ...(recallBlock ? { recallBlock: true } : {}),
      ...(p.batchTracked === true ? { batchTracked: true } : {}),
      // Head office's flags ride as published; the pack file's `ageRestricted` becomes the lane's age prompt.
      ...(p.regulatedFlags !== undefined ? { regulatedFlags: p.regulatedFlags }
        : p.ageRestricted === true ? { regulatedFlags: { minimumAge: minimumAge ?? 18 } } : {}),
    });
    for (const b of p.barcodes) {
      barcodes.push({ code: b.code, productId: p.productId, kind: b.kind });
    }
  }

  // A real `CatalogueSnapshot`, which is what `bootPos` actually consumes. The shape served here
  // used to be a different one of the same name in spirit — no `barcodes` array, no `status`, no
  // `taxBps` — and `new CatalogueCache(snapshot)` threw on `snapshot.barcodes` before the till
  // rendered anything. A cashier saw a blank screen, and nothing anywhere said why.
  return {
    tenantId: till.tenantId,
    version: till.version,
    builtAt: till.builtAt,
    // Which truth this lane sells from — head office's pulled pack or the shop PC's file (SP-9-i · F13).
    source: till.source,
    ...(till.scope === undefined ? {} : { scope: till.scope }),
    ...(till.embeddedRules === undefined ? {} : { embeddedRules: till.embeddedRules }),
    // SF-01: the offers ride through to the lane as signed — before, the box rebuilt the catalogue field by field and
    // an offer head office launched never reached a scanner.
    ...(till.promotions === undefined ? {} : { promotions: till.promotions }),
    products,
    barcodes,
    // Named, never silently dropped: a product missing from the till is a product nobody can sell.
    ...(excluded.length === 0 ? {} : { excludedProducts: excluded }),
  };
}

/**
 * The manager's payload.
 *
 * Two of its four registers are the gates on a day close, and **both are produced here rather than
 * fetched**, which is the point of the whole file:
 *
 *   • `unsentItems` is this box's own outbox. Nothing else in the system knows what has not reached
 *     the cloud — by definition, the cloud does not.
 *   • `openExceptions` is the day evaluated against the store's own thresholds. Waiting for the
 *     cloud to notice a void spike would blank the register exactly when the line is down, which is
 *     when a shop is least supervised.
 *
 * The other two come from the pack, and stay absent when the pack has not carried them.
 */
/**
 * One figure on the Today page (OB-15/OB-16 · UX-2b · P-08): the box's own count, or WHY it does not know. Never a
 * reassuring zero for a register the box has not been given — "Not known — the store computer has not been given
 * the purchase orders" is the honest reading, and the only one a manager can act on.
 */
export type TodayFigure =
  | { readonly known: true; readonly value: number; readonly unit?: 'inr'; readonly note?: string }
  | { readonly known: false; readonly why: string };

const notGiven = (what: string): TodayFigure => ({ known: false, why: `the store computer has not been given ${what}` });
const dateOf = (v: unknown): string | null => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
const daysBetween = (fromDay: string, toDay: string): number => Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / 86_400_000);

/**
 * The Today page's figures, each from the pack or from this box's own log — the command centre of the owner's
 * composition (OB-15), every number real or said to be not known (P-08). Pure: the same pack and log give the same
 * figures; a section the pack does not carry gives `known: false` with the reason, never zero.
 */
export function todayFigures(input: ScreenInput): Record<string, TodayFigure> {
  const pack = input.pack;
  const day = salesOn(input.sales, input.tradingDay);
  const takings = day.sales.reduce((sum, sale) => sum + (sale.total ?? 0), 0);
  const salesToday: TodayFigure = {
    known: true, value: takings, unit: 'inr',
    note: `${day.sales.length} ${day.sales.length === 1 ? 'sale' : 'sales'} on this box${day.undated > 0 ? ` · ${day.undated} undated, in nobody's figures` : ''}`,
  };

  let purchaseOrdersOpen: TodayFigure;
  if (!pack.purchaseOrders.known) purchaseOrdersOpen = notGiven('the purchase orders');
  else {
    const received = new Map<string, Map<string, number>>();
    if (pack.receipts.known) {
      for (const r of pack.receipts.value) {
        const byProduct = received.get(r.poId) ?? new Map<string, number>();
        for (const line of r.lines) byProduct.set(line.productId, (byProduct.get(line.productId) ?? 0) + line.qty);
        received.set(r.poId, byProduct);
      }
    }
    const open = pack.purchaseOrders.value.filter((po) => po.lines.some((line) => line.qty > (received.get(po.poId)?.get(line.productId) ?? 0)));
    purchaseOrdersOpen = { known: true, value: open.length, note: pack.receipts.known ? `of ${pack.purchaseOrders.value.length} on the box, still awaiting goods` : 'receipts not given — every order counted as open' };
  }

  const receiptsRecorded: TodayFigure = pack.receipts.known ? { known: true, value: pack.receipts.value.length, note: 'against open orders' } : notGiven('the goods receipts');

  const CLOSED = new Set(['received', 'closed', 'cancelled', 'rejected', 'fulfilled', 'done']);
  const indentsOpen: TodayFigure = pack.floorIndents.known
    ? { known: true, value: pack.floorIndents.value.indents.filter((i) => !CLOSED.has(String(i.state).toLowerCase())).length, note: 'shelf requests the back store has not finished' }
    : notGiven('the floor indents');

  let countsAwaitingApproval: TodayFigure;
  if (!pack.countsQueue.known) countsAwaitingApproval = notGiven('the stock counts');
  else {
    const rows = pack.countsQueue.value.filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null);
    const waiting = rows.filter((r) => r['approvedBy'] === null || r['approvedBy'] === undefined || r['status'] === 'pending');
    countsAwaitingApproval = { known: true, value: waiting.length, note: `of ${rows.length} counted` };
  }

  let expiringSoon: TodayFigure;
  if (!pack.batches.known) expiringSoon = notGiven('the batch register');
  else if (!pack.expiryPolicy.known) expiringSoon = notGiven('the expiry policy');
  else {
    const window = pack.expiryPolicy.value.nearExpiryDays;
    const rows = pack.batches.value.filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null);
    const dated = rows.map((r) => dateOf(r['expiresOn'] ?? r['expiryDate'] ?? r['bestBefore'] ?? r['useBy'] ?? r['expiresAt'])).filter((d): d is string => d !== null);
    expiringSoon = rows.length > 0 && dated.length === 0
      ? { known: false, why: 'the batch records carry no expiry date' }
      : { known: true, value: dated.filter((d) => daysBetween(input.tradingDay, d) <= window).length, note: `within ${window} days, of ${rows.length} batches` };
  }

  const recallsOpen: TodayFigure = pack.recalls.known ? { known: true, value: pack.recalls.value.length, note: 'recall notices on the box' } : notGiven('the recall notices');

  let checklistOpen: TodayFigure;
  if (!pack.checklist.known) checklistOpen = notGiven('the day\'s checklist');
  else {
    const open = pack.checklist.value.filter((i) => !i.done);
    const blocking = open.filter((i) => i.blocking).length;
    checklistOpen = { known: true, value: open.length, note: blocking > 0 ? `${blocking} must be done before the day closes` : 'none holds the day close' };
  }

  const deliveriesToday: TodayFigure = pack.deliveries.known
    ? { known: true, value: pack.deliveries.value.filter((d) => dateOf(d.slotStartsAt) === input.tradingDay).length, note: 'customer deliveries in today\'s slots' }
    : notGiven('the delivery slots');

  return { salesToday, purchaseOrdersOpen, receiptsRecorded, indentsOpen, countsAwaitingApproval, expiringSoon, recallsOpen, checklistOpen, deliveriesToday };
}

export function managerPayload(input: ScreenInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  // Who runs this screen, where, and which day (Stage G slice 5c · §28 · hard rule #4). Only what the pack says:
  // no manager named means the screen names nobody and refuses to decide, receive, count or close — never a
  // stand-in identity. The branch may be null (company-wide) and is passed through as null, not dropped.
  if (input.pack.managerPolicy.known) {
    const who = input.pack.managerPolicy.value;
    payload['userId'] = who.userId;
    payload['approvalLimitMinor'] = who.approvalLimitMinor ?? null;
  }
  if (input.pack.policies.known) {
    const policies = input.pack.policies.value;
    payload['storeId'] = policies.storeId;
    payload['branchId'] = policies.branchId;
    payload['tradingDayCutoff'] = policies.tradingDayCutoff;
    payload['countApprovalThresholdMinor'] = policies.countApprovalThresholdMinor;
    payload['warehouseId'] = policies.warehouseId;
  }
  // The shop's own trading day, not the browser's clock (the same rule the catalogue screen follows).
  payload['tradingDay'] = input.tradingDay;
  // The Today page (UX-2b): every figure from the pack or this box's log, or said to be not known (P-08).
  payload['today'] = todayFigures(input);

  // D04-FR-02 · PF-06: card/UPI payments with no final answer — the close list names each one (P-08).
  if (input.pendingPayments !== undefined) {
    payload['pendingPayments'] = input.pendingPayments.map((p) => ({
      id: p.attemptId,
      what: `${p.kind === 'upi' ? 'UPI' : 'Card'} payment of Rs ${(p.amountMinor / 100).toFixed(2)} on till ${p.laneId}, bill ${p.billRef}, asked ${p.askedAt} — ${p.state === 'asked' ? 'no answer was recorded from the machine' : 'no answer; not yet settled by the provider'}`,
    }));
  }
  // Every pending item, whatever it is. The manager's screen lists them, so a sale and a stock
  // adjustment both belong here — "3 things have not reached the cloud" is the honest count.
  payload['unsentItems'] = input.outbox.pending().map((item) => ({
    id: item.key,
    what: item.event.type,
  }));

  const rules = input.pack.lossPreventionRules.known
    ? (input.pack.lossPreventionRules.value as readonly LpRule[])
    : undefined;
  // TODAY's activity, not the whole log. A "no more than two refunds" limit counted against every
  // refund since the box was installed breaches on day three and never stops breaching, and the
  // day close gates on this register — so the shop would eventually be unable to close a clean day.
  const today = salesOn(input.sales, input.tradingDay);
  const day = exceptionsFor(activityFrom(today.sales), rules);
  if (day.rulesKnown) {
    const items = day.exceptions.map((e) => ({
      id: `${e.cashierId}:${e.kind}:${e.breach}`,
      what: `${e.kind.replace(/_/g, ' ')} by ${e.cashierId}: ${e.observed} against a limit of ${e.limit}`,
    }));
    // A record nobody can read is an exception in its own right. It is evidence that something
    // went wrong on this disk, and it must not be quietly excluded from the day's figures and then
    // also excluded from the list of things wrong with the day (hard rule #6).
    if (input.unreadableRecords > 0) {
      items.push({
        id: 'edge:unreadable-records',
        what: `${input.unreadableRecords} record(s) on this box could not be read — most likely a power cut mid-write`,
      });
    }
    // Same reasoning, different cause: a sale that names no trading day cannot be put in one, so it
    // is out of every day's figures. Silently out of the total somebody reconciles against the till
    // roll is exactly the kind of gap that gets blamed on a cashier.
    if (today.undated > 0) {
      items.push({
        id: 'edge:undated-sales',
        what: `${today.undated} sale(s) on this box name no trading day, so they are in nobody's figures — they need looking at`,
      });
    }

    // An order that could not be put on a route is a customer who ordered, paid and is waiting.
    // It belongs on the manager's exception register — and therefore holds the day close, which is
    // correct: a day should not lock with somebody's shopping still in the building and nobody
    // having told them (M19-FR-03).
    const plan = dispatchPlanFor(input);
    if (plan !== null) {
      for (const unplanned of plan.unplanned) {
        items.push({ id: `dispatch:${unplanned.orderId}`, what: unplanned.detail });
      }
      // Flagged for a look, not raised as an exception: an expensive stop is a question about
      // whether to keep taking that order, not something wrong with today (D09).
      for (const flag of plan.contributionFlags) {
        items.push({ id: `contribution:${flag.orderId}`, what: flag.detail });
      }
    }
    payload['openExceptions'] = items;
  }
  // else: the section is ABSENT. No rules means nobody is watching, and a manager must not be able
  // to close a day on a register that was never checked.

  if (input.pack.approvals.known) {
    // **Shaped for the manager's engine, not passed through.**
    //
    // The pack carries `valueMinor`, because a number over a wire is a number. The approval engine
    // takes `Money` — an amount with its currency — and a screen handed the wrong shape reads
    // `value.currency` off `undefined` and the whole inbox throws. The lane socket had exactly
    // this fault once (`saleId` against `id`) and refused every real sale with "could not read".
    //
    // Converting here rather than at six call sites means one place can be wrong instead of six.
    payload['approvals'] = input.pack.approvals.value.map((a) => ({
      id: a.id,
      subjectType: a.subjectType,
      subjectRef: a.subjectRef,
      requestedBy: a.requestedBy,
      branchId: a.branchId,
      value: a.valueMinor === null ? null : { minor: a.valueMinor, currency: 'INR' },
      status: 'pending',
    }));
  }

  if (input.pack.checklist.known) {
    const result = assessChecklist({
      checklistId: `${input.tradingDay}-closing`,
      kind: 'closing',
      items: input.pack.checklist.value.map((i) => ({
        itemId: i.itemId,
        description: i.description,
        done: i.done,
        blocking: i.blocking,
        ...(i.doneBy === undefined ? {} : { doneBy: i.doneBy }),
      })),
      signedBy: 'not signed yet',
    });
    payload['tasks'] = result.outstanding.map((i) => ({
      id: i.itemId,
      what: i.blocking ? `${i.description} (the shop cannot close without this)` : i.description,
    }));
  }

  if (input.pack.products.known) {
    payload['products'] = input.pack.products.value
      .filter((p) => p.unitCostMinor !== undefined)
      .map((p) => ({ id: p.productId, valuePerUnitMinor: p.unitCostMinor! }));
  }

  return payload;
}

/**
 * The owner's payload.
 *
 * **Margin is only served where it can genuinely be worked out.** A sale containing a product the
 * pack has no cost price for is left out of the figures and counted; the count is then raised as an
 * exception on the owner's own screen, naming the products, because the person who can fix a
 * missing cost price is exactly the person reading it.
 */
/** Round 4: today's bills that `costTheDay` could not cost — their count, takings and tender mix (each payment by its own kind). */
function uncostedOf(sales: readonly LoggedSale[], costed: ReadonlySet<string>): { bills: number; takenMinor: number; tenderMix: Record<string, number> } {
  const out = { bills: 0, takenMinor: 0, tenderMix: {} as Record<string, number> };
  for (const sale of sales) {
    if (costed.has(sale.id)) continue;
    out.bills += 1;
    out.takenMinor += sale.total ?? 0;
    for (const part of tenderPartsOf(sale)) out.tenderMix[part.kind] = (out.tenderMix[part.kind] ?? 0) + part.amountMinor;
  }
  return out;
}

export function ownerPayload(input: ScreenInput): Record<string, unknown> | null {
  if (!input.pack.policies.known) return null;
  const policies = input.pack.policies.value;
  const products = input.pack.products.known ? input.pack.products.value : [];
  // TODAY. The log holds every day the box has ever traded, so this brief reported the whole
  // week's takings as the day's — on a phone, as one number, with nothing to say it was wrong.
  const today = salesOn(input.sales, input.tradingDay);
  const day = costTheDay(today.sales, products);

  const exceptions: { cashierId: string; kind: string; breach: string; observed: number; limit: number; severity: string; linkedTxnIds: string[] }[] = [];
  const rules = input.pack.lossPreventionRules.known
    ? (input.pack.lossPreventionRules.value as readonly LpRule[])
    : undefined;
  for (const e of exceptionsFor(activityFrom(today.sales), rules).exceptions) {
    exceptions.push({ ...e, linkedTxnIds: [...e.linkedTxnIds] });
  }

  return {
    ownerId: 'owner',
    staleAfterSeconds: policies.staleAfterSeconds,
    privacySlaDays: policies.privacySlaDays,
    branches: [{
      branchId: policies.branchId ?? policies.storeId,
      name: policies.branchName,
      // The box's own clock, because the box is where the sales are. If the cloud were asked when
      // this branch last synced, a box with no line would report nothing and the owner would see
      // "never synced" about the shop that has been trading all day in front of him.
      lastSyncedAt: input.now,
      sales: day.facts,
      // Round 4 (P-08): the bills that could not be costed, with what they took and how it was paid — the owner app
      // shows the takings and says the margin is not known, instead of "no sales".
      uncosted: uncostedOf(today.sales, new Set(day.facts.map((f) => f.saleId))),
      exceptions,
      // Out of every day's figures, so it is named where the owner will see it rather than
      // becoming an unexplained difference against the till roll.
      ...(today.undated === 0 ? {} : { undatedSales: today.undated }),
      approvals: input.pack.approvals.known
        ? input.pack.approvals.value.map((a) => ({
          id: a.id,
          subjectType: a.subjectType,
          subjectRef: a.subjectRef,
          requestedBy: a.requestedBy,
          valueMinor: a.valueMinor,
        }))
        : [],
    }],
    // Reported alongside, not folded in. The owner is told the takings are complete and the margin
    // is over a subset, rather than being shown one number that is quietly both.
    uncostable: {
      sales: day.uncostableSales,
      takenMinor: day.takenMinor,
      billCount: day.billCount,
      products: day.productsWithoutCost,
    },
  };
}

/**
 * This store's shelf map, or `null` when it has none (M04-FR-02).
 *
 * Built here rather than in the cloud for the same reason the routes are: a picker walks the shop
 * whether or not the internet is up, and a shop whose pick lists could only be sequenced online
 * would go back to walking dairy-then-rice-then-dairy on the afternoon the router dies.
 */
export function shelfMapFor(input: ScreenInput): ShelfMap | null {
  if (!input.pack.shelfLocations.known || !input.pack.shelfAssignments.known) return null;
  const storeId = input.pack.policies.known ? input.pack.policies.value.storeId : 'store-1';
  const zoneOrder = input.pack.shelfPolicy.known ? input.pack.shelfPolicy.value.zoneOrder : undefined;
  const map = new ShelfMap(storeId, input.pack.shelfLocations.value, [], zoneOrder);
  // Assignments one at a time: a pack carrying two primaries for one product is a contradiction
  // about where an item lives, and the map refuses it. Refusing the WHOLE map over one bad row
  // would take the picker's route down for every other product in the shop, so the bad row is
  // dropped and the rest still sequences — the product simply reads as unmapped, which is exactly
  // what it is until somebody says where it lives.
  for (const assignment of input.pack.shelfAssignments.value) {
    if (assignment.storeId !== storeId) continue;
    try {
      map.assign(assignment);
    } catch {
      continue;
    }
  }
  return map;
}

/**
 * The picker's payload: the wave the cloud assigned, or nothing when none was.
 *
 * **The wave is put into shelf order here.** `ShelfMap.routeFor` has existed and been tested since
 * the module was written, and nothing had ever called it — so every wave was walked in whatever
 * order the cloud happened to send, which on an online grocery order is the order the customer
 * typed: dairy, rice, back to dairy. The roadmap's audit calls picking time the largest
 * controllable cost in this business, and it is decided here.
 *
 * The screen is told **which ordering it is holding**, the same way the driver is told whether a
 * dispatcher wrote their route by hand — a picker who thinks a list is sequenced when it is not
 * walks it trusting an order that was never applied.
 */
export function pickerPayload(input: ScreenInput, pickerId?: string): Record<string, unknown> | null {
  // HA-1: head office's assignment is the normal source; a wave written by hand into the pack file is the override, and
  // the screen is told which of the two it is holding — never left to assume.
  const handWritten = input.pack.wave.known && input.pack.wave.value !== null ? input.pack.wave.value : null;
  const assigned = input.pack.assignments.known ? input.pack.assignments.value : null;
  // DF-3-c: a picker signed in on the phone is given THEIR wave — the first is only for a box that does not know who is asking.
  const wave = handWritten ?? (pickerId === undefined ? assigned?.waves[0] : assigned?.waves.find((w) => w.pickerId === pickerId)) ?? null;
  if (wave === null) return null;
  const source = {
    assignedBy: handWritten !== null ? 'this box\'s pack file — a wave written by hand' : `head office, as of ${assigned!.asAt}`,
    wavesAssigned: assigned?.waves.length ?? 0,
  };

  // HA-2: the product master's handling class, as the pulled catalogue pack carries it — so the picker sees "chilled" on the
  // line and keeps it cold. A product the pack does not classify carries none; the phone shows nothing rather than a guess.
  const handlingOf = new Map<string, string>();
  const classified = input.cataloguePack?.snapshot.products;
  if (classified !== undefined) for (const p of classified) if (p.handling !== undefined) handlingOf.set(p.productId, p.handling);
  const lines = wave.lines.map((l) => ({
    lineId: l.lineId,
    orderRef: l.orderRef,
    productId: l.productId,
    description: l.description,
    bin: l.bin,
    requiredQty: l.requiredQty,
    uom: l.uom,
    unitPrice: { minor: l.unitPriceMinor, currency: 'INR' },
    ...(handlingOf.has(l.productId) ? { handling: handlingOf.get(l.productId)! } : {}),
  }));

  const map = shelfMapFor(input);
  if (map === null) {
    return {
      waveId: wave.waveId,
      pickerId: wave.pickerId,
      ...source,
      lines,
      orderedBy: 'the order the list arrived in — this store has no shelf map',
      unmapped: [],
    };
  }

  const walk = map.routeFor(lines);
  return {
    waveId: wave.waveId,
    pickerId: wave.pickerId,
    ...source,
    // The shelf address travels with the line, so the handheld can show where to go rather than
    // only which bin to scan. An unmapped line keeps its place at the end of the list and says so.
    lines: walk.lines.map((l) => {
      const { location, unmapped, ...line } = l as typeof l & { location?: ShelfLocation };
      return {
        ...line,
        ...(location === undefined ? {} : { shelf: shelfAddress(location) }),
        unmapped,
      };
    }),
    orderedBy: walk.ordering,
    unmapped: walk.unmapped,
  };
}

/**
 * The warehouse handheld's payload: the assignment the cloud gave this box — bins, the catalogue for
 * scanning, what is on order, what is awaiting put-away and what is under recall (M09 / OA-9). Absent
 * means the box has never been told about warehouse work, and the shell says so rather than showing
 * empty bins that read as a shift already finished.
 *
 * It maps the pack's ordered lines' `unitCostMinor`/`currency` into the `{ minor, currency }` money
 * shape the receiving engine expects, and carries every other section through unchanged — the offline
 * `WarehouseSession` boots on exactly this. Nothing is defaulted: an absent section stays absent.
 */
export function warehousePayload(input: ScreenInput): Record<string, unknown> | null {
  if (!input.pack.warehouse.known) return null;
  const w = input.pack.warehouse.value;
  return {
    assignmentId: w.assignmentId,
    workerId: w.workerId,
    storeId: w.storeId,
    bins: w.bins,
    ...(w.contents === undefined ? {} : { contents: w.contents }),
    ...(w.goodsIn === undefined ? {} : { goodsIn: w.goodsIn.map((g) => ({ ...g, recalled: g.recalled === true })) }),
    ...(w.barcodes === undefined ? {} : { barcodes: w.barcodes }),
    ...(w.grnId === undefined ? {} : { grnId: w.grnId }),
    ...(w.poId === undefined ? {} : { poId: w.poId }),
    ...(w.ordered === undefined ? {} : { ordered: w.ordered.map((o) => ({ productId: o.productId, quantityMinor: o.quantityMinor, unitCost: { minor: o.unitCostMinor, currency: o.currency } })) }),
    // OB-37: the store's open deliveries, each with what is still to arrive — the phone lets the receiver choose one.
    ...(w.openDeliveries === undefined ? {} : { openDeliveries: w.openDeliveries.map((d) => ({
      poId: d.poId, number: d.number, supplierId: d.supplierId, grnId: d.grnId,
      ordered: d.ordered.map((o) => ({ productId: o.productId, quantityMinor: o.quantityMinor, unitCost: { minor: o.unitCostMinor, currency: o.currency } })),
    })) }),
    ...(w.recalledProductIds === undefined ? {} : { recalledProductIds: w.recalledProductIds }),
    ...(w.recalledBatchIds === undefined ? {} : { recalledBatchIds: w.recalledBatchIds }),
    // The pick list, line by line, each naming its bin. Passed through as sent — absent stays absent, so a
    // handheld given no pick work shows none rather than an empty list that reads as "all picked".
    ...(w.pickLines === undefined ? {} : { pickLines: w.pickLines.map((l) => ({
      lineId: l.lineId, orderRef: l.orderRef, productId: l.productId, batchId: l.batchId ?? null,
      binId: l.binId, quantityMinor: l.quantityMinor, uom: l.uom,
    })) }),
    // SP-8c: the floor indents the back store owes, from head office's register as the box last pulled it — approved or
    // part-issued, lines with something still owed, for THIS back store when the pack names one. Absent stays absent.
    ...indentLinesFor(input),
  };
}

/** SP-8c: the handheld's issue list — one row per owed indent line, from the register the box holds. */
function indentLinesFor(input: ScreenInput): Record<string, unknown> {
  if (!input.pack.floorIndents.known) return {};
  const feed = input.pack.floorIndents.value;
  const backStore = input.pack.policies.known ? input.pack.policies.value.warehouseId : undefined;
  const indentLines = feed.indents
    .filter((i) => (i.state === 'approved' || i.state === 'issuing') && (backStore === undefined || i.fromLocationId === undefined || i.fromLocationId === backStore))
    // A row head office sent without its totals yields no issue line: nothing owed can be derived from it, and the box
    // derives, never invents.
    .flatMap((i) => (i.totals?.lines === undefined ? [] : i.totals.lines)
      .filter((l) => typeof l.outstandingMinor === 'number' && l.outstandingMinor > 0)
      .map((l) => ({
        indentId: i.indentId, productId: l.productId, uom: typeof l.uom === 'string' ? l.uom : 'EA', outstandingMinor: l.outstandingMinor,
        requestedBy: i.requestedBy ?? '', toLocationId: i.toLocationId ?? '',
      })));
  return { indentLines, indentsAsAt: feed.asAt };
}

/**
 * The Web ERP warehouse **supervisor's** payload (M09 / OA-9): the bin configuration and — where the
 * box has been told it — the current bin contents and what is under recall, so the supervisor's screen
 * can show stock visibility, bin occupancy and the exception queue. It reads the **same** `warehouse`
 * section the handheld does (one authoritative source, no duplicated data), and the oversight
 * derivations (occupancy, negative bins, over-capacity, recalled-in-a-pickable-bin) live in the tested
 * supervisor session, not here. Absent means the box has never been told about warehouse work, and the
 * screen says so. Nothing is defaulted: stock visibility stays absent unless contents were sent.
 */
export function warehouseSupervisorPayload(input: ScreenInput): Record<string, unknown> | null {
  if (!input.pack.warehouse.known) return null;
  const w = input.pack.warehouse.value;
  return {
    storeId: w.storeId,
    bins: w.bins,
    ...(w.contents === undefined ? {} : { contents: w.contents }),
    ...(w.recalledProductIds === undefined ? {} : { recalledProductIds: w.recalledProductIds }),
    ...(w.recalledBatchIds === undefined ? {} : { recalledBatchIds: w.recalledBatchIds }),
    // Mapped into the approvals-engine shapes the supervisor session consumes, so no rule is
    // re-implemented downstream. A request with no value stays value:null (never defaulted to zero).
    ...(w.approvals === undefined ? {} : { approvals: w.approvals.map((a) => ({
      id: a.id, subjectType: a.subjectType, subjectRef: a.subjectRef, requestedBy: a.requestedBy,
      branchId: a.branchId ?? null,
      value: a.valueMinor === undefined ? null : { minor: a.valueMinor, currency: a.currency ?? 'INR' },
      status: 'pending',
    })) }),
    ...(w.supervisor === undefined ? {} : { supervisor: {
      userId: w.supervisor.userId, branchScope: w.supervisor.branchScope,
      authorityLimit: w.supervisor.authorityLimitMinor === undefined ? null : { minor: w.supervisor.authorityLimitMinor, currency: w.supervisor.currency ?? 'INR' },
    } }),
    asAt: input.now,
  };
}

/** The address a picker reads on the aisle sign, or the numbers when there is no sign. */
function shelfAddress(location: ShelfLocation): string {
  const base = location.label ?? `${location.aisle}-${location.rack}-${location.bay}-${location.shelf}`;
  return location.zone === undefined || location.zone === 'ambient' ? base : `${base} (${location.zone})`;
}

/**
 * Plan today's deliveries on this box (M19-FR-03).
 *
 * **Dispatch runs here rather than in the cloud, and that is the whole reason it is in this file.**
 * Vans go out whether or not the line is up. A shop whose routes could only be planned when the
 * internet was working would be a shop that stops delivering on the afternoon the router dies —
 * which is precisely the day it can least afford to (P-01).
 *
 * Returns `null` when the box has not been told the orders, the fleet or the rules to plan by. Not
 * an empty plan: an empty plan says *nobody has any deliveries today*, and that is a different
 * sentence from *I have not been told what today's deliveries are*.
 */
export function dispatchPlanFor(input: ScreenInput): DispatchPlan | null {
  if (!input.pack.deliveries.known || !input.pack.drivers.known || !input.pack.routingPolicy.known) {
    return null;
  }
  const policy = input.pack.routingPolicy.value;
  return planDispatch({
    runDate: input.tradingDay,
    orders: input.pack.deliveries.value,
    // A van off the road simply is not in the fleet for the day. The planner then re-plans around
    // it rather than having somebody's stops appended to another driver's run in whatever order
    // they happened to be in (M19-FR-03, "partner unavailable → reassign").
    drivers: input.pack.drivers.value.filter((d) => d.unavailable !== true),
    policy: {
      storeLocation: policy.storeLocation,
      radiusMetres: policy.radiusMetres,
      averageSpeedKmh: policy.averageSpeedKmh,
      serviceMinutesPerStop: policy.serviceMinutesPerStop,
      ...(policy.contributionRule === undefined ? {} : { contributionRule: policy.contributionRule }),
    },
  });
}

/**
 * The driver's payload — the route this box planned, or the one a dispatcher wrote by hand.
 *
 * **A hand-written route wins.** A dispatcher who knows the bridge is shut has to be able to say
 * so, and software that cannot be overridden gets worked around instead — which means a driver with
 * a piece of paper and a screen that disagrees with it. The screen is told **which of the two** it
 * is showing rather than leaving the driver to work it out.
 */
export function driverPayload(input: ScreenInput, driverId?: string): Record<string, unknown> | null {
  const policies = input.pack.policies.known ? input.pack.policies.value : undefined;
  const tolerance = policies === undefined ? {} : { handoverToleranceMinor: policies.handoverToleranceMinor };

  if (input.pack.route.known && input.pack.route.value !== null) {
    const route = input.pack.route.value;
    return {
      routeId: route.routeId,
      driverId: route.driverId,
      stops: route.stops,
      plannedBy: 'a dispatcher, by hand',
      ...(route.contributionRule === undefined ? {} : { contributionRule: route.contributionRule }),
      ...tolerance,
    };
  }

  // HA-1: a route head office assigned to this store's driver — the normal source when no dispatcher overrode it by hand.
  if (input.pack.assignments.known) {
    const assigned = input.pack.assignments.value;
    const route = driverId === undefined ? assigned.routes[0] : assigned.routes.find((r) => r.driverId === driverId);
    if (route !== undefined) {
      return {
        routeId: route.routeId,
        driverId: route.driverId,
        stops: route.stops,
        plannedBy: `head office, as of ${assigned.asAt}`,
        routesAssigned: assigned.routes.length,
        ...(route.contributionRule === undefined ? {} : { contributionRule: route.contributionRule }),
        ...tolerance,
      };
    }
  }

  const plan = dispatchPlanFor(input);
  if (plan === null) return null;

  // Whose route this is. Absent a named driver the box serves the first planned run, which is what
  // a single-van shop wants; a fleet passes the driver.
  const route = driverId === undefined ? plan.routes[0] : plan.routes.find((r) => r.driverId === driverId);
  if (route === undefined) return null;

  return {
    routeId: route.routeId,
    driverId: route.driverId,
    plannedBy: 'this store box',
    // Carried through so the screen can say it, rather than presenting a straight-line estimate as
    // a road distance. There is no map here and a river between two stops makes the order wrong.
    distancesAre: plan.distancesAre,
    stops: route.stops.map((s) => ({
      stopId: s.stopId,
      orderRef: s.orderId,
      area: s.area,
      codMinor: s.codMinor,
      ...(s.orderValueMinor === undefined ? {} : { orderValueMinor: s.orderValueMinor }),
      // The straight-line leg, used by the contribution rule the driver's own session applies.
      costMinor: s.legMetres,
    })),
    estimatedReturnAt: route.estimatedReturnAt,
    totalCodMinor: route.totalCodMinor,
    ...tolerance,
  };
}

/**
 * The customer's payload.
 *
 * The pack version travels with it, and that is not decoration: the app ties its basket review to
 * the version it was priced against, and paying against an older one is refused rather than quietly
 * repriced (P-02). Serving prices without the version would remove that check entirely.
 */
export function customerPayload(input: ScreenInput): Record<string, unknown> | null {
  if (!input.pack.products.known) return null;
  const policies = input.pack.policies.known ? input.pack.policies.value : undefined;
  // Delivery serviceability rides on the routing policy — the SAME store location and radius the
  // driver dispatch uses (§6.2, one commerce truth). Without it the app defaulted its store to
  // {0,0}, which is 9,000 km from every real address, so it refused everyone; emitting it is what
  // makes the 10 km out-of-area check actually distinguish a 9 km address from an 11 km one.
  const routing = input.pack.routingPolicy.known ? input.pack.routingPolicy.value : undefined;
  // The day's delivery slots, GENERATED from the store's delivery policy (M20-FR-03) for this
  // trading day, or the concrete slots the pack carried, or none — never an invented slot.
  const generated = deliverySlotsFor(routing, input.tradingDay);
  const slots = generated !== undefined ? generated
    : input.pack.slots.known ? input.pack.slots.value : undefined;
  return {
    // The store that fulfils the app's orders is the store of the pack — the same basis the till's
    // own stock movements use (`store_of_pack`) — so a customer's reservation and the till's sale
    // draw on ONE stock figure (P-02). Without a pack policy the app is told no store, and refuses
    // to send an order rather than guess one.
    ...(policies === undefined ? {} : { tenantId: policies.storeId, locationId: policies.storeId, privacySlaDays: policies.privacySlaDays }),
    packVersion: input.pack.version,
    products: input.pack.products.value.map((p) => ({
      productId: p.productId,
      name: p.name,
      ...(p.nameTa === undefined ? {} : { nameTa: p.nameTa }),
      categoryId: p.categoryId,
      unitPriceMinor: p.unitPriceMinor,
      uom: p.uom,
      barcodes: p.barcodes,
      status: 'active',
      availableMinor: p.availableMinor,
      ...(p.ageRestricted === undefined ? {} : { ageRestricted: p.ageRestricted }),
    })),
    ...(routing === undefined ? {} : { storeLocation: routing.storeLocation, policy: { radiusMetres: routing.radiusMetres } }),
    ...(slots === undefined ? {} : { slots }),
    ...(input.pack.consentPurposes.known ? { consentPurposes: input.pack.consentPurposes.value } : {}),
  };
}

/**
 * The day's bookable delivery slots from a store's delivery policy, or `undefined` when the store
 * has no delivery-slot policy set (then the caller uses whatever concrete slots the pack carried,
 * or none). Generation is deterministic and invents nothing — a malformed window or a count that
 * would produce sub-millisecond slivers yields no slots, never a guess (the engine guards it).
 */
function deliverySlotsFor(
  routing: PackRoutingPolicy | undefined,
  tradingDay: string,
): readonly PackSlot[] | undefined {
  if (routing === undefined) return undefined;
  const { deliverySlotsPerDay, deliveryWindowOpen, deliveryWindowClose, deliverySlotCapacity } = routing;
  if (deliverySlotsPerDay === undefined || deliveryWindowOpen === undefined
    || deliveryWindowClose === undefined || deliverySlotCapacity === undefined) {
    return undefined;
  }
  // Local "HH:MM" on the trading day → an absolute instant: parse as UTC, then shift back by the
  // store's offset so "09:00" at +05:30 is 03:30Z, the moment it actually is 9 am at the store.
  const offMs = (routing.deliveryUtcOffsetMinutes ?? 0) * 60_000;
  const startMs = Date.parse(`${tradingDay}T${deliveryWindowOpen}:00Z`) - offMs;
  const endMs = Date.parse(`${tradingDay}T${deliveryWindowClose}:00Z`) - offMs;
  // A malformed window (unparseable "HH:MM" or day) → no slots, never a thrown Invalid Date.
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return undefined;
  const generated = generateDeliverySlots({
    windowStartIso: new Date(startMs).toISOString(),
    windowEndIso: new Date(endMs).toISOString(),
    slotsPerDay: deliverySlotsPerDay,
    capacityPerSlot: deliverySlotCapacity,
  });
  return generated.length > 0 ? generated : undefined;
}

/**
 * Fold a list of documents into a map keyed by their reference, summing quantities per product.
 *
 * Two goods receipts against one purchase order is an ordinary Tuesday — half the order on Monday
 * and the rest on Thursday. Keying by the order number and letting the second overwrite the first
 * would quietly report that only Thursday's half ever arrived, and the three-way match would then
 * withhold payment for goods that are sitting on the shelf.
 *
 * So they accumulate. The same fold is used for orders and for captured invoices, where a repeated
 * reference is a producer fault rather than a real second document — and there it fails toward
 * *blocked*, because a doubled invoiced quantity exceeds what was received and the match refuses.
 * Wrong, and refusing, is survivable. Wrong, and paying, is not.
 */
function foldByReference<TLine extends { readonly productId: string }>(
  documents: readonly { readonly reference: string; readonly lines: readonly TLine[] }[],
  merge: (into: TLine, next: TLine) => TLine,
): Record<string, TLine[]> {
  const out: Record<string, TLine[]> = {};
  for (const doc of documents) {
    const lines = out[doc.reference];
    const target = lines === undefined ? (out[doc.reference] = []) : lines;
    for (const line of doc.lines) {
      const index = target.findIndex((l) => l.productId === line.productId);
      const existing = index === -1 ? undefined : target[index];
      if (existing === undefined) target.push(line);
      else target[index] = merge(existing, line);
    }
  }
  return out;
}

/**
 * The buyer's payload (M06 · M07 · §28).
 *
 * `null` when this box has never been told who buys or what this tenant's match tolerances are —
 * because a buying screen that invented its own tolerances would be deciding, on its own authority,
 * how much of a price difference is worth nobody's attention.
 *
 * The three document sets are each served **only when the pack carried them**. The buyer's screen
 * then names each one it did not get, in a sentence, on the page. That matters more here than
 * anywhere else in this file: every missing set fails toward a refusal rather than a false
 * all-clear, so the danger is not a wrong answer, it is a buyer who cannot tell a supplier who
 * genuinely overcharged from a box that was never told what the order said.
 */
export function buyingPayload(input: ScreenInput): Record<string, unknown> | null {
  if (!input.pack.buyingPolicy.known) return null;
  const policy = input.pack.buyingPolicy.value;

  const payload: Record<string, unknown> = {
    // PA-06 part 3b: the buyer is the person who SIGNED IN, never whoever the pack named. Built here as nobody; the
    // screen server re-addresses it to the signed-in person (`asSignedInPerson`), and with nobody signed in the screen
    // says so and saves nothing.
    buyerId: null,
    // SP-7a: the store this screen serves, so the buyer's durable invoice queue is keyed per store like the manager's.
    ...(input.pack.policies.known ? { storeId: input.pack.policies.value.storeId } : {}),
    // The buyer is removed from this list on the box, by `asSignedInPerson`, rather than trusted to leave themselves
    // alone. Separation of duties enforced only by the list somebody was shown is not enforced at all (§28).
    approvers: Array.isArray(policy.approvers) ? [...policy.approvers] : [],
    quantityToleranceBps: policy.quantityToleranceBps,
    priceToleranceBps: policy.priceToleranceBps,
    immaterialMinor: policy.immaterialMinor,
  };

  if (input.pack.products.known) {
    payload['productIds'] = input.pack.products.value.map((p) => p.productId);
    // OB-31: each product's unit, so the buyer's screen checks a weighed line as grams × price per kg.
    payload['productUoms'] = Object.fromEntries(input.pack.products.value.map((p) => [p.productId, p.uom]));
  }
  if (input.pack.purchaseOrders.known) {
    payload['ordered'] = foldByReference(
      input.pack.purchaseOrders.value.map((po) => ({ reference: po.poId, lines: po.lines })),
      (into, next) => ({ ...into, qty: into.qty + next.qty }),
    );
  }
  if (input.pack.receipts.known) {
    payload['received'] = foldByReference(
      input.pack.receipts.value.map((r) => ({ reference: r.poId, lines: r.lines })),
      (into, next) => ({ ...into, qty: into.qty + next.qty }),
    );
  }
  if (input.pack.supplierInvoices.known) {
    payload['captured'] = foldByReference(
      input.pack.supplierInvoices.value.map((i) => ({ reference: i.invoiceId, lines: i.lines })),
      (into, next) => ({
        ...into,
        quantity: into.quantity + next.quantity,
        lineTotalMinor: into.lineTotalMinor + next.lineTotalMinor,
      }),
    );
  }

  return payload;
}

/**
 * The product-and-pricing payload (M03 · M05 · D01 · §28).
 *
 * `null` when this box has never been told who prices or what margin this tenant will not go below
 * — a screen that invented its own margin floor would be deciding, on its own authority, how much
 * of the shop's profit is worth nobody's attention.
 *
 * **What things cost is served from the pack's own cost prices, and a product with none is simply
 * absent from the map.** Not zero. A cost of zero makes every price look like a 100% margin, so the
 * floor check passes loudly and wrongly at the moment somebody is relying on it — the screen turns
 * an absent cost into a refusal that needs an approver, which is the honest answer.
 */
export function cataloguePayload(input: ScreenInput): Record<string, unknown> | null {
  if (!input.pack.pricingPolicy.known) return null;
  const policy = input.pack.pricingPolicy.value;

  const payload: Record<string, unknown> = {
    userId: policy.userId,
    storeId: input.pack.policies.known ? input.pack.policies.value.storeId : 'store-1',
    // The shop's own trading day, not the browser's clock. A device whose date is a day out would
    // otherwise activate tomorrow's price today.
    today: input.tradingDay,
    marginFloorBps: policy.marginFloorBps,
    // The setter is removed here rather than trusted to leave themselves alone (§28). The session
    // model refuses a self-approval as well; this stops it ever being offered.
    approvers: policy.approvers.filter((who) => who !== policy.userId),
  };

  if (input.pack.categories.known) payload['categories'] = input.pack.categories.value;
  if (input.pack.productMaster.known) payload['products'] = input.pack.productMaster.value;
  if (input.pack.priceEntries.known) {
    payload['priceEntries'] = input.pack.priceEntries.value.map((e) => ({
      id: e.id,
      productId: e.productId,
      scope: e.scope,
      scopeRef: e.scopeRef,
      // The wire carries minor units; the engine takes Money. Converting here rather than at every
      // call site means one place can be wrong instead of six — the same fault the manager's
      // approval inbox had once, where a bare number met code expecting `value.currency`.
      price: { minor: e.priceMinor, currency: 'INR' },
      effectiveFrom: e.effectiveFrom,
      ...(e.effectiveTo === undefined ? {} : { effectiveTo: e.effectiveTo }),
      status: e.status,
      version: e.version,
    }));
  }
  if (input.pack.products.known) {
    payload['barcodes'] = input.pack.products.value.flatMap((p) =>
      p.barcodes.map((barcode) => ({ barcode, productId: p.productId })));
    // Only the products that HAVE a cost. An entry of zero for the rest would be the whole point,
    // missed: the screen must be able to tell "it cost us nothing" from "nobody has told me".
    const costs: Record<string, number> = {};
    for (const product of input.pack.products.value) {
      if (product.unitCostMinor !== undefined) costs[product.productId] = product.unitCostMinor;
    }
    payload['costsMinor'] = costs;
  }

  // The shelf map, served as its parts rather than as a built map — the screen builds its own so
  // that anything assigned on it is kept while the person carries on working.
  if (input.pack.shelfLocations.known) payload['shelfLocations'] = input.pack.shelfLocations.value;
  if (input.pack.shelfAssignments.known) payload['shelfAssignments'] = input.pack.shelfAssignments.value;
  if (input.pack.shelfPolicy.known && input.pack.shelfPolicy.value.zoneOrder !== undefined) {
    payload['zoneOrder'] = input.pack.shelfPolicy.value.zoneOrder;
  }

  return payload;
}

/**
 * The merchandising payload (M04 · D02).
 *
 * `null` when this box has never been told the refill level or how long a count stays worth acting
 * on — a screen inventing those would be deciding, on its own authority, when a shelf is empty
 * enough to walk to and how old a reading may be before it is a waste of somebody's time.
 *
 * **Every other section is served only when the pack carried it**, and the screen names each gap.
 * The two that matter most: an absent planogram makes the check refuse outright rather than report
 * a clean shop, and an absent stockroom figure turns every refill task into a wish.
 */
export function merchandisingPayload(input: ScreenInput): Record<string, unknown> | null {
  if (!input.pack.merchandisingPolicy.known) return null;
  const policy = input.pack.merchandisingPolicy.value;

  const payload: Record<string, unknown> = {
    storeId: input.pack.policies.known ? input.pack.policies.value.storeId : 'store-1',
    // The shop's own trading day and the box's own clock. A tablet whose date is a day out would
    // otherwise judge every count as stale — or, worse, a three-day-old one as fresh.
    today: input.tradingDay,
    now: input.now,
    refillAtBp: policy.refillAtBp,
    countStaleAfterMinutes: policy.countStaleAfterMinutes,
    refillRole: policy.refillRole,
  };

  // SP-8c-ii: who counts, and the link to the indent chain. The counter's name goes on every count the screen queues for
  // head office (which re-verifies it from their grants); the Indents policy gives the refill tasks their way to become ONE
  // indent on the SAME durable queue the Floor indents screen uses. Named only when the pack named somebody — never a stand-in.
  const indentsPolicy = input.pack.indentsPolicy.known ? input.pack.indentsPolicy.value : undefined;
  const who = policy.userId ?? indentsPolicy?.userId;
  if (who !== undefined) payload['userId'] = who;
  if (policy.permissions !== undefined) payload['permissions'] = policy.permissions;
  if (indentsPolicy !== undefined) {
    const indents: Record<string, unknown> = { permissions: indentsPolicy.permissions };
    if (who !== undefined) indents['userId'] = who;
    if (input.pack.policies.known) {
      indents['storeId'] = input.pack.policies.value.storeId;
      indents['backStoreId'] = input.pack.policies.value.warehouseId;
    }
    if (input.pack.products.known) {
      indents['products'] = input.pack.products.value.map((p) => ({ productId: p.productId, name: p.name, ...(p.nameTa === undefined ? {} : { nameTa: p.nameTa }), uom: p.uom }));
    }
    payload['indents'] = indents;
  }

  if (input.pack.shelfLocations.known) payload['shelfLocations'] = input.pack.shelfLocations.value;
  if (input.pack.shelfAssignments.known) payload['shelfAssignments'] = input.pack.shelfAssignments.value;
  if (input.pack.planogram.known) payload['planogram'] = input.pack.planogram.value;
  if (input.pack.shelfCounts.known) payload['shelfCounts'] = input.pack.shelfCounts.value;
  if (input.pack.backstock.known) payload['backstock'] = input.pack.backstock.value;
  if (input.pack.assortment.known) payload['assortment'] = input.pack.assortment.value;
  if (input.pack.products.known) {
    // On-hand from the catalogue pack's own availability. **This is the figure that decides whether
    // dropping an item deletes it or routes it to clearance**, so serving nothing here would be the
    // dangerous default: every drop would delist, and the stock still on the shelf would become
    // invisible — not counted, not replenished, not sold, eventually written off.
    const onHand: Record<string, number> = {};
    for (const product of input.pack.products.value) onHand[product.productId] = product.availableMinor;
    payload['onHand'] = onHand;
  }
  if (input.pack.spaceAreas.known) payload['spaceAreas'] = input.pack.spaceAreas.value;
  if (input.pack.salesByAreaMinor.known) payload['salesByAreaMinor'] = input.pack.salesByAreaMinor.value;
  if (input.pack.marginByAreaMinor.known) payload['marginByAreaMinor'] = input.pack.marginByAreaMinor.value;
  if (input.pack.displayContracts.known) payload['displayContracts'] = input.pack.displayContracts.value;
  if (input.pack.fundingReceivedMinor.known) payload['fundingReceivedMinor'] = input.pack.fundingReceivedMinor.value;
  if (input.pack.stillOccupying.known) payload['stillOccupying'] = input.pack.stillOccupying.value;

  // Everything this box has ever recorded selling — deliberately the whole log rather than today,
  // because the question the range check asks is *has this shop ever sold something it does not
  // range?*, and an item that sold last Tuesday is exactly as much evidence as one that sold this
  // morning. A sale record with no readable lines contributes nothing rather than defaulting,
  // because "this sale had no lines" is a broken record, not a sale of nothing.
  const sold = new Set<string>();
  for (const sale of input.sales) {
    if (sale.lines === undefined) continue;
    for (const line of sale.lines) sold.add(line.productId);
  }
  payload['soldProductIds'] = [...sold];

  return payload;
}

/**
 * The reporting payload (D13 · M29-FR-01/02 · §32).
 *
 * `null` when the box has never been told when a figure stops being current — a screen inventing
 * its own staleness thresholds would be deciding, on its own authority, how old a number may be
 * before somebody should stop making decisions on it.
 *
 * **`reportingRecords` is the important one.** It is what the shop actually records, and everything
 * absent from it makes its reports refuse **by name** rather than run and come back as zero. Served
 * only when the pack carried it: a box that was never told runs nothing and says so for each
 * report, which is the honest state for a shop that has just been switched on.
 */
export function reportingPayload(input: ScreenInput): Record<string, unknown> | null {
  if (!input.pack.reportingPolicy.known) return null;
  const policy = input.pack.reportingPolicy.value;
  const policies = input.pack.policies.known ? input.pack.policies.value : undefined;

  const payload: Record<string, unknown> = {
    storeId: policies?.storeId ?? 'store-1',
    branchId: policies?.branchId ?? null,
    // The box's own clock. A device an hour out would quietly relabel a stale figure as live.
    now: input.now,
    laggingAfterMinutes: policy.laggingAfterMinutes,
    staleAfterMinutes: policy.staleAfterMinutes,
    // This box's own queue and its own log — the two facts the cloud cannot supply, by definition.
    unsentCount: input.outbox.pending().length,
    lastSyncedAt: input.pack.receivedAt,
  };

  // Served only when the pack named one. Not defaulted: an export's audit record names who took
  // the data, and a made-up id there is worse than no export at all.
  if (policy.userId !== undefined) payload['userId'] = policy.userId;

  if (input.pack.reportingRecords.known) payload['records'] = input.pack.reportingRecords.value;
  if (input.pack.roles.known) payload['roles'] = input.pack.roles.value;
  if (input.pack.roleAssignments.known) payload['roleAssignments'] = input.pack.roleAssignments.value;

  // **TODAY's** sales, reduced to reporting facts. The log is never rotated, so this was the whole
  // history — "Sales by day: Taken ₹2,245" on a day the shop took ₹145, with nothing saying so.
  const today = salesOn(input.sales, input.tradingDay);
  payload['tradingDay'] = input.tradingDay;
  if (today.undated > 0) payload['undatedSales'] = today.undated;

  // A sale whose products have no cost price carries NO cogs rather than a zero — zero cost
  // reports a 100% margin, and the margin report leaves it out and counts it instead.
  const products = input.pack.products.known ? input.pack.products.value : [];
  const costOf = new Map(products.filter((p) => p.unitCostMinor !== undefined)
    .map((p) => [p.productId, p.unitCostMinor!] as const));
  payload['sales'] = today.sales.map((sale) => {
    // A record with no readable lines keeps its takings — the till printed them and they are real —
    // but it carries NO basket size. A zero would be averaged into "units per basket" and quietly
    // drag the shop's figure down by an amount nobody could explain.
    //
    // The costing and the basket size both come from `read-model`, which is where this box already
    // works them out for the owner's brief. Writing them again here is how the two screens end up
    // quoting different margins for the same day.
    const lines = sale.lines;
    let cogs = 0;
    let costable = lines !== undefined && lines.length > 0;
    if (lines !== undefined) {
      for (const line of lines) {
        const unit = costOf.get(line.productId);
        if (unit === undefined) { costable = false; break; }
        cogs += lineCostMinor(unit, line);
      }
    }
    return {
      saleId: sale.id,
      committedAt: sale.committedAt ?? input.now,
      cashierId: sale.cashierId ?? 'unknown',
      netMinor: sale.netMinor ?? 0,
      taxMinor: sale.taxMinor ?? 0,
      totalMinor: sale.total ?? 0,
      ...(costable ? { cogsMinor: cogs } : {}),
      ...(lines === undefined ? {} : { units: basketUnits(lines) }),
      tender: sale.tenders?.[0]?.kind ?? 'unknown',
      // Every payment by its own kind and amount (audit EA-02): the tender report splits a bill across what paid it.
      tenders: tenderPartsOf(sale),
    };
  });

  // ── What today is compared against (M29-FR-02) ────────────────────────────
  //
  // A number on its own says almost nothing to a shopkeeper. ₹1,40,000 is a good Saturday and a
  // frightening Tuesday, and the figure is identical. So every trading day this box holds is
  // summarised — one small row each, rather than shipping the whole log to a browser — and today
  // is compared against the one before it.
  //
  // **Only the days this box actually holds.** A box installed on Thursday has no Wednesday, and
  // a comparison against a Wednesday of zero would report the shop as having doubled its takings
  // overnight. Absent is absent, and the report says so by name.
  const perDay = new Map<string, { total: number; bills: number }>();
  for (const sale of input.sales) {
    if (sale.tradingDay === undefined) continue;
    const held = perDay.get(sale.tradingDay) ?? { total: 0, bills: 0 };
    perDay.set(sale.tradingDay, { total: held.total + (sale.total ?? 0), bills: held.bills + 1 });
  }
  payload['dayTotals'] = tradingDaysHeld(input.sales).map((tradingDay) => ({
    tradingDay,
    totalMinor: perDay.get(tradingDay)!.total,
    bills: perDay.get(tradingDay)!.bills,
  }));

  // What sold, by department, in UNITS.
  //
  // Units rather than money on purpose: the log records a quantity per line but **no money per
  // line**, so revenue by department could only be reconstructed from list prices — and a bill
  // with a promotion on it would then produce a department revenue that does not add up to the
  // day's takings. A figure that nearly reconciles is worse than one that is honestly a count.
  const categoryOf = new Map(products.map((p) => [p.productId, p.categoryId] as const));
  const unitsByCategory: Record<string, number> = {};
  let unitsWithNoCategory = 0;
  for (const sale of today.sales) {
    if (sale.lines === undefined) continue;
    for (const line of sale.lines) {
      const units = line.uom === 'ea' ? line.quantityMinor : 1;
      const category = categoryOf.get(line.productId);
      if (category === undefined) { unitsWithNoCategory += units; continue; }
      unitsByCategory[category] = (unitsByCategory[category] ?? 0) + units;
    }
  }
  payload['unitsByCategory'] = unitsByCategory;
  // Counted, not folded into a department. A product the catalogue does not place is a catalogue
  // problem, and hiding it inside "Grocery" is how it stays one.
  if (unitsWithNoCategory > 0) payload['unitsWithNoCategory'] = unitsWithNoCategory;
  if (input.pack.categories.known) {
    payload['categoryNames'] = Object.fromEntries(
      input.pack.categories.value.map((c) => [c.categoryId, c.name] as const),
    );
  }

  // The exception register, and whether the shop's limits were known at all. Zero exceptions with
  // no rules is not a clean shop; it is a shop nobody is watching.
  const rules = input.pack.lossPreventionRules.known
    ? (input.pack.lossPreventionRules.value as readonly LpRule[])
    : undefined;
  const day = exceptionsFor(activityFrom(today.sales), rules);
  payload['exceptionRulesKnown'] = day.rulesKnown;
  payload['exceptions'] = day.exceptions.map((e) => ({
    what: `${e.kind.replace(/_/g, ' ')} by ${e.cashierId}: ${e.observed} against a limit of ${e.limit}`,
  }));

  return payload;
}

/**
 * The service desk's payload (M13 · M21 · API-05/API-06).
 *
 * `null` when the box has not been told the shop's own limits — a screen inventing its own return
 * window would be deciding how long this shop takes goods back for, and inventing its own refund
 * threshold would be deciding how much money may leave without a second signature.
 *
 * **The whole sales log, deliberately, not the trading day.** A customer brings back a receipt from
 * last Tuesday; that is the ordinary case and the reason the screen exists. This is the same
 * distinction the range check draws, in the other direction from the day's figures — and getting it
 * wrong here would make the desk unable to find any bill except one rung this morning.
 */
export function servicePayload(input: ScreenInput): Record<string, unknown> | null {
  if (!input.pack.servicePolicy.known) return null;
  const policy = input.pack.servicePolicy.value;
  const policies = input.pack.policies.known ? input.pack.policies.value : undefined;

  const payload: Record<string, unknown> = {
    storeId: policies?.storeId ?? 'store-1',
    branchId: policies?.branchId ?? null,
    now: input.now,
    tradingDay: input.tradingDay,
    returnWindowDays: policy.returnWindowDays,
    approvalThresholdMinor: policy.approvalThresholdMinor,
    noReceiptCapMinor: policy.noReceiptCapMinor,
    agentAuthorityMinor: policy.agentAuthorityMinor,
    compensationCapMinor: policy.compensationCapMinor,
  };
  // Not defaulted: a refund and a compensation both carry the name of whoever gave them into an
  // audit record that is the only evidence afterwards.
  if (policy.userId !== undefined) payload['userId'] = policy.userId;

  // Every bill this box holds, reduced to what a return needs. A record with no readable lines
  // cannot be returned against — there is nothing to check a quantity against — so it is left out
  // rather than offered as a bill with nothing on it.
  const bills: Record<string, unknown>[] = [];
  for (const sale of input.sales) {
    if (sale.lines === undefined || sale.number === undefined) continue;
    bills.push({
      saleId: sale.id,
      number: sale.number,
      tradingDay: sale.tradingDay ?? input.tradingDay,
      committedAt: sale.committedAt ?? input.now,
      totalMinor: sale.total ?? 0,
      lines: sale.lines.map((line) => ({
        productId: line.productId,
        uom: line.uom ?? 'ea',
        quantityMinor: line.quantityMinor,
      })),
      // How it was paid, served only when the record carried it. A bill with no recorded tender
      // is a bill the desk **cannot** offer "back to the original tender" against, and an empty
      // list would read as "paid by nothing" rather than "we do not know how this was paid".
      ...(sale.tenders === undefined ? {} : {
        tenders: sale.tenders.map((t) => ({
          kind: t.kind ?? 'unknown',
          amountMinor: t.amount?.minor ?? 0,
        })),
      }),
    });
  }
  payload['sales'] = bills;

  if (input.pack.returnHistory.known) payload['returnHistory'] = input.pack.returnHistory.value;
  if (input.pack.serviceCases.known) payload['cases'] = input.pack.serviceCases.value;
  if (input.pack.satisfaction.known) payload['satisfaction'] = input.pack.satisfaction.value;
  if (input.pack.slaPolicy.known) payload['slaPolicy'] = input.pack.slaPolicy.value;

  return payload;
}

/**
 * The expiry and recall payload (M10-FR-01…04).
 *
 * `null` when the box has not been told this shop's near-expiry window — a screen inventing its own
 * would be deciding how many days ahead counts as *going out of date*, which is a different number
 * for bread and for tinned goods and belongs to the shop.
 *
 * **The batches are served whether or not the shop tracks them**, because an absent `batches`
 * section and an empty one mean opposite things: *this shop does not track batches at all* versus
 * *nothing is going out of date*. The second is a reassuring sentence, and only one of them is true.
 */
export function expiryPayload(input: ScreenInput): Record<string, unknown> | null {
  if (!input.pack.expiryPolicy.known) return null;
  const policy = input.pack.expiryPolicy.value;
  const policies = input.pack.policies.known ? input.pack.policies.value : undefined;

  const payload: Record<string, unknown> = {
    storeId: policies?.storeId ?? 'store-1',
    branchId: policies?.branchId ?? null,
    // The box's own clock. A device a day out would call tomorrow's stock expired, or today's fine.
    now: input.now,
    tradingDay: input.tradingDay,
    nearExpiryDays: policy.nearExpiryDays,
  };
  if (policy.userId !== undefined) payload['userId'] = policy.userId;

  if (input.pack.batches.known) payload['batches'] = input.pack.batches.value;
  if (input.pack.recalls.known) payload['recalls'] = input.pack.recalls.value;

  // The names, so a screen about food safety shows a person a product and not a code.
  if (input.pack.products.known) {
    const names: Record<string, string> = {};
    for (const p of input.pack.products.value) names[p.productId] = p.name;
    payload['productNames'] = names;
  }

  return payload;
}

/**
 * The finance payload (M23-FR-04 / QG-07).
 *
 * `null` when the box has not been told this shop's own chart-of-accounts headings — a screen
 * inventing them would file a shop's takings under a heading its accountant does not use, and the
 * difference would surface as an unexplained control total nobody could resolve.
 *
 * **`financeLedger` is served only when the box has it.** Absent is absent: with no ledger side
 * there is nothing to compare the accounts against, and the screen refuses to close the month
 * rather than comparing the accounts with a substituted nought.
 */
export function financePayload(input: ScreenInput): Record<string, unknown> | null {
  if (!input.pack.financePolicy.known) return null;
  const policy = input.pack.financePolicy.value;
  const policies = input.pack.policies.known ? input.pack.policies.value : undefined;

  const payload: Record<string, unknown> = {
    storeId: policies?.storeId ?? 'store-1',
    now: input.now,
    period: policy.period,
    tradingDayCutoff: policy.tradingDayCutoff,
    journalPrefixes: policy.journalPrefixes,
    // This box's own queue is the honest source for what has not reached the cloud, and an unsent
    // sale is a sale the accounts cannot have seen either.
    unsentSyncCount: input.outbox.pending().length,
  };
  if (policy.userId !== undefined) payload['userId'] = policy.userId;

  if (input.pack.financeLedger.known) payload['ledger'] = input.pack.financeLedger.value;
  if (input.pack.tallyPostings.known) payload['postings'] = input.pack.tallyPostings.value;
  if (input.pack.periodState.known) payload['periodState'] = input.pack.periodState.value;

  return payload;
}

/**
 * The GST reconciliation payload (API-09 · A20/A23 · item 3 inc2/inc3).
 *
 * `null` when the box has not been told who is on the screen and what they may do — a screen inventing
 * its own permission set would be deciding, on its own authority, who may chase up a stuck e-invoice.
 *
 * **`rows` is served only when the box has the queue.** Absent is absent: the screen shows its sample
 * stand-in rather than an empty queue, because an empty queue reads as *every document is settled* and
 * exactly one of those is true. Nothing here reconciles anything — the rows are handed over as the box
 * last saw them, and a person triages them.
 */
export function gstReconciliationPayload(input: ScreenInput): Record<string, unknown> | null {
  if (!input.pack.gstReconciliationPolicy.known) return null;
  const policy: PackGstReconciliationPolicy = input.pack.gstReconciliationPolicy.value;

  const payload: Record<string, unknown> = { permissions: policy.permissions };
  if (policy.userId !== undefined) payload['userId'] = policy.userId;
  if (input.pack.gstReconciliationQueue.known) payload['rows'] = input.pack.gstReconciliationQueue.value;

  return payload;
}

/**
 * The category-rules payload (M03-FR-01·CAT-POLICY).
 *
 * `null` when the box has not been told who is on the screen — a screen inventing its own permissions would
 * decide, on its own authority, who may see the store's category configuration. The categories are served
 * only when the box has them, and the policies are RESOLVED on this box's own trading day (§32) — never the
 * browser's clock, which would show tomorrow's rules today.
 */
export function categoryPolicyPayload(input: ScreenInput): Record<string, unknown> | null {
  if (!input.pack.categoryPolicyPolicy.known) return null;
  const policy: PackCategoryPolicyPolicy = input.pack.categoryPolicyPolicy.value;

  const payload: Record<string, unknown> = { permissions: policy.permissions, onDate: input.tradingDay };
  if (policy.userId !== undefined) payload['userId'] = policy.userId;
  if (input.pack.categoryPolicyCategories.known) payload['categories'] = input.pack.categoryPolicyCategories.value;

  return payload;
}

/**
 * The GST-returns payload (owner directive item 3, the 4th UI domain; API-09; M23).
 *
 * `null` when the box has not been told who is on the screen — a screen inventing its own permissions would
 * decide, on its own authority, who may see the filing queue. The filing periods (each already folded to its
 * current submission state by the cloud) are served only when the box has them; absent means the shell shows
 * its sample stand-in, never an empty queue that would read as "every return filed".
 */
export function gstReturnsPayload(input: ScreenInput): Record<string, unknown> | null {
  if (!input.pack.gstReturnsPolicy.known) return null;
  const policy: PackGstReturnsPolicy = input.pack.gstReturnsPolicy.value;

  const payload: Record<string, unknown> = { permissions: policy.permissions };
  if (policy.userId !== undefined) payload['userId'] = policy.userId;
  if (input.pack.gstReturnsQueue.known) payload['rows'] = input.pack.gstReturnsQueue.value;

  return payload;
}

/**
 * The waste & write-off review payload (M28-FR-01).
 *
 * `null` when the box has not been told who is on the screen — a screen inventing its own permissions would
 * decide, on its own authority, who may review the shop's shrinkage. The recorded losses (each already folded
 * from the reason-coded compensating movements) are served only when the box has them; absent means the shell
 * shows its sample stand-in, never an empty list that would read as "no losses today".
 */
export function wastePayload(input: ScreenInput): Record<string, unknown> | null {
  if (!input.pack.wastePolicy.known) return null;
  const policy: PackWastePolicy = input.pack.wastePolicy.value;

  const payload: Record<string, unknown> = { permissions: policy.permissions };
  if (policy.userId !== undefined) payload['userId'] = policy.userId;
  if (input.pack.wasteWriteOffs.known) payload['rows'] = input.pack.wasteWriteOffs.value;

  return payload;
}

/**
 * The shop-floor write-off CAPTURE payload (M28-FR-01 · API-04 · §28).
 *
 * `null` when the box has not been told who is on the screen — a screen that invented its own permissions would
 * decide, on its own authority, who may record the shop's losses. **The material-loss threshold is sourced from
 * the pack**, and where the shop has set none the engine default (`DEFAULT_WRITE_OFF_THRESHOLD_MINOR`) is used —
 * the SAME line the server enforces, never a fabricated number presented as the shop's. The blocked cases
 * (evidence, a separate §28 approver, the raiser=caller rule) are all re-checked by the governed route; this
 * only shapes the operator's choices into the request.
 */
export function writeOffCapturePayload(input: ScreenInput): Record<string, unknown> | null {
  if (!input.pack.writeOffCapturePolicy.known) return null;
  const policy: PackWriteOffCapturePolicy = input.pack.writeOffCapturePolicy.value;

  const payload: Record<string, unknown> = {
    permissions: policy.permissions,
    materialThresholdMinor: policy.materialThresholdMinor ?? DEFAULT_WRITE_OFF_THRESHOLD_MINOR,
  };
  if (policy.userId !== undefined) payload['userId'] = policy.userId;

  return payload;
}

/**
 * The stock-count review payload (M09-FR-04).
 *
 * `null` when the box has not been told who is on the screen — a screen inventing its own permissions would
 * decide, on its own authority, who may review the shop's counts. The reconciled counts (each already folded
 * from the blind-count reconciliations) are served only when the box has them; absent means the shell shows
 * its sample stand-in, never an empty list that would read as "every count matched".
 */
export function countsPayload(input: ScreenInput): Record<string, unknown> | null {
  if (!input.pack.countsPolicy.known) return null;
  const policy: PackCountsPolicy = input.pack.countsPolicy.value;

  const payload: Record<string, unknown> = { permissions: policy.permissions };
  if (policy.userId !== undefined) payload['userId'] = policy.userId;
  if (input.pack.countsQueue.known) payload['rows'] = input.pack.countsQueue.value;

  return payload;
}

/**
 * The device fleet-manager payload (M33-FR-02/04, A-10).
 *
 * `null` when the box has not been told who is on the screen — a screen inventing its own permissions would
 * decide, on its own authority, who may register or block a till. **The fleet itself is NOT in this
 * payload**: it is read from the cloud fleet-health call (this device's screen fetches it when online, and
 * the shell shows a sample stand-in until then). This carries only the operator's CURRENT context — who is
 * looking and what they hold now — re-read every render; the cloud routes re-check the authority on every
 * register/block/retire, so this only shapes the UI and can never let a stale grant change the fleet.
 */
export function fleetPayload(input: ScreenInput): Record<string, unknown> | null {
  if (!input.pack.fleetPolicy.known) return null;
  const policy: PackFleetPolicy = input.pack.fleetPolicy.value;

  const payload: Record<string, unknown> = { permissions: policy.permissions };
  if (policy.userId !== undefined) payload['userId'] = policy.userId;

  return payload;
}

/**
 * The products-to-publish review payload (ADR-0013 slice 4, M03-FR-01/03).
 *
 * `null` when the box has not been told who is on the screen — a screen inventing its own permissions would
 * decide, on its own authority, who may publish a product to the shared catalogue. **The queue itself is NOT
 * in this payload**: it is the device-backed catalogue outbox (client-side), the same queue the catalogue Save
 * commits to, so the screen reads its own device's pending publishes. This payload carries only the operator's
 * CURRENT context (who is looking, what they hold now) — re-read every render, never the permissions captured
 * when an item was queued (ADR-0013 control 3). The cloud publish route re-checks the authority on delivery, so
 * this only shapes the review UI; it can never let a stale grant actually publish.
 */
export function productPublishReviewPayload(input: ScreenInput): Record<string, unknown> | null {
  if (!input.pack.productPublishReviewPolicy.known) return null;
  const policy: PackProductPublishReviewPolicy = input.pack.productPublishReviewPolicy.value;

  const payload: Record<string, unknown> = { permissions: policy.permissions };
  if (policy.userId !== undefined) payload['userId'] = policy.userId;

  return payload;
}

/**
 * The Data Quality inbox payload (A08 · API-13 · §7.1 · P-05).
 *
 * `null` when the box has not been told who is on the screen — a screen inventing its own permissions would
 * decide, on its own authority, who may see the shop's data-quality suggestions. **The worklist itself is NOT
 * in this payload**: it is read live from the cloud (`GET /v1/ai/data-quality/worklist`, which re-derives the
 * findings and honours the kill switch server-side); the shell fetches it when online and shows a sample
 * stand-in until then. This carries only the operator's CURRENT context — who is looking and what they hold
 * now — re-read every render; the cloud route re-checks the authority, so this only shapes the UI.
 */
export function dataQualityPayload(input: ScreenInput): Record<string, unknown> | null {
  if (!input.pack.dataQualityPolicy.known) return null;
  const policy: PackDataQualityPolicy = input.pack.dataQualityPolicy.value;

  const payload: Record<string, unknown> = { permissions: policy.permissions };
  if (policy.userId !== undefined) payload['userId'] = policy.userId;

  return payload;
}

/**
 * The Operations inbox payload (A06 · API-13 · §7.1 · P-05).
 *
 * `null` when the box has not been told who is on the screen. **The recommendations themselves are NOT in this
 * payload**: they are read live from the cloud (`GET /v1/ai/operations/worklist`, which re-derives them from
 * the live alerts and honours the kill switch server-side); the shell fetches it when online and shows a
 * sample stand-in until then. This carries only the operator's CURRENT context — who is looking and what they
 * hold now — re-read every render; the cloud route re-checks the authority, so this only shapes the UI.
 */
export function operationsPayload(input: ScreenInput): Record<string, unknown> | null {
  if (!input.pack.operationsInboxPolicy.known) return null;
  const policy: PackOperationsInboxPolicy = input.pack.operationsInboxPolicy.value;

  const payload: Record<string, unknown> = { permissions: policy.permissions };
  if (policy.userId !== undefined) payload['userId'] = policy.userId;

  return payload;
}

/**
 * The loss-prevention investigations inbox payload (M15-FR-04 · P-03 · §28).
 *
 * `null` when the box has not been told who is on the screen. **The open cases themselves are NOT in this
 * payload**: they are read live from the cloud (`GET /v1/loss-prevention/cases`); the shell fetches it when
 * online and shows a sample stand-in until then. This carries only the manager's CURRENT context — who is
 * looking and what they hold now — re-read every render; the cloud routes re-check the authority, so this only
 * shapes the UI.
 */
export function lossPreventionPayload(input: ScreenInput): Record<string, unknown> | null {
  if (!input.pack.lossPreventionPolicy.known) return null;
  const policy: PackLossPreventionPolicy = input.pack.lossPreventionPolicy.value;

  const payload: Record<string, unknown> = { permissions: policy.permissions };
  if (policy.userId !== undefined) payload['userId'] = policy.userId;

  return payload;
}

/**
 * The delivery-substitution exception inbox payload (M19-FR-01 · Item 2 · P-03 · §28).
 *
 * `null` when the box has not been told who is on the screen. **The exceptions themselves are NOT in this
 * payload**: they are read live from the cloud (`GET /v1/orders/substitution-exceptions`); the shell fetches it
 * when online and shows a sample stand-in until then. This carries only the member's CURRENT context — who is
 * looking and what they hold now — re-read every render; the cloud routes re-check the authority (and whether the
 * caller staffs the queue), so this only shapes the UI.
 */
export function substitutionExceptionsPayload(input: ScreenInput): Record<string, unknown> | null {
  if (!input.pack.substitutionExceptionPolicy.known) return null;
  const policy: PackSubstitutionExceptionPolicy = input.pack.substitutionExceptionPolicy.value;

  const payload: Record<string, unknown> = { permissions: policy.permissions };
  if (policy.userId !== undefined) payload['userId'] = policy.userId;

  return payload;
}

/**
 * The day-book payload (M23-FR-01 · P-03 · §28).
 *
 * `null` when the box has not been told who is on the screen. **The day itself is NOT in this payload**: it is read
 * live from the cloud (`GET /v1/finance/day-book/:tradingDay`) for the day the accountant chooses; the shell fetches
 * it when online and shows a sample stand-in until then. This carries only the accountant's CURRENT context — who is
 * looking and what they hold now — re-read every render; the cloud routes re-check the authority, so this only
 * shapes the UI.
 */
export function dayBookPayload(input: ScreenInput): Record<string, unknown> | null {
  if (!input.pack.dayBookPolicy.known) return null;
  const policy: PackDayBookPolicy = input.pack.dayBookPolicy.value;

  const payload: Record<string, unknown> = { permissions: policy.permissions };
  if (policy.userId !== undefined) payload['userId'] = policy.userId;

  return payload;
}

/**
 * The document-templates payload (M01-FR-02 · §28).
 *
 * `null` when the box has not been told who is on the screen. **The templates themselves are NOT in this
 * payload**: the register is read live from the cloud (`GET /v1/org/document-templates`); the shell fetches it
 * when online and shows a sample stand-in until then. This carries only the setup person's CURRENT context — who
 * is looking and what they hold now — re-read every render; the cloud routes re-check the authority and the §28
 * maker/approver split, so this only shapes the UI.
 */
export function documentTemplatesPayload(input: ScreenInput): Record<string, unknown> | null {
  if (!input.pack.documentTemplatePolicy.known) return null;
  const policy: PackDocumentTemplatePolicy = input.pack.documentTemplatePolicy.value;

  const payload: Record<string, unknown> = { permissions: policy.permissions };
  if (policy.userId !== undefined) payload['userId'] = policy.userId;

  return payload;
}

/**
 * The RECEIPT template the till prints with (M01-FR-02 · §31), or undefined when none has reached this box.
 *
 * Rides beside the till's catalogue as its own global (`window.posReceiptTemplate`): the header and footer head
 * office published, the version they were published as (stamped on every bill so a reprint is rendered as the
 * original), the paper it was written for, and how old the set is by the CLOUD's clock. Absent when the box has
 * only ever read its pack file, or the cloud has nothing published for receipts — the till then prints with its
 * defaults and stamps no version, rather than inventing one (P-08).
 */
/**
 * Who this till IS, for the served POS shell (SP-4b · F09): the lane the box was told it is (`EDGE_LANE_ID`) and the
 * shop's trading-day cut-off, so the till dates each sale at the moment it is taken — never a placeholder lane or a
 * 1970 day. The CASHIER is deliberately absent: the person at the till signs in with their staff code, and a name
 * carried in a pack for whoever happens to be at the till would be a shared identity (hard rule #4). Absent lane and
 * unknown cut-off are SAID (`null` / `tradingDayCutoffKnown: false`), never defaulted silently.
 */
export function posLanePayload(input: ScreenInput, laneId: string | undefined): Record<string, unknown> {
  const policies = input.pack.policies.known ? input.pack.policies.value : undefined;
  return {
    laneId: laneId ?? null,
    tradingDayCutoff: policies?.tradingDayCutoff ?? '00:00',
    tradingDayCutoffKnown: policies !== undefined,
    tradingDay: input.tradingDay,
    storeId: policies?.storeId ?? null,
  };
}

/**
 * The refund policy the till is GIVEN (SP-9b-i · M13-FR-01 · M13-FR-03 · §28): the approval threshold and the
 * no-receipt cap, exactly as the box's store pack carries them in `servicePolicy` — the same numbers the service desk
 * screen is given. Never invented: `undefined` when the box holds no service policy, and the till then offers NO
 * return without a receipt (fail safe — the cap is a control, and a till without it must not guess one). The till
 * reads only these two; the desk's own limits (agent authority, compensation cap, return window) stay with the desk.
 */
export function posRefundPolicyPayload(input: ScreenInput): Record<string, unknown> | undefined {
  if (!input.pack.servicePolicy.known) return undefined;
  const policy = input.pack.servicePolicy.value;
  return { approvalThresholdMinor: policy.approvalThresholdMinor, noReceiptCapMinor: policy.noReceiptCapMinor };
}

export function posReceiptTemplate(input: ScreenInput): Record<string, unknown> | undefined {
  if (!input.pack.documentTemplates.known) return undefined;
  const held = input.pack.documentTemplates.value;
  const receipt = held.templates.find((t) => t.kind === 'receipt');
  if (receipt === undefined) return undefined;
  return {
    version: receipt.version,
    header: receipt.content.header,
    footer: receipt.content.footer,
    language: receipt.content.language,
    ...(receipt.content.paperFormat === undefined ? {} : { paperFormat: receipt.content.paperFormat }),
    publishedAt: receipt.publishedAt,
    generatedAt: held.generatedAt,
    receivedAt: held.receivedAt,
    ageHours: Math.max(0, Math.floor((Date.parse(input.now) - Date.parse(held.generatedAt)) / 3_600_000)),
  };
}

/**
 * The refund-exceptions review payload (M13-FR-01/03 · M17 · P-03 · P-08).
 *
 * `null` when the box has not been told who is on the screen. **The flagged refunds themselves are NOT in this
 * payload**: they are read live from the cloud (`GET /v1/pos/return-governance-exceptions`); the shell fetches
 * it when online and shows a sample stand-in until then. This carries only the reviewer's CURRENT context — who
 * is looking + what they hold now (`lp.case.read`), re-read every render. The cloud route re-checks the
 * authority, so this only shapes the UI. Read-only screen — there is no write to shape.
 */
export function returnGovernancePayload(input: ScreenInput): Record<string, unknown> | null {
  if (!input.pack.returnGovernancePolicy.known) return null;
  const policy: PackReturnGovernancePolicy = input.pack.returnGovernancePolicy.value;

  const payload: Record<string, unknown> = { permissions: policy.permissions };
  if (policy.userId !== undefined) payload['userId'] = policy.userId;

  return payload;
}

/**
 * The cash-office over/short sign-off payload (M14-FR-02 · P-03 · §28).
 *
 * `null` when the box has not been told who is on the screen. **The open over/shorts themselves are NOT in this
 * payload**: they are read live from the cloud (`GET /v1/shifts/over-short`); the shell fetches it when online
 * and shows a sample stand-in until then. This carries only the reviewer's CURRENT context — who is looking +
 * what they hold now (`till.shift.read`, `till.overshort.review`), re-read every render. The cloud route
 * re-checks the authority and enforces §28 (reviewer ≠ cashier), so this only shapes the UI.
 */
export function cashOfficePayload(input: ScreenInput): Record<string, unknown> | null {
  if (!input.pack.cashOfficePolicy.known) return null;
  const policy: PackCashOfficePolicy = input.pack.cashOfficePolicy.value;

  const payload: Record<string, unknown> = { permissions: policy.permissions };
  if (policy.userId !== undefined) payload['userId'] = policy.userId;

  return payload;
}

/**
 * The risk-acceptance / compliance-gates payload (M34-FR-04 · P-03 · §28).
 *
 * `null` when the box has not been told who is on the screen. **The blocked gates themselves are NOT in this
 * payload**: they are read live from the cloud (`GET /v1/compliance/gates/blocked`); the shell fetches it when
 * online and shows a sample stand-in until then. This carries only the accepter's CURRENT context — who is
 * looking + what they hold now (`compliance.risk.read`, `compliance.risk.manage`), re-read every render. The
 * cloud route re-checks the authority and records an acceptance in the accepter's own name, so this only shapes
 * the UI.
 */
export function riskAcceptancePayload(input: ScreenInput): Record<string, unknown> | null {
  if (!input.pack.riskAcceptancePolicy.known) return null;
  const policy: PackRiskAcceptancePolicy = input.pack.riskAcceptancePolicy.value;

  const payload: Record<string, unknown> = { permissions: policy.permissions };
  if (policy.userId !== undefined) payload['userId'] = policy.userId;

  return payload;
}

/**
 * The day-reopen payload (M14-FR-04 · §28).
 *
 * `null` when the box has not been told who is on the screen. **The locked days themselves are NOT in this
 * payload**: they are read live from the cloud (`GET /v1/pos/day-close`); the shell fetches it when online and
 * shows a sample stand-in until then. This carries only the reopener's CURRENT context — who is looking + what
 * they hold now (`till.dayclose.read`, `till.dayclose.approve`), re-read every render. The reopener's own id
 * also lets the screen enforce §28 locally (the named approver must be a DIFFERENT person) before any POST. The
 * reopen itself posts to the BOX (`POST /lane/day-reopen`), which is the only place that can perform it.
 */
export function dayReopenPayload(input: ScreenInput): Record<string, unknown> | null {
  if (!input.pack.dayReopenPolicy.known) return null;
  const policy: PackDayReopenPolicy = input.pack.dayReopenPolicy.value;

  const payload: Record<string, unknown> = { permissions: policy.permissions };
  if (policy.userId !== undefined) payload['userId'] = policy.userId;

  return payload;
}

/**
 * The READ-ONLY stock-health dashboard payload (M08 · P-03 · P-08). Carries ONLY who is looking and whether they
 * may read stock health — the figures themselves are read live from the cloud by the screen (`GET
 * /v1/inventory/…`), never shipped in the pack. Absent policy → no payload, and the shell shows its sample.
 */
export function stockHealthPayload(input: ScreenInput): Record<string, unknown> | null {
  if (!input.pack.stockHealthPolicy.known) return null;
  const policy: PackStockHealthPolicy = input.pack.stockHealthPolicy.value;

  const payload: Record<string, unknown> = { permissions: policy.permissions };
  if (policy.userId !== undefined) payload['userId'] = policy.userId;

  return payload;
}

/**
 * The stored-value oversight payload (M17-FR-03/04 · P-03 · P-04). Who is looking and what they hold, so the
 * shell can gate on `lp.case.read` before the live reads; the double-spend / liability / velocity figures are
 * read live from the cloud (GETs), never shipped in the pack. Read-only — nothing here is written.
 */
export function storedValuePayload(input: ScreenInput): Record<string, unknown> | null {
  if (!input.pack.storedValuePolicy.known) return null;
  const policy: PackStoredValuePolicy = input.pack.storedValuePolicy.value;

  const payload: Record<string, unknown> = { permissions: policy.permissions };
  if (policy.userId !== undefined) payload['userId'] = policy.userId;

  return payload;
}

/**
 * The integration-health payload (M32-FR-04 · P-03 · P-08). Who is looking and what they hold, so the shell can
 * gate on `platform.health.read` before the live read; the adapter health picture itself is read live from the
 * cloud (a GET), never shipped in the pack. Read-only — nothing here is written.
 */
export function integrationHealthPayload(input: ScreenInput): Record<string, unknown> | null {
  if (!input.pack.integrationHealthPolicy.known) return null;
  const policy: PackIntegrationHealthPolicy = input.pack.integrationHealthPolicy.value;

  const payload: Record<string, unknown> = { permissions: policy.permissions };
  if (policy.userId !== undefined) payload['userId'] = policy.userId;

  return payload;
}

/**
 * The goods-receipt review payload (M07-FR-02/03 · P-03). Who is looking and what they hold, so the shell can
 * gate on `inventory.availability.read` before the live read; the GRN list itself is read live from the cloud,
 * never shipped in the pack.
 */
export function goodsReceiptPayload(input: ScreenInput): Record<string, unknown> | null {
  if (!input.pack.goodsReceiptPolicy.known) return null;
  const policy: PackGoodsReceiptPolicy = input.pack.goodsReceiptPolicy.value;

  const payload: Record<string, unknown> = { permissions: policy.permissions };
  if (policy.userId !== undefined) payload['userId'] = policy.userId;

  return payload;
}

/**
 * The suppliers payload (M06-FR-01 · M23-FR-01 · §28 · P-03). Who is looking and what they hold, so the shell can gate
 * the read on `supplier.view` and offer PROPOSE (`purchase.supplier.manage`) and APPROVE (`purchase.supplier.approve`)
 * only to the people who hold them; the supplier list itself is read live from the cloud, never shipped in the pack,
 * and the cloud re-checks every authority and the maker≠approver rule on each write.
 */
export function suppliersPayload(input: ScreenInput): Record<string, unknown> | null {
  if (!input.pack.suppliersPolicy.known) return null;
  const policy: PackSuppliersPolicy = input.pack.suppliersPolicy.value;

  const payload: Record<string, unknown> = { permissions: policy.permissions };
  if (policy.userId !== undefined) payload['userId'] = policy.userId;

  return payload;
}

/**
 * The floor indents payload (SP-8b · F08 · M09-FR-03 · §28). Who is looking and what they hold — `inventory.indent.read` to
 * see the register, `inventory.indent.request` to raise, `inventory.indent.approve` to approve, `inventory.movement.append`
 * to count an issue in — plus the two places the ask runs between (the floor = the store's location, the back store = the
 * pack's warehouse) and the products the floor may ask for (the box's own catalogue, so an ask names a product head office
 * knows). The register itself is read live from the cloud, never shipped in the pack; the cloud re-checks every authority.
 */
export function indentsPayload(input: ScreenInput): Record<string, unknown> | null {
  if (!input.pack.indentsPolicy.known) return null;
  const policy: PackIndentsPolicy = input.pack.indentsPolicy.value;

  const payload: Record<string, unknown> = { permissions: policy.permissions };
  if (policy.userId !== undefined) payload['userId'] = policy.userId;
  if (input.pack.policies.known) {
    payload['storeId'] = input.pack.policies.value.storeId;
    payload['backStoreId'] = input.pack.policies.value.warehouseId;
  }
  if (input.pack.products.known) {
    payload['products'] = input.pack.products.value.map((p) => ({ productId: p.productId, name: p.name, ...(p.nameTa === undefined ? {} : { nameTa: p.nameTa }), uom: p.uom }));
  }
  // SP-8c: the register as the box last pulled it — the screen opens on it with the cable out and re-reads head office when it can.
  if (input.pack.floorIndents.known) {
    const feed = input.pack.floorIndents.value;
    // Only rows head office sent WITH their totals are shown — a row without them would be a blank the screen cannot explain.
    payload['snapshot'] = { asAt: feed.asAt, indents: feed.indents.filter((i) => i.totals?.lines !== undefined).map((i) => ({ ...i, lines: i.totals!.lines })) };
  }

  return payload;
}

/**
 * The data import/export console payload (M30-FR-01/02/03 · P-06).
 *
 * `null` when the box has not been told who is on the screen. The exportable domains and the export log are read
 * live from the cloud (`GET /v1/export`, `GET /v1/exports`); the import templates are the store's configured
 * loads, shipped here (there is no proprietary "list templates" route). Carries who is looking + what they hold
 * now, re-read every render; the cloud routes re-check the authority, so this only shapes the UI.
 */
export function dataIoPayload(input: ScreenInput): Record<string, unknown> | null {
  if (!input.pack.dataIoPolicy.known) return null;
  const policy: PackDataIoPolicy = input.pack.dataIoPolicy.value;

  const payload: Record<string, unknown> = { permissions: policy.permissions, importTemplates: policy.importTemplates };
  if (policy.userId !== undefined) payload['userId'] = policy.userId;

  return payload;
}

/**
 * The Workforce guidance inbox payload (A10 · API-13 · §7.1 · M25-FR-02 · P-05).
 *
 * `null` when the box has not been told who is on the screen. **The guidance itself is NOT in this payload**:
 * it is read live from the cloud (`GET /v1/ai/workforce/worklist`, which re-derives it from the live daily
 * tasks and honours the kill switch server-side); the shell fetches it when online and shows a sample stand-in
 * until then. This carries only the manager's CURRENT context — who is looking and what they hold now —
 * re-read every render; the cloud route re-checks the authority, so this only shapes the UI.
 */
export function workforcePayload(input: ScreenInput): Record<string, unknown> | null {
  if (!input.pack.workforceInboxPolicy.known) return null;
  const policy: PackWorkforceInboxPolicy = input.pack.workforceInboxPolicy.value;

  const payload: Record<string, unknown> = { permissions: policy.permissions };
  if (policy.userId !== undefined) payload['userId'] = policy.userId;

  return payload;
}

/** Employee self-service (ESS) — only who is looking and what they hold; the rota and payslip come live from
 *  the cloud (self-scoped), not the pack. Null when the box was not told who is on the screen. */
export function essPayload(input: ScreenInput): Record<string, unknown> | null {
  if (!input.pack.essPolicy.known) return null;
  const policy: PackEssPolicy = input.pack.essPolicy.value;

  const payload: Record<string, unknown> = { permissions: policy.permissions };
  if (policy.userId !== undefined) payload['userId'] = policy.userId;

  return payload;
}

/** Manager rostering (M25-FR-01) — only who is looking and what they hold; the roster gaps and the staff who
 *  can fill them come live from the cloud (`GET /v1/hr/workforce/roster` + `/roster-gaps`), not the pack. Null
 *  when the box was not told who is on the screen. The cloud routes re-check both permissions, so this only
 *  shapes the UI (P-04). */
export function rosteringPayload(input: ScreenInput): Record<string, unknown> | null {
  if (!input.pack.rosteringPolicy.known) return null;
  const policy: PackRosteringPolicy = input.pack.rosteringPolicy.value;

  const payload: Record<string, unknown> = { permissions: policy.permissions };
  if (policy.userId !== undefined) payload['userId'] = policy.userId;

  return payload;
}

/** Manager checklist (M25-FR-02) — only who is looking and what they hold; the day's checklists come live from
 *  the cloud (`GET /v1/hr/workforce/checklists`), not the pack. Null when the box was not told who is on the
 *  screen. The cloud routes re-check both permissions, so this only shapes the UI (P-04). */
export function checklistPayload(input: ScreenInput): Record<string, unknown> | null {
  if (!input.pack.checklistPolicy.known) return null;
  const policy: PackChecklistPolicy = input.pack.checklistPolicy.value;

  const payload: Record<string, unknown> = { permissions: policy.permissions };
  if (policy.userId !== undefined) payload['userId'] = policy.userId;

  return payload;
}

/** Production quality-release (M11-FR-03) — only who is looking and what they hold; the production runs (finished
 *  batches in quarantine) come live from the cloud (`GET /v1/production/runs`), not the pack. Null when the box
 *  was not told who is on the screen. The cloud routes re-check both permissions, so this only shapes the UI. */
export function productionPayload(input: ScreenInput): Record<string, unknown> | null {
  if (!input.pack.productionPolicy.known) return null;
  const policy: PackProductionPolicy = input.pack.productionPolicy.value;

  const payload: Record<string, unknown> = { permissions: policy.permissions };
  if (policy.userId !== undefined) payload['userId'] = policy.userId;

  return payload;
}

/** Facilities maintenance & compliance (M26-FR-03) — only who is looking and what they hold; the overdue tasks
 *  (cleaning, pest, fire/electrical safety, statutory checks) come live from the cloud
 *  (`GET /v1/facilities/overdue`), not the pack. Null when the box was not told who is on the screen. The cloud
 *  routes re-check both permissions, so this only shapes the UI. */
export function facilitiesPayload(input: ScreenInput): Record<string, unknown> | null {
  if (!input.pack.facilitiesPolicy.known) return null;
  const policy: PackFacilitiesPolicy = input.pack.facilitiesPolicy.value;

  const payload: Record<string, unknown> = { permissions: policy.permissions };
  if (policy.userId !== undefined) payload['userId'] = policy.userId;

  return payload;
}

/**
 * The admin and security payload (M01 · M02 · M33 · M34 · D12).
 *
 * `null` when the box has not been told who administers this shop and by what windows — a screen
 * inventing its own dormancy window would be deciding, on its own authority, when a colleague's
 * account is stale enough to take away.
 *
 * **`versionPolicy` and `retentionPolicies` are served only when the box has them.** Absent means
 * nothing is being enforced and nothing has been decided, which is different from a fleet that
 * complies and a shelf of records with nothing due for deletion — and only one of each pair is
 * good news.
 */
export function adminPayload(input: ScreenInput): Record<string, unknown> | null {
  if (!input.pack.adminPolicy.known) return null;
  const policy = input.pack.adminPolicy.value;
  const policies = input.pack.policies.known ? input.pack.policies.value : undefined;

  const payload: Record<string, unknown> = {
    storeId: policies?.storeId ?? 'store-1',
    now: input.now,
    dormantAfterDays: policy.dormantAfterDays,
  };
  if (policy.userId !== undefined) payload['userId'] = policy.userId;
  // Never defaulted: a screen inventing what this person holds would offer decisions head office then refuses.
  if (policy.permissions !== undefined) payload['permissions'] = policy.permissions;

  if (input.pack.accounts.known) payload['accounts'] = input.pack.accounts.value;
  if (input.pack.roles.known) payload['roles'] = input.pack.roles.value;
  if (input.pack.roleAssignments.known) payload['assignments'] = input.pack.roleAssignments.value;
  if (input.pack.supportSessions.known) payload['supportSessions'] = input.pack.supportSessions.value;
  if (input.pack.devices.known) payload['devices'] = input.pack.devices.value;
  if (input.pack.versionPolicy.known) payload['versionPolicy'] = input.pack.versionPolicy.value;
  if (input.pack.auditRecords.known) payload['auditRecords'] = input.pack.auditRecords.value;
  if (input.pack.retentionPolicies.known) payload['retentionPolicies'] = input.pack.retentionPolicies.value;
  if (input.pack.legalHolds.known) payload['legalHolds'] = input.pack.legalHolds.value;

  return payload;
}

/**
 * The AI control payload (M32 · M36 · A01–A10 · P-05 · hard rule #5).
 *
 * `null` when the box has not been told who is on this screen and how long a draft stays fit to
 * accept — a screen inventing its own staleness window would be deciding, on its own authority,
 * when yesterday's reasoning is still good enough to act on.
 *
 * **`killSwitches` is served only when the box has it.** A substituted empty list is the exact
 * fault this screen exists to make impossible: ten assistants drawn as running while one of them
 * is stopped. **`platformCeilingMinor` likewise** — absent means the owner has never agreed a
 * ceiling (D3), and no summary at all is the honest answer.
 */
export function aiPayload(input: ScreenInput): Record<string, unknown> | null {
  if (!input.pack.aiPolicy.known) return null;
  const policy = input.pack.aiPolicy.value;
  const policies = input.pack.policies.known ? input.pack.policies.value : undefined;

  const payload: Record<string, unknown> = {
    storeId: policies?.storeId ?? 'store-1',
    now: input.now,
    period: policy.period,
    staleAfterMinutes: policy.staleAfterMinutes,
  };
  if (policy.userId !== undefined) payload['userId'] = policy.userId;
  if (policy.platformCeilingMinor !== undefined) {
    payload['platformCeilingMinor'] = policy.platformCeilingMinor;
  }

  if (input.pack.killSwitches.known) payload['killSwitches'] = input.pack.killSwitches.value;
  if (input.pack.agentBudgets.known) payload['agentBudgets'] = input.pack.agentBudgets.value;
  if (input.pack.aiUsage.known) payload['usage'] = input.pack.aiUsage.value;
  if (input.pack.aiPending.known) payload['pending'] = input.pack.aiPending.value;
  if (input.pack.aiEvaluations.known) payload['evaluations'] = input.pack.aiEvaluations.value;

  return payload;
}

/**
 * The migration payload (MG-01…MG-12 · §34 · QG-07 · P-01).
 *
 * `null` when the box has not been told which cutover this is or how many consecutive clean days
 * this shop requires — a screen inventing its own clean-day threshold would be deciding, on its
 * own authority, how much evidence is enough before a hypermarket changes systems.
 *
 * **Every other section is served only when the box has it, and every absence fails a check.**
 * That is the whole point of this screen: the eight-check gate has always been handed booleans
 * somebody typed, and the one substitution that would undo the fix is a `?? []` here — an empty
 * exception list reads as clean data, and an empty totals list reads as a reconciliation with
 * nothing wrong.
 *
 * **`edgeUnsyncedItems` comes from this box's own outbox**, which is the only honest source for
 * it. An unsynced till is an unmigrated sale, and it is not found until a customer asks for the
 * receipt.
 */
export function migrationPayload(input: ScreenInput): Record<string, unknown> | null {
  if (!input.pack.migrationPolicy.known) return null;
  const policy = input.pack.migrationPolicy.value;
  const policies = input.pack.policies.known ? input.pack.policies.value : undefined;

  const payload: Record<string, unknown> = {
    storeId: policies?.storeId ?? 'store-1',
    now: input.now,
    cutoverId: policy.cutoverId,
    requiredCleanDays: policy.requiredCleanDays,
    cutoverAccepted: policy.cutoverAccepted === true,
    // This box's own queue. Never a figure the cloud asserts about the box.
    edgeUnsyncedItems: input.outbox.pending().length,
  };
  if (policy.userId !== undefined) payload['userId'] = policy.userId;
  if (policy.loadOperator !== undefined) payload['loadOperator'] = policy.loadOperator;
  if (policy.deltaAppliedAt !== undefined) payload['deltaAppliedAt'] = policy.deltaAppliedAt;
  if (policy.rollbackDemonstratedAt !== undefined) {
    payload['rollbackDemonstratedAt'] = policy.rollbackDemonstratedAt;
  }
  if (policy.namedTeam !== undefined) payload['namedTeam'] = policy.namedTeam;
  if (policy.ownerGoBy !== undefined) payload['ownerGoBy'] = policy.ownerGoBy;
  if (policy.openAssessments !== undefined) payload['openAssessments'] = policy.openAssessments;

  if (input.pack.migrationSources.known) payload['sources'] = input.pack.migrationSources.value;
  if (input.pack.migrationExceptions.known) payload['exceptions'] = input.pack.migrationExceptions.value;
  if (input.pack.migrationTotals.known) payload['totals'] = input.pack.migrationTotals.value;
  if (input.pack.parallelDays.known) payload['parallelDays'] = input.pack.parallelDays.value;
  if (input.pack.parallelDifferences.known) payload['parallelDifferences'] = input.pack.parallelDifferences.value;
  if (input.pack.historyExclusions.known) payload['exclusions'] = input.pack.historyExclusions.value;
  if (input.pack.legacyArchive.known) payload['archive'] = input.pack.legacyArchive.value;

  // The cloud's register, when this box has pulled it (C3b): how old it is — from the CLOUD's clock, never
  // this box's boot — plus the two registers with no section of their own. Absent when the box has only ever
  // read its pack file, and the screen must say so rather than imply it is looking at the register (P-08).
  if (input.pack.migrationFeed.known) {
    const feed = input.pack.migrationFeed.value;
    payload['cloudRegister'] = {
      generatedAt: feed.generatedAt,
      receivedAt: feed.receivedAt,
      ageHours: Math.max(0, Math.floor((Date.parse(input.now) - Date.parse(feed.generatedAt)) / 3_600_000)),
    };
    if (feed.refusedDecisions !== undefined) payload['refusedDecisions'] = feed.refusedDecisions;
    if (feed.verification !== undefined) payload['verification'] = feed.verification;
  }

  return payload;
}

/**
 * The Approvals page payload (ADR-0024 · M02-FR-03 · §28): only WHO is looking. The inbox — what waits for this person
 * and what they asked for — is head office's, read live (`GET /v1/approvals/requests`), never a copy on this box; head
 * office decides what waits for whom by each kind's own permission. The page has no named viewer of its own in the
 * pack: behind the authenticated relay the person who signed in becomes the viewer (their id, their permissions from
 * this box's role register); on a box with nobody signed in it says nobody is named and decides nothing.
 */
export function approvalsPayload(): Record<string, unknown> | null {
  return { permissions: [] };
}

/** The global each screen's bundle reads at boot. One name per screen, and they must not drift. */
export const GLOBAL_FOR: Readonly<Record<ScreenName, string>> = Object.freeze({
  pos: 'posCatalogue',
  manager: 'managerData',
  owner: 'ownerData',
  picker: 'pickerData',
  driver: 'driverData',
  customer: 'shopData',
  buying: 'buyingData',
  catalogue: 'catalogueData',
  merchandising: 'merchandisingData',
  reporting: 'reportingData',
  service: 'serviceData',
  expiry: 'expiryData',
  finance: 'financeData',
  'gst-reconciliation': 'gstReconciliationData',
  'category-policy': 'categoryPolicyData',
  'gst-returns': 'gstReturnsData',
  waste: 'wasteData',
  'write-off-capture': 'writeOffCaptureData',
  counts: 'countsData',
  fleet: 'fleetData',
  'product-publish-review': 'productPublishReviewData',
  'data-quality': 'dataQualityInboxData',
  operations: 'operationsInboxData',
  'loss-prevention': 'lossPreventionInboxData',
  'substitution-exceptions': 'substitutionExceptionInboxData',
  'day-book': 'dayBookData',
  'document-templates': 'documentTemplatesData',
  'return-governance': 'returnGovernanceData',
  'cash-office': 'cashOfficeData',
  'risk-acceptance': 'riskAcceptanceData',
  'day-reopen': 'dayReopenData',
  'stock-health': 'stockHealthData',
  'stored-value': 'storedValueData',
  'integration-health': 'integrationHealthData',
  'goods-receipt': 'goodsReceiptData',
  suppliers: 'suppliersData',
  indents: 'indentsData',
  unsellable: 'unsellableData',
  'data-io': 'dataIoData',
  workforce: 'workforceInboxData',
  ess: 'essData',
  rostering: 'rosteringData',
  checklist: 'checklistData',
  production: 'productionData',
  facilities: 'facilitiesData',
  admin: 'adminData',
  ai: 'aiData',
  migration: 'migrationData',
  warehouse: 'warehouseData',
  'warehouse-supervisor': 'warehouseSupervisorData',
  approvals: 'approvalsData',
});

const BUILDERS: Readonly<Record<ScreenName, (input: ScreenInput) => Record<string, unknown> | null>> = Object.freeze({
  pos: posPayload,
  manager: managerPayload,
  owner: ownerPayload,
  picker: pickerPayload,
  driver: driverPayload,
  customer: customerPayload,
  buying: buyingPayload,
  catalogue: cataloguePayload,
  merchandising: merchandisingPayload,
  reporting: reportingPayload,
  service: servicePayload,
  expiry: expiryPayload,
  finance: financePayload,
  'gst-reconciliation': gstReconciliationPayload,
  'category-policy': categoryPolicyPayload,
  'gst-returns': gstReturnsPayload,
  waste: wastePayload,
  'write-off-capture': writeOffCapturePayload,
  counts: countsPayload,
  fleet: fleetPayload,
  'product-publish-review': productPublishReviewPayload,
  'data-quality': dataQualityPayload,
  operations: operationsPayload,
  'loss-prevention': lossPreventionPayload,
  'substitution-exceptions': substitutionExceptionsPayload,
  'day-book': dayBookPayload,
  'document-templates': documentTemplatesPayload,
  'return-governance': returnGovernancePayload,
  'cash-office': cashOfficePayload,
  'risk-acceptance': riskAcceptancePayload,
  'day-reopen': dayReopenPayload,
  'stock-health': stockHealthPayload,
  'stored-value': storedValuePayload,
  'integration-health': integrationHealthPayload,
  'goods-receipt': goodsReceiptPayload,
  suppliers: suppliersPayload,
  indents: indentsPayload,
  unsellable: unsellablePayload,
  'data-io': dataIoPayload,
  workforce: workforcePayload,
  ess: essPayload,
  rostering: rosteringPayload,
  checklist: checklistPayload,
  production: productionPayload,
  facilities: facilitiesPayload,
  admin: adminPayload,
  ai: aiPayload,
  migration: migrationPayload,
  warehouse: warehousePayload,
  'warehouse-supervisor': warehouseSupervisorPayload,
  approvals: approvalsPayload,
});

/** Build one screen's payload. `null` means this box has nothing to give it, and says so. */
export function payloadFor(screen: ScreenName, input: ScreenInput, personId?: string): Record<string, unknown> | null {
  // DF-3-c: the picker's and driver's work is chosen for the person signed in on the phone, when the box knows who that is.
  if (personId !== undefined && screen === 'picker') return pickerPayload(input, personId);
  if (personId !== undefined && screen === 'driver') return driverPayload(input, personId);
  return BUILDERS[screen](input);
}
