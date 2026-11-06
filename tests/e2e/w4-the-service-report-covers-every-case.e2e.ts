import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startW4Shop, openAs, says, type W4Shop } from './lib/w4-office-shop';

/**
 * **W4 · M21-FR-04 (P-03 · P-08): head office's service performance report — every case — is on the Customer cases page,
 * in a real browser, on the production API surface (over real PostgreSQL when DATABASE_URL is set).** Acceptance: "an SLA
 * breach escalates and is visible; resolution and CSAT are recorded; a report shows service performance." The offline desk
 * on the store computer keeps its own local report; this is head office's count across ALL cases, for the manager and owner.
 *   • two complaints are opened; K-1 is answered, resolved the same day and rated 4 by the customer; K-2 is left open;
 *   • four days later (past the three-day target for a normal case) the owner opens the page: 2 cases, 1 resolved, 1 resolved
 *     within time, 1 past its time; K-2 is named as late and still open — escalate now; satisfaction 4.00 from half the cases;
 *   • nothing is written on open; the figures are head office's exactly (`GET /v1/service/report`); the section reads in Tamil.
 * Only `Date` is moved (timers and I/O run normally); the real clock is given back after.
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER = 'u-owner'; const DESK = 'u-desk';

describe.skipIf(!existsSync(CHROMIUM))('the service report over every case (M21-FR-04) on the Customer cases page, in a real browser', () => {
  let browser: Browser;
  let shop: W4Shop;
  const T = randomUUID();
  const act = (path: string, body: unknown) => shop.ho().request({ method: 'POST', path, userId: DESK, tenantId: T, idempotencyKey: `seed-${randomUUID()}`, body });

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startW4Shop({ tenantId: T, databaseUrl: DATABASE_URL, pages: { '/service-desk': { html: 'service-desk.html', dataGlobal: 'serviceDeskData' } } });
    await shop.ho().seedOwner(T, OWNER);
    await shop.ho().provisionRole(T, DESK, 'store_manager');
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { vi.useRealTimers(); await browser?.close(); await shop?.stop(); });

  it('names the late open case to escalate, counts what was resolved in time, and the satisfaction with its reply rate', async () => {
    const base = { kind: 'complaint', priority: 'normal', assignedTo: DESK };
    expect((await act('/v1/service/cases/K-1', { ...base, customerRef: 'c-1', summary: 'The milk was sour' })).status).toBe(201);
    expect((await act('/v1/service/cases/K-2', { ...base, customerRef: 'c-2', summary: 'The bread was stale' })).status).toBe(201);
    expect((await act('/v1/service/cases/K-1/first-response', {})).status).toBe(200);
    expect((await act('/v1/service/cases/K-1/resolution', { resolution: 'Replaced the milk' })).status).toBe(200);
    expect((await act('/v1/service/cases/K-1/satisfaction', { customerRef: 'c-1', score: 4 })).status).toBe(201);

    // Four days on: K-2 (normal priority, a three-day target) is past its time and still open.
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(new Date(Date.now() + 4 * 86_400_000));

    const s = await openAs(shop, browser, OWNER, '/service-desk');
    try {
      await says(s.page, '#service-report li[data-r="cases"]', /^Cases: 2 · resolved 1 · resolved within time 1 · past their time 1$/);
      await says(s.page, '#service-report li[data-r="first"]', /^Not answered in time \(first reply\): 1$/);
      await says(s.page, '#service-report li[data-r="escalate"]', /^Late and still open — escalate now: K-2$/);
      await says(s.page, '#service-report li[data-r="csat"]', /^Satisfaction \(out of 5\): 4\.00 · 50\.0% of cases replied$/);
      const report = (await shop.ho().request({ method: 'GET', path: '/v1/service/report', userId: OWNER, tenantId: T })).body as Record<string, unknown>;
      expect(report).toMatchObject({ cases: 2, resolved: 1, met: 1, breached: 1, breachedValue: ['K-2'], escalateNow: ['K-2'], firstResponseBreached: 1, csatHundredths: 400, responseRateBps: 5_000 });
      expect(s.writes, 'nothing is written on open').toEqual([]);
      await s.page.click('#lang');
      await says(s.page, '#report-h', /^சேவை எப்படி உள்ளது — எல்லா வழக்குகளும்$/);
      await says(s.page, '#service-report li[data-r="escalate"]', /இப்போதே மேலே அனுப்புங்கள்: K-2$/);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  });
});
