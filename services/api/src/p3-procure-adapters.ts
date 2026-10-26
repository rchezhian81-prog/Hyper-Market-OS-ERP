// OB-288 package P3 — procure-to-pay completion. Head office's wiring for M06-FR-02 (blanket POs, separation of duties
// across one purchase, the value-limit seam), M06-FR-03 (rebate basis folded from the registers, rebate receipts as
// journals), M06-FR-04 (the open-commitment report), M07-FR-01 (the durable dock diary, receiving against a stored ASN),
// M07-FR-04 (landed cost into stock value), WF-03 (a proposal becomes a requisition by a buyer's own act) and WF-05 (the
// Tally voucher file of the payables journals).
//
// Every register here is append-only on its own stream (hard rules #2, #6); reads fold the streams. Nothing here edits or
// deletes a record, and nothing here commits money, stock or a price by itself — each write is a person's act through a
// route, or a compensating event a person's match caused (P-05). One entry point, `p3ProcureRoutes`, is registered from
// main.ts; the hooks below are spread into the existing routes' deps there.

import type { EventStore } from '../../../packages/persistence/src/event-store';
import { InMemoryEventStore } from '../../../packages/persistence/src/event-store';
import type { Route } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { makeEvent } from '../../../packages/contracts/src/event';
import {
  STREAM, streamName, foldPurchaseOrders, purchaseOrdersAdapter, orgStructureAdapter, goodsReceiptAdapter, liveSupplierInvoices,
  financeAdapter, rebatesAdapter, stockCostAdjustments, STOCK_COST_ADJUSTMENTS_STREAM, rfqAdapter, replenishmentFactsAdapter, assortmentAdapter,
} from './adapters';
import { masterLifecycleOf } from './r3-ops-adapters';
import { branchOfLocationIn, type LocationBranches } from '../../inventory/src/location-scope';
import {
  judgeCallOff, ordersAPaymentPays, type BlanketAgreement, type BlanketRelease, type PurchaseActors,
} from '../../../packages/purchasing/src/index';
import type { SegregationPort } from '../../purchase/src/segregation-of-duties';
import type { StoredRequisition } from '../../purchase/src/rfq';
import type { StoredMatch } from '../../purchase/src/index';
import type { SupplierPayment } from '../../purchase/src/supplier-account';
import type { SupplierOpeningBalance, SupplierOpeningReversal } from '../../purchase/src/supplier-openings';
import type { Asn } from '../../../packages/receiving/src/asn';
import { apportionLandedCharges, landedCostDeltas, type LandedCostTarget } from '../../../packages/stock/src/landed-cost';
import { chargesTotal, matchLinesFrom, type PurchaseDeps } from '../../purchase/src/index';
import { lineValueMinor } from '../../../packages/purchasing/src/three-way-match';
import type { StockCostAdjustment } from '../../inventory/src/landed-cost';
import { replenishmentRoutes } from '../../inventory/src/replenishment';
import { requisitionSourceRoutes, type RequisitionSourceDeps, type ProposedLine } from '../../purchase/src/requisition-sources';
import { dockDiaryRoutes, type DockDiaryDeps, type DiaryBooking, dockGuardKey } from '../../inventory/src/dock-diary';
import type { DockSlot } from '../../../packages/receiving/src/asn';
import type { BlanketReleaseHooks, StoredPurchaseOrder, DeliveryAsn } from '../../purchase/src/purchase-orders';
import { blanketOrderRoutes, type BlanketOrderDeps } from '../../purchase/src/blanket-orders';
import { commitmentReportRoutes, type CommitmentReportDeps, type ReceiptPosting } from '../../purchase/src/commitment-report';
import { tallyExportRoutes, type TallyExportDeps, type TallyLedgerNames, type ExportableJournal } from '../../finance/src/tally-export';
import type { JournalEntry } from '../../finance/src/index';
import { rebateReceiptRoutes, type RebateReceiptDeps, type RebateReceiptJournal } from '../../finance/src/rebate-receipts';
import type { StoredPostingMap } from '../../finance/src/day-book';
import type { RebateDeps } from '../../purchase/src/rebates';
import { DEFAULT_SHOP_CALENDAR, shopClock, shopDateIn, type ShopCalendarOf } from '../../../packages/calendar/src/shop-clock';

type Recorder = (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
interface Base { readonly store: EventStore; readonly now: () => string; readonly recordAudit?: Recorder }

/** Every payload of one type in a stream, oldest first (the type goes to the store, not to a filter afterwards). */
async function payloads<T>(store: EventStore, tenantId: string, stream: string, type: string): Promise<readonly T[]> {
  return (await store.readStream(tenantId, stream, { type })).map((e) => e.event.payload as T);
}

const locationBranches = (input: Base): LocationBranches =>
  async (tenantId) => branchOfLocationIn(await orgStructureAdapter({ store: input.store, now: input.now }).nodes(tenantId));

// ── M06-FR-02 — blanket agreements and their call-off releases ──────────────────────────────────────────────────────

/** The purchase-order register's stream (the same one `purchaseOrdersAdapter` writes). */
const PURCHASE_ORDERS = streamName(STREAM.purchase, 'orders');
const BLANKET_AGREEMENTS = streamName(STREAM.purchase, 'blanket-agreements');
/** One write guard per agreement: every release proposed or issued against it moves it (two at once: one lands). */
export const blanketGuardKey = (agreementId: string): string => `blanket-agreement:${agreementId}`;

/** Each agreement at its current state: proposed once (the first proposal of an id stands), approved once. */
export async function foldBlanketAgreements(store: EventStore, tenantId: string): Promise<Map<string, BlanketAgreement>> {
  const byId = new Map<string, BlanketAgreement>();
  for (const e of await store.readStream(tenantId, BLANKET_AGREEMENTS)) {
    if (e.event.type === 'BlanketAgreementProposed') {
      const a = e.event.payload as unknown as BlanketAgreement;
      if (!byId.has(a.agreementId)) byId.set(a.agreementId, a);
    } else if (e.event.type === 'BlanketAgreementApproved') {
      const p = e.event.payload as { agreementId: string; approvedBy: string; approvedAt: string };
      const cur = byId.get(p.agreementId);
      if (cur !== undefined && cur.status === 'proposed') byId.set(p.agreementId, { ...cur, status: 'approved', approvedBy: p.approvedBy, approvedAt: p.approvedAt });
    }
  }
  return byId;
}

const asRelease = (po: StoredPurchaseOrder): BlanketRelease & { readonly number: string; readonly requisitionedBy: string; readonly approvedBy: string | null } => ({
  poId: po.poId, number: po.number, status: po.status, lines: po.lines, cancelledByProduct: po.cancelledByProduct,
  requisitionedBy: po.requisitionedBy, approvedBy: po.approvedBy,
});

async function releasesOf(store: EventStore, tenantId: string, agreementId: string) {
  return [...(await foldPurchaseOrders(store, tenantId)).values()].filter((p) => p.blanketAgreementId === agreementId).map(asRelease);
}

export function blanketAgreementsAdapter(input: Base): BlanketOrderDeps {
  const pos = purchaseOrdersAdapter(input);
  return {
    now: input.now,
    ...(input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit }),
    ...(pos.supplierStatus === undefined ? {} : { supplierStatus: pos.supplierStatus }),
    ...(pos.orgLocation === undefined ? {} : { orgLocation: pos.orgLocation }),
    ...(pos.productUom === undefined ? {} : { productUom: pos.productUom }),
    supplierBlocked: pos.supplierBlocked,
    locationBranches: locationBranches(input),
    masterLifecycle: masterLifecycleOf(input),
    agreement: async (tenantId, agreementId) => (await foldBlanketAgreements(input.store, tenantId)).get(agreementId),
    agreements: async (tenantId) => [...(await foldBlanketAgreements(input.store, tenantId)).values()],
    releases: (tenantId, agreementId) => releasesOf(input.store, tenantId, agreementId),
    recordProposed: async (tenantId, a) => {
      await input.store.append(tenantId, BLANKET_AGREEMENTS, makeEvent({
        id: `blanket-${a.agreementId}-proposed`, type: 'BlanketAgreementProposed', occurredAt: a.proposedAt,
        idempotencyKey: `blanket-${tenantId}-${a.agreementId}-proposed`, source: 'api/purchase', payload: a as unknown as Record<string, unknown>,
      }));
    },
    recordApproved: async (tenantId, agreementId, approvedBy, approvedAt, reason) => {
      await input.store.append(tenantId, BLANKET_AGREEMENTS, makeEvent({
        id: `blanket-${agreementId}-approved`, type: 'BlanketAgreementApproved', occurredAt: approvedAt,
        // Once per agreement: a second approval collapses (the route already answers `alreadyApproved`).
        idempotencyKey: `blanket-${tenantId}-${agreementId}-approved`, source: 'api/purchase', payload: { agreementId, approvedBy, approvedAt, reason },
      }));
    },
  };
}

const REFUSAL_STATUS: Readonly<Record<string, number>> = {
  agreement_not_approved: 409, outside_validity: 409, ceiling_exceeded: 409, quantity_ceiling_exceeded: 409,
  product_not_on_agreement: 422, no_lines: 400, bad_quantity: 400,
};

/** The call-off side the purchase-order routes run: judge (guard read first), propose and issue under the guard. */
export function blanketReleaseHooks(input: Base): BlanketReleaseHooks {
  return {
    judge: async (tenantId, j) => {
      const key = blanketGuardKey(j.agreementId);
      // The guard first, then the agreement and the releases it protects — anything landing in between refuses the write.
      const expectedVersion = await input.store.guardVersion(tenantId, key);
      const agreement = (await foldBlanketAgreements(input.store, tenantId)).get(j.agreementId);
      if (agreement === undefined) return { ok: false, status: 404, code: 'blanket_agreement_unknown', detail: `There is no blanket agreement ${j.agreementId} on head office's register` };
      if (j.supplierId !== undefined && j.supplierId !== agreement.supplierId) {
        return { ok: false, status: 422, code: 'supplier_not_the_agreements', detail: `Blanket agreement ${j.agreementId} is with ${agreement.supplierId}, not ${j.supplierId}` };
      }
      const others = (await releasesOf(input.store, tenantId, j.agreementId)).filter((r) => r.poId !== j.poId);
      const judged = judgeCallOff({ agreement, others, onDate: j.onDate, lines: j.lines });
      if (!judged.ok) return { ok: false, status: REFUSAL_STATUS[judged.refusal] ?? 422, code: judged.refusal, detail: judged.detail };
      return {
        ok: true, supplierId: agreement.supplierId, currency: agreement.currency, lines: judged.lines,
        ...(agreement.deliverToLocationId === undefined ? {} : { deliverToLocationId: agreement.deliverToLocationId }),
        guard: { key, expectedVersion },
      };
    },
    propose: async (tenantId, po, guard) => {
      // The same event the ordinary proposal writes (same id and key), under the agreement's guard.
      await input.store.appendBatch(tenantId, [{ stream: PURCHASE_ORDERS, event: makeEvent({
        id: `po-${po.poId}-proposed`, type: 'PurchaseOrderProposed', occurredAt: input.now(),
        idempotencyKey: `po-${tenantId}-${po.poId}-proposed`, source: 'api/purchase', payload: po as unknown as Record<string, unknown>,
      }) }], { guard });
    },
    issue: async (tenantId, poId, approvedBy, issuedAt, reason, guard, budgetGuard) => {
      await input.store.appendBatch(tenantId, [{ stream: PURCHASE_ORDERS, event: makeEvent({
        id: `po-${poId}-issued`, type: 'PurchaseOrderIssued', occurredAt: issuedAt,
        idempotencyKey: `po-${tenantId}-${poId}-issued`, source: 'api/purchase', payload: { poId, approvedBy, issuedAt, reason },
      }) }], { guard, ...(budgetGuard === undefined ? {} : { alsoGuards: [budgetGuard] }) });
    },
  };
}

// ── M06-FR-02 · §28 — who did each step of one purchase ──────────────────────────────────────────────────────────────

const REQUISITIONS = streamName(STREAM.purchase, 'requisitions');
const SUPPLIER_PAYMENTS = streamName(STREAM.purchase, 'supplier-payments');
const SUPPLIER_OPENINGS = streamName(STREAM.purchase, 'supplier-openings');

/** One supplier's bills (matched, oldest first), payments (in the order recorded) and opening balance still standing. */
async function supplierLedgerFacts(store: EventStore, tenantId: string, supplierId: string) {
  const latest = new Map<string, StoredMatch>();
  for (const m of await payloads<StoredMatch>(store, tenantId, STREAM.purchase, 'InvoiceMatched')) latest.set(m.invoiceId, m);
  const bills = (await liveSupplierInvoices(store, tenantId))
    .filter((i) => i.supplierId === supplierId && latest.has(i.invoiceId))
    .map((i) => { const m = latest.get(i.invoiceId)!; return { invoiceId: i.invoiceId, poId: m.poId ?? i.poId, payableMinor: m.payableMinor, at: i.capturedAt }; });
  const payments = (await payloads<SupplierPayment>(store, tenantId, SUPPLIER_PAYMENTS, 'SupplierPaymentRecorded'))
    .filter((p) => p.supplierId === supplierId)
    .sort((a, b) => (a.recordedAt < b.recordedAt ? -1 : a.recordedAt > b.recordedAt ? 1 : 0));
  const reversed = new Set((await payloads<SupplierOpeningReversal>(store, tenantId, SUPPLIER_OPENINGS, 'SupplierOpeningBalanceReversed')).map((r) => r.openingId));
  const openingMinor = (await payloads<SupplierOpeningBalance>(store, tenantId, SUPPLIER_OPENINGS, 'SupplierOpeningBalanceRecorded'))
    .filter((o) => o.supplierId === supplierId && !reversed.has(o.openingId)).reduce((s, o) => s + o.amountMinor, 0);
  return { bills, payments, openingMinor };
}

/**
 * Who did each of the four steps on one purchase order — from head office's own registers only: the order's buyer and every
 * raiser of the requisition it came from; every receiver (goods receipts, the handheld's scanners, receipt postings); every
 * person who matched a bill against it; and every person who recorded or approved a payment that paid one of its bills
 * (a payment pays the bills still open when it was recorded, oldest first — `ordersAPaymentPays`).
 */
export async function purchaseActorsOf(input: Base, tenantId: string, poId: string): Promise<PurchaseActors> {
  const po = (await foldPurchaseOrders(input.store, tenantId)).get(poId);
  const requisition = new Set<string>();
  const receipt = new Set<string>();
  const match = new Set<string>();
  const payment = new Set<string>();
  if (po !== undefined) {
    requisition.add(po.requisitionedBy);
    if (po.requisitionId !== undefined) {
      for (const r of await payloads<StoredRequisition>(input.store, tenantId, REQUISITIONS, 'RequisitionRaised')) {
        if (r.requisitionId === po.requisitionId && r.raisedBy !== undefined) requisition.add(r.raisedBy);
      }
    }
  }
  for (const g of await goodsReceiptAdapter(input).all(tenantId)) {
    if (g.poId !== poId) continue;
    receipt.add(g.receivedBy);
    for (const u of g.assembledFrom?.scannedBy ?? []) receipt.add(u);
  }
  for (const e of await input.store.readStream(tenantId, PURCHASE_ORDERS, { type: 'PurchaseOrderReceiptPosted' })) {
    const p = e.event.payload as { poId: string; by?: string };
    if (p.poId === poId && typeof p.by === 'string') receipt.add(p.by);
  }
  for (const m of await payloads<StoredMatch>(input.store, tenantId, STREAM.purchase, 'InvoiceMatched')) if (m.poId === poId) match.add(m.matchedBy);
  if (po !== undefined) {
    const facts = await supplierLedgerFacts(input.store, tenantId, po.supplierId);
    let paidBefore = 0;
    for (const pay of facts.payments) {
      const open = ordersAPaymentPays({ openingMinor: facts.openingMinor, bills: facts.bills.filter((b) => b.at <= pay.recordedAt), paidBeforeMinor: paidBefore });
      if (open.includes(poId)) { payment.add(pay.recordedBy); payment.add(pay.approvedBy); }
      paidBefore += pay.amountMinor;
    }
  }
  return { poId, requisition: [...requisition], receipt: [...receipt], match: [...match], payment: [...payment] };
}

export function segregationAdapter(input: Base): SegregationPort {
  return {
    actorsOf: (tenantId, poId) => purchaseActorsOf(input, tenantId, poId),
    ordersPaidBy: async (tenantId, supplierId) => {
      const facts = await supplierLedgerFacts(input.store, tenantId, supplierId);
      const paid = facts.payments.reduce((s, p) => s + p.amountMinor, 0);
      const orders = ordersAPaymentPays({ openingMinor: facts.openingMinor, bills: facts.bills, paidBeforeMinor: paid });
      return Promise.all(orders.map((poId) => purchaseActorsOf(input, tenantId, poId)));
    },
  };
}

// ── M06-FR-04 · OB-289 / OB-290 — buying scope, the local limit seam, the open-commitment report ─────────────────────

export function commitmentReportAdapter(input: Base): CommitmentReportDeps {
  return {
    now: input.now,
    orders: async (tenantId) => [...(await foldPurchaseOrders(input.store, tenantId)).values()],
    receiptPostings: async (tenantId) => (await input.store.readStream(tenantId, PURCHASE_ORDERS, { type: 'PurchaseOrderReceiptPosted' }))
      .map((e) => e.event.payload as unknown as ReceiptPosting),
    locationBranches: locationBranches(input),
  };
}

// ── M06-FR-03 — rebate basis from the matched invoices; rebate receipts as journals ─────────────────────────────────

async function rebateJournals(store: EventStore, tenantId: string): Promise<readonly RebateReceiptJournal[]> {
  return (await payloads<JournalEntry & Partial<RebateReceiptJournal>>(store, tenantId, STREAM.finance, 'JournalPosted'))
    .filter((j): j is RebateReceiptJournal => j.rebateReceipt !== undefined);
}

/**
 * The basis of a purchase-value rebate for a period: the supplier's invoices dated in it (the supplier's own invoice date
 * when captured, else the capture day) whose LATEST match lets them be paid — the taxable value paid on goods, before GST
 * and before any landed charges — with the bills it came from.
 */
export async function rebateBasisFor(store: EventStore, tenantId: string, supplierId: string, from: string, to: string, timeZone: string = DEFAULT_SHOP_CALENDAR.timeZone) {
  const latest = new Map<string, StoredMatch>();
  for (const m of await payloads<StoredMatch>(store, tenantId, STREAM.purchase, 'InvoiceMatched')) latest.set(m.invoiceId, m);
  let amountMinor = 0;
  const invoices: string[] = [];
  for (const i of await liveSupplierInvoices(store, tenantId)) {
    if (i.supplierId !== supplierId) continue;
    const m = latest.get(i.invoiceId);
    if (m === undefined || m.blocked) continue;
    const day = i.supplierInvoiceDate ?? shopDateIn(i.capturedAt, timeZone); // R1b: the shop's date, never UTC
    if (day < from || day > to) continue;
    const charges = (m as StoredMatch & { landedCharges?: { totalMinor: number } }).landedCharges?.totalMinor ?? 0;
    amountMinor += (m.tax?.taxablePayableMinor ?? m.payableMinor) - (m.tax === undefined ? charges : 0);
    invoices.push(i.invoiceId);
  }
  return { amountMinor, invoices };
}

/**
 * OB-334 (owner, 23 Oct 2026): the basis of a VOLUME rebate — the value RECEIVED at ORDER cost, from the supplier's MATCHED
 * bills dated in the period (the same bills, dates and "latest match lets it be paid" rule as the purchase-value basis).
 * For each line of such a bill: the quantity received against its order that this bill accounts for (after what earlier
 * bills on the same order claimed — the match's own SP-7c figure), never more than the bill charges or the order asked
 * for, valued at the ORDER's unit price (before GST, before landed charges; OB-31 / OB-46 units and case prices exactly as
 * the match values them). A matched bill whose order head office cannot read is listed as not valued — never a nought.
 */
export async function volumeRebateBasisFor(store: EventStore, tenantId: string, supplierId: string, from: string, to: string, timeZone: string = DEFAULT_SHOP_CALENDAR.timeZone) {
  const latest = new Map<string, StoredMatch>();
  for (const m of await payloads<StoredMatch>(store, tenantId, STREAM.purchase, 'InvoiceMatched')) latest.set(m.invoiceId, m);
  const orders = await foldPurchaseOrders(store, tenantId);
  let amountMinor = 0;
  const invoices: string[] = [];
  const notValued: { invoiceId: string; why: string }[] = [];
  for (const i of await liveSupplierInvoices(store, tenantId)) {
    if (i.supplierId !== supplierId) continue;
    const m = latest.get(i.invoiceId);
    if (m === undefined || m.blocked) continue;
    const day = i.supplierInvoiceDate ?? shopDateIn(i.capturedAt, timeZone); // R1b: the shop's date, never UTC
    if (day < from || day > to) continue;
    const order = m.poId === null ? undefined : orders.get(m.poId);
    if (order === undefined || order.status !== 'issued') {
      notValued.push({ invoiceId: i.invoiceId, why: m.poId === null ? 'the bill names no purchase order, so there is no order cost' : `purchase order ${m.poId} is not an issued order head office holds` });
      continue;
    }
    for (const l of matchLinesFrom(order, i, m.sources.invoicedBefore ?? {})) {
      const qty = Math.min(l.receivedQty, l.invoicedQty, l.orderedQty);
      if (qty <= 0) continue;
      amountMinor += lineValueMinor(qty, l.orderedUnitMinor, l.minorPerUnit ?? 1, l.orderedPer ?? 1);
    }
    invoices.push(i.invoiceId);
  }
  return { amountMinor, invoices, notValued };
}

/** The hooks the rebate routes take (spread into their deps in main.ts): the folded bases and the ledger's "received". */
export function p3RebateHooks(input: { readonly store: EventStore; readonly now: () => string; readonly calendar?: ShopCalendarOf }): Pick<RebateDeps, 'basisFor' | 'volumeBasisFor' | 'receivedFor'> {
  const zoneOf = async (t: string): Promise<string> => (await shopClock(input.calendar).calendar(t)).timeZone;
  return {
    basisFor: async (tenantId, supplierId, from, to) => rebateBasisFor(input.store, tenantId, supplierId, from, to, await zoneOf(tenantId)),
    volumeBasisFor: async (tenantId, supplierId, from, to) => volumeRebateBasisFor(input.store, tenantId, supplierId, from, to, await zoneOf(tenantId)),
    receivedFor: async (tenantId, schemeId) => (await rebateJournals(input.store, tenantId)).filter((j) => j.rebateReceipt.schemeId === schemeId).reduce((s, j) => s + j.rebateReceipt.amountMinor, 0),
  };
}

export function rebateReceiptAdapter(input: Base): RebateReceiptDeps {
  const fin = financeAdapter(input);
  const rebates = rebatesAdapter(input);
  return {
    periodStates: fin.periodStates, nextOpenPeriod: fin.nextOpenPeriod, appendJournal: fin.appendJournal, now: input.now,
    postingMap: async (tenantId) => (await payloads<StoredPostingMap>(input.store, tenantId, STREAM.finance, 'PostingMapDefined')).at(-1),
    schemes: (tenantId) => rebates.schemes(tenantId),
    accruedFor: async (tenantId, schemeId) => (await rebates.accruals(tenantId, schemeId)).reduce((s, a) => s + a.accrued.minor, 0),
    rebateJournals: (tenantId) => rebateJournals(input.store, tenantId),
  };
}

// ── WF-05 — the payables journals as a Tally import file ─────────────────────────────────────────────────────────────

const TALLY_LEDGER_NAMES = streamName(STREAM.finance, 'tally-ledger-names');

export function tallyExportAdapter(input: Base): TallyExportDeps {
  return {
    now: input.now,
    ledgerNames: async (tenantId) => (await payloads<TallyLedgerNames>(input.store, tenantId, TALLY_LEDGER_NAMES, 'TallyLedgerNamesSet')).at(-1),
    recordLedgerNames: async (tenantId, names) => {
      await input.store.append(tenantId, TALLY_LEDGER_NAMES, makeEvent({
        id: `tally-ledger-names-v${names.version}`, type: 'TallyLedgerNamesSet', occurredAt: names.setAt,
        idempotencyKey: `tally-ledger-names-${tenantId}-v${names.version}`, source: 'api/finance', payload: names as unknown as Record<string, unknown>,
      }));
    },
    // The payables vouchers on the ledger — the same `JournalPosted` events the payables reconciliation reads.
    payablesJournals: async (tenantId) => (await payloads<JournalEntry & Partial<ExportableJournal>>(input.store, tenantId, STREAM.finance, 'JournalPosted'))
      .filter((j): j is ExportableJournal => 'payables' in j && j.payables !== undefined),
  };
}

// ── the entry point ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Every P3 route on head office's surface. With no store, an in-memory one (the bare surface the guardrails build). */
export function p3ProcureRoutes(input: { readonly store: EventStore | undefined; readonly now: () => string; readonly recordAudit?: Recorder; readonly calendar?: ShopCalendarOf }): readonly Route[] {
  const cal = input.calendar === undefined ? {} : { calendar: input.calendar }; // R1b · R1c: the shop's clock
  const store = input.store ?? new InMemoryEventStore();
  const base: Base = { store, now: input.now, ...(input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit }) };
  return [
    ...blanketOrderRoutes({ ...blanketAgreementsAdapter(base), ...cal }),
    ...commitmentReportRoutes(commitmentReportAdapter(base)),
    ...tallyExportRoutes(tallyExportAdapter(base)),
    ...rebateReceiptRoutes({ ...rebateReceiptAdapter(base), ...cal }),
    ...dockDiaryRoutes(dockDiaryAdapter(base)),
    ...requisitionSourceRoutes(requisitionSourceAdapter(base)),
  ];
}

/** The hooks the existing purchase-order routes take (spread into their deps in main.ts). */
export function p3PurchaseOrderHooks(input: { readonly store: EventStore; readonly now: () => string }): Pick<import('../../purchase/src/purchase-orders').PurchaseOrderDeps, 'blanket' | 'segregation' | 'requisitionExists' | 'asnOf'> {
  return {
    asnOf: (tenantId, poId) => deliveryAsnOf(input.store, tenantId, poId),
    blanket: blanketReleaseHooks(input),
    segregation: segregationAdapter(input),
    requisitionExists: async (tenantId, requisitionId) => (await payloads<StoredRequisition>(input.store, tenantId, REQUISITIONS, 'RequisitionRaised')).some((r) => r.requisitionId === requisitionId),
  };
}

/** The separation-of-duties port the receipt, match and payment routes take (spread into their deps in main.ts). */
export function p3Segregation(input: { readonly store: EventStore; readonly now: () => string }): { readonly segregation: SegregationPort } {
  return { segregation: segregationAdapter(input) };
}

// ── WF-03 — a proposal or an A02 draft becomes a requisition by a buyer's own act ──────────────────────────────────

export function requisitionSourceAdapter(input: Base): RequisitionSourceDeps {
  const rfq = rfqAdapter(input);
  const branches = locationBranches(input);
  // The SAME replenishment route the proposal screen reads, on head office's own stock, orders, sales, range and lifecycle.
  const propose = replenishmentRoutes({
    now: input.now, ...replenishmentFactsAdapter({ store: input.store, now: input.now, branchOf: branches }),
    rangeOf: assortmentAdapter(input).entries, locationBranches: branches, masterLifecycle: masterLifecycleOf(input),
  }).find((r) => r.method === 'POST' && r.path === '/v1/replenishment/propose')!;
  return {
    now: input.now,
    requisition: rfq.requisition,
    recordRequisition: rfq.recordRequisition,
    proposalFor: async (ctx, storeId, items) => {
      const res = await propose.handler({ ...ctx, body: { items }, query: { storeId } });
      return res.body as { proposals: readonly ProposedLine[]; asAt: string };
    },
    a02Draft: async (tenantId, proposalId) => {
      const p = (await payloads<{ proposalId: string; agent: string; evidence: readonly { reference: string }[] }>(input.store, tenantId, STREAM.ai, 'AiProposalRaised'))
        .find((x) => x.proposalId === proposalId && x.agent === 'A02');
      return p === undefined ? undefined : { proposalId: p.proposalId, references: p.evidence.map((e) => e.reference) };
    },
  };
}

// ── M07-FR-01 — the durable dock diary ───────────────────────────────────────────────────────────────────────────────

const DOCK_DIARY = streamName(STREAM.inventory, 'dock-diary');

/** Each booking at its latest status, every status change kept in its history. */
export async function foldDockDiary(store: EventStore, tenantId: string): Promise<readonly DiaryBooking[]> {
  const byId = new Map<string, DiaryBooking>();
  for (const e of await store.readStream(tenantId, DOCK_DIARY)) {
    if (e.event.type === 'DockSlotBooked') {
      const b = e.event.payload as unknown as DiaryBooking;
      if (!byId.has(b.slotId)) byId.set(b.slotId, b);
    } else if (e.event.type === 'DockSlotStatusSet') {
      const p = e.event.payload as { slotId: string; status: DockSlot['status']; by: string; at: string; reason?: string };
      const cur = byId.get(p.slotId);
      if (cur !== undefined) byId.set(p.slotId, { ...cur, status: p.status, history: [...cur.history, { status: p.status, by: p.by, at: p.at, ...(p.reason === undefined ? {} : { reason: p.reason }) }] });
    }
  }
  return [...byId.values()];
}

export function dockDiaryAdapter(input: Base): DockDiaryDeps {
  return {
    now: input.now,
    ...(input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit }),
    locationBranches: locationBranches(input),
    bookings: (tenantId) => foldDockDiary(input.store, tenantId),
    doorVersion: (tenantId, storeId, dockId) => input.store.guardVersion(tenantId, dockGuardKey(storeId, dockId)),
    recordBooking: async (tenantId, booking, guard) => {
      await input.store.appendBatch(tenantId, [{ stream: DOCK_DIARY, event: makeEvent({
        id: `dock-${booking.slotId}-booked`, type: 'DockSlotBooked', occurredAt: booking.bookedAt,
        idempotencyKey: `dock-${tenantId}-${booking.slotId}-booked`, source: 'api/inventory', payload: booking as unknown as Record<string, unknown>,
      }) }], { guard });
    },
    recordStatus: async (tenantId, slotId, status, by, at, reason) => {
      await input.store.append(tenantId, DOCK_DIARY, makeEvent({
        id: `dock-${slotId}-${status}`, type: 'DockSlotStatusSet', occurredAt: at,
        // Once per status: a slot is arrived once, completed once — a re-send collapses.
        idempotencyKey: `dock-${tenantId}-${slotId}-${status}`, source: 'api/inventory', payload: { slotId, status, by, at, ...(reason === undefined ? {} : { reason }) },
      }));
    },
  };
}

// ── M07-FR-01 — receiving against the advance ship notice on file ────────────────────────────────────────────────────

const ASN_REGISTER = streamName(STREAM.purchase, 'asns');

/**
 * The advance ship notice a buyer accepted from the supplier portal for this order: the one the delivery named (only if it
 * is for THIS order), else the latest accepted for the order; undefined when there is none.
 */
export async function asnForOrder(store: EventStore, tenantId: string, poId: string, asnId?: string): Promise<Asn | undefined> {
  const forOrder = (await payloads<Asn>(store, tenantId, ASN_REGISTER, 'AsnAccepted')).filter((a) => a.poId === poId);
  if (asnId !== undefined) {
    const named = forOrder.filter((a) => a.asnId === asnId).at(-1);
    if (named !== undefined) return named;
  }
  return forOrder.at(-1);
}

/** The ASN as the receiving phone carries it (the box caches it with the open delivery). */
export async function deliveryAsnOf(store: EventStore, tenantId: string, poId: string): Promise<DeliveryAsn | undefined> {
  const a = await asnForOrder(store, tenantId, poId);
  return a === undefined ? undefined : { asnId: a.asnId, expectedAt: a.expectedAt, lines: a.lines.map((l) => ({ productId: l.productId, quantityMinor: l.quantityMinor, uom: l.uom })) };
}

/** The checks every goods receipt takes (spread into the GRN routes' deps in main.ts): §28 and the ASN comparison. */
export function p3ReceiptHooks(input: { readonly store: EventStore; readonly now: () => string }) {
  return {
    segregation: segregationAdapter(input),
    asnFor: (tenantId: string, poId: string, asnId?: string) => asnForOrder(input.store, tenantId, poId, asnId),
  };
}

// ── M07-FR-04 — a matched bill's landed charges into stock value ────────────────────────────────────────────────────

/**
 * Post the landed-cost apportionment of a matched bill: when the bill may be paid against an issued order, its charges are
 * apportioned (to the paisa) across the products paid for by value, then across the places each was received at by
 * quantity; only the DIFFERENCE from what this bill already posted is appended (one atomic batch). A blocked bill, or one
 * with no order, posts back whatever it had posted. Returns what was posted and what now stands.
 */
export async function postLandedCostOf(input: Base, tenantId: string, a: Parameters<NonNullable<PurchaseDeps['postLandedCost']>>[1]) {
  const total = chargesTotal(a.invoice.landedCharges);
  const poId = a.match.poId;
  const targets = new Map<string, LandedCostTarget>();
  if (poId !== null) {
    for (const g of await goodsReceiptAdapter(input).all(tenantId)) {
      if (g.poId !== poId) continue;
      for (const [productId, qty] of Object.entries(g.poReceipt?.receivedByProduct ?? {})) {
        const k = `${productId}\u001f${g.warehouseId}`;
        const cur = targets.get(k);
        targets.set(k, { productId, locationId: g.warehouseId, quantityMinor: (cur?.quantityMinor ?? 0) + qty });
      }
    }
  }
  const payable = !a.match.blocked && a.order !== undefined && a.order.status === 'issued';
  const desired = payable ? apportionLandedCharges(total, a.match.lines.map((l) => ({ productId: l.productId, valueMinor: l.payableMinor })), [...targets.values()]) : [];
  const posted = (await stockCostAdjustments(input.store, tenantId)).filter((x) => x.invoiceId === a.invoice.invoiceId);
  const deltas = landedCostDeltas(desired, posted.map((x) => ({ productId: x.productId, locationId: x.locationId, quantityMinor: x.quantityMinor, valueMinor: x.valueMinor })));
  const at = input.now();
  const events = deltas.map((d) => {
    const adj: StockCostAdjustment = {
      adjustmentId: `landed:${a.invoice.invoiceId}:${a.match.matchedAt}:${d.productId}:${d.locationId}`, invoiceId: a.invoice.invoiceId, poId,
      productId: d.productId, locationId: d.locationId, quantityMinor: d.quantityMinor, valueMinor: d.valueMinor, occurredAt: at, postedBy: a.by, matchedAt: a.match.matchedAt,
    };
    return { stream: STOCK_COST_ADJUSTMENTS_STREAM, event: makeEvent({
      id: adj.adjustmentId, type: 'StockCostAdjusted', occurredAt: at,
      idempotencyKey: `stock-cost-${tenantId}-${adj.adjustmentId}`, source: 'api/purchase', payload: adj as unknown as Record<string, unknown>,
    }) };
  });
  if (events.length > 0) await input.store.appendBatch(tenantId, events);
  return { chargesMinor: total, apportioned: payable && desired.length > 0, standing: desired, posted: deltas };
}

/** The hooks the supplier-invoice routes take: §28 at the match, and the landed cost into stock value. */
export function p3PurchaseHooks(input: { readonly store: EventStore; readonly now: () => string }): Pick<PurchaseDeps, 'segregation' | 'postLandedCost'> {
  return {
    segregation: segregationAdapter(input),
    postLandedCost: (tenantId, a) => postLandedCostOf(input, tenantId, a),
  };
}
