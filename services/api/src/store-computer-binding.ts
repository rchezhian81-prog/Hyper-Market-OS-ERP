// OB-54 "A" (owner, 11 Oct 2026): each store computer's credential is locked to its own store — composed for the kernel.
//
// The kernel calls this on EVERY request after the permission check. A caller who holds no `store_computer` grant is
// never judged (a person's sign-in is untouched). A store computer is refused, by name, when its credential names no
// store, names a store its grant does not, or the request names a record at another store — and each refusal is kept
// on head office's own append-only record (`GET /v1/store-computers/refusals`), so it is a visible exception at head
// office as well as a dead letter on the box, never a silent drop (P-08 · hard rules #6 and #10).

import { createHash } from 'node:crypto';
import type { EventStore } from '../../../packages/persistence/src/event-store';
import type { BoundStoreGuard, Route } from '../../kernel/src/index';
import { classifyReferences, judgeBoxRequest, storeReferencesIn, storeStampFor, STORE_COMPUTER_ROLE, RECORD_STORE_PARAM, type StoreReference } from '../../platform/src/store-computer-identity';
import { paymentExceptionsAdapter } from './finance-close-adapters';
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
  return async (principal, access, request) => {
    const grants = access.assignmentsOf(principal.userId).filter((g) => g.roleId === STORE_COMPUTER_ROLE);
    if (grants.length === 0) return { ok: true }; // not a store computer — nothing to judge
    // The stores its store_computer grants NAME — a tenant-wide grant names none (it never stands for "every store").
    const grantedStores = [...new Set(grants.flatMap((g) => (g.branchScope === 'all' ? [] : g.branchScope)))];
    const references: StoreReference[] = [...classifyReferences(request.routePath, storeReferencesIn(request))];
    // OB-54 round 12: a route acting on a record head office already holds — the record's OWN store is judged too.
    const recordParam = RECORD_STORE_PARAM[request.routePath];
    const recordId = recordParam === undefined ? undefined : request.params[recordParam];
    if (recordParam !== undefined && recordId !== undefined && recordId !== '') {
      const held = (await paymentExceptionsAdapter(input).exceptions(principal.tenantId)).find((e) => e.attemptId === recordId);
      // A held record that names no store cannot be shown to be this box's: judged as an unplaceable store code.
      if (held !== undefined) references.push({ field: `record.${recordParam}`, value: held.storeId, names: 'store' });
    }
    const placing = references.length === 0 ? { storeOf: (s: string) => s, knownStores: new Set<string>() } : await storeOfLocationResolver(input, principal.tenantId);
    const verdict = judgeBoxRequest({ credentialStore: principal.branchId, grantedStores, references, ...placing });
    if (verdict.ok) {
      // OB-54 round 10: a record that names no store is STAMPED with the credential's store — server-side, recorded.
      const credentialStore = principal.branchId!; // judged above: the credential names a granted store
      const stamp = storeStampFor({ method: request.method, routePath: request.routePath, body: request.body, credentialStore, references });
      if (stamp.kind === 'none') return { ok: true };
      const stampId = createHash('sha256').update(JSON.stringify([principal.userId, credentialStore, request.method, request.routePath, request.params, request.body ?? null])).digest('hex').slice(0, 32);
      const onAccepted = (): Promise<void> => stamps.record(principal.tenantId, {
        stampId, userId: principal.userId, store: credentialStore, field: stamp.kind === 'stamped' ? stamp.field : null,
        method: request.method, path: request.routePath, at: input.now(),
      });
      return stamp.kind === 'stamped' ? { ok: true, stampedBody: stamp.body, onAccepted } : { ok: true, onAccepted };
    }
    const at = input.now();
    // One record per distinct refused request: the same request re-sent collapses onto the first.
    const refusalId = createHash('sha256').update(JSON.stringify([principal.userId, principal.branchId, request.method, request.routePath, request.params, request.query, request.body ?? null])).digest('hex').slice(0, 32);
    await refusals.record(principal.tenantId, {
      refusalId, userId: principal.userId, credentialStore: principal.branchId, reason: verdict.reason,
      ...(verdict.namedStore === undefined ? {} : { namedStore: verdict.namedStore }),
      ...(verdict.field === undefined ? {} : { field: verdict.field }),
      method: request.method, path: request.routePath, at,
    });
    return {
      ok: false, code: `store_computer_${verdict.reason}`, why: verdict.why,
      nextSafeAction: verdict.reason === 'record_names_unknown_store'
        ? 'The record stays at this store computer as a dead letter for a person to look at: head office cannot place the store or location it names. Add that place to the store hierarchy, or correct the record; nothing was recorded at head office except this refusal.'
        : verdict.reason === 'record_names_another_store'
        ? 'The record stays at this store computer as a dead letter for a person to look at; it belongs to another store\'s computer. Nothing was recorded at head office except this refusal.'
        : 'The administrator re-issues this box\'s credential for its own store (docs/runbooks/demo-deployment-handover.md) and grants its store computer role for that one store. Nothing was recorded.',
    };
  };
}

/** Head office's read of what store computers tried to send for another store (owner, operations). */
export function storeComputerRefusalRoutes(input: { readonly store: EventStore | undefined }): readonly Route[] {
  const refusals = input.store === undefined ? undefined : storeComputerRefusalsAdapter({ store: input.store });
  const stamps = input.store === undefined ? undefined : storeComputerStampsAdapter({ store: input.store });
  return [{
    api: 'API-01', method: 'GET', path: '/v1/store-computers/refusals',
    permission: 'platform.health.read',
    handler: async (ctx) => ({ status: 200, body: { refusals: refusals === undefined ? [] : await refusals.list(ctx.tenantId) } }),
  }, {
    // OB-54 round 10: every record head office stamped (or attributed) with a box credential's store because it named none.
    api: 'API-01', method: 'GET', path: '/v1/store-computers/stamps',
    permission: 'platform.health.read',
    handler: async (ctx) => ({ status: 200, body: { stamps: stamps === undefined ? [] : await stamps.list(ctx.tenantId) } }),
  }];
}
