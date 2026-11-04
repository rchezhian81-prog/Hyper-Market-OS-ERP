import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startW4Shop, openAs, says, type W4Shop } from './lib/w4-office-shop';
import { pinTheEveningClock, pinThePageClock } from '../support/evening-clock';

/**
 * **W5 · M34-FR-01 · M34-FR-02 (hard rule #6) — legal holds, what may be reviewed for deletion, and the evidence pack, on the
 * Audit log page, in a real browser, on the production API surface over real PostgreSQL when DATABASE_URL is set.**
 * Acceptance: "a record under legal hold survives past its retention date; an auditor can export the evidence for a period;
 * retention runs without deleting held or statutorily-required data." Head office has recorded some changes today. Through
 * Chromium the OWNER:
 *   • places a hold for a dispute over today's EPR records — it is listed in force, saying what it covers in shop days;
 *   • reads what may be reviewed for deletion — the records it read, those the hold keeps, those the law keeps; NOTHING is
 *     deleted and nothing kept is offered for review;
 *   • makes the evidence pack for today — a file named for the days, named to him, every record of the day in it, and the
 *     page says the chain checked whole;
 *   • lifts the hold with a reason — it stays on the list as lifted, by him; the page reads in Tamil.
 * An ACCOUNTANT, who may read the audit log but not hold records, sees the holds and is told placing one is not his to do.
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER = 'u-owner'; const ACCOUNTANT = 'u-acct';
/** Today on the shop's clock (Asia/Kolkata) — never the UTC date. */
const shopToday = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

describe.skipIf(!existsSync(CHROMIUM))('Audit log: legal holds, the keeping plan and the evidence pack (M34-FR-01/02), in a real browser', () => {
  let browser: Browser;
  let shop: W4Shop;
  const T = randomUUID();
  const act = (path: string, body: unknown) => shop.ho().request({ method: 'POST', path, userId: OWNER, tenantId: T, idempotencyKey: `seed-${randomUUID()}`, body });

  beforeAll(async () => {
    // The shop's date is ahead of UTC from 18:30 to 24:00 UTC: the clock is pinned there, so "today" is always the shop's.
    pinTheEveningClock();
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startW4Shop({ tenantId: T, databaseUrl: DATABASE_URL, pages: { '/audit-log': { html: 'audit-log.html', dataGlobal: 'auditLogData' } } });
    await shop.ho().seedOwner(T, OWNER);
    await shop.ho().provisionRole(T, ACCOUNTANT, 'accountant');
    // Today's recorded changes: two recyclers on the EPR register (each change is sealed on the trail).
    expect((await act('/v1/compliance/epr/recyclers/r-1', { name: 'Green Recyclers (test)', registrationNumber: 'TNPCB-EW-TEST-0001' })).status).toBe(200);
    expect((await act('/v1/compliance/epr/recyclers/r-2', { name: 'Blue Recyclers (test)', registrationNumber: 'TNPCB-EW-TEST-0002' })).status).toBe(200);
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 240_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); vi.useRealTimers(); });

  it('the owner places a hold, reads the keeping plan, takes the evidence pack for today and lifts the hold', async () => {
    const today = shopToday();
    const context = await browser.newContext({ acceptDownloads: true, serviceWorkers: 'block' });
    await context.addCookies([{ name: 'who', value: OWNER, domain: new URL(shop.base).hostname, path: '/' }]);
    await pinThePageClock(context); // the page reads the shop's today from its own clock — the same pinned evening
    const p = await context.newPage();
    p.setDefaultTimeout(15_000);
    const errors: string[] = []; const writes: string[] = [];
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${u.pathname}`); });
    try {
      await p.goto(`${shop.base}/audit-log`, { waitUntil: 'load' });
      await says(p, '#hold-list', /No legal hold has been placed\./);
      expect(writes, 'nothing is written on open').toEqual([]);

      // A hold over today's EPR records.
      await p.fill('#h-reason', 'Recycler dispute (test)'); await p.fill('#h-type', 'epr_register');
      await p.fill('#h-from', today); await p.fill('#h-until', today);
      await p.click('#h-go');
      await says(p, '#holds-status', /^Hold placed\.$/);
      await says(p, '#hold-list li[data-state="in-force"]', new RegExp(`In force — Recycler dispute \\(test\\)[\\s\\S]*covers: kind epr_register · from ${today} · until ${today}[\\s\\S]*placed by u-owner`));
      expect(writes).toEqual(['POST /v1/audit/legal-holds']);

      // What may be reviewed for deletion: the held records are kept; nothing is offered that a hold or the law keeps.
      await p.click('#p-go');
      await says(p, '#plan-status', new RegExp(`as of shop day ${today}: \\d+ records read · [1-9]\\d* kept by a hold`));
      await says(p, '#plan-rows', /No record is past its keeping time\./);

      // The evidence pack for today.
      await p.fill('#k-from', today); await p.fill('#k-until', today);
      const [download] = await Promise.all([p.waitForEvent('download'), p.click('#k-go')]);
      expect(download.suggestedFilename()).toBe(`evidence-pack-${today}-to-${today}.json`);
      const file = JSON.parse(await readFile((await download.path())!, 'utf8')) as { exportedBy: string; sourceIntact: boolean; records: { objectId: string }[]; chainHash: string };
      expect(file.exportedBy).toBe(OWNER);
      expect(file.sourceIntact).toBe(true);
      expect(file.records.map((r) => r.objectId)).toEqual(expect.arrayContaining(['r-1', 'r-2']));
      expect(file.chainHash).not.toBe('');
      await says(p, '#pack-status', new RegExp(`✓ Evidence pack made: ${today} → ${today} · ${file.records.length} records · the chain checked whole`));

      // Lift the hold: kept on the list, lifted, by the owner.
      await p.fill('#hold-list li[data-state="in-force"] .lift-why', 'dispute settled (test)');
      await p.click('#hold-list li[data-state="in-force"] .lift-go');
      await says(p, '#holds-status', /^Hold lifted\. It stays on the record\.$/);
      await says(p, '#hold-list li[data-state="lifted"]', /Lifted — Recycler dispute \(test\)[\s\S]*lifted by u-owner/);
      await p.click('#p-go');
      await says(p, '#plan-status', /· 0 kept by a hold ·/);

      await p.click('#lang');
      await says(p, '#holds-h', /^சட்டப் பிடிப்புகள்$/);
      await says(p, '#k-go', /^சான்றுத் தொகுப்பை உருவாக்கு$/);
      expect(writes.filter((w) => w.includes('legal-holds'))).toEqual(['POST /v1/audit/legal-holds', `POST /v1/audit/legal-holds/${(await p.getAttribute('#hold-list li[data-state="lifted"]', 'data-hold'))!}/lift`]);
      expect(errors).toEqual([]);
    } finally { await context.close(); }

    // Head office keeps the hold — lifted, never erased.
    const holds = (await shop.ho().request({ method: 'GET', path: '/v1/audit/legal-holds', userId: OWNER, tenantId: T })).body as { holds: { reason: string; liftedBy?: string }[]; active: number };
    expect(holds).toMatchObject({ active: 0, holds: [expect.objectContaining({ reason: 'Recycler dispute (test)', liftedBy: OWNER })] });
  }, 180_000);

  it('an accountant reads the holds but is told placing or lifting one is not his to do', async () => {
    const s = await openAs(shop, browser, ACCOUNTANT, '/audit-log');
    try {
      await says(s.page, '#holds-status', /^You can see the holds; placing or lifting one needs/);
      await says(s.page, '#hold-list li[data-state="lifted"]', /Recycler dispute \(test\)/);
      expect(await s.page.isVisible('#hold-form')).toBe(false);
      expect(await s.page.locator('#hold-list .lift-go').count()).toBe(0);
      expect(s.writes).toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  });
});
