// OB-352 (owner, 24 Oct 2026, in writing) — head office's wiring for the till delivery's address and slot. One import and
// one registration line in `main.ts`; `till-side-adapters.ts` records each till delivery job here when it books one.
//
//   • the job register — one record per till delivery job (`till-<saleId>`), with the member code the bill named;
//   • "has the app" — the membership is tied to an app account now (the desk's member ↔ app link, seen on the phone);
//   • the customer's own saved addresses (the account controls' register), never re-typed;
//   • the slot bound through head office's own delivery service (`bindDelivery`), whose booking the dispatch board reads.

import type { EventStore } from '../../../packages/persistence/src/event-store';
import { makeEvent } from '../../../packages/contracts/src/event';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { wallClockIn } from '../../../packages/calendar/src/trading-day';
import type { Route } from '../../kernel/src/index';
import { InMemoryEventStore } from '../../../packages/persistence/src/event-store';
import { tillDeliveryJobRoutes, type TillDeliveryJob, type TillDeliveryGiven, type TillDeliveryJobDeps } from '../../fulfilment/src/till-delivery-jobs';
import { bindDelivery, openDeliverySlots } from '../../orders/src/delivery-service';
import { currentMemberLink, type MemberAppLink } from '../../customer/src/digital-receipts';
import type { SavedAddress } from '../../orders/src/storefront-account';
import type { LoyaltyWalletDeps } from '../../customer/src/loyalty-wallets';
import { STREAM, streamName, ordersAdapter, deliveryServiceAdapter } from './adapters';
import { foldControls, type ControlsChange } from '../../fulfilment/src/delivery-controls';
import { appMemberOf, MEMBER_LINKS_STREAM, SAVED_ADDRESSES_STREAM } from './customer-commerce-adapters';

interface Base {
  readonly store: EventStore;
  readonly now: () => string;
  readonly timeZone: (tenantId: string) => Promise<string> | string;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}

const JOBS = streamName(STREAM.delivery, 'till-delivery-jobs');

const payloadsOf = async <T>(store: EventStore, tenantId: string, stream: string, type: string): Promise<readonly T[]> =>
  (await store.readStream(tenantId, stream, { type })).map((e) => e.event.payload as T);

async function append<T>(store: EventStore, tenantId: string, type: string, key: string, at: string, payload: T): Promise<void> {
  await store.append(tenantId, JOBS, makeEvent({ id: `${type}-${key}`, type, occurredAt: at, idempotencyKey: `${type}-${tenantId}-${key}`, source: 'api/till-delivery', payload }));
}

/** OB-352: record a till delivery job when head office books it (idempotent per order). */
export function recordTillDeliveryJob(store: EventStore) {
  return async (tenantId: string, job: TillDeliveryJob): Promise<void> => append(store, tenantId, 'TillDeliveryJobBooked', job.orderId, job.bookedAt, job);
}

/** The app account a membership is tied to now: an account whose CURRENT link points at this member code. */
export function appAccountOf(links: readonly MemberAppLink[], memberRef: string): string | undefined {
  const accounts = [...new Set(links.filter((l) => l.memberRef === memberRef).map((l) => l.customerRef))].sort();
  return accounts.find((c) => currentMemberLink(links, c)?.memberRef === memberRef);
}

export function tillDeliveryJobAdapter(input: Base): TillDeliveryJobDeps {
  const { store, now } = input;
  const delivery = deliveryServiceAdapter({ store, now, timeZone: input.timeZone });
  const orders = ordersAdapter({ store, now, holdMinutes: 0 });
  const memberOf = appMemberOf({ store, now });
  return {
    now,
    jobs: (t) => payloadsOf<TillDeliveryJob>(store, t, JOBS, 'TillDeliveryJobBooked'),
    given: (t) => payloadsOf<TillDeliveryGiven>(store, t, JOBS, 'TillDeliveryAddressGiven'),
    recordGiven: (t, g) => append(store, t, 'TillDeliveryAddressGiven', g.orderId, g.at, g),
    appAccountOfMember: async (t, memberRef) => appAccountOf(await payloadsOf<MemberAppLink>(store, t, MEMBER_LINKS_STREAM, 'MemberAppLinked'), memberRef),
    memberOfAppAccount: async (t, customerRef) => (await memberOf(t, customerRef))?.memberRef,
    savedAddresses: async (t, customerRef) => {
      const latest = new Map<string, SavedAddress>();
      for (const a of await payloadsOf<SavedAddress>(store, t, SAVED_ADDRESSES_STREAM, 'AddressSaved')) if (a.customerRef === customerRef) latest.set(a.addressId, a);
      return [...latest.values()].filter((a) => a.change === 'saved').sort((a, b) => a.label.localeCompare(b.label))
        .map((a) => ({ addressId: a.addressId, label: a.label, location: a.location, ...(a.landmark === undefined ? {} : { landmark: a.landmark }) }));
    },
    bind: (t, orderId, bookedFor, slotStartsAt, location) => bindDelivery(delivery, { tenantId: t, orderId, customerRef: bookedFor, request: { slotStartsAt, deliveryLocation: location } }),
    openSlots: (t, day) => openDeliverySlots(delivery, t, day),
    orderState: async (t, orderId) => (await orders.orderState(t, orderId))?.state,
    dayOf: async (t, iso) => wallClockIn(iso, await input.timeZone(t)).slice(0, 10),
    // OB-369: the owner's wait, one of his delivery numbers (the same register the Dispatch page sets) — "not set" until then.
    appChoiceWaitHours: async (t) => foldControls(await payloadsOf<ControlsChange>(store, t, streamName(STREAM.delivery, 'controls'), 'DeliveryControlsSet')).values.appChoiceWaitHours,
    ...(input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit }),
  };
}

/** OB-352: "has the app" in the till's wallet feed — each member whose membership is tied to an app account now. */
export function withWalletAppLinks<D extends LoyaltyWalletDeps>(wallets: D, input: Pick<Base, 'store' | 'now'>): D {
  return {
    ...wallets,
    appLinked: async (t: string, memberRef: string) => appAccountOf(await payloadsOf<MemberAppLink>(input.store, t, MEMBER_LINKS_STREAM, 'MemberAppLinked'), memberRef) !== undefined,
  };
}

/** The routes, for `main.ts`. */
export function tillDeliveryJobsRoutes(input: Omit<Base, 'store'> & { readonly store: EventStore | undefined }): readonly Route[] {
  return tillDeliveryJobRoutes(tillDeliveryJobAdapter({ ...input, store: input.store ?? new InMemoryEventStore() }));
}
