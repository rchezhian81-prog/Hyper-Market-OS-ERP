// Round 9 (Batch 3) finance registers — each append-only on its own stream (hard rules #2, #6):
//   • OB-55: the card/UPI payments a store's day close carried forward to head office, their one resolution, conflicts;
//   • OB-56: the month-end stock valuation the stock adjustment and the close read (head office's own stock ledger);
//   • OB-57: monthly budget versions, and the fixed-asset register's facts (added, transferred, disposed);
// Reads fold the streams; nothing here edits a record.

import { createHash, randomUUID } from 'node:crypto';
import { makeEvent } from '../../../packages/contracts/src/event';
import type { EventStore } from '../../../packages/persistence/src/event-store';
import type { DayCloseRecord, CarriedPaymentIn } from '../../pos/src/day-close';
import type { PaymentException, PaymentExceptionResolution, PaymentExceptionConflict, PaymentExceptionDeps, LatePaymentAnswer, LateAnswerConflict, RaisedNoAnswer } from '../../finance/src/payment-exceptions';
import { mergeRaisedAndCarried } from '../../finance/src/payment-exceptions';
import { stockCostAdjustments } from './adapters'; // OB-288 P3
import { STREAM, streamName, permissionsHeldBy, productMasterAdapter, periodBooksAdapter, stockLossAdapter, storeOfLocationResolver, averageBuyingCosts, unappliedHeldWriteOffs } from './adapters';
import { project, ownershipOf, EFFECT_ON_HAND, type Movement } from '../../inventory/src/index';
import { valueAtCost } from '../../../packages/contracts/src/quantity';
import { stockAdjustmentSources } from '../../finance/src/period-books';
import { lossSourceId } from '../../finance/src/stock-losses';
import { stockPeriodAccounts, stockValueCheck, type ClosingStockLine, type StockValuation, type StockPeriodDeps } from '../../finance/src/stock-period';
import type { ControlTotalCheck } from '../../finance/src/index';
import type { BudgetAssetDeps, BudgetVersion, FixedAssetFact } from '../../finance/src/budgets-assets';
import { shopClock, tradingMonthIn, type ShopCalendarOf } from '../../../packages/calendar/src/shop-clock';

const digest = (key: string): string => createHash('sha256').update(key).digest('hex').slice(0, 16);
const all = async <T>(store: EventStore, tenantId: string, stream: string, type: string): Promise<T[]> =>
  (await store.readStream(tenantId, stream, { type })).map((e) => e.event.payload as T);

// ── OB-55: payment exceptions carried forward from a store day close ─────────────────────────────────────────────

// Resolved at call time: this module and adapters.ts import each other (through the report producers).
const paymentExceptionsStream = (): string => streamName(STREAM.finance, 'payment-exceptions');

/** Each carried payment becomes ONE exception, keyed on its attempt id — a re-sent close carries nothing twice. */
export async function carryPaymentExceptionsIn(store: EventStore, tenantId: string, close: DayCloseRecord, payments: readonly CarriedPaymentIn[], at: string): Promise<void> {
  const cf = close.carriedForward;
  if (cf === undefined || payments.length === 0) return;
  await store.appendBatch(tenantId, payments.map((p) => {
    const e: PaymentException = {
      ...p, storeId: close.storeId, dayCloseId: close.dayCloseId, closedBy: close.closedBy, approvedBy: cf.approvedBy,
      approvalId: cf.approvalId, reason: cf.reason, carriedAt: at, governanceFlags: cf.flags,
    };
    return {
      stream: paymentExceptionsStream(),
      event: makeEvent({
        id: `payment-exception-${digest(p.attemptId)}`, type: 'PaymentExceptionCarried', occurredAt: at,
        idempotencyKey: `payment-exception-carried-${tenantId}-${p.attemptId}`, source: 'api/finance', payload: e,
      }),
    };
  }));
}

export function paymentExceptionsAdapter(input: { readonly store: EventStore; readonly now: () => string }): PaymentExceptionDeps {
  return {
    now: input.now,
    // OB-69: one item per attempt — raised at the no-answer, the same item once a day close carries it (never two).
    exceptions: async (tenantId) => {
      const [raised, carried] = await Promise.all([
        all<RaisedNoAnswer>(input.store, tenantId, paymentExceptionsStream(), 'PaymentNoAnswerRaised'),
        all<PaymentException>(input.store, tenantId, paymentExceptionsStream(), 'PaymentExceptionCarried'),
      ]);
      return mergeRaisedAndCarried(raised, carried);
    },
    raised: (tenantId) => all<RaisedNoAnswer>(input.store, tenantId, paymentExceptionsStream(), 'PaymentNoAnswerRaised'),
    recordRaised: async (tenantId, r) => {
      const res = await input.store.append(tenantId, paymentExceptionsStream(), makeEvent({
        id: `payment-no-answer-${digest(r.attemptId)}`, type: 'PaymentNoAnswerRaised', occurredAt: r.raisedAt,
        // ONE raised item per attempt: a re-sent relay collapses here even if two raced past the route's check.
        idempotencyKey: `payment-no-answer-raised-${tenantId}-${r.attemptId}`, source: 'api/finance', payload: r,
      }));
      return { deduped: res.deduped };
    },
    resolutions: (tenantId) => all<PaymentExceptionResolution>(input.store, tenantId, paymentExceptionsStream(), 'PaymentExceptionResolved'),
    conflicts: (tenantId) => all<PaymentExceptionConflict>(input.store, tenantId, paymentExceptionsStream(), 'PaymentExceptionResolutionConflict'),
    recordResolution: async (tenantId, r) => {
      // Says whether THIS resolution landed: a second, concurrent answer collapses on the key and the route judges it.
      const res = await input.store.append(tenantId, paymentExceptionsStream(), makeEvent({
        // The id is unique per write: two answers racing must meet on the KEY (one lands, the other collapses and is judged),
        // never on the ledger's id constraint (PostgreSQL would fail the loser outright instead of collapsing it).
        id: `payment-exception-resolved-${digest(r.attemptId)}-${randomUUID()}`, type: 'PaymentExceptionResolved', occurredAt: r.resolvedAt,
        // ONE resolution per payment: a second arrival collapses here even if two raced past the route's check.
        idempotencyKey: `payment-exception-resolved-${tenantId}-${r.attemptId}`, source: 'api/finance', payload: r,
      }));
      return !res.deduped;
    },
    lateAnswers: async (tenantId) => {
      const seen = new Set<string>();
      return (await all<LatePaymentAnswer>(input.store, tenantId, paymentExceptionsStream(), 'PaymentLateAnswerRecorded')).filter((a) => (seen.has(a.attemptId) ? false : (seen.add(a.attemptId), true)));
    },
    recordLateAnswer: async (tenantId, a) => {
      const res = await input.store.append(tenantId, paymentExceptionsStream(), makeEvent({
        // Round 13: the id is unique per write, so two answers racing meet on the KEY (one lands, the other collapses and is
        // judged against it) — never on the ledger's id constraint.
        id: `payment-late-answer-${digest(a.attemptId)}-${randomUUID()}`, type: 'PaymentLateAnswerRecorded', occurredAt: a.answeredAt,
        idempotencyKey: `payment-late-answer-${tenantId}-${a.attemptId}`, source: 'api/finance', payload: a,
      }));
      return res.record.event.payload as LatePaymentAnswer;
    },
    lateAnswerConflicts: (tenantId) => all<LateAnswerConflict>(input.store, tenantId, paymentExceptionsStream(), 'PaymentLateAnswerConflict'),
    recordLateAnswerConflict: async (tenantId, c) => {
      const d = digest(`${c.attemptId}|${JSON.stringify(c.offered)}`);
      await input.store.append(tenantId, paymentExceptionsStream(), makeEvent({
        // One record per distinct offered answer: the same conflicting answer re-sent collapses on its key.
        id: `payment-late-answer-conflict-${d}-${randomUUID()}`, type: 'PaymentLateAnswerConflict', occurredAt: c.at,
        idempotencyKey: `payment-late-answer-conflict-${tenantId}-${d}`, source: 'api/finance', payload: c,
      }));
    },
    permissionsOf: (tenantId, userId) => permissionsHeldBy(input.store, tenantId, userId),
    recordConflict: async (tenantId, c) => {
      const d = digest(`${c.attemptId}|${JSON.stringify(c.offered)}`);
      await input.store.append(tenantId, paymentExceptionsStream(), makeEvent({
        // The id is unique per write (a re-sent conflict collapses on its key, never on the id constraint).
        id: `payment-exception-conflict-${d}-${randomUUID()}`, type: 'PaymentExceptionResolutionConflict', occurredAt: c.at,
        idempotencyKey: `payment-exception-conflict-${tenantId}-${d}`, source: 'api/finance', payload: c,
      }));
    },
  };
}

/** R1b (M01-FR-02): the month (YYYY-MM) of an instant's shop trading day, in the tenant's calendar (the shop default when none). */
async function shopMonthReader(input: { readonly calendar?: ShopCalendarOf }, tenantId: string): Promise<(iso: string) => string> {
  const calendar = await shopClock(input.calendar).calendar(tenantId);
  return (iso) => tradingMonthIn(iso, calendar);
}

// ── OB-56: the month-end stock adjustment — head office's own stock ledger, valued at the average buying cost ─────

/** Every product's on-hand at the month end per store, at the OB-39 average as it stood then; the month's purchases. */
export async function stockValuationFor(input: { readonly store: EventStore; readonly now: () => string; readonly calendar?: ShopCalendarOf }, tenantId: string, period: string): Promise<StockValuation> {
  // R1b (M01-FR-02): a movement belongs to the month of its shop trading day — never its UTC month (wrong 00:00–05:30 IST on the 1st).
  const monthOf = await shopMonthReader(input, tenantId);
  const [{ storeOf }, avg, products] = await Promise.all([storeOfLocationResolver(input, tenantId), averageBuyingCosts(input, tenantId, { throughPeriod: period }), productMasterAdapter(input).products(tenantId)]);
  // A line with no value carries the product's display name (the product master's), so finance reads it without
  // catalogue access; a product the master does not hold is named by its id alone.
  const nameOf = new Map(products.map((p) => [p.productId, p.name] as const));
  const named = (productId: string): { name?: string } => { const n = nameOf.get(productId); return n === undefined || n.trim() === '' ? {} : { name: n }; };
  const movements = (await input.store.readStream(tenantId, STREAM.inventory, { type: 'InventoryMoved' }))
    .map((e) => e.event.payload as Movement)
    // The shop's own stock only (M27-FR-02): concession, consignment and customer property are not its inventory.
    .filter((m) => ownershipOf(m) === 'own' && monthOf(m.occurredAt) <= period);
  const uomOf = new Map<string, string>();
  for (const m of movements) if (!uomOf.has(m.productId)) uomOf.set(m.productId, m.uom);
  const onHand = new Map<string, { productId: string; storeId: string; qty: number }>();
  for (const a of project(movements, input.now())) {
    const storeId = storeOf(a.locationId);
    const key = `${a.productId}\u001f${storeId}`;
    const held = onHand.get(key) ?? { productId: a.productId, storeId, qty: 0 };
    held.qty += a.onHandMinor;
    onHand.set(key, held);
  }
  // OB-68 / OB-70: units a production run made with NO cost (an ingredient had neither an average nor a registered cost)
  // are never priced at the product's average from OTHER runs or receipts. Stock on hand at the month end is taken to be
  // the LATEST arrivals (first in, first out): walking a product's arrivals at a store newest first, the units of a
  // not-valued run that are still on hand are split out, unvalued and named by run — the adjustment waits for them.
  const inflowsOf = new Map<string, Movement[]>();
  for (const m of movements) {
    if (EFFECT_ON_HAND[m.kind] <= 0) continue;
    const key = `${m.productId}\u001f${storeOf(m.locationId)}`;
    const xs = inflowsOf.get(key) ?? [];
    xs.push(m);
    inflowsOf.set(key, xs);
  }
  const notValuedRunUnits = (productId: string, storeId: string, qty: number): { units: number; runs: string[] } => {
    const out = { units: 0, runs: [] as string[] };
    let left = qty;
    const newestFirst = [...(inflowsOf.get(`${productId}\u001f${storeId}`) ?? [])].map((m, i) => ({ m, i }))
      .sort((a, b) => (a.m.occurredAt === b.m.occurredAt ? b.i - a.i : b.m.occurredAt.localeCompare(a.m.occurredAt)));
    for (const { m } of newestFirst) {
      if (left <= 0) break;
      const take = Math.min(m.quantityMinor, left);
      left -= take;
      if (m.kind === 'produced' && m.unitCostMinor === undefined) {
        out.units += take;
        const run = /^prod-run:(.+):out$/.exec(m.movementId)?.[1] ?? m.movementId;
        if (!out.runs.includes(run)) out.runs.push(run);
      }
    }
    return out;
  };
  const closing: ClosingStockLine[] = [...onHand.values()].filter((x) => x.qty !== 0)
    .sort((a, b) => (a.productId === b.productId ? a.storeId.localeCompare(b.storeId) : a.productId.localeCompare(b.productId)))
    .flatMap((x): ClosingStockLine[] => {
      const uom = uomOf.get(x.productId) ?? 'ea';
      const unit = avg.costOf(x.productId, x.storeId);
      const nv = x.qty > 0 ? notValuedRunUnits(x.productId, x.storeId, x.qty) : { units: 0, runs: [] };
      const runsNamed = nv.runs.length === 0 ? {} : { notValuedRuns: nv.runs };
      if (unit === undefined) return [{ productId: x.productId, ...named(x.productId), storeId: x.storeId, onHandMinor: x.qty, uom, unitCostMinor: null, valueMinor: null, ...runsNamed }];
      if (nv.units === 0) return [{ productId: x.productId, storeId: x.storeId, onHandMinor: x.qty, uom, unitCostMinor: unit, valueMinor: valueAtCost(x.qty, uom, { minor: unit }) }];
      const valuedQty = x.qty - nv.units;
      return [
        ...(valuedQty > 0 ? [{ productId: x.productId, storeId: x.storeId, onHandMinor: valuedQty, uom, unitCostMinor: unit, valueMinor: valueAtCost(valuedQty, uom, { minor: unit }) }] : []),
        { productId: x.productId, ...named(x.productId), storeId: x.storeId, onHandMinor: nv.units, uom, unitCostMinor: null, valueMinor: null, notValuedRuns: nv.runs },
      ];
    });
  // The month's purchases: receipts into own stock at their own cost (no cost: the average), less goods sent back to a
  // supplier at the average. Opening-load receipts and their reversals are not purchases.
  let receivedMinor = 0;
  let returnedToSupplierMinor = 0;
  let openingLoadsMinor = 0;
  const unvaluedPurchases: string[] = [];
  const isOpening = (m: Movement): boolean => m.movementId.startsWith('opening-');
  // OB-288 P3 (M07-FR-04): a matched bill's landed charges posted into stock this month are part of the month's purchases.
  for (const adj of await stockCostAdjustments(input.store, tenantId)) if (monthOf(adj.occurredAt) === period) receivedMinor += adj.valueMinor;
  for (const m of movements.filter((x) => monthOf(x.occurredAt) === period)) {
    const storeId = storeOf(m.locationId);
    const atAverage = (): number | undefined => { const u = avg.costOf(m.productId, storeId); return u === undefined ? undefined : valueAtCost(m.quantityMinor, m.uom, { minor: u }); };
    if (m.kind === 'received') {
      const v = m.unitCostMinor !== undefined ? valueAtCost(m.quantityMinor, m.uom, { minor: m.unitCostMinor, ...(m.unitCostPer === undefined ? {} : { per: m.unitCostPer }) }) : atAverage();
      if (v === undefined) { unvaluedPurchases.push(`receipt ${m.movementId} of ${m.productId} (no cost, no average)`); continue; }
      if (isOpening(m)) openingLoadsMinor += v; else receivedMinor += v;
    } else if (m.kind === 'returned_to_supplier') {
      const v = atAverage();
      if (v === undefined) { unvaluedPurchases.push(`return to supplier ${m.movementId} of ${m.productId} (no average)`); continue; }
      returnedToSupplierMinor += v;
    } else if (m.kind === 'opening_reversed') {
      openingLoadsMinor -= m.unitCostMinor !== undefined ? valueAtCost(m.quantityMinor, m.uom, { minor: m.unitCostMinor, ...(m.unitCostPer === undefined ? {} : { per: m.unitCostPer }) }) : (atAverage() ?? 0);
    }
  }
  return {
    period, closing,
    closingValueMinor: closing.reduce((n, l) => n + (l.valueMinor ?? 0), 0),
    unvalued: closing.filter((l) => l.valueMinor === null),
    negative: closing.filter((l) => l.onHandMinor < 0),
    purchases: { receivedMinor, returnedToSupplierMinor, purchasesMinor: receivedMinor - returnedToSupplierMinor, unvalued: unvaluedPurchases },
    openingLoadsMinor,
  };
}

/** Valued count differences, write-offs and shortfalls of the month or earlier the books do not hold yet. */
export async function outstandingStockPostingsFor(input: { readonly store: EventStore; readonly now: () => string; readonly calendar?: ShopCalendarOf }, tenantId: string, period: string): Promise<readonly string[]> {
  const monthOf = await shopMonthReader(input, tenantId); // R1b
  const pb = periodBooksAdapter(input);
  const [counts, writeOffs, adjJournals] = await Promise.all([pb.counts(tenantId), pb.writeOffs(tenantId), pb.stockAdjustmentJournals(tenantId)]);
  const posted = new Set(adjJournals.map((j) => j.stockAdjustment.sourceId));
  const out = stockAdjustmentSources(counts, writeOffs)
    .filter((s) => s.valueMinor !== null && monthOf(s.at) <= period && !posted.has(s.sourceId)).map((s) => s.sourceId);
  const sl = stockLossAdapter(input);
  const [losses, lossJournals] = await Promise.all([sl.losses(tenantId), sl.stockLossJournals(tenantId)]);
  const lossPosted = new Set(lossJournals.map((j) => j.stockLoss.sourceId));
  for (const l of losses) if (l.lostValueMinor > 0 && monthOf(l.resolvedAt) <= period && !lossPosted.has(lossSourceId(l))) out.push(lossSourceId(l));
  // OB-66: a damaged write-off HELD on an open count is a write-off of the month not in the books yet — the adjustment waits.
  out.push(...await unappliedHeldWriteOffs(input.store, tenantId, period, await shopClock(input.calendar).calendar(tenantId)));
  return out;
}

export function stockPeriodAdapter(input: { readonly store: EventStore; readonly now: () => string; readonly calendar?: ShopCalendarOf }): StockPeriodDeps {
  const pb = periodBooksAdapter(input);
  return {
    periodStates: pb.periodStates, appendJournal: pb.appendJournal, now: input.now,
    postingMap: pb.postingMap, journals: pb.journals,
    valuation: (tenantId, period) => stockValuationFor(input, tenantId, period),
    outstandingStockPostings: (tenantId, period) => outstandingStockPostingsFor(input, tenantId, period),
    // The months before this one in which the shop's OWN stock moved — each needs its adjustment first (months in order).
    monthsWithStockActivityBefore: async (tenantId, period) => {
      const months = new Set<string>();
      const monthOf = await shopMonthReader(input, tenantId); // R1b
      for (const e of await input.store.readStream(tenantId, STREAM.inventory, { type: 'InventoryMoved' })) {
        const m = e.event.payload as Movement;
        const month = monthOf(m.occurredAt);
        if (month < period && ownershipOf(m) === 'own') months.add(month);
      }
      return [...months].sort();
    },
  };
}

/** The close's stock check (WF-18 · OB-56): said in `notChecked` when the shop holds no stock and the books none. */
export async function stockValueCheckFor(input: { readonly store: EventStore; readonly now: () => string; readonly calendar?: ShopCalendarOf }, tenantId: string, period: string): Promise<{ readonly check: ControlTotalCheck; readonly notChecked?: undefined } | { readonly check: null; readonly notChecked: string }> {
  const pb = periodBooksAdapter(input);
  const [map, journals, valuation] = await Promise.all([pb.postingMap(tenantId), pb.journals(tenantId), stockValuationFor(input, tenantId, period)]);
  const inventory = stockPeriodAccounts(map)?.inventory ?? 'inventory';
  const check = stockValueCheck(period, valuation, journals, inventory);
  if (valuation.closing.length === 0 && check.rightMinor === 0) return { check: null, notChecked: `Stock value: no stock on hand at the end of ${period} and none in the books.` };
  // Nothing on hand has a cost and the books hold none: there is no value to compare — said, never counted as agreement.
  if (valuation.closing.every((l) => l.valueMinor === null) && check.rightMinor === 0) {
    return { check: null, notChecked: `Stock value: ${valuation.closing.length} product line(s) on hand at the end of ${period} have no buying cost, so no stock value can be compared with the books (never valued at zero).` };
  }
  return { check };
}

// ── OB-57: budgets (versioned) and the fixed-asset register ───────────────────────────────────────────────────────

export function budgetAssetAdapter(input: { readonly store: EventStore; readonly now: () => string }): BudgetAssetDeps {
  const pb = periodBooksAdapter(input);
  const budgetsStream = (): string => streamName(STREAM.finance, 'budgets');
  const assetsStream = (): string => streamName(STREAM.finance, 'fixed-assets');
  return {
    periodStates: pb.periodStates, appendJournal: pb.appendJournal, now: input.now,
    journals: pb.journals, accountClasses: pb.accountClasses, postingMap: pb.postingMap,
    budgets: (tenantId) => all<BudgetVersion>(input.store, tenantId, budgetsStream(), 'BudgetVersionSet'),
    recordBudget: async (tenantId, v) => {
      // Keyed on the month and the version NUMBER: two people setting the same version at once — the second is told.
      const res = await input.store.append(tenantId, budgetsStream(), makeEvent({
        id: `budget-${v.period}-v${v.version}-${digest(JSON.stringify(v.lines))}`, type: 'BudgetVersionSet', occurredAt: v.at,
        idempotencyKey: `budget-${tenantId}-${v.period}-v${v.version}`, source: 'api/finance', payload: v,
      }));
      return !res.deduped;
    },
    assetFacts: (tenantId) => all<FixedAssetFact>(input.store, tenantId, assetsStream(), 'FixedAssetFact'),
    recordAssetFact: async (tenantId, f, key) => {
      await input.store.append(tenantId, assetsStream(), makeEvent({
        id: `fixed-asset-${digest(key)}`, type: 'FixedAssetFact', occurredAt: f.at,
        idempotencyKey: `fixed-asset-${tenantId}-${key}`, source: 'api/finance', payload: f,
      }));
    },
  };
}
