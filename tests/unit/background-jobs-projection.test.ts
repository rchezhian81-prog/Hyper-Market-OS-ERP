import { describe, it, expect } from 'vitest';
import { projectJobs, type BackgroundJobEvent } from '../../services/platform/src/background-jobs';

// M33-FR-01 — the pure fold behind "monitor jobs" and "a failed job is visible and retryable". The projection
// is where a job's STATUS is decided; the routes only guard against it. So it is worth pinning on its own: a
// bug here makes a failed job read as succeeded, and the whole acceptance criterion silently evaporates.

const AT = (n: number): string => `2026-08-31T1${n}:00:00Z`;
const scheduled = (jobId: string, kind: string, at: string): BackgroundJobEvent => ({ jobId, change: 'scheduled', kind, by: 'u-admin', at });
const reported = (jobId: string, outcome: 'succeeded' | 'failed', at: string, error?: string): BackgroundJobEvent => ({ jobId, change: 'reported', outcome, by: 'u-runner', at, ...(error !== undefined ? { error } : {}) });
const retry = (jobId: string, at: string): BackgroundJobEvent => ({ jobId, change: 'retryRequested', by: 'u-admin', at });

describe('projectJobs — the fold that decides a job’s status', () => {
  it('an empty log is no jobs, not a phantom one', () => {
    expect(projectJobs([])).toEqual([]);
  });

  it('a scheduled job is scheduled, has run zero times, and needs no attention', () => {
    const [job] = projectJobs([scheduled('nightly-report', 'report', AT(0))]);
    expect(job).toMatchObject({ jobId: 'nightly-report', kind: 'report', status: 'scheduled', attempts: 0, retries: 0, needsAttention: false });
  });

  it('a failed run turns the job failed, keeps the error, and flags it for a person', () => {
    const [job] = projectJobs([scheduled('pack', 'settings-pack', AT(0)), reported('pack', 'failed', AT(1), 'signing key missing')]);
    expect(job).toMatchObject({ status: 'failed', attempts: 1, lastError: 'signing key missing', needsAttention: true });
  });

  it('a retry re-queues a failed job (scheduled again, retries+1) while keeping its run history', () => {
    const jobs = projectJobs([scheduled('pack', 'settings-pack', AT(0)), reported('pack', 'failed', AT(1), 'boom'), retry('pack', AT(2))]);
    expect(jobs[0]).toMatchObject({ status: 'scheduled', attempts: 1, retries: 1, needsAttention: false });
    // the error from the last run is retained until it runs again — the history is not erased by re-queueing
    expect(jobs[0]?.lastError).toBe('boom');
  });

  it('a succeeding retry clears the failure — attempts count both runs, the job no longer needs attention', () => {
    const jobs = projectJobs([
      scheduled('pack', 'settings-pack', AT(0)),
      reported('pack', 'failed', AT(1), 'boom'),
      retry('pack', AT(2)),
      reported('pack', 'succeeded', AT(3)),
    ]);
    expect(jobs[0]).toMatchObject({ status: 'succeeded', attempts: 2, retries: 1, needsAttention: false });
    expect(jobs[0]?.lastError).toBeUndefined();
  });

  it('a report for a job nobody scheduled is ignored — no phantom job is ever created', () => {
    expect(projectJobs([reported('ghost', 'failed', AT(1)), retry('ghost', AT(2))])).toEqual([]);
  });

  it('re-scheduling a known id keeps its run history rather than resetting the counters', () => {
    const jobs = projectJobs([
      scheduled('pack', 'settings-pack', AT(0)),
      reported('pack', 'failed', AT(1), 'boom'),
      scheduled('pack', 'settings-pack', AT(2)), // e.g. the idempotent re-send of the schedule POST
    ]);
    expect(jobs[0]).toMatchObject({ status: 'scheduled', attempts: 1 });
  });

  it('folds many jobs independently, one row each', () => {
    const jobs = projectJobs([
      scheduled('a', 'k', AT(0)), reported('a', 'succeeded', AT(1)),
      scheduled('b', 'k', AT(0)), reported('b', 'failed', AT(1), 'x'),
    ]);
    expect(jobs).toHaveLength(2);
    expect(jobs.find((j) => j.jobId === 'a')?.status).toBe('succeeded');
    expect(jobs.find((j) => j.jobId === 'b')?.status).toBe('failed');
  });
});
