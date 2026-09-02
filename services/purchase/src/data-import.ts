// Bulk data import — validate & approval-gated commit (M30-FR-01/03) on the cloud API.
//
// The tested engine (`packages/import`) does the hard part: parse a delimited file, validate every row against
// a template (per-row errors with the source line, referential integrity, duplicate-for-review), reconcile a
// financial import against its declared control total, and commit ATOMICALLY under §28 maker-checker (the
// person who uploaded may never approve their own import; nothing is applied while any row has an error or the
// totals do not balance). None of it was on the API. This wires it:
//
//   • VALIDATE — a stateless preview: send the template and either the file text (parsed here) or ready rows,
//     and get back what would be applied, every error by line, the duplicates needing review, and whether a
//     financial import balances. Writes nothing.
//   • COMMIT — re-validates on the server (never trusts a client-supplied "all clear"), then commits the whole
//     job or nothing: a job with errors, that does not reconcile, without an approval, or approved by its own
//     uploader is refused (422, by reason). A committed job is a durable, append-only record — who loaded what,
//     who approved it, how many rows, and whether it reconciled — so an import is auditable and re-committing
//     the same job id is refused (409).
//   • LIST / READ — the committed import jobs (newest first), and one job in full.
//
// Validate/read gated `purchase.import.read`; commit `purchase.import.record`. Append-only (hard rule #2/#6);
// no AI commits an import (hard rule #5).

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { validateImport, commitImport, type TemplateSpec, type ValidateInput, type ImportPreview } from '../../../packages/import/src/import-job';
import { parseDelimited, MalformedFileError, MissingHeaderError } from '../../../packages/import/src/delimited';
import type { DecidedRequest } from '../../../packages/approvals/src/approvals';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isArr = (v: unknown): v is unknown[] => Array.isArray(v);

/** A committed import job — the durable, append-only record of one approved, reconciled load. */
export interface ImportCommitRecord {
  readonly jobId: string;
  readonly templateId: string;
  readonly domain: string;
  readonly uploadedBy: string;
  readonly approvedBy: string;
  readonly rowsApplied: number;
  readonly sumMinor?: number;
  readonly reconciles?: boolean;
  readonly at: string;
  /** The rows that were applied — the import truth, kept for audit/re-projection. */
  readonly rows: readonly Readonly<Record<string, string>>[];
}

export interface DataImportDeps {
  readonly commits: (tenantId: string) => Promise<readonly ImportCommitRecord[]> | readonly ImportCommitRecord[];
  readonly recordCommit: (tenantId: string, record: ImportCommitRecord, key: string) => Promise<void> | void;
  readonly now: () => string;
}

/** Read a TemplateSpec off the request. Only the shape the engine needs is checked here. */
function readTemplate(v: unknown): TemplateSpec | undefined {
  if (!isObj(v) || !isStr(v['id']) || !isStr(v['domain']) || !isArr(v['columns']) || !isArr(v['keyColumns'])) return undefined;
  if (!v['columns'].every((c) => isObj(c) && isStr((c as Record<string, unknown>)['name']) && isStr((c as Record<string, unknown>)['type']))) return undefined;
  if (!v['keyColumns'].every((k) => typeof k === 'string')) return undefined;
  return v as unknown as TemplateSpec;
}

/** Build the engine's ValidateInput from a request body — from `text` (parsed here) or ready `rows`. */
function readValidateInput(b: Record<string, unknown>): { input: ValidateInput } | { error: ReturnType<typeof apiError> } {
  const template = readTemplate(b['template']);
  if (template === undefined) {
    return { error: apiError(400, { code: 'not_readable_as_a_template', whatHappened: 'An import needs a { template } with { id, domain, columns[{name,type}], keyColumns[] }.', wasItSaved: 'not_saved', nextSafeAction: 'Send the template that describes the file.' }) };
  }
  let rows: readonly Readonly<Record<string, string>>[];
  let lineNumbers: readonly number[];
  if (isStr(b['text'])) {
    try {
      const parsed = parseDelimited(b['text'] as string, { ...(isStr(b['delimiter']) ? { delimiter: b['delimiter'] as string } : {}) });
      rows = parsed.rows;
      lineNumbers = parsed.lineNumbers;
    } catch (e) {
      if (e instanceof MalformedFileError || e instanceof MissingHeaderError) {
        return { error: apiError(400, { code: 'file_malformed', whatHappened: e.message, wasItSaved: 'not_saved', nextSafeAction: 'Fix the file so every row has the header’s columns, then send it again.' }) };
      }
      throw e;
    }
  } else if (isArr(b['rows']) && (b['rows'] as unknown[]).every(isObj)) {
    rows = b['rows'] as readonly Readonly<Record<string, string>>[];
    lineNumbers = isArr(b['lineNumbers']) && (b['lineNumbers'] as unknown[]).every((n) => typeof n === 'number')
      ? (b['lineNumbers'] as number[])
      : rows.map((_, i) => i + 2);
  } else {
    return { error: apiError(400, { code: 'no_rows_to_import', whatHappened: 'Send either the file { text } or the parsed { rows }.', wasItSaved: 'not_saved', nextSafeAction: 'Attach the data to import.' }) };
  }
  const references = isObj(b['references']) ? (b['references'] as Record<string, readonly string[]>) : undefined;
  const existingKeys = isArr(b['existingKeys']) && (b['existingKeys'] as unknown[]).every((k) => typeof k === 'string') ? (b['existingKeys'] as string[]) : undefined;
  const declaredTotalMinor = typeof b['declaredTotalMinor'] === 'number' ? (b['declaredTotalMinor'] as number) : undefined;
  return {
    input: {
      template, rows, lineNumbers,
      ...(references !== undefined ? { references } : {}),
      ...(existingKeys !== undefined ? { existingKeys } : {}),
      ...(declaredTotalMinor !== undefined ? { declaredTotalMinor } : {}),
    },
  };
}

const REFUSAL_MESSAGE: Record<string, string> = {
  has_errors: 'the file still has row errors — fix them and validate again',
  nothing_to_import: 'there are no valid rows to import',
  does_not_reconcile: 'the rows do not add up to the declared control total',
  not_approved: 'this import has not been approved (a valid owner approval for this job is required)',
  self_approved: 'the person who uploaded an import may not approve their own (§28)',
};

const summary = (r: ImportCommitRecord) => ({
  jobId: r.jobId, templateId: r.templateId, domain: r.domain, uploadedBy: r.uploadedBy,
  approvedBy: r.approvedBy, rowsApplied: r.rowsApplied, at: r.at,
  ...(r.sumMinor !== undefined ? { sumMinor: r.sumMinor } : {}),
  ...(r.reconciles !== undefined ? { reconciles: r.reconciles } : {}),
});

export function dataImportRoutes(deps: DataImportDeps): readonly Route[] {
  return [
    {
      // VALIDATE — a stateless preview. Writes nothing; POST because the file is a body, not a query.
      api: 'API-03', method: 'POST', path: '/v1/import/validate',
      permission: 'purchase.import.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const read = readValidateInput(b);
        if ('error' in read) throw read.error;
        return { status: 200, body: { preview: validateImport(read.input) } };
      },
    },
    {
      // COMMIT — re-validate on the server, then commit atomically under §28 or refuse the whole job.
      api: 'API-03', method: 'POST', path: '/v1/import/commit',
      permission: 'purchase.import.record', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isStr(b['jobId'])) {
          throw apiError(400, { code: 'no_job_id', whatHappened: 'An import commit needs a { jobId } that the approval refers to.', wasItSaved: 'not_saved', nextSafeAction: 'Send the job id.' });
        }
        const jobId = (b['jobId'] as string).trim();
        if (!isObj(b['approval']) || !isStr((b['approval'] as Record<string, unknown>)['decidedBy']) || !isStr((b['approval'] as Record<string, unknown>)['status'])) {
          throw apiError(400, { code: 'no_approval', whatHappened: 'An import commit needs an { approval } with { decidedBy, status } — nothing is applied without it (§28).', wasItSaved: 'not_saved', nextSafeAction: 'Have the owner (not the uploader) approve the job, then commit.' });
        }
        const read = readValidateInput(b);
        if ('error' in read) throw read.error;
        const preview: ImportPreview = validateImport(read.input);

        const uploadedBy = isStr(b['uploadedBy']) ? (b['uploadedBy'] as string).trim() : ctx.userId;
        const ab = b['approval'] as Record<string, unknown>;
        // The approval the checker recorded. The tested engine gates on status / subjectRef / decidedBy; the
        // rest is carried for a complete, auditable maker-checker fact. subjectRef is fixed to the job id here
        // so a client cannot point an approval for one job at another.
        const approval: DecidedRequest = {
          id: isStr(ab['id']) ? (ab['id'] as string) : `imp-approval-${jobId}`,
          subjectType: 'data_import',
          subjectRef: jobId,
          requestedBy: uploadedBy,
          branchId: null,
          value: null,
          status: ab['status'] as DecidedRequest['status'],
          decidedBy: (ab['decidedBy'] as string).trim(),
          reason: isStr(ab['reason']) ? (ab['reason'] as string).trim() : 'bulk import approved',
          decidedAt: isStr(ab['decidedAt']) ? (ab['decidedAt'] as string) : deps.now(),
        };

        // Committing the same job twice is refused — an import job commits once.
        if ((await deps.commits(ctx.tenantId)).some((c) => c.jobId === jobId)) {
          throw apiError(409, { code: 'import_already_committed', whatHappened: `Import job '${jobId}' has already been committed.`, wasItSaved: 'not_saved', nextSafeAction: 'A new load is a new job id.' });
        }

        // The engine is the single gate: errors / reconciliation / approval / §28 all refuse the WHOLE job.
        const result = commitImport({ preview, uploadedBy, approval, jobId }, () => { /* the durable apply is the append below */ });
        if (!result.committed) {
          throw apiError(422, { code: `import_refused_${result.refusal}`, whatHappened: `The import was not committed: ${REFUSAL_MESSAGE[result.refusal ?? ''] ?? result.refusal}.`, wasItSaved: 'not_saved', nextSafeAction: 'Nothing was applied. Address the reason and commit again.' });
        }

        const at = deps.now();
        const record: ImportCommitRecord = {
          jobId, templateId: read.input.template.id, domain: read.input.template.domain,
          uploadedBy, approvedBy: approval.decidedBy, rowsApplied: result.rowsApplied,
          ...(preview.sumMinor !== undefined ? { sumMinor: preview.sumMinor } : {}),
          ...(preview.reconciles !== undefined ? { reconciles: preview.reconciles } : {}),
          at, rows: preview.validRows,
        };
        await deps.recordCommit(ctx.tenantId, record, ctx.idempotencyKey ?? `import-${jobId}-${at}`);
        return { status: 200, body: { jobId, committed: true, rowsApplied: result.rowsApplied, at } };
      },
    },
    {
      // LIST — the committed import jobs, newest first, with a count. Summaries only (no row payloads).
      api: 'API-03', method: 'GET', path: '/v1/import/commits',
      permission: 'purchase.import.read',
      handler: async (ctx) => {
        const all = await deps.commits(ctx.tenantId);
        const ordered = [...all].sort((a, b) => b.at.localeCompare(a.at));
        return { status: 200, body: { jobs: ordered.map(summary), total: ordered.length, asAt: deps.now() } };
      },
    },
    {
      // READ one committed job in full (including its applied rows).
      api: 'API-03', method: 'GET', path: '/v1/import/commits/:jobId',
      permission: 'purchase.import.read',
      handler: async (ctx) => {
        const job = (await deps.commits(ctx.tenantId)).find((c) => c.jobId === (ctx.params['jobId'] ?? ''));
        if (job === undefined) {
          throw apiError(404, { code: 'unknown_import_job', whatHappened: `There is no committed import job '${ctx.params['jobId'] ?? ''}'.`, wasItSaved: 'not_saved', nextSafeAction: 'Check the id against GET /v1/import/commits.' });
        }
        return { status: 200, body: { job } };
      },
    },
  ];
}
