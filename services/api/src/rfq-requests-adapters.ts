// U6 (UI/UX gap audit §27 "Purchase — RFQ" and "Purchase — claims") — head office's wiring for the request for quotation
// SENT to suppliers (M06-FR-02 · M24-FR-01) and the one supplier-claims register (M07-FR-03 · M24-FR-02): the RFQ facts on
// their own append-only stream; the supplier master's word on who is approved; the portal's view of the RFQs sent to one
// supplier and of the claims the shop holds against it; the accepted reply landing as a quote on the requisition. Kept in
// its own file: main.ts carries only the registration lines.

import type { EventStore } from '../../../packages/persistence/src/event-store';
import { makeEvent } from '../../../packages/contracts/src/event';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { shopToday, type ShopCalendarOf } from '../../../packages/calendar/src/shop-clock';
import { withUnits, type RfqDeps, type RfqRequest } from '../../purchase/src/rfq';
import type { SupplierPortalDeps, SupplierRfq } from '../../purchase/src/supplier-portal';
import { claimsAgainst, supplierClaimsRoutes } from '../../purchase/src/supplier-claims';
import type { SupplierAccountDeps } from '../../purchase/src/supplier-account';
import type { Route } from '../../kernel/src/index';
import { STREAM, streamName, supplierMasterAdapter, supplierAccountAdapter } from './adapters';

type Recorder = (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
interface Base { readonly store: EventStore; readonly now: () => string; readonly calendar?: ShopCalendarOf; readonly recordAudit?: Recorder }

/** Where the RFQ facts live: one append-only stream per shop (`RfqSent`, latest version per rfqId). */
export const rfqRequestsStream = (): string => streamName(STREAM.purchase, 'rfq-requests');

async function foldRfqs(store: EventStore, tenantId: string): Promise<readonly RfqRequest[]> {
  const byId = new Map<string, RfqRequest>();
  for (const e of await store.readStream(tenantId, rfqRequestsStream(), { type: 'RfqSent' })) {
    const r = e.event.payload as RfqRequest;
    byId.set(r.rfqId, r); // occurrence order → the latest version wins
  }
  return [...byId.values()];
}

/** The requisition deps with the RFQ register, the master's word on approval, the shop's day and the audit trail. */
export function withRfqRequests(deps: RfqDeps, input: Base): RfqDeps {
  const master = supplierMasterAdapter({ store: input.store, now: input.now });
  return {
    ...deps,
    rfqs: (t) => foldRfqs(input.store, t),
    recordRfq: async (t, rfq) => {
      // Keyed on the rfq AND what it says (suppliers, day, note), so the same send again collapses and a changed one is a new
      // version (7 Nov 2026 lesson: keyed on the moment alone, two different sends in one millisecond collapsed).
      const digest = `${[...rfq.supplierIds].sort().join(',')}|${rfq.dueOn}|${rfq.note ?? ''}`;
      await input.store.append(t, rfqRequestsStream(), makeEvent({
        id: `rfq-sent-${rfq.rfqId}-${digestOf(digest)}`, type: 'RfqSent', occurredAt: rfq.sentAt,
        idempotencyKey: `rfq-sent-${t}-${rfq.rfqId}-${digestOf(digest)}`, source: 'api/purchase', payload: rfq,
      }));
    },
    supplierStatus: async (t, supplierId) => (await master.record(t, supplierId))?.status,
    today: (t) => shopToday({ now: input.now, ...(input.calendar === undefined ? {} : { calendar: input.calendar }) }, t),
    ...(input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit }),
  };
}

function digestOf(s: string): string {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h.toString(36);
}

/** The RFQs sent to one supplier, each with the requisition's lines (its units from the master, OB-31). */
export async function supplierRfqs(rfq: RfqDeps, tenantId: string, partnerId: string): Promise<readonly SupplierRfq[]> {
  const out: SupplierRfq[] = [];
  for (const r of (await rfq.rfqs?.(tenantId)) ?? []) {
    if (!r.supplierIds.includes(partnerId)) continue;
    const req = await rfq.requisition(tenantId, r.requisitionId);
    const withU = req === undefined ? undefined : await withUnits(rfq, tenantId, req);
    out.push({ ...r, partnerId, currency: withU?.currency ?? 'INR', lines: withU?.lines ?? [] });
  }
  return out;
}

/** The supplier-portal deps with the RFQs sent to that supplier and the accepted reply landing as a quote (U6 · M24-FR-01). */
export function withSupplierRfqs(deps: SupplierPortalDeps, input: { readonly rfq: RfqDeps }): SupplierPortalDeps {
  return {
    ...deps,
    rfqsOf: (t, partnerId) => supplierRfqs(input.rfq, t, partnerId),
    recordRfqQuote: (t, requisitionId, quote) => input.rfq.recordQuote(t, requisitionId, quote),
  };
}

/** The supplier-portal deps with the claims the shop holds against that supplier (U6 · M24-FR-02). */
export function withSupplierClaims(deps: SupplierPortalDeps, input: { readonly account: SupplierAccountDeps }): SupplierPortalDeps {
  return { ...deps, claimsOf: (t, partnerId) => claimsAgainst(input.account, t, partnerId) };
}

/** The supplier-claims register routes. With no store, the bare surface the guardrails and the contract documents build. */
export function supplierClaimsRoutesFor(input: { readonly store: EventStore | undefined; readonly now: () => string; readonly portal?: Pick<SupplierPortalDeps, 'submissions' | 'reviews'>; readonly partners?: (tenantId: string) => Promise<readonly string[]> }): readonly Route[] {
  if (input.store === undefined) {
    return supplierClaimsRoutes({
      account: { invoices: () => [], latestMatches: () => new Map(), purchaseOrders: () => [], receipts: () => [], payments: () => [], debitNoteIssues: () => [], now: input.now },
      now: input.now,
    });
  }
  const store = input.store;
  const master = supplierMasterAdapter({ store, now: input.now });
  return supplierClaimsRoutes({
    account: supplierAccountAdapter({ store, now: input.now }),
    ...(input.partners === undefined ? {} : { partners: input.partners }),
    ...(input.portal === undefined ? {} : { submissions: input.portal.submissions, reviews: async (t: string, p: string) => (await input.portal!.reviews?.(t, p)) ?? [] }),
    supplierName: async (t, supplierId) => (await master.record(t, supplierId))?.name,
    now: input.now,
  });
}
