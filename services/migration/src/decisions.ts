// API-12 — the decisions the migration screen makes, KEPT on the cloud (Stage C3a; MG-04 · MG-06 · §28 ·
// §31 · hard rules #6 #10 · P-08).
//
// Until now `POST /v1/migration/cleaning/exceptions` and `POST /v1/migration/reconciliation` were pure
// what-if surfaces: they judged the dataset or the totals in the request body and stored NOTHING. The
// migration screen, meanwhile, resolved exceptions and signed control totals against the copy the store
// box had been handed, committed each decision to the box's outbox (hard rule #1) and queued a
// `MigrationExceptionResolved` / `MigrationTotalSigned` event — which the sync agent could not route
// anywhere, so every decision made on the night dead-lettered. A decision that is only ever a row in a
// dead-letter queue is not a decision anybody can rely on at the cutover gate.
//
// This module is where those decisions land:
//
//   • the exceptions a cleaning pass raised are RECORDED (once per id; never pruned — resolved ones are
//     the evidence, hard rule #6), and a named person resolves one at the desk or from the store box;
//   • control totals are RECORDED (the engine's independence check still refuses a total that compares a
//     figure with itself), and a named person signs one — the signer's authority is read from their OWN
//     grants and the load operator from the ledger, never from the request;
//   • a decision RELAYED by the store box (the screen's queued event) is applied under the person who made
//     it at the box — trusted as the synced sale/return/checklist routes trust the lane's operator — AFTER
//     the cloud re-checks that person's authority and re-runs the engine's own rules. A relayed decision
//     the cloud cannot accept is not dropped and not silently applied: it is recorded as a REFUSED
//     decision, visible for a person to work (hard rule #10), and the relay gets 202 so the box stops
//     retrying something that will never pass.
//
// The engines are the same pure ones the screen runs (`resolveException`, `recordControlTotal`,
// `signControlTotal`, `assessReconciliation`, `outstandingExceptions`), so a decision that passes at the
// desk passes here for the same reasons, and one that fails, fails for the same reasons.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  outstandingExceptions, resolveException,
  type ExceptionResolution, type MigrationException, type ResolutionAction,
} from '../../../packages/migration/src/cleaning';
import {
  assessReconciliation, recordControlTotal, signControlTotal,
  type ControlTotal, type TotalSignature,
} from '../../../packages/migration/src/reconcile';
import { assertSafeTarget } from './guards';
import type { MigrationDeps } from './index';

// ── What gets recorded ─────────────────────────────────────────────────────────────────────────────

/** A decision the store box relayed that the cloud could not accept — kept, never dropped (hard rule #10). */
export interface RefusedDecision {
  readonly decisionId: string;
  readonly kind: 'exception_resolution' | 'total_signature';
  /** The exception id or the total id the decision was about. */
  readonly subjectId: string;
  /** The person the box says made it. */
  readonly attemptedBy: string;
  readonly refusedBecause: string;
  readonly detail: string;
  /** The sync identity that relayed it, and when the cloud saw it. */
  readonly relayedBy: string;
  readonly relayedAt: string;
}

// ── Readers ────────────────────────────────────────────────────────────────────────────────────────

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const EXCEPTION_KINDS: ReadonlySet<string> = new Set([
  'duplicate_product', 'shared_barcode', 'negative_stock', 'unmapped_tax_code', 'document_total_mismatch',
  'pre_revision_tax_document', 'duplicate_supplier_gstin', 'orphan_line', 'duplicate_customer', 'batch_without_expiry',
]);
const SEVERITIES: ReadonlySet<string> = new Set(['blocking', 'high', 'medium', 'low']);
const CONFIDENCES: ReadonlySet<string> = new Set(['certain', 'probable']);
const ACTIONS: ReadonlySet<string> = new Set(['merge', 'correct', 'exclude', 'migrate_as_is']);
const TOTAL_KINDS: ReadonlySet<string> = new Set(['migration', 'stock', 'financial', 'tax', 'loyalty']);
const TOTAL_UNITS: ReadonlySet<string> = new Set(['rows', 'quantity', 'minor_currency', 'points']);

/** An exception as the cleaning pass raised it — stamped with THIS tenant, never the body's. */
function readException(v: unknown, tenantId: string): MigrationException | undefined {
  if (!isObj(v)) return undefined;
  if (!isStr(v['exceptionId']) || !isStr(v['kind']) || !EXCEPTION_KINDS.has(v['kind']) || !isStr(v['severity']) || !SEVERITIES.has(v['severity'])
    || !isStr(v['confidence']) || !CONFIDENCES.has(v['confidence']) || !Array.isArray(v['legacyIds']) || !v['legacyIds'].every(isStr)
    || typeof v['evidence'] !== 'string' || (v['valueMinor'] !== undefined && !isNum(v['valueMinor']))) return undefined;
  return {
    exceptionId: v['exceptionId'], tenantId,
    kind: v['kind'] as MigrationException['kind'], severity: v['severity'] as MigrationException['severity'],
    confidence: v['confidence'] as MigrationException['confidence'],
    legacyIds: v['legacyIds'] as string[], evidence: v['evidence'],
    ...(isNum(v['valueMinor']) ? { valueMinor: v['valueMinor'] } : {}),
  };
}

/** A control total as the operator recorded it — stamped with THIS tenant; no signature may arrive in the body. */
function readTotal(v: unknown, tenantId: string): ControlTotal | undefined {
  if (!isObj(v)) return undefined;
  if (!isStr(v['totalId']) || !isStr(v['kind']) || !TOTAL_KINDS.has(v['kind']) || !isStr(v['name']) || !isStr(v['unit']) || !TOTAL_UNITS.has(v['unit'])
    || !isNum(v['legacyValue']) || !isNum(v['loadedValue']) || typeof v['legacyDerivation'] !== 'string' || typeof v['loadedDerivation'] !== 'string'
    || (v['approvedExclusionValue'] !== undefined && !isNum(v['approvedExclusionValue']))
    || (v['explanation'] !== undefined && typeof v['explanation'] !== 'string')) return undefined;
  return {
    totalId: v['totalId'], tenantId, kind: v['kind'] as ControlTotal['kind'], name: v['name'], unit: v['unit'] as ControlTotal['unit'],
    legacyValue: v['legacyValue'], loadedValue: v['loadedValue'],
    legacyDerivation: v['legacyDerivation'], loadedDerivation: v['loadedDerivation'],
    ...(isNum(v['approvedExclusionValue']) ? { approvedExclusionValue: v['approvedExclusionValue'] } : {}),
    ...(typeof v['explanation'] === 'string' && v['explanation'] !== '' ? { explanation: v['explanation'] } : {}),
  };
}

interface ResolutionBody {
  readonly action: ResolutionAction;
  readonly reason: string;
  readonly survivingLegacyId?: string;
}
function readResolutionBody(v: unknown): ResolutionBody | undefined {
  if (!isObj(v) || !isStr(v['action']) || !ACTIONS.has(v['action']) || typeof v['reason'] !== 'string') return undefined;
  return {
    action: v['action'] as ResolutionAction, reason: v['reason'],
    ...(isStr(v['survivingLegacyId']) ? { survivingLegacyId: v['survivingLegacyId'] } : {}),
  };
}

const notWired = (): never => {
  throw apiError(503, {
    code: 'decision_store_not_wired',
    whatHappened: 'This deployment has no ledger to keep migration decisions in.',
    wasItSaved: 'not_saved',
    nextSafeAction: 'Nothing was recorded. Run against a deployment with the event ledger configured.',
  });
};

/** The signer's role for THIS signature, from their own grants: the chartered accountant if they hold it. */
async function signerRoleOf(deps: MigrationDeps, tenantId: string, userId: string): Promise<string> {
  const roles = deps.rolesOf ? await deps.rolesOf(tenantId, userId) : [];
  return roles.includes('chartered_accountant') ? 'chartered_accountant' : (roles[0] ?? 'unknown');
}

// ── The routes ─────────────────────────────────────────────────────────────────────────────────────

export function decisionRoutes(deps: MigrationDeps): readonly Route[] {
  const exceptionsNow = async (tenantId: string): Promise<readonly MigrationException[]> => {
    if (deps.exceptions === undefined) notWired();
    return deps.exceptions!(tenantId);
  };
  const totalsNow = async (tenantId: string): Promise<readonly ControlTotal[]> => {
    if (deps.controlTotals === undefined) notWired();
    return deps.controlTotals!(tenantId);
  };
  const refuse = async (tenantId: string, d: Omit<RefusedDecision, 'decisionId' | 'relayedAt'>): Promise<RefusedDecision> => {
    const relayedAt = deps.now();
    const refused: RefusedDecision = { ...d, decisionId: `${d.kind}-${d.subjectId}-${relayedAt}`, relayedAt };
    if (deps.recordRefusedDecision === undefined) notWired();
    await deps.recordRefusedDecision!(tenantId, refused);
    return refused;
  };

  return [
    {
      // MG-04 — RECORD the exceptions a cleaning pass raised, so they exist somewhere other than a
      // response body. Body: { exceptions: MigrationException[] } (the cleaning report's own list). Once per
      // exception id; a re-post of the same list records nothing new; a resolved exception is never
      // overwritten by a fresh copy of its unresolved self (the ledger keeps the first fact — hard rule #6).
      api: 'API-12', method: 'POST', path: '/v1/migration/exceptions',
      permission: 'migration.exception.record', idempotent: true,
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const raw = isObj(ctx.body) ? ctx.body['exceptions'] : undefined;
        const parsed = Array.isArray(raw) ? raw.map((e) => readException(e, ctx.tenantId)) : undefined;
        if (parsed === undefined || parsed.some((e) => e === undefined)) {
          throw apiError(400, {
            code: 'not_readable_as_exceptions',
            whatHappened: 'This payload could not be read as migration exceptions — each needs an exceptionId, a kind, a severity (blocking/high/medium/low), a confidence (certain/probable), legacyIds[] and evidence.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was recorded. Send the cleaning report\'s own exceptions list.',
          });
        }
        if (deps.recordException === undefined) notWired();
        const known = new Set((await exceptionsNow(ctx.tenantId)).map((e) => e.exceptionId));
        let recorded = 0;
        for (const e of parsed as MigrationException[]) {
          if (known.has(e.exceptionId)) continue;
          await deps.recordException!(ctx.tenantId, e);
          known.add(e.exceptionId);
          recorded += 1;
        }
        const all = await exceptionsNow(ctx.tenantId);
        return { status: 201, body: { recorded, alreadyKnown: parsed.length - recorded, outstanding: outstandingExceptions(all) } };
      },
    },
    {
      // MG-04 — every exception ever recorded (resolved ones included — they are the evidence), what still
      // stands between the data and a cutover, and every relayed decision the cloud could not accept.
      api: 'API-12', method: 'GET', path: '/v1/migration/exceptions',
      permission: 'migration.cleaning.read',
      handler: async (ctx) => {
        const all = await exceptionsNow(ctx.tenantId);
        const refused = deps.refusedDecisions === undefined ? [] : await deps.refusedDecisions(ctx.tenantId);
        return { status: 200, body: { exceptions: all, outstanding: outstandingExceptions(all), refusedDecisions: refused.filter((r) => r.kind === 'exception_resolution'), asAt: deps.now() } };
      },
    },
    {
      // MG-04 — RESOLVE an exception at the desk. The decider is the authenticated caller (a decision about
      // the old shop's data carries the name of whoever made it — in a year that name is the only record
      // anybody did). The engine's rules refuse: an unknown exception, a second decision on a resolved one
      // (the first is the evidence), a merge with no survivor or a survivor not involved, an empty reason.
      api: 'API-12', method: 'POST', path: '/v1/migration/exceptions/:exceptionId/resolution',
      permission: 'migration.exception.resolve', idempotent: true,
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const exceptionId = (ctx.params['exceptionId'] ?? '').trim();
        const body = readResolutionBody(ctx.body);
        if (exceptionId === '' || body === undefined) {
          throw apiError(400, {
            code: 'not_readable_as_a_resolution',
            whatHappened: 'Resolving an exception needs its id in the path and { action (merge/correct/exclude/migrate_as_is), reason, survivingLegacyId? } in the body.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was recorded. Say what was decided and why, and send it again.',
          });
        }
        const all = await exceptionsNow(ctx.tenantId);
        if (!all.some((e) => e.exceptionId === exceptionId)) throw notFound(`migration exception ${exceptionId}`);
        const resolution: ExceptionResolution = { action: body.action, decidedBy: ctx.userId, decidedAt: deps.now(), reason: body.reason, ...(body.survivingLegacyId === undefined ? {} : { survivingLegacyId: body.survivingLegacyId }) };
        const result = resolveException({ exceptions: all, exceptionId, resolution });
        if (!result.ok) {
          throw apiError(422, {
            code: result.refusedBecause!,
            whatHappened: result.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was recorded. A resolved exception keeps its first decision; a merge must name a record that is involved; every decision needs a reason.',
          });
        }
        if (deps.recordExceptionResolution === undefined) notWired();
        await deps.recordExceptionResolution!(ctx.tenantId, exceptionId, resolution);
        const after = await exceptionsNow(ctx.tenantId);
        return { status: 200, body: { exception: after.find((e) => e.exceptionId === exceptionId), outstanding: outstandingExceptions(after), detail: result.detail } };
      },
    },
    {
      // MG-04 / §31 — a resolution made on the migration SCREEN at the store box and relayed by the sync agent
      // (the queued `MigrationExceptionResolved`). The decider is the person named at the box — trusted as the
      // synced sale/return/checklist routes trust the lane's operator — but the cloud RE-CHECKS that they hold
      // the authority to resolve, and re-runs the engine's own rules. A decision that cannot be accepted is
      // RECORDED AS REFUSED (visible; hard rule #10) and acknowledged 202, so the box stops retrying it and a
      // person sees it. A replay of a decision already applied is acknowledged as applied.
      api: 'API-12', method: 'POST', path: '/v1/migration/exceptions/:exceptionId/resolution/synced',
      permission: 'migration.decision.sync', idempotent: true,
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const exceptionId = (ctx.params['exceptionId'] ?? '').trim();
        const body = readResolutionBody(ctx.body);
        const decidedBy = isObj(ctx.body) && isStr(ctx.body['decidedBy']) ? ctx.body['decidedBy'] : undefined;
        if (exceptionId === '' || body === undefined || decidedBy === undefined) {
          throw apiError(400, {
            code: 'not_readable_as_a_relayed_resolution',
            whatHappened: 'A relayed resolution needs the exception id in the path and { action, reason, decidedBy, survivingLegacyId? } in the body.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Keep it in the outbox and raise it — a decision made at the store must not be dropped.',
          });
        }
        const decidedAt = isObj(ctx.body) && isStr(ctx.body['decidedAt']) ? ctx.body['decidedAt'] : deps.now();
        const resolution: ExceptionResolution = { action: body.action, decidedBy, decidedAt, reason: body.reason, ...(body.survivingLegacyId === undefined ? {} : { survivingLegacyId: body.survivingLegacyId }) };
        const refusedAs = async (refusedBecause: string, detail: string) => {
          const r = await refuse(ctx.tenantId, { kind: 'exception_resolution', subjectId: exceptionId, attemptedBy: decidedBy, refusedBecause, detail, relayedBy: ctx.userId });
          return { status: 202, body: { exceptionId, applied: false, refusedBecause, detail, refusedDecisionId: r.decisionId } };
        };
        // Authority first: a name at the box is not authority (§28).
        const mayResolve = deps.holdsPermission === undefined ? false : await deps.holdsPermission(ctx.tenantId, decidedBy, 'migration.exception.resolve');
        if (!mayResolve) return refusedAs('decider_lacks_authority', `${decidedBy} does not hold the authority to resolve migration exceptions, so this decision made at the store does not count.`);
        const all = await exceptionsNow(ctx.tenantId);
        const target = all.find((e) => e.exceptionId === exceptionId);
        if (target === undefined) return refusedAs('unknown_exception', `the cloud has no exception ${exceptionId} — the store decided about a record head office never recorded.`);
        if (target.resolution !== undefined) {
          const same = target.resolution.decidedBy === decidedBy && target.resolution.action === body.action && target.resolution.reason === body.reason;
          if (same) return { status: 202, body: { exceptionId, applied: true, alreadyApplied: true, detail: `${exceptionId} was already resolved by ${decidedBy}` } };
          return refusedAs('already_resolved', `${exceptionId} was resolved by ${target.resolution.decidedBy} first — the store's later decision does not overwrite it.`);
        }
        const result = resolveException({ exceptions: all, exceptionId, resolution });
        if (!result.ok) return refusedAs(result.refusedBecause!, result.detail);
        if (deps.recordExceptionResolution === undefined) notWired();
        await deps.recordExceptionResolution!(ctx.tenantId, exceptionId, resolution);
        return { status: 202, body: { exceptionId, applied: true, detail: result.detail } };
      },
    },
    {
      // MG-06 — RECORD control totals. The engine's independence check is the point: a total whose two
      // sides are derived the same way is a self-comparison wearing the costume of a check, and is refused
      // with nothing recorded. Body: { totals: ControlTotal[] } (no signatures — those are signed here later).
      api: 'API-12', method: 'POST', path: '/v1/migration/control-totals',
      permission: 'migration.controltotal.record', idempotent: true,
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const raw = isObj(ctx.body) ? ctx.body['totals'] : undefined;
        const parsed = Array.isArray(raw) ? raw.map((t) => readTotal(t, ctx.tenantId)) : undefined;
        if (parsed === undefined || parsed.some((t) => t === undefined)) {
          throw apiError(400, {
            code: 'not_readable_as_control_totals',
            whatHappened: 'This payload could not be read as control totals. Each needs a totalId, a kind (migration/stock/financial/tax/loyalty), a name, a unit (rows/quantity/minor_currency/points), a legacyValue, a loadedValue, and how EACH side was derived.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was recorded. Correct the totals and send them again.',
          });
        }
        let acc = await totalsNow(ctx.tenantId);
        const fresh: ControlTotal[] = [];
        for (const t of parsed as ControlTotal[]) {
          if (acc.some((k) => k.totalId === t.totalId)) continue; // already recorded — the ledger keeps the first
          const r = recordControlTotal({ totals: acc, total: t });
          if (!r.ok) {
            throw apiError(422, {
              code: r.refusedBecause!,
              whatHappened: r.detail,
              wasItSaved: 'not_saved',
              nextSafeAction: 'Nothing was recorded. Give the two sides different, independent derivations (or a unique id), then send again.',
            });
          }
          acc = r.totals;
          fresh.push(t);
        }
        if (deps.recordControlTotal === undefined) notWired();
        for (const t of fresh) await deps.recordControlTotal!(ctx.tenantId, t);
        const all = await totalsNow(ctx.tenantId);
        return { status: 201, body: { recorded: fresh.length, alreadyKnown: parsed.length - fresh.length, totals: all, reconciliation: assessReconciliation({ tenantId: ctx.tenantId, totals: all }) } };
      },
    },
    {
      // MG-06 — the totals as they stand, with the reconciliation (QG-07 lives in `qg07Passed`) and every
      // relayed signature the cloud could not accept.
      api: 'API-12', method: 'GET', path: '/v1/migration/control-totals',
      permission: 'migration.reconciliation.read',
      handler: async (ctx) => {
        const all = await totalsNow(ctx.tenantId);
        const refused = deps.refusedDecisions === undefined ? [] : await deps.refusedDecisions(ctx.tenantId);
        return { status: 200, body: { totals: all, reconciliation: assessReconciliation({ tenantId: ctx.tenantId, totals: all }), refusedDecisions: refused.filter((r) => r.kind === 'total_signature'), asAt: deps.now() } };
      },
    },
    {
      // MG-06 — SIGN a recorded control total at the desk (QG-07). The signer is the authenticated caller; their
      // role is read from their own grants; who ran the load is read from the ledger (the extraction run) —
      // none of it from the body. The engine refuses the signer who ran the load (§28), a finance/tax total
      // not signed by the chartered accountant (M23 / C-01), an open total (no provisional signature), and a
      // second signature (the first stands).
      api: 'API-12', method: 'POST', path: '/v1/migration/control-totals/:totalId/signature',
      permission: 'migration.controltotal.sign', idempotent: true,
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const totalId = (ctx.params['totalId'] ?? '').trim();
        const statement = isObj(ctx.body) ? ctx.body['statement'] : undefined;
        if (totalId === '' || !isStr(statement)) {
          throw apiError(400, {
            code: 'not_readable_as_a_signature',
            whatHappened: 'Signing a control total needs its id in the path and a statement in the body — what the signer checked, in their own words.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was signed. Say what you checked and send it again.',
          });
        }
        const all = await totalsNow(ctx.tenantId);
        if (!all.some((t) => t.totalId === totalId)) throw notFound(`control total ${totalId}`);
        const loadOperator = await deps.extractionOperator(ctx.tenantId);
        if (loadOperator === undefined) {
          throw apiError(422, {
            code: 'nobody_ran_the_load',
            whatHappened: 'The ledger does not say who ran the extraction/load, so it cannot check that the signer is somebody else (§28) — and a signature that cannot be checked is not a control.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Record the extraction run (POST /v1/migration/extraction-runs/:runId) first. Nothing was signed.',
          });
        }
        const signerRole = await signerRoleOf(deps, ctx.tenantId, ctx.userId);
        const result = signControlTotal({ totals: all, totalId, signedBy: ctx.userId, signerRole, loadOperator, statement, now: deps.now() });
        if (!result.ok) {
          throw apiError(422, {
            code: result.refusedBecause!,
            whatHappened: result.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was signed. The person who ran the load cannot sign its totals; a finance or tax total is the chartered accountant\'s to sign; an open total has no provisional signature; the first signature stands.',
          });
        }
        const signature = result.totals.find((t) => t.totalId === totalId)!.signature!;
        if (deps.recordTotalSignature === undefined) notWired();
        await deps.recordTotalSignature!(ctx.tenantId, totalId, signature);
        const after = await totalsNow(ctx.tenantId);
        return { status: 200, body: { total: after.find((t) => t.totalId === totalId), reconciliation: assessReconciliation({ tenantId: ctx.tenantId, totals: after }), detail: result.detail } };
      },
    },
    {
      // MG-06 / §31 — a signature made on the migration SCREEN at the store box and relayed by the sync agent
      // (the queued `MigrationTotalSigned`). The signer is the person named at the box; the cloud re-checks
      // that they hold the authority to sign, derives their role from their OWN grants (never the body's
      // `signerRole`), reads the load operator from the ledger, and re-runs the engine. A signature the cloud
      // cannot accept is RECORDED AS REFUSED (visible) and acknowledged 202 — a control total is never
      // "provisionally" signed by a relay. A replay of the same signature is acknowledged as applied.
      api: 'API-12', method: 'POST', path: '/v1/migration/control-totals/:totalId/signature/synced',
      permission: 'migration.decision.sync', idempotent: true,
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const totalId = (ctx.params['totalId'] ?? '').trim();
        const b = isObj(ctx.body) ? ctx.body : {};
        if (totalId === '' || !isStr(b['signedBy']) || !isStr(b['statement'])) {
          throw apiError(400, {
            code: 'not_readable_as_a_relayed_signature',
            whatHappened: 'A relayed signature needs the total id in the path and { signedBy, statement } in the body.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Keep it in the outbox and raise it — a signature made at the store must not be dropped.',
          });
        }
        const signedBy = b['signedBy'];
        const statement = b['statement'];
        const refusedAs = async (refusedBecause: string, detail: string) => {
          const r = await refuse(ctx.tenantId, { kind: 'total_signature', subjectId: totalId, attemptedBy: signedBy, refusedBecause, detail, relayedBy: ctx.userId });
          return { status: 202, body: { totalId, applied: false, refusedBecause, detail, refusedDecisionId: r.decisionId } };
        };
        const maySign = deps.holdsPermission === undefined ? false : await deps.holdsPermission(ctx.tenantId, signedBy, 'migration.controltotal.sign');
        if (!maySign) return refusedAs('signer_lacks_authority', `${signedBy} does not hold the authority to sign a control total, so this signature made at the store does not count.`);
        const all = await totalsNow(ctx.tenantId);
        const target = all.find((t) => t.totalId === totalId);
        if (target === undefined) return refusedAs('unknown_total', `the cloud has no control total ${totalId} — the store signed a total head office never recorded.`);
        if (target.signature !== undefined) {
          if (target.signature.signedBy === signedBy && target.signature.statement === statement) {
            return { status: 202, body: { totalId, applied: true, alreadyApplied: true, detail: `${totalId} was already signed by ${signedBy}` } };
          }
          return refusedAs('already_signed', `${totalId} was signed by ${target.signature.signedBy} first — the store's later signature does not replace it.`);
        }
        const loadOperator = await deps.extractionOperator(ctx.tenantId);
        if (loadOperator === undefined) return refusedAs('nobody_ran_the_load', 'the ledger does not say who ran the extraction/load, so the cloud cannot check the signer is somebody else (§28).');
        const signerRole = await signerRoleOf(deps, ctx.tenantId, signedBy);
        const signedAt = isStr(b['signedAt']) ? b['signedAt'] : deps.now();
        const result = signControlTotal({ totals: all, totalId, signedBy, signerRole, loadOperator, statement, now: signedAt });
        if (!result.ok) return refusedAs(result.refusedBecause!, result.detail);
        const signature: TotalSignature = result.totals.find((t) => t.totalId === totalId)!.signature!;
        if (deps.recordTotalSignature === undefined) notWired();
        await deps.recordTotalSignature!(ctx.tenantId, totalId, signature);
        return { status: 202, body: { totalId, applied: true, detail: result.detail } };
      },
    },
  ];
}
