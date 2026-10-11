// Round 8 registers, each append-only on its own stream (hard rules #2, #6):
//   • the replies a PERSON sent from an approved AI draft, and the root causes recorded on resolved cases (WF-17 · M21);
//   • the A07 anomaly summaries a security officer reads (roadmap §7);
// and the domain readers the A05 / A07 drafting legs ask over (the order a case is about, the shop's service policy, the
// rule breaches the store's rules raised). Reads fold the streams; nothing here edits a record.

import { createHash } from 'node:crypto';
import { makeEvent } from '../../../packages/contracts/src/event';
import type { EventStore } from '../../../packages/persistence/src/event-store';
import type { EvidenceItem } from '../../../packages/ai/src/index';
import type { SentReply, RootCauseRecord } from '../../customer/src/service-cases';
import type { AnomalySummary } from '../../ai/src/drafting-legs';
import type { RaisedException } from '../../pos/src/loss-prevention';
import type { PlacedOrder, OrderTransition } from '../../orders/src/index';
import type { FavouriteRecord, ShoppingListVersion, ReturnRequestRecord } from '../../orders/src/storefront-self';
import type { CompetitorObservation } from '../../pricing/src/competitor-prices';
import { STREAM, streamName, notificationQueueAdapter, effectiveGrants, rosterStoreAdapter, orgStructureAdapter } from './adapters';
import type { BreachAlert, DutyManagers } from '../../orders/src/exception-ownership';
import { branchOfLocationIn } from '../../inventory/src/location-scope';
import { OWNER_ROLE_ID, STORE_MANAGER_ROLE_ID } from './roles';

const SENT_REPLIES = streamName(STREAM.service, 'sent-replies');
const ROOT_CAUSES = streamName(STREAM.service, 'root-causes');
const ANOMALY_SUMMARIES = streamName(STREAM.ai, 'anomaly-summaries');

const digest = (key: string): string => createHash('sha256').update(key).digest('hex').slice(0, 16);
const all = async <T>(store: EventStore, tenantId: string, stream: string, type: string): Promise<T[]> =>
  (await store.readStream(tenantId, stream, { type })).map((e) => e.event.payload as T);

export function serviceDeskExtrasAdapter(input: { readonly store: EventStore; readonly now: () => string }) {
  return {
    sentReplies: async (tenantId: string, caseId: string): Promise<readonly SentReply[]> =>
      (await all<SentReply>(input.store, tenantId, SENT_REPLIES, 'ServiceReplySent')).filter((r) => r.caseId === caseId),
    recordSentReply: async (tenantId: string, rec: SentReply, key: string): Promise<void> => {
      const d = digest(key);
      await input.store.append(tenantId, SENT_REPLIES, makeEvent({
        id: `service-reply-${d}`, type: 'ServiceReplySent', occurredAt: rec.at,
        // One send per draft: the key is the case and the draft, so a re-sent request is the same fact.
        idempotencyKey: `service-reply-${tenantId}-${d}`, source: 'api/customer', payload: rec,
      }));
    },
    rootCauses: (tenantId: string): Promise<readonly RootCauseRecord[]> => all<RootCauseRecord>(input.store, tenantId, ROOT_CAUSES, 'ServiceRootCauseRecorded'),
    recordRootCause: async (tenantId: string, rec: RootCauseRecord, key: string): Promise<void> => {
      const d = digest(key);
      await input.store.append(tenantId, ROOT_CAUSES, makeEvent({
        id: `service-root-cause-${d}`, type: 'ServiceRootCauseRecorded', occurredAt: rec.at,
        idempotencyKey: `service-root-cause-${tenantId}-${d}`, source: 'api/customer', payload: rec,
      }));
    },
  };
}

export function anomalySummaryAdapter(input: { readonly store: EventStore; readonly now: () => string }) {
  return {
    anomalySummaries: (tenantId: string): Promise<readonly AnomalySummary[]> => all<AnomalySummary>(input.store, tenantId, ANOMALY_SUMMARIES, 'AiAnomalySummaryRecorded'),
    recordAnomalySummary: async (tenantId: string, s: AnomalySummary): Promise<void> => {
      await input.store.append(tenantId, ANOMALY_SUMMARIES, makeEvent({
        id: `ai-anomaly-summary-${s.summaryId}`, type: 'AiAnomalySummaryRecorded', occurredAt: s.at,
        idempotencyKey: `ai-anomaly-summary-${tenantId}-${s.summaryId}`, source: 'api/ai', payload: s,
      }));
    },
    /** PF-07: the breaches the store's own rules raised, latest per exception — evidence the A07 summary may cite. */
    raisedExceptionFacts: async (tenantId: string): Promise<readonly EvidenceItem[]> => {
      const latest = new Map<string, RaisedException>();
      for (const r of await all<RaisedException>(input.store, tenantId, streamName(STREAM.lossPrevention, 'raised'), 'LpExceptionRaised')) latest.set(r.exceptionId, r);
      return [...latest.values()].sort((a, b) => a.exceptionId.localeCompare(b.exceptionId)).map((r) => ({
        evidenceId: `lp-raised:${r.exceptionId}`, source: 'loss-prevention rule breaches', untrusted: false,
        content: `${r.exceptionId} on ${r.day}: cashier ${r.cashierId}, ${r.kind} ${r.breach} — ${r.observed} against a limit of ${r.limit} (${r.severity}); linked ${r.linkedTxnIds.join(', ')}`,
      }));
    },
  };
}

/**
 * The roster roles that make a person the store's DUTY MANAGER while their shift runs (OB-61). The roster's role on an
 * assignment is the shop's own word; these are the manager words it uses. Written in one place so it can change.
 */
export const DUTY_MANAGER_ROSTER_ROLES: readonly string[] = Object.freeze(['duty_manager', 'store_manager', 'manager']);

/**
 * Round 9 (M19 · owner decision OB-61): who is the store's duty manager NOW for the store an order belongs to.
 *   1. the stored roster: an active person assigned, in a manager role, to a shift at that store whose time covers now;
 *   2. no roster says who is on duty -> the people holding the store-manager role with that store in their grant scope;
 *   3. no store manager holds the store -> the owner (the top of the shop) — so a breach is never silently untold;
 *   4. nobody at all -> `none` (the sweep reports it as nobody-to-tell, P-08).
 * The store is the order's own place (its `OrderPlaced` location, mapped to its branch through the org structure); an
 * order with no stored record is treated as the single store (the whole tenant) and the answer names no branch.
 */
export async function dutyManagersFor(store: EventStore, now: () => string, tenantId: string, orderId: string, at: string): Promise<DutyManagers> {
  const placed = (await all<PlacedOrder>(store, tenantId, streamName(STREAM.orders, orderId), 'OrderPlaced'))[0];
  const branchId = placed === undefined ? undefined : branchOfLocationIn(await orgStructureAdapter({ store, now }).nodes(tenantId))(placed.locationId);
  const roster = await rosterStoreAdapter({ store, now }).roster(tenantId, branchId);
  const t = Date.parse(at);
  const onNow = new Set(roster.shifts.filter((sh) => Date.parse(sh.startsAt) <= t && t < Date.parse(sh.endsAt)).map((sh) => sh.shiftId));
  const leavers = new Set(roster.employees.filter((e) => !e.active).map((e) => e.employeeId));
  const rostered = [...new Set(roster.assignments.filter((x) => onNow.has(x.shiftId) && DUTY_MANAGER_ROSTER_ROLES.includes(x.role) && !leavers.has(x.employeeId)).map((x) => x.employeeId))].sort();
  const where = branchId === undefined ? {} : { branchId };
  if (rostered.length > 0) return { people: rostered, source: 'roster', ...where };
  const grants = await effectiveGrants(store, tenantId);
  const covers = (g: { readonly branchScope: readonly string[] | 'all' }): boolean => branchId === undefined || g.branchScope === 'all' || g.branchScope.includes(branchId);
  const holding = (roleId: string): string[] => [...new Set(grants.filter((g) => g.roleId === roleId && covers(g)).map((g) => g.userId))].sort();
  const managers = holding(STORE_MANAGER_ROLE_ID);
  if (managers.length > 0) return { people: managers, source: 'store_manager_grants', ...where };
  const owners = holding(OWNER_ROLE_ID);
  if (owners.length > 0) return { people: owners, source: 'owner_grants', ...where };
  return { people: [], source: 'none', ...where };
}

/**
 * Round 8 (M19-FR-04 · PA-08) / round 9 (OB-61): who to tell when nobody holds a breached exception (the store's duty
 * manager, above), and putting a breach alert on the SAME message queue the sender drains — a transactional message
 * composed by head office (`system:exception-alert`), so the sender still re-checks the recipient and the budget.
 */
export function breachAlertAdapter(input: { readonly store: EventStore; readonly now: () => string }) {
  const queue = notificationQueueAdapter({ store: input.store, now: input.now });
  return {
    dutyManagersFor: (tenantId: string, orderId: string, at: string): Promise<DutyManagers> => dutyManagersFor(input.store, input.now, tenantId, orderId, at),
    enqueueBreachAlert: async (tenantId: string, a: BreachAlert): Promise<boolean> => {
      if ((await queue.events!(tenantId)).some((e) => e.id === a.id && e.change === 'enqueued')) return false;
      await queue.record(tenantId, {
        id: a.id, change: 'enqueued', by: a.by, at: a.at, channel: 'sms',
        intent: { customerId: a.to, purpose: 'transactional', templateId: 'substitution-exception-breach', templateVersion: 1, text: a.text, composedBy: 'system:exception-alert' },
      }, `notif-enqueue-${a.id}`);
      return true;
    },
  };
}

/**
 * Round 8 (D08-FR-02/05 · WF-16): the signed-in customer's own favourites, lists and return requests — each on a stream
 * of that customer's own (one customer's records fold one stream), append-only; a change is a new record.
 */
export function storefrontSelfAdapter(input: { readonly store: EventStore; readonly now: () => string }) {
  const fav = (c: string): string => streamName(STREAM.customer, 'favourites', c);
  const lists = (c: string): string => streamName(STREAM.customer, 'lists', c);
  const returns = (c: string): string => streamName(STREAM.customer, 'return-requests', c);
  const put = async (tenantId: string, stream: string, type: string, payload: { readonly at: string }, key: string): Promise<void> => {
    const d = digest(`${stream}|${key}`);
    await input.store.append(tenantId, stream, makeEvent({ id: `${type}-${d}`, type, occurredAt: payload.at, idempotencyKey: `${type}-${tenantId}-${d}`, source: 'api/storefront', payload }));
  };
  return {
    favourites: (tenantId: string, c: string): Promise<readonly FavouriteRecord[]> => all<FavouriteRecord>(input.store, tenantId, fav(c), 'CustomerFavouriteSet'),
    recordFavourite: (tenantId: string, rec: FavouriteRecord, key: string): Promise<void> => put(tenantId, fav(rec.customerRef), 'CustomerFavouriteSet', rec, key),
    lists: (tenantId: string, c: string): Promise<readonly ShoppingListVersion[]> => all<ShoppingListVersion>(input.store, tenantId, lists(c), 'CustomerListSaved'),
    recordList: (tenantId: string, rec: ShoppingListVersion, key: string): Promise<void> => put(tenantId, lists(rec.customerRef), 'CustomerListSaved', rec, key),
    returnRequests: (tenantId: string, c: string): Promise<readonly ReturnRequestRecord[]> => all<ReturnRequestRecord>(input.store, tenantId, returns(c), 'CustomerReturnRequested'),
    recordReturnRequest: (tenantId: string, rec: ReturnRequestRecord, key: string): Promise<void> => put(tenantId, returns(rec.customerRef), 'CustomerReturnRequested', rec, key),
  };
}

/** Round 8 (D06-FR-05): competitor price sightings — one tenant-wide, append-only register; one record per sighting id. */
export function competitorPriceAdapter(input: { readonly store: EventStore; readonly now: () => string }) {
  const stream = streamName(STREAM.pricing, 'competitor-prices');
  return {
    observations: (tenantId: string): Promise<readonly CompetitorObservation[]> => all<CompetitorObservation>(input.store, tenantId, stream, 'CompetitorPriceObserved'),
    recordObservation: async (tenantId: string, o: CompetitorObservation): Promise<void> => {
      await input.store.append(tenantId, stream, makeEvent({
        id: `competitor-price-${o.observationId}`, type: 'CompetitorPriceObserved', occurredAt: o.recordedAt,
        idempotencyKey: `competitor-price-${tenantId}-${o.observationId}`, source: 'api/pricing', payload: o,
      }));
    },
  };
}

/** The order a case is about, in words, from the order register (its placed record and its latest step). */
export async function orderFactsFor(store: EventStore, tenantId: string, orderId: string): Promise<string | undefined> {
  const stream = streamName(STREAM.orders, orderId);
  const placed = (await all<PlacedOrder>(store, tenantId, stream, 'OrderPlaced'))[0];
  if (placed === undefined) return undefined;
  const steps = await all<OrderTransition>(store, tenantId, stream, 'OrderTransitioned');
  const state = steps.at(-1)?.to ?? placed.state;
  return `order ${orderId}: placed ${placed.placedAt} at ${placed.locationId}, ${placed.lines.length} line(s), now ${state}${placed.fulfilment === undefined ? '' : `, for ${placed.fulfilment}`}`;
}
