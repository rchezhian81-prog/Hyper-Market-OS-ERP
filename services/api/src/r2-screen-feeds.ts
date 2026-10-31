// Screen gap audit (31 Oct 2026) Round A — the store pack sections two office pages were never sent, read from head
// office's OWN registers (P-02: nothing typed twice; P-08: a page that was never told says so, and an empty register says
// "nothing recorded yet", never "all clear").
//
//   • `wasteWriteOffsSectionFor` — the Waste & write-off page (M28-FR-01): every write-off head office committed at THIS
//     store or its back store, as the review row the page reads. The register is the append-only write-off stream every
//     write-off path builds through (`writeOffCommittedEntry`); a correction is its own compensating write-off, shown as
//     itself. Sent even when empty, so the page can tell "nothing recorded yet" from "never told".
//   • `categoryPolicySectionFor` — the Category rules page (M03-FR-01 · CAT-POLICY): every category on head office's list.
//     Head office keeps NO dated rule set for a category yet (the rule engine is reached only through the read-only preview
//     route), so each category goes with an empty history and the page shows it as "No rules in force — set them": the
//     truth, never a preset passed off as the shop's own rules.
//   • `consolidationOwnRecords` — the Company report (M01 / M29 / D13): the branches under each company from head office's
//     organisation register, and each branch's month of sales and refunds from what its store sent head office (below).
//
// Read-only: nothing here writes anything.

import type { EventStore } from '../../../packages/persistence/src/event-store';
import { categoryRegisterAdapter, writeOffAdapter, orgStructureAdapter, storeSyncView, STREAM } from './adapters';
import { branchOfLocationIn } from '../../inventory/src/location-scope';
import { shopClock, type ShopCalendarOf } from '../../../packages/calendar/src/shop-clock';
import { tradingDayIn } from '../../../packages/calendar/src/trading-day';
import type { IncomingSale } from '../../pos/src/sale-intake';
import type { ReturnRecord } from '../../pos/src/returns';

/** One write-off as the Waste page reads it (`apps/web-erp/src/waste-review-session.ts` `WriteOffRow`). */
export interface WasteReviewRow {
  readonly id: string;
  readonly productId: string;
  readonly lossType: string;
  readonly qtyRemoved: number;
  readonly uom: string;
  readonly valueMinor: number;
  readonly currency: string;
  readonly requiredApproval: boolean;
  readonly evidenceRef?: string;
  readonly raisedBy: string;
  readonly at: string;
}

/**
 * The write-offs committed at this store's own places (the store and its back store), newest first. `branchOf` is the
 * builder's own "whose place is this" rule, so a write-off at a place the hierarchy puts under another store is never
 * shown here.
 */
export async function wasteWriteOffsSectionFor(
  store: EventStore, now: () => string, tenantId: string, storeId: string, branchOf: (locationId: string) => string,
): Promise<readonly WasteReviewRow[]> {
  const all = await writeOffAdapter({ store, now }).writeOffs(tenantId);
  return all
    .filter((w) => branchOf(w.locationId) === storeId)
    .map((w): WasteReviewRow => ({
      id: w.id, productId: w.productId, lossType: w.lossType, qtyRemoved: w.qtyRemoved, uom: w.uom,
      valueMinor: w.valueMinor, currency: w.currency, requiredApproval: w.requiredApproval,
      ...(typeof w.evidenceRef === 'string' && w.evidenceRef.trim() !== '' ? { evidenceRef: w.evidenceRef } : {}),
      raisedBy: w.raisedBy, at: w.at,
    }))
    .sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
}

/** One category as the Category rules page reads it (`packages/product` `CategoryPolicy`), plus its name. */
export interface CategoryPolicyRow {
  readonly categoryId: string;
  readonly name: string;
  /** The category's dated rule entries. Empty: head office holds no rules for it (the page says "no rules in force"). */
  readonly history: readonly never[];
}

/** Every category on head office's list, by id. Head office keeps no dated rules for a category, so none are invented. */
export async function categoryPolicySectionFor(store: EventStore, now: () => string, tenantId: string): Promise<readonly CategoryPolicyRow[]> {
  const categories = await categoryRegisterAdapter({ store, now }).categories(tenantId);
  return [...categories]
    .sort((a, b) => a.categoryId.localeCompare(b.categoryId))
    .map((c) => ({ categoryId: c.categoryId, name: c.name, history: [] }));
}

// ── The Company report (M01 / M29 / D13): what head office ITSELF holds, rolled up by branch ─────────────────────────────
//
// Before: nothing produced a branch contribution. The roll-up's population came only from memberships a branch feed POSTs,
// so with none posted it expected no branch, found none missing, and the page said "No branch has reported" and "Every
// expected branch has reported" at once. Head office already holds the two facts the roll-up needs for a business like
// this one, whose store sends its sales and refunds to head office itself:
//   • which branches the company has — its own organisation register (an active or suspended branch, under its company);
//   • each branch's month — the sales and the refunds its store computer sent, dated by the shop's own calendar.
// What a branch feed POSTs still wins for its (branch, month, family): these fill only what nobody posted. A branch that
// sent head office nothing for the month is NOT given a zero — it is left out, so the report names it missing.

/** One branch's numbers for one family in one month, as the consolidation engine reads it. */
export interface OwnContribution {
  readonly branchId: string;
  readonly period: string;
  readonly family: 'sales' | 'returns';
  readonly measures: Readonly<Record<string, number>>;
  readonly lastRefreshAt: string | null;
  readonly revision: number;
}
/** A branch under its company, as the consolidation engine reads it. */
export interface OwnMembership { readonly branchId: string; readonly parentId: string; readonly from: string; readonly to: string | null }

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const isoDayShift = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00.000Z`) + days * 86_400_000).toISOString();
const later = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : (Date.parse(a) >= Date.parse(b) ? a : b));

/**
 * Head office's own records for the Company report: the branches under each company (memberships) and, for a month
 * (`YYYY-MM`) and the `sales` or `returns` family, each branch's contribution from the sales and refunds it holds.
 */
export function consolidationOwnRecords(input: {
  readonly store: EventStore;
  readonly now: () => string;
  readonly calendar?: ShopCalendarOf;
}): (tenantId: string, period: string, family: string) => Promise<{ readonly contributions: readonly OwnContribution[]; readonly memberships: readonly OwnMembership[] }> {
  return async (tenantId, period, family) => {
    const nodes = await orgStructureAdapter({ store: input.store, now: input.now }).nodes(tenantId);
    const byId = new Map(nodes.map((n) => [n.nodeId, n] as const));
    const companyOf = (nodeId: string): string | undefined => {
      const seen = new Set<string>();
      let at = byId.get(nodeId);
      while (at !== undefined && !seen.has(at.nodeId)) {
        if (at.kind === 'company') return at.nodeId;
        seen.add(at.nodeId);
        at = at.parentId === null ? undefined : byId.get(at.parentId);
      }
      return undefined;
    };
    // A branch that trades (active) or is paused (suspended) is expected; a draft never opened and a closed one are not.
    const branches = nodes.filter((n) => n.kind === 'branch' && (n.status === 'active' || n.status === 'suspended'));
    const memberships: OwnMembership[] = branches.flatMap((b) => {
      const company = b.companyId ?? companyOf(b.nodeId);
      return company === undefined ? [] : [{ branchId: b.nodeId, parentId: company, from: '0001-01-01', to: null }];
    });
    if (!MONTH.test(period) || (family !== 'sales' && family !== 'returns')) return { contributions: [], memberships };

    const expected = new Set(branches.map((b) => b.nodeId));
    const placed = branchOfLocationIn(nodes);
    const only = branches.length === 1 ? branches[0]!.nodeId : undefined;
    // A record names a stock place; its branch is the place's branch in the hierarchy. With ONE branch in the business, a
    // record that names no place is that branch's (there is no other); with more, it is left out rather than guessed.
    const branchOf = (locationId: string | undefined): string | undefined => {
      if (locationId === undefined || locationId === '') return only;
      const b = placed(locationId);
      return expected.has(b) ? b : undefined;
    };
    const calendar = await shopClock(input.calendar).calendar(tenantId);
    const window = { from: isoDayShift(`${period}-01`, -2), to: isoDayShift(`${nextMonth(period)}-01`, 2) };
    const sums = new Map<string, { amount: number; count: number; newest: string | null }>();
    const add = (branchId: string | undefined, amount: number, at: string): void => {
      if (branchId === undefined) return;
      const held = sums.get(branchId) ?? { amount: 0, count: 0, newest: null };
      sums.set(branchId, { amount: held.amount + amount, count: held.count + 1, newest: later(held.newest, at) });
    };
    if (family === 'sales') {
      for (const e of await input.store.readStream(tenantId, STREAM.sales, { type: 'SaleCommitted', ...window })) {
        const s = e.event.payload as IncomingSale;
        if (typeof s.tradingDay === 'string' && s.tradingDay.startsWith(period)) add(branchOf(s.locationId), s.totalMinor, e.event.occurredAt);
      }
    } else {
      for (const e of await input.store.readStream(tenantId, STREAM.returns, { type: 'ReturnRecorded', ...window })) {
        const r = e.event.payload as ReturnRecord;
        if (!tradingDayIn(r.processedAt, calendar).startsWith(period)) continue;
        // A refund belongs to the branch of the bill it refunds (the place that sale sold from), else the place it names.
        const sale = r.originalSaleId === null ? undefined : await input.store.findByIdempotencyKey(tenantId, `sale-${tenantId}-${r.originalSaleId}`);
        const location = (sale?.event.payload as IncomingSale | undefined)?.locationId ?? r.locationId;
        add(branchOf(location), r.refundMinor, e.event.occurredAt);
      }
    }
    // The store computer's own word on how far its queue has reached head office: a branch that says everything up to a
    // moment AFTER the month began has reached head office has a real total even with no record (a true zero) — and its
    // freshness is that moment when later than its newest record.
    const reports = (await storeSyncView(input.store, tenantId, input.now)).sales;
    const monthStart = isoDayShift(`${period}-01`, 0);
    const contributions: OwnContribution[] = [];
    for (const branchId of [...expected].sort()) {
      const held = sums.get(branchId);
      const reported = reports.get(branchId)?.completeThrough ?? null;
      const vouched = reported !== null && Date.parse(reported) >= Date.parse(monthStart);
      if (held === undefined && !vouched) continue; // nothing heard for the month: left out, so it is named missing
      const amount = held?.amount ?? 0;
      const count = held?.count ?? 0;
      contributions.push({
        branchId, period, family, revision: 0,
        measures: family === 'sales' ? { grossMinor: amount, count } : { refundMinor: amount, count },
        lastRefreshAt: later(held?.newest ?? null, reported),
      });
    }
    return { contributions, memberships };
  };
}

const nextMonth = (period: string): string => {
  const [y, m] = period.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};
