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
import { apiError } from '../../kernel/src/index';
import {
  importSettlementBatch, reviewSettlement,
  type SettlementBatch,
} from '../../../packages/settlement/src/settlement';
import type { PosTender, SettlementLine } from '../../../packages/reconciliation/src/reconciliation';

export type { SettlementBatch } from '../../../packages/settlement/src/settlement';
export type { PosTender, SettlementLine } from '../../../packages/reconciliation/src/reconciliation';

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
  readonly now: () => string;
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
  ];
}
