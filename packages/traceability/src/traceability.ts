// Supplier-to-customer lot traceability (M10-FR-03) — trace any batch from the
// supplier/GRN through stock movements to the sales (and identified customers) that
// received it, and back. The trace is a PROJECTION over the append-only ledger: it
// collects every event tagged with the batch, classifying each as inbound (received)
// or outbound (sold/returned) by the sign of its stock movement. Works backwards
// (customer→supplier) and forwards (supplier→customer). Pure and deterministic; uses
// last-synced ledger data (freshness is the caller's to surface). PII (customerRef)
// is carried only where captured and access is controlled upstream (PRV).

import type { Ledger } from '../../ledger/src/ledger';

export type TraceDirection = 'inbound' | 'outbound';

export interface TraceRecord {
  readonly eventId: string;
  readonly eventType: string;
  readonly at: string;
  readonly source: string;
  readonly direction: TraceDirection;
  /** Absolute quantity moved (magnitude). */
  readonly qty: number;
  /** The related document id (GRN / sale / order), where present. */
  readonly ref: string | null;
  /** The customer, where captured (else null — e.g. an anonymous walk-in). */
  readonly customerRef: string | null;
}

export interface BatchTrace {
  readonly batchId: string;
  readonly inbound: readonly TraceRecord[];
  readonly outbound: readonly TraceRecord[];
  readonly receivedQty: number;
  readonly issuedQty: number;
}

interface TracePayload {
  readonly batchId?: string;
  readonly deltaMinor?: number;
  readonly grnId?: string;
  readonly saleId?: string;
  readonly orderId?: string;
  readonly returnId?: string;
  readonly number?: string;
  readonly customerId?: string;
  readonly customerRef?: string;
}

function pickRef(p: TracePayload): string | null {
  return p.grnId ?? p.saleId ?? p.orderId ?? p.returnId ?? p.number ?? null;
}

/**
 * Trace a batch over the ledger: every batch-tagged event, split into inbound
 * (received) and outbound (issued/sold) by the sign of its movement. Records are in
 * ledger (append) order — the chain of custody. `receivedQty`/`issuedQty` summarise
 * the totals so a discrepancy is visible.
 */
export function traceBatch(ledger: Ledger, batchId: string): BatchTrace {
  const inbound: TraceRecord[] = [];
  const outbound: TraceRecord[] = [];
  let receivedQty = 0;
  let issuedQty = 0;

  for (const record of ledger.entries()) {
    const p = record.event.payload as TracePayload;
    if (p.batchId !== batchId) continue;

    const delta = typeof p.deltaMinor === 'number' ? p.deltaMinor : 0;
    // A GoodsReceived with no explicit delta still counts as inbound.
    const inboundEvent = delta > 0 || record.event.type === 'GoodsReceived';
    const qty = Math.abs(delta);
    const traceRecord: TraceRecord = {
      eventId: record.event.id,
      eventType: record.event.type,
      at: record.event.occurredAt,
      source: record.event.source,
      direction: inboundEvent ? 'inbound' : 'outbound',
      qty,
      ref: pickRef(p),
      customerRef: p.customerId ?? p.customerRef ?? null,
    };
    if (inboundEvent) {
      inbound.push(traceRecord);
      receivedQty += qty;
    } else {
      outbound.push(traceRecord);
      issuedQty += qty;
    }
  }

  return { batchId, inbound, outbound, receivedQty, issuedQty };
}
