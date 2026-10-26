// OB-288 lane 4 · P2 — data in: head office's wiring for the further import templates (OB-315 "import all domains" ·
// M30-FR-01/03/04 · hard rules #2, #6, #10 · P-04).
//
// `dataInTemplates` supplies the five templates (`services/purchase/src/import-templates-domains.ts`) over head office's
// own registers; `dataInCommitDeps` is the writer behind them: an approved load's job record AND every record it applies
// in ONE atomic save, each record the SAME event, on the SAME stream, under the SAME key shape its own screen writes —
// so everything that reads that register (the supplier master, the price list the till pack is built from, the stock
// ledger and its valuation, the loyalty register and points ledger) sees it, and a re-sent load collapses onto the first.
//
// A rollback is compensating records only — nothing is ever deleted or overwritten:
//   supplier        blocked, with the reason (it stays on the master as evidence)
//   price           the price it replaced, as a new version of the store's price-list entry
//   opening stock   an `opening_reversed` movement: the same quantity out at the opening's own cost (OB-44's kind)
//   customer        a "left" fact on the member (they earn nothing more; the record stays)
//   opening points  a reversal movement taking the opening back off the member's points
// each refused by name while anything downstream has used what the load wrote (the template's `blocksRollback`).
//
// The dry-run register keeps every dry run with its row-by-row exceptions (never deleted, hard rule #6).
//
// `dataOutDomains` (audit-4 M30-FR-02) adds the further export domains — price lists, promotions, goods receipts, supplier
// invoices, returns, stock movements (a bounded period), transfers, counts, till shifts, write-offs, waste and service
// cases — each read from its own register, through the governed export engine (scope, redaction, the export log).

import type { EventStore, BatchEntry } from '../../../packages/persistence/src/event-store';
import { makeEvent } from '../../../packages/contracts/src/event';
import { money } from '../../../packages/contracts/src/money';
import type { PriceEntry } from '../../../packages/price-list/src/price-list';
import type { RegisteredTemplate, DomainImportEffect } from '../../purchase/src/import-templates';
import type { ImportCommitRecord, ImportRollbackRecord, ImportDryRunRecord, DataImportDeps } from '../../purchase/src/data-import';
import {
  supplierTemplate, priceListTemplate, openingStockTemplate, customerTemplate, loyaltyOpeningTemplate,
} from '../../purchase/src/import-templates-domains';
import type { MemberRecord } from '../../customer/src/loyalty-members';
import type { RecordedPointsMovement } from '../../customer/src/index';
import type { Movement } from '../../inventory/src/index';
import { moreExportDomains, type ExportDomainSource } from '../../purchase/src/data-export';
import {
  STREAM, STREAM_FOR, streamName, productMasterAdapter, supplierMasterAdapter, productUomFrom, registeredStores, knownStockPlace, storeRulesAdapter,
  foldPurchaseOrders, liveSupplierInvoices, transfersAdapter, wasteAdapter, serviceCaseAdapter, INVOICE_WITHDRAWN,
} from './adapters';
import { shopClock, type ShopCalendarOf } from '../../../packages/calendar/src/shop-clock';

interface Base { readonly store: EventStore; readonly now: () => string; readonly calendar?: ShopCalendarOf }

export const DATA_IN_STREAMS = Object.freeze({
  imports: streamName(STREAM.purchase, 'data-imports'),
  dryRuns: streamName(STREAM.purchase, 'import-dry-runs'),
  suppliers: streamName(STREAM.purchase, 'suppliers'),
  supplierBlock: streamName(STREAM.purchase, 'supplier-block'),
  priceList: (productId: string) => streamName(STREAM.pricing, 'list', productId),
  members: streamName(STREAM.loyalty, 'members'),
  points: (memberRef: string) => streamName(STREAM.loyalty, memberRef),
  consent: (customerId: string) => streamName(STREAM.consent, customerId),
});

const payloadsOf = async <T>(store: EventStore, tenantId: string, stream: string, type: string): Promise<T[]> =>
  (await store.readStream(tenantId, stream, { type })).map((e) => e.event.payload as T);
const entry = (stream: string, id: string, type: string, occurredAt: string, idempotencyKey: string, payload: unknown, source = 'api/purchase/import'): BatchEntry => ({
  stream, event: makeEvent({ id, type, occurredAt, idempotencyKey, source, payload: payload as Record<string, unknown> }),
});

const memberHistory = (input: Base) => async (t: string, memberRef: string): Promise<MemberRecord[]> =>
  (await payloadsOf<MemberRecord>(input.store, t, DATA_IN_STREAMS.members, 'LoyaltyMember')).filter((m) => m.memberRef === memberRef);
const pointsMovements = (input: Base) => (t: string, memberRef: string): Promise<RecordedPointsMovement[]> =>
  payloadsOf<RecordedPointsMovement>(input.store, t, DATA_IN_STREAMS.points(memberRef), 'PointsMovement');
const priceEntries = (input: Base) => (t: string, productId: string): Promise<PriceEntry[]> =>
  payloadsOf<PriceEntry>(input.store, t, DATA_IN_STREAMS.priceList(productId), 'PriceListEntryPublished');
const stockMovements = (input: Base) => (t: string): Promise<Movement[]> => payloadsOf<Movement>(input.store, t, STREAM.inventory, 'InventoryMoved');

/** The five further templates (OB-315), each over head office's own registers. */
export function dataInTemplates(input: Base & { readonly memberKey?: Buffer }): readonly RegisteredTemplate[] {
  const products = productMasterAdapter(input);
  const suppliers = supplierMasterAdapter(input);
  const members = { memberHistory: memberHistory(input), pointsMovements: pointsMovements(input), ...(input.memberKey === undefined ? {} : { memberKey: input.memberKey }) };
  return [
    supplierTemplate({
      suppliers: async (t) => suppliers.records(t),
      supplierInUse: async (t, supplierId) => {
        const record = await suppliers.record(t, supplierId);
        if (record?.status === 'active') return 'has been approved by finance since';
        if ((record?.version ?? 1) > 1) return 'was changed on the supplier screen since';
        if ([...(await foldPurchaseOrders(input.store, t)).values()].some((o) => o.supplierId === supplierId)) return 'has purchase orders';
        if ((await liveSupplierInvoices(input.store, t)).some((i) => i.supplierId === supplierId)) return 'has supplier bills';
        return undefined;
      },
    }),
    priceListTemplate({
      productIds: async (t) => (await products.products(t)).map((p) => p.productId),
      storeIds: async (t) => [...await registeredStores(input, t)],
      marginFloorFor: async (t, storeId) => (await storeRulesAdapter(input).rules(t, storeId))?.marginFloorBps,
      entries: priceEntries(input),
      shopDateOf: (t, at) => shopClock(input.calendar).dateOf(t, at), // R1b: "from today" in the shop
    }),
    openingStockTemplate({
      productIds: async (t) => (await products.products(t)).map((p) => p.productId),
      knownPlace: (t) => knownStockPlace(input, t),
      productUom: (t, p) => productUomFrom(input, t, p),
      movements: stockMovements(input),
    }),
    customerTemplate(members),
    loyaltyOpeningTemplate(members),
  ];
}

/** The writer behind the five templates: one atomic save per commit and per rollback, and the dry-run register. */
export function dataInCommitDeps(input: Base): Pick<DataImportDeps, 'recordDomainCommit' | 'recordDomainRollback' | 'dryRuns' | 'recordDryRun'> {
  const committed = (t: string, record: ImportCommitRecord, key: string): BatchEntry =>
    entry(DATA_IN_STREAMS.imports, `data-import-${record.jobId}`, 'ImportCommitted', record.at, `data-import-${t}-${key}`, record, 'api/purchase');

  const effectEntries = (t: string, jobId: string, e: DomainImportEffect): BatchEntry[] => {
    switch (e.kind) {
      case 'supplier':
        // The supplier master's own event and key (one event per version; this is version 1).
        return [entry(DATA_IN_STREAMS.suppliers, `supplier-${e.supplier.supplierId}-v1`, 'SupplierRecorded', e.supplier.updatedAt, `supplier-${t}-${e.supplier.supplierId}-v1`, e.supplier)];
      case 'price':
        // The price change AND its operative store-scope entry, as the price screen writes them (SF-01).
        return [
          entry(STREAM.pricing, `pricechange-import-${jobId}-${e.productId}-${e.storeId}`, 'PriceChangeRecorded', e.change.at, `pricechange-${t}-import-${jobId}-${e.productId}-${e.storeId}`, { ...e.change, operativeAt: [e.storeId] }, 'api/pricing'),
          entry(DATA_IN_STREAMS.priceList(e.productId), `price-entry-${e.productId}-${e.entry.id}`, 'PriceListEntryPublished', e.change.at, `price-entry-${t}-${e.productId}-${e.entry.id}`, e.entry, 'api/pricing'),
        ];
      case 'opening_stock':
        // An opening receipt on the stock ledger at its cost — the valuation re-averages from it (M08-FR-04).
        return [entry(STREAM.inventory, `mv-${e.movement.movementId}`, 'InventoryMoved', e.movement.occurredAt, `mv-${t}-${e.movement.movementId}`, e.movement, 'api/inventory')];
      case 'customer': {
        const key = `${e.member.memberRef}:joined:import-${jobId}`;
        const c = e.marketingConsent;
        return [
          // The loyalty register's own event: the name (when given) is sealed to the member by the personal-data store.
          entry(DATA_IN_STREAMS.members, `loyalty-member-${key}`, 'LoyaltyMember', c.recordedAt, `loyalty-member-${t}-${key}`, e.member, 'api/customer'),
          entry(DATA_IN_STREAMS.consent(c.customerId), `consent-import-${jobId}-${c.customerId}`, 'ConsentRecorded', c.recordedAt, `consent-${t}-${c.customerId}-${c.purpose}-${c.channel}-withdrawn-${c.recordedAt}`, c, 'api/customer'),
        ];
      }
      case 'loyalty_opening':
        return [entry(DATA_IN_STREAMS.points(e.movement.customerId), `points-${e.movement.movementId}`, 'PointsMovement', e.movement.at, `points-${t}-${e.movement.movementId}`, e.movement, 'api/customer')];
    }
  };

  return {
    recordDomainCommit: async (t, record, key, effects) => {
      await input.store.appendBatch(t, [...effects.flatMap((e) => effectEntries(t, record.jobId, e)), committed(t, record, key)]);
    },
    recordDomainRollback: async (t, record: ImportRollbackRecord) => {
      const at = record.at;
      const why = `import ${record.jobId} rolled back: ${record.reason}`;
      const out: BatchEntry[] = [];
      for (const e of record.effects) {
        if (e.kind === 'supplier') {
          out.push(entry(DATA_IN_STREAMS.supplierBlock, `supplier-block-import-${record.jobId}-${e.ref}`, 'SupplierBlockStatusSet', at, `supplier-block-${t}-${e.ref}-true-${at}`, { supplierId: e.ref, blocked: true, reason: why, by: record.requestedBy, at }, 'api/purchase'));
        } else if (e.kind === 'price') {
          const [productId, storeId] = e.ref.split('@') as [string, string];
          const mine = (await priceEntries(input)(t, productId)).filter((x) => x.scope === 'store' && x.scopeRef === storeId).sort((a, b) => a.version - b.version);
          const idx = mine.findIndex((x) => x.id === `import-${record.jobId}-${storeId}`);
          const before = mine.slice(0, idx < 0 ? mine.length : idx).filter((x) => x.status === 'active').at(-1);
          if (before === undefined) continue; // refused before here (`blocksRollback`): never left with no price
          const back: PriceEntry = { ...before, id: `rollback-${record.jobId}-${storeId}`, effectiveFrom: await shopClock(input.calendar).dateOf(t, at), effectiveTo: null, status: 'active', version: (mine.at(-1)?.version ?? 0) + 1 };
          out.push(entry(STREAM.pricing, `pricechange-rollback-${record.jobId}-${productId}-${storeId}`, 'PriceChangeRecorded', at, `pricechange-${t}-rollback-${record.jobId}-${productId}-${storeId}`, { id: `price-${productId}`, productId, priceMinor: before.price.minor, currency: before.price.currency, setBy: record.requestedBy, verdict: 'ok', approvedBy: record.approvedBy, reason: why, at, operativeAt: [storeId] }, 'api/pricing'));
          out.push(entry(DATA_IN_STREAMS.priceList(productId), `price-entry-${productId}-${back.id}`, 'PriceListEntryPublished', at, `price-entry-${t}-${productId}-${back.id}`, { ...back, price: money(before.price.minor, before.price.currency) }, 'api/pricing'));
        } else if (e.kind === 'opening_stock') {
          const m = (await stockMovements(input)(t)).find((x) => x.movementId === e.ref);
          if (m === undefined) continue;
          const reversed: Movement = { ...m, movementId: `${m.movementId}-reversed`, kind: 'opening_reversed', occurredAt: at, enteredBy: record.requestedBy, approvedBy: record.approvedBy, reason: why };
          out.push(entry(STREAM.inventory, `mv-${reversed.movementId}`, 'InventoryMoved', at, `mv-${t}-${reversed.movementId}`, reversed, 'api/inventory'));
        } else if (e.kind === 'customer') {
          const history = await memberHistory(input)(t, e.ref);
          const now = history.at(-1);
          if (now === undefined || now.status === 'left') continue;
          const left: MemberRecord = { ...now, status: 'left', leftAt: at, leftBy: record.requestedBy, leftReason: why };
          const key = `${e.ref}:left:import-rollback-${record.jobId}`;
          out.push(entry(DATA_IN_STREAMS.members, `loyalty-member-${key}`, 'LoyaltyMember', at, `loyalty-member-${t}-${key}`, left, 'api/customer'));
        } else if (e.kind === 'loyalty_opening') {
          const memberRef = e.ref.replace(/^import-.*-opening-/, '');
          const opening = (await pointsMovements(input)(t, memberRef)).find((x) => x.movementId === e.ref);
          if (opening === undefined) continue;
          const back: RecordedPointsMovement = { movementId: `${e.ref}-reversed`, customerId: memberRef, delta: -opening.delta, reason: 'reversal', sourceRef: why, at };
          out.push(entry(DATA_IN_STREAMS.points(memberRef), `points-${back.movementId}`, 'PointsMovement', at, `points-${t}-${back.movementId}`, back, 'api/customer'));
        }
      }
      out.push(entry(DATA_IN_STREAMS.imports, `data-import-rollback-${record.jobId}`, 'ImportRolledBack', at, `data-import-rollback-${t}-${record.jobId}`, record, 'api/purchase'));
      await input.store.appendBatch(t, out);
    },
    dryRuns: (t) => payloadsOf<ImportDryRunRecord>(input.store, t, DATA_IN_STREAMS.dryRuns, 'ImportDryRunRecorded'),
    recordDryRun: async (t, record) => {
      await input.store.append(t, DATA_IN_STREAMS.dryRuns, makeEvent({ id: `import-dry-run-${record.runId}`, type: 'ImportDryRunRecorded', occurredAt: record.at, idempotencyKey: `import-dry-run-${t}-${record.runId}`, source: 'api/purchase', payload: record as unknown as Record<string, unknown> }));
    },
  };
}


// ── data out (audit-4 M30-FR-02): the further export domains, each from its own register ────────────────────────────

const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v));
const latestBy = <T>(xs: readonly T[], key: (x: T) => string): T[] => [...xs.reduce((m, x) => m.set(key(x), x), new Map<string, T>()).values()];

/** The further export domains' rows (OB-288 P2 · M30-FR-02) — each the register its own domain writes, never a copy. */
export function dataOutDomains(input: Base): readonly ExportDomainSource[] {
  const { store } = input;
  const read = async (t: string, stream: string, type: string, window?: { from: string; to: string }): Promise<Record<string, unknown>[]> =>
    (await store.readStream(t, stream, { type, ...(window === undefined ? {} : window) })).map((e) => e.event.payload as Record<string, unknown>);
  return moreExportDomains({
    'price-lists': async (t) => {
      const out: Record<string, string>[] = [];
      for (const p of await productMasterAdapter(input).products(t)) {
        for (const e of await priceEntries(input)(t, p.productId)) {
          out.push({
            entryId: e.id, productId: e.productId, scope: e.scope, store: e.scope === 'store' ? e.scopeRef : '', scopeRef: e.scopeRef,
            priceMinor: str(e.price.minor), currency: e.price.currency, effectiveFrom: e.effectiveFrom, effectiveTo: str(e.effectiveTo), status: e.status,
            version: str(e.version), batchId: str(e.batchId),
          });
        }
      }
      return out;
    },
    promotions: async (t) => (await read(t, STREAM.promotions, 'PromotionLaunched')).map((r) => ({
      promotionId: str(r['promotionId']), verdict: str(r['verdict']), incrementalMarginMinor: str(r['incrementalMarginMinor']), currency: str(r['currency']),
      proposedBy: str(r['proposedBy']), approvedBy: str(r['approvedBy']), launchedAt: str(r['launchedAt']), detail: str(r['detail']),
    })),
    'goods-receipts': async (t) => latestBy(await read(t, streamName(STREAM.purchase, 'grn'), 'GoodsReceived'), (r) => str(r['grnId'])).map((r) => {
      const captured = (r['captured'] ?? {}) as { lines?: readonly unknown[] };
      return {
        grnId: str(r['grnId']), number: str(r['number']), poId: str(r['poId']), store: str(r['warehouseId']), receivedBy: str(r['receivedBy']), receivedAt: str(r['receivedAt']),
        lines: str(captured.lines?.length ?? 0), availableMinor: str(r['availableMinor']), heldMinor: str(r['heldMinor']),
      };
    }),
    'supplier-invoices': async (t) => {
      const withdrawn = new Set((await read(t, STREAM_FOR.supplierInvoices, INVOICE_WITHDRAWN)).map((w) => str(w['invoiceId'])));
      return latestBy(await read(t, STREAM_FOR.supplierInvoices, 'SupplierInvoiceCaptured'), (r) => str(r['invoiceId'])).map((r) => ({
        invoiceId: str(r['invoiceId']), supplierId: str(r['supplierId']), poId: str(r['poId']), lines: str((r['lines'] as readonly unknown[] | undefined)?.length ?? 0),
        totalMinor: str(r['totalMinor']), declaredTotalMinor: str(r['declaredTotalMinor']), capturedBy: str(r['capturedBy']), capturedAt: str(r['capturedAt']),
        approvedBy: str(r['approvedBy']), source: str(r['source']), withdrawn: withdrawn.has(str(r['invoiceId'])) ? 'yes' : 'no',
      }));
    },
    returns: async (t) => latestBy(await read(t, STREAM.returns, 'ReturnRecorded'), (r) => str(r['returnId'])).map((r) => ({
      returnId: str(r['returnId']), number: str(r['number']), originalSaleId: str(r['originalSaleId']), store: str(r['locationId']),
      processedBy: str(r['processedBy']), processedAt: str(r['processedAt']), reasonCode: str(r['reasonCode']), refundMinor: str(r['refundMinor']),
      refundTender: str(r['refundTender']), refundStatus: str(r['refundStatus']), lines: str((r['lines'] as readonly unknown[] | undefined)?.length ?? 0),
    })),
    'stock-movements': async (t, period) => {
      if (period === undefined) return [];
      // The window is on the ledger's own time — first instant of the first day to the last instant of the last (UTC days).
      const from = `${period.from}T00:00:00.000Z`; const to = new Date(Date.parse(`${period.to}T00:00:00.000Z`) + 86_400_000 - 1).toISOString();
      return (await read(t, STREAM.inventory, 'InventoryMoved', { from, to })).map((m) => ({
        movementId: str(m['movementId']), occurredAt: str(m['occurredAt']), productId: str(m['productId']), store: str(m['locationId']), kind: str(m['kind']),
        quantityMinor: str(m['quantityMinor']), uom: str(m['uom']), unitCostMinor: str(m['unitCostMinor']), batchId: str(m['batchId']), expiry: str(m['expiry']),
        reason: str(m['reason']), enteredBy: str(m['enteredBy']), approvedBy: str(m['approvedBy']),
      }));
    },
    transfers: async (t) => (await transfersAdapter(input).transfers!(t)).map((x) => ({
      transferId: x.transferId, from: x.fromLocationId, to: x.toLocationId, state: x.state, lines: str(x.lines.length),
      quantities: x.lines.map((l) => `${(l as { productId?: string }).productId ?? ''}:${(l as { quantityMinor?: number }).quantityMinor ?? ''}`).join(';'),
      requestedBy: x.requestedBy, approvedBy: str(x.approvedBy), dispatchedAt: str(x.dispatchedAt), receivedAt: str(x.receivedAt), receivedBy: str(x.receivedBy),
    })),
    'stock-counts': async (t) => {
      const counts = streamName(STREAM.inventory, 'counts');
      const all = [...await read(t, counts, 'CountReconciled'), ...await read(t, counts, 'CountDecided')];
      return latestBy(all, (r) => str(r['countId'])).map((r) => ({
        countId: str(r['countId']), productId: str(r['productId']), store: str(r['locationId']), expectedMinor: str(r['expectedMinor']), countedMinor: str(r['countedMinor']),
        varianceMinor: str(r['varianceMinor']), valueMinor: str(r['valueMinor']), reasonCode: str(r['reasonCode']), adjusted: r['adjusted'] === true ? 'yes' : 'no',
        counterId: str(r['counterId']), approvedBy: str(r['approvedBy']), at: str(r['at']),
      }));
    },
    'till-shifts': async (t) => latestBy(await read(t, streamName(STREAM.cash, 'shifts'), 'TillClosed'), (r) => str(r['shiftId'])).map((r) => ({
      shiftId: str(r['shiftId']), store: str(r['storeId']), till: str(r['tillId']), cashier: str(r['cashierId']), tradingDay: str(r['tradingDay']),
      openingFloatMinor: str(r['openingFloatMinor']), cashSalesMinor: str(r['cashSalesMinor']), pickupsMinor: str(r['pickupsMinor']), cashRefundsMinor: str(r['cashRefundsMinor']),
      expectedMinor: str(r['expectedMinor']), countedMinor: str(r['countedMinor']), varianceMinor: str(r['varianceMinor']), reasonCode: str(r['reasonCode']), closedAt: str(r['closedAt']),
    })),
    'cash-movements': async (t) => {
      // Each till keeps its own cash stream (OB-80: a till is (store, till)); the tills are found from the stores' own lists
      // of tills kept, and — for a till kept before stores were named — from the till closes.
      const closes = await read(t, streamName(STREAM.cash, 'shifts'), 'TillClosed');
      const stores = new Set<string>([...await registeredStores(input, t), ...closes.map((c) => str(c['storeId'])).filter((s) => s !== '')]);
      const out: Record<string, string>[] = [];
      const row = (m: Record<string, unknown>, store: string): Record<string, string> => ({
        movementId: str(m['movementId']), store, till: str(m['tillId']), kind: str(m['kind']), deltaMinor: str(m['deltaMinor']), currency: str(m['currency']),
        custodian: str(m['custodianId']), performedBy: str(m['performedBy']), tradingDay: str(m['tradingDay']), at: str(m['at']),
      });
      for (const store of [...stores].sort()) {
        const tills = [...new Set((await read(t, streamName(STREAM.cash, 'tills-at', store), 'TillKeptAtStore')).map((x) => str(x['tillId'])))].sort();
        for (const till of tills) for (const m of await read(t, streamName(STREAM.cash, 'at', store, till), 'CashMovement')) out.push(row(m, store));
      }
      // A till's own stream (kept by the till alone, before OB-80 or in a one-store business), for every till ever closed.
      const seen = new Set(out.map((r) => `${r['store']}|${r['till']}|${r['movementId']}`));
      for (const till of [...new Set(closes.map((c) => str(c['tillId'])))].sort()) {
        for (const m of await read(t, streamName(STREAM.cash, till), 'CashMovement')) {
          const r = row(m, str(m['storeId']));
          if (!seen.has(`${r['store']}|${r['till']}|${r['movementId']}`)) out.push(r);
        }
      }
      return out;
    },
    'write-offs': async (t) => (await read(t, streamName(STREAM.inventory, 'write-offs'), 'WriteOffCommitted')).map((r) => ({
      writeOffId: str(r['id']), productId: str(r['productId']), store: str(r['locationId']), lossType: str(r['lossType']), quantity: str(r['qtyRemoved']), uom: str(r['uom']),
      valueMinor: str(r['valueMinor']), valueSource: str(r['valueSource']), reasonCode: str(r['reasonCode']), raisedBy: str(r['raisedBy']), approvedBy: str(r['approvedBy']), at: str(r['at']),
    })),
    'waste-records': async (t) => (await wasteAdapter(input).records(t)).map((w) => ({
      wasteId: w.wasteId, store: w.branchId, departmentId: w.departmentId, productId: w.productId, source: w.source, at: w.at,
      valueMinor: str(w.valueMinor), disposal: w.disposal, grams: str(w.grams),
    })),
    'service-cases': async (t) => (await serviceCaseAdapter(input).serviceCases(t)).map((c) => ({
      caseId: c.caseId, kind: c.kind, state: c.state, priority: c.priority, customerRef: c.customerRef, openedAt: c.openedAt, assignedTo: c.assignedTo,
      firstRespondedAt: str(c.firstRespondedAt), resolvedAt: str(c.resolvedAt), orderRef: str(c.orderRef), summary: c.summary, resolution: str(c.resolution),
    })),
  });
}
