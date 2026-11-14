// CR-01 OI-13 (OB-763 B, owner 14 Nov 2026) — the deterministic legs of the two assistants the owner chose before go-live:
//
//   • A12 Supplier-bill match explainer — every supplier bill whose LATEST three-way match (M07-FR-04) did not come out
//     clean is explained in plain sentences (the tested rule `explainBillMismatch`, packages/purchasing), with the query to
//     the supplier drafted. The accounts person decides — through the bill's own routes (match again once corrected, or the
//     supplier's debit note); a debit note touches what the shop pays, so it is never auto-approved.
//   • A14 Cash-office variance explainer — every till close (M14) that is over or short and that nobody has signed off yet
//     gets its likely causes from the records (the tested rule `explainTillVariance`, packages/cash): the till's own sales by
//     tender and the refunds paid out in the shift. It lists records, not people. The manager decides through the over/short
//     sign-off; writing off a shortage is never auto-approved and nothing here changes a cash balance.
//
// Neither calls a model or spends anything (₹0 a month; no AI service is contracted, OB-296 · OB-382). Read-only by
// construction: nothing here appends an event. Every draft carries its evidence and names the route a PERSON would use
// (hard rule 5, P-05). Neither sets an `act`, so no owner-set auto-approve limit can ever approve one (OI-12).

import type { EventStore } from '../../../packages/persistence/src/event-store';
import type { Proposal, EvidenceItem } from '../../ai/src/index';
import { FACT_CONFIDENCE, RULE_CONFIDENCE } from '../../ai/src/index';
import type { StoredMatch } from '../../purchase/src/index';
import type { ClosedShiftRecord, OverShortReview } from '../../pos/src/shift';
import type { IncomingSale } from '../../pos/src/sale-intake';
import type { ReturnRecord } from '../../pos/src/returns';
import { explainBillMismatch, inRupees } from '../../../packages/purchasing/src/bill-mismatch-explainer';
import { explainTillVariance, type TillPaymentFact } from '../../../packages/cash/src/variance-explainer';
import { STREAM, streamName, liveSupplierInvoices } from './adapters';

type Draft = Omit<Proposal, 'committed'>;

/** A compact, stable token for an instant inside a proposal id (the register keys proposals on their id). */
const stamp = (iso: string): string => iso.replace(/[^0-9]/g, '').slice(0, 14);

/**
 * A12 — one draft per supplier bill whose latest match did not come out clean. A bill matched again after it was corrected
 * (and now clean) drops off on its own; a bill matched again with different figures gets a fresh draft (its id carries the
 * match's moment), so a person never decides on yesterday's figures.
 */
export async function billMismatchDrafts(store: EventStore, tenantId: string, now: string): Promise<Draft[]> {
  const latest = new Map<string, StoredMatch>();
  for (const e of await store.readStream(tenantId, STREAM.purchase, { type: 'InvoiceMatched' })) {
    const m = e.event.payload as StoredMatch;
    latest.set(m.invoiceId, m);
  }
  const bills = new Map((await liveSupplierInvoices(store, tenantId)).map((b) => [b.invoiceId, b] as const));
  const out: Draft[] = [];
  for (const m of [...latest.values()].sort((a, b) => a.invoiceId.localeCompare(b.invoiceId))) {
    const bill = bills.get(m.invoiceId);
    const x = explainBillMismatch({
      invoiceId: m.invoiceId, supplierId: bill?.supplierId ?? m.sources.order?.supplierId ?? 'unknown supplier', poId: m.poId, matchedAt: m.matchedAt,
      blocked: m.blocked, invoicedMinor: m.invoicedMinor, payableMinor: m.payableMinor, withheldMinor: m.withheldMinor,
      lines: m.lines, flags: m.flags,
      ...(bill === undefined ? {} : { invoiceLines: bill.lines.map((l) => ({ productId: l.productId, quantity: l.quantity, unitPriceMinor: l.unitPriceMinor })) }),
    });
    if (x === null) continue;
    const evidence: EvidenceItem[] = [
      { source: 'three-way match verdict', reference: `InvoiceMatched ${m.invoiceId} @ ${m.matchedAt}`, summary: `billed ${inRupees(m.invoicedMinor)}, payable ${inRupees(m.payableMinor)}, held back ${inRupees(Math.max(0, m.withheldMinor))}${m.blocked ? ', blocked' : ''}; matched by ${m.matchedBy}` },
    ];
    if (bill !== undefined) evidence.push({ source: 'supplier bill', reference: `/v1/purchase/invoices/${m.invoiceId}`, summary: `${bill.lines.length} line(s), total ${inRupees(bill.totalMinor)}, captured ${bill.capturedAt}` });
    if (m.poId !== null) evidence.push({ source: 'purchase order and goods received', reference: `/v1/purchase/orders/${m.poId}`, summary: m.sources.order === null ? `order ${m.poId} not on file` : `order ${m.poId} (${m.sources.order.status}), ${m.sources.order.lineCount} line(s); received figures from the goods receipts folded into the order` });
    out.push({
      proposalId: `a12-bill:${m.invoiceId}:${stamp(m.matchedAt)}`, agent: 'A12', createdAt: now,
      summary: x.summary,
      // The accounts person's own routes — a corrected bill is matched again; money the supplier owes back is the supplier's
      // debit note. Named, never called: the assistant pays nothing and issues nothing.
      wouldRequire: x.supplierQuery !== null && x.heldBackMinor > 0
        ? `POST /v1/purchase/suppliers/${x.supplierId}/debit-notes/:debitNoteRef/issue by the accounts person, or POST /v1/purchase/invoices/${m.invoiceId}/match once the supplier corrects the bill`
        : `POST /v1/purchase/invoices/${m.invoiceId}/match by the accounts person, once the bill or the order is put right`,
      confidence: { ...FACT_CONFIDENCE, uncertainty: 'The figures are the bill, the order and the goods received as recorded at head office. It cannot know about a delivery not yet entered, an agreement with the supplier made by phone, or a mistake made when the bill was typed in — check the paper bill.' },
      evidence,
      reasons: x.reasons.map((r) => ({ code: r.code, values: r.values, sentence: r.sentence, ...(r.productId === undefined ? {} : { recordRef: r.productId }) })),
      ...(x.supplierQuery === null ? {} : { draftText: x.supplierQuery }),
    });
  }
  return out;
}

/** A day either side of a trading day — the window a till's payments are read from (bounded, not all history). */
const windowOf = (tradingDay: string): { readonly from: string; readonly to: string } => {
  const at = Date.parse(`${tradingDay}T00:00:00.000Z`);
  return { from: new Date(at - 86_400_000).toISOString(), to: new Date(at + 2 * 86_400_000).toISOString() };
};

/**
 * A14 — one draft per till close that is over or short and that nobody has signed off. The till's payments are its own:
 * the sales on that lane in that trading day (inside the shift's window when the close carries one), and the refunds paid
 * out in the shift by whoever held the drawer — used only to find the records; no person is named in the draft.
 */
export async function tillVarianceDrafts(store: EventStore, tenantId: string, now: string): Promise<Draft[]> {
  const shiftStream = streamName(STREAM.cash, 'shifts');
  const reviewed = new Set((await store.readStream(tenantId, shiftStream, { type: 'ShiftOverShortReviewed' })).map((e) => (e.event.payload as OverShortReview).shiftId));
  const closes = (await store.readStream(tenantId, shiftStream, { type: 'TillClosed' })).map((e) => e.event.payload as ClosedShiftRecord)
    .filter((c) => c.varianceMinor !== 0 && !reviewed.has(c.shiftId))
    .sort((a, b) => a.closedAt.localeCompare(b.closedAt) || a.shiftId.localeCompare(b.shiftId));
  const out: Draft[] = [];
  for (const c of closes) {
    const w = windowOf(c.tradingDay);
    const lane = c.laneId ?? c.tillId;
    const inShift = (at: string): boolean => (c.openedAt === undefined || at >= c.openedAt) && at <= c.closedAt;
    const payments: TillPaymentFact[] = [];
    for (const e of await store.readStream(tenantId, STREAM.sales, { type: 'SaleCommitted', from: w.from, to: w.to })) {
      const s = e.event.payload as IncomingSale;
      if (s.laneId !== lane || s.tradingDay !== c.tradingDay || !inShift(s.committedAt)) continue;
      for (const t of s.tenders) payments.push({ ref: s.receiptNumber, kind: 'sale', tender: t.kind, amountMinor: t.amountMinor, at: s.committedAt });
    }
    for (const e of await store.readStream(tenantId, STREAM.returns, { type: 'ReturnRecorded', from: w.from, to: w.to })) {
      const r = e.event.payload as ReturnRecord;
      if (r.processedBy !== c.cashierId || c.openedAt === undefined || !inShift(r.processedAt)) continue;
      payments.push({ ref: r.number, kind: 'refund', tender: r.refundTender, amountMinor: r.refundMinor, at: r.processedAt });
    }
    const x = explainTillVariance({
      close: {
        shiftId: c.shiftId, tillId: c.tillId, ...(c.storeId === undefined ? {} : { storeId: c.storeId }), tradingDay: c.tradingDay,
        expectedMinor: c.expectedMinor, countedMinor: c.countedMinor, varianceMinor: c.varianceMinor,
        ...(c.toleranceMinor === undefined ? {} : { toleranceMinor: c.toleranceMinor }),
        ...(c.pickupsMinor === undefined ? {} : { pickupsMinor: c.pickupsMinor }),
        denominationsGiven: (c.denominations ?? []).length > 0, reviewed: false,
      },
      payments,
    });
    if (x === null) continue;
    const explained = x.reasons.some((r) => r.code !== 'no_cause_found' && r.code !== 'count_not_broken_down');
    out.push({
      proposalId: `a14-till:${c.shiftId}`, agent: 'A14', createdAt: now,
      summary: x.summary,
      // The manager's own route — the over/short sign-off (a different person from the one who counted). Named, never called.
      wouldRequire: `POST /v1/shifts/${c.shiftId}/over-short/review by the manager (never the person who counted the drawer)`,
      confidence: explained
        ? { ...RULE_CONFIDENCE, uncertainty: 'These are likely causes a tested rule found in the till\'s records — not a finding against anyone. Only checking the bill, the drawer and the payment app shows which, if any, is right.' }
        : { band: 'low', basis: 'rule_inference', uncertainty: 'No record on this till explains the difference, so there is nothing to rely on yet — recount with a second person.' },
      evidence: [
        { source: 'till close (blind count)', reference: `TillClosed ${c.shiftId}`, summary: `till ${c.tillId} on ${c.tradingDay}: expected ${inRupees(c.expectedMinor)}, counted ${inRupees(c.countedMinor)}, ${c.varianceMinor < 0 ? 'short' : 'over'} ${inRupees(Math.abs(c.varianceMinor))}${c.pickupsMinor === undefined ? '' : `; pickups entered ${inRupees(c.pickupsMinor)}`}` },
        { source: 'sales and refunds on this till', reference: `SaleCommitted/ReturnRecorded lane ${lane} ${c.tradingDay}`, summary: `${payments.filter((p) => p.kind === 'sale').length} tender line(s) and ${payments.filter((p) => p.kind === 'refund').length} refund(s) read` },
      ],
      reasons: x.reasons.map((r) => ({ code: r.code, values: r.values, sentence: r.sentence, ...(r.recordRef === undefined ? {} : { recordRef: r.recordRef }) })),
    });
  }
  return out;
}
