// Batch 18c — head-office wiring for S1 (return shelf stock to the supplier) and R2 (correct a saved goods receipt).
// Every register is append-only on its own stream (hard rules #2, #6); every numbered save takes its numbers in the same
// atomic append as the documents (OB-847 / OB-850).

import { makeEvent } from '../../../packages/contracts/src/event';
import type { EventStore } from '../../../packages/persistence/src/event-store';
import { checkDispatchEwb, supplyRouteBetween } from '../../../packages/e-way-bill/src/index';
import { readDocumentNumber } from '../../../packages/numbering/src/document-numbers';
import { appendWithDocumentNumbers } from '../../platform/src/document-numbers-batch';
import { branchOfLocationIn } from '../../inventory/src/location-scope';
import type { ShelfReturnDeps, StoredShelfReturn } from '../../inventory/src/shelf-returns';
import type { DebitNoteIssue } from '../../purchase/src/supplier-account';
import {
  STREAM, streamName, allOf, movementEvent, storeNumberFor, DEBIT_NOTE_ISSUES_STREAM,
  inventoryAdapter, writeOffAdapter, eWayBillAdapter, orgStructureAdapter, foldSupplierRecords,
} from './adapters';

/** S1: the shelf returns register. */
export const SHELF_RETURNS_STREAM = streamName(STREAM.inventory, 'shelf-returns');

const stateOfGstin = (gstin: unknown): string | null => (typeof gstin === 'string' && /^[0-9]{2}/.test(gstin) ? gstin.slice(0, 2) : null);

/** Every shelf return on file (oldest first). */
export const shelfReturnsOf = (store: EventStore, tenantId: string): Promise<readonly StoredShelfReturn[]> =>
  allOf<StoredShelfReturn>(store, tenantId, SHELF_RETURNS_STREAM, 'ShelfStockReturnedToSupplier');

/**
 * S1 (batch 18c · OB-872): the return, its `returned_to_supplier` movement and its issued debit note — ONE append, with the
 * store's `RTS` number and the company's `SDN` number taken together in it.
 */
export function shelfReturnsAdapter(input: { readonly store: EventStore; readonly now: () => string }): Omit<ShelfReturnDeps, 'approvals' | 'recordAudit' | 'locationBranches' | 'countFreeze'> {
  const { store, now } = input;
  const inv = inventoryAdapter(input);
  const wo = writeOffAdapter(input);
  const ewb = eWayBillAdapter(input);
  const org = orgStructureAdapter(input);
  return {
    now,
    returns: (tenantId) => shelfReturnsOf(store, tenantId),
    onHandAt: async (tenantId, productId, locationId, batchId) => {
      if (batchId !== undefined && inv.batches !== undefined) {
        const rows = await inv.batches(tenantId, productId);
        return rows.filter((r) => r.locationId === locationId && r.batchId === batchId).reduce((s, r) => s + r.onHandMinor, 0);
      }
      return (await inv.availability(tenantId, productId)).filter((a) => a.locationId === locationId).reduce((s, a) => s + a.onHandMinor, 0);
    },
    ...(wo.unitCostAt === undefined ? {} : { unitCostAt: wo.unitCostAt }),
    writeOffThreshold: (tenantId) => wo.writeOffThreshold(tenantId),
    supplierStatus: async (tenantId, supplierId) => (await foldSupplierRecords(store, tenantId)).get(supplierId)?.status,
    // The same tested rule as a return from the goods-receipt page: from the place's GST state to the supplier's.
    ewbGate: async (tenantId, g) => {
      const nodes = await org.nodes(tenantId);
      const branchOf = branchOfLocationIn(nodes);
      const own = nodes.find((n) => n.nodeId === g.locationId)?.gstin;
      const fromState = stateOfGstin(own ?? nodes.find((n) => n.nodeId === branchOf(g.locationId))?.gstin);
      const toState = stateOfGstin((await foldSupplierRecords(store, tenantId)).get(g.supplierId)?.gstin);
      const held = await ewb.load(tenantId, g.movementId);
      return checkDispatchEwb({
        movementId: g.movementId, consignmentValueMinor: g.valueMinor, unvaluedLines: 0, supplyRoute: supplyRouteBetween(fromState, toState),
        ewb: held === undefined ? undefined : { state: held.state, ...(held.ewbNo === undefined ? {} : { ewbNo: held.ewbNo }) },
      });
    },
    recordShelfReturn: async (tenantId, rec) => {
      const place = await storeNumberFor(store, now, tenantId, rec.locationId);
      const numbers = await appendWithDocumentNumbers(store, tenantId, {
        docs: [
          { range: { kind: 'return_to_supplier', storeNumber: place.storeNumber, ...(place.storeId === undefined ? {} : { storeId: place.storeId }) }, documentRef: `shelf/${rec.returnId}` },
          { range: { kind: 'supplier_debit_note' }, documentRef: `${rec.supplierId}/${rec.debitNote.debitNoteRef}` },
        ],
        at: rec.at,
        entries: ([rts, sdn]) => {
          const issue: DebitNoteIssue = {
            debitNoteRef: rec.debitNote.debitNoteRef, supplierId: rec.supplierId, number: sdn ?? '', seq: readDocumentNumber(sdn ?? '')?.count ?? 0,
            valueMinor: rec.debitNote.valueMinor, issuedBy: rec.approvedBy ?? rec.raisedBy, issuedAt: rec.at,
          };
          const saved: StoredShelfReturn = {
            ...rec, ...(rts === undefined || rts === '' ? {} : { documentNumber: rts }),
            debitNote: { ...rec.debitNote, ...(sdn === undefined || sdn === '' ? {} : { number: sdn }) },
          };
          return [
            { stream: SHELF_RETURNS_STREAM, event: makeEvent({
              id: `shelf-return-${rec.returnId}`, type: 'ShelfStockReturnedToSupplier', occurredAt: rec.at,
              idempotencyKey: `shelf-return-${tenantId}-${rec.returnId}`, source: 'api/inventory', payload: saved,
            }) },
            movementEvent(tenantId, {
              movementId: rec.movementId, productId: rec.productId, locationId: rec.locationId, kind: 'returned_to_supplier',
              quantityMinor: rec.quantityMinor, uom: rec.uom, occurredAt: rec.at, reason: `return to supplier ${rec.supplierId}: ${rec.reason}`,
              enteredBy: rec.raisedBy, ...(rec.approvedBy === null ? {} : { approvedBy: rec.approvedBy }), ...(rec.batchId === undefined ? {} : { batchId: rec.batchId }),
            }),
            { stream: DEBIT_NOTE_ISSUES_STREAM, event: makeEvent({
              id: `dn-issue-${rec.debitNote.debitNoteRef}`, type: 'SupplierDebitNoteIssued', occurredAt: rec.at,
              idempotencyKey: `dn-issue-${tenantId}-${rec.supplierId}-${rec.debitNote.debitNoteRef}`, source: 'api/purchase', payload: issue,
            }) },
          ];
        },
      });
      const [rts, sdn] = numbers;
      return { ...(rts === null || rts === undefined ? {} : { documentNumber: rts }), ...(sdn === null || sdn === undefined ? {} : { debitNoteNumber: sdn }) };
    },
  };
}
