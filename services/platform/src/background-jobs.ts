// Durable background-job registry (M33-FR-01 · §28 · M35) — the write path behind "manage settings/flags →
// schedule/monitor jobs → view history", and specifically behind the acceptance criterion **"a failed job is
// visible and retryable."** Until now the product had feature flags and settings but no jobs surface at all:
// a failed overnight job (a settings pack that would not build, a report that never ran) was invisible and
// could not be re-tried through the platform.
//
// This keeps the shop's jobs on the system, append-only (hard rule #2), folded latest-per-job:
//   • SCHEDULE a job — records it as `scheduled`. A second schedule of an id already known is refused (409),
//     because "schedule" means a new job, not a silent overwrite of a running one.
//   • REPORT a run — the runner says how the attempt went: `succeeded` or `failed` (with the error kept, so
//     the failure is diagnosable, P-08). A report for a job nobody scheduled is refused (404).
//   • RETRY a failed job — the remediation verb: only a job that is actually `failed` can be re-queued
//     (→ `scheduled`, retries+1). Retrying a job that succeeded, or one still waiting, is refused (409) —
//     there is nothing to retry.
//   • MONITOR — list every job with its status; and a dedicated FAILED view (control by exception, P-03), so
//     "a failed job is visible" is a read a person can actually make, not a promise.
//
// Writes are gated `platform.job.manage`; reads `platform.job.read`. No business transaction is posted here
// (§28), and no AI writes anything (hard rule #5).

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** The status a job is in, folded from its append-only history. */
export type JobStatus = 'scheduled' | 'succeeded' | 'failed';

/** One append-only fact about a background job. The kind says which fact; the extra fields carry its detail. */
export interface BackgroundJobEvent {
  readonly jobId: string;
  readonly change: 'scheduled' | 'reported' | 'retryRequested';
  /** Who caused it — the authorised admin or the runner, for the audit trail (P-04). */
  readonly by: string;
  readonly at: string;
  /** `scheduled` only — what kind of work this is (e.g. `settings-pack`, `nightly-report`). */
  readonly kind?: string;
  /** `scheduled` only — when it is meant to run, if not now. */
  readonly scheduledFor?: string;
  /** `reported` only — how the attempt went. */
  readonly outcome?: 'succeeded' | 'failed';
  /** `reported`+failed only — why, kept so the failure is diagnosable (P-08). */
  readonly error?: string;
}

/** A background job as monitored — the fold of its history to now. */
export interface BackgroundJob {
  readonly jobId: string;
  readonly kind: string;
  readonly status: JobStatus;
  /** Completed runs (reports) — how many times it has actually run. */
  readonly attempts: number;
  /** How many times a person re-queued it after a failure. */
  readonly retries: number;
  readonly scheduledAt: string;
  readonly scheduledFor?: string;
  readonly lastRunAt?: string;
  readonly lastError?: string;
  /** A failed job needs a person — surfaced first (P-03, control by exception). */
  readonly needsAttention: boolean;
}

interface MutableJob {
  jobId: string; kind: string; status: JobStatus; attempts: number; retries: number;
  scheduledAt: string; scheduledFor?: string; lastRunAt?: string; lastError?: string;
}

/**
 * Fold the append-only log to the CURRENT set of jobs — one per id, its latest status winning. A `reported`
 * or `retryRequested` for an id never `scheduled` is ignored (it cannot make a phantom job), the same way the
 * device registry ignores a stray status for an unregistered device.
 */
export function projectJobs(events: readonly BackgroundJobEvent[]): readonly BackgroundJob[] {
  const byId = new Map<string, MutableJob>();
  for (const e of events) {
    if (e.change === 'scheduled') {
      const existing = byId.get(e.jobId);
      // A re-schedule of a known id (the idempotent retry of the same POST) keeps its run history; a genuine
      // first schedule creates it. Either way the status returns to `scheduled`.
      byId.set(e.jobId, {
        jobId: e.jobId, kind: e.kind ?? existing?.kind ?? 'unknown', status: 'scheduled',
        attempts: existing?.attempts ?? 0, retries: existing?.retries ?? 0,
        scheduledAt: e.at, ...(e.scheduledFor !== undefined ? { scheduledFor: e.scheduledFor } : {}),
        ...(existing?.lastRunAt !== undefined ? { lastRunAt: existing.lastRunAt } : {}),
        ...(existing?.lastError !== undefined ? { lastError: existing.lastError } : {}),
      });
      continue;
    }
    const job = byId.get(e.jobId);
    if (job === undefined) continue; // no phantom jobs
    if (e.change === 'reported') {
      job.attempts += 1;
      job.lastRunAt = e.at;
      if (e.outcome === 'failed') { job.status = 'failed'; job.lastError = e.error ?? 'the job failed'; }
      else { job.status = 'succeeded'; delete job.lastError; }
    } else { // retryRequested
      job.status = 'scheduled';
      job.retries += 1;
      job.scheduledAt = e.at;
    }
  }
  return [...byId.values()].map((j) => ({
    jobId: j.jobId, kind: j.kind, status: j.status, attempts: j.attempts, retries: j.retries,
    scheduledAt: j.scheduledAt, ...(j.scheduledFor !== undefined ? { scheduledFor: j.scheduledFor } : {}),
    ...(j.lastRunAt !== undefined ? { lastRunAt: j.lastRunAt } : {}),
    ...(j.lastError !== undefined ? { lastError: j.lastError } : {}),
    needsAttention: j.status === 'failed',
  }));
}

export interface BackgroundJobsDeps {
  /** The current set of jobs, projected from the append-only log (survives restart). */
  readonly jobs: (tenantId: string) => Promise<readonly BackgroundJob[]> | readonly BackgroundJob[];
  /** Append one job fact. Idempotent on the key. */
  readonly recordJobEvent: (tenantId: string, event: BackgroundJobEvent, key: string) => Promise<void> | void;
  readonly now: () => string;
}

export function backgroundJobsRoutes(deps: BackgroundJobsDeps): readonly Route[] {
  const find = async (tenantId: string, jobId: string): Promise<BackgroundJob | undefined> =>
    (await deps.jobs(tenantId)).find((j) => j.jobId === jobId);

  return [
    {
      // MONITOR — every job with its status, and the count that need a look. Failed jobs sort FIRST
      // (control by exception, P-03) so the thing that needs doing is at the top.
      api: 'API-11', method: 'GET', path: '/v1/platform/jobs',
      permission: 'platform.job.read',
      handler: async (ctx) => {
        const jobs = await deps.jobs(ctx.tenantId);
        const ordered = [...jobs].sort((a, b) => Number(b.needsAttention) - Number(a.needsAttention));
        return { status: 200, body: { jobs: ordered, failing: jobs.filter((j) => j.needsAttention).length, asAt: deps.now() } };
      },
    },
    {
      // The exception view — ONLY the jobs that failed. "A failed job is visible" is a read a person can make.
      api: 'API-11', method: 'GET', path: '/v1/platform/jobs/failed',
      permission: 'platform.job.read',
      handler: async (ctx) => {
        const failing = (await deps.jobs(ctx.tenantId)).filter((j) => j.needsAttention);
        return { status: 200, body: { jobs: failing, asAt: deps.now() } };
      },
    },
    {
      // SCHEDULE a job. A second schedule of a known id is refused — that would silently reset a job that may
      // be mid-run; re-queueing a FAILED one is what `retry` is for.
      api: 'API-11', method: 'POST', path: '/v1/platform/jobs',
      permission: 'platform.job.manage', idempotent: true,
      handler: async (ctx) => {
        const b = ctx.body;
        if (!isObj(b) || !isStr(b['jobId']) || !isStr(b['kind'])) {
          throw apiError(400, { code: 'not_readable_as_a_job', whatHappened: 'Scheduling a job needs { jobId, kind } (and an optional scheduledFor).', wasItSaved: 'not_saved', nextSafeAction: 'Send the job id and what kind of work it is.' });
        }
        const jobId = (b['jobId'] as string).trim();
        if (b['scheduledFor'] !== undefined && !isStr(b['scheduledFor'])) {
          throw apiError(400, { code: 'scheduled_for_not_a_time', whatHappened: 'scheduledFor must be a timestamp when given.', wasItSaved: 'not_saved', nextSafeAction: 'Send scheduledFor as an ISO time, or leave it out to run now.' });
        }
        const existing = await find(ctx.tenantId, jobId);
        if (existing !== undefined) {
          throw apiError(409, { code: 'job_already_scheduled', whatHappened: `A job called '${jobId}' already exists (status: ${existing.status}).`, wasItSaved: 'not_saved', nextSafeAction: existing.status === 'failed' ? 'Retry it instead: POST /v1/platform/jobs/' + jobId + '/retry.' : 'Use a different job id.' });
        }
        const at = deps.now();
        const event: BackgroundJobEvent = { jobId, change: 'scheduled', kind: (b['kind'] as string).trim(), by: ctx.userId, at, ...(isStr(b['scheduledFor']) ? { scheduledFor: b['scheduledFor'] } : {}) };
        await deps.recordJobEvent(ctx.tenantId, event, ctx.idempotencyKey ?? `schedule-${jobId}-${at}`);
        return { status: 201, body: { jobId, status: 'scheduled', at } };
      },
    },
    {
      // REPORT a run outcome — the runner says how the attempt went. A report for an unknown job is refused
      // (no phantom job), and the outcome must be succeeded or failed.
      api: 'API-11', method: 'POST', path: '/v1/platform/jobs/:jobId/runs',
      permission: 'platform.job.manage', idempotent: true,
      handler: async (ctx) => {
        const jobId = ctx.params['jobId'] ?? '';
        const b = ctx.body;
        const outcome = isObj(b) ? b['outcome'] : undefined;
        if (outcome !== 'succeeded' && outcome !== 'failed') {
          throw apiError(400, { code: 'outcome_not_given', whatHappened: 'A run report must say outcome: "succeeded" or "failed".', wasItSaved: 'not_saved', nextSafeAction: 'Send the outcome of the run.' });
        }
        const job = await find(ctx.tenantId, jobId);
        if (job === undefined) {
          throw apiError(404, { code: 'unknown_job', whatHappened: `There is no scheduled job called '${jobId}'.`, wasItSaved: 'not_saved', nextSafeAction: 'Schedule the job first, then report its run.' });
        }
        const at = deps.now();
        const error = outcome === 'failed' && isObj(b) && isStr(b['error']) ? (b['error'] as string) : undefined;
        const event: BackgroundJobEvent = { jobId, change: 'reported', outcome, by: ctx.userId, at, ...(error !== undefined ? { error } : {}) };
        await deps.recordJobEvent(ctx.tenantId, event, ctx.idempotencyKey ?? `run-${jobId}-${at}`);
        return { status: 200, body: { jobId, status: outcome, at } };
      },
    },
    {
      // RETRY — re-queue a FAILED job. Only a failed job can be retried: there is nothing to retry on one that
      // succeeded or is still waiting, and saying so (409) is clearer than silently re-scheduling it.
      api: 'API-11', method: 'POST', path: '/v1/platform/jobs/:jobId/retry',
      permission: 'platform.job.manage', idempotent: true,
      handler: async (ctx) => {
        const jobId = ctx.params['jobId'] ?? '';
        const job = await find(ctx.tenantId, jobId);
        if (job === undefined) {
          throw apiError(404, { code: 'unknown_job', whatHappened: `There is no job called '${jobId}' to retry.`, wasItSaved: 'not_saved', nextSafeAction: 'Schedule the job first.' });
        }
        if (job.status !== 'failed') {
          throw apiError(409, { code: 'job_not_failed', whatHappened: `Only a failed job can be retried; '${jobId}' is ${job.status}.`, wasItSaved: 'not_saved', nextSafeAction: 'Retry a job that has actually failed.' });
        }
        const at = deps.now();
        await deps.recordJobEvent(ctx.tenantId, { jobId, change: 'retryRequested', by: ctx.userId, at }, ctx.idempotencyKey ?? `retry-${jobId}-${at}`);
        return { status: 200, body: { jobId, status: 'scheduled', retries: job.retries + 1, at } };
      },
    },
  ];
}
