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
  sendAcceptedPriceToTills, type CatalogueDeps, type NotSentLog, type NotSentToTills,
} from '../../catalogue/src/index';
import type { AcceptedPriceForTills, TillDeliveryAnswer } from '../../pricing/src/index';
import { STREAM, streamName } from './adapters';

export const TILL_DELIVERY_STREAM = streamName(STREAM.catalogue, 'till-delivery');
const NOT_SENT = 'PriceNotSentToTills';
const SENT = 'PackSentForStore';

interface SentForStore { readonly storeId: string; readonly version: number; readonly at: string }

export function notSentLogAdapter(input: { readonly store: EventStore }): NotSentLog {
  return {
    recordNotSent: async (tenantId, e) => {
      await input.store.append(tenantId, TILL_DELIVERY_STREAM, makeEvent({
        id: `not-sent-${e.storeId}-${e.productId}-${e.priceMinor}-${e.at}`, type: NOT_SENT, occurredAt: e.at,
        idempotencyKey: `not-sent-${tenantId}-${e.storeId}-${e.productId}-${e.priceMinor}-${e.at}`, source: 'api/catalogue', payload: e,
      }));
    },
    recordSent: async (tenantId, storeId, version, at) => {
      await input.store.append(tenantId, TILL_DELIVERY_STREAM, makeEvent({
        id: `sent-${storeId}-v${version}`, type: SENT, occurredAt: at,
        // One pack version, once: a retried send of the same version is the same fact.
        idempotencyKey: `sent-${tenantId}-${storeId}-v${version}`, source: 'api/catalogue', payload: { storeId, version, at } satisfies SentForStore,
      }));
    },
    since: async (tenantId, storeId) => {
      // Folded in append order: a pack that went for the store settles everything not sent before it.
      let open: NotSentToTills[] = [];
      for (const e of await input.store.readStream(tenantId, TILL_DELIVERY_STREAM) as readonly PersistedEvent[]) {
        const p = e.event.payload as { storeId?: unknown };
        if (p.storeId !== storeId) continue;
        if (e.event.type === SENT) open = [];
        else if (e.event.type === NOT_SENT) open.push(e.event.payload as NotSentToTills);
      }
      return open;
    },
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
