// R3 lane 3 (till, batch and traceability) — head office's wiring for B16, B13 and D-26. D-20 and SF-08 need no register
// of their own: the batch markdown is a price-list entry for one batch, and the batch-precise block is the recall and
// quality-hold registers' own batches, both folded into the signed catalogue pack.
//
//   • B16 (OB-140 "A") — the register of the tobacco health-warning pictures the government notified, append-only on its
//     own stream, and each tobacco product's confirmation by a named person, kept as a new version of its product record.
//   • B13 (OB-138) — head office's backstop for a hallmark HUID sold twice: the other banked sale each HUID was sold on.
//   • D-26 — the facts one batch's trace is folded from (goods receipts and the orders behind them, stock movements,
//     transfers, production, sales), and the trace-request register with its 24-hour clock.
//
// The production hop reads D-25 (Lane 4): each run records the ingredient batches it used, so `productionUseOf` follows an
// ingredient batch into the output batch and on to that batch's sales.

import { makeEvent } from '../../../packages/contracts/src/event';
import type { EventStore } from '../../../packages/persistence/src/event-store';
import type { Route } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import type { WarningImage } from '../../../packages/product/src/index';
import type { TraceReceipt, TraceTransfer, TraceProducedBy, ProductionUse, TraceUsedIn, TraceRequest, TraceAnswer } from '../../../packages/quality/src/lot-trace-chain';
import type { IncomingSale } from '../../pos/src/index';
import type { Transfer } from '../../../packages/warehouse/src/transfers';
import { tobaccoWarningRoutes, type TobaccoWarningDeps } from '../../catalogue/src/tobacco-warning';
import { lotTraceChainRoutes, type LotTraceChainDeps, type LotTraceFacts } from '../../inventory/src/lot-trace-chain';
import {
  STREAM, streamName, productMasterAdapter, peopleAdapter, goodsReceiptAdapter, foldPurchaseOrders, transfersAdapter, lotTraceAdapter,
} from './adapters';
import { productionInputsForOutputBatch, productionTraceRunsOf } from './r3-ops-adapters';
import { type ShopCalendarOf } from '../../../packages/calendar/src/shop-clock';

const PICTURES = streamName(STREAM.catalogue, 'tobacco-warning-pictures');
const PICTURE_RECORDED = 'TobaccoWarningPictureRecorded';
const TRACE_REQUESTS = streamName(STREAM.inventory, 'lot-trace-requests');
const TRACE_REQUESTED = 'LotTraceRequested';
const TRACE_ANSWERED = 'LotTraceRequestAnswered';

type Input = { readonly store: EventStore; readonly now: () => string };

const payloads = async <T>(store: EventStore, tenantId: string, stream: string, type: string): Promise<T[]> =>
  (await store.readStream(tenantId, stream, { type })).map((e) => e.event.payload as T);

/** B16: the picture register and the product master it stamps, on head office's event store. */
export function tobaccoWarningAdapter(input: Input & { readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void }): TobaccoWarningDeps {
  const master = productMasterAdapter(input);
  const people = peopleAdapter(input);
  return {
    now: input.now,
    pictures: (tenantId) => payloads<WarningImage>(input.store, tenantId, PICTURES, PICTURE_RECORDED),
    recordPicture: async (tenantId, picture) => {
      await input.store.append(tenantId, PICTURES, makeEvent({
        id: `tobacco-picture-${picture.imageId}`, type: PICTURE_RECORDED, occurredAt: picture.recordedAt,
        // One picture id, once — a resend collapses (hard rule #10); a different picture needs a new id.
        idempotencyKey: `tobacco-picture-${tenantId}-${picture.imageId}`, source: 'api/catalogue', payload: picture,
      }));
    },
    product: async (tenantId, productId) => master.product(tenantId, productId),
    products: async (tenantId) => master.products(tenantId),
    publish: async (tenantId, record, key) => { await master.publish(tenantId, record, key); },
    personName: async (tenantId, userId) => (await people.people(tenantId)).find((p) => p.userId === userId)?.displayName,
    ...(input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit }),
  };
}

/**
 * B13 (OB-138): for each HUID a sale carries, the OTHER sale head office already banked it on. Read from the banked
 * sales; a gold sale is rare, and the read is made only for a sale that carries a HUID or a gold product.
 */
export function huidsSoldElsewhereAdapter(input: { readonly store: EventStore }): (tenantId: string, sale: IncomingSale) => Promise<ReadonlyMap<string, string>> {
  return async (tenantId, sale) => {
    const wanted = new Set(sale.lines.flatMap((l) => (typeof l.huid === 'string' && l.huid !== '' ? [l.huid] : [])));
    const found = new Map<string, string>();
    if (wanted.size === 0) return found;
    for (const banked of await payloads<IncomingSale>(input.store, tenantId, STREAM.sales, 'SaleCommitted')) {
      if (banked.saleId === sale.saleId) continue;
      for (const l of banked.lines ?? []) {
        if (typeof l.huid === 'string' && wanted.has(l.huid) && !found.has(l.huid)) found.set(l.huid, banked.saleId);
      }
    }
    return found;
  };
}

/**
 * D-26 ← D-25: which production runs USED a batch as an ingredient, from the input batches each run records (Lane 4's
 * production register), and the sales of each output batch — so a trace of an ingredient reaches the customers of what
 * was made from it. A run recorded before D-25 carries no input batches; how many there are is said, never read as
 * "not used".
 */
export function productionUseOf(input: Input): (tenantId: string, batchId: string) => Promise<ProductionUse> {
  return async (tenantId, batchId) => {
    const runs = await productionTraceRunsOf(input, tenantId);
    const sold = lotTraceAdapter(input);
    const used: TraceUsedIn[] = [];
    for (const r of runs) {
      const mine = (r.inputBatches ?? []).filter((i) => i.batchId === batchId);
      if (mine.length === 0) continue;
      // Each output batch is confirmed against Lane 4's own output → inputs answer for it.
      const made = (await productionInputsForOutputBatch(input, tenantId, r.outputBatchId)).find((m) => m.runId === r.runId);
      if (made === undefined) continue;
      used.push({
        runId: r.runId, at: r.at, outputProductId: r.outputProductId, outputBatchId: r.outputBatchId,
        quantityMinor: made.inputBatches.filter((i) => i.batchId === batchId).reduce((n, i) => n + i.quantityMinor, 0),
        outputSales: (await sold.soldOfBatch(tenantId, r.outputBatchId)).map((s) => ({ ...s, productId: r.outputProductId })),
      });
    }
    return { connected: true, runs: used, runsWithoutRecordedInputs: runs.filter((r) => r.inputBatches === undefined).length };
  };
}

/** One movement as the inventory stream stores it — the fields the trace reads. */
interface StoredMovement {
  readonly movementId: string;
  readonly productId: string;
  readonly locationId: string;
  readonly kind: string;
  readonly quantityMinor: number;
  readonly occurredAt: string;
  readonly batchId?: string;
  readonly expiry?: string;
}

/** D-26: the stored facts one batch's trace is folded from. */
export function lotTraceFactsAdapter(input: Input & { readonly productionUse?: (tenantId: string, batchId: string) => Promise<ProductionUse> }): (tenantId: string, batchId: string) => Promise<LotTraceFacts> {
  return async (tenantId, batchId) => {
    const orders = await foldPurchaseOrders(input.store, tenantId);
    const grns = await goodsReceiptAdapter(input).all(tenantId);
    const receipts: TraceReceipt[] = [];
    const grnIds = new Set<string>();
    for (const g of grns) {
      grnIds.add(g.grnId);
      for (const l of g.captured.lines) {
        if (l.batchId !== batchId) continue;
        const counted = l.sellableMinor + l.quarantinedMinor + l.heldMinor;
        if (counted <= 0) continue;
        receipts.push({
          grnId: g.grnId, grnNumber: g.number, supplierId: g.poId === null ? null : (orders.get(g.poId)?.supplierId ?? null), poId: g.poId,
          productId: l.productId, locationId: g.warehouseId, receivedAt: g.receivedAt, quantityMinor: counted, expiry: l.expiry,
        });
      }
    }
    // A batch received straight onto the stock ledger (no receipt note) is still a receipt — named, with its supplier unknown.
    // A receipt note's own postings (`<grnId>:…`, `recv:<grnId>:…`) are not counted twice.
    const fromGrn = (movementId: string): boolean => [...grnIds].some((g) => movementId.startsWith(`${g}:`) || movementId.startsWith(`recv:${g}:`));
    const moves = await payloads<StoredMovement>(input.store, tenantId, STREAM.inventory, 'InventoryMoved');
    const producedBy: TraceProducedBy[] = [];
    for (const m of moves) {
      if (m.batchId !== batchId) continue;
      if (m.kind === 'received' && !fromGrn(m.movementId)) {
        receipts.push({ grnId: null, movementId: m.movementId, supplierId: null, poId: null, productId: m.productId, locationId: m.locationId, receivedAt: m.occurredAt, quantityMinor: m.quantityMinor, expiry: m.expiry ?? null });
      }
      if (m.kind === 'produced') {
        const runId = /^prod-run:(.+):out$/.exec(m.movementId)?.[1] ?? m.movementId;
        producedBy.push({ runId, productId: m.productId, locationId: m.locationId, at: m.occurredAt, quantityMinor: m.quantityMinor });
      }
    }
    const transfers: TraceTransfer[] = (await transfersAdapter(input).transfers!(tenantId)).flatMap((t: Transfer) => t.lines
      .filter((l) => l.batchId === batchId)
      .map((l) => ({
        transferId: t.transferId, productId: l.productId, fromLocationId: t.fromLocationId, toLocationId: t.toLocationId, state: t.state,
        ...(t.dispatchedAt === undefined ? {} : { dispatchedAt: t.dispatchedAt }), ...(t.receivedAt === undefined ? {} : { receivedAt: t.receivedAt }),
        quantityMinor: l.quantityMinor,
      })));
    const sales = await lotTraceAdapter(input).soldOfBatch(tenantId, batchId);
    const usedIn = await (input.productionUse ?? productionUseOf(input))(tenantId, batchId);
    return { receipts, producedBy, transfers, usedIn, sales };
  };
}

/** D-26: the trace-request register — each request and its answer, once each, on their own stream. */
export function lotTraceRequestsAdapter(input: Input): Pick<LotTraceChainDeps, 'requests' | 'recordRequest' | 'answers' | 'recordAnswer'> {
  return {
    requests: (tenantId) => payloads<TraceRequest>(input.store, tenantId, TRACE_REQUESTS, TRACE_REQUESTED),
    recordRequest: async (tenantId, r) => {
      await input.store.append(tenantId, TRACE_REQUESTS, makeEvent({
        id: `lot-trace-request-${r.requestId}`, type: TRACE_REQUESTED, occurredAt: r.requestedAt,
        idempotencyKey: `lot-trace-request-${tenantId}-${r.requestId}`, source: 'api/inventory', payload: r,
      }));
    },
    answers: (tenantId) => payloads<TraceAnswer>(input.store, tenantId, TRACE_REQUESTS, TRACE_ANSWERED),
    recordAnswer: async (tenantId, a) => {
      await input.store.append(tenantId, TRACE_REQUESTS, makeEvent({
        id: `lot-trace-answer-${a.requestId}`, type: TRACE_ANSWERED, occurredAt: a.answeredAt,
        // Answered once: a second answer for the same request collapses onto the first.
        idempotencyKey: `lot-trace-answer-${tenantId}-${a.requestId}`, source: 'api/inventory', payload: a,
      }));
    },
  };
}

/** The routes this lane adds to head office, composed from its store (or held in memory when there is none). */
export function r3TillTraceRoutes(input: {
  readonly store: EventStore | undefined;
  readonly now: () => string;
  /** R1b · R1c (M01-FR-02): the tenant calendar — every business date these routes read is the shop's. */
  readonly calendar?: ShopCalendarOf;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}): readonly Route[] {
  const { store, now } = input;
  if (store === undefined) {
    // No store: nothing to trace and no products to confirm — every read answers empty, every write is refused upstream.
    const none = <T>(): Promise<T[]> => Promise.resolve([]);
    return [
      ...tobaccoWarningRoutes({ now, pictures: none, recordPicture: async () => {}, product: async () => undefined, products: none, publish: async () => {} }),
      ...lotTraceChainRoutes({
        now, requests: none, recordRequest: async () => {}, answers: none, recordAnswer: async () => {},
        // No store: no production run is recorded, so none used the batch.
        facts: async () => ({ receipts: [], producedBy: [], transfers: [], sales: [], usedIn: { connected: true, runs: [] } }),
      }),
    ];
  }
  return [
    ...tobaccoWarningRoutes({ ...tobaccoWarningAdapter({ store, now, ...(input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit }) }), ...(input.calendar === undefined ? {} : { calendar: input.calendar }) }),
    ...lotTraceChainRoutes({ now, facts: lotTraceFactsAdapter({ store, now }), ...lotTraceRequestsAdapter({ store, now }) }),
  ];
}
