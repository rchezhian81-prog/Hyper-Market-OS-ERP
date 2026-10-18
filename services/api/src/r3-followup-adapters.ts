// R3 follow-up (owner decisions OB-193 to OB-200, 18 Oct 2026) — head-office wiring that is not a lane's own. Each
// register is append-only on its own stream (hard rules #2, #6); reads fold the streams.
//
//   • OB-194 (A23): the supplier-return dispatch gate and register, spread into the goods-receipt deps in main.ts.
//   • OB-196 (D-11): the ONE `debit_note` series the supplier master and the DSD door both number from.

import { makeEvent } from '../../../packages/contracts/src/event';
import type { EventStore } from '../../../packages/persistence/src/event-store';
import { InMemoryNumberSeriesStore, type NumberSeriesStore } from '../../../packages/persistence/src/number-series-store';
import { checkDispatchEwb, supplyRouteBetween } from '../../../packages/e-way-bill/src/index';
import { branchOfLocationIn } from '../../inventory/src/location-scope';
import type { GoodsReceiptDeps, SupplierReturnDispatch } from '../../inventory/src/goods-receipt';
import { STREAM, streamName, eWayBillAdapter, orgStructureAdapter, purchaseOrdersAdapter, supplierMasterAdapter } from './adapters';

// ── OB-194 · A23 · a supplier return above the threshold leaves only under a generated e-way bill ─────────────────

const RETURN_DISPATCHES = streamName(STREAM.purchase, 'supplier-return-dispatches');

/** The GST state code a GSTIN starts with, or null when there is none to read. */
const stateOfGstin = (gstin: unknown): string | null => (typeof gstin === 'string' && /^[0-9]{2}/.test(gstin) ? gstin.slice(0, 2) : null);

/**
 * The hook spread into the goods-receipt deps (`goodsReceiptRoutes`): the e-way-bill gate for a supplier return — from the
 * receipt's warehouse (its own GST registration, else its branch's) to the supplier on the receipt's order (the supplier
 * master's GSTIN); either not known → the lower, inter-State threshold, said (Lane 2's `checkDispatchEwb`) — and the
 * append-only register of dispatches, one per return.
 */
export function supplierReturnDispatchHooks(input: { readonly store: EventStore; readonly now: () => string }): Pick<GoodsReceiptDeps, 'supplierReturnEwb'> {
  const { store, now } = input;
  const ewb = eWayBillAdapter(input);
  const org = orgStructureAdapter(input);
  return {
    supplierReturnEwb: {
      gate: async (tenantId, rec, movementId, valueMinor) => {
        const nodes = await org.nodes(tenantId);
        const branchOf = branchOfLocationIn(nodes);
        const own = nodes.find((n) => n.nodeId === rec.warehouseId)?.gstin;
        const fromState = stateOfGstin(own ?? nodes.find((n) => n.nodeId === branchOf(rec.warehouseId))?.gstin);
        const supplierId = rec.poId === null ? undefined : (await purchaseOrdersAdapter({ store, now }).order(tenantId, rec.poId))?.supplierId;
        const toState = supplierId === undefined ? null : stateOfGstin((await supplierMasterAdapter({ store, now }).record(tenantId, supplierId))?.gstin);
        const held = await ewb.load(tenantId, movementId);
        return checkDispatchEwb({
          movementId, consignmentValueMinor: valueMinor, unvaluedLines: 0, supplyRoute: supplyRouteBetween(fromState, toState),
          ewb: held === undefined ? undefined : { state: held.state, ...(held.ewbNo === undefined ? {} : { ewbNo: held.ewbNo }) },
        });
      },
      dispatches: async (tenantId, grnId) =>
        (await store.readStream(tenantId, RETURN_DISPATCHES, { type: 'SupplierReturnDispatched' })).map((e) => e.event.payload as SupplierReturnDispatch).filter((d) => d.grnId === grnId),
      recordDispatch: async (tenantId, d) => {
        await store.append(tenantId, RETURN_DISPATCHES, makeEvent({
          id: `supplier-return-dispatch-${d.grnId}-${d.target}`, type: 'SupplierReturnDispatched', occurredAt: d.dispatchedAt,
          // One dispatch per return: a retry collapses to the first.
          idempotencyKey: `supplier-return-dispatch-${tenantId}-${d.grnId}-${d.target}`, source: 'api/inventory', payload: d,
        }));
      },
    },
  };
}

// ── OB-196 · D-11 · one debit-note series ──────────────────────────────────────────────────────────────────────────

/**
 * The series both the supplier master's issued debit notes and the DSD door's draw from: the durable one main.ts was given
 * (PostgreSQL in production), else ONE in-process series shared by both — so the two never hand out the same number.
 */
export function oneDebitNoteSeries(given: NumberSeriesStore | undefined): NumberSeriesStore {
  return given ?? new InMemoryNumberSeriesStore();
}
