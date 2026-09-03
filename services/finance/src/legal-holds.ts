// API-09 Legal holds, retention plan & evidence pack (M34-FR-02 / PRV-08 / hard rule #6).
//
// Two duties pull in opposite directions and both are real: privacy says do not keep personal data
// for ever (PRV-08), and evidence says never destroy what an audit, a dispute or a court may need
// (hard rule #6). The tested `@sre/audit` engine resolves it by DELETING NOTHING — it produces a
// retention PLAN (what is past its period, what is held, what is statutory, what has no policy) and a
// legal HOLD that freezes records regardless of their age. `services/finance/src/retention.ts` already
// answers the statutory-period question; this wires the missing half — the hold LIFECYCLE and the plan
// that applies it:
//
//   • PLACE a hold — a dispute / investigation / case freezes a class or a single object; it needs a
//     reason (a hold nobody can explain is not defensible). Durable, append-only.
//   • LIFT a hold — recorded as a new state (`liftHold`), the hold itself NEVER erased (hard rule #6),
//     so a year later it is provable what was frozen, by whom, and when it was released.
//   • LIST holds — active first, the lifted kept beside them.
//   • PLAN retention — run `planRetention` over the supplied audit records + policies AND the tenant's
//     STORED holds: a record past its retention period that a hold covers comes back `legal_hold`, not
//     eligible — a hold beats the retention date (the FR-02 acceptance). Nothing is deleted; the
//     eligible set is a proposal for an authorised human decision, which is itself audited.
//   • EVIDENCE PACK — assemble the records for a period for an auditor / inspector / court, named to
//     the person who exported it (nothing leaves anonymously) and carrying the trail's seal.
//
// Placing / lifting gated `audit.hold.manage`; the plan, list and pack read `audit.retention.read`.
// A read never writes; no AI places, lifts or exports anything (hard rule #5).

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  planRetention, liftHold, buildEvidencePack,
  type LegalHold, type RetentionPolicy, type AuditRecord,
} from '../../../packages/audit/src/index';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** One append-only fact about a legal hold. The `change` says which; the extra fields carry its detail. */
export interface LegalHoldEvent {
  readonly holdId: string;
  readonly change: 'placed' | 'lifted';
  readonly by: string;
  readonly at: string;
  /** `placed` only — the hold as placed. */
  readonly hold?: LegalHold;
  /** `lifted` only — an optional note on why it was released. */
  readonly reason?: string;
}

/**
 * Fold the append-only log to the CURRENT set of holds — one per id. A `lifted` for a hold never placed
 * is ignored (no phantom hold); a re-place of a known id keeps the original (a hold is placed once).
 */
export function projectHolds(events: readonly LegalHoldEvent[]): readonly LegalHold[] {
  const byId = new Map<string, LegalHold>();
  for (const e of events) {
    if (e.change === 'placed') {
      if (e.hold !== undefined && !byId.has(e.holdId)) byId.set(e.holdId, e.hold);
      continue;
    }
    const hold = byId.get(e.holdId);
    if (hold === undefined || hold.liftedAt !== undefined) continue;
    byId.set(e.holdId, liftHold(hold, e.by, e.at));
  }
  return [...byId.values()];
}

export interface LegalHoldsDeps {
  readonly holds: (tenantId: string) => Promise<readonly LegalHold[]> | readonly LegalHold[];
  readonly recordHoldEvent: (tenantId: string, event: LegalHoldEvent, key: string) => Promise<void> | void;
  readonly now: () => string;
}

/** Read a hold placement off the request body — only the fields `LegalHold` needs, all validated. */
function readPlacement(b: Record<string, unknown>, placedBy: string, placedAt: string): LegalHold | undefined {
  if (!isStr(b['holdId']) || !isStr(b['reason'])) return undefined;
  for (const k of ['objectType', 'objectId', 'actorId', 'from', 'until'] as const) {
    if (b[k] !== undefined && !isStr(b[k])) return undefined;
  }
  return {
    holdId: (b['holdId'] as string).trim(),
    reason: (b['reason'] as string).trim(),
    placedBy, placedAt,
    ...(isStr(b['objectType']) ? { objectType: b['objectType'] as string } : {}),
    ...(isStr(b['objectId']) ? { objectId: b['objectId'] as string } : {}),
    ...(isStr(b['actorId']) ? { actorId: b['actorId'] as string } : {}),
    ...(isStr(b['from']) ? { from: b['from'] as string } : {}),
    ...(isStr(b['until']) ? { until: b['until'] as string } : {}),
  };
}

function readPolicy(v: unknown): RetentionPolicy | undefined {
  if (!isObj(v) || !isStr(v['objectType']) || !isInt(v['retainDays']) || (v['retainDays'] as number) < 0) return undefined;
  if (v['statutory'] !== undefined && typeof v['statutory'] !== 'boolean') return undefined;
  if (v['basis'] !== undefined && !isStr(v['basis'])) return undefined;
  return {
    objectType: v['objectType'] as string, retainDays: v['retainDays'] as number,
    ...(v['statutory'] === true ? { statutory: true } : {}),
    ...(isStr(v['basis']) ? { basis: v['basis'] as string } : {}),
  };
}

/** Validate the fields the retention/evidence engines actually read off an audit record. */
function readRecord(v: unknown): AuditRecord | undefined {
  if (!isObj(v) || !isInt(v['sequence']) || !isStr(v['objectType']) || !isStr(v['objectId']) || !isStr(v['at']) || !isStr(v['actorId'])) return undefined;
  if (v['hash'] !== undefined && typeof v['hash'] !== 'string') return undefined;
  return v as unknown as AuditRecord;
}

function readAll<T>(v: unknown, read: (x: unknown) => T | undefined): readonly T[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: T[] = [];
  for (const item of v) {
    const one = read(item);
    if (one === undefined) return undefined;
    out.push(one);
  }
  return out;
}

export function legalHoldsRoutes(deps: LegalHoldsDeps): readonly Route[] {
  return [
    {
      // PLACE — freeze a class or a single object for a dispute / investigation. Needs a reason; a
      // second place of a known id is refused (a hold is placed once, never silently re-scoped).
      api: 'API-09', method: 'POST', path: '/v1/audit/legal-holds',
      permission: 'audit.hold.manage', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const at = deps.now();
        const hold = readPlacement(b, ctx.userId, at);
        if (hold === undefined) {
          throw apiError(400, {
            code: 'not_readable_as_a_hold',
            whatHappened: 'Placing a legal hold needs a { holdId } and a { reason }, plus optional { objectType, objectId, actorId, from, until } to narrow it.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the hold id and why it is being placed. A hold with no reason cannot be defended later.',
          });
        }
        if ((await deps.holds(ctx.tenantId)).some((h) => h.holdId === hold.holdId)) {
          throw apiError(409, { code: 'hold_already_placed', whatHappened: `A legal hold called '${hold.holdId}' already exists.`, wasItSaved: 'not_saved', nextSafeAction: 'Use a different hold id, or lift the existing one.' });
        }
        await deps.recordHoldEvent(ctx.tenantId, { holdId: hold.holdId, change: 'placed', by: ctx.userId, at, hold }, `hold-${hold.holdId}`);
        return { status: 201, body: { holdId: hold.holdId, placedBy: ctx.userId, placedAt: at } };
      },
    },
    {
      // LIFT — release a hold. Recorded as a new state; the hold is NEVER erased (hard rule #6). Lifting
      // an unknown hold → 404, an already-lifted one → 409.
      api: 'API-09', method: 'POST', path: '/v1/audit/legal-holds/:holdId/lift',
      permission: 'audit.hold.manage', idempotent: true,
      handler: async (ctx) => {
        const holdId = ctx.params['holdId'] ?? '';
        const hold = (await deps.holds(ctx.tenantId)).find((h) => h.holdId === holdId);
        if (hold === undefined) {
          throw apiError(404, { code: 'unknown_hold', whatHappened: `There is no legal hold called '${holdId}'.`, wasItSaved: 'not_saved', nextSafeAction: 'Check the id against GET /v1/audit/legal-holds.' });
        }
        if (hold.liftedAt !== undefined) {
          throw apiError(409, { code: 'hold_already_lifted', whatHappened: `Legal hold '${holdId}' was already lifted by ${hold.liftedBy} at ${hold.liftedAt}.`, wasItSaved: 'not_saved', nextSafeAction: 'A hold is lifted once; it is kept, never erased.' });
        }
        const at = deps.now();
        const reason = isStr((ctx.body as Record<string, unknown> | null)?.['reason']) ? ((ctx.body as Record<string, unknown>)['reason'] as string) : undefined;
        await deps.recordHoldEvent(ctx.tenantId, { holdId, change: 'lifted', by: ctx.userId, at, ...(reason !== undefined ? { reason } : {}) }, `lift-${holdId}`);
        return { status: 200, body: { holdId, liftedBy: ctx.userId, liftedAt: at } };
      },
    },
    {
      // LIST — every hold, active first, the lifted kept beside them.
      api: 'API-09', method: 'GET', path: '/v1/audit/legal-holds',
      permission: 'audit.retention.read',
      handler: async (ctx) => {
        const all = await deps.holds(ctx.tenantId);
        const ordered = [...all].sort((a, b) => Number(a.liftedAt !== undefined) - Number(b.liftedAt !== undefined) || a.placedAt.localeCompare(b.placedAt));
        return { status: 200, body: { holds: ordered, active: all.filter((h) => h.liftedAt === undefined).length, asAt: deps.now() } };
      },
    },
    {
      // PLAN — what may be reviewed for deletion and what is frozen. Runs the tested `planRetention` over
      // the supplied records + policies AND the tenant's stored holds; a held record past its retention
      // date comes back `legal_hold`, never eligible. Deletes nothing (a POST because the records are a
      // body; it writes nothing).
      api: 'API-09', method: 'POST', path: '/v1/audit/retention/plan',
      permission: 'audit.retention.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const records = readAll(b['records'], readRecord);
        const policies = readAll(b['policies'], readPolicy);
        if (records === undefined || policies === undefined || !isStr(b['asOf'])) {
          throw apiError(400, {
            code: 'not_readable_as_a_retention_plan',
            whatHappened: 'A retention plan needs { records[] } (each with sequence, objectType, objectId, at, actorId), { policies[] } (objectType, retainDays, optional statutory/basis) and { asOf } (ISO date).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the audit records to assess, the retention policies, and the date to assess against. A plan reads; it deletes nothing.',
          });
        }
        const holds = await deps.holds(ctx.tenantId);
        const plan = planRetention(records, policies, holds, b['asOf'] as string);
        return { status: 200, body: plan };
      },
    },
    {
      // EVIDENCE PACK — the records for a period, for an auditor / inspector / court, named to the person
      // who exported it (nothing leaves anonymously) and carrying the trail's seal.
      api: 'API-09', method: 'POST', path: '/v1/audit/evidence-pack',
      permission: 'audit.retention.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const records = readAll(b['records'], readRecord);
        if (records === undefined || !isStr(b['from']) || !isStr(b['until']) || typeof b['sourceIntact'] !== 'boolean') {
          throw apiError(400, {
            code: 'not_readable_as_an_evidence_pack',
            whatHappened: 'An evidence pack needs { records[] }, a { from } and { until } (ISO instants) bounding the period, and a boolean { sourceIntact } stating whether the trail verified at export time.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the records, the period and whether the source trail was intact.',
          });
        }
        const pack = buildEvidencePack({
          records, from: b['from'] as string, until: b['until'] as string,
          exportedBy: ctx.userId, exportedAt: deps.now(), sourceIntact: b['sourceIntact'] as boolean,
        });
        return { status: 200, body: pack };
      },
    },
  ];
}
