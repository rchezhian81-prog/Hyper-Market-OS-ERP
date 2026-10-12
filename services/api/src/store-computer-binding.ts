// OB-54 "A" (owner, 11 Oct 2026): each store computer's credential is locked to its own store — composed for the kernel.
//
// The kernel calls this on EVERY request after the permission check. A caller who holds no `store_computer` grant is
// never judged (a person's sign-in is untouched). A store computer is refused, by name, when its credential names no
// store, names a store its grant does not, or the request names a record at another store — and each refusal is kept
// on head office's own append-only record (`GET /v1/store-computers/refusals`), so it is a visible exception at head
// office as well as a dead letter on the box, never a silent drop (P-08 · hard rules #6 and #10).

import { createHash } from 'node:crypto';
import type { EventStore } from '../../../packages/persistence/src/event-store';
import type { BoundStoreGuard, BoundStoreVerdict, Route } from '../../kernel/src/index';
import { classifyReferences, isRelayWrite, isWrite, paddedWritePathParam, judgePersonRelay, judgeBoxRequest, malformedStoreField, paddedStoreParam, storeReferencesIn, storeStampFor, STORE_COMPUTER_ROLE, type BoxRequestVerdict, type StoreReference } from '../../platform/src/store-computer-identity';
import { relayRecordStore, type RelayCaller, type RelayPlacement } from './relay-record-store';
import { storeComputerRefusalsAdapter, storeOfLocationResolver, STREAM, streamName } from './adapters';
import { makeEvent } from '../../../packages/contracts/src/event';

/**
 * OB-54 round 10: what head office did with a store computer's record that named no store — stamped the credential's
 * store at `field`, or (field null) attributed the record to it on a route that carries no store field. Append-only,
 * once per distinct accepted request (a replay collapses onto the first).
 */
export interface StoreComputerStamp {
  readonly stampId: string;
  readonly userId: string;
  /** The store the box's SIGNED credential names — the store written onto (or attributed to) the record. */
  readonly store: string;
  readonly field: string | null;
  readonly method: string;
  readonly path: string;
  readonly at: string;
}

export function storeComputerStampsAdapter(input: { readonly store: EventStore }): {
  record: (tenantId: string, s: StoreComputerStamp) => Promise<void>;
  list: (tenantId: string) => Promise<readonly StoreComputerStamp[]>;
} {
  const stream = streamName(STREAM.org, 'store-computer-stamps');
  return {
    record: async (tenantId, st) => {
      await input.store.append(tenantId, stream, makeEvent({
        id: `store-computer-stamped-${st.stampId}`, type: 'StoreComputerRecordStamped', occurredAt: st.at,
        idempotencyKey: `store-computer-stamped-${tenantId}-${st.stampId}`, source: 'api/platform', payload: st,
      }));
    },
    list: async (tenantId) => (await input.store.readStream(tenantId, stream, { type: 'StoreComputerRecordStamped' }))
      .map((e) => e.event.payload as StoreComputerStamp),
  };
}

export function storeComputerBinding(input: { readonly store: EventStore; readonly now: () => string }): BoundStoreGuard {
  const refusals = storeComputerRefusalsAdapter({ store: input.store });
  const stamps = storeComputerStampsAdapter({ store: input.store });
  const records = relayRecordStore(input);
  type Request = Parameters<BoundStoreGuard>[2];
  type Principal = Parameters<BoundStoreGuard>[0];
  /**
   * Every store the request names, and (round 14, verifier G1-G3) what head office itself places the request's record in:
   * the OWN store of a held record the route acts on (every keyed relay route, `RELAY_RECORD_KEY`), and the store a NEW
   * sale's or till record's lane is registered at — so naming another store's record by its id is judged like naming
   * that store.
   */
  const referencesOf = async (tenantId: string, request: Request, caller: RelayCaller): Promise<{ references: StoreReference[]; placement: RelayPlacement }> => {
    const placement = await records.derive(tenantId, request, caller);
    return { references: [...classifyReferences(request.routePath, storeReferencesIn(request)), ...placement.references], placement };
  };
  /** Keep a refused relay on head office's append-only refusal list (visible, never lost) — persons' as well as boxes'. */
  const keepRefusal = async (principal: Principal, request: Request, by: 'store_computer' | 'person', reason: string, extra: { namedStore?: string; field?: string }): Promise<void> => {
    // One record per distinct refused request: the same request re-sent collapses onto the first.
    const refusalId = createHash('sha256').update(JSON.stringify([principal.userId, principal.branchId, request.method, request.routePath, request.params, request.query, request.body ?? null])).digest('hex').slice(0, 32);
    await refusals.record(principal.tenantId, {
      refusalId, userId: principal.userId, credentialStore: principal.branchId, reason, by,
      ...(extra.namedStore === undefined ? {} : { namedStore: extra.namedStore }),
      ...(extra.field === undefined ? {} : { field: extra.field }),
      method: request.method, path: request.routePath, at: input.now(),
    });
  };
  /**
   * Round 15 (verifier LOW — placement not atomic): a record head office does not hold yet (it starts at a store) is
   * CLAIMED for the caller's store BEFORE the handler runs — one idempotency key per record, so two stores relaying the
   * same new id at the same moment meet on that key and exactly one claim stands. Returns the store whose claim stands
   * (the caller's, or the earlier claimant's). A crash between the claim and the handler's own write leaves the record
   * claimed by the store that sent it: only that store's re-send is accepted. undefined when nothing is to be claimed.
   */
  const claim = async (principal: Principal, placement: RelayPlacement, store: string | undefined): Promise<string | undefined> => {
    const record = placement.record;
    if (record === undefined || store === undefined || store === '') return undefined;
    return (await records.owners.place(principal.tenantId, { family: record.family, recordId: record.recordId, store, userId: principal.userId, at: input.now() })).store;
  };
  /**
   * Round 13 (verifier D1 · PA-01): a PERSON holding a relay permission (a store manager's `till.dayclose.sync`, a
   * cashier's sync grants) relays only for the branches their grants give them for that permission — the stores the
   * request names AND the held record's own store. Round 14 (verifier G1-G3): the held record's store is resolved for
   * EVERY keyed relay route, and a relay that head office cannot place in any store (it names none, its lane is not
   * registered, its pack names none) is REFUSED for a person whose role does not cover the whole business, rather than
   * passed. Each refusal is kept on head office's refusal list. Company-wide callers and every non-relay route are
   * untouched (their handlers apply PA-01 themselves).
   */
  const judgePerson = async (principal: Principal, access: Parameters<BoundStoreGuard>[1], request: Request): Promise<BoundStoreVerdict> => {
    if (!isRelayWrite(request.method, request.routePath)) return { ok: true };
    const scope = access.branchScopeOf(principal.userId, request.permission);
    const { references, placement } = await referencesOf(principal.tenantId, request, { kind: 'person' });
    const placing = await storeOfLocationResolver(input, principal.tenantId);
    const placedStore = references.map((r) => placing.storeOf(r.value)).find((st) => placing.knownStores.has(st));
    if (scope === 'all') {
      await claim(principal, placement, placedStore);
      return { ok: true };
    }
    if (placement.unresolved !== undefined) {
      await keepRefusal(principal, request, 'person', 'record_store_unresolved', { field: placement.unresolved.field });
      return { ok: false, code: 'record_store_unresolved', why: placement.unresolved.why, nextSafeAction: 'A person whose role covers the whole business looks at the record and places it. Nothing was recorded except this refusal.' };
    }
    if (references.length === 0) {
      await keepRefusal(principal, request, 'person', 'relay_names_no_store', {});
      return {
        ok: false, code: 'relay_names_no_store',
        why: `This relay (${request.permission}) names no store, and head office cannot place it in one (no location, no registered lane, no held record) — so it cannot be shown to be within this account's branches (${scope.join(', ') || 'none'}).`,
        nextSafeAction: 'Relay it from the store\'s own computer, or name the store (or register the lane at its store). The refusal is kept on head office\'s list; nothing else was recorded.',
      };
    }
    const judged = judgePersonRelay({ scope, references, ...placing });
    // A new store-originated record is claimed for its store before the handler; a claim another store won first is judged.
    const standing = judged.ok ? await claim(principal, placement, placedStore) : undefined;
    const verdict = standing === undefined || standing === placedStore ? judged
      : judgePersonRelay({ scope, references: [{ field: placement.record!.field, value: standing, names: 'store' }], ...placing });
    if (verdict.ok) return { ok: true };
    await keepRefusal(principal, request, 'person', 'outside_your_branch_scope', { namedStore: verdict.namedStore, field: verdict.field });
    return {
      ok: false, code: 'outside_your_branch_scope',
      why: `This account's authority to relay (${request.permission}) does not reach branch "${verdict.namedStore}" (named at ${verdict.field}). A person relays only for the branches their own role covers.`,
      nextSafeAction: 'Relay it from that store (its own computer or a person whose role covers that branch). The refusal is kept on head office\'s list; nothing else was recorded.',
    };
  };
  return async (principal, access, request) => {
    const grants = access.assignmentsOf(principal.userId).filter((g) => g.roleId === STORE_COMPUTER_ROLE);
    const by = grants.length === 0 ? 'person' as const : 'store_computer' as const;
    // Round 14 (verifier G2): a store or location field that is a list, a number or an object is unreadable — refused 400,
    // never read as "no store" and placed by a fallback.
    // Round 15 (verifier GAP C): a store or location id with spaces around it is not canonical — the judge would read it
    // trimmed while a handler stored it as sent (a phantom " store-1 "). Refused 400 here, at head office's edge, for
    // every store computer request and every person's relay, so the judge and every handler see one value.
    // Round 16 (verifier C-1): the same edge now covers EVERY write by anyone — head office's company-wide writes too (a
    // stock movement, a lane registration, a wave or route assignment, a store's settings…) — so " store-1 " can never
    // become a phantom stock place, a padded lane or a stranded wave. Reads by a person stay as they were (no harm: a read
    // writes nothing).
    if (isWrite(request.method) || grants.length > 0) {
      const bad = malformedStoreField(request.body) ?? paddedStoreParam(request.params, request.query)
        ?? (isWrite(request.method) ? paddedWritePathParam(request.params) : undefined);
      if (bad !== undefined) {
        await keepRefusal(principal, request, by, 'store_field_not_readable', { field: bad });
        return {
          ok: false, status: 400, code: 'store_field_not_readable',
          why: `The record's ${bad} is not a piece of text naming one store or location exactly (a list, a number, an object, or text with spaces around it), so head office cannot tell where it belongs. It is never read as "no store", and never trimmed into another place.`,
          nextSafeAction: 'Keep the record at the store and send it with that field as one store or location id. The refusal is kept on head office\'s list; nothing else was recorded.',
        };
      }
    }
    if (grants.length === 0) return judgePerson(principal, access, request); // a person: PA-01 on relay writes only
    // The stores its store_computer grants NAME — a tenant-wide grant names none (it never stands for "every store").
    const grantedStores = [...new Set(grants.flatMap((g) => (g.branchScope === 'all' ? [] : g.branchScope)))];
    const { references, placement } = await referencesOf(principal.tenantId, request, { kind: 'store_computer', store: principal.branchId });
    const placing = references.length === 0 ? { storeOf: (st: string) => st, knownStores: new Set<string>() } : await storeOfLocationResolver(input, principal.tenantId);
    const judged: BoxRequestVerdict = placement.unresolved !== undefined && principal.branchId !== null && grantedStores.includes(principal.branchId)
      ? { ok: false, reason: 'record_store_unresolved', field: placement.unresolved.field, why: placement.unresolved.why }
      : judgeBoxRequest({ credentialStore: principal.branchId, grantedStores, references, ...placing });
    // A new store-originated record is claimed for this box's store before the handler; one another store claimed first is refused.
    const standing = judged.ok ? await claim(principal, placement, principal.branchId!) : undefined;
    const verdict: BoxRequestVerdict = standing === undefined || standing === principal.branchId ? judged : {
      ok: false, reason: 'record_names_another_store', field: placement.record!.field, namedStore: standing,
      why: `Store ${principal.branchId}'s computer sent ${placement.record!.family} ${placement.record!.recordId}, which store ${standing}'s computer sent to head office first (named at ${placement.record!.field}). A store computer relays and reports only for its own store (OB-54), so it was refused and kept as an exception.`,
    };
    if (verdict.ok) {
      // OB-54 round 10: a record that names no store is STAMPED with the credential's store — server-side, recorded.
      const credentialStore = principal.branchId!; // judged above: the credential names a granted store
      const stamp = storeStampFor({ method: request.method, routePath: request.routePath, body: request.body, credentialStore, references });
      if (stamp.kind === 'none') return { ok: true };
      const stampId = createHash('sha256').update(JSON.stringify([principal.userId, credentialStore, request.method, request.routePath, request.params, request.body ?? null])).digest('hex').slice(0, 32);
      const onAccepted = async (): Promise<void> => {
        await stamps.record(principal.tenantId, {
          stampId, userId: principal.userId, store: credentialStore, field: stamp.kind === 'stamped' ? stamp.field : null,
          method: request.method, path: request.routePath, at: input.now(),
        });
      };
      return stamp.kind === 'stamped' ? { ok: true, stampedBody: stamp.body, onAccepted } : { ok: true, onAccepted };
    }
    await keepRefusal(principal, request, 'store_computer', verdict.reason, {
      ...(verdict.namedStore === undefined ? {} : { namedStore: verdict.namedStore }),
      ...(verdict.field === undefined ? {} : { field: verdict.field }),
    });
    return {
      ok: false, code: `store_computer_${verdict.reason}`, why: verdict.why,
      nextSafeAction: verdict.reason === 'record_names_unknown_store'
        ? 'The record stays at this store computer as a dead letter for a person to look at: head office cannot place the store or location it names. Add that place to the store hierarchy, or correct the record; nothing was recorded at head office except this refusal.'
        : verdict.reason === 'record_names_another_store'
        ? 'The record stays at this store computer as a dead letter for a person to look at; it belongs to another store\'s computer. Nothing was recorded at head office except this refusal.'
        : verdict.reason === 'record_store_unresolved'
        ? 'The record stays at this store computer as a dead letter for a person to look at: head office holds it but cannot tell which store it belongs to. Nothing was recorded at head office except this refusal.'
        : 'The administrator re-issues this box\'s credential for its own store (docs/runbooks/demo-deployment-handover.md) and grants its store computer role for that one store. Nothing was recorded.',
    };
  };
}

/** Head office's read of what store computers tried to send for another store (owner, operations). */
export function storeComputerRefusalRoutes(input: { readonly store: EventStore | undefined; readonly now?: () => string }): readonly Route[] {
  const refusals = input.store === undefined ? undefined : storeComputerRefusalsAdapter({ store: input.store });
  const stamps = input.store === undefined ? undefined : storeComputerStampsAdapter({ store: input.store });
  const records = input.store === undefined ? undefined : relayRecordStore({ store: input.store, now: input.now ?? (() => new Date().toISOString()) });
  return [{
    api: 'API-01', method: 'GET', path: '/v1/store-computers/refusals',
    permission: 'platform.health.read',
    handler: async (ctx) => ({
      status: 200,
      body: {
        refusals: refusals === undefined ? [] : await refusals.list(ctx.tenantId),
        // OB-84: records a store's relay took first that head office's own record (the order, the subject) places at
        // another store — for head office to resolve; the rightful store's relays are accepted meanwhile.
        overruledClaims: records === undefined ? [] : await records.overruledClaims(ctx.tenantId),
      },
    }),
  }, {
    // OB-54 round 10: every record head office stamped (or attributed) with a box credential's store because it named none.
    api: 'API-01', method: 'GET', path: '/v1/store-computers/stamps',
    permission: 'platform.health.read',
    handler: async (ctx) => ({ status: 200, body: { stamps: stamps === undefined ? [] : await stamps.list(ctx.tenantId) } }),
  }];
}
