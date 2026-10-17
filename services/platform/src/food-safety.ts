// API-11 Food-safety / HACCP checks (D-6, roadmap v2.1 addendum, ratified R2) — "Scheduled temperature/equipment checks and
// cleaning/receiving checklists with corrective-action capture and a tamper-evident trail; a missed check surfaces".
//
//   • POST /v1/facilities/food-safety/checks/:checkId                  — define a check (its kind, schedule, limits, items,
//     who does it, who a miss escalates to). facilities.schedule.manage. A change is a new version (append-only) that
//     governs from the moment it is made (NEW-8): a later start, a new interval or "inactive" never erases a slot that was
//     already due — a missed check stays missed, and the redefinition is sealed in the trail with what it changed.
//   • POST /v1/facilities/food-safety/checks/:checkId/records/:recordId — a person records the check as DONE, in their own
//     name (never a typed name): the reading, each item pass/fail, and — on any failure — the corrective action taken. A
//     failure with no action is refused; a slot already recorded is refused (a correction is a new record of its own
//     kind, never an overwrite). facilities.task.record.
//   • GET  /v1/facilities/food-safety/status?asOf=&from=&branchId=      — every scheduled slot: done / failed (with the
//     action) / done late / due / MISSED (with who it escalates to), and the receiving checklists, with the checks in force (their kind, limits and items). facilities.overdue.read.
//
// The tamper-evident trail: every definition and every record is SEALED into the hash-chained audit trail (M34-FR-01) in
// the actor's name — `GET /v1/audit/trail/verify` names any break, and `GET /v1/audit/trail?objectType=food_safety_check`
// lists the trail. Nothing here edits or deletes a record (hard rules #2, #6). No AI records or closes a check (#5).
//
// The rules are the pure engine in `packages/facilities/src/food-safety.ts`, which sits beside — and reuses the words of —
// the M26 probe monitoring and compliance schedules (the continuous probe and the person's check are both kept).

import type { Route } from '../../kernel/src/index';
import { apiError, notFound, requireActorIsCaller, assertBranchInScope, narrowScope } from '../../kernel/src/index';
import {
  assessCheckRecord, definitionProblem, foodSafetyStatus, checkInForceAt, FOOD_SAFETY_CHECK_KINDS,
  type FoodSafetyCheck, type FoodSafetyCheckKind, type FoodSafetyCheckRecord, type ItemResult, type ChecklistItem,
} from '../../../packages/facilities/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';

/** The store's own refusal when another record of the same slot landed first (two people, one slot) — said as a 409. */
export class SlotAlreadyRecordedError extends Error {
  constructor(readonly checkId: string, readonly slotDueAt: string) {
    super(`"${checkId}" at ${slotDueAt} was recorded by someone else a moment ago.`);
    this.name = 'SlotAlreadyRecordedError';
  }
}

export interface FoodSafetyDeps {
  /** The version of each check in force now (the latest). */
  readonly checks: (tenantId: string) => Promise<readonly FoodSafetyCheck[]> | readonly FoodSafetyCheck[];
  /** NEW-8: EVERY version of every check, each stamped with when it came into force (`effectiveFrom`). Absent on a bare
   *  stub — then the latest versions are the only history. */
  readonly checkVersions?: (tenantId: string) => Promise<readonly FoodSafetyCheck[]> | readonly FoodSafetyCheck[];
  readonly records: (tenantId: string) => Promise<readonly FoodSafetyCheckRecord[]> | readonly FoodSafetyCheckRecord[];
  readonly recordCheck: (tenantId: string, check: FoodSafetyCheck, by: string, at: string) => Promise<void> | void;
  readonly recordRecord: (tenantId: string, record: FoodSafetyCheckRecord) => Promise<void> | void;
  /** Seal into the tamper-evident audit trail (M34-FR-01). The running system provides it. */
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isTime = (v: unknown): v is string => isStr(v) && !Number.isNaN(Date.parse(v));
const iso = (v: string): string => new Date(Date.parse(v)).toISOString();
const DAY_MS = 86_400_000;

/** The definition's own content — what a person set — without when or by whom it was set. */
const META = new Set(['effectiveFrom', 'definedBy', 'definedAt']);
const contentOf = (c: FoodSafetyCheck): string => {
  const r = c as unknown as Record<string, unknown>;
  return JSON.stringify(Object.keys(r).filter((k) => !META.has(k)).sort().map((k) => [k, r[k]]));
};

function readItems(v: unknown): ChecklistItem[] | undefined {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return undefined;
  const out: ChecklistItem[] = [];
  for (const i of v) {
    if (i === null || typeof i !== 'object') return undefined;
    const r = i as Record<string, unknown>;
    if (!isStr(r['itemId']) || !isStr(r['label'])) return undefined;
    out.push({ itemId: r['itemId'].trim(), label: r['label'].trim() });
  }
  return out;
}

function readItemResults(v: unknown): Record<string, ItemResult> | undefined | 'bad' {
  if (v === undefined) return undefined;
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return 'bad';
  const out: Record<string, ItemResult> = {};
  for (const [k, r] of Object.entries(v as Record<string, unknown>)) {
    if (r !== 'pass' && r !== 'fail') return 'bad';
    out[k] = r;
  }
  return out;
}

export function foodSafetyRoutes(deps: FoodSafetyDeps): readonly Route[] {
  const checkOf = async (tenantId: string, checkId: string): Promise<FoodSafetyCheck | undefined> =>
    (await deps.checks(tenantId)).find((c) => c.checkId === checkId);
  const versionsOf = async (tenantId: string): Promise<readonly FoodSafetyCheck[]> =>
    deps.checkVersions === undefined ? deps.checks(tenantId) : deps.checkVersions(tenantId);
  return [
    {
      api: 'API-11', method: 'POST', path: '/v1/facilities/food-safety/checks/:checkId',
      permission: 'facilities.schedule.manage', idempotent: true,
      handler: async (ctx) => {
        const checkId = (ctx.params['checkId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const items = readItems(b['items']);
        const kind = b['kind'] as FoodSafetyCheckKind;
        const draft: Omit<FoodSafetyCheck, 'checkId'> | undefined = items === undefined ? undefined : {
          branchId: isStr(b['branchId']) ? b['branchId'].trim() : '', title: isStr(b['title']) ? b['title'].trim() : '',
          kind, graceMinutes: b['graceMinutes'] as number, items,
          assignedRole: isStr(b['assignedRole']) ? b['assignedRole'].trim() : '', escalatesTo: isStr(b['escalatesTo']) ? b['escalatesTo'].trim() : '',
          active: b['active'] !== false,
          ...(b['everyMinutes'] === undefined ? {} : { everyMinutes: b['everyMinutes'] as number }),
          ...(b['startsAt'] === undefined ? {} : { startsAt: isTime(b['startsAt']) ? iso(b['startsAt']) : String(b['startsAt']) }),
          ...(b['minTenthsC'] === undefined ? {} : { minTenthsC: b['minTenthsC'] as number }),
          ...(b['maxTenthsC'] === undefined ? {} : { maxTenthsC: b['maxTenthsC'] as number }),
          ...(isStr(b['equipmentId']) ? { equipmentId: b['equipmentId'].trim() } : {}),
        };
        const problem = checkId === '' ? 'the check needs an id in the path' : draft === undefined ? 'items must be a list of { itemId, label }' : definitionProblem(draft);
        if (problem !== null || draft === undefined) {
          throw apiError(400, {
            code: 'not_readable_as_a_food_safety_check',
            whatHappened: `This could not be read as a food-safety check: ${problem ?? ''}. Kinds: ${FOOD_SAFETY_CHECK_KINDS.join(' / ')}.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the check with its kind, schedule, limits or items, the role that does it and who a miss escalates to. Nothing was set.',
          });
        }
        assertBranchInScope(ctx, draft.branchId); // PA-01-r1
        const before = await checkOf(ctx.tenantId, checkId);
        if (before !== undefined) assertBranchInScope(ctx, before.branchId);
        const at = deps.now();
        // The same definition again changes nothing — no new version, nothing sealed twice.
        if (before !== undefined && contentOf(before) === contentOf({ checkId, ...draft })) {
          return { status: 200, body: { check: before, unchanged: true } };
        }
        // NEW-8: a (re)definition is a new VERSION in force from now; the slots that fell due before stay the earlier one's.
        const check: FoodSafetyCheck = { checkId, ...draft, effectiveFrom: at };
        await deps.recordCheck(ctx.tenantId, check, ctx.userId, at);
        const shape = (c: FoodSafetyCheck): Record<string, string> => ({
          kind: c.kind, title: c.title, active: String(c.active), everyMinutes: String(c.everyMinutes ?? ''), startsAt: c.startsAt ?? '',
          graceMinutes: String(c.graceMinutes), limits: c.kind === 'temperature' ? `${c.minTenthsC}..${c.maxTenthsC}` : '', items: c.items.map((i) => i.itemId).join(','),
          assignedRole: c.assignedRole, escalatesTo: c.escalatesTo,
        });
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: before === undefined ? 'food_safety.check.define' : 'food_safety.check.redefine',
          objectType: 'food_safety_check', objectId: checkId, at,
          origin: { tenantId: ctx.tenantId, branchId: check.branchId },
          before: before === undefined ? null : shape(before),
          after: { ...shape(check), effectiveFrom: at },
          ...(before === undefined ? {} : { reason: `redefined — in force from ${at}; every slot due before stays as it was` }),
          correlationId: checkId,
        });
        return { status: 201, body: { check, ...(before === undefined ? {} : { redefined: true, effectiveFrom: at }) } };
      },
    },
    {
      api: 'API-11', method: 'POST', path: '/v1/facilities/food-safety/checks/:checkId/records/:recordId',
      permission: 'facilities.task.record', idempotent: true,
      handler: async (ctx) => {
        const checkId = (ctx.params['checkId'] ?? '').trim();
        const recordId = (ctx.params['recordId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        // Who did the check is the signed-in person — a body naming someone else is refused by name.
        requireActorIsCaller(ctx, b, 'performedBy');
        // NEW-8: a slot is judged by the version of the check in force when it fell due (a receiving checklist: now) — so a
        // slot missed before a redefinition can still be recorded, late, and stays that version's slot.
        const at = deps.now();
        const latest = await checkOf(ctx.tenantId, checkId);
        const governing = latest === undefined ? undefined
          : checkInForceAt(await versionsOf(ctx.tenantId), checkId, latest.kind !== 'receiving' && isTime(b['slotDueAt']) ? iso(b['slotDueAt']) : at) ?? latest;
        const check = governing;
        if (check === undefined || !check.active) throw notFound(`food-safety check ${checkId}`);
        assertBranchInScope(ctx, check.branchId); // PA-01-r1
        const itemResults = readItemResults(b['itemResults']);
        if (recordId === '' || itemResults === 'bad' || (b['readingTenthsC'] !== undefined && !isInt(b['readingTenthsC']))
          || (b['slotDueAt'] !== undefined && !isTime(b['slotDueAt'])) || (b['correctiveAction'] !== undefined && typeof b['correctiveAction'] !== 'string')
          || (b['evidenceRefs'] !== undefined && (!Array.isArray(b['evidenceRefs']) || !(b['evidenceRefs'] as unknown[]).every(isStr)))) {
          throw apiError(400, {
            code: 'not_readable_as_a_check_record',
            whatHappened: 'A check record takes { slotDueAt (the scheduled time) or subjectRef (the delivery), readingTenthsC (whole tenths of °C), itemResults { itemId: "pass" | "fail" }, correctiveAction, evidenceRefs [] }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send what was found. Nothing was recorded.',
          });
        }
        const all = await deps.records(ctx.tenantId);
        const existing = all.find((r) => r.recordId === recordId);
        if (existing !== undefined) return { status: 200, body: { record: existing, alreadyRecorded: true } };
        const assessed = assessCheckRecord(check, {
          recordId, checkId, performedBy: ctx.userId, performedAt: at,
          ...(isTime(b['slotDueAt']) ? { slotDueAt: iso(b['slotDueAt']) } : {}),
          ...(isStr(b['subjectRef']) ? { subjectRef: b['subjectRef'].trim() } : {}),
          ...(isInt(b['readingTenthsC']) ? { readingTenthsC: b['readingTenthsC'] } : {}),
          ...(itemResults === undefined ? {} : { itemResults }),
          ...(typeof b['correctiveAction'] === 'string' && b['correctiveAction'].trim() !== '' ? { correctiveAction: b['correctiveAction'] } : {}),
          ...(Array.isArray(b['evidenceRefs']) ? { evidenceRefs: b['evidenceRefs'] as string[] } : {}),
        });
        if (!assessed.ok) {
          throw apiError(422, {
            code: assessed.refusal, whatHappened: assessed.detail, wasItSaved: 'not_saved',
            nextSafeAction: assessed.refusal === 'corrective_action_required'
              ? 'Write down what was done about the failure (moved the stock, called the engineer, re-cleaned …) and send the check again. Nothing was recorded.'
              : 'Correct the check and send it again. Nothing was recorded.',
          });
        }
        const rec = assessed.record;
        if (rec.slotDueAt !== undefined && all.some((r) => r.checkId === checkId && r.slotDueAt === rec.slotDueAt)) {
          throw apiError(409, {
            code: 'check_already_recorded',
            whatHappened: `"${check.title}" at ${rec.slotDueAt} is already recorded. A record is never overwritten.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'If something more was done, record it as a corrective action on the next check or as an incident. Nothing was changed.',
          });
        }
        try {
          await deps.recordRecord(ctx.tenantId, rec);
        } catch (e) {
          if (e instanceof SlotAlreadyRecordedError) {
            throw apiError(409, { code: 'check_already_recorded', whatHappened: `${e.message} A record is never overwritten.`, wasItSaved: 'not_saved', nextSafeAction: 'Read the status: the check is on file. Nothing was changed.' });
          }
          throw e;
        }
        // The tamper-evident trail: sealed in the doer's name, with what was found and what was done.
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: rec.outcome === 'fail' ? 'food_safety.check.failed' : 'food_safety.check.passed',
          objectType: 'food_safety_check', objectId: checkId, at,
          origin: { tenantId: ctx.tenantId, branchId: check.branchId },
          before: null,
          after: {
            recordId, slotDueAt: rec.slotDueAt ?? '', subjectRef: rec.subjectRef ?? '', outcome: rec.outcome, late: String(rec.late),
            reading: rec.readingTenthsC === undefined ? '' : String(rec.readingTenthsC), failures: rec.failures.join('; '),
            correctiveAction: rec.correctiveAction ?? '',
          },
          ...(rec.correctiveAction === undefined ? {} : { reason: rec.correctiveAction }),
          correlationId: recordId,
        });
        return { status: 201, body: { record: rec } };
      },
    },
    {
      api: 'API-11', method: 'GET', path: '/v1/facilities/food-safety/status',
      permission: 'facilities.overdue.read',
      handler: async (ctx) => {
        const asOf = ctx.query['asOf'];
        const from = ctx.query['from'];
        if ((asOf !== undefined && !isTime(asOf)) || (from !== undefined && !isTime(from))) {
          throw apiError(400, { code: 'status_needs_times', whatHappened: '?asOf= and ?from= must be times (ISO).', wasItSaved: 'not_saved', nextSafeAction: 'Send the times, or leave them out (now, and the last day). A status reads; it never writes.' });
        }
        const asAt = asOf === undefined ? deps.now() : iso(asOf);
        const since = from === undefined ? new Date(Date.parse(asAt) - DAY_MS).toISOString() : iso(from);
        const asked = ctx.query['branchId'];
        const scope = narrowScope(ctx, isStr(asked) ? [asked] : undefined); // PA-01-r1
        // NEW-8: every version of every check, so a slot missed under an earlier version is still shown missed.
        const checks = (await versionsOf(ctx.tenantId)).filter((c) => scope === 'all' || scope.includes(c.branchId));
        const ids = new Set(checks.map((c) => c.checkId));
        const status = foodSafetyStatus({ checks, records: (await deps.records(ctx.tenantId)).filter((r) => ids.has(r.checkId)), from: since, asAt });
        // The checks in force now (their kind, limits and items), so a screen can offer the right record form (OB-154).
        const inForce = (await deps.checks(ctx.tenantId)).filter((c) => scope === 'all' || scope.includes(c.branchId));
        return { status: 200, body: { ...status, missedCount: status.missed.length, failedCount: status.failed.length, checks: inForce } };
      },
    },
  ];
}
