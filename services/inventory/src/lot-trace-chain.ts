// API-04 The whole road of a batch, and the 24-hour trace request (roadmap v2.1 D-26 · FSMA 204 · M10-FR-03 · P-08).
//
//   • GET  /v1/quality/lot-trace/:batchId/chain — ONE call: supplier → goods receipt → transfers → production → sales, all
//     folded from what head office stored, as rows and as a CSV sorted by the column asked for (`?sort=`).
//   • POST /v1/quality/lot-trace/requests/:requestId — someone (an inspector, a supplier's recall notice) asks for a trace;
//     the clock starts: it must be answered within 24 hours.
//   • POST /v1/quality/lot-trace/requests/:requestId/answer — the trace is built from the stored facts at that moment and
//     handed over; the answer keeps the CSV's SHA-256, so the file given is the file on record.
//   • GET  /v1/quality/lot-trace/requests — every request and where it stands. One not answered within 24 hours raises a
//     CRITICAL exception, shown here by name (and kept on the answer when it came late) — never silent.
//
// The engine is `packages/quality/src/lot-trace-chain.ts`; this file only validates, stores and replies. Append-only: a
// request and its answer are each recorded once and never edited (hard rules #2, #6).

import { createHash } from 'node:crypto';
import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  buildLotTraceChain, traceCsv, traceDueAt, traceRequestStanding, TRACE_SORTS, TRACE_CSV_COLUMNS,
  type TraceReceipt, type TraceTransfer, type TraceProducedBy, type ProductionUse, type TraceRequest, type TraceAnswer, type TraceSort,
} from '../../../packages/quality/src/lot-trace-chain';
import type { OutboundLotRecord } from '../../../packages/quality/src/lot-trace';

/** The stored facts about one batch, from head office's own registers. */
export interface LotTraceFacts {
  readonly receipts: readonly TraceReceipt[];
  readonly producedBy: readonly TraceProducedBy[];
  readonly transfers: readonly TraceTransfer[];
  readonly usedIn: ProductionUse;
  readonly sales: readonly OutboundLotRecord[];
}

export interface LotTraceChainDeps {
  readonly facts: (tenantId: string, batchId: string) => Promise<LotTraceFacts>;
  readonly requests: (tenantId: string) => Promise<readonly TraceRequest[]>;
  readonly recordRequest: (tenantId: string, request: TraceRequest) => Promise<void>;
  readonly answers: (tenantId: string) => Promise<readonly TraceAnswer[]>;
  readonly recordAnswer: (tenantId: string, answer: TraceAnswer) => Promise<void>;
  readonly now: () => string;
}

const text = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() !== '' && v.trim().length <= max ? v.trim() : undefined);
const BATCH = /^[A-Za-z0-9._/-]{1,40}$/;

async function chainFor(deps: LotTraceChainDeps, tenantId: string, batchId: string) {
  const facts = await deps.facts(tenantId, batchId);
  return buildLotTraceChain({ batchId, ...facts });
}

export function lotTraceChainRoutes(deps: LotTraceChainDeps): readonly Route[] {
  return [
    {
      api: 'API-04', method: 'GET', path: '/v1/quality/lot-trace/:batchId/chain',
      permission: 'quality.lottrace.read',
      handler: async (ctx) => {
        const batchId = (ctx.params['batchId'] ?? '').trim();
        if (!BATCH.test(batchId)) {
          throw apiError(400, { code: 'lot_trace_needs_batch', whatHappened: 'Name the batch as printed (up to 40 letters, digits, dots, dashes or slashes).', wasItSaved: 'not_saved', nextSafeAction: 'Call /v1/quality/lot-trace/<batch>/chain.' });
        }
        const sort = (ctx.query['sort'] ?? 'date') as TraceSort;
        if (!TRACE_SORTS.includes(sort)) {
          throw apiError(400, { code: 'lot_trace_sort_unknown', whatHappened: `sort must be one of ${TRACE_SORTS.join(', ')}.`, wasItSaved: 'not_saved', nextSafeAction: 'Send ?sort=date (the default) or another column.' });
        }
        const chain = await chainFor(deps, ctx.tenantId, batchId);
        return { status: 200, body: { ...chain, sortedBy: sort, columns: TRACE_CSV_COLUMNS, csv: traceCsv(chain, sort) } };
      },
    },
    {
      api: 'API-04', method: 'POST', path: '/v1/quality/lot-trace/requests/:requestId',
      permission: 'quality.lottrace.request', idempotent: true,
      handler: async (ctx) => {
        const requestId = (ctx.params['requestId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const batchId = typeof b['batchId'] === 'string' && BATCH.test(b['batchId'].trim()) ? b['batchId'].trim() : undefined;
        const askedBy = text(b['askedBy'], 120);
        const reason = text(b['reason'], 500);
        if (!/^[A-Za-z0-9._-]{1,60}$/.test(requestId) || batchId === undefined || askedBy === undefined || reason === undefined) {
          throw apiError(400, {
            code: 'not_readable_as_a_trace_request',
            whatHappened: 'A trace request needs its id in the path, the batch, who asked for it (askedBy) and why (reason).',
            wasItSaved: 'not_saved', nextSafeAction: 'Send { batchId, askedBy, reason }. Nothing was recorded.',
          });
        }
        const held = (await deps.requests(ctx.tenantId)).find((r) => r.requestId === requestId);
        if (held !== undefined) {
          if (held.batchId === batchId && held.askedBy === askedBy && held.reason === reason) return { status: 200, body: { request: held, alreadyRecorded: true } };
          throw apiError(409, { code: 'trace_request_already_recorded', whatHappened: `Trace request ${requestId} is already recorded for batch ${held.batchId}.`, wasItSaved: 'not_saved', nextSafeAction: 'Use a new request id. Nothing was changed.' });
        }
        const requestedAt = deps.now();
        const request: TraceRequest = { requestId, batchId, askedBy, reason, requestedAt, recordedBy: ctx.userId, dueAt: traceDueAt(requestedAt) };
        await deps.recordRequest(ctx.tenantId, request);
        return { status: 201, body: { request, detail: `Answer by ${request.dueAt} — 24 hours. After that it is raised as a critical exception.` } };
      },
    },
    {
      api: 'API-04', method: 'POST', path: '/v1/quality/lot-trace/requests/:requestId/answer',
      permission: 'quality.lottrace.request', idempotent: true,
      handler: async (ctx) => {
        const requestId = (ctx.params['requestId'] ?? '').trim();
        const request = (await deps.requests(ctx.tenantId)).find((r) => r.requestId === requestId);
        if (request === undefined) throw notFound(`trace request ${requestId}`);
        const chain = await chainFor(deps, ctx.tenantId, request.batchId);
        const csv = traceCsv(chain, 'date');
        const sha = createHash('sha256').update(csv).digest('hex');
        const prior = (await deps.answers(ctx.tenantId)).find((a) => a.requestId === requestId);
        if (prior !== undefined) {
          // Answered once, kept once: the record stands; the trace as it is now is given again for convenience.
          return { status: 200, body: { request, answer: prior, alreadyAnswered: true, ...traceRequestStanding(request, prior, deps.now()), chain, csv } };
        }
        const answer: TraceAnswer = { requestId, answeredAt: deps.now(), answeredBy: ctx.userId, rowCount: chain.rows.length, gapCount: chain.gaps.length, csvSha256: sha };
        await deps.recordAnswer(ctx.tenantId, answer);
        return { status: 201, body: { request, answer, ...traceRequestStanding(request, answer, deps.now()), chain, csv } };
      },
    },
    {
      api: 'API-04', method: 'GET', path: '/v1/quality/lot-trace/requests',
      permission: 'quality.lottrace.read',
      handler: async (ctx) => {
        const now = deps.now();
        const answers = new Map((await deps.answers(ctx.tenantId)).map((a) => [a.requestId, a] as const));
        const rows = [...(await deps.requests(ctx.tenantId))]
          .sort((a, b) => (a.requestedAt < b.requestedAt ? -1 : 1))
          .map((r) => ({ ...r, ...traceRequestStanding(r, answers.get(r.requestId), now), ...(answers.has(r.requestId) ? { answer: answers.get(r.requestId) } : {}) }));
        const exceptions = rows.flatMap((r) => (r.exception === undefined ? [] : [{ requestId: r.requestId, batchId: r.batchId, ...r.exception }]));
        return {
          status: 200,
          body: {
            requests: rows, exceptions,
            overdue: rows.filter((r) => r.state === 'overdue').length,
            detail: exceptions.length === 0 ? 'Every trace request was answered within 24 hours, or is still inside them.' : `${exceptions.length} trace request(s) were not answered within 24 hours.`,
          },
        };
      },
    },
  ];
}
