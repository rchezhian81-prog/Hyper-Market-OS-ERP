// R4 Lane 3 — customer insight, offers and demand. Head office's wiring for M16 (the Customers page's read) · M17-FR-02 /
// D07-FR-04 (referral rewards as a liability, OB-221) · D-23 (bought-together) · D-22 (personal offers a person approves)
// · D-24 (festivals and local events in the forecast; weather switched off, OB-220). Every register is append-only on its
// own stream (hard rules #2, #6); reads fold the streams; nothing here edits or deletes a record. One entry point,
// `r4InsightRoutes`, is registered from main.ts, and `demandCalendarFor` is the port the forecast reads.

import { makeEvent } from '../../../packages/contracts/src/event';
import { InMemoryEventStore, type EventStore } from '../../../packages/persistence/src/event-store';
import type { Route } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import type { SignedPack } from '../../catalogue/src/pack';
import type { IncomingSale } from '../../pos/src/sale-intake';
import type { ReturnRecord } from '../../pos/src/returns';
import type { StoredPostingMap } from '../../finance/src/day-book';
import type { JournalEntry } from '../../finance/src/index';
import type { Category } from '../../../packages/product/src/product';
import {
  STREAM, streamName, segmentDataAdapter, customer360Adapter, financeAdapter, couponAdapter, productMasterAdapter,
  categoryRegisterAdapter, inventoryAdapter, orgStructureAdapter, saleStockLocationOf,
} from './adapters';
import { branchOfLocationIn } from '../../inventory/src/location-scope';
import { collapseConsent } from '../../customer/src/segments';
import { customerOverviewRoutes, type CustomerOverviewDeps } from '../../customer/src/customer-overview';
import { referralLiabilityRoutes, type ReferralLiabilityDeps, type ReferralEarned, type ReferralSettled, type ReferralJournal } from '../../customer/src/offer-liability';
import { offerProposalRoutes, ageOf, type OfferProposalDeps, type OfferBatch, type AgeConfirmation } from '../../customer/src/offer-proposals';
import { basketAffinityRoutes, type BasketAffinityDeps } from '../../reporting/src/basket-affinity';
import { demandEventRoutes, type DemandEventsDeps, type DemandCalendarPort } from '../../inventory/src/demand-events';
import { WEATHER_FEED_SWITCHED_OFF, type DemandEvent, type WeatherFeedPort } from '../../../packages/calendar/src/demand-events';
import type { OfferMember, MemberPurchaseLine, OfferPricing } from '../../../packages/loyalty/src/next-best-offer';
import type { DailyDemand } from '../../../packages/demand/src/forecast';

/** EA-07 · OB-222: the brief's sending link type, for main.ts (production never sets one). */
export type { BriefSendingLink } from '../../reporting/src/scheduled-brief';

type Recorder = (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
type Base = { readonly store: EventStore; readonly now: () => string; readonly recordAudit?: Recorder };

const all = async <T>(store: EventStore, tenantId: string, stream: string, type: string): Promise<T[]> =>
  (await store.readStream(tenantId, stream, { type })).map((e) => e.event.payload as T);
const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10);
const audited = (r: Recorder | undefined) => (r === undefined ? {} : { recordAudit: r });

/** The banked bills booked to trading days in [fromDay, toDay] (the read is padded: a bill can commit after midnight). */
async function bankedSales(store: EventStore, tenantId: string, fromDay: string, toDay: string): Promise<IncomingSale[]> {
  const events = await store.readStream(tenantId, STREAM.sales, { type: 'SaleCommitted', from: `${addDays(fromDay, -1)}T00:00:00.000Z`, to: `${addDays(toDay, 2)}T00:00:00.000Z` });
  return events.map((e) => e.event.payload as IncomingSale).filter((s) => s.tradingDay >= fromDay && s.tradingDay <= toDay);
}

/** Each product's category and every parent of it, nearest first — undefined when the product has no category. */
async function categoryChains(store: EventStore, now: () => string, tenantId: string): Promise<(productId: string) => readonly string[] | undefined> {
  const products = new Map((await productMasterAdapter({ store, now }).products(tenantId)).map((p) => [p.productId, p] as const));
  const cats = new Map((await categoryRegisterAdapter({ store, now }).categories(tenantId)).map((c) => [(c as Category).categoryId, c as Category] as const));
  return (productId) => {
    const start = products.get(productId)?.primaryCategoryId ?? null;
    if (start === null) return undefined;
    const chain: string[] = [];
    let at: string | null = start;
    while (at !== null && !chain.includes(at)) { chain.push(at); at = cats.get(at)?.parentId ?? null; }
    return chain;
  };
}

// ── M16: the Customers page's read ──────────────────────────────────────────────────────────────────────────────────

export function customerOverviewAdapter(input: Base): CustomerOverviewDeps {
  const { store, now } = input;
  const seg = segmentDataAdapter({ store, now });
  const c360 = customer360Adapter({ store, now });
  return {
    now,
    // FUL-10: the facts are derived from the banked sales and returns, brought up to date before each read.
    orderFacts: async (t) => { await c360.catchUp(t); return seg.orderFacts(t); },
    complaintFacts: async (t) => seg.complaintFacts(t),
    policy: async (t) => seg.policy(t),
    consentFor: async (t, ref) => seg.consentFor(t, ref),
    merges: async (t) => c360.merges(t),
  };
}

// ── M17-FR-02 / D07-FR-04: referral rewards as a liability (OB-221) ─────────────────────────────────────────────────

const REFERRALS = streamName(STREAM.loyalty, 'referrals');
const REFERRAL_SETTLEMENTS = streamName(STREAM.loyalty, 'referral-settlements');

export function referralLiabilityAdapter(input: Base): ReferralLiabilityDeps {
  const { store, now } = input;
  const fin = financeAdapter({ store, now });
  return {
    now, periodStates: fin.periodStates, nextOpenPeriod: fin.nextOpenPeriod, appendJournal: fin.appendJournal,
    earned: (t) => all<ReferralEarned>(store, t, REFERRALS, 'ReferralRewarded'),
    settled: (t) => all<ReferralSettled>(store, t, REFERRAL_SETTLEMENTS, 'ReferralRewardSettled'),
    recordSettled: async (t, s) => {
      await store.append(t, REFERRAL_SETTLEMENTS, makeEvent({
        id: `referral-${s.kind}-${s.referralId}`, type: 'ReferralRewardSettled', occurredAt: s.at,
        // One settlement per referral: a resend (or a payout racing an expiry) collapses onto the first.
        idempotencyKey: `referral-settled-${t}-${s.referralId}`, source: 'api/customer', payload: s,
      }));
    },
    postingMap: async (t) => (await all<StoredPostingMap>(store, t, STREAM.finance, 'PostingMapDefined')).at(-1),
    referralJournals: async (t) => (await all<JournalEntry | ReferralJournal>(store, t, STREAM.finance, 'JournalPosted')).filter((j): j is ReferralJournal => 'referral' in j),
    creditBalance: async (t, account) => {
      let balance = 0;
      for (const j of await all<JournalEntry>(store, t, STREAM.finance, 'JournalPosted')) for (const l of j.lines) if (l.accountCode === account) balance += l.creditMinor - l.debitMinor;
      return balance;
    },
    ...audited(input.recordAudit),
  };
}

// ── D-23: bought together ───────────────────────────────────────────────────────────────────────────────────────────

export function basketAffinityAdapter(input: Base): BasketAffinityDeps {
  const { store, now } = input;
  return {
    now,
    baskets: async (t, fromDay, toDay) => (await bankedSales(store, t, fromDay, toDay)).map((s) => ({ basketId: s.saleId, lines: (s.lines ?? []).map((l) => ({ productId: l.productId, quantityMinor: l.quantityMinor })) })),
    returnsAgainst: async (t, ids) => (await all<ReturnRecord>(store, t, STREAM.returns, 'ReturnRecorded'))
      .filter((r) => r.originalSaleId !== null && ids.has(r.originalSaleId))
      .map((r) => ({ basketId: r.originalSaleId!, lines: r.lines.map((l) => ({ productId: l.productId, quantityMinor: l.quantityMinor })) })),
    categoryChain: (t) => categoryChains(store, now, t),
  };
}

// ── D-22: personal offers ───────────────────────────────────────────────────────────────────────────────────────────

const OFFER_BATCHES = streamName(STREAM.loyalty, 'offer-batches');
const AGE_CONFIRMATIONS = streamName(STREAM.customer, 'age-confirmations');

export function offerProposalAdapter(input: Base): OfferProposalDeps {
  const { store, now } = input;
  const seg = segmentDataAdapter({ store, now });
  const c360 = customer360Adapter({ store, now });
  const coupons = couponAdapter({ store, now });
  const ages = (t: string) => all<AgeConfirmation>(store, t, AGE_CONFIRMATIONS, 'CustomerAgeConfirmed');
  const memberOf = async (t: string, ref: string, confirmations?: readonly AgeConfirmation[]): Promise<OfferMember> => {
    const consent = collapseConsent(ref, await seg.consentFor(t, ref));
    return { customerRef: ref, profilingConsent: consent.granted.includes('profiling'), marketingConsent: consent.granted.includes('marketing'), age: ageOf(confirmations ?? await ages(t), ref) };
  };
  return {
    now,
    members: async (t) => {
      await c360.catchUp(t);
      const refs = [...new Set((await seg.orderFacts(t)).map((o) => o.customerRef))].sort();
      const confirmations = await ages(t);
      return Promise.all(refs.map((ref) => memberOf(t, ref, confirmations)));
    },
    member: (t, ref) => memberOf(t, ref),
    purchases: async (t, fromDay, toDay) => {
      const out: MemberPurchaseLine[] = [];
      for (const s of await bankedSales(store, t, fromDay, toDay)) {
        const ref = typeof s.customerRef === 'string' ? s.customerRef.trim() : '';
        if (ref === '') continue;
        for (const l of s.lines ?? []) out.push({ customerRef: ref, saleId: s.saleId, productId: l.productId, quantityMinor: l.quantityMinor, day: s.tradingDay });
      }
      return out;
    },
    pricing: async (t) => {
      const pack = (await all<SignedPack>(store, t, STREAM.catalogue, 'CataloguePublished')).at(-1);
      const shelf = new Map((pack?.snapshot.products ?? []).map((p) => [p.productId, p] as const));
      // The cost: the highest weighted-average unit cost the ledger holds for the product at any place — so an offer is
      // never below what any of its stock cost. A cost the ledger does not know stays unknown (never zero).
      const cost = new Map<string, number>();
      for (const r of await inventoryAdapter({ store, now }).valuation(t, undefined)) {
        if (r.unitCostMinor === 'not_known') continue;
        cost.set(r.productId, Math.max(cost.get(r.productId) ?? 0, r.unitCostMinor));
      }
      return (productId): OfferPricing => {
        const p = shelf.get(productId);
        return {
          ...(p === undefined ? {} : { priceMinor: p.unitPriceMinor }),
          ...(p?.mrpMinor === undefined ? {} : { mrpMinor: p.mrpMinor }),
          ...(cost.has(productId) ? { costMinor: cost.get(productId)! } : {}),
        };
      };
    },
    batches: (t) => all<OfferBatch>(store, t, OFFER_BATCHES, 'OfferBatchRecorded'),
    recordBatch: async (t, b) => {
      await store.append(t, OFFER_BATCHES, makeEvent({
        id: `offer-batch-${b.batchId}-${b.state}`, type: 'OfferBatchRecorded', occurredAt: b.approvedAt ?? b.rejectedAt ?? b.draftedAt,
        idempotencyKey: `offer-batch-${t}-${b.batchId}-${b.state}`, source: 'api/customer', payload: b,
      }));
    },
    couponExists: async (t, code) => (await coupons.coupon(t, code)) !== undefined,
    issueCoupon: async (t, coupon, key) => { await coupons.issue(t, coupon, key); },
    ageConfirmations: ages,
    recordAgeConfirmation: async (t, c) => {
      await store.append(t, AGE_CONFIRMATIONS, makeEvent({
        id: `age-${c.customerRef}-${c.confirmedAt}`, type: 'CustomerAgeConfirmed', occurredAt: c.confirmedAt,
        idempotencyKey: `age-${t}-${c.customerRef}-${c.confirmedAt}`, source: 'api/customer', payload: c,
      }));
    },
    ...audited(input.recordAudit),
  };
}

// ── D-24: the store's event calendar and the forecast's port to it ──────────────────────────────────────────────────

const DEMAND_EVENTS = streamName(STREAM.inventory, 'demand-events');
const demandEvents = (store: EventStore, t: string) => all<DemandEvent>(store, t, DEMAND_EVENTS, 'DemandEventRecorded');

export function demandEventsAdapter(input: Base & { readonly weather?: WeatherFeedPort }): DemandEventsDeps {
  const { store, now } = input;
  return {
    now,
    events: (t) => demandEvents(store, t),
    recordEvent: async (t, e) => {
      await store.append(t, DEMAND_EVENTS, makeEvent({
        id: `demand-event-${e.eventId}-v${e.version}`, type: 'DemandEventRecorded', occurredAt: e.withdrawn?.at ?? e.recordedAt,
        idempotencyKey: `demand-event-${t}-${e.eventId}-v${e.version}`, source: 'api/inventory', payload: e,
      }));
    },
    storeDailyTotals: async (t, storeId, fromDay, toDay) => {
      const branchOf = branchOfLocationIn(await orgStructureAdapter({ store, now }).nodes(t));
      const perDay = new Map<string, number>();
      for (const s of await bankedSales(store, t, fromDay, toDay)) {
        const { locationId } = await saleStockLocationOf(store, t, s);
        if (locationId !== storeId && branchOf(locationId) !== storeId) continue;
        for (const l of s.lines ?? []) perDay.set(s.tradingDay, (perDay.get(s.tradingDay) ?? 0) + l.quantityMinor);
      }
      return [...perDay].map(([day, qty]): DailyDemand => ({ day, qty })).sort((a, b) => a.day.localeCompare(b.day));
    },
    // OB-220: the only weather link production has is switched off.
    weather: input.weather ?? WEATHER_FEED_SWITCHED_OFF,
    ...audited(input.recordAudit),
  };
}

/** The port the forecast and the order proposal read the calendar through (sales-history.ts `demandCalendar`). */
export function demandCalendarFor(input: { readonly store: EventStore | undefined; readonly now: () => string; readonly weather?: WeatherFeedPort }): DemandCalendarPort | undefined {
  const { store, now } = input;
  if (store === undefined) return undefined;
  return {
    events: (t) => demandEvents(store, t),
    categoryChain: async (t, productId) => (await categoryChains(store, now, t))(productId) ?? [],
    weather: input.weather ?? WEATHER_FEED_SWITCHED_OFF,
  };
}

// ── the one entry point ──────────────────────────────────────────────────────────────────────────────────────────

/** Every Lane 3 route, composed over head office's store (or a throw-away in-memory one when the surface has none). */
export function r4InsightRoutes(input: { readonly store: EventStore | undefined; readonly now: () => string; readonly recordAudit?: Recorder }): readonly Route[] {
  const base: Base = { store: input.store ?? new InMemoryEventStore(), now: input.now, ...audited(input.recordAudit) };
  return [
    ...customerOverviewRoutes(customerOverviewAdapter(base)),
    ...referralLiabilityRoutes(referralLiabilityAdapter(base)),
    ...basketAffinityRoutes(basketAffinityAdapter(base)),
    ...offerProposalRoutes(offerProposalAdapter(base)),
    ...demandEventRoutes(demandEventsAdapter(base)),
  ];
}
