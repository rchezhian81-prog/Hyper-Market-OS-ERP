// OB-288 wave-5 follow-ups — head office's wiring for the owner's decisions of 24–25 Oct 2026 that need a register read
// the shared adapters do not already give. Kept in its own file: main.ts carries only the registration line.
//
//   • withSupplierOpenOrders — OB-362: the supplier portal lists the supplier's OWN open orders (issued on head office's
//                              purchase-order register, not yet all received or cancelled), so its "Delivery update" form
//                              names only them. The order's costs are never shown; the partner is the login's binding.
//   • tillSignInLog*         — OB-365: the till sign-in log the store computers relay, kept on its own append-only stream,
//                              read by the owner's alerts and the security report.

import { InMemoryEventStore, type EventStore } from '../../../packages/persistence/src/event-store';
import { makeEvent } from '../../../packages/contracts/src/event';
import { tradingDayIn, type TradingCalendar } from '../../../packages/calendar/src/index';
import type { Route } from '../../kernel/src/index';
import type { SupplierPortalDeps, SupplierOpenOrder } from '../../purchase/src/supplier-portal';
import { tillSignInLogRoutes, type TillSignInLogDeps, type TillSignInRecord } from '../../identity/src/till-sign-in-log';
import { STREAM, streamName, foldPurchaseOrders } from './adapters';

interface Base { readonly store: EventStore; readonly now: () => string }

/** OB-365: where head office keeps the till sign-in log (one append-only stream per shop). A function, not a constant:
 *  this file and adapters.ts reach each other through the report producers, so nothing is read at load time. */
export const tillSignInStream = (): string => streamName(STREAM.identity, 'till-sign-ins');

/** OB-365: every till sign-in record head office holds, oldest first. */
export async function tillSignInRecords(store: EventStore, tenantId: string): Promise<readonly { readonly p: TillSignInRecord; readonly at: string }[]> {
  return (await store.readStream(tenantId, tillSignInStream(), { type: 'TillSignInRecorded' })).map((e) => ({ p: e.event.payload as unknown as TillSignInRecord, at: e.event.occurredAt }));
}

export function tillSignInLogAdapter(input: Base & { readonly calendar: (tenantId: string) => Promise<TradingCalendar> }): TillSignInLogDeps {
  const { store, now } = input;
  return {
    entries: async (t) => (await tillSignInRecords(store, t)).map((x) => x.p),
    entry: async (t, entryId) => (await tillSignInRecords(store, t)).map((x) => x.p).find((r) => r.entryId === entryId),
    record: async (t, r) => {
      await store.append(t, tillSignInStream(), makeEvent({
        id: `till-sign-in-${r.entryId}`, type: 'TillSignInRecorded', occurredAt: r.at,
        idempotencyKey: `till-sign-in-${t}-${r.entryId}`, source: 'api/identity', payload: r as unknown as Record<string, unknown>,
      }));
    },
    dayOf: async (t, at) => tradingDayIn(at, await input.calendar(t)),
    now,
  };
}

/** OB-365: the till sign-in log's routes (the store computer's relay, and the day's read). */
export function tillSignInLogRoutesFor(input: { readonly store: EventStore | undefined; readonly now: () => string; readonly calendar: (tenantId: string) => Promise<TradingCalendar> }): readonly Route[] {
  return tillSignInLogRoutes(tillSignInLogAdapter({ store: input.store ?? new InMemoryEventStore(), now: input.now, calendar: input.calendar }));
}

/** OB-362: an order is open while it is issued and some line still has quantity neither received nor cancelled. */
export function openOrdersOfSupplier(input: Base): (tenantId: string, partnerId: string) => Promise<readonly SupplierOpenOrder[]> {
  return async (tenantId, partnerId) => {
    const out: SupplierOpenOrder[] = [];
    for (const o of (await foldPurchaseOrders(input.store, tenantId)).values()) {
      if (o.supplierId !== partnerId || o.status !== 'issued') continue;
      const open = o.lines.some((l) => l.orderedQty > (o.receivedByProduct[l.productId] ?? 0) + (o.cancelledByProduct[l.productId] ?? 0));
      if (!open) continue;
      out.push({ partnerId, poId: o.poId, number: o.number, issuedAt: o.issuedAt, deliverToLocationId: o.deliverToLocationId ?? null, lines: o.lines.length });
    }
    return out.sort((a, b) => (b.issuedAt ?? '').localeCompare(a.issuedAt ?? '') || a.poId.localeCompare(b.poId));
  };
}

/** The supplier-portal deps with the supplier's own open orders (OB-362). */
export function withSupplierOpenOrders(deps: SupplierPortalDeps, input: Base): SupplierPortalDeps {
  return { ...deps, openOrdersOf: openOrdersOfSupplier(input) };
}
