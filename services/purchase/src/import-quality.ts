// Import job history & supplier data-quality scoring (M30-FR-04) on API-03 Purchase.
//
// `validateImport`/`commitImport` already refuse a bad file with per-row line numbers and an
// all-or-nothing commit. What was missing is the part that matters over months rather than minutes:
// **the record of what was imported, from which source, and whether the data is getting better or
// worse** — and the report that turns "88% clean" (a dashboard) into "these three suppliers cost you
// 90 hours a year and each one is a single missing column" (an email somebody sends).
//
// The rules are the tested `recordJob` / `scoreSource` / `jobHistory` / `compareSources` in
// `@sre/import` (the services-run-on-their-tested-engine guardrail). Append-only and event-sourced —
// **a job is recorded whether it SUCCEEDED or not** (hard rule #6): a history of only the successes
// is exactly how a file that fails half the time looks perfect. Recording gated
// `purchase.import.record`; the reports read `purchase.import.read`.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  scoreSource, jobHistory, compareSources,
  type ImportJobRecord, type JobOutcome, type QualityScore,
  type RowError, type RowErrorKind,
} from '../../../packages/import/src/index';

export type { ImportJobRecord } from '../../../packages/import/src/index';

const OUTCOMES: readonly JobOutcome[] = ['committed', 'refused', 'abandoned'];
const ERROR_KINDS: readonly RowErrorKind[] = [
  'missing_required', 'not_an_integer', 'not_an_amount', 'not_allowed_value', 'unknown_reference', 'duplicate_in_file',
];

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isNonNegInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isPosInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;
/** A positive integer from a query value, else the fallback — never NaN into the engine. */
const posIntOr = (v: unknown, fallback: number): number => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isInteger(n) && n > 0 ? n : fallback;
};
const isoDateOr = (v: unknown, fallback: string): string =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : fallback;

/** Validate one caller-supplied row error into a RowError, or return undefined. */
function readError(v: unknown): RowError | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const e = v as Record<string, unknown>;
  if (!isPosInt(e['line']) || !isStr(e['column']) || !ERROR_KINDS.includes(e['kind'] as RowErrorKind) || !isStr(e['message'])) {
    return undefined;
  }
  return { line: e['line'], column: e['column'], kind: e['kind'] as RowErrorKind, message: e['message'] };
}

export interface ImportQualityDeps {
  /** Every recorded import job — the history and the scores fold over these. */
  readonly jobs: (tenantId: string) => Promise<readonly ImportJobRecord[]> | readonly ImportJobRecord[];
  /** Append one job outcome — append-only, refusals kept alongside successes (hard rule #6). */
  readonly recordImportJob: (tenantId: string, jobId: string, record: ImportJobRecord, key: string) => Promise<void> | void;
  readonly now: () => string;
}

// A stable digest so a re-send of the identical outcome collapses, but a genuinely different record is a
// new fact (the fold takes the latest per jobId).
const digestOf = (r: ImportJobRecord): string =>
  [r.sourceId, r.templateId, r.fileName, r.outcome, r.totalRows, r.validRows, r.errorRows, r.duplicatesForReview, r.errors.length, r.uploadedAt].join('|');

/** The distinct source ids present in a set of jobs, in first-seen order. */
const sourcesOf = (jobs: readonly ImportJobRecord[]): readonly string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const j of jobs) if (!seen.has(j.sourceId)) { seen.add(j.sourceId); out.push(j.sourceId); }
  return out;
};

export function importQualityRoutes(deps: ImportQualityDeps): readonly Route[] {
  return [
    {
      // Record an import job outcome — a supplier/system file that was committed, refused or abandoned.
      // Refusals are recorded too (hard rule #6). Body: { sourceId, templateId, fileName, outcome, totalRows,
      // validRows, errorRows, duplicatesForReview, errors[], uploadedAt?, approvedBy?, refusalReason?,
      // sumMinor?, reconciled? }. uploadedBy is the authenticated caller.
      api: 'API-03', method: 'POST', path: '/v1/purchase/import-jobs/:jobId',
      permission: 'purchase.import.record', idempotent: true,
      handler: async (ctx) => {
        const jobId = (ctx.params['jobId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const rawErrors = b['errors'];
        const errors = Array.isArray(rawErrors) ? rawErrors.map(readError) : undefined;
        if (jobId === '' || !isStr(b['sourceId']) || !isStr(b['templateId']) || !isStr(b['fileName'])
          || !OUTCOMES.includes(b['outcome'] as JobOutcome)
          || !isNonNegInt(b['totalRows']) || !isNonNegInt(b['validRows']) || !isNonNegInt(b['errorRows'])
          || !isNonNegInt(b['duplicatesForReview'])
          || errors === undefined || errors.some((e) => e === undefined)
          || (b['uploadedAt'] !== undefined && !isStr(b['uploadedAt']))
          || (b['approvedBy'] !== undefined && !isStr(b['approvedBy']))
          || (b['refusalReason'] !== undefined && !isStr(b['refusalReason']))
          || (b['sumMinor'] !== undefined && !Number.isInteger(b['sumMinor']))
          || (b['reconciled'] !== undefined && typeof b['reconciled'] !== 'boolean')) {
          throw apiError(400, {
            code: 'not_readable_as_an_import_job',
            whatHappened: 'An import job needs a jobId in the path and { sourceId, templateId, fileName, outcome (committed/refused/abandoned), totalRows, validRows, errorRows, duplicatesForReview, errors:[{line,column,kind,message}] } — plus optional uploadedAt, approvedBy, refusalReason, sumMinor, reconciled.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Record the outcome as reported by the importer, refusals included — a history of only the successes hides a file that fails half the time.',
          });
        }
        const record: ImportJobRecord = {
          jobId, tenantId: ctx.tenantId, templateId: b['templateId'] as string, sourceId: b['sourceId'] as string,
          fileName: b['fileName'] as string, uploadedBy: ctx.userId,
          uploadedAt: isStr(b['uploadedAt']) ? (b['uploadedAt'] as string) : deps.now(),
          outcome: b['outcome'] as JobOutcome,
          totalRows: b['totalRows'], validRows: b['validRows'], errorRows: b['errorRows'],
          duplicatesForReview: b['duplicatesForReview'], errors: errors as RowError[],
          ...(isStr(b['approvedBy']) ? { approvedBy: b['approvedBy'] as string } : {}),
          ...(isStr(b['refusalReason']) ? { refusalReason: b['refusalReason'] as string } : {}),
          ...(typeof b['sumMinor'] === 'number' ? { sumMinor: b['sumMinor'] } : {}),
          ...(typeof b['reconciled'] === 'boolean' ? { reconciled: b['reconciled'] } : {}),
        };
        await deps.recordImportJob(ctx.tenantId, jobId, record, digestOf(record));
        return { status: 201, body: { jobId, sourceId: record.sourceId, outcome: record.outcome, rows: `${record.validRows}/${record.totalRows}` } };
      },
    },
    {
      // Compare every source and name the ones worth a conversation — "these three files cost you 90 hours a
      // year, each one a single column". Query: from?, to? (the window), conversationAboveHours?. STATIC path,
      // registered before /:sourceId so it is not swallowed as a source id.
      api: 'API-03', method: 'GET', path: '/v1/purchase/import-quality',
      permission: 'purchase.import.read',
      handler: async (ctx) => {
        const to = isoDateOr(ctx.query['to'], deps.now().slice(0, 10));
        const from = isoDateOr(ctx.query['from'], '1970-01-01');
        const jobs = await deps.jobs(ctx.tenantId);
        const scores = sourcesOf(jobs).map((sourceId): QualityScore => scoreSource({ sourceId, jobs, from, to }));
        const comparison = compareSources({
          scores, asAt: deps.now(),
          ...(ctx.query['conversationAboveHours'] !== undefined ? { conversationAboveHours: posIntOr(ctx.query['conversationAboveHours'], 10) } : {}),
        });
        return { status: 200, body: comparison };
      },
    },
    {
      // Score one source's data quality over a window — accepted %, band, direction, the ranked reasons and
      // the annual fix-hours cost. Query: from?, to?, previousFrom?, previousTo? (for direction), minimumRows?,
      // minutesPerRow?.
      api: 'API-03', method: 'GET', path: '/v1/purchase/import-quality/:sourceId',
      permission: 'purchase.import.read',
      handler: async (ctx) => {
        const sourceId = ctx.params['sourceId'] ?? '';
        const to = isoDateOr(ctx.query['to'], deps.now().slice(0, 10));
        const from = isoDateOr(ctx.query['from'], '1970-01-01');
        const jobs = await deps.jobs(ctx.tenantId);
        // A previous window is optional — supplied only when the caller wants a direction (improving/worsening).
        const previous = isoDateOr(ctx.query['previousFrom'], '') !== '' && isoDateOr(ctx.query['previousTo'], '') !== ''
          ? jobs.filter((j) => j.uploadedAt >= isoDateOr(ctx.query['previousFrom'], '') && j.uploadedAt <= `${isoDateOr(ctx.query['previousTo'], '')}T23:59:59Z`)
          : undefined;
        const score = scoreSource({
          sourceId, jobs, from, to,
          ...(previous !== undefined ? { previous } : {}),
          ...(ctx.query['minimumRows'] !== undefined ? { minimumRows: posIntOr(ctx.query['minimumRows'], 100) } : {}),
          ...(ctx.query['minutesPerRow'] !== undefined ? { minutesPerRow: posIntOr(ctx.query['minutesPerRow'], 2) } : {}),
        });
        return { status: 200, body: score };
      },
    },
    {
      // The job history somebody actually reads — refusals included, newest first. Query: sourceId?,
      // templateId?, limit?.
      api: 'API-03', method: 'GET', path: '/v1/purchase/import-jobs',
      permission: 'purchase.import.read',
      handler: async (ctx) => {
        const jobs = await deps.jobs(ctx.tenantId);
        const rows = jobHistory({
          jobs,
          ...(isStr(ctx.query['sourceId']) ? { sourceId: ctx.query['sourceId'] } : {}),
          ...(isStr(ctx.query['templateId']) ? { templateId: ctx.query['templateId'] } : {}),
          ...(ctx.query['limit'] !== undefined ? { limit: posIntOr(ctx.query['limit'], 50) } : {}),
        });
        return { status: 200, body: { jobs: rows, count: rows.length } };
      },
    },
  ];
}
