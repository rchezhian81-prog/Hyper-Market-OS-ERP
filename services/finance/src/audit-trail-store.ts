// API-09 The PRODUCED domain audit trail — search / reconstruct / verify over the STORED chain (M34-FR-01).
//
// `audit-search.ts` gives these three reads over a trail an auditor SUPPLIES (an export). This reads the
// trail the running system now PRODUCES and keeps: every sealed domain action (slice 1: the credential
// lifecycle) is folded from the durable store and inspected here. It is the SAME tested `@sre/audit`
// engine and the SAME seals, so `verify` over the stored chain is the real end-to-end tamper check — a
// record changed, removed or reordered behind the store is named, never silently absorbed (P-08).
//
// This is distinct from the kernel's request-level `audit_log` (who called which route): that records
// the REQUEST; this records the domain FACT with its before/after state, so an object can be rebuilt from
// the evidence alone (NFR-15).
//
// Pure reads. There is no route here — nor anywhere — to edit or drop a record: the trail is written only
// by the domain action that produced it, with the actor taken from the authenticated session, never from
// a client (M34-FR-01, hard rule #6). Gated `audit.retention.read`.

import type { Route } from '../../kernel/src/index';
import { apiError, narrowScope, scopeNotHeld, assertBranchInScope } from '../../kernel/src/index';
import {
  AuditTrail, InMemoryAuditStore,
  type AuditRecord, type AuditQuery, type AuditObjectType,
} from '../../../packages/audit/src/index';

export interface StoredAuditTrailDeps {
  /** The whole sealed domain trail for a tenant, in the order it happened. */
  readonly records: (tenantId: string) => Promise<readonly AuditRecord[]> | readonly AuditRecord[];
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** Build the tested trail over the stored sealed records — nothing is re-sealed; their seals are checked. */
function trailOf(records: readonly AuditRecord[]): AuditTrail {
  const store = new InMemoryAuditStore();
  for (const r of records) store.append(r);
  return new AuditTrail(store);
}

/** Read the narrowing query from the URL — every field optional, taken only when a non-empty string. */
function queryFrom(q: Record<string, string>): AuditQuery {
  const out: Record<string, string> = {};
  for (const k of ['actorId', 'objectType', 'objectId', 'action', 'tenantId', 'branchId', 'from', 'until'] as const) {
    if (isStr(q[k])) out[k] = q[k];
  }
  return out as AuditQuery;
}

export function storedAuditTrailRoutes(deps: StoredAuditTrailDeps): readonly Route[] {
  return [
    {
      // SEARCH the stored trail — actor / object / action / scope / period, from the URL query.
      api: 'API-09', method: 'GET', path: '/v1/audit/trail',
      permission: 'audit.retention.read',
      handler: async (ctx) => {
        // PA-01-r1: a branch-limited reader searches only the records made at their branches (narrowed to ?branchId= when
        // asked; another branch refused by name). A record with no branch is head office's — company-wide readers only.
        const asked = ctx.query['branchId'];
        const scope = narrowScope(ctx, isStr(asked) ? [asked] : undefined);
        const records = (await deps.records(ctx.tenantId)).filter((r) => scope === 'all' || (r.origin.branchId !== null && scope.includes(r.origin.branchId)));
        const matches = trailOf(records).search(queryFrom(ctx.query));
        return { status: 200, body: { matches, total: matches.length } };
      },
    },
    {
      // VERIFY the whole stored chain — names EVERY break, so tampering is detectable (P-08).
      api: 'API-09', method: 'GET', path: '/v1/audit/trail/verify',
      permission: 'audit.retention.read',
      handler: async (ctx) => {
        // PA-01-r1: the chain is one for the whole shop — verifying it reads every branch's records, so it is a
        // company-wide act; a branch-limited reader is refused by name rather than shown a chain with holes.
        if (narrowScope(ctx) !== 'all') throw scopeNotHeld(['all branches']);
        const records = await deps.records(ctx.tenantId);
        return { status: 200, body: trailOf(records).verify() };
      },
    },
    {
      // RECONSTRUCT one object's state from the stored evidence alone (NFR-15) — ?objectType=&objectId=.
      api: 'API-09', method: 'GET', path: '/v1/audit/trail/reconstruct',
      permission: 'audit.retention.read',
      handler: async (ctx) => {
        if (!isStr(ctx.query['objectType']) || !isStr(ctx.query['objectId'])) {
          throw apiError(400, {
            code: 'reconstruct_needs_an_object',
            whatHappened: 'Reconstructing needs ?objectType= and ?objectId= to rebuild the object from the stored trail.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Name the object to reconstruct from the evidence.',
          });
        }
        const records = await deps.records(ctx.tenantId);
        // PA-01-r1: an object's history is rebuilt only when every record of it is at a branch the caller holds — never a
        // partial rebuild that looks whole.
        for (const r of records) {
          if (r.objectType !== ctx.query['objectType'] || r.objectId !== ctx.query['objectId']) continue;
          if (r.origin.branchId === null) { if (narrowScope(ctx) !== 'all') throw scopeNotHeld(['all branches']); } else assertBranchInScope(ctx, r.origin.branchId);
        }
        const { state, history } = trailOf(records).reconstruct(
          ctx.query['objectType'] as AuditObjectType, ctx.query['objectId'] as string,
        );
        return {
          status: 200,
          body: { objectType: ctx.query['objectType'], objectId: ctx.query['objectId'], state, history, changes: history.length },
        };
      },
    },
  ];
}
