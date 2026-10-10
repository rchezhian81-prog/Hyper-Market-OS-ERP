// The records a business document is issued FROM (audit PA-09 · M31-FR-02), read where they already live — never
// forked, never re-modelled here:
//
//   purchase_order     ← the purchase-order register (`foldPurchaseOrders`): a PROPOSED order is a draft and is refused;
//                        its own number; its lines at cost (OB-31: smallest steps × per-whole-unit cost); no tax.
//   goods_receipt      ← the goods-receipt register: a receipt whose over-delivery is still waiting for a second person's
//                        decision is not final; its own number; what arrived, at what it cost.
//   sale               ← the banked sale (a tax invoice): its receipt number; each line's GST from the rate the lane
//                        FROZE on it at the time of supply — a line without one is refused, never filled with today's rate.
//   supplier_statement ← the supplier's account (`foldSupplierAccount`), as at today; no number of its own → allocated.
//   customer_statement ← the B2B customer's receivables, aged as at the date asked (`ageReceivables`); allocated number.
//
// Each answer carries a VERSION — a fingerprint of exactly what was read — so a record that changes later is a different
// document, and the one already issued keeps what it said. Reprints are kept here too: append-only, for ever.

import { createHash } from 'node:crypto';
import type { EventStore } from '../../../packages/persistence/src/event-store';
import { InMemoryNumberSeriesStore, type NumberSeriesStore } from '../../../packages/persistence/src/number-series-store';
import { makeEvent } from '../../../packages/contracts/src/event';
import { valueAtUnitCost } from '../../../packages/contracts/src/quantity';
import { splitInclusive } from '../../../packages/finance/src/day-book';
import { ageReceivables } from '../../../packages/b2b/src/collections';
import type { FrozenLine } from '../../../packages/documents/src/index';
import type { IncomingSale } from '../../pos/src/sale-intake';
import type { DocumentsDeps, DocumentSourceType, ResolvedSource, DocumentReprint } from '../../platform/src/documents';
import { branchOfLocationIn } from '../../inventory/src/location-scope';
import { accountRegisters, foldSupplierAccount } from '../../purchase/src/supplier-account';
import {
  STREAM, foldPurchaseOrders, goodsReceiptAdapter, orgStructureAdapter, deviceRegistryAdapter, supplierAccountAdapter,
  b2bCollectionsAdapter,
} from './adapters';

/** A stable text for any JSON value (object keys sorted), so the same record always fingerprints the same. */
function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}
const versionOf = (record: unknown): string => createHash('sha256').update(canonical(record), 'utf8').digest('hex').slice(0, 16);
const rupees = (minor: number): string => `Rs ${(minor < 0 ? '-' : '')}${Math.floor(Math.abs(minor) / 100)}.${String(Math.abs(minor) % 100).padStart(2, '0')}`;
const lineText = (lines: readonly FrozenLine[]): string =>
  lines.map((l) => `${l.productId} ${l.quantityMinor} ${l.uom} @ ${rupees(l.unitPriceMinor)} = ${rupees(l.lineTotalMinor)}${l.taxRateBps === undefined ? '' : ` (GST ${l.taxRateBps / 100}%: ${rupees(l.taxMinor ?? 0)})`}`).join('; ');

const missing = (detail: string): ResolvedSource => ({ outcome: 'missing', detail });

export function documentSourcesAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
  readonly numberSeries?: NumberSeriesStore;
}): Required<Pick<DocumentsDeps, 'resolveSource' | 'allocateNumber' | 'reprints' | 'recordReprint'>> {
  const { store, now } = input;
  const numberSeries = input.numberSeries ?? new InMemoryNumberSeriesStore();
  const branchOfPlace = async (tenantId: string): Promise<(locationId: string) => string | null> => {
    const nodes = await orgStructureAdapter({ store, now }).nodes(tenantId);
    const placed = branchOfLocationIn(nodes);
    const branches = new Set(nodes.filter((n) => n.kind === 'branch').map((n) => n.nodeId));
    return (locationId) => { const b = placed(locationId); return branches.has(b) ? b : null; };
  };

  const resolvers: Record<DocumentSourceType, (tenantId: string, id: string, asAt: string) => Promise<ResolvedSource>> = {
    purchase_order: async (tenantId, id) => {
      const po = (await foldPurchaseOrders(store, tenantId)).get(id);
      if (po === undefined) return missing(`There is no purchase order ${id}.`);
      if (po.status !== 'issued') return { outcome: 'not_final', detail: `Purchase order ${po.number} is still ${po.status} — not approved, so it is not a purchase order a supplier can be sent.` };
      const lines: FrozenLine[] = po.lines.map((l) => {
        const uom = l.uom ?? 'ea';
        return { productId: l.productId, quantityMinor: l.orderedQty, uom, unitPriceMinor: l.unitCost.minor, lineTotalMinor: valueAtUnitCost(l.orderedQty, uom, l.unitCost.minor) };
      });
      const branchId = po.deliverToLocationId === undefined ? null : (await branchOfPlace(tenantId))(po.deliverToLocationId);
      return {
        outcome: 'ready', id: po.poId, version: versionOf(po), number: po.number, branchId, subjectRef: `purchase_order:${po.poId}`,
        fields: {
          number: po.number, supplierId: po.supplierId, deliverTo: po.deliverToLocationId ?? 'store not named', issuedAt: po.issuedAt ?? '',
          approvedBy: po.approvedBy ?? '', total: rupees(po.totalMinor), lines: lineText(lines),
        },
        figures: { currency: po.currency, totalMinor: po.totalMinor, taxMinor: null, lines },
      };
    },

    goods_receipt: async (tenantId, id) => {
      const grn = (await goodsReceiptAdapter({ store, now }).all(tenantId)).find((g) => g.grnId === id);
      if (grn === undefined) return missing(`There is no goods receipt ${id}.`);
      if (grn.heldMinor > 0 && grn.excessDecision === undefined) {
        return { outcome: 'not_final', detail: `Goods receipt ${grn.number} holds an over-delivery still waiting for a second person's decision.` };
      }
      const lines: FrozenLine[] = grn.captured.lines.map((l) => {
        const received = l.sellableMinor + l.quarantinedMinor + l.heldMinor;
        return { productId: l.productId, quantityMinor: received, uom: l.uom, unitPriceMinor: l.unitCost.minor, lineTotalMinor: valueAtUnitCost(received, l.uom, l.unitCost.minor) };
      });
      const total = lines.reduce((s, l) => s + l.lineTotalMinor, 0);
      const currency = grn.captured.lines[0]?.unitCost.currency ?? 'INR';
      return {
        outcome: 'ready', id: grn.grnId, version: versionOf(grn), number: grn.number, branchId: (await branchOfPlace(tenantId))(grn.warehouseId),
        subjectRef: `goods_receipt:${grn.grnId}`,
        fields: {
          number: grn.number, purchaseOrder: grn.poId ?? 'none', receivedAt: grn.receivedAt, receivedBy: grn.receivedBy,
          warehouse: grn.warehouseId, total: rupees(total), lines: lineText(lines),
        },
        figures: { currency, totalMinor: total, taxMinor: null, lines },
      };
    },

    sale: async (tenantId, id) => {
      const held = await store.findByIdempotencyKey(tenantId, `sale-${tenantId}-${id}`);
      if (held === undefined) return missing(`There is no banked sale ${id}.`);
      const sale = held.event.payload as IncomingSale;
      const unrated = sale.lines.filter((l) => l.taxRateBps === undefined);
      if (unrated.length > 0) {
        return { outcome: 'incomplete', detail: `Sale ${sale.receiptNumber} has ${unrated.length} line(s) that do not carry the GST rate they were sold at, so a tax invoice cannot state its tax.` };
      }
      const lines: FrozenLine[] = sale.lines.map((l) => ({
        productId: l.productId, quantityMinor: l.quantityMinor, uom: l.uom, unitPriceMinor: l.unitPriceMinor,
        lineTotalMinor: l.lineTotalMinor, taxRateBps: l.taxRateBps!, taxMinor: splitInclusive(l.lineTotalMinor, l.taxRateBps!).tax,
      }));
      const taxMinor = lines.reduce((s, l) => s + (l.taxMinor ?? 0), 0);
      const place = sale.locationId ?? (await deviceRegistryAdapter({ store, now }).fleet(tenantId)).find((d) => d.deviceId === sale.laneId)?.branchId;
      return {
        outcome: 'ready', id: sale.saleId, version: versionOf(sale), number: sale.receiptNumber,
        branchId: place === undefined ? null : (await branchOfPlace(tenantId))(place), subjectRef: `sale:${sale.saleId}`,
        fields: {
          number: sale.receiptNumber, soldAt: sale.committedAt, tradingDay: sale.tradingDay, lane: sale.laneId,
          total: rupees(sale.totalMinor), tax: rupees(taxMinor), taxable: rupees(sale.totalMinor - taxMinor), lines: lineText(lines),
        },
        figures: { currency: sale.currency, totalMinor: sale.totalMinor, taxMinor, lines },
      };
    },

    supplier_statement: async (tenantId, supplierId, asAt) => {
      if (asAt !== now().slice(0, 10)) {
        return { outcome: 'incomplete', detail: `A supplier's statement is drawn as at today (${now().slice(0, 10)}); head office keeps no account as at ${asAt}.` };
      }
      const regs = await accountRegisters(supplierAccountAdapter({ store, now }), tenantId);
      const known = regs.invoices.some((i) => i.supplierId === supplierId) || regs.orders.some((o) => o.supplierId === supplierId)
        || (regs.payments ?? []).some((p) => p.supplierId === supplierId);
      if (!known) return missing(`No register names a supplier ${supplierId}.`);
      const account = foldSupplierAccount({ ...regs, supplierId });
      const { asAt: _drawnAt, ...content } = account;
      void _drawnAt;
      const t = account.totals;
      return {
        outcome: 'ready', id: supplierId, version: versionOf(content), number: null, numberSeries: { series: 'supplier_statement', prefix: 'SST' },
        branchId: null, subjectRef: `supplier:${supplierId}`,
        fields: {
          supplierId, asAt, invoiced: rupees(t.invoicedMinor), debitNotes: rupees(t.debitNotesMinor), paid: rupees(t.paidMinor),
          withheld: rupees(t.withheldMinor), owed: rupees(t.owedMinor),
        },
        figures: {
          currency: account.currency, totalMinor: t.owedMinor, taxMinor: null, lines: [],
          amounts: { invoicedMinor: t.invoicedMinor, accruedMinor: t.accruedMinor, withheldMinor: t.withheldMinor, debitNotesMinor: t.debitNotesMinor, paidMinor: t.paidMinor, owedMinor: t.owedMinor },
        },
      };
    },

    customer_statement: async (tenantId, customerId, asAt) => {
      const invoices = await b2bCollectionsAdapter({ store, now }).invoices(tenantId, customerId);
      if (invoices.length === 0) return missing(`No invoices have been recorded for customer ${customerId}; there is no statement to send.`);
      const ageing = ageReceivables({ customerId, invoices, asAt });
      const invoicedMinor = invoices.reduce((s, i) => s + i.grossMinor, 0);
      const settledMinor = invoices.reduce((s, i) => s + i.settledMinor, 0);
      return {
        outcome: 'ready', id: customerId, version: versionOf({ invoices, asAt }), number: null, numberSeries: { series: 'customer_statement', prefix: 'CST' },
        branchId: null, subjectRef: `customer:${customerId}`,
        fields: {
          customerId, asAt, invoiced: rupees(invoicedMinor), settled: rupees(settledMinor), outstanding: rupees(ageing.totalOutstandingMinor),
          overdue: rupees(ageing.overdueMinor), disputed: rupees(ageing.disputedMinor),
        },
        figures: {
          currency: 'INR', totalMinor: ageing.totalOutstandingMinor, taxMinor: null, lines: [],
          amounts: { invoicedMinor, settledMinor, outstandingMinor: ageing.totalOutstandingMinor, overdueMinor: ageing.overdueMinor, disputedMinor: ageing.disputedMinor },
        },
      };
    },
  };

  return {
    resolveSource: (tenantId, type, id, asAt) => resolvers[type](tenantId, id, asAt),
    allocateNumber: (tenantId, series) => numberSeries.allocate(tenantId, series),
    reprints: async (tenantId, documentId) =>
      (await store.readStream(tenantId, STREAM.documents, { type: 'DocumentReprinted' }))
        .map((e) => e.event.payload as DocumentReprint).filter((r) => r.documentId === documentId),
    recordReprint: async (tenantId, r) => {
      await store.append(tenantId, STREAM.documents, makeEvent({
        id: `doc-reprint-${r.documentId}-${r.copyNumber}`, type: 'DocumentReprinted', occurredAt: r.reprintedAt,
        idempotencyKey: `doc-reprint-${tenantId}-${r.documentId}-${r.copyNumber}`, source: 'api/platform', payload: r,
      }));
    },
  };
}
