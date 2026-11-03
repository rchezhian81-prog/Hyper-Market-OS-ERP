import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startW4Shop, openAs, says, type W4Shop } from './lib/w4-office-shop';

/**
 * **W4 · M35-FR-03 (P-08 no silent failure · P-03 · hard rule #2): a failed background job is seen on the Failed jobs page
 * and a person sends it round again, in a real browser, on the production API surface — over real PostgreSQL when
 * DATABASE_URL is set.** Acceptance: "a failed job is visible and retryable."
 *   • head office holds two jobs: the night's settings pack FAILED (with its error), a report that ran; the page lists only
 *     the failed one, with the error head office kept, and writes nothing on open;
 *   • the owner presses "Run it again": exactly one POST …/retry goes, head office now holds it waiting to run (retries 1),
 *     and the page says nothing has failed;
 *   • it fails again: the page shows it again — "1 sent round again" — and after a RESTART of head office it is still there
 *     (the history is append-only: the first failure, the retry and the second failure are all kept);
 *   • a store manager, whose role does not include the jobs, is told so and sees no job; the page reads in Tamil.
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER = 'u-owner'; const MGR = 'u-mgr';

describe.skipIf(!existsSync(CHROMIUM))('Failed jobs (M35-FR-03): a failed job is visible and retryable, in a real browser', () => {
  let browser: Browser;
  let shop: W4Shop;
  const T = randomUUID();
  const act = (path: string, body: unknown) => shop.ho().request({ method: 'POST', path, userId: OWNER, tenantId: T, idempotencyKey: `seed-${randomUUID()}`, body });

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startW4Shop({ tenantId: T, databaseUrl: DATABASE_URL, pages: { '/failed-jobs': { html: 'failed-jobs.html', dataGlobal: 'failedJobsData' } } });
    await shop.ho().seedOwner(T, OWNER);
    await shop.ho().provisionRole(T, MGR, 'store_manager');
    expect((await act('/v1/platform/jobs', { jobId: 'pack-nightly', kind: 'settings-pack' })).status).toBe(201);
    expect((await act('/v1/platform/jobs/pack-nightly/runs', { outcome: 'failed', error: 'the settings pack would not sign: no signing key' })).status).toBe(200);
    expect((await act('/v1/platform/jobs', { jobId: 'report-daily', kind: 'nightly-report' })).status).toBe(201);
    expect((await act('/v1/platform/jobs/report-daily/runs', { outcome: 'succeeded' })).status).toBe(200);
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  it(`the owner sees the failed job with its error and runs it again; a second failure stays visible through a restart`, async () => {
    let s = await openAs(shop, browser, OWNER, '/failed-jobs');
    try {
      const row = '#jobs li[data-job="pack-nightly"]';
      await says(s.page, row, /pack-nightly · kind settings-pack/);
      await says(s.page, row, /1 runs · 0 sent round again/);
      await says(s.page, row, /error: the settings pack would not sign: no signing key/);
      expect(await s.page.locator('#jobs li[data-job="report-daily"]').count(), 'a job that ran is not on the failed list').toBe(0);
      expect(s.writes, 'nothing is written on open').toEqual([]);

      await s.page.click(`${row} button`);
      await says(s.page, '#jobs', /No job has failed\./);
      await says(s.page, '#jobs-status', /pack-nightly: Sent round again\. It is waiting to run\./);
      expect(s.writes).toEqual(['POST /v1/platform/jobs/pack-nightly/retry']);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    const jobs = (await shop.ho().request({ method: 'GET', path: '/v1/platform/jobs', userId: OWNER, tenantId: T })).body as { jobs: { jobId: string; status: string; retries: number; attempts: number }[] };
    expect(jobs.jobs.find((j) => j.jobId === 'pack-nightly')).toMatchObject({ status: 'scheduled', retries: 1, attempts: 1 });

    // The runner tries again and it fails again: visible again, with the retry counted — and after a restart.
    expect((await act('/v1/platform/jobs/pack-nightly/runs', { outcome: 'failed', error: 'the settings pack would not sign: key still missing' })).status).toBe(200);
    await shop.restart();
    s = await openAs(shop, browser, OWNER, '/failed-jobs');
    try {
      const row = '#jobs li[data-job="pack-nightly"]';
      await says(s.page, row, /2 runs · 1 sent round again/);
      await says(s.page, row, /error: the settings pack would not sign: key still missing/);
      await s.page.click('#lang');
      await says(s.page, '#jobs-h', /^தோல்வியடைந்த பணிகள்$/);
      await says(s.page, `${row} button`, /^மீண்டும் இயக்கு$/);
      expect(s.writes).toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  });

  it('a store manager is told the jobs are not his role\'s to see — no job, no button, nothing sent', async () => {
    const s = await openAs(shop, browser, MGR, '/failed-jobs');
    try {
      await says(s.page, '#page-status', /^Your role cannot see the background jobs\.$/);
      expect(await s.page.isVisible('#jobs-s')).toBe(false);
      expect(await s.page.locator('#jobs li').count()).toBe(0);
      expect(s.writes).toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  });
});
