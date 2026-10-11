// Round 9 (Batch 3) finance registers — each append-only on its own stream (hard rules #2, #6):
//   • OB-55: the card/UPI payments a store's day close carried forward to head office, their one resolution, conflicts;
//   • OB-56: the month-end stock valuation the stock adjustment and the close read (head office's own stock ledger);
//   • OB-57: monthly budget versions, and the fixed-asset register's facts (added, transferred, disposed);
// Reads fold the streams; nothing here edits a record.

import { createHash } from 'node:crypto';
import { makeEvent } from '../../../packages/contracts/src/event';
import type { EventStore } from '../../../packages/persistence/src/event-store';
import type { DayCloseRecord, CarriedPaymentIn } from '../../pos/src/day-close';
import type { PaymentException, PaymentExceptionResolution, PaymentExceptionConflict, PaymentExceptionDeps, LatePaymentAnswer, RaisedNoAnswer } from '../../finance/src/payment-exceptions';
import { mergeRaisedAndCarried } from '../../finance/src/payment-exceptions';
import { STREAM, streamName, permissionsHeldBy, periodBooksAdapter, stockLossAdapter, storeOfLocationResolver, averageBuyingCosts, unappliedHeldWriteOffs } from './adapters';
import { project, ownershipOf, type Movement } from '../../inventory/src/index';
import { valueAtCost } from '../../../packages/contracts/src/quantity';
import { stockAdjustmentSources } from '../../finance/src/period-books';
import { lossSourceId } from '../../finance/src/stock-losses';
import { stockPeriodAccounts, stockValueCheck, type ClosingStockLine, type StockValuation, type StockPeriodDeps } from '../../finance/src/stock-period';
import type { ControlTotalCheck } from '../../finance/src/index';
import type { BudgetAssetDeps, BudgetVersion, FixedAssetFact } from '../../finance/src/budgets-assets';

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
      await input.store.append(tenantId, paymentExceptionsStream(), makeEvent({
        id: `payment-no-answer-${digest(r.attemptId)}`, type: 'PaymentNoAnswerRaised', occurredAt: r.raisedAt,
        // ONE raised item per attempt: a re-sent relay collapses here even if two raced past the route's check.
        idempotencyKey: `payment-no-answer-raised-${tenantId}-${r.attemptId}`, source: 'api/finance', payload: r,
      }));
    },
    resolutions: (tenantId) => all<PaymentExceptionResolution>(input.store, tenantId, paymentExceptionsStream(), 'PaymentExceptionResolved'),
    conflicts: (tenantId) => all<PaymentExceptionConflict>(input.store, tenantId, paymentExceptionsStream(), 'PaymentExceptionResolutionConflict'),
    recordResolution: async (tenantId, r) => {
      await input.store.append(tenantId, paymentExceptionsStream(), makeEvent({
        id: `payment-exception-resolved-${digest(r.attemptId)}`, type: 'PaymentExceptionResolved', occurredAt: r.resolvedAt,
        // ONE resolution per payment: a second arrival collapses here even if two raced past the route's check.
        idempotencyKey: `payment-exception-resolved-${tenantId}-${r.attemptId}`, source: 'api/finance', payload: r,
      }));
    },
    lateAnswers: async (tenantId) => {
      const seen = new Set<string>();
      return (await all<LatePaymentAnswer>(input.store, tenantId, paymentExceptionsStream(), 'PaymentLateAnswerRecorded')).filter((a) => (seen.has(a.attemptId) ? false : (seen.add(a.attemptId), true)));
    },
    recordLateAnswer: async (tenantId, a) => {
      await input.store.append(tenantId, paymentExceptionsStream(), makeEvent({
        id: `payment-late-answer-${digest(a.attemptId)}`, type: 'PaymentLateAnswerRecorded', occurredAt: a.answeredAt,
        idempotencyKey: `payment-late-answer-${tenantId}-${a.attemptId}`, source: 'api/finance', payload: a,
      }));
    },
    permissionsOf: (tenantId, userId) => permissionsHeldBy(input.store, tenantId, userId),
    recordConflict: async (tenantId, c) => {
      const d = digest(`${c.attemptId}|${JSON.stringify(c.offered)}`);
      await input.store.append(tenantId, paymentExceptionsStream(), makeEvent({
        id: `payment-exception-conflict-${d}`, type: 'PaymentExceptionResolutionConflict', occurredAt: c.at,
        idempotencyKey: `payment-exception-conflict-${tenantId}-${d}`, source: 'api/finance', payload: c,
      }));
    },
  };
}

// ── OB-56: the month-end stock adjustment — head office's own stock ledger, valued at the average buying cost ─────

/** Every product's on-hand at the month end per store, at the OB-39 average as it stood then; the month's purchases. */
export async function stockValuationFor(input: { readonly store: EventStore; readonly now: () => string }, tenantId: string, period: string): Promise<StockValuation> {
  const [{ storeOf }, avg] = await Promise.all([storeOfLocationResolver(input, tenantId), averageBuyingCosts(input, tenantId, { throughPeriod: period })]);
  const movements = (await input.store.readStream(tenantId, STREAM.inventory, { type: 'InventoryMoved' }))
    .map((e) => e.event.payload as Movement)
    // The shop's own stock only (M27-FR-02): concession, consignment and customer property are not its inventory.
    .filter((m) => ownershipOf(m) === 'own' && m.occurredAt.slice(0, 7) <= period);
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
  const closing: ClosingStockLine[] = [...onHand.values()].filter((x) => x.qty !== 0)
    .sort((a, b) => (a.productId === b.productId ? a.storeId.localeCompare(b.storeId) : a.productId.localeCompare(b.productId)))
    .map((x) => {
      const uom = uomOf.get(x.productId) ?? 'ea';
      const unit = avg.costOf(x.productId, x.storeId);
      return { productId: x.productId, storeId: x.storeId, onHandMinor: x.qty, uom, unitCostMinor: unit ?? null, valueMinor: unit === undefined ? null : valueAtCost(x.qty, uom, { minor: unit }) };
    });
  // The month's purchases: receipts into own stock at their own cost (no cost: the average), less goods sent back to a
  // supplier at the average. Opening-load receipts and their reversals are not purchases.
  let receivedMinor = 0;
  let returnedToSupplierMinor = 0;
  let openingLoadsMinor = 0;
  const unvaluedPurchases: string[] = [];
  const isOpening = (m: Movement): boolean => m.movementId.startsWith('opening-');
  for (const m of movements.filter((x) => x.occurredAt.slice(0, 7) === period)) {
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
export async function outstandingStockPostingsFor(input: { readonly store: EventStore; readonly now: () => string }, tenantId: string, period: string): Promise<readonly string[]> {
  const pb = periodBooksAdapter(input);
  const [counts, writeOffs, adjJournals] = await Promise.all([pb.counts(tenantId), pb.writeOffs(tenantId), pb.stockAdjustmentJournals(tenantId)]);
  const posted = new Set(adjJournals.map((j) => j.stockAdjustment.sourceId));
  const out = stockAdjustmentSources(counts, writeOffs)
    .filter((s) => s.valueMinor !== null && s.at.slice(0, 7) <= period && !posted.has(s.sourceId)).map((s) => s.sourceId);
  const sl = stockLossAdapter(input);
  const [losses, lossJournals] = await Promise.all([sl.losses(tenantId), sl.stockLossJournals(tenantId)]);
  const lossPosted = new Set(lossJournals.map((j) => j.stockLoss.sourceId));
  for (const l of losses) if (l.lostValueMinor > 0 && l.resolvedAt.slice(0, 7) <= period && !lossPosted.has(lossSourceId(l))) out.push(lossSourceId(l));
  // OB-66: a damaged write-off HELD on an open count is a write-off of the month not in the books yet — the adjustment waits.
  out.push(...await unappliedHeldWriteOffs(input.store, tenantId, period));
  return out;
}

export function stockPeriodAdapter(input: { readonly store: EventStore; readonly now: () => string }): StockPeriodDeps {
  const pb = periodBooksAdapter(input);
  return {
    periodStates: pb.periodStates, appendJournal: pb.appendJournal, now: input.now,
    postingMap: pb.postingMap, journals: pb.journals,
    valuation: (tenantId, period) => stockValuationFor(input, tenantId, period),
    outstandingStockPostings: (tenantId, period) => outstandingStockPostingsFor(input, tenantId, period),
  };
}

/** The close's stock check (WF-18 · OB-56): said in `notChecked` when the shop holds no stock and the books none. */
export async function stockValueCheckFor(input: { readonly store: EventStore; readonly now: () => string }, tenantId: string, period: string): Promise<{ readonly check: ControlTotalCheck; readonly notChecked?: undefined } | { readonly check: null; readonly notChecked: string }> {
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
