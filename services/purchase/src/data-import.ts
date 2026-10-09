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
//
// SF-06-a (Wave 4 · OB-23 "C"): the template, its reference lists and its target are head office's OWN
// (`import-templates.ts`) — a template id head office does not support is refused, a body carrying its own reference
// or "already exists" lists is refused, the target module's rules are run at validate AND at commit, and an approved
// load writes the real records (a captured supplier invoice) in the SAME atomic save as the job's record. A committed
// load can be ROLLED BACK by compensating records once a second person approves it, while nothing downstream uses it.

import type { Route } from '../../kernel/src/index';
import { apiError, requireActorIsCaller } from '../../kernel/src/index';
import { fingerprintOf, namedSecondPersonRefusal, openApproval, type ApprovalPort, NO_APPROVALS } from '../../identity/src/approval-requests';
import { validateImport, commitImport, type ValidateInput, type ImportPreview } from '../../../packages/import/src/import-job';
import { parseDelimited, MalformedFileError, MissingHeaderError } from '../../../packages/import/src/delimited';
import type { DecidedRequest } from '../../../packages/approvals/src/approvals';
import { effectRef, templateView, type RegisteredTemplate, type ImportEffect, type ImportEffectRef } from './import-templates';

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
  /** The real records the load wrote (SF-06-a) — absent on a job committed before targets existed (it wrote none). */
  readonly effects?: readonly ImportEffectRef[];
  /** Set when the load was rolled back (folded from its `ImportRolledBack` record — the commit itself is never changed). */
  readonly rolledBack?: ImportRollbackRecord;
}

/** A rollback (M30-FR-04): compensating records for every effect, approved by a second person. Append-only. */
export interface ImportRollbackRecord {
  readonly jobId: string;
  readonly requestedBy: string;
  readonly approvedBy: string;
  readonly reason: string;
  readonly at: string;
  readonly effects: readonly ImportEffectRef[];
}

export interface DataImportDeps {
  readonly commits: (tenantId: string) => Promise<readonly ImportCommitRecord[]> | readonly ImportCommitRecord[];
  /** Write the job's record AND the real records it applies, in ONE atomic save (SF-06-a). */
  readonly recordCommit: (tenantId: string, record: ImportCommitRecord, key: string, effects: readonly ImportEffect[]) => Promise<void> | void;
  /** Write the rollback's record AND its compensating records, in ONE atomic save. */
  readonly recordRollback?: (tenantId: string, record: ImportRollbackRecord) => Promise<void> | void;
  /** The templates head office supports — the ONLY ones an import may use. Empty on a bare stub: then every import is refused. */
  readonly templates?: readonly RegisteredTemplate[];
  /** The permissions a named user holds — the uploader must also hold the target module's own permission. */
  readonly permissionsOfUser?: (tenantId: string, userId: string) => Promise<readonly string[] | undefined> | readonly string[] | undefined;
  readonly now: () => string;
  /** Head office's maker-checker engine (ADR-0024): the import's checker approves in their own session. Optional on a
   *  bare stub (then every approval is unknown); the running system provides it. */
  readonly approvals?: ApprovalPort;
}


/** What an import's approval is for (ADR-0024): the template, every row and the declared total — change any of them
 *  and the approval no longer matches. Returned by validate, asked for by the maker, recomputed at commit. */
export function importContentFingerprint(input: ValidateInput): string {
  return fingerprintOf({ template: input.template, rows: input.rows, declaredTotalMinor: input.declaredTotalMinor ?? null });
}

/** The template head office supports for this request — named by `templateId` or `template.id`; the caller's column
 *  list is never used (the screen sends it for display only). */
function readTemplate(b: Record<string, unknown>, templates: readonly RegisteredTemplate[]): RegisteredTemplate {
  const named = isStr(b['templateId']) ? (b['templateId'] as string) : isObj(b['template']) && isStr(b['template']['id']) ? (b['template']['id'] as string) : undefined;
  if (named === undefined) {
    throw apiError(400, { code: 'not_readable_as_a_template', whatHappened: 'An import names the template it uses ({ templateId }).', wasItSaved: 'not_saved', nextSafeAction: `Name one of the supported templates: ${templates.map((t) => t.spec.id).join(', ') || 'none yet'}.` });
  }
  const found = templates.find((t) => t.spec.id === named.trim());
  if (found === undefined) {
    throw apiError(422, {
      code: 'import_template_not_supported',
      whatHappened: `Head office cannot load "${named}": it has no rules or target for it, so nothing could really be applied.`,
      wasItSaved: 'not_saved',
      nextSafeAction: `Use a supported template (${templates.map((t) => t.spec.id).join(', ') || 'none yet'}). Nothing was saved.`,
    });
  }
  return found;
}

/** Build the engine's ValidateInput from a request body — from `text` (parsed here) or ready `rows`. The references and
 *  the "already exists" lists are head office's own; a body that brings its own is refused by name. */
function readValidateInput(b: Record<string, unknown>, template: RegisteredTemplate): { input: ValidateInput } | { error: ReturnType<typeof apiError> } {
  if (b['references'] !== undefined || b['existingKeys'] !== undefined) {
    return { error: apiError(400, { code: 'import_carries_caller_claims', whatHappened: 'The request brings its own list of what exists. Head office checks every row against its own registers — never against a list the sender supplies.', wasItSaved: 'not_saved', nextSafeAction: 'Send only the template id, the file and the declared total.' }) };
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
  const declaredTotalMinor = typeof b['declaredTotalMinor'] === 'number' ? (b['declaredTotalMinor'] as number) : undefined;
  return { input: { template: template.spec, rows, lineNumbers, ...(declaredTotalMinor !== undefined ? { declaredTotalMinor } : {}) } };
}

/** The engine's preview over head office's own references, with the target module's rules folded in: a row the target
 *  refuses is an error row like any other, and the counts, total and readiness are recomputed from what is left. */
async function previewOf(template: RegisteredTemplate, tenantId: string, input: ValidateInput): Promise<ImportPreview> {
  const base = validateImport({ ...input, references: await template.references(tenantId) });
  const extra = await template.check(tenantId, input.rows, input.lineNumbers, input.declaredTotalMinor);
  if (extra.length === 0) return base;
  const errors = [...base.errors, ...extra].sort((a, b) => a.line - b.line);
  const badLines = new Set(errors.map((e) => e.line));
  const validRows = input.rows.filter((_, i) => !badLines.has(input.lineNumbers[i] ?? i + 2)).map((r) => ({ ...r }));
  const sumMinor = template.spec.amountColumn === undefined ? undefined : validRows.reduce((s, r) => s + Number(r[template.spec.amountColumn!] ?? 0), 0);
  const reconciles = sumMinor !== undefined && input.declaredTotalMinor !== undefined ? sumMinor === input.declaredTotalMinor : undefined;
  return {
    ...base, errors, validRows, validCount: validRows.length,
    errorRowCount: input.rows.filter((_, i) => badLines.has(input.lineNumbers[i] ?? i + 2)).length,
    ...(sumMinor !== undefined ? { sumMinor } : {}),
    ...(reconciles !== undefined ? { reconciles } : {}),
    commitReady: false,
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
  ...(r.effects !== undefined ? { effects: r.effects } : {}),
  ...(r.rolledBack !== undefined ? { rolledBack: { at: r.rolledBack.at, requestedBy: r.rolledBack.requestedBy, approvedBy: r.rolledBack.approvedBy, reason: r.rolledBack.reason } } : {}),
  ...(r.sumMinor !== undefined ? { sumMinor: r.sumMinor } : {}),
  ...(r.reconciles !== undefined ? { reconciles: r.reconciles } : {}),
});

export function dataImportRoutes(deps: DataImportDeps): readonly Route[] {
  const templates = deps.templates ?? [];
  return [
    {
      // The templates head office supports — what the screen may offer. Nothing else can be loaded.
      api: 'API-03', method: 'GET', path: '/v1/import/templates',
      permission: 'purchase.import.read',
      handler: async () => ({ status: 200, body: { templates: templates.map(templateView) } }),
    },
    {
      // VALIDATE — a stateless preview. Writes nothing; POST because the file is a body, not a query.
      api: 'API-03', method: 'POST', path: '/v1/import/validate',
      permission: 'purchase.import.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const template = readTemplate(b, templates);
        const read = readValidateInput(b, template);
        if ('error' in read) throw read.error;
        // The content fingerprint is what the maker asks approval FOR (ADR-0024) — the commit recomputes it from the file.
        return { status: 200, body: { preview: await previewOf(template, ctx.tenantId, read.input), contentFingerprint: importContentFingerprint(read.input) } };
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
        // The uploader (maker) is the signed-in caller — never a body value (ADR-0024 · audit PA-03). The checker is an
        // approval they gave in their own session, for THIS job and THIS content; a typed checker is refused.
        requireActorIsCaller(ctx, b, 'uploadedBy');
        const uploadedBy = ctx.userId;
        if (!isStr(b['approvalId'])) {
          const named = isObj(b['approval']) ? (b['approval'] as Record<string, unknown>)['decidedBy'] : undefined;
          if (isStr(named)) throw namedSecondPersonRefusal('approval.decidedBy', named as string);
          throw apiError(422, { code: 'no_approval', whatHappened: 'An import changes nothing until a second person approves it (M30-FR-01, §28).', wasItSaved: 'not_saved', nextSafeAction: 'Ask for approval (POST /v1/approvals/requests, kind data_import_commit, with the jobId and the content fingerprint validate returned); once the owner approves, commit with the approvalId.' });
        }
        const template = readTemplate(b, templates);
        const read = readValidateInput(b, template);
        if ('error' in read) throw read.error;
        // The uploader also needs the target module's own authority — loading invoices is capturing invoices.
        if (!(((await deps.permissionsOfUser?.(ctx.tenantId, uploadedBy)) ?? []).includes(template.makerPermission))) {
          throw apiError(403, { code: 'import_target_not_permitted', whatHappened: `Loading "${template.label}" writes records only a person with "${template.makerPermission}" may write, and you do not hold it.`, wasItSaved: 'not_saved', nextSafeAction: 'Ask someone who may do this work by hand to load the file. Nothing was saved.' });
        }
        const preview: ImportPreview = await previewOf(template, ctx.tenantId, read.input);

        const opened = await openApproval(deps.approvals ?? NO_APPROVALS, {
          tenantId: ctx.tenantId, approvalId: (b['approvalId'] as string).trim(), kind: 'data_import_commit', subjectRef: jobId,
          details: { jobId, contentFingerprint: importContentFingerprint(read.input) }, valueMinor: null,
          maker: uploadedBy, usedBy: `import-${jobId}`, now: deps.now(),
        });
        // The engine's own approval record, built from the checker's decision — the tested engine still gates on it.
        const approval: DecidedRequest = {
          id: (b['approvalId'] as string).trim(), subjectType: 'data_import', subjectRef: jobId, requestedBy: uploadedBy, branchId: null,
          value: null, status: opened.decision.decision, decidedBy: opened.decision.decidedBy, reason: opened.decision.reason, decidedAt: opened.decision.decidedAt,
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
        // Every rule passed: the approval is spent — once — and only then is the import applied.
        await opened.spend();

        const at = deps.now();
        const effects = await template.effects(ctx.tenantId, preview.validRows, { jobId, uploadedBy, approvedBy: approval.decidedBy, approvedAt: approval.decidedAt ?? at, at });
        const record: ImportCommitRecord = {
          jobId, templateId: read.input.template.id, domain: read.input.template.domain,
          uploadedBy, approvedBy: approval.decidedBy, rowsApplied: result.rowsApplied,
          ...(preview.sumMinor !== undefined ? { sumMinor: preview.sumMinor } : {}),
          ...(preview.reconciles !== undefined ? { reconciles: preview.reconciles } : {}),
          at, rows: preview.validRows, effects: effects.map(effectRef),
        };
        // Keyed by the JOB, not the request: an import job commits once, so two commits of one job racing on the same
        // approval (the same action — the engine lets it retry after a lost write) land ONE record, never a second. The
        // real records go in the same save — a job record with no target, or a target with no job, cannot exist.
        await deps.recordCommit(ctx.tenantId, record, `job-${jobId}`, effects);
        return { status: 200, body: { jobId, committed: true, rowsApplied: result.rowsApplied, effects: record.effects, at } };
      },
    },
    {
      // ROLLBACK (M30-FR-04) — undo a committed load by compensating records, once a SECOND person approved it in their
      // own session (kind data_import_rollback). Refused while anything downstream already uses what it wrote.
      api: 'API-03', method: 'POST', path: '/v1/import/commits/:jobId/rollback',
      permission: 'purchase.import.record', idempotent: true,
      handler: async (ctx) => {
        const jobId = (ctx.params['jobId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const job = (await deps.commits(ctx.tenantId)).find((c) => c.jobId === jobId);
        if (job === undefined) {
          throw apiError(404, { code: 'unknown_import_job', whatHappened: `There is no committed import job '${jobId}'.`, wasItSaved: 'not_saved', nextSafeAction: 'Check the id against GET /v1/import/commits.' });
        }
        if (job.rolledBack !== undefined) {
          throw apiError(409, { code: 'import_already_rolled_back', whatHappened: `Import job '${jobId}' was already rolled back on ${job.rolledBack.at}.`, wasItSaved: 'not_saved', nextSafeAction: 'Nothing to undo.' });
        }
        const template = templates.find((t) => t.spec.id === job.templateId);
        if (template === undefined || job.effects === undefined || deps.recordRollback === undefined) {
          throw apiError(422, { code: 'import_not_reversible', whatHappened: `Import job '${jobId}' wrote no records head office can undo (it was committed before loads wrote real records, or its template is no longer supported).`, wasItSaved: 'not_saved', nextSafeAction: 'Correct the affected records by hand, each through its own screen.' });
        }
        if (!isStr(b['reason'])) {
          throw apiError(400, { code: 'reason_required', whatHappened: 'A rollback says why.', wasItSaved: 'not_saved', nextSafeAction: 'Send { reason, approvalId }.' });
        }
        if (!isStr(b['approvalId'])) {
          throw apiError(422, { code: 'no_approval', whatHappened: 'A rollback changes nothing until a second person approves it (M30-FR-04, §28).', wasItSaved: 'not_saved', nextSafeAction: 'Ask for approval (kind data_import_rollback, subject the job id); once approved, send the approvalId.' });
        }
        const blocked = await template.blocksRollback(ctx.tenantId, job.effects);
        if (blocked.length > 0) {
          throw apiError(409, { code: 'import_effect_in_use', whatHappened: `Import job '${jobId}' cannot be undone: ${blocked.join('; ')}.`, wasItSaved: 'not_saved', nextSafeAction: 'Correct it through the record that uses it (for an invoice, a debit or credit note). Nothing was changed.' });
        }
        const opened = await openApproval(deps.approvals ?? NO_APPROVALS, {
          tenantId: ctx.tenantId, approvalId: (b['approvalId'] as string).trim(), kind: 'data_import_rollback', subjectRef: jobId,
          details: { jobId }, valueMinor: null, maker: ctx.userId, usedBy: `import-rollback-${jobId}`, now: deps.now(),
        });
        await opened.spend();
        const record: ImportRollbackRecord = {
          jobId, requestedBy: ctx.userId, approvedBy: opened.decision.decidedBy, reason: (b['reason'] as string).trim(), at: deps.now(), effects: job.effects,
        };
        await deps.recordRollback(ctx.tenantId, record);
        return { status: 200, body: { jobId, rolledBack: true, effects: job.effects, at: record.at } };
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
