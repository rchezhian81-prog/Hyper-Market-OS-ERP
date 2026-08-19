// API-04 Recall lifecycle (M10-FR-04) — initiate a recall on a batch, and close it only with evidence,
// as a DURABLE cloud record. The recall BLOCK that stops a sale at the till is already carried to every lane
// on the signed pack (a recalled product master → `recallBlock` in the pack → the POS refuses it, even
// offline); this is the other half the roadmap requires: the recall RECORD itself — who initiated it, why,
// and its closure evidence — kept centrally and **never deleted** (hard rule #6, `event BatchRecalled`).
//
// The rule is the tested `RecallRegistry` in `@sre/traceability` (the `services-run-on-their-tested-engine`
// guardrail): initiating is idempotent (a batch already under recall is one effect), a recall closes ONLY
// with an evidence reference (P-04), and closing retains the full record rather than erasing it. This file is
// the persistence + HTTP skin: the lifecycle is event-sourced (`RecallInitiated` / `RecallClosed`), so every
// initiation and closure is on the append-only record forever and the current state folds from them.
//
// Initiating/closing is gated `quality.recall.initiate` (Compliance/Owner, §28); reads are
// `quality.recall.read`. Identifying the affected customers is the lot-trace surface (M10-FR-03,
// `GET /v1/quality/lot-trace/:batchId/sold`), read alongside this.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  RecallRegistry, MissingRecallEvidenceError, RecalledBatchError,
  type RecallRecord,
} from '../../../packages/traceability/src/index';

export interface RecallDeps {
  /** The tested registry rebuilt from every recall event, in occurrence order — for the write semantics. */
  readonly registry: (tenantId: string) => Promise<RecallRegistry> | RecallRegistry;
  /** Every recall's CURRENT record (open and closed) — for the read surface. Folded from the same events. */
  readonly records: (tenantId: string) => Promise<readonly RecallRecord[]> | readonly RecallRecord[];
  /** Append a recall initiation (idempotent on the caller's key). */
  readonly recordInitiated: (tenantId: string, record: RecallRecord, key: string) => Promise<void> | void;
  /** Append a recall closure (idempotent on the caller's key). */
  readonly recordClosed: (tenantId: string, record: RecallRecord, key: string) => Promise<void> | void;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

const byUrgency = (a: RecallRecord, b: RecallRecord): number => {
  // Open recalls first (nothing is more urgent), then most-recently initiated.
  if (a.status !== b.status) return a.status === 'open' ? -1 : 1;
  return a.initiatedAt < b.initiatedAt ? 1 : a.initiatedAt > b.initiatedAt ? -1 : 0;
};

export function recallRoutes(deps: RecallDeps): readonly Route[] {
  return [
    {
      // Initiate a recall on a batch. Body: { reason }. The initiator is the authenticated caller.
      api: 'API-04', method: 'POST', path: '/v1/quality/recalls/:batchId',
      permission: 'quality.recall.initiate', idempotent: true,
      handler: async (ctx) => {
        const batchId = (ctx.params['batchId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (batchId === '' || !isStr(b['reason'])) {
          throw apiError(400, {
            code: 'not_readable_as_a_recall',
            whatHappened: 'Initiating a recall needs a batch id in the path and a plain-English reason in the body.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send { reason: "..." } with the batch id in the URL — the reason is what a person later has to justify.',
          });
        }
        const registry = await deps.registry(ctx.tenantId);
        const alreadyOpen = registry.isRecalled(batchId);
        const record = registry.initiate({ batchId, reason: b['reason'], initiatedBy: ctx.userId, at: deps.now() });
        if (alreadyOpen) {
          // Already under recall — one effect (the block is already in force); nothing new to record.
          return { status: 200, body: { recall: record, alreadyOpen: true } };
        }
        await deps.recordInitiated(ctx.tenantId, record, ctx.idempotencyKey ?? batchId);
        return { status: 201, body: { recall: record } };
      },
    },
    {
      // Close a recall — only with evidence. The record is retained, never deleted (hard rule #6).
      api: 'API-04', method: 'POST', path: '/v1/quality/recalls/:batchId/closure',
      permission: 'quality.recall.initiate', idempotent: true,
      handler: async (ctx) => {
        const batchId = (ctx.params['batchId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (batchId === '') throw notFound('recall (no batch id given)');
        const registry = await deps.registry(ctx.tenantId);
        let record: RecallRecord;
        try {
          record = registry.close({
            batchId,
            closedBy: ctx.userId,
            evidenceRef: isStr(b['evidenceRef']) ? b['evidenceRef'] : '',
            at: deps.now(),
          });
        } catch (err) {
          if (err instanceof MissingRecallEvidenceError) {
            throw apiError(422, {
              code: 'recall_needs_evidence',
              whatHappened: `The recall on batch "${batchId}" can only be closed with an evidence reference — a recall closed with nothing is a recall nobody did (M10-FR-04).`,
              wasItSaved: 'not_saved',
              nextSafeAction: 'Record where the collected/disposed stock and the customer contact are evidenced, then close.',
            });
          }
          if (err instanceof RecalledBatchError) {
            // Nothing OPEN to close — either never recalled, or already closed.
            throw apiError(409, {
              code: 'no_open_recall_to_close',
              whatHappened: `Batch "${batchId}" has no open recall to close.`,
              wasItSaved: 'not_saved',
              nextSafeAction: 'Check the batch id; a closed recall stays closed (its record is retained), and an un-recalled batch has nothing to close.',
            });
          }
          throw err;
        }
        await deps.recordClosed(ctx.tenantId, record, ctx.idempotencyKey ?? `${batchId}:close`);
        return { status: 200, body: { recall: record } };
      },
    },
    {
      // Every recall — open ones first (nothing is more urgent), then closed (evidence retained).
      api: 'API-04', method: 'GET', path: '/v1/quality/recalls',
      permission: 'quality.recall.read',
      handler: async (ctx) => {
        const all = [...(await deps.records(ctx.tenantId))].sort(byUrgency);
        return { status: 200, body: { recalls: all, count: all.length, openCount: all.filter((r) => r.status === 'open').length } };
      },
    },
    {
      // One recall record (open or closed) — evidence is retained. 404 when the batch was never recalled.
      api: 'API-04', method: 'GET', path: '/v1/quality/recalls/:batchId',
      permission: 'quality.recall.read',
      handler: async (ctx) => {
        const batchId = (ctx.params['batchId'] ?? '').trim();
        const record = (await deps.records(ctx.tenantId)).find((r) => r.batchId === batchId);
        if (record === undefined) throw notFound(`recall for batch ${batchId}`);
        return { status: 200, body: { recall: record } };
      },
    },
  ];
}
