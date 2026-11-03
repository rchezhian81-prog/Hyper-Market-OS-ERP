import { describe, it, expect } from 'vitest';
import { createFailedJobsSession, FAILED_JOBS_COPY } from '../../apps/web-erp/src/failed-jobs-session';
import { createOpsAlertsSession, OPS_ALERTS_COPY } from '../../apps/web-erp/src/ops-alerts-session';

/**
 * Wave 4 (operations): the DOM-free sessions behind M35-FR-03 Failed jobs (a failed background job is seen and sent round
 * again) and M35-FR-01 the backup and restore readings on the Operational alerts page. Each refuses the cheap things
 * before anything is sent, asks only with the permission its page holds, and sends exactly what head office's route reads.
 */

type Sent = { method: string; path: string; body: unknown };
function fakeHeadOffice(answer: (method: string, path: string) => { status?: number; body: unknown } = () => ({ body: {} })) {
  const sent: Sent[] = [];
  const fetch = (async (path: string, init: { method: string; body?: string }) => {
    sent.push({ method: init.method, path, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const a = answer(init.method, path);
    const status = a.status ?? 200;
    return { ok: status < 400, status, json: async () => a.body } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  return { sent, fetch };
}
const v = (...permissions: string[]) => ({ userId: 'u-x', permissions });

describe('every word has a Tamil twin', () => {
  it('in the Failed jobs and Operational alerts word tables', () => {
    for (const c of [FAILED_JOBS_COPY, OPS_ALERTS_COPY]) expect(Object.keys(c.ta).sort()).toEqual(Object.keys(c.en).sort());
  });
});

describe('Failed jobs (M35-FR-03): a failed job is visible and a person retries it', () => {
  const FAILED = { jobs: [
    { jobId: 'pack-1', kind: 'settings-pack', status: 'failed', attempts: 1, retries: 0, scheduledAt: '2026-11-02T18:00:00.000Z', lastRunAt: '2026-11-02T18:01:00.000Z', lastError: 'the pack would not sign', needsAttention: true },
    { jobId: 'report-9', kind: 'nightly-report', status: 'failed', attempts: 2, retries: 1, scheduledAt: '2026-11-02T20:00:00.000Z', lastRunAt: '2026-11-02T20:05:00.000Z', lastError: 'timed out', needsAttention: true },
  ], asAt: '2026-11-02T21:00:00.000Z' };

  it('reads only the failed jobs, the newest failure first, with its error', async () => {
    const ho = fakeHeadOffice(() => ({ body: FAILED }));
    const s = createFailedJobsSession({ viewer: v('platform.job.read'), fetch: ho.fetch });
    const out = await s.failed();
    expect(ho.sent).toEqual([{ method: 'GET', path: '/v1/platform/jobs/failed', body: undefined }]);
    expect(out).toEqual({ result: 'ok', value: { asAt: '2026-11-02T21:00:00.000Z', jobs: [
      { jobId: 'report-9', kind: 'nightly-report', attempts: 2, retries: 1, lastRunAt: '2026-11-02T20:05:00.000Z', lastError: 'timed out' },
      { jobId: 'pack-1', kind: 'settings-pack', attempts: 1, retries: 0, lastRunAt: '2026-11-02T18:01:00.000Z', lastError: 'the pack would not sign' },
    ] } });
  });

  it('a reader may see but not retry — nothing is sent; a manager retries exactly that job', async () => {
    const reader = fakeHeadOffice();
    expect(await createFailedJobsSession({ viewer: v('platform.job.read'), fetch: reader.fetch }).retry('pack-1')).toEqual({ result: 'invalid', why: 'cannotRetry' });
    expect(reader.sent).toEqual([]);
    const ho = fakeHeadOffice(() => ({ body: { jobId: 'pack/1', status: 'scheduled', retries: 1 } }));
    const s = createFailedJobsSession({ viewer: v('platform.job.read', 'platform.job.manage'), fetch: ho.fetch });
    expect(await s.retry('pack/1')).toEqual({ result: 'ok', value: { retries: 1 } });
    expect(ho.sent).toEqual([{ method: 'POST', path: '/v1/platform/jobs/pack%2F1/retry', body: {} }]);
  });

  it('says head office\'s refusal in its own words, and names nobody signed in or a role that cannot read', async () => {
    const ho = fakeHeadOffice(() => ({ status: 409, body: { error: { code: 'job_not_failed', whatHappened: "Only a failed job can be retried; 'x' is scheduled." } } }));
    const s = createFailedJobsSession({ viewer: v('platform.job.read', 'platform.job.manage'), fetch: ho.fetch });
    expect(await s.retry('x')).toEqual({ result: 'refused', status: 409, code: 'job_not_failed', whatHappened: "Only a failed job can be retried; 'x' is scheduled." });
    expect(await createFailedJobsSession({ viewer: undefined }).failed()).toEqual({ result: 'invalid', why: 'nobody' });
    expect(await createFailedJobsSession({ viewer: v('platform.health.read') }).failed()).toEqual({ result: 'invalid', why: 'cannotRead' });
  });
});

describe('the backup and restore readings (M35-FR-01) on the Operational alerts page', () => {
  it('reads the newest backup, the newest good one and head office\'s reading of the backup', async () => {
    const ho = fakeHeadOffice(() => ({ body: {
      observed: {
        signals: { lastBackupAt: '2026-11-01T21:00:00.000Z' },
        lastBackup: { backupId: 'bk-2', at: '2026-11-02T21:00:00.000Z', ok: false, encrypted: true, offsite: false, detail: 'pg_dump failed', recordedBy: 'u-backup-job', recordedAt: 'x' },
      },
      health: { components: [{ name: 'database', status: 'ok', detail: 'd' }, { name: 'backup', status: 'degraded', detail: 'the latest backup (bk-2) did not complete' }] },
      asAt: '2026-11-02T22:00:00.000Z',
    } }));
    const s = createOpsAlertsSession({ viewer: v('platform.health.read'), fetch: ho.fetch });
    expect(await s.backups()).toEqual({ result: 'ok', value: {
      latest: { backupId: 'bk-2', at: '2026-11-02T21:00:00.000Z', ok: false, encrypted: true, offsite: false, detail: 'pg_dump failed', recordedBy: 'u-backup-job' },
      lastGoodAt: '2026-11-01T21:00:00.000Z', reading: { status: 'degraded', detail: 'the latest backup (bk-2) did not complete' }, asAt: '2026-11-02T22:00:00.000Z',
    } });
    expect(ho.sent).toEqual([{ method: 'GET', path: '/v1/platform/operational-health/observed', body: undefined }]);
  });

  it('no backup ever reported is "none", never a made-up good one', async () => {
    const s = createOpsAlertsSession({ viewer: v('platform.health.read'), fetch: fakeHeadOffice(() => ({ body: { observed: { signals: {}, lastBackup: null }, health: { components: [] } } })).fetch });
    expect(await s.backups()).toEqual({ result: 'ok', value: { latest: null, lastGoodAt: null, reading: null, asAt: '' } });
  });

  it('reads the latest backup-restore rehearsal only for a person who may see the recovery readings', async () => {
    const ho = fakeHeadOffice(() => ({ body: { rehearsals: [
      { kind: 'store_recovery', state: 'passed', detail: 'x' },
      { kind: 'backup_restore', state: 'failed', drillId: 'q4-restore', drilledAt: '2026-11-02T10:00:00.000Z', drilledBy: 'u-owner', detail: 'recovery took 300 min against a 240-minute target' },
    ] } }));
    const s = createOpsAlertsSession({ viewer: v('platform.health.read', 'backup.verify.read'), fetch: ho.fetch });
    expect(s.may.restore).toBe(true);
    expect(await s.restore()).toEqual({ result: 'ok', value: { state: 'failed', drillId: 'q4-restore', drilledAt: '2026-11-02T10:00:00.000Z', drilledBy: 'u-owner', detail: 'recovery took 300 min against a 240-minute target' } });
    expect(ho.sent).toEqual([{ method: 'GET', path: '/v1/platform/recovery-gate', body: undefined }]);
    const missing = createOpsAlertsSession({ viewer: v('platform.health.read', 'backup.verify.read'), fetch: fakeHeadOffice(() => ({ body: { rehearsals: [] } })).fetch });
    expect(await missing.restore()).toEqual({ result: 'ok', value: { state: 'missing', detail: '' } });
    const noRight = fakeHeadOffice();
    expect(await createOpsAlertsSession({ viewer: v('platform.health.read'), fetch: noRight.fetch }).restore()).toEqual({ result: 'invalid', why: 'cannotRestore' });
    expect(noRight.sent).toEqual([]);
  });
});
