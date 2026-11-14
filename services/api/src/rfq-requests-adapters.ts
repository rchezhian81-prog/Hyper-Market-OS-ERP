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
import { claimsAgainst, supplierClaimsRoutes, readClaimDisputes, claimDisputeCounts, claimDisputeAlertPlan, claimDisputeAlertIdOf, type ClaimCreditDecision, type ClaimDispute, type ClaimDisputeResolution, type SupplierClaimsDeps } from '../../purchase/src/supplier-claims';
import type { SupplierAccountDeps } from '../../purchase/src/supplier-account';
import type { Route } from '../../kernel/src/index';
import { STREAM, streamName, supplierMasterAdapter, supplierAccountAdapter, supplierPortalAdapter, alertLifecycleAdapter, effectiveGrants, SUPPLIER_CLAIM_CREDITS_STREAM, SUPPLIER_CLAIM_DISPUTES_STREAM } from './adapters';
import { OWNER_ROLE_ID } from './roles';
import { SUPPLIER_PARTNER_INDEX_STREAM } from './commercial-desks-adapters';
import type { AlertLifecycleEvent } from '../../platform/src/alert-lifecycle';

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
export function supplierClaimsRoutesFor(input: { readonly store: EventStore | undefined; readonly now: () => string; readonly calendar?: ShopCalendarOf; readonly recordAudit?: Recorder; readonly portal?: Pick<SupplierPortalDeps, 'submissions' | 'reviews'>; readonly partners?: (tenantId: string) => Promise<readonly string[]> }): readonly Route[] {
  if (input.store === undefined) {
    return supplierClaimsRoutes({
      account: { invoices: () => [], latestMatches: () => new Map(), purchaseOrders: () => [], receipts: () => [], payments: () => [], debitNoteIssues: () => [], now: input.now },
      now: input.now,
    });
  }
  return supplierClaimsRoutes(supplierClaimsDepsOf({ ...input, store: input.store }));
}

/** The supplier claims register's deps on the event store — one wiring for the page, the Today count and the alert (P-02). */
function supplierClaimsDepsOf(input: { readonly store: EventStore; readonly now: () => string; readonly calendar?: ShopCalendarOf; readonly recordAudit?: Recorder; readonly portal?: Pick<SupplierPortalDeps, 'submissions' | 'reviews'>; readonly partners?: (tenantId: string) => Promise<readonly string[]> }): SupplierClaimsDeps {
  const store = input.store;
  const master = supplierMasterAdapter({ store, now: input.now });
  return {
    account: supplierAccountAdapter({ store, now: input.now }),
    ...(input.partners === undefined ? {} : { partners: input.partners }),
    ...(input.portal === undefined ? {} : { submissions: input.portal.submissions, reviews: async (t: string, p: string) => (await input.portal!.reviews?.(t, p)) ?? [] }),
    supplierName: async (t, supplierId) => (await master.record(t, supplierId))?.name,
    // U7 · OB-725 — the accountant's decisions on draft credits; M24-FR-02 alt — how each disputed claim was settled.
    // Both append-only, keyed on the credit / dispute: two writers of one meet on the key and the first stands.
    creditDecisions: async (t) => (await store.readStream(t, SUPPLIER_CLAIM_CREDITS_STREAM, { type: 'SupplierClaimCreditDecided' })).map((e) => e.event.payload as ClaimCreditDecision),
    recordCreditDecision: async (t, d) => {
      await store.append(t, SUPPLIER_CLAIM_CREDITS_STREAM, makeEvent({
        id: `supplier-claim-credit-${d.creditId}`, type: 'SupplierClaimCreditDecided', occurredAt: d.decidedAt,
        idempotencyKey: `supplier-claim-credit-${t}-${d.creditId}`, source: 'api/purchase', payload: d,
      }));
    },
    disputeResolutions: async (t) => (await store.readStream(t, SUPPLIER_CLAIM_DISPUTES_STREAM, { type: 'SupplierClaimDisputeResolved' })).map((e) => e.event.payload as ClaimDisputeResolution),
    recordDisputeResolution: async (t, r) => {
      await store.append(t, SUPPLIER_CLAIM_DISPUTES_STREAM, makeEvent({
        id: `supplier-claim-dispute-${r.exceptionId}`, type: 'SupplierClaimDisputeResolved', occurredAt: r.at,
        idempotencyKey: `supplier-claim-dispute-${t}-${r.exceptionId}`, source: 'api/purchase', payload: r,
      }));
      // U7 · OB-727: settled → its alert is cleared at once (the sweep would on its next pass; the people who settle it
      // should not see it open in between). Keyed on the dispute: a replay writes nothing new.
      await clearDisputeAlert(store, input.now, t, r.exceptionId, r.by, r.at);
    },
    ...(input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit }),
    ...(input.calendar === undefined ? {} : { calendar: input.calendar }),
    now: input.now,
  };
}

// ── U7 · OB-727 (owner, in writing: B) — a disputed supplier claim counted on Today and alerted to who settles it ───────

interface DisputeReadInput { readonly store: EventStore; readonly now: () => string; readonly calendar?: ShopCalendarOf }

/** The register's deps with the portal and its partner index wired the way main.ts wires the page. */
function disputeDepsOf(input: DisputeReadInput): SupplierClaimsDeps {
  const { store, now } = input;
  return supplierClaimsDepsOf({
    store, now, ...(input.calendar === undefined ? {} : { calendar: input.calendar }),
    portal: supplierPortalAdapter({ store, now, ...(input.calendar === undefined ? {} : { calendar: input.calendar }) }),
    partners: async (t) => [...new Set((await store.readStream(t, SUPPLIER_PARTNER_INDEX_STREAM, { type: 'SupplierPartnerIndexed' })).map((e) => (e.event.payload as { partnerId: string }).partnerId))],
  });
}

/** The store pack's `supplierClaimDisputes` section — the open disputes and the overdue ones, counts only (no build time). */
export function claimDisputeCountsFor(input: DisputeReadInput): (tenantId: string) => Promise<{ readonly open: number; readonly overdue: number }> {
  const deps = disputeDepsOf(input);
  return async (t) => claimDisputeCounts(await readClaimDisputes(deps, t));
}

const rupees = (minor: number | null): string => (minor === null ? 'no value named' : `₹${(minor / 100).toFixed(2)}`);

async function clearDisputeAlert(store: EventStore, now: () => string, t: string, exceptionId: string, by: string, at: string): Promise<boolean> {
  const lifecycle = alertLifecycleAdapter({ store, now });
  const alertId = claimDisputeAlertIdOf(exceptionId);
  const current = (await lifecycle.alerts(t)).find((a) => a.alert.alertId === alertId);
  if (current === undefined || current.state === 'cleared') return false;
  await lifecycle.recordAlertEvent(t, { alertId, change: 'cleared', by, at, detail: 'the disputed claim was settled on Supplier claims' }, `${alertId}|cleared|${current.occurrence}`);
  return true;
}

/**
 * The ops-alert worker's pass (one line in ops-alert-sweeps.ts): each OPEN disputed claim raised ONCE — owned by the buyer
 * who rejected it (the person who settles it) and also sent to every owner, who may settle it too — and each settled
 * one's alert cleared. Every change is a new fact on the alert log, keyed so a replay writes nothing. Answers how many it raised.
 */
export function claimDisputeAlertSweep(input: DisputeReadInput): (tenantId: string, at: string) => Promise<number> {
  const deps = disputeDepsOf(input);
  return async (t, at) => {
    const disputes = await readClaimDisputes(deps, t);
    const lifecycle = alertLifecycleAdapter({ store: input.store, now: input.now });
    const live = await lifecycle.alerts(t);
    const plan = claimDisputeAlertPlan(disputes, live.filter((a) => a.state !== 'cleared').map((a) => a.alert.alertId));
    const owners = [...new Set((await effectiveGrants(input.store, t)).filter((g) => g.roleId === OWNER_ROLE_ID).map((g) => g.userId))].sort();
    let raised = 0;
    for (const d of plan.raise) raised += (await raiseDispute(lifecycle, t, d, owners, live.find((a) => a.alert.alertId === claimDisputeAlertIdOf(d.exceptionId))?.occurrence ?? 0, at)) ? 1 : 0;
    for (const alertId of plan.clear) {
      const occurrence = live.find((a) => a.alert.alertId === alertId)?.occurrence ?? 1;
      await lifecycle.recordAlertEvent(t, { alertId, change: 'cleared', by: 'system:supplier-claim-disputes', at, detail: 'the disputed claim was settled on Supplier claims' }, `${alertId}|cleared|${occurrence}`);
    }
    return raised;
  };
}

async function raiseDispute(lifecycle: ReturnType<typeof alertLifecycleAdapter>, t: string, d: ClaimDispute, owners: readonly string[], occurrence: number, at: string): Promise<boolean> {
  const alertId = claimDisputeAlertIdOf(d.exceptionId);
  const also = owners.filter((u) => u !== d.ownerUserId);
  const event: AlertLifecycleEvent = {
    alertId, change: 'raised', by: 'system:supplier-claim-disputes', at,
    alert: {
      alertId, component: `Disputed supplier claim ${d.exceptionId}`, status: 'degraded', ownerUserId: d.ownerUserId, ownerName: d.ownerUserId,
      detail: `Supplier ${d.supplierId} claimed ${rupees(d.valueMinor)} (${d.why}); ${d.ownerUserId} rejected it: ${d.rejectedBecause || 'no reason given'}. It stays open until it is settled on Supplier claims.`,
      raisedAt: at, ackDueBy: at, ...(also.length > 0 ? { alsoToUserIds: also } : {}),
    },
  };
  // Keyed on the dispute and the occurrence: two passes at once meet on the key, and one alert is written.
  await lifecycle.recordAlertEvent(t, event, `${alertId}|raised|${occurrence + 1}`);
  return true;
}
