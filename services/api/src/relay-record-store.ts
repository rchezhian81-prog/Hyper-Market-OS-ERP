// Round 14 (verifier G1 · G2 · G3): the store of the RECORD a relay acts on — resolved by head office, never taken from
// the caller.
//
// Before this, only three payment routes judged the store of the record they named by id, so a store-1 manager — or
// store-1's own store computer — could reopen store-2's locked day by naming its day-close id, and a store-1 cashier could
// relay a refund on store-2's sale, or a sale whose lane happened to be called "store-2". Now every keyed relay route
// (`RELAY_RECORD_KEY`, one row per route) resolves the store of the record AS HEAD OFFICE HOLDS IT, and the binding
// (`store-computer-binding.ts`) judges it like a store the request names: a person against their own branch scope, a
// store computer against its own store (OB-54). How each family is resolved:
//
//   • day-close (close, reopen) ......... the held close's own storeId;
//   • sale (a re-sent sale, a return) ... the held sale's stock location by the ONE deterministic rule
//                                          (`saleStockLocationOf`: declared → registered lane's store → pack's store) —
//                                          a held sale nothing places is UNRESOLVED and refused, never passed;
//   • a NEW sale / no-receipt return .... the store head office registered its lane at (device registry), and for a
//                                          sale naming no location the pack's store — never the free-text lane id;
//   • shift close, till cash ............ the store the till (lane) is registered at;
//   • payment-attempt ................... the held no-answer or late answer's storeId (round 13);
//   • every other family ................ the store head office recorded the record at when it first ACCEPTED a relay
//                                          of it (`relay-record-owners`, append-only, written on acceptance) — so a
//                                          later relay acting on that record by its id is judged against that store.
//   • migration (tenantWide) ............ the business's own cut-over record: no store.
//
// A record head office holds whose store it cannot resolve is refused by name (`record_store_unresolved`), never passed.

import type { EventStore } from '../../../packages/persistence/src/event-store';
import { makeEvent } from '../../../packages/contracts/src/event';
import { RELAY_RECORD_KEY, type StoreReference } from '../../platform/src/store-computer-identity';
import type { IncomingSale } from '../../pos/src/sale-intake';
import { paymentExceptionsAdapter } from './finance-close-adapters';
import { dayCloseAdapter, saleStockLocationOf, storeOfLane, storeOfPack, STREAM, streamName } from './adapters';

/** One record's recorded store: which family and id, the store, who relayed it, when. Append-only; the first one stands. */
export interface RelayRecordOwner {
  readonly family: string;
  readonly recordId: string;
  readonly store: string;
  readonly userId: string;
  readonly at: string;
}

const OWNERS = streamName(STREAM.org, 'relay-record-owners');

export function relayRecordOwnersAdapter(input: { readonly store: EventStore }): {
  owner: (tenantId: string, family: string, recordId: string) => Promise<RelayRecordOwner | undefined>;
  place: (tenantId: string, o: RelayRecordOwner) => Promise<void>;
  list: (tenantId: string) => Promise<readonly RelayRecordOwner[]>;
} {
  const key = (tenantId: string, family: string, recordId: string): string => `relay-record-owner-${tenantId}-${family}-${recordId}`;
  return {
    owner: async (tenantId, family, recordId) => {
      const held = await input.store.findByIdempotencyKey(tenantId, key(tenantId, family, recordId));
      return held === undefined ? undefined : (held.event.payload as RelayRecordOwner);
    },
    // Keyed per record: a second placement of the same record collapses onto the first (it was judged against it first).
    place: async (tenantId, o) => {
      await input.store.append(tenantId, OWNERS, makeEvent({
        id: `relay-record-owner-${o.family}-${o.recordId}`, type: 'RelayRecordPlaced', occurredAt: o.at,
        idempotencyKey: key(tenantId, o.family, o.recordId), source: 'api/platform', payload: o,
      }));
    },
    list: async (tenantId) => (await input.store.readStream(tenantId, OWNERS, { type: 'RelayRecordPlaced' })).map((e) => e.event.payload as RelayRecordOwner),
  };
}

/** What head office derives about one relay request, beyond the stores the request itself names. */
export interface RelayPlacement {
  /** Stores (or locations) head office places the request's record in — judged like stores the request names. */
  readonly references: readonly StoreReference[];
  /** A record head office HOLDS but cannot place in any store: refused by name, never passed. */
  readonly unresolved?: { readonly field: string; readonly why: string };
  /** The record this request is about, to be recorded at its store once the request is accepted (not for tenant-wide). */
  readonly record?: { readonly family: string; readonly recordId: string; readonly field: string };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
const bodyOf = (b: unknown): Record<string, unknown> => (b !== null && typeof b === 'object' && !Array.isArray(b) ? b as Record<string, unknown> : {});

export function relayRecordStore(input: { readonly store: EventStore; readonly now: () => string }): {
  derive: (tenantId: string, request: { readonly routePath: string; readonly params: Readonly<Record<string, string>>; readonly body: unknown }) => Promise<RelayPlacement>;
  owners: ReturnType<typeof relayRecordOwnersAdapter>;
} {
  const owners = relayRecordOwnersAdapter(input);
  const derive = async (tenantId: string, request: { readonly routePath: string; readonly params: Readonly<Record<string, string>>; readonly body: unknown }): Promise<RelayPlacement> => {
    const k = RELAY_RECORD_KEY[request.routePath];
    if (k === undefined) return { references: [] };
    const b = bodyOf(request.body);
    const recordId = k.param !== undefined ? str(request.params[k.param]) : k.bodyKey !== undefined ? str(b[k.bodyKey]) : undefined;
    const field = `record.${k.param ?? k.bodyKey ?? 'id'}`;
    const references: StoreReference[] = [];
    // ── what the request's own lane / till is registered at (a new sale, return, shift close or cash movement) ──
    const laneRefs = async (fields: readonly string[], from: Readonly<Record<string, unknown>>): Promise<void> => {
      for (const f of fields) {
        const store = await storeOfLane(input.store, tenantId, from[f]);
        if (store !== undefined) references.push({ field: `record.${f}`, value: store, names: 'store' });
      }
    };
    if (k.tenantWide === true || recordId === undefined) return { references };

    let heldStore: StoreReference | undefined;
    let held = false;
    switch (k.family) {
      case 'day-close': {
        const close = await dayCloseAdapter(input).dayClose(tenantId, recordId);
        if (close !== undefined) { held = true; const s = str(close.storeId); if (s !== undefined) heldStore = { field, value: s, names: 'store' }; }
        break;
      }
      case 'sale': {
        const banked = await input.store.findByIdempotencyKey(tenantId, `sale-${tenantId}-${recordId}`);
        if (banked !== undefined) {
          held = true;
          const at = await saleStockLocationOf(input.store, tenantId, banked.event.payload as IncomingSale);
          // A held sale nothing placed stays unresolved (refused below); a declared shelf is placed in its store by the judge.
          if (at.basis !== 'unplaced') heldStore = { field, value: at.locationId, names: at.basis === 'declared_by_lane' ? 'location' : 'store' };
        }
        if (request.routePath === '/v1/sales') {
          await laneRefs(['laneId'], b);
          // A NEW sale naming no location is placed (as `bankSale` will place it) by its pack's store — judged here too.
          if (str(b['locationId']) === undefined && references.length === 0 && Number.isInteger(b['packVersion'])) {
            const pack = await storeOfPack(input.store, tenantId, b['packVersion'] as number);
            if (pack !== undefined) references.push({ field: 'record.packVersion', value: pack, names: 'store' });
          }
        }
        break;
      }
      case 'no-receipt-return': await laneRefs(['laneId'], b); break;
      case 'shift': await laneRefs(['tillId', 'laneId'], b); break;
      case 'till': {
        const store = await storeOfLane(input.store, tenantId, recordId);
        if (store !== undefined) references.push({ field, value: store, names: 'store' });
        await laneRefs(['laneId'], b);
        break;
      }
      case 'payment-attempt': {
        // Round 13 (verifier P5): head office "holds" an attempt when it has an exception for it OR a late answer for it.
        const payments = paymentExceptionsAdapter(input);
        const item = (await payments.exceptions(tenantId)).find((e) => e.attemptId === recordId)
          ?? (await payments.lateAnswers(tenantId)).find((a) => a.attemptId === recordId);
        if (item !== undefined) { held = true; heldStore = { field, value: item.storeId, names: 'store' }; }
        break;
      }
      default: break;
    }
    if (heldStore === undefined) {
      const owner = await owners.owner(tenantId, k.family, recordId);
      if (owner !== undefined) { held = true; heldStore = { field, value: owner.store, names: 'store' }; }
    }
    if (heldStore !== undefined) references.push(heldStore);
    else if (held) {
      return {
        references,
        unresolved: { field, why: `Head office already holds ${k.family} ${recordId}, but cannot tell which store it belongs to, so nobody can act on it by relay until a person places it.` },
      };
    }
    return { references, record: { family: k.family, recordId, field } };
  };
  return { derive, owners };
}
