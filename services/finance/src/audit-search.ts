// API-09 Audit-trail search, reconstruct & tamper-verify (M34-FR-01 / NFR-15 / SEC-07 / hard rule #6).
//
// The tested `@sre/audit` AuditTrail is the tamper-evident memory of the system: who did what, when,
// where, and the before/after state, each record sealed with the hash of the one before it so a single
// changed byte is DETECTABLE — never silently absorbed (P-08). Its three read capabilities had no cloud
// route. This wires them, over a supplied trail (an export or a synced store dump — the SAME `@sre/audit`
// records the retention plan and evidence pack take):
//
//   • SEARCH — narrow the trail by actor / object / action / scope / period.
//   • RECONSTRUCT — rebuild an object's state from the evidence ALONE, with the chain of changes that
//     produced it, so "how did this price get here?" is answerable without trusting any screen (NFR-15).
//   • VERIFY — check the whole chain and name EVERY place it does not hold up (a record whose contents no
//     longer match its seal, a broken link, a sequence gap), rather than the first — an auditor sees the
//     full extent of a problem, not a hint of one.
//
// All three are pure reads over supplied evidence — they write nothing, and (like the engine) there is no
// operation here to change or drop a record (M34-FR-01: it must be impossible for anyone, the owner
// included, to edit the audit log). Gated `audit.retention.read`.
//
// HONEST SCOPE: the records are SUPPLIED. Nothing in the running system yet keeps this domain-level trail
// (the kernel keeps a separate request-level `audit_log`); a store that every module records into, read
// here directly, is the follow-on. This surface verifies and reconstructs whatever sealed trail it is
// handed, which is exactly what an auditor holding an export needs.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  AuditTrail, InMemoryAuditStore,
  type AuditRecord, type AuditQuery, type AuditObjectType,
} from '../../../packages/audit/src/index';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isStateMap = (v: unknown): v is Record<string, string> => isObj(v) && Object.values(v).every((x) => typeof x === 'string');

/** Validate a sealed audit record — every field the engine's search / reconstruct / verify reads. */
function readRecord(v: unknown): AuditRecord | undefined {
  if (!isObj(v)) return undefined;
  // The seal: a sequence, the previous hash (empty at genesis), and this record's own hash.
  if (!isInt(v['sequence']) || typeof v['previousHash'] !== 'string' || !isStr(v['hash'])) return undefined;
  if (!isStr(v['at']) || !isStr(v['actorId']) || !isStr(v['action']) || !isStr(v['objectType']) || !isStr(v['objectId'])) return undefined;
  const o = v['origin'];
  if (!isObj(o) || !isStr(o['tenantId']) || !(o['branchId'] === null || isStr(o['branchId']))) return undefined;
  if (o['deviceId'] !== undefined && !isStr(o['deviceId'])) return undefined;
  if (o['capturedOffline'] !== undefined && typeof o['capturedOffline'] !== 'boolean') return undefined;
  if (!(v['before'] === null || isStateMap(v['before'])) || !(v['after'] === null || isStateMap(v['after']))) return undefined;
  if (v['before'] === null && v['after'] === null) return undefined; // an entry with no state is not evidence
  for (const k of ['reason', 'approvalId', 'correlationId'] as const) {
    if (v[k] !== undefined && !isStr(v[k])) return undefined;
  }
  return v as unknown as AuditRecord;
}

function readAll(v: unknown): readonly AuditRecord[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: AuditRecord[] = [];
  for (const item of v) {
    const one = readRecord(item);
    if (one === undefined) return undefined;
    out.push(one);
  }
  return out;
}

/** Read an audit query — every field optional, each a string when present. */
function readQuery(v: unknown): AuditQuery | undefined {
  if (v === undefined) return {};
  if (!isObj(v)) return undefined;
  const out: Record<string, string> = {};
  for (const k of ['actorId', 'objectType', 'objectId', 'action', 'tenantId', 'branchId', 'from', 'until'] as const) {
    if (v[k] === undefined) continue;
    if (!isStr(v[k])) return undefined;
    out[k] = v[k] as string;
  }
  return out as AuditQuery;
}

/** Build the tested trail over the supplied sealed records — nothing is re-sealed; their seals are checked. */
function trailOf(records: readonly AuditRecord[]): AuditTrail {
  const store = new InMemoryAuditStore();
  for (const r of records) store.append(r);
  return new AuditTrail(store);
}

const badRecords = () => apiError(400, {
  code: 'not_readable_as_an_audit_trail',
  whatHappened: 'This needs { records[] } — each a sealed audit record with sequence, previousHash, hash, at, actorId, action, objectType, objectId, origin{tenantId,branchId}, and a before/after state.',
  wasItSaved: 'not_saved',
  nextSafeAction: 'Send the trail export to inspect. A search, reconstruct or verify reads; it never writes and never edits the trail.',
});

export function auditSearchRoutes(): readonly Route[] {
  return [
    {
      // SEARCH — narrow the supplied trail by actor / object / action / scope / period.
      api: 'API-09', method: 'POST', path: '/v1/audit/trail/search',
      permission: 'audit.retention.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const records = readAll(b['records']);
        const query = readQuery(b['query']);
        if (records === undefined || query === undefined) throw badRecords();
        const matches = trailOf(records).search(query);
        return { status: 200, body: { matches, total: matches.length } };
      },
    },
    {
      // RECONSTRUCT — rebuild one object's state from the evidence alone, with the history that produced it.
      api: 'API-09', method: 'POST', path: '/v1/audit/trail/reconstruct',
      permission: 'audit.retention.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const records = readAll(b['records']);
        if (records === undefined || !isStr(b['objectType']) || !isStr(b['objectId'])) {
          if (records === undefined) throw badRecords();
          throw apiError(400, { code: 'reconstruct_needs_an_object', whatHappened: 'Reconstructing needs the { objectType } and { objectId } to rebuild.', wasItSaved: 'not_saved', nextSafeAction: 'Name the object to reconstruct from the trail.' });
        }
        const { state, history } = trailOf(records).reconstruct(b['objectType'] as AuditObjectType, b['objectId'] as string);
        return { status: 200, body: { objectType: b['objectType'], objectId: b['objectId'], state, history, changes: history.length } };
      },
    },
    {
      // VERIFY — check the whole chain and name EVERY break, so tampering is detectable (P-08).
      api: 'API-09', method: 'POST', path: '/v1/audit/trail/verify',
      permission: 'audit.retention.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const records = readAll(b['records']);
        if (records === undefined) throw badRecords();
        return { status: 200, body: trailOf(records).verify() };
      },
    },
  ];
}
