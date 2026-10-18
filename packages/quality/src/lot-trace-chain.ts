// The whole road of one batch — roadmap v2.1 D-26 (FDA FSMA 204 / GS1 US "one-up / one-down", M10-FR-03).
//
// Signed sentence (OB-188): "for any batch, one call returns supplier → GRN → transfers → production → sales, all from
// stored facts, as a sortable CSV. A trace request not answered within 24 h raises an exception."
//
// B11's export (`lot-trace.ts`) answers one step back and one step forward, with the step back typed in by the caller.
// This folds every hop from what the shop already STORED — the goods-receipt notes and the purchase orders they were
// received against (supplier → GRN), the stock movements that received a batch with no receipt note at all, the transfers
// between its places, the production runs (the batch made here, and the runs that used it as an ingredient with the
// sales of what they made — D-25), and the sales — into one table a person can sort and hand to an inspector.
//
// No silent failure (P-08): a hop the shop cannot name is a GAP on the trace, said in words — a receipt with no supplier,
// a batch received with no receipt note, a production run recorded before it kept its ingredient batches, more sold or
// moved than ever arrived.
// Pure and deterministic: the facts go in, the trace and its CSV come out; no clock, no storage.

import type { OutboundLotRecord } from './lot-trace';

/** One receipt of the batch at a place: from a goods-receipt note, or a stock movement with none. */
export interface TraceReceipt {
  /** The goods-receipt note id, or null when the stock was received with no receipt note (a direct stock movement). */
  readonly grnId: string | null;
  readonly grnNumber?: string;
  /** The movement that received it, when there was no receipt note. */
  readonly movementId?: string;
  readonly supplierId: string | null;
  readonly poId: string | null;
  readonly productId: string;
  readonly locationId: string;
  readonly receivedAt: string;
  readonly quantityMinor: number;
  readonly expiry?: string | null;
}

export interface TraceTransfer {
  readonly transferId: string;
  readonly productId: string;
  readonly fromLocationId: string;
  readonly toLocationId: string;
  readonly state: string;
  readonly dispatchedAt?: string;
  readonly receivedAt?: string;
  readonly quantityMinor: number;
}

/** A production run that MADE this batch (its output). */
export interface TraceProducedBy {
  readonly runId: string;
  readonly productId: string;
  readonly locationId: string;
  readonly at: string;
  readonly quantityMinor: number;
}

/** A production run that USED this batch as an ingredient, and what it made. */
export interface TraceUsedIn {
  readonly runId: string;
  readonly at: string;
  readonly quantityMinor: number;
  readonly outputProductId: string;
  readonly outputBatchId: string;
  /** The sales of the OUTPUT batch — the road continues past the run to the customer (D-25 → D-26). */
  readonly outputSales?: readonly (OutboundLotRecord & { readonly productId?: string })[];
}

/**
 * Which production runs used the batch, from the input batches each run records (D-25). `connected: false` is for a
 * source that cannot answer at all — the trace then says so, rather than reading "used in nothing".
 */
export type ProductionUse =
  | {
    readonly connected: true;
    readonly runs: readonly TraceUsedIn[];
    /** Runs recorded before D-25, which carry no input batches: whether they used this batch cannot be said. */
    readonly runsWithoutRecordedInputs?: number;
  }
  | { readonly connected: false; readonly why: string };

export type TraceHop = 'supplier_to_store' | 'production_made' | 'transfer' | 'production_used' | 'sale';

/** The order the hops run in along the road — the `hop` sort. */
export const HOP_ORDER: Readonly<Record<TraceHop, number>> = Object.freeze({
  supplier_to_store: 1, production_made: 2, transfer: 3, production_used: 4, sale: 5,
});

/** One row of the trace — one fact, one hop. Every value is text, so the CSV and the JSON say the same thing. */
export interface TraceRow {
  readonly hop: TraceHop;
  /** YYYY-MM-DD — the column a person sorts by first. */
  readonly date: string;
  /** The full timestamp where the fact has one, else the date. */
  readonly at: string;
  /** The record it came from: the GRN, the movement, the transfer, the run, the sale. */
  readonly reference: string;
  /** Who it came from: the supplier, the sending place, the production run. "not known" where the shop cannot say. */
  readonly from: string;
  /** Where it went: the store place, the receiving place, the customer ("walk-in" where none was identified). */
  readonly to: string;
  readonly productId: string;
  readonly quantityMinor: number;
  /** How the shop knows: a receipt note, a stock movement, a transfer, a run, the till's captured batch, a FIFO estimate. */
  readonly source: string;
}

export interface LotTraceChain {
  readonly batchId: string;
  readonly productIds: readonly string[];
  readonly rows: readonly TraceRow[];
  readonly receivedMinor: number;
  readonly producedMinor: number;
  readonly soldMinor: number;
  readonly usedInProductionMinor: number | 'not_known';
  /** Each thing the shop cannot say about this batch, in words (P-08). Empty only when nothing is missing. */
  readonly gaps: readonly string[];
  /** True only when every hop is known and no more of the batch left than arrived. */
  readonly complete: boolean;
}

export type TraceSort = 'date' | 'hop' | 'reference' | 'from' | 'to' | 'product' | 'quantity';
export const TRACE_SORTS: readonly TraceSort[] = ['date', 'hop', 'reference', 'from', 'to', 'product', 'quantity'];

const day = (at: string): string => at.slice(0, 10);
const NOT_KNOWN = 'not known';

/** Fold the stored facts about one batch into its trace. */
export function buildLotTraceChain(input: {
  readonly batchId: string;
  readonly receipts: readonly TraceReceipt[];
  readonly producedBy: readonly TraceProducedBy[];
  readonly transfers: readonly TraceTransfer[];
  readonly usedIn: ProductionUse;
  readonly sales: readonly (OutboundLotRecord & { readonly productId?: string })[];
}): LotTraceChain {
  const gaps: string[] = [];
  const rows: TraceRow[] = [];

  for (const r of input.receipts) {
    if (r.grnId === null) {
      gaps.push(`${r.quantityMinor} received at ${r.locationId} on ${day(r.receivedAt)} with no goods-receipt note (movement ${r.movementId ?? NOT_KNOWN}) — the supplier is not known`);
    } else if (r.supplierId === null) {
      gaps.push(`goods receipt ${r.grnNumber ?? r.grnId} names no purchase order, so its supplier is not known`);
    }
    rows.push({
      hop: 'supplier_to_store', date: day(r.receivedAt), at: r.receivedAt,
      reference: r.grnId === null ? `movement ${r.movementId ?? NOT_KNOWN}` : `GRN ${r.grnNumber ?? r.grnId}${r.poId === null ? '' : ` (PO ${r.poId})`}`,
      from: r.supplierId ?? NOT_KNOWN, to: r.locationId, productId: r.productId, quantityMinor: r.quantityMinor,
      source: r.grnId === null ? 'stock movement (no receipt note)' : 'goods-receipt note',
    });
  }
  for (const p of input.producedBy) {
    rows.push({
      hop: 'production_made', date: day(p.at), at: p.at, reference: `production run ${p.runId}`, from: `production run ${p.runId}`,
      to: p.locationId, productId: p.productId, quantityMinor: p.quantityMinor, source: 'production release',
    });
  }
  for (const t of input.transfers) {
    const at = t.receivedAt ?? t.dispatchedAt;
    if (at === undefined) continue; // proposed, never moved: not a hop
    rows.push({
      hop: 'transfer', date: day(at), at, reference: `transfer ${t.transferId} (${t.state})`,
      from: t.fromLocationId, to: t.state === 'received' ? t.toLocationId : `${t.toLocationId} (in transit)`, productId: t.productId,
      quantityMinor: t.quantityMinor, source: 'transfer',
    });
  }
  if (input.usedIn.connected) {
    for (const u of input.usedIn.runs) {
      rows.push({
        hop: 'production_used', date: day(u.at), at: u.at, reference: `production run ${u.runId}`, from: input.batchId,
        to: `${u.outputProductId} batch ${u.outputBatchId}`, productId: u.outputProductId, quantityMinor: u.quantityMinor, source: 'production run inputs',
      });
      // One step further: the output batch's own sales. Not this batch's sales (they are not counted in `soldMinor`), but
      // the customers a recall of this ingredient must reach.
      for (const s of u.outputSales ?? []) {
        rows.push({
          hop: 'sale', date: s.soldDate, at: s.soldDate, reference: `sale ${s.saleId}`, from: `${u.outputProductId} batch ${u.outputBatchId}`,
          to: s.customerId ?? 'walk-in', productId: s.productId ?? u.outputProductId, quantityMinor: s.quantityMinor,
          source: `${s.source === 'fifo_receipt_estimate' ? 'estimate (FIFO by receipt, not a till record)' : 'till recorded the batch'} — made from this batch in run ${u.runId}`,
        });
      }
    }
    const unrecorded = input.usedIn.runsWithoutRecordedInputs ?? 0;
    if (unrecorded > 0) {
      gaps.push(`${unrecorded} production run(s) were recorded before runs kept their ingredient batches (D-25) — whether they used this batch is not known`);
    }
  } else {
    gaps.push(`whether this batch was used in production is not known: ${input.usedIn.why}`);
  }
  const productOf = [...new Set([...input.receipts, ...input.producedBy, ...input.transfers].map((r) => r.productId))];
  for (const s of input.sales) {
    rows.push({
      hop: 'sale', date: s.soldDate, at: s.soldDate, reference: `sale ${s.saleId}`, from: 'store', to: s.customerId ?? 'walk-in',
      productId: s.productId ?? (productOf.length === 1 ? productOf[0]! : NOT_KNOWN), quantityMinor: s.quantityMinor,
      source: s.source === 'fifo_receipt_estimate' ? 'estimate (FIFO by receipt, not a till record)' : 'till recorded the batch',
    });
  }

  const receivedMinor = input.receipts.reduce((n, r) => n + r.quantityMinor, 0);
  const producedMinor = input.producedBy.reduce((n, p) => n + p.quantityMinor, 0);
  const soldMinor = input.sales.reduce((n, s) => n + s.quantityMinor, 0);
  const usedInProductionMinor = input.usedIn.connected ? input.usedIn.runs.reduce((n, u) => n + u.quantityMinor, 0) : 'not_known' as const;
  const arrived = receivedMinor + producedMinor;
  const left = soldMinor + (usedInProductionMinor === 'not_known' ? 0 : usedInProductionMinor);
  if (arrived === 0) gaps.push('no receipt and no production of this batch is on record — where it came from is not known');
  if (left > arrived) gaps.push(`${left} of this batch left the shop but only ${arrived} ever arrived — a traceability gap`);
  if (input.sales.some((s) => s.source === 'fifo_receipt_estimate')) gaps.push('some sales are a FIFO estimate, not a till record of the batch');
  if (input.usedIn.connected && input.usedIn.runs.some((u) => (u.outputSales ?? []).some((s) => s.source === 'fifo_receipt_estimate'))) {
    gaps.push('some sales of what was made from this batch are a FIFO estimate, not a till record of the output batch');
  }

  return {
    batchId: input.batchId,
    productIds: [...new Set(rows.map((r) => r.productId).filter((p) => p !== NOT_KNOWN))].sort(),
    rows: sortRows(rows, 'date'),
    receivedMinor, producedMinor, soldMinor, usedInProductionMinor,
    gaps,
    complete: gaps.length === 0,
  };
}

/** Sort the rows by a column; ties fall back to the road order, then the date, then the reference — stable and total. */
export function sortRows(rows: readonly TraceRow[], by: TraceSort): TraceRow[] {
  const key = (r: TraceRow): string | number => {
    switch (by) {
      case 'date': return r.at;
      case 'hop': return HOP_ORDER[r.hop];
      case 'reference': return r.reference;
      case 'from': return r.from;
      case 'to': return r.to;
      case 'product': return r.productId;
      case 'quantity': return r.quantityMinor;
    }
  };
  return [...rows].sort((a, b) => {
    const ka = key(a), kb = key(b);
    if (ka !== kb) return ka < kb ? -1 : 1;
    if (HOP_ORDER[a.hop] !== HOP_ORDER[b.hop]) return HOP_ORDER[a.hop] - HOP_ORDER[b.hop];
    if (a.at !== b.at) return a.at < b.at ? -1 : 1;
    return a.reference < b.reference ? -1 : a.reference > b.reference ? 1 : 0;
  });
}

export const TRACE_CSV_COLUMNS = ['batch', 'hop', 'date', 'at', 'reference', 'from', 'to', 'product', 'quantity_minor', 'source'] as const;

/** One CSV cell (RFC 4180), never read by a spreadsheet as a formula. */
function cell(v: string): string {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** The trace as a CSV any spreadsheet opens and sorts — header first, one row per hop, in the order asked for. */
export function traceCsv(chain: LotTraceChain, by: TraceSort = 'date'): string {
  const lines = [TRACE_CSV_COLUMNS.join(',')];
  for (const r of sortRows(chain.rows, by)) {
    lines.push([chain.batchId, r.hop, r.date, r.at, r.reference, r.from, r.to, r.productId, String(r.quantityMinor), r.source].map(cell).join(','));
  }
  return `${lines.join('\n')}\n`;
}

// ── The 24-hour clock on a trace request (FSMA 204: records within 24 hours of a request) ──────────────────────────

export const TRACE_ANSWER_WITHIN_MS = 24 * 60 * 60 * 1000;

export interface TraceRequest {
  readonly requestId: string;
  readonly batchId: string;
  /** Who asked — an inspector, a supplier's recall notice, the owner. Words, as given. */
  readonly askedBy: string;
  readonly reason: string;
  readonly requestedAt: string;
  readonly recordedBy: string;
  readonly dueAt: string;
}

export interface TraceAnswer {
  readonly requestId: string;
  readonly answeredAt: string;
  readonly answeredBy: string;
  readonly rowCount: number;
  readonly gapCount: number;
  /** The SHA-256 of the CSV handed over, so the file given is the file on record. */
  readonly csvSha256: string;
}

export type TraceRequestState = 'open' | 'overdue' | 'answered' | 'answered_late';

/** The due time for a request made at `requestedAt`: 24 hours later. */
export function traceDueAt(requestedAt: string): string {
  return new Date(Date.parse(requestedAt) + TRACE_ANSWER_WITHIN_MS).toISOString();
}

/** Where a request stands at `now`, and the exception it raises when it is past its 24 hours. */
export function traceRequestStanding(request: TraceRequest, answer: TraceAnswer | undefined, now: string): {
  readonly state: TraceRequestState;
  readonly exception?: { readonly kind: 'trace_request_not_answered_in_24h'; readonly severity: 'critical'; readonly raisedAt: string; readonly detail: string };
} {
  const due = Date.parse(request.dueAt);
  if (answer !== undefined) {
    const late = Date.parse(answer.answeredAt) > due;
    return late
      ? { state: 'answered_late', exception: { kind: 'trace_request_not_answered_in_24h', severity: 'critical', raisedAt: request.dueAt, detail: `trace request ${request.requestId} for batch ${request.batchId} was answered at ${answer.answeredAt}, after its 24-hour deadline ${request.dueAt}` } }
      : { state: 'answered' };
  }
  if (Date.parse(now) > due) {
    return { state: 'overdue', exception: { kind: 'trace_request_not_answered_in_24h', severity: 'critical', raisedAt: request.dueAt, detail: `trace request ${request.requestId} for batch ${request.batchId} (asked by ${request.askedBy}) was due by ${request.dueAt} and has not been answered` } };
  }
  return { state: 'open' };
}
