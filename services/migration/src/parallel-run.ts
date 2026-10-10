// API-12 — MG-10, the parallel run, as something the server KEEPS (Stage B3).
//
// Until now the day-by-day comparison engine existed and a web screen could display parallel days, but
// nothing on the server recorded a day, a difference, who reconciles, or how long the run may last —
// control MG-10 was NOT STARTED and risk R-05 ("nobody allocated to run the parallel period") was open.
//
// This module gives the parallel run a written start and a memory:
//
//   • the POLICY — the owner writes down, before day one, the named person who reconciles every day,
//     the consecutive clean days required before a cutover (§34.1), and the maximum number of days the
//     run may last before it is escalated (R-05). Nothing is compared until this exists.
//   • a DAY — the named reconciler (or the owner) records both systems' figures for one business date;
//     the engine judges each area against its tolerance and every difference becomes an open item with
//     an id, appended to the ledger. Nobody can post "clean": clean is what the engine says when the
//     figures agree.
//   • OWNING a difference — a person puts their name on it, and eventually an explanation and which
//     system was wrong. The engine refuses "the new system is probably right" (hard rule #10).
//   • the POSITION and the daily SHEET — consecutive clean days, open and unowned differences, value at
//     stake, whether the run is long enough, and whether it has overrun its maximum; and a printable
//     sheet the reconciler signs each day.
//   • ROLLBACK — performed, recorded, and thereafter the cutover checklist's "rollback demonstrated"
//     comes from the ledger, not from a field the client typed.
//   • ROLLBACK RECONCILED (audit GT-02 round 4) — a rollback is DEMONSTRATED only when its data reconciles: every bill
//     and paisa the new system took before the switch-back is in the old system afterwards, counted by head office from
//     its own sales ledger — and only once every store computer has synced past the switch-back (EA-01 watermarks), so
//     a store still holding sales on its disk cannot make the count look complete.
//
// Everything is append-only. A day compared twice is two facts (the later one is the day's state); a
// difference owned twice is refused by the engine. The cutover decision can now read the parallel-run
// position and the rollback from the ledger when the caller does not supply them.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  compareParallelDay, ownDifference, parallelRunPosition, performRollback, confirmRollback, reconcileRollback,
  type ComparisonArea, type DayComparison, type ParallelDayResult, type ParallelDifference, type ParallelRunPosition,
  type RollbackResult, type RollbackTrigger, type RollbackReconciliation,
} from '../../../packages/migration/src/cutover';
import { assertSafeTarget } from './guards';
import type { MigrationDeps } from './index';

// ── What gets recorded ────────────────────────────────────────────────────────────────────────────────

/** The owner's written terms for the run, set before day one. */
export interface ParallelRunPolicy {
  readonly cutoverId: string;
  /** The ONE person who reconciles every day (R-05). The owner may also record a day. */
  readonly dailyReconcilerUserId: string;
  /** Consecutive clean days required before a cutover (§34.1). */
  readonly requiredCleanDays: number;
  /** Days the run may last before it is escalated to the owner. Overrun is reported, never hidden. */
  readonly maxParallelDays: number;
  /** YYYY-MM-DD — the first business date compared. */
  readonly startedOn: string;
  readonly setBy: string;
  readonly setAt: string;
}

/** A compared day as the ledger keeps it: the engine's result, the figures it judged, who recorded it. */
export interface RecordedParallelDay extends ParallelDayResult {
  readonly comparisons: readonly DayComparison[];
  readonly recordedBy: string;
  readonly recordedAt: string;
}

export interface RecordedRollback extends RollbackResult {
  readonly tenantId: string;
}

export interface ParallelRunView {
  readonly policy: ParallelRunPolicy;
  readonly position: ParallelRunPosition;
  /** Calendar days from `startedOn` to the latest compared day, inclusive. */
  readonly elapsedDays: number;
  /** True when the run has lasted longer than the owner allowed — the escalation R-05 asks for. */
  readonly overdue: boolean;
  readonly days: readonly { readonly businessDate: string; readonly clean: boolean; readonly differences: number; readonly open: number; readonly recordedBy: string }[];
  readonly detail: string;
}

const AREAS: readonly ComparisonArea[] = ['sales_value', 'sales_count', 'stock_movement', 'tax', 'payments', 'loyalty'];
const TRIGGERS: readonly RollbackTrigger[] = ['control_total_failed', 'edge_cannot_trade', 'data_corruption', 'owner_decision', 'time_window_exceeded'];
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

const notWired = (): never => {
  throw apiError(503, {
    code: 'parallel_run_store_not_wired',
    whatHappened: 'This deployment has no ledger to record the parallel run into.',
    wasItSaved: 'not_saved',
    nextSafeAction: 'Nothing was recorded. Run against a deployment with the event ledger configured.',
  });
};

const daysBetween = (from: string, to: string): number =>
  Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

/** The run as it stands, or undefined when the owner has not written the policy. */
export async function parallelRunView(deps: MigrationDeps, tenantId: string): Promise<ParallelRunView | undefined> {
  const policy = deps.parallelPolicy === undefined ? undefined : await deps.parallelPolicy(tenantId);
  if (policy === undefined) return undefined;
  const days = deps.parallelDays === undefined ? [] : await deps.parallelDays(tenantId);
  const differences = deps.parallelDifferences === undefined ? [] : await deps.parallelDifferences(tenantId);
  const position = parallelRunPosition({ days, differences, requiredCleanDays: policy.requiredCleanDays });
  const latest = [...days].map((d) => d.businessDate).sort().at(-1);
  const elapsedDays = latest === undefined ? 0 : Math.max(0, daysBetween(policy.startedOn, latest));
  const overdue = elapsedDays > policy.maxParallelDays;
  const openBy = new Map<string, number>();
  for (const d of differences) if (d.status !== 'resolved') openBy.set(d.businessDate, (openBy.get(d.businessDate) ?? 0) + 1);
  return {
    policy, position, elapsedDays, overdue,
    days: [...days].sort((a, b) => (a.businessDate < b.businessDate ? -1 : 1)).map((d) => ({
      businessDate: d.businessDate, clean: d.clean, differences: d.differences.length, open: openBy.get(d.businessDate) ?? 0, recordedBy: d.recordedBy,
    })),
    detail: overdue
      ? `the parallel run has lasted ${elapsedDays} day(s) against a maximum of ${policy.maxParallelDays} — escalate to the owner (R-05): decide to cut over, to roll back, or to extend in writing. ${position.detail}`
      : position.detail,
  };
}

const money = (minor: number): string => `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The daily reconciliation sheet — one section per compared day, printable, with a line to sign. */
export function renderParallelSheet(view: ParallelRunView, days: readonly RecordedParallelDay[], differences: readonly ParallelDifference[]): string {
  const lines: string[] = [
    `# Parallel run — daily reconciliation sheet`,
    ``,
    `Cutover ${view.policy.cutoverId} · daily reconciler **${view.policy.dailyReconcilerUserId}** · required clean days ${view.policy.requiredCleanDays} · maximum ${view.policy.maxParallelDays} day(s) · started ${view.policy.startedOn}`,
    ``,
    `**Position:** ${view.detail}`,
    ``,
  ];
  for (const day of [...days].sort((a, b) => (a.businessDate < b.businessDate ? -1 : 1))) {
    lines.push(`## ${day.businessDate} — ${day.clean ? 'CLEAN' : `${day.differences.length} difference(s)`} (recorded by ${day.recordedBy})`, ``);
    lines.push(`| Area | Old system | New system | Difference | Tolerance |`, `|---|---|---|---|---|`);
    for (const c of day.comparisons) {
      const diff = c.newValue - c.legacyValue;
      lines.push(`| ${c.area} | ${c.legacyValue} | ${c.newValue} | ${diff === 0 ? '—' : diff} | ${c.toleranceMinor} |`);
    }
    const todays = differences.filter((d) => d.businessDate === day.businessDate);
    if (todays.length > 0) {
      lines.push(``, `| Difference | Area | Amount | Status | Owner | Which side was wrong | Explanation |`, `|---|---|---|---|---|---|---|`);
      for (const d of todays) lines.push(`| ${d.differenceId} | ${d.area} | ${d.difference} | ${d.status} | ${d.ownerUserId ?? '— nobody yet —'} | ${d.wrongSide ?? '—'} | ${d.explanation ?? '—'} |`);
    }
    lines.push(``, `Reconciled by: ______________________  Signature: ______________________  Date: ____________`, ``);
  }
  lines.push(`Value still at stake across open differences: ${money(view.position.valueAtStakeMinor)}.`);
  return lines.join('\n');
}

/**
 * What the ledger can tell the cutover checklist on its own: the parallel-run position and the latest
 * performed rollback. The decision route uses these when the caller supplies nothing for them, so the two
 * checks that used to rest on typed-in fields now rest on recorded facts.
 */
export async function ledgerCutoverEvidence(deps: MigrationDeps, tenantId: string): Promise<{ readonly parallel?: ParallelRunPosition; readonly rollbackDemonstratedAt?: string }> {
  const view = await parallelRunView(deps, tenantId);
  const rollbacks = deps.rollbacks === undefined ? [] : await deps.rollbacks(tenantId);
  // Only a rollback CONFIRMED with execution evidence counts (audit GT-02): a decision, or an old record that says
  // "performed" with nothing seen behind it, never demonstrates one. And (round 4) only once its DATA reconciled — the
  // old system holds every bill the new one took, with every store synced past the switch-back. The time is then.
  const reconciliations = deps.rollbackReconciliations === undefined ? [] : await deps.rollbackReconciliations(tenantId);
  const performed = new Set(rollbacks.filter((r) => r.performed && r.state === 'performed' && r.execution !== undefined).map((r) => `${r.cutoverId}|${r.decidedAt}`));
  const latest = reconciliations.filter((c) => c.reconciled && performed.has(`${c.cutoverId}|${c.decidedAt}`))
    .map((c) => c.at).sort().at(-1);
  return {
    ...(view === undefined ? {} : { parallel: view.position }),
    ...(latest === undefined ? {} : { rollbackDemonstratedAt: latest }),
  };
}

// ── The routes ────────────────────────────────────────────────────────────────────────────────────────

export function parallelRunRoutes(deps: MigrationDeps): readonly Route[] {
  const requirePolicy = async (tenantId: string): Promise<ParallelRunPolicy> => {
    const policy = deps.parallelPolicy === undefined ? undefined : await deps.parallelPolicy(tenantId);
    if (policy === undefined) {
      throw apiError(409, {
        code: 'parallel_run_not_started',
        whatHappened: 'No parallel-run policy has been written for this tenant: nobody is named to reconcile daily, and no required clean days or maximum duration are set (R-05).',
        wasItSaved: 'not_saved',
        nextSafeAction: 'The owner writes the policy first — PUT /v1/migration/parallel-run/policy — then days can be compared.',
      });
    }
    return policy;
  };

  return [
    {
      // The owner writes the terms before day one. Body: { cutoverId, dailyReconcilerUserId, requiredCleanDays,
      // maxParallelDays, startedOn }. Idempotent on the tenant; a later PUT is a new, dated fact (the newest applies).
      api: 'API-12', method: 'PUT', path: '/v1/migration/parallel-run/policy',
      permission: 'migration.cutover.decide', idempotent: true,
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const b = isObj(ctx.body) ? ctx.body : {};
        if (!isStr(b['cutoverId']) || !isStr(b['dailyReconcilerUserId']) || !isInt(b['requiredCleanDays']) || (b['requiredCleanDays'] as number) < 1
          || !isInt(b['maxParallelDays']) || (b['maxParallelDays'] as number) < (b['requiredCleanDays'] as number) || !isDate(b['startedOn'])) {
          throw apiError(400, {
            code: 'not_readable_as_a_parallel_run_policy',
            whatHappened: 'A parallel-run policy needs the cutoverId, the ONE named daily reconciler (dailyReconcilerUserId), requiredCleanDays (at least 1), maxParallelDays (at least the required clean days) and startedOn (YYYY-MM-DD).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was recorded. Name the person and the numbers, then send it again.',
          });
        }
        if (deps.recordParallelPolicy === undefined) notWired();
        const policy: ParallelRunPolicy = {
          cutoverId: b['cutoverId'] as string, dailyReconcilerUserId: (b['dailyReconcilerUserId'] as string).trim(),
          requiredCleanDays: b['requiredCleanDays'] as number, maxParallelDays: b['maxParallelDays'] as number,
          startedOn: b['startedOn'] as string, setBy: ctx.userId, setAt: deps.now(),
        };
        await deps.recordParallelPolicy!(ctx.tenantId, policy);
        return { status: 201, body: { policy } };
      },
    },
    {
      // One business date, both systems' figures per area. The named reconciler or the owner records it; the
      // engine decides what is a difference. Body: { comparisons: [{ area, legacyValue, newValue, toleranceMinor }] }.
      api: 'API-12', method: 'POST', path: '/v1/migration/parallel-run/days/:businessDate',
      permission: 'migration.parallel.record', idempotent: true,
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const businessDate = (ctx.params['businessDate'] ?? '').trim();
        const b = isObj(ctx.body) ? ctx.body : {};
        const comparisons = b['comparisons'];
        if (!isDate(businessDate) || !Array.isArray(comparisons) || comparisons.length === 0
          || !comparisons.every((c) => isObj(c) && (AREAS as readonly string[]).includes(c['area'] as string) && isNum(c['legacyValue']) && isNum(c['newValue']) && isNum(c['toleranceMinor']) && (c['toleranceMinor'] as number) >= 0)) {
          throw apiError(400, {
            code: 'not_readable_as_a_parallel_day',
            whatHappened: `A compared day needs a business date (YYYY-MM-DD) in the path and comparisons[] each with an area (${AREAS.join(', ')}), legacyValue, newValue and a non-negative toleranceMinor.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was recorded. Read both systems\' figures for the day into the fields named and send again.',
          });
        }
        const policy = await requirePolicy(ctx.tenantId);
        const ownerId = await deps.ownerId(ctx.tenantId);
        if (ctx.userId !== policy.dailyReconcilerUserId && ctx.userId !== ownerId) {
          throw apiError(403, {
            code: 'not_the_named_reconciler',
            whatHappened: `${policy.dailyReconcilerUserId} is the person named to reconcile this parallel run daily (R-05); ${ctx.userId} is not, and is not the owner.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was recorded. The named reconciler records the day, or the owner names somebody else in the policy.',
          });
        }
        if (businessDate < policy.startedOn) {
          throw apiError(422, {
            code: 'before_the_parallel_run_started',
            whatHappened: `${businessDate} is before the run started on ${policy.startedOn}.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was recorded. Compare days from the start date onwards.',
          });
        }
        if (deps.recordParallelDay === undefined || deps.recordParallelDifference === undefined) notWired();
        const result = compareParallelDay({ tenantId: ctx.tenantId, businessDate, comparisons: comparisons as DayComparison[] });
        const day: RecordedParallelDay = { ...result, comparisons: comparisons as DayComparison[], recordedBy: ctx.userId, recordedAt: deps.now() };
        await deps.recordParallelDay!(ctx.tenantId, day);
        for (const d of result.differences) await deps.recordParallelDifference!(ctx.tenantId, d);
        const view = await parallelRunView(deps, ctx.tenantId);
        return { status: 201, body: { day, position: view?.position, overdue: view?.overdue ?? false } };
      },
    },
    {
      // Put a name on a difference — and, when known, the explanation and which system was wrong. The engine
      // refuses "the new system is probably right" (hard rule #10). Body: { explanation?, wrongSide? }.
      api: 'API-12', method: 'POST', path: '/v1/migration/parallel-run/differences/:differenceId/own',
      permission: 'migration.parallel.record', idempotent: true,
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const differenceId = (ctx.params['differenceId'] ?? '').trim();
        const b = isObj(ctx.body) ? ctx.body : {};
        const wrongSide = b['wrongSide'];
        if (differenceId === '' || (b['explanation'] !== undefined && typeof b['explanation'] !== 'string')
          || (wrongSide !== undefined && !['legacy', 'new', 'both', 'neither'].includes(wrongSide as string))) {
          throw apiError(400, {
            code: 'not_readable_as_a_difference_decision',
            whatHappened: 'Owning a difference needs its id in the path; explanation and wrongSide (legacy | new | both | neither) are optional until it is resolved.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was recorded.',
          });
        }
        await requirePolicy(ctx.tenantId);
        if (deps.recordParallelDifference === undefined) notWired();
        const differences = deps.parallelDifferences === undefined ? [] : await deps.parallelDifferences(ctx.tenantId);
        const result = ownDifference({
          differences, differenceId, ownerUserId: ctx.userId,
          ...(isStr(b['explanation']) ? { explanation: b['explanation'] } : {}),
          ...(wrongSide === undefined ? {} : { wrongSide: wrongSide as 'legacy' | 'new' | 'both' | 'neither' }),
        });
        if (!result.ok) {
          const status = result.refusedBecause === 'unknown_difference' ? 404 : result.refusedBecause === 'already_resolved' ? 409 : 422;
          throw apiError(status, {
            code: result.refusedBecause ?? 'difference_refused',
            whatHappened: result.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: result.refusedBecause === 'newer_is_not_a_reason'
              ? 'Nothing was recorded. Find out WHY the two systems differ — a keying error, a missed refund, a timing cut-off — and say which side was wrong.'
              : 'Nothing was recorded.',
          });
        }
        const updated = result.differences.find((d) => d.differenceId === differenceId)!;
        await deps.recordParallelDifference!(ctx.tenantId, updated);
        return { status: 200, body: { difference: updated, detail: result.detail } };
      },
    },
    {
      // Where the run stands: policy, position, overdue, one line per day.
      api: 'API-12', method: 'GET', path: '/v1/migration/parallel-run',
      permission: 'migration.parallel.read',
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const view = await parallelRunView(deps, ctx.tenantId);
        if (view === undefined) return { status: 200, body: { started: false, detail: 'no parallel-run policy written yet — nobody is named to reconcile daily (R-05)' } };
        return { status: 200, body: { started: true, ...view } };
      },
    },
    {
      // The printable daily sheet the reconciler signs.
      api: 'API-12', method: 'GET', path: '/v1/migration/parallel-run/sheet',
      permission: 'migration.parallel.read',
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const view = await parallelRunView(deps, ctx.tenantId);
        if (view === undefined) {
          throw apiError(409, {
            code: 'parallel_run_not_started',
            whatHappened: 'There is no parallel run to print a sheet for.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'The owner writes the policy first.',
          });
        }
        const days = deps.parallelDays === undefined ? [] : await deps.parallelDays(ctx.tenantId);
        const differences = deps.parallelDifferences === undefined ? [] : await deps.parallelDifferences(ctx.tenantId);
        return { status: 200, body: { markdown: renderParallelSheet(view, days, differences) } };
      },
    },
    {
      // DECIDE to roll back (audit GT-02) — recorded at once, needing nobody's approval, but recorded as DECIDED, never
      // as performed: the old system is back only when somebody has seen it take a sale (the confirmation below).
      // Body: { cutoverId, trigger, legacySystemAvailable }. The shop keeps trading either way.
      api: 'API-12', method: 'POST', path: '/v1/migration/cutover/rollback',
      permission: 'migration.cutover.decide', idempotent: true,
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const b = isObj(ctx.body) ? ctx.body : {};
        if (!isStr(b['cutoverId']) || !(TRIGGERS as readonly string[]).includes(b['trigger'] as string) || typeof b['legacySystemAvailable'] !== 'boolean') {
          throw apiError(400, {
            code: 'not_readable_as_a_rollback',
            whatHappened: `A rollback needs the cutoverId, a trigger (${TRIGGERS.join(', ')}) and whether the legacy system is available to take the shop.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was recorded. Say what triggered it and whether the old system is there to fall back to.',
          });
        }
        if (deps.recordRollback === undefined) notWired();
        const decided = performRollback({
          cutoverId: b['cutoverId'] as string, trigger: b['trigger'] as RollbackTrigger, decidedBy: ctx.userId,
          legacySystemAvailable: b['legacySystemAvailable'] as boolean, now: deps.now(),
        });
        const recorded: RecordedRollback = { ...decided, tenantId: ctx.tenantId };
        await deps.recordRollback!(ctx.tenantId, recorded);
        return {
          status: 201,
          body: {
            rollback: recorded,
            nextSafeAction: decided.state === 'legacy_unavailable'
              ? 'The old system is not there to take the shop, so this rollback cannot be performed. Keep trading on the new system and call for help.'
              : 'Switch the tills to the old system, take the first sale on it, then confirm the rollback with that bill number.',
          },
        };
      },
    },
    {
      // CONFIRM a decided rollback with EXECUTION evidence (audit GT-02): the old system's first bill after the decision
      // and when it started trading, seen by the signed-in person confirming. Only then is the rollback PERFORMED — and
      // only a performed one demonstrates the cutover checklist's "rollback demonstrated". A rollback decided with the
      // old system unavailable is refused: there is nothing to confirm. Body: { legacyFirstBillRef, legacyTradingFrom }.
      api: 'API-12', method: 'POST', path: '/v1/migration/cutover/rollback/:cutoverId/confirmation',
      permission: 'migration.cutover.decide', idempotent: true,
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const cutoverId = ctx.params['cutoverId'] ?? '';
        const b = isObj(ctx.body) ? ctx.body : {};
        if (!isStr(b['legacyFirstBillRef']) || !isStr(b['legacyTradingFrom'])) {
          throw apiError(400, {
            code: 'not_readable_as_a_rollback_confirmation',
            whatHappened: 'Confirming a rollback needs { legacyFirstBillRef, legacyTradingFrom } — the old system\'s first bill after the decision and when it started taking sales.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Take a sale on the old system, then send its bill number and the time.',
          });
        }
        if (deps.recordRollback === undefined || deps.rollbacks === undefined) notWired();
        const decided = [...(await deps.rollbacks!(ctx.tenantId))].filter((r) => r.cutoverId === cutoverId)
          .sort((x, y) => x.decidedAt.localeCompare(y.decidedAt)).at(-1);
        if (decided === undefined) {
          throw apiError(404, {
            code: 'no_rollback_decided',
            whatHappened: `No rollback of ${cutoverId} has been decided, so there is nothing to confirm.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Decide the rollback first (one button, no approval needed).',
          });
        }
        const confirmed = confirmRollback(decided, {
          confirmedBy: ctx.userId, confirmedAt: deps.now(),
          legacyTradingFrom: (b['legacyTradingFrom'] as string).trim(), legacyFirstBillRef: (b['legacyFirstBillRef'] as string).trim(),
        });
        if (!confirmed.ok) {
          throw apiError(confirmed.refusal === 'already_performed' ? 409 : 422, {
            code: confirmed.refusal,
            whatHappened: confirmed.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: confirmed.refusal === 'legacy_unavailable'
              ? 'There is no old system to go back to. Keep trading on the new system; the decision stays on the record.'
              : 'Nothing was confirmed. Correct what is named and send again.',
          });
        }
        const recorded: RecordedRollback = { ...confirmed.rollback, tenantId: ctx.tenantId };
        await deps.recordRollback!(ctx.tenantId, recorded);
        return { status: 201, body: { rollback: recorded, nextSafeAction: 'Carry the new system\'s bills back into the old one, then reconcile the rollback (count and takings).' } };
      },
    },
    {
      // RECONCILE a performed rollback's data (audit GT-02 round 4): head office counts the bills and takings the new
      // system took from `newSystemTradingFrom` to the switch-back, from ITS OWN sales ledger; the operator says what the
      // old system holds from the carry-back. Refused while any store computer has not synced past the switch-back. A
      // reconciliation that does not balance is recorded too (evidence), as not reconciled — and demonstrates nothing.
      // Body: { newSystemTradingFrom, legacyCarriedBack: { count, totalMinor } }.
      api: 'API-12', method: 'POST', path: '/v1/migration/cutover/rollback/:cutoverId/reconciliation',
      permission: 'migration.cutover.decide', idempotent: true,
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const cutoverId = ctx.params['cutoverId'] ?? '';
        const b = isObj(ctx.body) ? ctx.body : {};
        const legacy = isObj(b['legacyCarriedBack']) ? b['legacyCarriedBack'] : undefined;
        const whole = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
        if (!isStr(b['newSystemTradingFrom']) || legacy === undefined || !whole(legacy['count']) || !whole(legacy['totalMinor'])) {
          throw apiError(400, {
            code: 'not_readable_as_a_rollback_reconciliation',
            whatHappened: 'Reconciling a rollback needs { newSystemTradingFrom, legacyCarriedBack: { count, totalMinor } } — when the new system started taking sales, and what the old system now holds from the carry-back.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Count the carried-back bills and their total in the old system, then send them.',
          });
        }
        if (deps.rollbacks === undefined || deps.recordRollbackReconciliation === undefined || deps.windowSales === undefined || deps.storeSalesSyncedThrough === undefined) notWired();
        const latest = [...(await deps.rollbacks!(ctx.tenantId))].filter((r) => r.cutoverId === cutoverId)
          .sort((x, y) => x.decidedAt.localeCompare(y.decidedAt) || Number(x.performed) - Number(y.performed)).at(-1);
        if (latest === undefined) {
          throw apiError(404, { code: 'no_rollback_decided', whatHappened: `No rollback of ${cutoverId} has been decided.`, wasItSaved: 'not_saved', nextSafeAction: 'Decide and confirm the rollback first.' });
        }
        const from = (b['newSystemTradingFrom'] as string).trim();
        const to = latest.execution?.legacyTradingFrom;
        const newSystem = to === undefined || Number.isNaN(Date.parse(from)) ? { count: 0, totalMinor: 0 } : await deps.windowSales!(ctx.tenantId, from, to);
        const result = reconcileRollback({
          rollback: latest, windowFrom: from, newSystem,
          legacy: { count: legacy['count'] as number, totalMinor: legacy['totalMinor'] as number },
          stores: await deps.storeSalesSyncedThrough!(ctx.tenantId), by: ctx.userId, at: deps.now(),
        });
        if (!result.ok) {
          throw apiError(result.refusal === 'store_not_synced_through_switch_back' || result.refusal === 'no_store_sync_report' ? 409 : 422, {
            code: result.refusal, whatHappened: result.detail, wasItSaved: 'not_saved',
            nextSafeAction: result.refusal === 'not_performed' ? 'Confirm the rollback with the old system\'s first bill first.' : 'Nothing was recorded. Fix what is named and reconcile again.',
          });
        }
        await deps.recordRollbackReconciliation!(ctx.tenantId, result.reconciliation);
        return { status: 201, body: { reconciliation: result.reconciliation, demonstrated: result.reconciliation.reconciled } };
      },
    },
    {
      // The rollback as the ledger holds it — decision, execution evidence, every reconciliation — after any reload.
      api: 'API-12', method: 'GET', path: '/v1/migration/cutover/rollback/:cutoverId',
      permission: 'migration.parallel.read',
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const cutoverId = ctx.params['cutoverId'] ?? '';
        const all = [...(deps.rollbacks === undefined ? [] : await deps.rollbacks(ctx.tenantId))].filter((r) => r.cutoverId === cutoverId)
          .sort((x, y) => x.decidedAt.localeCompare(y.decidedAt) || Number(x.performed) - Number(y.performed));
        if (all.length === 0) throw apiError(404, { code: 'no_rollback_decided', whatHappened: `No rollback of ${cutoverId} is on record.`, wasItSaved: 'not_saved', nextSafeAction: 'Nothing to show.' });
        const reconciliations: readonly RollbackReconciliation[] = (deps.rollbackReconciliations === undefined ? [] : await deps.rollbackReconciliations(ctx.tenantId)).filter((c) => c.cutoverId === cutoverId);
        const latest = all.at(-1)!;
        const demonstrated = latest.state === 'performed' && reconciliations.some((c) => c.decidedAt === latest.decidedAt && c.reconciled);
        return { status: 200, body: { rollback: latest, reconciliations, demonstrated, asAt: deps.now() } };
      },
    },
  ];
}
