// API-12 — MG-10, the parallel-run DAY as the reconciler works it on the migration screen (§34.1 daily parallel
// controls · R-05 · G10 · hard rules #1 #10 · P-08).
//
// The day route (`POST /v1/migration/parallel-run/days/:businessDate`) records both systems' figures and raises a
// difference for every area beyond tolerance; the own route puts a name and a reason on one. Missing were: a way to
// SIGN the day, and the screen's path to the cloud. Here:
//
//   • SIGN at the desk — `POST …/days/:businessDate/signature`: the named reconciler (or the owner) signs the day
//     as it is recorded. Refused, naming each one, while ANY of the day's material differences is unexplained
//     (`signParallelDay`). A signature belongs to the figures it saw: a day recorded again with other figures is
//     unsigned again (the old signature stays in the ledger).
//   • the SCREEN's two decisions, relayed by the store box (local first, then synced — hard rule #1):
//       `MigrationParallelDayEntered` → `…/days/:businessDate/synced` — the old ERP's daily totals typed or imported
//         beside the new system's, and a reason on each difference. Recorded under the person the box vouched for,
//         after the cloud re-checks they are the named reconciler or the owner and re-runs the same engines.
//       `MigrationParallelDaySigned` → `…/days/:businessDate/signature/synced` — the signature, re-judged here.
//     A relayed decision the cloud cannot accept is RECORDED AS REFUSED (visible, hard rule #10) and acknowledged 202.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { compareParallelDay, ownDifference, type ComparisonArea, type DayComparison, type ParallelDifference } from '../../../packages/migration/src/cutover';
import { dayDigestOf, signParallelDay, signatureStillApplies, type ParallelDaySignature } from '../../../packages/migration/src/parallel-day-sign';
import { assertSafeTarget } from './guards';
import { deciderSealFlags } from '../../pos/src/store-seal';
import type { RefusedDecision } from './decisions';
import type { ParallelRunPolicy, RecordedParallelDay } from './parallel-run';
import type { MigrationDeps } from './index';

const AREAS: readonly ComparisonArea[] = ['sales_value', 'sales_count', 'stock_movement', 'tax', 'payments', 'loyalty'];
const SIDES = ['legacy', 'new', 'both', 'neither'] as const;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export const isComparison = (c: unknown): c is DayComparison =>
  isObj(c) && (AREAS as readonly string[]).includes(c['area'] as string) && isNum(c['legacyValue']) && isNum(c['newValue']) && isNum(c['toleranceMinor']) && (c['toleranceMinor'] as number) >= 0;

interface Explanation { readonly area: ComparisonArea; readonly explanation: string; readonly wrongSide?: (typeof SIDES)[number] }
const isExplanation = (e: unknown): e is Explanation =>
  isObj(e) && (AREAS as readonly string[]).includes(e['area'] as string) && typeof e['explanation'] === 'string'
  && (e['wrongSide'] === undefined || (SIDES as readonly string[]).includes(e['wrongSide'] as string));

/** A day signature as the ledger keeps it. */
export type RecordedDaySignature = ParallelDaySignature;

const notWired = (): never => {
  throw apiError(503, {
    code: 'parallel_run_store_not_wired',
    whatHappened: 'This deployment has no ledger to record the parallel run into.',
    wasItSaved: 'not_saved',
    nextSafeAction: 'Nothing was recorded. Run against a deployment with the event ledger configured.',
  });
};

/** The day's signature that still applies to its recorded figures, if any. */
export async function currentDaySignature(deps: MigrationDeps, tenantId: string, businessDate: string): Promise<RecordedDaySignature | undefined> {
  const days = deps.parallelDays === undefined ? [] : await deps.parallelDays(tenantId);
  const day = days.find((d) => d.businessDate === businessDate);
  const sigs = deps.parallelDaySignatures === undefined ? [] : await deps.parallelDaySignatures(tenantId);
  return sigs.filter((s) => s.businessDate === businessDate && signatureStillApplies(s, day?.comparisons)).at(0);
}

export function parallelDayRoutes(deps: MigrationDeps): readonly Route[] {
  const policyOf = async (tenantId: string): Promise<ParallelRunPolicy | undefined> =>
    deps.parallelPolicy === undefined ? undefined : deps.parallelPolicy(tenantId);
  const dayOf = async (tenantId: string, businessDate: string): Promise<RecordedParallelDay | undefined> =>
    (deps.parallelDays === undefined ? [] : await deps.parallelDays(tenantId)).find((d) => d.businessDate === businessDate);
  const differencesNow = async (tenantId: string): Promise<readonly ParallelDifference[]> =>
    deps.parallelDifferences === undefined ? [] : deps.parallelDifferences(tenantId);
  const refuse = async (tenantId: string, d: Omit<RefusedDecision, 'decisionId' | 'relayedAt'>): Promise<RefusedDecision> => {
    const relayedAt = deps.now();
    const refused: RefusedDecision = { ...d, decisionId: `${d.kind}-${d.subjectId}-${relayedAt}`, relayedAt };
    if (deps.recordRefusedDecision === undefined) notWired();
    await deps.recordRefusedDecision!(tenantId, refused);
    return refused;
  };

  /** Sign the recorded day as `signedBy` — shared by the desk route and the relayed one. */
  const judgeSignature = async (tenantId: string, businessDate: string, signedBy: string, statement: string, at: string) => {
    const policy = await policyOf(tenantId);
    if (policy === undefined) return { policy, result: undefined };
    const day = await dayOf(tenantId, businessDate);
    const result = signParallelDay({
      businessDate, comparisons: day?.comparisons, differences: await differencesNow(tenantId), signedBy, statement, now: at,
      reconcilerUserId: policy.dailyReconcilerUserId, ownerUserId: await deps.ownerId(tenantId),
    });
    return { policy, day, result };
  };

  return [
    {
      // The named reconciler (or the owner) signs the day at the desk. Body: { statement }. The signer is the caller.
      api: 'API-12', method: 'POST', path: '/v1/migration/parallel-run/days/:businessDate/signature',
      permission: 'migration.parallel.sign', idempotent: true,
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const businessDate = (ctx.params['businessDate'] ?? '').trim();
        const b = isObj(ctx.body) ? ctx.body : {};
        if (!isDate(businessDate) || typeof b['statement'] !== 'string' || b['signedBy'] !== undefined) {
          throw apiError(400, {
            code: 'not_readable_as_a_day_signature',
            whatHappened: 'Signing a parallel-run day needs the date (YYYY-MM-DD) in the path and { statement } — what you checked. The signer is the person signed in, never a name in the request.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was signed.',
          });
        }
        const existing = await currentDaySignature(deps, ctx.tenantId, businessDate);
        if (existing !== undefined) return { status: 200, body: { signature: existing, alreadySigned: true } };
        const { policy, result } = await judgeSignature(ctx.tenantId, businessDate, ctx.userId, b['statement'] as string, deps.now());
        if (policy === undefined || result === undefined) {
          throw apiError(409, {
            code: 'parallel_run_not_started',
            whatHappened: 'No parallel-run policy has been written, so nobody is named to reconcile daily (R-05).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'The owner writes the policy first — PUT /v1/migration/parallel-run/policy. Nothing was signed.',
          });
        }
        if (!result.ok) {
          const status = result.refusedBecause === 'not_the_named_reconciler' ? 403 : result.refusedBecause === 'day_not_recorded' ? 404 : 422;
          throw apiError(status, {
            code: result.refusedBecause,
            whatHappened: result.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: result.refusedBecause === 'unexplained_material_difference'
              ? `Nothing was signed. Give each of these a reason — ${result.unexplained.map((d) => d.differenceId).join(', ')} — on the migration screen or POST /v1/migration/parallel-run/differences/:differenceId/own, then sign.`
              : 'Nothing was signed.',
          });
        }
        if (deps.recordParallelDaySignature === undefined) notWired();
        await deps.recordParallelDaySignature!(ctx.tenantId, result.signature);
        return { status: 201, body: { signature: result.signature, detail: result.detail } };
      },
    },
    {
      // The day as the screen entered it, relayed by the box (`MigrationParallelDayEntered`). Body: { enteredBy,
      // comparisons[], explanations[{ area, explanation, wrongSide? }], enteredAt? }.
      api: 'API-12', method: 'POST', path: '/v1/migration/parallel-run/days/:businessDate/synced',
      permission: 'migration.decision.sync', idempotent: true,
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const businessDate = (ctx.params['businessDate'] ?? '').trim();
        const b = isObj(ctx.body) ? ctx.body : {};
        const comparisons = b['comparisons'];
        const explanations = b['explanations'] ?? [];
        if (!isDate(businessDate) || !isStr(b['enteredBy']) || !Array.isArray(comparisons) || comparisons.length === 0 || !comparisons.every(isComparison)
          || !Array.isArray(explanations) || !explanations.every(isExplanation)) {
          throw apiError(400, {
            code: 'not_readable_as_a_relayed_day',
            whatHappened: 'A relayed parallel-run day needs the date in the path and { enteredBy, comparisons[{ area, legacyValue, newValue, toleranceMinor }], explanations[{ area, explanation, wrongSide? }] }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Keep it in the outbox and raise it — a day entered at the store must not be dropped.',
          });
        }
        const enteredBy = (b['enteredBy'] as string).trim();
        const refusedAs = async (refusedBecause: string, detail: string) => {
          const r = await refuse(ctx.tenantId, { kind: 'parallel_day', subjectId: businessDate, attemptedBy: enteredBy, refusedBecause, detail, relayedBy: ctx.userId });
          return { status: 202, body: { businessDate, applied: false, refusedBecause, detail, refusedDecisionId: r.decisionId } };
        };
        const seal = deciderSealFlags(deps.tillSealKey, { tenantId: ctx.tenantId, kind: 'migration_parallel_day', recordId: businessDate, named: enteredBy, record: ctx.body });
        if (seal.length > 0) return refusedAs(seal[0]!, `the store computer did not vouch that ${enteredBy} entered this day (${seal[0]!}), so it does not count until a person looks.`);
        const policy = await policyOf(ctx.tenantId);
        if (policy === undefined) return refusedAs('parallel_run_not_started', 'no parallel-run policy is written on the cloud, so nobody is named to reconcile daily (R-05).');
        const ownerId = await deps.ownerId(ctx.tenantId);
        if (enteredBy !== policy.dailyReconcilerUserId && enteredBy !== ownerId) {
          return refusedAs('not_the_named_reconciler', `${policy.dailyReconcilerUserId} is the person named to reconcile daily; ${enteredBy} is not, and is not the owner.`);
        }
        if (businessDate < policy.startedOn) return refusedAs('before_the_parallel_run_started', `${businessDate} is before the run started on ${policy.startedOn}.`);
        if (deps.recordParallelDay === undefined || deps.recordParallelDifference === undefined) notWired();
        const enteredAt = isStr(b['enteredAt']) ? (b['enteredAt'] as string) : deps.now();
        const held = await dayOf(ctx.tenantId, businessDate);
        // The same figures again is the same day: it is not re-recorded, only the reasons are applied. New figures are
        // a new, later fact about the day — its differences are raised afresh and need their reasons afresh.
        if (held === undefined || dayDigestOf(held.comparisons) !== dayDigestOf(comparisons as DayComparison[])) {
          const result = compareParallelDay({ tenantId: ctx.tenantId, businessDate, comparisons: comparisons as DayComparison[] });
          await deps.recordParallelDay!(ctx.tenantId, { ...result, comparisons: comparisons as DayComparison[], recordedBy: enteredBy, recordedAt: enteredAt });
          for (const d of result.differences) await deps.recordParallelDifference!(ctx.tenantId, d);
        }
        const applied: string[] = [];
        const refusedReasons: string[] = [];
        for (const e of explanations as Explanation[]) {
          if (e.explanation.trim() === '') continue;
          const all = await differencesNow(ctx.tenantId);
          const target = all.find((d) => d.businessDate === businessDate && d.area === e.area && d.status !== 'resolved');
          if (target === undefined) continue;
          const r = ownDifference({ differences: all, differenceId: target.differenceId, ownerUserId: enteredBy, explanation: e.explanation, ...(e.wrongSide === undefined ? {} : { wrongSide: e.wrongSide }) });
          if (!r.ok) { refusedReasons.push(`${target.differenceId}: ${r.detail}`); continue; }
          await deps.recordParallelDifference!(ctx.tenantId, r.differences.find((d) => d.differenceId === target.differenceId)!);
          applied.push(target.differenceId);
        }
        if (refusedReasons.length > 0) {
          const r = await refuse(ctx.tenantId, { kind: 'parallel_day', subjectId: businessDate, attemptedBy: enteredBy, refusedBecause: 'explanation_refused', detail: refusedReasons.join('; '), relayedBy: ctx.userId });
          return { status: 202, body: { businessDate, applied: true, explained: applied, refusedExplanations: refusedReasons, refusedDecisionId: r.decisionId } };
        }
        return { status: 202, body: { businessDate, applied: true, explained: applied } };
      },
    },
    {
      // The day signed on the screen, relayed by the box (`MigrationParallelDaySigned`). Body: { signedBy, statement,
      // dayDigest, signedAt? }. The digest must be the figures the cloud holds for the day — a signature over figures
      // the cloud never recorded signs nothing.
      api: 'API-12', method: 'POST', path: '/v1/migration/parallel-run/days/:businessDate/signature/synced',
      permission: 'migration.decision.sync', idempotent: true,
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const businessDate = (ctx.params['businessDate'] ?? '').trim();
        const b = isObj(ctx.body) ? ctx.body : {};
        if (!isDate(businessDate) || !isStr(b['signedBy']) || typeof b['statement'] !== 'string' || !isStr(b['dayDigest'])) {
          throw apiError(400, {
            code: 'not_readable_as_a_relayed_day_signature',
            whatHappened: 'A relayed day signature needs the date in the path and { signedBy, statement, dayDigest }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Keep it in the outbox and raise it — a signature made at the store must not be dropped.',
          });
        }
        const signedBy = (b['signedBy'] as string).trim();
        const refusedAs = async (refusedBecause: string, detail: string) => {
          const r = await refuse(ctx.tenantId, { kind: 'parallel_day_signature', subjectId: businessDate, attemptedBy: signedBy, refusedBecause, detail, relayedBy: ctx.userId });
          return { status: 202, body: { businessDate, applied: false, refusedBecause, detail, refusedDecisionId: r.decisionId } };
        };
        const seal = deciderSealFlags(deps.tillSealKey, { tenantId: ctx.tenantId, kind: 'migration_parallel_day_signature', recordId: businessDate, named: signedBy, record: ctx.body });
        if (seal.length > 0) return refusedAs(seal[0]!, `the store computer did not vouch that ${signedBy} signed this day (${seal[0]!}), so the signature does not count until a person looks.`);
        const existing = await currentDaySignature(deps, ctx.tenantId, businessDate);
        if (existing !== undefined) {
          if (existing.signedBy === signedBy) return { status: 202, body: { businessDate, applied: true, alreadyApplied: true } };
          return refusedAs('already_signed', `${businessDate} was signed by ${existing.signedBy} first — the store's later signature does not replace it.`);
        }
        const day = await dayOf(ctx.tenantId, businessDate);
        if (day !== undefined && dayDigestOf(day.comparisons) !== b['dayDigest']) {
          return refusedAs('day_changed', `the figures signed at the store are not the figures head office holds for ${businessDate} — the day was entered again since. Sign the day as it now stands.`);
        }
        const at = isStr(b['signedAt']) ? (b['signedAt'] as string) : deps.now();
        const { policy, result } = await judgeSignature(ctx.tenantId, businessDate, signedBy, b['statement'] as string, at);
        if (policy === undefined || result === undefined) return refusedAs('parallel_run_not_started', 'no parallel-run policy is written on the cloud (R-05).');
        if (!result.ok) return refusedAs(result.refusedBecause, result.detail);
        if (deps.recordParallelDaySignature === undefined) notWired();
        await deps.recordParallelDaySignature!(ctx.tenantId, result.signature);
        return { status: 202, body: { businessDate, applied: true, detail: result.detail } };
      },
    },
  ];
}
