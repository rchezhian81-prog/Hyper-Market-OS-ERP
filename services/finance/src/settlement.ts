// API-09 Settlement — the cash office's day: get the provider's file in safely, then tell apart the
// unmatched card tender that is merely NOT DUE YET from the one that is genuinely LATE (M14-FR-03).
//
// `packages/settlement` is a complete, tested engine that nothing fed. This wires it to the cloud,
// where every card/UPI tender the shop took and every credit the provider paid are both visible —
// the only place the two can actually be reconciled. Two endpoints, both thin over the engine:
//
//   • import a provider batch, refused unless it reconciles to its OWN declared figures (a file that
//     does not add up will not stop being wrong once it is inside the system), and refused as a
//     duplicate (importing it twice doubles every credit in it);
//   • review a window of electronic tenders against what the provider actually paid — matched,
//     not-due-yet (reported for cash flow, not as a problem), and genuinely at-risk (late, short,
//     over, unknown, ambiguous), each valued so the one that matters is not buried.
//
// The window the review read is reported back, never left implicit: an unmatched tender older than
// the window is not "settled", it is out of scope for this review and belongs to an open
// investigation (the next slice). Saying so is the difference between an honest review and a
// reassuring one (P-08).

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  importSettlementBatch, reviewSettlement,
  openInvestigation, resolveInvestigation, ageInvestigations,
  type SettlementBatch, type SettlementException, type SettlementFinding,
  type Investigation, type InvestigationOutcome,
} from '../../../packages/settlement/src/settlement';
import type { PosTender, SettlementLine } from '../../../packages/reconciliation/src/reconciliation';

export type { SettlementBatch } from '../../../packages/settlement/src/settlement';
export type { Investigation } from '../../../packages/settlement/src/settlement';
export type { PosTender, SettlementLine } from '../../../packages/reconciliation/src/reconciliation';

const OUTCOMES: readonly InvestigationOutcome[] = ['provider_error_recovered', 'provider_fee_not_an_exception', 'till_error', 'timing_only', 'written_off', 'fraud_suspected'];

/** A POS electronic tender with the day it was captured, for ageing (M14-FR-03). */
export type CapturedTender = PosTender & { readonly capturedOn: string };

export interface SettlementRoutesDeps {
  /** Batch ids already imported, so importing one twice is refused rather than doubling its credits. */
  readonly importedBatchIds: (tenantId: string) => Promise<readonly string[]> | readonly string[];
  /** Record an accepted batch (its lines become the credits the review reconciles against). */
  readonly recordBatch: (tenantId: string, batch: SettlementBatch) => Promise<void> | void;
  /** Every credit line the shop has imported (bounded — a handful of batches a day). */
  readonly credits: (tenantId: string) => Promise<readonly SettlementLine[]> | readonly SettlementLine[];
  /** Electronic tenders captured in `[fromIso, toIso)`, for the review's ageing window. */
  readonly electronicTenders: (tenantId: string, fromIso: string, toIso: string) => Promise<readonly CapturedTender[]> | readonly CapturedTender[];
  /** Every investigation, folded from its lifecycle events (bounded — exceptions are low-volume). */
  readonly investigations: (tenantId: string) => Promise<readonly Investigation[]> | readonly Investigation[];
  readonly recordInvestigationOpened: (tenantId: string, inv: Investigation) => Promise<void> | void;
  readonly recordInvestigationEvidence: (tenantId: string, investigationId: string, ref: string, at: string) => Promise<void> | void;
  readonly recordInvestigationResolved: (tenantId: string, inv: Investigation) => Promise<void> | void;
  readonly now: () => string;
}

/** The exception a case is opened on — the fields `openInvestigation` reads, from the review output. */
function readException(body: unknown): SettlementException | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const e = (body as { exception?: unknown }).exception;
  if (e === null || typeof e !== 'object') return undefined;
  const x = e as Partial<SettlementException>;
  const ok = typeof x.finding === 'string' && typeof x.ref === 'string' && x.ref.trim() !== ''
    && Number.isInteger(x.valueMinor) && typeof x.needsInvestigation === 'boolean';
  return ok ? { finding: x.finding as SettlementFinding, ref: x.ref!, valueMinor: x.valueMinor!, needsInvestigation: x.needsInvestigation!, detail: typeof x.detail === 'string' ? x.detail : '' } : undefined;
}

const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00.000Z`));

/** A date shifted by whole days, in UTC — the window the ledger's timestamps are stored in. */
function shiftDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** Enough of a provider batch to be one; the arithmetic checks belong to `importSettlementBatch`. */
function readBatch(body: unknown): SettlementBatch | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const b = body as Partial<SettlementBatch>;
  const ints = [b.declaredGrossMinor, b.declaredFeesMinor, b.declaredNetMinor];
  const ok = typeof b.batchId === 'string' && b.batchId.trim() !== ''
    && typeof b.providerId === 'string' && typeof b.currency === 'string'
    && isDate(b.settlementDate)
    && Array.isArray(b.lines)
    && ints.every((n) => Number.isInteger(n))
    && b.lines.every((l) => typeof l.id === 'string' && typeof l.ref === 'string' && Number.isInteger(l.amountMinor));
  return ok ? (b as SettlementBatch) : undefined;
}

export function settlementRoutes(deps: SettlementRoutesDeps): readonly Route[] {
  return [
    {
      api: 'API-09', method: 'POST', path: '/v1/settlement/batches',
      permission: 'settlement.batch.import', idempotent: true,
      handler: async (ctx) => {
        const batch = readBatch(ctx.body);
        if (batch === undefined) {
          throw apiError(400, {
            code: 'not_readable_as_a_batch',
            whatHappened: 'This payload could not be read as a settlement batch — it needs a batch id, provider, currency, settlement date, lines (id/ref/amount) and whole gross/fees/net figures.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Fix the file and send it again. Nothing was imported.',
          });
        }

        const result = importSettlementBatch(batch, await deps.importedBatchIds(ctx.tenantId));
        if (!result.accepted) {
          throw apiError(422, {
            code: result.outcome,
            whatHappened: result.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: result.outcome === 'duplicate_batch'
              ? 'This batch is already in the system; do not import it again. Its credits are already reconciling.'
              : 'Query the file with the provider before using it. Nothing was imported, so nothing has been corrupted.',
          });
        }

        await deps.recordBatch(ctx.tenantId, batch);
        return { status: 201, body: { batchId: batch.batchId, accepted: true, detail: result.detail, lineTotalMinor: result.lineTotalMinor } };
      },
    },
    {
      api: 'API-09', method: 'GET', path: '/v1/settlement/review',
      permission: 'settlement.review.read',
      handler: async (ctx) => {
        const asOf = ctx.query['date'];
        const cycleDays = Number(ctx.query['cycleDays']);
        const windowDays = ctx.query['windowDays'] === undefined ? 30 : Number(ctx.query['windowDays']);
        if (!isDate(asOf) || !Number.isInteger(cycleDays) || cycleDays < 0 || !Number.isInteger(windowDays) || windowDays <= 0) {
          throw apiError(400, {
            code: 'review_needs_a_date_and_a_cycle',
            whatHappened: 'A settlement review needs ?date=YYYY-MM-DD, ?cycleDays=<the provider\'s contracted settlement cycle, e.g. 2 for T+2>, and an optional ?windowDays (default 30).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the date and the cycle. Nothing was changed; a review reads, it never writes.',
          });
        }

        const from = shiftDays(asOf, -windowDays);
        const tenders = await deps.electronicTenders(ctx.tenantId, `${from}T00:00:00.000Z`, `${shiftDays(asOf, 1)}T00:00:00.000Z`);
        const credits = await deps.credits(ctx.tenantId);
        const review = reviewSettlement({ tenders, credits, settlementCycleDays: cycleDays, asOf });

        // The window is part of the answer, not a hidden assumption: an unmatched tender older than
        // `from` is out of scope here, not settled, and belongs to an open investigation.
        return { status: 200, body: { ...review, window: { from, to: asOf, windowDays }, asAt: deps.now() } };
      },
    },
    {
      // Open an investigation on a settlement exception. It needs a NAMED owner and a future due
      // date, and it refuses to open on a not-a-problem (an awaiting-settlement tender is not late) —
      // opening cases on non-problems trains people to close cases without reading them.
      api: 'API-09', method: 'POST', path: '/v1/settlement/investigations',
      permission: 'settlement.investigation.manage', idempotent: true,
      handler: async (ctx) => {
        const body = (ctx.body ?? {}) as { investigationId?: unknown; ownerId?: unknown; dueBy?: unknown; evidenceRefs?: unknown };
        const exception = readException(ctx.body);
        if (typeof body.investigationId !== 'string' || body.investigationId.trim() === '' || exception === undefined
          || typeof body.ownerId !== 'string' || !isDate(body.dueBy)) {
          throw apiError(400, {
            code: 'not_readable_as_an_investigation',
            whatHappened: 'Opening a case needs an investigation id, the exception it is about (finding, ref, value, needsInvestigation), a named owner and a due date (YYYY-MM-DD).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was opened. Send the exception from the review, an owner and a due date.',
          });
        }

        const result = openInvestigation({
          investigationId: body.investigationId, exception, ownerId: body.ownerId,
          openedBy: ctx.userId, at: deps.now(), dueBy: body.dueBy,
          evidenceRefs: Array.isArray(body.evidenceRefs) ? body.evidenceRefs.filter((r): r is string => typeof r === 'string') : undefined,
        });
        if (!result.opened) {
          throw apiError(422, {
            code: result.refusedBecause!,
            whatHappened: result.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was opened. A case needs a real problem, a named owner and a due date that is not already past.',
          });
        }

        await deps.recordInvestigationOpened(ctx.tenantId, result.investigation!);
        return { status: 201, body: { investigationId: result.investigation!.investigationId, state: 'open', ownerId: result.investigation!.ownerId, dueBy: result.investigation!.dueBy } };
      },
    },
    {
      // Attach evidence to an open case. Append-only: references are never replaced or removed
      // (hard rule #6 — evidence is not edited).
      api: 'API-09', method: 'POST', path: '/v1/settlement/investigations/:investigationId/evidence',
      permission: 'settlement.investigation.manage', idempotent: true,
      handler: async (ctx) => {
        const id = ctx.params['investigationId'] ?? '';
        const ref = (ctx.body as { ref?: unknown } | null)?.ref;
        if (typeof ref !== 'string' || ref.trim() === '') {
          throw apiError(400, { code: 'evidence_needs_a_reference', whatHappened: 'Attaching evidence needs a non-empty reference (a document id or link).', wasItSaved: 'not_saved', nextSafeAction: 'Send { "ref": "…" }. Nothing was attached.' });
        }
        const inv = (await deps.investigations(ctx.tenantId)).find((i) => i.investigationId === id);
        if (inv === undefined) throw notFound(`investigation ${id}`);

        await deps.recordInvestigationEvidence(ctx.tenantId, id, ref, deps.now());
        return { status: 200, body: { investigationId: id, evidenceRefs: inv.evidenceRefs.includes(ref) ? inv.evidenceRefs : [...inv.evidenceRefs, ref] } };
      },
    },
    {
      // Resolve a case. It closes ONLY with an outcome and a note — "closed" with no category is how
      // a shop discovers a year later it has been absorbing the same provider error every month.
      // Writing money off needs someone other than the person who raised it (§28).
      api: 'API-09', method: 'POST', path: '/v1/settlement/investigations/:investigationId/resolve',
      permission: 'settlement.investigation.manage', idempotent: true,
      handler: async (ctx) => {
        const id = ctx.params['investigationId'] ?? '';
        const body = (ctx.body ?? {}) as { outcome?: unknown; note?: unknown };
        if (typeof body.outcome !== 'string' || !OUTCOMES.includes(body.outcome as InvestigationOutcome) || typeof body.note !== 'string') {
          throw apiError(400, {
            code: 'resolution_needs_an_outcome_and_a_note',
            whatHappened: `Resolving a case needs one of the outcomes (${OUTCOMES.join(', ')}) and a note saying what was found.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was resolved. Send an outcome and a note.',
          });
        }
        const inv = (await deps.investigations(ctx.tenantId)).find((i) => i.investigationId === id);
        if (inv === undefined) throw notFound(`investigation ${id}`);

        const result = resolveInvestigation({ investigation: inv, outcome: body.outcome as InvestigationOutcome, note: body.note, resolvedBy: ctx.userId, at: deps.now() });
        if (!result.resolved) {
          throw apiError(422, {
            code: result.refusedBecause!,
            whatHappened: result.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: result.refusedBecause === 'write_off_needs_a_second_person'
              ? 'A write-off is a financial decision — have someone other than the person who raised it resolve it.'
              : 'Nothing was resolved. A close needs an outcome and a note, and a case can only be closed once.',
          });
        }

        await deps.recordInvestigationResolved(ctx.tenantId, result.investigation);
        return { status: 200, body: { investigationId: id, state: 'resolved', outcome: body.outcome, feedback: result.feedback } };
      },
    },
    {
      // Open cases and their ageing — the oldest unmatched money is the least likely ever to arrive,
      // so it is reported by age, not as one total.
      api: 'API-09', method: 'GET', path: '/v1/settlement/investigations',
      permission: 'settlement.review.read',
      handler: async (ctx) => {
        const asOf = ctx.query['date'];
        if (!isDate(asOf)) {
          throw apiError(400, { code: 'ageing_needs_a_date', whatHappened: 'Ageing open cases needs ?date=YYYY-MM-DD to measure age against.', wasItSaved: 'not_saved', nextSafeAction: 'Send the date. A list reads, it never writes.' });
        }
        const all = await deps.investigations(ctx.tenantId);
        const open = all.filter((i) => i.state === 'open');
        return {
          status: 200,
          body: {
            open: open.map((i) => ({ investigationId: i.investigationId, ref: i.ref, finding: i.finding, valueMinor: i.valueMinor, ownerId: i.ownerId, dueBy: i.dueBy, openedAt: i.openedAt, evidenceCount: i.evidenceRefs.length })),
            ageing: ageInvestigations(all, asOf),
            asAt: deps.now(),
          },
        };
      },
    },
  ];
}
