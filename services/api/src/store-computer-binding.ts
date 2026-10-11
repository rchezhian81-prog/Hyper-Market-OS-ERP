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
import { judgeBoxRequest, storeReferencesIn, STORE_COMPUTER_ROLE } from '../../platform/src/store-computer-identity';
import { storeComputerRefusalsAdapter, storeOfLocationResolver } from './adapters';

export function storeComputerBinding(input: { readonly store: EventStore; readonly now: () => string }): BoundStoreGuard {
  const refusals = storeComputerRefusalsAdapter({ store: input.store });
  return async (principal, access, request) => {
    const grants = access.assignmentsOf(principal.userId).filter((g) => g.roleId === STORE_COMPUTER_ROLE);
    if (grants.length === 0) return { ok: true }; // not a store computer — nothing to judge
    // The stores its store_computer grants NAME — a tenant-wide grant names none (it never stands for "every store").
    const grantedStores = [...new Set(grants.flatMap((g) => (g.branchScope === 'all' ? [] : g.branchScope)))];
    const references = storeReferencesIn(request);
    const placing = references.length === 0 ? { storeOf: (s: string) => s, knownStores: new Set<string>() } : await storeOfLocationResolver(input, principal.tenantId);
    const verdict = judgeBoxRequest({ credentialStore: principal.branchId, grantedStores, references, ...placing });
    if (verdict.ok) return { ok: true };
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
      nextSafeAction: verdict.reason === 'record_names_another_store'
        ? 'The record stays at this store computer as a dead letter for a person to look at; it belongs to another store\'s computer. Nothing was recorded at head office except this refusal.'
        : 'The administrator re-issues this box\'s credential for its own store (docs/runbooks/demo-deployment-handover.md) and grants its store computer role for that one store. Nothing was recorded.',
    };
  };
}

/** Head office's read of what store computers tried to send for another store (owner, operations). */
export function storeComputerRefusalRoutes(input: { readonly store: EventStore | undefined }): readonly Route[] {
  const refusals = input.store === undefined ? undefined : storeComputerRefusalsAdapter({ store: input.store });
  return [{
    api: 'API-01', method: 'GET', path: '/v1/store-computers/refusals',
    permission: 'platform.health.read',
    handler: async (ctx) => ({ status: 200, body: { refusals: refusals === undefined ? [] : await refusals.list(ctx.tenantId) } }),
  }];
}
