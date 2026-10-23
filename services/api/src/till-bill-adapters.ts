// Till bill and GST package (OB-288 builders · audit-1 P5: A2, A7, A8, A12, A22 · audit-2 P3: M12-FR-01, M12-FR-02,
// M13-FR-02, M14-FR-04, B8, B10, B12) — head office's wiring for it.
//
// Composition: `tillBillSurface(surface, …)` is the one line in `main.ts`. It adds this package's routes to the surface;
// the stores live in `till-bill-stores.ts`, which `adapters.ts` reads with one registration line where the catalogue pack
// assembly needs them. No route here is new permission: each reuses the code its family already gates by.

import type { EventStore } from '../../../packages/persistence/src/event-store';
import type { Route } from '../../kernel/src/index';
import { cessRateRoutes } from '../../catalogue/src/cess-rates';
import { cessRateStore } from './till-bill-stores';
import { orgStructureAdapter, dayCloseAdapter, storeSettingsAdapter, auditTrailAdapter, saleStockLocationOf, storeOfLane, streamName, STREAM } from './adapters';
import { branchOfLocationIn } from '../../inventory/src/location-scope';
import { gstStateOf } from '../../../packages/finance/src/gst-states';
import { dayEvidenceRoutes, type DayEvidenceDeps } from '../../pos/src/day-evidence';
import type { DayEvidenceFacts } from '../../../packages/day-close/src/evidence-pack';
import type { IncomingSale, SaleException } from '../../pos/src/sale-intake';
import type { ReturnRecord } from '../../pos/src/returns';
import type { ClosedShiftRecord, OverShortReview } from '../../pos/src/shift';
import { makeTradingDayRule, tradingDateOf } from '../../../packages/calendar/src/index';
import { SETTINGS, type TenantSetting } from '../../../packages/tenant/src/settings';

/**
 * A8: the supplier's own GST State for a B2B order — the State of the GSTIN of the store the order is dispatched from (its
 * location's branch), else, when the business has exactly ONE GST registration, that registration's State. Undefined when
 * neither is on record: the invoice then carries no split and says why, rather than a guessed one (P-08).
 */
export function supplierStateCodeOf(input: { readonly store: EventStore; readonly now: () => string }): (tenantId: string, locationId: string | undefined) => Promise<string | undefined> {
  return async (tenantId, locationId) => {
    const org = orgStructureAdapter(input);
    const nodes = await org.nodes(tenantId);
    const branchId = locationId === undefined ? undefined : branchOfLocationIn(nodes)(locationId);
    const branch = branchId === undefined ? undefined : nodes.find((n) => n.nodeId === branchId);
    const fromStore = typeof branch?.gstin === 'string' ? gstStateOf(branch.gstin)?.code : undefined;
    if (fromStore !== undefined) return fromStore;
    const registrations = await org.registrations(tenantId);
    return registrations.length === 1 ? gstStateOf(registrations[0]!.gstin)?.code : undefined;
  };
}

/** A day either side of a trading day, as ISO instants — the window a store-day's facts are read from (bounded, not all history). */
const windowOf = (tradingDay: string): { readonly from: string; readonly to: string } => {
  const at = Date.parse(`${tradingDay}T00:00:00.000Z`);
  return { from: new Date(at - 2 * 86_400_000).toISOString(), to: new Date(at + 3 * 86_400_000).toISOString() };
};

/**
 * M14-FR-04: every recorded fact of one store-day for its evidence pack — the store's closes and reopens of the day, the
 * sales whose trading day it is and whose stock left this store, the refunds processed in it (by the store's own cut-off,
 * India time), the tills' shift closes and their over/short sign-offs, and the exceptions raised on those sales.
 */
export function dayEvidenceFacts(input: { readonly store: EventStore; readonly now: () => string }): DayEvidenceDeps['facts'] {
  return async (tenantId, storeId, tradingDay) => {
    const { store } = input;
    const org = orgStructureAdapter(input);
    const nodes = await org.nodes(tenantId);
    const branchOf = branchOfLocationIn(nodes);
    const atStore = (locationId: string | undefined): boolean => locationId !== undefined && (locationId === storeId || branchOf(locationId) === storeId);
    const dc = dayCloseAdapter(input);
    const closes = (await dc.dayCloses(tenantId)).filter((c) => c.storeId === storeId && c.tradingDay === tradingDay);
    const closeIds = new Set(closes.map((c) => c.dayCloseId));
    const reopens = (await dc.dayReopens(tenantId)).filter((r) => closeIds.has(r.dayCloseId));
    const w = windowOf(tradingDay);

    const sales: IncomingSale[] = [];
    for (const e of await store.readStream(tenantId, STREAM.sales, { type: 'SaleCommitted', from: w.from, to: w.to })) {
      const sale = e.event.payload as IncomingSale;
      if (sale.tradingDay !== tradingDay) continue;
      if (atStore((await saleStockLocationOf(store, tenantId, sale)).locationId)) sales.push(sale);
    }
    const saleIds = new Set(sales.map((s) => s.saleId));

    const cutoff = (await storeSettingsAdapter(input).settings(tenantId, storeId))?.tradingDayCutoff ?? '00:00';
    const rule = makeTradingDayRule(cutoff);
    const refunds: ReturnRecord[] = [];
    for (const e of await store.readStream(tenantId, STREAM.returns, { type: 'ReturnRecorded', from: w.from, to: w.to })) {
      const r = e.event.payload as ReturnRecord;
      if (tradingDateOf(r.processedAt, rule, 'Asia/Kolkata') !== tradingDay) continue;
      let here = atStore(r.locationId);
      if (!here && r.locationId === undefined && r.originalSaleId !== null) {
        const held = await store.findByIdempotencyKey(tenantId, `sale-${tenantId}-${r.originalSaleId}`);
        here = held !== undefined && atStore((await saleStockLocationOf(store, tenantId, held.event.payload as IncomingSale)).locationId);
      }
      if (here) refunds.push(r);
    }

    const shiftStream = streamName(STREAM.cash, 'shifts');
    const reviews = new Map((await store.readStream(tenantId, shiftStream, { type: 'ShiftOverShortReviewed' })).map((e) => { const r = e.event.payload as OverShortReview; return [r.shiftId, r] as const; }));
    const shifts: DayEvidenceFacts['shifts'][number][] = [];
    for (const e of await store.readStream(tenantId, shiftStream, { type: 'TillClosed' })) {
      const s = e.event.payload as ClosedShiftRecord;
      if (s.tradingDay !== tradingDay) continue;
      if ((s.storeId ?? await storeOfLane(store, tenantId, s.tillId)) !== storeId) continue;
      const review = reviews.get(s.shiftId);
      shifts.push({
        shiftId: s.shiftId, tillId: s.tillId, cashierId: s.cashierId, closedAt: s.closedAt, expectedMinor: s.expectedMinor, countedMinor: s.countedMinor,
        varianceMinor: s.varianceMinor, exceptionRaised: s.exceptionRaised, reasonCode: s.reasonCode,
        ...(review === undefined ? {} : { review: { reviewedBy: review.reviewedBy, disposition: review.disposition, reviewedAt: review.reviewedAt } }),
      });
    }

    const saleExceptions = (await store.readStream(tenantId, STREAM.saleExceptions, { type: 'SaleExceptionRaised' }))
      .map((e) => e.event.payload as SaleException).filter((x) => saleIds.has(x.saleId))
      .map((x) => ({ saleId: x.saleId, kind: x.kind, severity: x.severity, detail: x.detail, ...(x.differenceMinor === undefined ? {} : { differenceMinor: x.differenceMinor }) }));
    const name = nodes.find((n) => n.nodeId === storeId)?.name;

    return {
      storeId, ...(typeof name === 'string' ? { storeName: name } : {}), tradingDay,
      closes: closes.map((c) => ({ dayCloseId: c.dayCloseId, closedBy: c.closedBy, closedAt: c.closedAt, ...(c.governanceFlags === undefined ? {} : { governanceFlags: c.governanceFlags }), ...(c.carriedForward === undefined ? {} : { carriedForward: c.carriedForward }) })),
      reopens: reopens.map((r) => ({ dayCloseId: r.dayCloseId, reopenedBy: r.reopenedBy, approvedBy: r.approvedBy, reason: r.reason, reopenedAt: r.reopenedAt, governanceFlags: r.governanceFlags })),
      sales: sales.map((s) => ({ saleId: s.saleId, receiptNumber: s.receiptNumber, laneId: s.laneId, cashierId: s.cashierId, committedAt: s.committedAt, totalMinor: s.totalMinor, tenders: s.tenders.map((t) => ({ kind: t.kind, amountMinor: t.amountMinor })) })),
      refunds: refunds.map((r) => ({
        returnId: r.returnId, number: r.number, originalSaleId: r.originalSaleId, processedBy: r.processedBy, processedAt: r.processedAt, refundMinor: r.refundMinor,
        refundTender: r.refundTender, reasonCode: r.reasonCode, ...(r.approvedBy === undefined ? {} : { approvedBy: r.approvedBy }),
        ...(r.governanceFlags === undefined || r.governanceFlags.length === 0 ? {} : { governanceFlags: r.governanceFlags.map((f) => (typeof f === 'string' ? f : String((f as { code?: unknown }).code ?? JSON.stringify(f)))) }),
      })),
      shifts, saleExceptions,
    };
  };
}

export function tillBillSurface(surface: Route[], input: { readonly store: EventStore | undefined; readonly now: () => string }): void {
  const { store, now } = input;
  // A7: the compensation-cess schedule per HSN — what the pack carries to the tills, signed.
  surface.push(...cessRateRoutes(store === undefined ? { setCess: () => {}, schedule: () => [] } : cessRateStore({ store, now })));
  // M14-FR-04: the closed-day evidence pack (sales, tenders, cash, over/short, exceptions, reopen history), sealed, for the CA.
  // With no store (a bare surface) the route is still served — and documented — and finds no close (404).
  if (store === undefined) {
    surface.push(...dayEvidenceRoutes({ now, closeOf: async () => undefined, facts: async (_t, storeId, tradingDay) => ({ storeId, tradingDay, closes: [], reopens: [], sales: [], refunds: [], shifts: [], saleExceptions: [] }) }));
  } else {
    const audit = auditTrailAdapter({ store });
    surface.push(...dayEvidenceRoutes({
      now,
      closeOf: async (tenantId, dayCloseId) => {
        const c = await dayCloseAdapter({ store, now }).dayClose(tenantId, dayCloseId);
        return c === undefined ? undefined : { storeId: c.storeId, tradingDay: c.tradingDay };
      },
      facts: dayEvidenceFacts({ store, now }),
      recordExport: async (tenantId, e) => {
        await audit.recordAudit(tenantId, {
          actorId: e.by, action: 'day_evidence.export', objectType: 'store_day', objectId: `${e.storeId}:${e.tradingDay}`, at: e.at,
          origin: { tenantId, branchId: e.storeId }, before: null, after: { dayCloseId: e.dayCloseId, contentHash: e.contentHash },
        });
      },
    }));
  }
}

/**
 * A22 (OB-326, switched off): the shop's B2C dynamic QR from store setup, for the store pack — on only when the owner
 * switched it on; each detail only when given (an empty answer is "not set", and the till then prints no QR and says so).
 */
export function b2cDynamicQrSettingOf(settings: { value<T>(tenantId: string, setting: TenantSetting<T>): Promise<T> }) {
  return async (tenantId: string): Promise<{ readonly on: boolean; readonly upiId?: string; readonly bankAccountNo?: string; readonly ifsc?: string }> => {
    const on = (await settings.value(tenantId, SETTINGS.INVOICE_B2C_DYNAMIC_QR_ON)) === true;
    if (!on) return { on: false };
    const given = async (s: TenantSetting<string>): Promise<string | undefined> => {
      const v = await settings.value(tenantId, s);
      return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
    };
    const upiId = await given(SETTINGS.INVOICE_B2C_DYNAMIC_QR_UPI_ID);
    const bankAccountNo = await given(SETTINGS.INVOICE_B2C_DYNAMIC_QR_BANK_ACCOUNT);
    const ifsc = await given(SETTINGS.INVOICE_B2C_DYNAMIC_QR_IFSC);
    return { on: true, ...(upiId === undefined ? {} : { upiId }), ...(bankAccountNo === undefined ? {} : { bankAccountNo }), ...(ifsc === undefined ? {} : { ifsc: ifsc.toUpperCase() }) };
  };
}
