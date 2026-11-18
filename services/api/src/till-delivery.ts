// OB-806 A (owner, 16 Nov 2026, in writing: "a manager's price change is sent to the tills automatically once head office
// accepts it") · daily-work defect D-021 · P-01 · P-08 · hard rules #2, #5.
//
// Two pieces, both composed by `main.ts` (and `p1-identity-adapters.ts` for its swapped-in price route):
//   • `notSentLogAdapter` — the append-only record of an accepted price whose automatic send did not go (and why), settled
//     by the next pack that does go for that store. Head office reads it back for the owner's "Send to the tills" page, so a
//     price saved but not on the tills is never silent.
//   • `tillsSender` — what the price routes call after recording an accepted price: for each store, the catalogue service's
//     `sendAcceptedPriceToTills` (the SAME signed, versioned pack publish as "Send to the tills"), with an audit entry saying
//     who, what and whether it went. The store computer takes the pack on its normal pull (`packages/sync/src/pull-timing.ts`)
//     and the tills keep trading offline on the pack they hold (P-01). No AI is anywhere on this path (hard rule #5).

import type { EventStore, PersistedEvent } from '../../../packages/persistence/src/event-store';
import { makeEvent } from '../../../packages/contracts/src/event';
import { shopClock, type ShopCalendarOf } from '../../../packages/calendar/src/shop-clock';
import { storePullMaxMinutes } from '../../../packages/sync/src/pull-timing';
import type { AuditEntry } from '../../../packages/audit/src/index';
import {
  sendAcceptedPriceToTills, sendPricesNowInForce, type CatalogueDeps, type NotSentLog, type NotSentToTills,
} from '../../catalogue/src/index';
import type { AcceptedPriceForTills, TillDeliveryAnswer } from '../../pricing/src/index';
import { STREAM, streamName } from './adapters';

export const TILL_DELIVERY_STREAM = streamName(STREAM.catalogue, 'till-delivery');
const NOT_SENT = 'PriceNotSentToTills';
const SENT = 'PackSentForStore';

interface SentForStore { readonly storeId: string; readonly version: number; readonly at: string; readonly shopDate?: string }

export function notSentLogAdapter(input: { readonly store: EventStore; readonly calendar?: ShopCalendarOf }): NotSentLog {
  const fold = async (tenantId: string): Promise<Map<string, NotSentToTills[]>> => {
    // Folded in append order: a pack that went for the store settles everything not sent before it — EXCEPT a price whose
    // start day is still after the day that pack was built (D-021): that pack could not carry it, so it stays waiting.
    const open = new Map<string, NotSentToTills[]>();
    for (const e of await input.store.readStream(tenantId, TILL_DELIVERY_STREAM) as readonly PersistedEvent[]) {
      const p = e.event.payload as { storeId?: unknown };
      if (typeof p.storeId !== 'string') continue;
      const list = open.get(p.storeId) ?? [];
      if (e.event.type === SENT) {
        const sentOn = (e.event.payload as SentForStore).shopDate;
        open.set(p.storeId, sentOn === undefined ? [] : list.filter((x) => x.reason === 'starts_later' && x.startsOn !== undefined && x.startsOn > sentOn));
      } else if (e.event.type === NOT_SENT) {
        list.push(e.event.payload as NotSentToTills);
        open.set(p.storeId, list);
      }
    }
    return open;
  };
  return {
    recordNotSent: async (tenantId, e) => {
      await input.store.append(tenantId, TILL_DELIVERY_STREAM, makeEvent({
        id: `not-sent-${e.storeId}-${e.productId}-${e.priceMinor}-${e.at}`, type: NOT_SENT, occurredAt: e.at,
        idempotencyKey: `not-sent-${tenantId}-${e.storeId}-${e.productId}-${e.priceMinor}-${e.at}`, source: 'api/catalogue', payload: e,
      }));
    },
    recordSent: async (tenantId, storeId, version, at) => {
      // The shop's date the pack was built on — so a later-day price it could not carry stays on the list (D-021).
      const shopDate = await shopClock(input.calendar).today(tenantId, at);
      await input.store.append(tenantId, TILL_DELIVERY_STREAM, makeEvent({
        id: `sent-${storeId}-v${version}`, type: SENT, occurredAt: at,
        // One pack version, once: a retried send of the same version is the same fact.
        idempotencyKey: `sent-${tenantId}-${storeId}-v${version}`, source: 'api/catalogue', payload: { storeId, version, at, shopDate } satisfies SentForStore,
      }));
    },
    since: async (tenantId, storeId) => (await fold(tenantId)).get(storeId) ?? [],
    storesWaiting: async (tenantId) => [...(await fold(tenantId)).entries()].filter(([, l]) => l.length > 0).map(([id]) => id),
  };
}

/** What the price routes call after an accepted price is recorded (`PricingDeps.toTheTills`). */
export function tillsSender(input: {
  readonly catalogue: CatalogueDeps;
  readonly now: () => string;
  readonly calendar?: ShopCalendarOf;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}): (tenantId: string, price: AcceptedPriceForTills) => Promise<readonly TillDeliveryAnswer[]> {
  return async (tenantId, price) => {
    const today = await shopClock(input.calendar).today(tenantId, input.now());
    const answers: TillDeliveryAnswer[] = [];
    // One store at a time: each send is one pack version for that store, built from head office's records as they now are.
    for (const storeId of price.storeIds) {
      const d = await sendAcceptedPriceToTills(input.catalogue, tenantId, {
        storeId, productId: price.productId, priceMinor: price.priceMinor, by: price.by,
        startsOn: price.startsOn, today, withinMinutes: storePullMaxMinutes(),
      });
      answers.push(d);
      await input.recordAudit?.(tenantId, {
        actorId: price.by, action: d.sent ? 'catalogue.pack.sent_after_accepted_price' : 'catalogue.pack.not_sent_after_accepted_price',
        objectType: 'store', objectId: storeId, at: input.now(), origin: { tenantId, branchId: storeId },
        before: null,
        after: d.sent
          ? { productId: price.productId, priceMinor: String(price.priceMinor), packVersion: String(d.version) }
          : { productId: price.productId, priceMinor: String(price.priceMinor), reason: d.reason },
        ...(d.sent ? {} : { reason: d.why }),
        correlationId: `price-${price.productId}`,
      });
    }
    return answers;
  };
}

/**
 * D-021: the start-day check the store computer's pack ask runs first (`CatalogueDeps.startDaySend`). Every later-day price
 * whose day has come on the shop's clock is sent through the one signed publish, with an audit entry for each store saying
 * what went — or, once, why not.
 */
export function startDaySender(input: {
  readonly catalogue: CatalogueDeps;
  readonly now: () => string;
  readonly calendar?: ShopCalendarOf;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}): (tenantId: string) => ReturnType<typeof sendPricesNowInForce> {
  return async (tenantId) => {
    const today = await shopClock(input.calendar).today(tenantId, input.now());
    const answers = await sendPricesNowInForce(input.catalogue, tenantId, { today, withinMinutes: storePullMaxMinutes() });
    for (const d of answers) {
      await input.recordAudit?.(tenantId, {
        actorId: 'system:start-day-send',
        action: d.sent ? 'catalogue.pack.sent_on_start_day' : 'catalogue.pack.not_sent_on_start_day',
        objectType: 'store', objectId: d.storeId, at: input.now(), origin: { tenantId, branchId: d.storeId },
        before: null,
        after: d.sent
          ? { productIds: d.productIds.join(','), packVersion: String(d.version), shopDate: today }
          : { productIds: d.productIds.join(','), reason: d.reason, shopDate: today },
        ...(d.sent ? {} : { reason: d.why }),
        correlationId: `start-day-${d.storeId}-${today}`,
      });
    }
    return answers;
  };
}
