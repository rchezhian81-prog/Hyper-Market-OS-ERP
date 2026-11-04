import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startW4Shop, openAs, says, type W4Shop } from './lib/w4-office-shop';
import { pinTheEveningClock, pinThePageClock } from '../support/evening-clock';

/**
 * **W5 · M34-FR-03 · M34-FR-04 · OB-331 — the "Licences, controls and findings" page, in a real browser, on the production
 * API surface over real PostgreSQL when DATABASE_URL is set.** Through Chromium the OWNER:
 *   • M34-FR-03: registers the FSSAI licence with the person who must renew it, expiring in 20 days — it shows under "Needs
 *     attention" with that person, and under "Nothing on file to show an inspector"; files the licence copy as evidence — the
 *     gap clears and the evidence is listed; registers a scale's stamping certificate and closes it with a reason — it stays
 *     on the register, closed, with its reason (nothing is deleted);
 *   • M34-FR-04: registers a control with its owner — "Never checked"; records an incident against it, a remediation for the
 *     incident with an owner and a date, marks it done, and records a dated check of the control in his own name;
 *   • OB-331: records a penetration-test finding, names who must fix it, and records it fixed with written evidence; a
 *     scanner's finding on the same register offers no "fixed" button;
 *   • the page reads in Tamil. A CASHIER, whose role does not include these registers, is told so and sees none of them.
 * Head office holds every record afterwards (read back over the API after a restart).
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER = 'u-owner'; const TILL = 'u-till';

/** The shop's today plus n days, as YYYY-MM-DD on the shop's clock (Asia/Kolkata) — never the UTC date. */
const shopDayPlus = (n: number): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() + n * 86_400_000));

describe.skipIf(!existsSync(CHROMIUM))('Licences, controls and findings (M34-FR-03 · M34-FR-04 · OB-331), in a real browser', () => {
  let browser: Browser;
  let shop: W4Shop;
  const T = randomUUID();
  const read = async <B>(path: string): Promise<B> => (await shop.ho().request({ method: 'GET', path, userId: OWNER, tenantId: T })).body as B;

  beforeAll(async () => {
    // The shop's date is ahead of UTC from 18:30 to 24:00 UTC: the clock is pinned there, so "today" is always the shop's.
    pinTheEveningClock();
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startW4Shop({ tenantId: T, databaseUrl: DATABASE_URL, pages: { '/compliance-registers': { html: 'compliance-registers.html', dataGlobal: 'complianceRegistersData' } } });
    await shop.ho().seedOwner(T, OWNER);
    await shop.ho().provisionRole(T, TILL, 'cashier');
    // A scanner's finding already on the register (the CI scanner's import), so the page shows both kinds.
    const report = { tool: 'semgrep', source: 'sast', runId: 'run-1', scannedAt: new Date(Date.now() - 3_600_000).toISOString(), complete: true,
      observations: [{ fingerprint: 'fp-no-eval-1', tool: 'semgrep', source: 'sast', ruleId: 'no-eval', title: 'eval used', severity: 'medium', toolSeverity: 'WARNING', location: 'apps/x.ts:1' }] };
    const r = await shop.ho().request({ method: 'POST', path: '/v1/compliance/finding-scans', userId: OWNER, tenantId: T, idempotencyKey: `seed-${randomUUID()}`, body: { report } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 240_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); vi.useRealTimers(); });

  it('the owner keeps licences with their evidence, controls with their incidents and checks, and the findings people raise', async () => {
    // The owner's own browser, on the same pinned evening as head office (a browser on UTC is on the shop's yesterday).
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    await context.addCookies([{ name: 'who', value: OWNER, domain: new URL(shop.base).hostname, path: '/' }]);
    await pinThePageClock(context);
    const p = await context.newPage();
    p.setDefaultTimeout(15_000);
    const s = { page: p, errors: [] as string[], writes: [] as string[], close: () => context.close() };
    p.on('pageerror', (e) => s.errors.push(e.message));
    p.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') s.writes.push(`${r.method()} ${u.pathname}`); });
    await p.goto(`${shop.base}/compliance-registers`, { waitUntil: 'load' });
    try {
      await says(p, '#lic-list', /No licence or certificate is on the register yet\./);
      expect(s.writes, 'nothing is written on open').toEqual([]);

      // M34-FR-03 — the FSSAI licence, expiring in 20 shop days, with the person who must renew it.
      const expires = shopDayPlus(20);
      await p.selectOption('#lic-kind', 'licence');
      await p.fill('#lic-name', 'FSSAI licence (test)'); await p.fill('#lic-authority', 'FSSAI'); await p.fill('#lic-reference', '10020000000001');
      await p.fill('#lic-from', shopDayPlus(-345)); await p.fill('#lic-expires', expires); await p.fill('#lic-branch', 'br-1');
      await p.fill('#lic-person', 'u-mgr'); await p.fill('#lic-person-name', 'Meena (test)');
      await p.click('#lic-go');
      await says(p, '#lic-status', /^Saved on the register\.$/);
      await says(p, '#lic-alerts', new RegExp(`FSSAI licence \\(test\\)[\\s\\S]*expires ${expires} · 20 days left[\\s\\S]*person to act: Meena \\(test\\) \\(u-mgr\\)`));
      await says(p, '#lic-gaps', /FSSAI licence \(test\)/);

      // Its evidence: the gap clears and the copy is listed.
      await p.selectOption('#ev-which', { label: 'FSSAI licence (test)' });
      await p.fill('#ev-ref', 'DOC-FSSAI-1'); await p.fill('#ev-what', 'licence copy, scanned');
      await p.click('#ev-go');
      await says(p, '#lic-status', /^Evidence filed\.$/);
      await says(p, '#lic-gaps', /Every licence in force has evidence on file\./);
      await says(p, '#lic-list', /evidence on file: DOC-FSSAI-1 — licence copy, scanned/);

      // A scale's stamping certificate, closed with a reason — kept on the register.
      await p.selectOption('#lic-which', '');
      await p.selectOption('#lic-kind', 'calibration');
      await p.fill('#lic-name', 'Scale 2 stamping (test)'); await p.fill('#lic-authority', 'Legal Metrology'); await p.fill('#lic-from', shopDayPlus(-30));
      await p.fill('#lic-person', 'u-mgr'); await p.fill('#lic-person-name', 'Meena (test)');
      await p.click('#lic-go');
      await says(p, '#lic-list', /Scale 2 stamping \(test\) · Scale stamping or calibration · In force/);
      await p.selectOption('#cl-which', { label: 'Scale 2 stamping (test)' });
      await p.fill('#cl-why', 'scale scrapped');
      await p.click('#cl-go');
      await says(p, '#lic-status', /^Closed\. It stays on the register with its reason\.$/);
      await says(p, '#lic-list li[data-status="closed"]', /Scale 2 stamping \(test\)[\s\S]*reason: scale scrapped/);

      // M34-FR-04 — a control, never checked; an incident, its remediation, done; a dated check in the owner's name.
      await p.fill('#ctl-title', 'Backups encrypted (test)'); await p.fill('#ctl-impl', 'P-04'); await p.fill('#ctl-owner', 'u-owner');
      await p.click('#ctl-go');
      await says(p, '#ctl-list', /Backups encrypted \(test\)[\s\S]*0 incident\(s\) · 0 remediation\(s\) late · Never checked/);
      await p.fill('#inc-title', 'Backup left unencrypted (test)'); await p.selectOption('#inc-sev', 'sev2');
      await p.fill('#inc-occ', `${shopDayPlus(-1)}T22:30`); await p.fill('#inc-det', `${shopDayPlus(-1)}T23:00`);
      await p.click('#inc-go');
      await says(p, '#ctl-list', new RegExp(`Backup left unencrypted \\(test\\) · Serious \\(sev 2\\) · ${shopDayPlus(-1)} 22:30`));
      await expect.poll(() => p.locator('#rem-inc option').count()).toBe(1);
      await p.fill('#rem-action', 'rotate the backup key'); await p.fill('#rem-owner', 'u-owner'); await p.fill('#rem-due', shopDayPlus(7));
      await p.click('#rem-go');
      await says(p, '#ctl-list', new RegExp(`rotate the backup key · owner u-owner · due ${shopDayPlus(7)}`));
      await p.click('#ctl-list li[data-remediation] button');
      await says(p, '#ctl-status', /^Remediation marked done\.$/);
      await says(p, '#ctl-list', /rotate the backup key · owner u-owner · done/);
      await p.fill('#att-stmt', 'restored last night\'s backup to a spare disk');
      await p.click('#att-go');
      await says(p, '#ctl-status', /^Your check is recorded/);
      await says(p, '#ctl-list', /✓ restored last night's backup to a spare disk · checked by u-owner/);
      await says(p, '#ctl-list', /1 incident\(s\) · 0 remediation\(s\) late · last checked/);

      // OB-331 — a penetration-test finding: recorded, owned, fixed with evidence. The scanner's has no "fixed" button.
      await says(p, '#fnd-list', /eval used/);
      expect(await p.locator('#fnd-list li .fix-go').count()).toBe(0);
      await p.selectOption('#fnd-source', 'pentest'); await p.selectOption('#fnd-sev', 'high');
      await p.fill('#fnd-title', 'Login has no lockout (test)'); await p.fill('#fnd-loc', '/login');
      await p.click('#fnd-go');
      await says(p, '#fnd-status', /^Finding recorded\.$/);
      const row = '#fnd-list li[data-finding^="pentest-"]';
      await says(p, row, /High · Login has no lockout \(test\)[\s\S]*Penetration test · where: \/login · Open[\s\S]*owner: nobody owns it yet/);
      await p.fill(`${row} .owner-in`, 'u-it');
      await p.click(`${row} .owner-go`);
      await says(p, row, /owner: u-it/);
      await p.fill(`${row} .fix-in`, 'lockout after 5 tries; tried 6 and was locked out');
      await p.click(`${row} .fix-go`);
      await says(p, '#fnd-status', /^Recorded fixed, with your evidence\.$/);
      await says(p, row, /✓ High · Login has no lockout[\s\S]*Fixed[\s\S]*fixed by u-owner: lockout after 5 tries/);
      expect(await p.locator('#fnd-list li[data-finding^="semgrep"] .fix-go, #fnd-list li[data-status="open"]:not([data-finding^="pentest-"]) .fix-go').count()).toBe(0);

      // Tamil.
      await p.click('#lang');
      await says(p, '#lic-h', /^உரிமங்களும் சான்றிதழ்களும்$/);
      await says(p, '#att-go', /^என் சரிபார்ப்பைப் பதிவு செய்$/);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    await shop.restart();
    const obl = await read<{ obligations: { name: string; status: string; evidence?: unknown[]; responsible: { userId: string } }[] }>('/v1/compliance/obligations');
    expect(obl.obligations.map((o) => [o.name, o.status, (o.evidence ?? []).length, o.responsible.userId])).toEqual([['FSSAI licence (test)', 'active', 1, 'u-mgr'], ['Scale 2 stamping (test)', 'closed', 0, 'u-mgr']]);
    const reg = await read<{ incidents: { controlId: string }[]; remediations: { completedAt?: string }[]; attestations: { attestedBy: string }[]; controls: { controlId: string }[] }>('/v1/compliance/control-register');
    expect(reg.incidents.map((i) => i.controlId)).toEqual(reg.controls.map((c) => c.controlId));
    expect(reg.remediations[0]?.completedAt).toMatch(/^\d{4}-/);
    expect(reg.attestations.map((a) => a.attestedBy)).toEqual(['u-owner']);
    const f = await read<{ findings: { source: string; status: string; ownerUserId?: string; fixedBy?: string }[] }>('/v1/compliance/findings');
    expect(f.findings.find((x) => x.source === 'pentest')).toMatchObject({ status: 'fixed', ownerUserId: 'u-it', fixedBy: 'u-owner' });
  }, 240_000);

  it('a cashier is told these registers are not his role\'s to see — nothing shown, nothing sent', async () => {
    const s = await openAs(shop, browser, TILL, '/compliance-registers');
    try {
      await says(s.page, '#page-status', /^Your role cannot see these registers\.$/);
      for (const id of ['#lic-s', '#ctl-s', '#fnd-s']) expect(await s.page.isVisible(id)).toBe(false);
      expect(s.writes).toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  });
});
