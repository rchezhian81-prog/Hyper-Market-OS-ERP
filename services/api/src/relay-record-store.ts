// Round 14 (verifier G1 · G2 · G3) and round 15 (verifier GAP A · OB-80): the store of the RECORD a relay acts on —
// resolved by head office from its OWN record, never taken from the caller and never from whichever store relays first.
//
// Every keyed relay route (`RELAY_RECORD_KEY`, one row per route) resolves the store of the record AS HEAD OFFICE HOLDS IT,
// and the binding (`store-computer-binding.ts`) judges it like a store the request names: a person against their own
// branch scope, a store computer against its own store (OB-54). Each family, and where its store is read from:
//
//   family              head office's own record (read FIRST)                     origin
//   ──────────────────  ────────────────────────────────────────────────────────  ─────────────────────────────────
//   day-close .......... the held close's storeId                                  store (stamped)
//   sale ............... the held sale's stock location (`saleStockLocationOf`)    store (stamped); a NEW sale from a
//                                                                                   person is placed by its registered
//                                                                                   lane / pack when it names no store
//   no-receipt-return .. the held return's locationId                              store (stamped)
//   payment-attempt .... the held no-answer / late answer's storeId                store (stamped)
//   wave ............... the store head office ASSIGNED it at (assignment index    HEAD OFFICE (assignment)
//                        + each known store's assignments)
//   delivery-route ..... the store head office ASSIGNED it at (as for waves)       HEAD OFFICE (assignment)
//   task ............... the task definition's branchId                             HEAD OFFICE
//   checklist .......... the stored checklist's branchId                            head office or store
//   count .............. the held count's locationId; a count under a plan: the     head office (plan) or store
//                        plan's locationId too
//   approval ........... the decided request's storeId / branchId, and the store    HEAD OFFICE (the pack's approvals
//                        of its SUBJECT (a held count, correction, delivery excess   list is built from head office's
//                        or day close — read from the id and from the body)          registers)
//   goods-receipt ...... the held receipt's warehouseId; the order it names: the    head office (order) or store
//                        order's deliver-to place
//   adjustment-request . the held request's storeId / locationId                   store (stamped)
//   floor-indent ....... the held indent's floor (toLocationId)                    head office or store
//   supplier-invoice ... the held invoice's storeId                                head office or store
//   warehouse-command .. the held command's movement locations                     head office or store
//   receiving-scan ..... the held scan's storeId                                   store (stamped)
//   shift .............. the held close's storeId (OB-80)                          store (stamped)
//   till ............... OB-80: a till is (store, till) — for a store computer the store of its OWN credential (so two
//                        stores' "lane-1" never meet); for a person the store the body names, else the store the till is
//                        registered at
//   shelf-count ........ none needed: head office keeps shelf counts per (store, count) already — never shared
//   till-activity ...... store-originated only: `relay-record-owners`
//   migration .......... the business's own cut-over record: no store (tenantWide)
//
// Resolution: a record head office HOLDS is judged against the store(s) its own record names — a place that is a shelf or a
// bin is placed in its store first; a value head office cannot place is judged as a store code (so a box or a person of any
// OTHER store is refused, never passed). Only when head office's record names nothing does a placement recorded when a
// store's relay of it was first accepted (`relay-record-owners`) count — and a held record with neither is REFUSED by name
// (`record_store_unresolved`), never placed by whoever relays it first. `relay-record-owners` is consulted ALONE only for a
// record head office does not hold at all: one that genuinely starts at a store. Its first placement is CLAIMED before the
// handler runs (one idempotency key per record: two stores racing meet on the key, the loser is refused by name), so a
// crash between the claim and the handler leaves the record placed at the store that claimed it — re-sendable by that
// store only.
//
// Round 16 · OB-84 "A" (owner, 12 Oct 2026, "Head office's record decides"): when head office holds the record a relay's id
// is FOR — the purchase order a `grn-<po>-<n>` receipt is booked against (the order the held receipt names, else the order
// its id names), or the subject an approval decides (a held count, correction, excess, day close) — THAT record decides
// the store, over the store a held copy names and over any first claim. So a store computer that took such an id first
// (a misbehaving box, or an id minted before head office created its order or subject) never locks the rightful store out:
// the rightful store's relays are judged against head office's record and accepted; the earlier foreign claim is refused
// from then on and LISTED as an exception for head office to resolve (`overruledClaims`, shown on the store-computer
// refusal list) — nothing deleted, nothing merged (a different decision is kept beside it, approvalDecisionAdapter).

import type { EventStore } from '../../../packages/persistence/src/event-store';
import { makeEvent } from '../../../packages/contracts/src/event';
import { RELAY_RECORD_KEY, type StoreReference } from '../../platform/src/store-computer-identity';
import type { IncomingSale } from '../../pos/src/sale-intake';
import type { StockMovement } from '../../../packages/stock/src/position';
import type { ReceivingScanRecord } from '../../inventory/src/warehouse-synced';
import { paymentExceptionsAdapter } from './finance-close-adapters';
import {
  adjustmentRequestAdapter, allCountReconciliations, approvalDecisionAdapter, approvalDecisionRecords, approvalSubjectStore, decisionStoreResolver, assignedStoresOf, checklistStoreAdapter, countPlansAdapter,
  dayCloseAdapter, floorIndentsAdapter, foldPurchaseOrders, goodsReceiptAdapter, liveSupplierInvoices, lpActivityAdapter, saleStockLocationOf, shiftAdapter,
  storeOfLane, storeOfLocationResolver, storeOfPack, taskStoreAdapter, STREAM, streamName,
} from './adapters';

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
  /** Claim a record for a store. First claim wins (one key per record); returns the placement that STANDS. */
  place: (tenantId: string, o: RelayRecordOwner) => Promise<RelayRecordOwner>;
  list: (tenantId: string) => Promise<readonly RelayRecordOwner[]>;
} {
  const key = (tenantId: string, family: string, recordId: string): string => `relay-record-owner-${tenantId}-${family}-${recordId}`;
  return {
    owner: async (tenantId, family, recordId) => {
      const held = await input.store.findByIdempotencyKey(tenantId, key(tenantId, family, recordId));
      return held === undefined ? undefined : (held.event.payload as RelayRecordOwner);
    },
    // Keyed per record: a second placement of the same record collapses onto the first — and the first is returned, so
    // the caller can tell whether its own claim stands.
    place: async (tenantId, o) => {
      const res = await input.store.append(tenantId, OWNERS, makeEvent({
        id: `relay-record-owner-${o.family}-${o.recordId}`, type: 'RelayRecordPlaced', occurredAt: o.at,
        idempotencyKey: key(tenantId, o.family, o.recordId), source: 'api/platform', payload: o,
      }));
      return res.record.event.payload as RelayRecordOwner;
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
  /**
   * A record head office does NOT hold (it starts at a store): claimed for the caller's store before the handler runs
   * (`relay-record-owners`), so a later relay acting on it is judged against that store.
   */
  readonly record?: { readonly family: string; readonly recordId: string; readonly field: string };
}

/** OB-84: the purchase order a pack-issued goods-receipt id names (`grn-<po>-<n>`, store-pack-builder.ts). */
export const grnOrderOf = (grnId: string): string | undefined => /^grn-(.+)-\d+$/.exec(grnId)?.[1];

/** OB-84: a record a store's relay took first that head office's own record now places at ANOTHER store. */
export interface OverruledClaim {
  readonly family: 'approval' | 'goods-receipt';
  readonly recordId: string;
  /** The store whose relay holds the record (its copy names this store). */
  readonly claimedStore: string;
  /** The store head office's own record places it at — the store whose relays are accepted. */
  readonly decidingStore: string;
  /** Head office's record that decides: e.g. `stock_count CT-F`, `purchase order PO-0003`. */
  readonly decidedBy: string;
  readonly relayedBy: string | null;
  readonly at: string | null;
}

/** Who is relaying: a store computer (its credential's store) or a person. */
export interface RelayCaller { readonly kind: 'store_computer' | 'person'; readonly store?: string | null }

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
const bodyOf = (b: unknown): Record<string, unknown> => (b !== null && typeof b === 'object' && !Array.isArray(b) ? b as Record<string, unknown> : {});
const present = (...vs: readonly unknown[]): string[] => vs.flatMap((v) => (str(v) === undefined ? [] : [str(v)!]));

/** Head office's own record of one id: whether it holds it, and the stores or places that record names. */
interface Held { readonly held: boolean; readonly places: readonly string[] }
const NOT_HELD: Held = { held: false, places: [] };
const heldAt = (places: readonly string[]): Held => ({ held: true, places });

/** Families that only ever START at a store (head office has no route that creates one). */
const STORE_ORIGINATED: ReadonlySet<string> = new Set(['shift', 'till-activity', 'receiving-scan']);

/** The approval subject types whose subject head office holds in a register it can place (approve-then-apply, SP-4). */
const SUBJECT_FAMILY: Readonly<Record<string, string>> = Object.freeze({
  stock_count: 'count', stock_adjustment: 'adjustment-request', goods_receipt_excess: 'goods-receipt', day_close_reopen: 'day-close', day_reopen: 'day-close',
});

export function relayRecordStore(input: { readonly store: EventStore; readonly now: () => string }): {
  derive: (tenantId: string, request: { readonly routePath: string; readonly params: Readonly<Record<string, string>>; readonly body: unknown }, caller?: RelayCaller) => Promise<RelayPlacement>;
  owners: ReturnType<typeof relayRecordOwnersAdapter>;
  overruledClaims: (tenantId: string) => Promise<readonly OverruledClaim[]>;
} {
  const owners = relayRecordOwnersAdapter(input);

  /** Head office's OWN record of `recordId` in `family` — never the caller's word, never a first placement. */
  const holds = async (tenantId: string, family: string, recordId: string, knownStores: () => Promise<ReadonlySet<string>>): Promise<Held> => {
    switch (family) {
      case 'day-close': {
        const close = await dayCloseAdapter(input).dayClose(tenantId, recordId);
        return close === undefined ? NOT_HELD : heldAt(present(close.storeId));
      }
      case 'no-receipt-return': {
        const held = await input.store.findByIdempotencyKey(tenantId, `return-${tenantId}-${recordId}`);
        return held === undefined ? NOT_HELD : heldAt(present((held.event.payload as { locationId?: unknown }).locationId));
      }
      case 'wave': case 'delivery-route': {
        const stores = await assignedStoresOf(input, tenantId, family === 'wave' ? 'wave' : 'route', recordId, await knownStores());
        return stores.length === 0 ? NOT_HELD : heldAt(stores);
      }
      case 'task': {
        const task = (await taskStoreAdapter(input).tasks(tenantId)).find((t) => t.taskId === recordId);
        return task === undefined ? NOT_HELD : heldAt(present(task.branchId));
      }
      case 'checklist': {
        const c = await checklistStoreAdapter(input).checklist(tenantId, recordId);
        return c === undefined ? NOT_HELD : heldAt(present(c.branchId));
      }
      case 'count': {
        const c = (await allCountReconciliations(input.store, tenantId)).find((r) => r.countId === recordId);
        return c === undefined ? NOT_HELD : heldAt(present(c.locationId));
      }
      case 'goods-receipt': {
        const g = await goodsReceiptAdapter(input).grn(tenantId, recordId);
        return g === undefined ? NOT_HELD : heldAt(present(g.warehouseId));
      }
      case 'adjustment-request': {
        const r = await adjustmentRequestAdapter(input).request(tenantId, recordId);
        return r === undefined ? NOT_HELD : heldAt(present(r.storeId ?? r.locationId));
      }
      case 'floor-indent': {
        const i = await floorIndentsAdapter(input).indent(tenantId, recordId);
        return i === undefined ? NOT_HELD : heldAt(present(i.toLocationId));
      }
      case 'supplier-invoice': {
        const inv = (await liveSupplierInvoices(input.store, tenantId)).find((r) => r.invoiceId === recordId);
        return inv === undefined ? NOT_HELD : heldAt(present(inv.storeId));
      }
      case 'warehouse-command': {
        const rec = (await input.store.readStream(tenantId, streamName(STREAM.warehouse, 'movements'), { type: 'WarehouseMovementRecorded' }))
          .map((e) => e.event.payload as { commandId: string; movements: readonly StockMovement[] }).find((r) => r.commandId === recordId);
        return rec === undefined ? NOT_HELD : heldAt([...new Set(rec.movements.flatMap((m) => present(m.locationId)))]);
      }
      case 'receiving-scan': {
        const scan = (await input.store.readStream(tenantId, streamName(STREAM.purchase, 'grn-scans'), { type: 'ReceivingScanRecorded' }))
          .map((e) => e.event.payload as ReceivingScanRecord).find((r) => r.commandId === recordId);
        return scan === undefined ? NOT_HELD : heldAt(present(scan.storeId));
      }
      case 'shift': {
        const close = await shiftAdapter(input).closedShift(tenantId, recordId);
        return close === undefined ? NOT_HELD : heldAt(present(close.storeId));
      }
      case 'till-activity': {
        const a = await lpActivityAdapter(input).activity(tenantId, recordId);
        return a === undefined ? NOT_HELD : heldAt(present(a.storeId));
      }
      case 'approval': {
        const d = await approvalDecisionAdapter(input).decision(tenantId, recordId);
        return d === undefined ? NOT_HELD : heldAt(present(d.storeId ?? d.branchId));
      }
      default: return NOT_HELD;
    }
  };

  const derive = async (tenantId: string, request: { readonly routePath: string; readonly params: Readonly<Record<string, string>>; readonly body: unknown }, caller?: RelayCaller): Promise<RelayPlacement> => {
    const k = RELAY_RECORD_KEY[request.routePath];
    if (k === undefined) return { references: [] };
    const b = bodyOf(request.body);
    const recordId = k.param !== undefined ? str(request.params[k.param]) : k.bodyKey !== undefined ? str(b[k.bodyKey]) : undefined;
    const field = `record.${k.param ?? k.bodyKey ?? 'id'}`;
    const references: StoreReference[] = [];
    const box = caller?.kind === 'store_computer';
    // The body names its own store (or the box's credential is stamped onto it): then a lane id is that store's own lane
    // (OB-80 — a till is (store, till)), never looked up in the tenant-wide device register.
    const bodyNamesStore = str(b['storeId']) !== undefined || str(b['locationId']) !== undefined;
    // ── what a PERSON's request's own lane / till is registered at (a new sale, return, shift close or cash movement) ──
    const laneRefs = async (fields: readonly string[], from: Readonly<Record<string, unknown>>): Promise<void> => {
      if (box || bodyNamesStore) return;
      for (const f of fields) {
        const store = await storeOfLane(input.store, tenantId, from[f]);
        if (store !== undefined) references.push({ field: `record.${f}`, value: store, names: 'store' });
      }
    };
    if (k.tenantWide === true || recordId === undefined) return { references };

    let placing: Awaited<ReturnType<typeof storeOfLocationResolver>> | undefined;
    const resolver = async () => (placing ??= await storeOfLocationResolver(input, tenantId));
    const knownStores = async (): Promise<ReadonlySet<string>> => (await resolver()).knownStores;
    /** Head office's own places → references (a place it can put in a known store is that store; any other value is judged as a store code). */
    const placesToRefs = async (at: string, places: readonly string[]): Promise<StoreReference[]> => {
      const r = await resolver();
      return [...new Set(places.map((p) => (r.knownStores.has(r.storeOf(p)) ? r.storeOf(p) : p)))].map((value) => ({ field: at, value, names: 'store' as const }));
    };

    let held: Held = NOT_HELD;
    switch (k.family) {
      case 'sale': {
        const banked = await input.store.findByIdempotencyKey(tenantId, `sale-${tenantId}-${recordId}`);
        if (banked !== undefined) {
          const at = await saleStockLocationOf(input.store, tenantId, banked.event.payload as IncomingSale);
          // A held sale nothing placed stays unresolved (refused below); a declared shelf is placed in its store by the judge.
          if (at.basis !== 'unplaced') references.push({ field, value: at.locationId, names: at.basis === 'declared_by_lane' ? 'location' : 'store' });
          else return { references, unresolved: { field, why: `Head office already holds sale ${recordId}, but cannot tell which store it belongs to, so nobody can act on it by relay until a person places it.` } };
        }
        if (request.routePath === '/v1/sales') {
          await laneRefs(['laneId'], b);
          // A NEW sale naming no location is placed (as `bankSale` will place it) by its pack's store — judged here too.
          if (!box && str(b['locationId']) === undefined && references.length === 0 && Number.isInteger(b['packVersion'])) {
            const pack = await storeOfPack(input.store, tenantId, b['packVersion'] as number);
            if (pack !== undefined) references.push({ field: 'record.packVersion', value: pack, names: 'store' });
          }
        }
        // A sale places itself (its banked record carries its location, keyed by its id) — no separate placement row.
        return { references };
      }
      case 'payment-attempt': {
        // Round 13 (verifier P5): head office "holds" an attempt when it has an exception for it OR a late answer for it.
        const payments = paymentExceptionsAdapter(input);
        const item = (await payments.exceptions(tenantId)).find((e) => e.attemptId === recordId)
          ?? (await payments.lateAnswers(tenantId)).find((a) => a.attemptId === recordId);
        if (item !== undefined) held = heldAt(present(item.storeId));
        break;
      }
      case 'till': {
        // OB-80 (owner, 12 Oct 2026): head office keeps a till as (store, till). A store computer's till is its OWN store's
        // till (its credential's store is stamped on the movement), so another store's "lane-1" is a different till —
        // never judged against it, never merged with it. A person's: the store the body names, else the store head office
        // registered the till at.
        if (!box) await laneRefs(['tillId', 'laneId'], { ...b, tillId: recordId });
        return { references };
      }
      case 'shelf-count':
        // Head office keeps shelf counts per (store, count) — the stamped / named store IS the record's store.
        return { references };
      default:
        held = await holds(tenantId, k.family, recordId, knownStores);
        if (k.family === 'no-receipt-return' || k.family === 'shift') await laneRefs(['tillId', 'laneId'], b);
    }

    // ── records the request links to that head office holds: a count's plan, a receipt's order, an approval's subject ──
    if (k.family === 'count' && str(b['planId']) !== undefined) {
      const plan = await countPlansAdapter(input).plan(tenantId, str(b['planId'])!);
      if (plan !== undefined) references.push(...await placesToRefs('record.planId', present(plan.locationId)));
    }
    // OB-84: references from HEAD OFFICE's own record the id is for — they decide the store (see the header).
    const decided: StoreReference[] = [];
    if (k.family === 'goods-receipt') {
      const orders = await foldPurchaseOrders(input.store, tenantId);
      // The body's order is the caller's word: judged beside everything else, never deciding.
      if (str(b['poId']) !== undefined) {
        const po = orders.get(str(b['poId'])!);
        if (po?.deliverToLocationId !== undefined) references.push(...await placesToRefs('record.poId', present(po.deliverToLocationId)));
      }
      // Head office's order for THIS receipt: the one the held receipt names, else the one a pack-issued id names.
      const heldGrn = held.held ? await goodsReceiptAdapter(input).grn(tenantId, recordId) : undefined;
      const orderOf = str(heldGrn?.poId) ?? grnOrderOf(recordId);
      const order = orderOf === undefined ? undefined : orders.get(orderOf);
      if (order?.deliverToLocationId !== undefined) decided.push(...await placesToRefs(heldGrn?.poId ? 'record.order' : 'record.grnId', present(order.deliverToLocationId)));
    }
    if (k.family === 'approval') {
      // The subject the decision will be APPLIED to — named by the request id (`stock_count:<countId>`, as head office's
      // pack lists it) and by the body (what the apply step reads). Each is judged on head office's own record of it.
      const idType = recordId.includes(':') ? recordId.slice(0, recordId.indexOf(':')) : undefined;
      const subjects: [string | undefined, string | undefined][] = [
        [idType, idType === undefined ? undefined : recordId.slice(recordId.indexOf(':') + 1)],
        [str(b['subjectType']), str(b['subjectRef'])],
      ];
      for (const [type, ref] of subjects) {
        const fam = type === undefined ? undefined : SUBJECT_FAMILY[type];
        if (fam === undefined || ref === undefined) continue;
        const subject = await holds(tenantId, fam, ref, knownStores);
        if (!subject.held) continue; // a subject head office does not hold: the apply step refuses it by name
        if (subject.places.length === 0) return { references, unresolved: { field: 'record.subjectRef', why: `Head office holds the ${type} ${ref} this decision is about, but cannot tell which store it belongs to, so it is not applied by relay.` } };
        decided.push(...await placesToRefs('record.subjectRef', subject.places));
        if (!held.held) held = { held: true, places: [] }; // a decision on a subject head office holds is a head-office record
      }
    }

    // OB-84: head office's own record the id is for decides — over the held copy's store and over any first claim.
    const r0 = decided.length === 0 ? undefined : await resolver();
    if (r0 !== undefined && decided.some((d) => r0.knownStores.has(r0.storeOf(d.value)))) {
      references.push(...decided);
      return { references };
    }
    references.push(...decided);
    if (held.held) {
      // Head office's own record first. Only when it names no place it can put in a known store does a placement recorded
      // when a store's relay of it was first accepted count (a store-originated record held without a store field).
      const r = held.places.length === 0 ? undefined : await resolver();
      const placeable = r !== undefined && held.places.some((p) => r.knownStores.has(r.storeOf(p)));
      if (placeable) { references.push(...await placesToRefs(field, held.places)); return { references }; }
      const owner = await owners.owner(tenantId, k.family, recordId);
      if (owner !== undefined) { references.push({ field, value: owner.store, names: 'store' }); return { references }; }
      if (held.places.length > 0) { references.push(...await placesToRefs(field, held.places)); return { references }; }
      if (references.length > 0) return { references }; // placed by the subject it acts on (an approval)
      // A shift close, a till action or a back-door scan only ever starts at a store; one head office took before it carried
      // a store field — the store whose relay claims it first places it (as for any store-originated record).
      if (STORE_ORIGINATED.has(k.family)) return { references, record: { family: k.family, recordId, field } };
      return {
        references,
        unresolved: { field, why: `Head office already holds ${k.family} ${recordId}, but its own record names no store, so nobody can act on it by relay until a person places it.` },
      };
    }
    // Not held by head office: a record that starts at a store — placed at the store whose relay first claims it.
    const owner = await owners.owner(tenantId, k.family, recordId);
    if (owner !== undefined) { references.push({ field, value: owner.store, names: 'store' }); return { references }; }
    return { references, record: { family: k.family, recordId, field } };
  };
  /**
   * OB-84: every record a store's relay took that head office's own record now places at another store — listed for head
   * office to resolve (derived from the append-only records each time; nothing is deleted, moved or merged).
   */
  const overruledClaims = async (tenantId: string): Promise<readonly OverruledClaim[]> => {
    const r = await storeOfLocationResolver(input, tenantId);
    const storeOf = (place: string | null | undefined): string | undefined => {
      if (typeof place !== 'string' || place.trim() === '') return undefined;
      const st = r.storeOf(place); return r.knownStores.has(st) ? st : place;
    };
    const out: OverruledClaim[] = [];
    const from = await decisionStoreResolver(input.store, tenantId);
    for (const d of await approvalDecisionRecords(input.store, tenantId)) {
      const claimed = storeOf(from(d));
      if (claimed === undefined) continue;
      const deciding = await approvalSubjectStore(input, tenantId, d.subjectType, d.subjectRef);
      if (deciding !== undefined && deciding !== claimed) {
        out.push({ family: 'approval', recordId: d.id, claimedStore: claimed, decidingStore: deciding, decidedBy: `${d.subjectType} ${d.subjectRef}`, relayedBy: d.relayedBy, at: d.recordedAt });
      }
    }
    const orders = await foldPurchaseOrders(input.store, tenantId);
    for (const g of await goodsReceiptAdapter(input).all(tenantId)) {
      const poId = str(g.poId) ?? grnOrderOf(g.grnId);
      const deliverTo = poId === undefined ? undefined : orders.get(poId)?.deliverToLocationId;
      const deciding = storeOf(deliverTo);
      const claimed = storeOf(g.warehouseId);
      if (deciding !== undefined && claimed !== undefined && r.knownStores.has(deciding) && deciding !== claimed) {
        out.push({ family: 'goods-receipt', recordId: g.grnId, claimedStore: claimed, decidingStore: deciding, decidedBy: `purchase order ${poId!}`, relayedBy: g.relayedBy ?? null, at: g.receivedAt });
      }
    }
    return out;
  };
  return { derive, owners, overruledClaims };
}
