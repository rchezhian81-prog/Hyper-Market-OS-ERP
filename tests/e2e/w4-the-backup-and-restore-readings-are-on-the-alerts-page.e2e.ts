import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startW4Shop, openAs, says, type W4Shop } from './lib/w4-office-shop';
import { shopMomentOf } from '../../apps/web-erp/src/findings-session';

/**
 * **W4 · M35-FR-01 (P-04 tested recovery · P-08 · hard rule #4): the backup and restore readings are on the Operational
 * alerts page, in a real browser, on the production API surface — over real PostgreSQL when DATABASE_URL is set.**
 * Until now head office knew each backup the backup job reported and each restore rehearsal, but no screen showed them.
 *   • nothing reported yet: the page says no backup has been reported and the restore was never rehearsed — never a made-up
 *     good one;
 *   • the backup JOB (its own machine identity — no person can post one) reports a good night: the page shows it completed,
 *     encrypted and copied off-site, with its size and checksum, and the newest good backup at that time; the owner records a
 *     backup-restore rehearsal that met its target, and the page shows it passed, by him;
 *   • the next night fails: the page shows ⚠ that it did NOT complete, the newest good backup is still the night before, and
 *     head office's own reading of the backup says it is not working well;
 *   • a systems administrator (who reads health but not the recovery rehearsals) is told so; no page writes anything.
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER = 'u-owner'; const JOB = 'u-backup-job'; const ADMIN = 'u-it';
const CHECKSUM = `sha256:${'ab'.repeat(32)}`;

describe.skipIf(!existsSync(CHROMIUM))('the backup and restore readings (M35-FR-01) on the Operational alerts page, in a real browser', () => {
  let browser: Browser;
  let shop: W4Shop;
  const T = randomUUID();
  const as = (userId: string, path: string, body: unknown) => shop.ho().request({ method: 'POST', path, userId, tenantId: T, idempotencyKey: `seed-${randomUUID()}`, body });

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startW4Shop({ tenantId: T, databaseUrl: DATABASE_URL, pages: { '/ops-alerts': { html: 'ops-alerts.html', dataGlobal: 'opsAlertsData' } } });
    await shop.ho().seedOwner(T, OWNER);
    await shop.ho().provisionRole(T, JOB, 'backup_job');
    await shop.ho().provisionRole(T, ADMIN, 'platform_admin');
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  it('shows what the backup job reported and the latest restore rehearsal — a good night, then a failed one', async () => {
    let s = await openAs(shop, browser, OWNER, '/ops-alerts');
    try {
      await says(s.page, '#readings li[data-reading="newest"]', /No backup has been reported by the backup job yet\./);
      await says(s.page, '#readings li[data-reading="good"]', /None yet/);
      await says(s.page, '#readings li[data-reading="restore"]', /never rehearsed/);
      expect(s.writes).toEqual([]);
    } finally { await s.close(); }

    // A person cannot post a backup — only the backup job's own identity is believed (hard rule #4).
    const goodAt = new Date(Date.now() - 20 * 3_600_000).toISOString();
    const byOwner = await as(OWNER, '/v1/platform/backups/bk-person/taken', { at: goodAt, ok: true, encrypted: true, offsite: true });
    expect(byOwner.status).toBe(403);
    expect((await as(JOB, '/v1/platform/backups/bk-1/taken', { at: goodAt, endedAt: new Date(Date.parse(goodAt) + 300_000).toISOString(), ok: true, encrypted: true, offsite: true, sizeBytes: 524_288, checksum: CHECKSUM })).status).toBe(201);
    expect((await as(OWNER, '/v1/platform/dr-drills', { drillId: 'q4-backup-restore', rehearsal: 'backup_restore', dataLossSeconds: 0, recoverySeconds: 5_400 })).status).toBe(201);

    s = await openAs(shop, browser, OWNER, '/ops-alerts');
    try {
      const newest = '#readings li[data-reading="newest"]';
      await says(s.page, newest, new RegExp(`✓ bk-1 · ${shopMomentOf(goodAt)} · completed · encrypted · copied off-site · 524288 bytes · reported by ${JOB}`));
      await says(s.page, newest, new RegExp(CHECKSUM));
      await says(s.page, '#readings li[data-reading="good"]', new RegExp(shopMomentOf(goodAt)));
      await says(s.page, '#readings li[data-reading="restore"]', new RegExp(`✓ passed · .* · rehearsed by ${OWNER} · counts until`));
      expect(await s.page.getAttribute('#readings li[data-reading="restore"]', 'data-state')).toBe('passed');
      expect(s.writes).toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    // The next night the job reports that the backup did not complete.
    const badAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
    expect((await as(JOB, '/v1/platform/backups/bk-2/taken', { at: badAt, ok: false, encrypted: true, offsite: false, detail: 'pg_dump stopped: disk full' })).status).toBe(201);
    await shop.restart();
    s = await openAs(shop, browser, OWNER, '/ops-alerts');
    try {
      const newest = '#readings li[data-reading="newest"]';
      await says(s.page, newest, new RegExp(`⚠ bk-2 · ${shopMomentOf(badAt)} · did NOT complete · encrypted · NO off-site copy · reported by ${JOB}`));
      await says(s.page, newest, /pg_dump stopped: disk full/);
      expect(await s.page.getAttribute(newest, 'data-good')).toBe('false');
      await says(s.page, '#readings li[data-reading="good"]', new RegExp(shopMomentOf(goodAt)));
      await says(s.page, '#readings li[data-reading="health"]', /Head office's reading of the backup — not working well/);
      await says(s.page, '#readings li[data-reading="health"]', /bk-2.*did not complete/);
      await s.page.click('#lang');
      await says(s.page, '#readings-h', /^காப்புப் பிரதி, மீட்பு அளவீடுகள்$/);
      await says(s.page, newest, /முடியவில்லை/);
      expect(s.writes).toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  });

  it('a systems administrator reads the backups but is told the restore rehearsals are not his role\'s', async () => {
    const s = await openAs(shop, browser, ADMIN, '/ops-alerts');
    try {
      await says(s.page, '#readings li[data-reading="newest"]', /bk-2/);
      await says(s.page, '#readings li[data-reading="restore"]', /Your role cannot see the restore rehearsals\./);
      expect(s.writes).toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  });
});
