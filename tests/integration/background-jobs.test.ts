import { describe, it, expect } from 'vitest';
import { apiHarness } from '../support/api-harness';

/**
 * **Durable background-job registry — a failed job is visible and retryable, end to end (M33-FR-01, API-11).**
 *
 * The platform now has a jobs surface: an admin schedules a job, the runner reports how each run went, and a
 * FAILED job is both visible (a monitor read + a dedicated failed view) and retryable (re-queued, only when it
 * actually failed). Durable and append-only, so the record survives a restart; gated `platform.job.manage`
 * (writes) / `platform.job.read` (reads); no business transaction is posted here (§28).
 */

const TENANT = 't-sre';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

const schedule = (h: ReturnType<typeof apiHarness>, u: string, jobId: string, kind: string, key: string) =>
  h.request({ method: 'POST', path: '/v1/platform/jobs', userId: u, tenantId: TENANT, idempotencyKey: key, body: { jobId, kind } });
const report = (h: ReturnType<typeof apiHarness>, u: string, jobId: string, outcome: string, key: string, error?: string) =>
  h.request({ method: 'POST', path: `/v1/platform/jobs/${jobId}/runs`, userId: u, tenantId: TENANT, idempotencyKey: key, body: { outcome, ...(error !== undefined ? { error } : {}) } });
const retry = (h: ReturnType<typeof apiHarness>, u: string, jobId: string, key: string) =>
  h.request({ method: 'POST', path: `/v1/platform/jobs/${jobId}/retry`, userId: u, tenantId: TENANT, idempotencyKey: key });
const monitor = (h: ReturnType<typeof apiHarness>, u: string) =>
  h.request({ method: 'GET', path: '/v1/platform/jobs', userId: u, tenantId: TENANT });
const failedOnly = (h: ReturnType<typeof apiHarness>, u: string) =>
  h.request({ method: 'GET', path: '/v1/platform/jobs/failed', userId: u, tenantId: TENANT });

describe('background jobs (M33-FR-01) — schedule, monitor, a failed job made retryable', () => {
  it('schedules a job, a failed run makes it visible, and a retry re-queues it to success', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');

    expect((await schedule(h, 'u-owner', 'nightly-report', 'report', 's-1')).status).toBe(201);

    // Monitor shows it scheduled, needing no attention yet.
    const before = await monitor(h, 'u-owner');
    expect((before.body as { jobs: { status: string }[] }).jobs[0]?.status).toBe('scheduled');
    expect((before.body as { failing: number }).failing).toBe(0);

    // The run fails — the job is now visible as failed, with the reason kept.
    expect((await report(h, 'u-owner', 'nightly-report', 'failed', 'r-1', 'db timeout')).status).toBe(200);
    const failed = await failedOnly(h, 'u-owner');
    expect((failed.body as { jobs: { jobId: string; lastError: string }[] }).jobs).toHaveLength(1);
    expect((failed.body as { jobs: { lastError: string }[] }).jobs[0]?.lastError).toBe('db timeout');

    // Retry re-queues it; the next run succeeds; nothing is left failing.
    expect((await retry(h, 'u-owner', 'nightly-report', 'rt-1')).status).toBe(200);
    expect((await report(h, 'u-owner', 'nightly-report', 'succeeded', 'r-2')).status).toBe(200);
    const after = await monitor(h, 'u-owner');
    expect((after.body as { jobs: { status: string; attempts: number; retries: number }[] }).jobs[0]).toMatchObject({ status: 'succeeded', attempts: 2, retries: 1 });
    expect((after.body as { failing: number }).failing).toBe(0);
    expect((await failedOnly(h, 'u-owner')).body).toMatchObject({ jobs: [] });
  });

  it('keeps the jobs across a restart — a fresh process over the same store still sees the failure', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    await schedule(h, 'u-owner', 'pack', 'settings-pack', 's-1');
    await report(h, 'u-owner', 'pack', 'failed', 'r-1', 'signing key missing');

    const restarted = apiHarness({ store: h.store });
    const got = await restarted.request({ method: 'GET', path: '/v1/platform/jobs/failed', userId: 'u-owner', tenantId: TENANT });
    expect((got.body as { jobs: { jobId: string; status: string }[] }).jobs[0]).toMatchObject({ jobId: 'pack', status: 'failed' });
  });

  it('the monitor puts the jobs that need attention first (control by exception)', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    await schedule(h, 'u-owner', 'ok-job', 'report', 's-1');
    await report(h, 'u-owner', 'ok-job', 'succeeded', 'r-1');
    await schedule(h, 'u-owner', 'bad-job', 'report', 's-2');
    await report(h, 'u-owner', 'bad-job', 'failed', 'r-2', 'boom');

    const jobs = (await monitor(h, 'u-owner')).body as { jobs: { jobId: string; needsAttention: boolean }[] };
    expect(jobs.jobs[0]).toMatchObject({ jobId: 'bad-job', needsAttention: true }); // failing job first
  });

  it('refuses to schedule a job id that already exists, and to retry a job that has not failed', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    await schedule(h, 'u-owner', 'pack', 'settings-pack', 's-1');

    const dup = await schedule(h, 'u-owner', 'pack', 'settings-pack', 's-2');
    expect(dup.status).toBe(409);
    expect(codeOf(dup)).toBe('job_already_scheduled');

    // A scheduled (not failed) job cannot be retried — there is nothing to retry.
    const early = await retry(h, 'u-owner', 'pack', 'rt-1');
    expect(early.status).toBe(409);
    expect(codeOf(early)).toBe('job_not_failed');
  });

  it('refuses a run report or a retry for a job nobody scheduled (no phantom job), and a report with no outcome', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');

    const ghostRun = await report(h, 'u-owner', 'ghost', 'failed', 'r-1');
    expect(ghostRun.status).toBe(404);
    expect(codeOf(ghostRun)).toBe('unknown_job');

    const ghostRetry = await retry(h, 'u-owner', 'ghost', 'rt-1');
    expect(ghostRetry.status).toBe(404);

    await schedule(h, 'u-owner', 'pack', 'settings-pack', 's-1');
    const bad = await h.request({ method: 'POST', path: '/v1/platform/jobs/pack/runs', userId: 'u-owner', tenantId: TENANT, idempotencyKey: 'r-x', body: { outcome: 'maybe' } });
    expect(bad.status).toBe(400);
    expect(codeOf(bad)).toBe('outcome_not_given');
  });

  it('is gated — a platform administrator may run the whole loop, but a user with no role is refused', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');

    // The §28 story holds the other way round too: a platform_admin CAN operate jobs (it is admin work, not a
    // business transaction), so provisioning that role must let the whole schedule→fail→retry loop through.
    await h.provisionRole(TENANT, 'u-admin', 'platform_admin');
    expect((await schedule(h, 'u-admin', 'pack', 'settings-pack', 's-1')).status).toBe(201);
    expect((await report(h, 'u-admin', 'pack', 'failed', 'r-1', 'boom')).status).toBe(200);
    expect((await retry(h, 'u-admin', 'pack', 'rt-1')).status).toBe(200);
    expect((await monitor(h, 'u-admin')).status).toBe(200);

    // A user with no role authorises nothing (default-deny).
    expect((await schedule(h, 'u-nobody', 'other', 'report', 's-9')).status).toBe(403);
    expect((await monitor(h, 'u-nobody')).status).toBe(403);
  });
});
