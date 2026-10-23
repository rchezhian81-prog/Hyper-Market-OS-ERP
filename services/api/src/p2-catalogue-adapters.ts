// OB-288 package P2 — catalogue, pricing and product legal guards. Head office's wiring for M03-FR-01 (variants and the
// manufacturer roll-up), M03-FR-02 (own-barcode bundles, OB-306), M03-FR-03 (a GST rate change approved by Finance),
// M03-FR-04 (the approved substitute list), M04-FR-04 (the floor plan and its heat map, OB-308), M05-FR-03 (the new offer
// kinds and the B15 tobacco guard), M05-FR-04 (promotion funding and effectiveness folded from banked bills), D02-FR-02
// (clusters from the price-zone register and season plans, OB-318) and D02-FR-04 (range gaps, OB-319).
//
// Every register here is append-only on its own stream (hard rules #2, #6); reads fold the streams. Nothing here commits
// a price, a payment or stock by itself: each write is a person's act through a route (P-05). One entry point,
// `p2CatalogueRoutes`, is registered from main.ts; the hooks below are spread into the existing routes' deps there.

import type { EventStore } from '../../../packages/persistence/src/event-store';
import { InMemoryEventStore } from '../../../packages/persistence/src/event-store';
import type { Route } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { makeEvent } from '../../../packages/contracts/src/event';
import { money } from '../../../packages/contracts/src/money';
import { valueAtCost, normaliseUom } from '../../../packages/contracts/src/quantity';
import {
  STREAM, streamName, productMasterAdapter, categoryRegisterAdapter, planogramStoreAdapter, assortmentAdapter, averageBuyingCosts,
  registeredStores, orgStructureAdapter, financeAdapter, approvalRequestsAdapter, taxClassAdapter,
} from './adapters';
import { resolveGstRate } from '../../../packages/finance/src/rate';
import { channelPricingAdapter } from './r3-ops-adapters';
import { eprAdapter } from './r4-pay-epr-adapters';
import { branchOfLocationIn } from '../../inventory/src/location-scope';
import type { SignedPack } from '../../catalogue/src/pack';
import type { BundleDefinition, SubstituteList, ProductRecord } from '../../../packages/product/src/index';
import type { FloorPlan, ProductTakings, SeasonPlan, GapFact, SearchMiss, SoldProduct } from '../../../packages/merchandising/src/index';
import { bestPrice, promotionLines, type Promotion, type BasketLine } from '../../../packages/promotions/src/promotions';
import { bundleRoutes } from '../../catalogue/src/bundles';
import { substituteRoutes } from '../../catalogue/src/substitutes';
import { variantReportRoutes } from '../../catalogue/src/variant-report';
import { searchMissRoutes, type SearchMissRecord } from '../../catalogue/src/search-misses';
import { floorPlanRoutes } from '../../inventory/src/floor-plan';
import { seasonPlanRoutes, endDueSeasons, type SeasonEnd, type SeasonPlanDeps } from '../../inventory/src/season-plans';
import { rangeGapRoutes } from '../../inventory/src/range-gaps';
import { vendorFundingRoutes, type FundingAgreement, type PromotionFundingJournal, type UnitsUnderOffer } from '../../finance/src/vendor-funding';
import { promotionResultRoutes, type WindowTakings } from '../../pricing/src/promotion-results';
import type { StoredPostingMap } from '../../finance/src/day-book';
import type { WaveLineOutcome } from '../../fulfilment/src/waves';
import type { StoredSubstitution } from '../../orders/src/index';

type Recorder = (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
interface Base { readonly store: EventStore; readonly now: () => string; readonly recordAudit?: Recorder }

const BUNDLES = streamName(STREAM.catalogue, 'bundles');
const SUBSTITUTES = (productId: string): string => streamName(STREAM.catalogue, 'substitutes', productId);
const SEARCH_MISSES = streamName(STREAM.catalogue, 'search-misses');
const FLOOR_PLANS = (storeId: string): string => streamName(STREAM.inventory, 'floor-plans', storeId);
const SEASON_PLANS = streamName(STREAM.inventory, 'season-plans');
const FUNDING = streamName(STREAM.promotions, 'funding');

/** Every payload of one type in a stream, oldest first. */
async function payloads<T>(store: EventStore, tenantId: string, stream: string, type: string, window?: { from: string; to: string }): Promise<readonly T[]> {
  return (await store.readStream(tenantId, stream, { type, ...(window === undefined ? {} : { from: window.from, to: window.to }) })).map((e) => e.event.payload as T);
}

async function append(store: EventStore, tenantId: string, stream: string, type: string, key: string, at: string, payload: unknown): Promise<void> {
  await store.append(tenantId, stream, makeEvent({
    id: `${type}-${key}`, type, occurredAt: at, idempotencyKey: `p2-${type}-${tenantId}-${key}`, source: 'api/catalogue', payload: payload as Record<string, unknown>,
  }));
}

// ── the facts every fold reads: banked bills, their stores, tax, cost ───────────────────────────────────────────────

interface BankedLine { readonly productId: string; readonly quantityMinor: number; readonly uom: string; readonly unitPriceMinor: number; readonly lineTotalMinor: number; readonly discountMinor?: number }
interface BankedSale { readonly saleId: string; readonly committedAt: string; readonly locationId?: string; readonly customerRef?: string; readonly lines: readonly BankedLine[] }

async function latestPack(store: EventStore, tenantId: string): Promise<SignedPack | undefined> {
  return (await store.latestOfType(tenantId, STREAM.catalogue, 'CataloguePublished'))?.event.payload as SignedPack | undefined;
}

/** The banked bills in [fromIso, toIso), each with the store it was sold at (undefined when it cannot be placed). */
async function bankedSales(input: Base, tenantId: string, fromIso: string, toIso: string): Promise<readonly (BankedSale & { readonly storeId: string | undefined })[]> {
  const sales = await payloads<BankedSale>(input.store, tenantId, STREAM.sales, 'SaleCommitted', { from: fromIso, to: toIso });
  const branchOf = branchOfLocationIn(await orgStructureAdapter(input).nodes(tenantId));
  const packStore = (await latestPack(input.store, tenantId))?.snapshot.scope?.storeId;
  return sales.map((s) => ({ ...s, storeId: s.locationId !== undefined && s.locationId !== '' ? branchOf(s.locationId) : packStore }));
}

/** One bill line's whole units: an each line counts its pieces; a weighed line counts as one. */
const isEach = (uom: string): boolean => (normaliseUom(uom) ?? uom) === 'ea';
const unitsOf = (l: BankedLine): number => (isEach(l.uom) ? l.quantityMinor : 1);
const deGross = (grossMinor: number, taxBps: number): number => Number((BigInt(grossMinor) * 10_000n) / BigInt(10_000 + taxBps));

interface Taken { units: number; salesMinor: number; netSalesMinor: number; costMinor: number; costKnown: boolean; bills: Set<string> }

/** What each product took in the window (optionally at one store / among some products): as charged, ex-tax, at cost. */
async function takingsByProduct(input: Base, tenantId: string, fromIso: string, toIso: string, opts: { readonly storeId?: string; readonly productIds?: readonly string[] } = {}): Promise<Map<string, Taken>> {
  const [sales, pack, costs] = await Promise.all([bankedSales(input, tenantId, fromIso, toIso), latestPack(input.store, tenantId), averageBuyingCosts(input, tenantId)]);
  const packTax = new Map((pack?.snapshot.products ?? []).map((p) => [p.productId, p.taxBps] as const));
  // A product not in the latest pack is de-taxed at its HSN's rate in force on the bill's day (the effective-dated schedule);
  // a class with no rate on that day leaves the line's net — and so its margin — not known, never guessed.
  const hsnOf = new Map((await productMasterAdapter(input).products(tenantId)).map((p) => [p.productId, p.taxClass] as const));
  const schedules = new Map<string, Awaited<ReturnType<ReturnType<typeof taxClassAdapter>['schedule']>>>();
  const taxOn = async (productId: string, day: string): Promise<number | undefined> => {
    const fromPack = packTax.get(productId);
    if (fromPack !== undefined) return fromPack;
    const hsn = hsnOf.get(productId);
    if (hsn === undefined || hsn === null || hsn === '') return undefined;
    if (!schedules.has(hsn)) schedules.set(hsn, await taxClassAdapter(input).schedule(tenantId, hsn));
    try { return resolveGstRate({ schedule: schedules.get(hsn)!, supplyDate: day }).rateBps; } catch { return undefined; }
  };
  const only = opts.productIds === undefined ? undefined : new Set(opts.productIds);
  const out = new Map<string, Taken>();
  for (const s of sales) {
    if (opts.storeId !== undefined && s.storeId !== opts.storeId) continue;
    for (const l of s.lines ?? []) {
      if (only !== undefined && !only.has(l.productId)) continue;
      const t = out.get(l.productId) ?? { units: 0, salesMinor: 0, netSalesMinor: 0, costMinor: 0, costKnown: true, bills: new Set<string>() };
      t.units += unitsOf(l);
      t.salesMinor += l.lineTotalMinor;
      t.bills.add(s.saleId);
      const taxBps = await taxOn(l.productId, s.committedAt.slice(0, 10));
      const unitCost = s.storeId === undefined ? undefined : costs.costOf(l.productId, s.storeId);
      if (taxBps === undefined || unitCost === undefined) t.costKnown = false;
      else {
        t.netSalesMinor += deGross(l.lineTotalMinor, taxBps);
        t.costMinor += valueAtCost(l.quantityMinor, l.uom, { minor: unitCost });
      }
      out.set(l.productId, t);
    }
  }
  return out;
}

// ── M05-FR-04: an offer re-judged on the banked bills by the till's own engine ─────────────────────────────────────

interface PromotionTimeline { readonly promotion: Promotion; readonly activatedAt?: string; readonly stoppedAt?: string }

async function promotionTimelines(store: EventStore, tenantId: string): Promise<Map<string, PromotionTimeline>> {
  const byId = new Map<string, { promotion: Promotion; activatedAt?: string; stoppedAt?: string }>();
  for (const e of await store.readStream(tenantId, STREAM.promotions)) {
    const p = e.event.payload as Record<string, unknown>;
    if (e.event.type === 'PromotionDefined') byId.set(p['id'] as string, { promotion: p as unknown as Promotion });
    else if (e.event.type === 'PromotionActivated' || e.event.type === 'PromotionStopped') {
      const cur = byId.get(p['promotionId'] as string);
      if (cur === undefined) continue;
      if (e.event.type === 'PromotionActivated' && cur.activatedAt === undefined) cur.activatedAt = e.event.occurredAt;
      if (e.event.type === 'PromotionStopped' && cur.stoppedAt === undefined) cur.stoppedAt = e.event.occurredAt;
    }
  }
  return byId;
}

const activeAt = (t: PromotionTimeline, at: string): boolean =>
  t.activatedAt !== undefined && t.activatedAt <= at && (t.stoppedAt === undefined || at < t.stoppedAt);

/** The units on the lines an offer reached, bill by bill, as the till's engine judges each banked bill again. */
export async function unitsUnderOffer(input: Base, tenantId: string, promotion: Promotion, funded: readonly string[] | undefined): Promise<UnitsUnderOffer> {
  const timelines = await promotionTimelines(input.store, tenantId);
  const sales = await bankedSales(input, tenantId, promotion.startsAt, new Date(Date.parse(promotion.endsAt) + 1).toISOString());
  const products = new Map((await productMasterAdapter(input).products(tenantId)).map((p) => [p.productId, p] as const));
  const fundedSet = funded === undefined ? undefined : new Set(funded);
  let units = 0; let bills = 0; let notJudged = 0;
  for (const s of sales) {
    const basket: BasketLine[] = (s.lines ?? []).map((l, i) => ({
      lineId: `${i}`, productId: l.productId, unitPrice: money(l.unitPriceMinor, 'INR'), qty: unitsOf(l),
      ...(isEach(l.uom) ? {} : { lineTotal: money(l.lineTotalMinor + (l.discountMinor ?? 0), 'INR') }),
      ...(products.get(l.productId)?.safety?.carryBag === true ? { carryBag: true } : {}),
      ...(products.get(l.productId)?.safety?.tobacco === true ? { tobacco: true } : {}),
    }));
    const reached = promotionLines(promotion, basket);
    if (reached.length === 0) continue;
    // A coupon is not recorded on the bill, so an offer that needed one cannot be judged again: counted, said, never guessed.
    if (promotion.requiresCoupon !== undefined) { notJudged += 1; continue; }
    const set = [...timelines.values()].filter((t) => activeAt(t, s.committedAt) && t.promotion.requiresCoupon === undefined).map((t) => ({ ...t.promotion, status: 'active' as const }));
    const r = bestPrice(basket, set, { at: s.committedAt, currency: 'INR', isMember: s.customerRef !== undefined });
    if (!r.applied.some((a) => a.promotionId === promotion.id)) continue;
    bills += 1;
    units += reached.filter((l) => fundedSet === undefined || fundedSet.has(l.productId)).reduce((n, l) => n + l.qty, 0);
  }
  return { units, bills, billsNotJudged: notJudged };
}

async function fundingJournals(input: Base, tenantId: string): Promise<readonly PromotionFundingJournal[]> {
  return (await payloads<PromotionFundingJournal | { promotionFunding?: undefined }>(input.store, tenantId, STREAM.finance, 'JournalPosted'))
    .filter((j): j is PromotionFundingJournal => j.promotionFunding !== undefined);
}

// ── D02-FR-04: the shop's own lost-demand facts ─────────────────────────────────────────────────────────────────────

async function waveIds(input: Base, tenantId: string): Promise<readonly string[]> {
  const ids = new Set<string>();
  for (const p of await payloads<{ kind: string; id: string }>(input.store, tenantId, streamName(STREAM.delivery, 'assignment-index'), 'AssignmentPlaced')) if (p.kind === 'wave') ids.add(p.id);
  for (const storeId of await registeredStores(input, tenantId)) {
    for (const a of await payloads<{ waveId: string }>(input.store, tenantId, streamName(STREAM.delivery, 'assignments', storeId), 'WaveAssigned')) ids.add(a.waveId);
  }
  return [...ids].sort();
}

async function gapFacts(input: Base, tenantId: string, fromIso: string, toIso: string): Promise<readonly GapFact[]> {
  const pack = await latestPack(input.store, tenantId);
  const priceOf = new Map((pack?.snapshot.products ?? []).map((p) => [p.productId, p.unitPriceMinor] as const));
  const facts: GapFact[] = [];
  const shortsByOrder = new Map<string, string[]>();
  for (const waveId of await waveIds(input, tenantId)) {
    const latest = new Map<string, WaveLineOutcome>();
    for (const o of await payloads<WaveLineOutcome>(input.store, tenantId, streamName(STREAM.delivery, 'wave', waveId), 'PickLineOutcomeRecorded')) latest.set(o.lineId, o);
    for (const o of latest.values()) {
      if (o.state !== 'short' || o.at < fromIso || o.at >= toIso) continue;
      const shortBy = o.requiredQty === undefined || o.requiredQty === null ? 1 : Math.max(0, o.requiredQty - o.pickedQty);
      facts.push({ kind: 'short_pick', productId: o.productId, quantityMinor: shortBy, unitPriceMinor: priceOf.get(o.productId) });
      shortsByOrder.set(o.orderRef, [...(shortsByOrder.get(o.orderRef) ?? []), o.productId]);
    }
  }
  // A substitute offered and not taken. The substitution record names the order and line, not the ordered product, so the
  // product is the order's one short line (or the order's only line); otherwise it is filed as "product not recorded".
  const placed = new Map((await payloads<{ orderId: string; lines: readonly { productId: string }[] }>(input.store, tenantId, streamName(STREAM.orders, 'index'), 'OrderPlaced')).map((o) => [o.orderId, o] as const));
  const seen = new Set<string>();
  for (const s of await payloads<StoredSubstitution>(input.store, tenantId, streamName(STREAM.orders, 'substitutions'), 'LineSubstituted')) {
    const key = `${s.orderId}\u001f${s.lineId}`;
    if (seen.has(key) || s.outcome === 'substituted' || s.at < fromIso || s.at >= toIso) continue;
    seen.add(key);
    const shorts = [...new Set(shortsByOrder.get(s.orderId) ?? [])];
    const lines = placed.get(s.orderId)?.lines ?? [];
    const productId = shorts.length === 1 ? shorts[0]! : lines.length === 1 ? lines[0]!.productId : 'product not recorded';
    facts.push({ kind: 'failed_substitution', productId, quantityMinor: 1, unitPriceMinor: priceOf.get(productId) });
  }
  return facts;
}

// ── M04-FR-04: placements and the floor plan ────────────────────────────────────────────────────────────────────────

async function primaryPlacements(input: Base, tenantId: string, storeId: string): Promise<ReadonlyMap<string, string>> {
  const today = input.now().slice(0, 10);
  const latest = new Map<string, { version: number; assignments: readonly { productId: string; locationId: string; primary: boolean }[] }>();
  for (const p of await planogramStoreAdapter(input).planograms(tenantId, storeId)) {
    if (p.effectiveFrom.slice(0, 10) > today) continue;
    const cur = latest.get(p.planogramId);
    if (cur === undefined || p.version > cur.version) latest.set(p.planogramId, p);
  }
  const out = new Map<string, string>();
  for (const id of [...latest.keys()].sort()) for (const a of latest.get(id)!.assignments) if (a.primary && !out.has(a.productId)) out.set(a.productId, a.locationId);
  return out;
}

// ── the wiring ──────────────────────────────────────────────────────────────────────────────────────────────────────

function seasonDeps(input: Base): SeasonPlanDeps {
  const range = assortmentAdapter(input);
  return {
    now: input.now,
    memberships: async (t) => (await channelPricingAdapter(input).zones(t)).map((z) => ({ storeId: z.storeId, zoneId: z.zoneId, setAt: z.setAt })),
    productKnown: async (t, productId) => (await productMasterAdapter(input).product(t, productId)) !== undefined,
    storeOnHand: async (t, storeId, productId) => range.storeOnHand!(t, storeId, productId),
    recordRangeEntry: async (t, storeId, entry, key) => { await range.recordEntry(t, storeId, entry, key); },
    plans: (t) => payloads<SeasonPlan>(input.store, t, SEASON_PLANS, 'SeasonPlanMade'),
    recordPlan: (t, plan) => append(input.store, t, SEASON_PLANS, 'SeasonPlanMade', plan.planId, plan.setAt, plan),
    ends: (t) => payloads<SeasonEnd>(input.store, t, SEASON_PLANS, 'SeasonPlanEnded'),
    recordEnd: (t, end) => append(input.store, t, SEASON_PLANS, 'SeasonPlanEnded', end.planId, end.endedAt, end),
  };
}

/** The season sweep the ops worker runs on every pass (automatic clearance at season end). Answers how many seasons ended. */
export function p2SeasonSweep(input: Base): (tenantId: string, at: string) => Promise<number> {
  return async (tenantId) => (await endDueSeasons(seasonDeps(input), tenantId, 'season-end-sweep')).length;
}

/** M03-FR-03 §28: the tax-class routes' approval engine and audit trail. */
export function p2TaxClassHooks(input: Base) {
  return { approvals: approvalRequestsAdapter(input), now: input.now, ...(input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit }) };
}

/** B15: which products the product master says are tobacco — for the promotion catalogue's guard and its evaluation. */
export function p2PromotionHooks(input: Base) {
  return {
    tobaccoAmong: async (tenantId: string, ids: readonly string[]): Promise<readonly string[]> => {
      const wanted = new Set(ids);
      return (await productMasterAdapter(input).products(tenantId)).filter((p) => wanted.has(p.productId) && p.safety?.tobacco === true).map((p) => p.productId);
    },
  };
}

/** The bundles in force — what a pack would carry to the tills for them to explode a bundle sale (the till hook, P5). */
export async function bundlesInForce(input: Base, tenantId: string): Promise<readonly BundleDefinition[]> {
  const latest = new Map<string, BundleDefinition>();
  for (const d of await payloads<BundleDefinition>(input.store, tenantId, BUNDLES, 'BundleDefined')) {
    const cur = latest.get(d.bundleProductId);
    if (cur === undefined || d.version > cur.version) latest.set(d.bundleProductId, d);
  }
  return [...latest.values()];
}

export function p2CatalogueRoutes(raw: { readonly store: EventStore | undefined; readonly now: () => string; readonly recordAudit?: Recorder }): readonly Route[] {
  // With no ledger (the documented surface only) the routes run on an empty in-memory store — never a silent no-op.
  const input: Base = { store: raw.store ?? new InMemoryEventStore(), now: raw.now, ...(raw.recordAudit === undefined ? {} : { recordAudit: raw.recordAudit }) };
  const { store, now } = input;
  const audit = input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit };
  const master = productMasterAdapter(input);
  const products = (t: string): Promise<readonly ProductRecord[]> => Promise.resolve(master.products(t));
  return [
    ...variantReportRoutes({ products, categories: async (t) => categoryRegisterAdapter(input).categories(t), now }),
    ...bundleRoutes({
      products, now, ...audit,
      definitions: (t) => payloads<BundleDefinition>(store, t, BUNDLES, 'BundleDefined'),
      recordDefinition: (t, d) => append(store, t, BUNDLES, 'BundleDefined', `${d.bundleProductId}-v${d.version}`, d.definedAt, d),
    }),
    ...substituteRoutes({
      products, now, ...audit,
      lists: (t, productId) => payloads<SubstituteList>(store, t, SUBSTITUTES(productId), 'SubstitutesSet'),
      recordList: (t, l) => append(store, t, SUBSTITUTES(l.productId), 'SubstitutesSet', `${l.productId}-v${l.version}`, l.setAt, l),
    }),
    ...searchMissRoutes({ now, recordMiss: (t, m, key) => append(store, t, SEARCH_MISSES, 'SearchMissRecorded', key, m.at, m) }),
    ...floorPlanRoutes({
      now, registeredStores: (t) => registeredStores(input, t),
      shelfLocations: async (t, storeId) => {
        const map = await planogramStoreAdapter(input).shelfMap(t, storeId);
        return map === undefined ? undefined : new Set(map.locations.map((l) => l.locationId));
      },
      plans: (t, storeId) => payloads<FloorPlan>(store, t, FLOOR_PLANS(storeId), 'FloorPlanPublished'),
      recordPlan: (t, p) => append(store, t, FLOOR_PLANS(p.storeId), 'FloorPlanPublished', `${p.storeId}-v${p.version}`, p.publishedAt, p),
      primaryPlacements: (t, storeId) => primaryPlacements(input, t, storeId),
      takings: async (t, storeId, fromIso, toIso): Promise<readonly ProductTakings[]> =>
        [...(await takingsByProduct(input, t, fromIso, toIso, { storeId })).entries()].map(([productId, v]) => ({
          productId, salesMinor: v.salesMinor, netSalesMinor: v.netSalesMinor, costMinor: v.costKnown ? v.costMinor : undefined,
        })),
    }),
    ...seasonPlanRoutes(seasonDeps(input)),
    ...rangeGapRoutes({
      now,
      gapFacts: (t, from, to) => gapFacts(input, t, from, to),
      searchMisses: async (t, from, to): Promise<readonly SearchMiss[]> => {
        const counts = new Map<string, number>();
        for (const m of await payloads<SearchMissRecord>(store, t, SEARCH_MISSES, 'SearchMissRecorded', { from, to })) counts.set(m.words, (counts.get(m.words) ?? 0) + 1);
        return [...counts.entries()].map(([words, count]) => ({ words, count }));
      },
      categoryOf: async (t) => {
        const byId = new Map((await products(t)).map((p) => [p.productId, p.primaryCategoryId] as const));
        return (productId) => byId.get(productId) ?? null;
      },
      sold: async (t, from, to): Promise<readonly SoldProduct[]> =>
        [...(await takingsByProduct(input, t, from, to)).entries()].map(([productId, v]) => ({ productId, netSalesMinor: v.netSalesMinor, costMinor: v.costKnown ? v.costMinor : undefined })),
      privateLabel: async (t) => {
        const latest = new Map<string, boolean>();
        for (const d of await eprAdapter(input).declarations(t)) latest.set(d.productId, d.ownBrand);
        return new Set([...latest.entries()].filter(([, own]) => own).map(([id]) => id));
      },
    }),
    ...vendorFundingRoutes({
      ...financeDeps(input), approvals: approvalRequestsAdapter(input),
      promotion: async (t, id) => (await promotionTimelines(store, t)).get(id)?.promotion,
      agreements: (t) => payloads<FundingAgreement>(store, t, FUNDING, 'PromotionFundingAgreed'),
      recordAgreement: (t, a, key) => append(store, t, FUNDING, 'PromotionFundingAgreed', `${a.promotionId}-${a.supplierId}-${key}`, a.recordedAt, a),
      postingMap: async (t) => (await store.latestOfType(t, STREAM.finance, 'PostingMapDefined'))?.event.payload as StoredPostingMap | undefined,
      fundingJournals: (t) => fundingJournals(input, t),
      unitsUnderOffer: (t, promotion, funded) => unitsUnderOffer(input, t, promotion, funded),
    }),
    ...promotionResultRoutes({
      now,
      promotion: async (t, id) => (await promotionTimelines(store, t)).get(id)?.promotion,
      takings: async (t, productIds, fromIso, toIso): Promise<WindowTakings> => {
        const taken = await takingsByProduct(input, t, fromIso, toIso, { productIds });
        const all = [...taken.entries()];
        const unknown = all.filter(([, v]) => !v.costKnown).map(([id]) => id).sort();
        return {
          units: all.reduce((n, [, v]) => n + v.units, 0), netSalesMinor: all.reduce((n, [, v]) => n + v.netSalesMinor, 0),
          costMinor: unknown.length > 0 ? undefined : all.reduce((n, [, v]) => n + v.costMinor, 0), costNotKnownFor: unknown,
          bills: new Set(all.flatMap(([, v]) => [...v.bills])).size,
        };
      },
      fundingReceived: async (t, promotionId) => (await fundingJournals(input, t)).filter((j) => j.promotionFunding.promotionId === promotionId).reduce((s, j) => s + j.promotionFunding.amountMinor, 0),
    }),
  ];
}

function financeDeps(input: Base) {
  const fin = financeAdapter(input);
  return { periodStates: fin.periodStates, nextOpenPeriod: fin.nextOpenPeriod, appendJournal: fin.appendJournal, now: input.now };
}
