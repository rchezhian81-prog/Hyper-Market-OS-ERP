import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startW4Shop, openAs, says, type W4Shop } from './lib/w4-office-shop';

/**
 * **W5 — the Payroll page's statutory checks (C15 · C16 · C19 · OB-208 · OB-209) and the committee's confidential complaints
 * register (C20 · OB-157), in a real browser, on the production API surface over real PostgreSQL when DATABASE_URL is set.**
 *   • the CA (chartered_accountant) opens Payroll and sees ONLY the legal figures, every one "not confirmed"; head office
 *     refuses an overtime multiplier below 2× by name; 200% is saved and shows confirmed;
 *   • the owner prepares a payslip for review (hours from attendance, never typed) — "prepared, not issued", with what was
 *     not checked; the month's check lists it and says approving, locking and the bank file stay on hold; EPF/ESI totals are
 *     recorded and compared; the payslip not issued by its pay date is listed; nobody has been issued one. Every write the
 *     page sent is one of the three compute-and-record routes — never an issue, approve, lock or bank file (OB-209);
 *   • the Internal Committee receives a complaint, starts the inquiry and disposes of it, and reads the access log; the
 *     owner and the store manager open the committee page and are told the register is the committee's alone — head office
 *     refuses them too (403) — and the complaint's words appear nowhere on their pages.
 * Synthetic data only: a fresh random tenant, made-up staff numbers and amounts.
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER = 'u-owner'; const CA = 'u-ca'; const IC = 'u-ic'; const MGR = 'u-mgr';
const EMP = 'E-W5-1';
const COMPLAINT_WORDS = 'SYNTHETIC CONFIDENTIAL WORDS 7731';

describe.skipIf(!existsSync(CHROMIUM))('W5 pay checks and the committee register (PostgreSQL when set), in a real browser', () => {
  let browser: Browser;
  let shop: W4Shop;
  const T = randomUUID();
  const call = (userId: string, path: string, body?: unknown) => shop.ho().request({
    method: body === undefined ? 'GET' : 'POST', path, userId, tenantId: T, ...(body === undefined ? {} : { idempotencyKey: `k-${randomUUID()}`, body }),
  });
  const ok = async (p: ReturnType<typeof call>, what: string): Promise<unknown> => { const r = await p; if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`); return r.body; };

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startW4Shop({
      tenantId: T, databaseUrl: DATABASE_URL,
      pages: {
        '/payroll': { html: 'payroll.html', dataGlobal: 'payrollData' },
        '/posh-committee': { html: 'posh-committee.html', dataGlobal: 'poshCommitteeData' },
      },
    });
    await shop.ho().seedOwner(T, OWNER);
    await shop.ho().provisionRole(T, CA, 'chartered_accountant');
    await shop.ho().provisionRole(T, IC, 'internal_committee');
    await shop.ho().provisionRole(T, MGR, 'store_manager');
    // A synthetic person in the staff directory, and the hours attendance holds for them in January.
    await ok(call(OWNER, `/v1/hr/workforce/employees/${EMP}`, { name: 'Staff A', branchId: 'br-1', roles: ['cashier'], active: true, hourlyRateMinor: 10_000 }), 'employee');
    for (const d of ['2026-01-05', '2026-01-06']) await ok(call(OWNER, `/v1/hr/workforce/attendance/${EMP}/${d}`, { hours: 8 }), `attendance ${d}`);
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 240_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  it('C19 · C16 · OB-208: the CA sees only the legal figures; overtime below 2× is refused by head office; 200% is confirmed', async () => {
    const s = await openAs(shop, browser, CA, '/payroll');
    try {
      await says(s.page, '#ps-figures [data-figure="overtimeMultiplierPercent"]', /not confirmed/);
      expect(await s.page.locator('#ps-prepare').count(), 'the CA prepares no payslip').toBe(0);
      await s.page.selectOption('#ps-fig-key', 'overtimeMultiplierPercent');
      await s.page.fill('#ps-fig-value', '150'); await s.page.fill('#ps-fig-source', 'Code on Wages 2019'); await s.page.fill('#ps-fig-conf', 'CA synthetic ref 1');
      await s.page.click('#ps-fig-save');
      await says(s.page, '#ps-fig-status', /^Head office refused: overtime below 2×/);
      await s.page.fill('#ps-fig-value', '200');
      await s.page.click('#ps-fig-save');
      await says(s.page, '#ps-figures [data-figure="overtimeMultiplierPercent"]', /200 .* · confirmed/);
      await says(s.page, '#ps-fig-status', /^Saved on head office\.$/);
      expect(s.writes).toEqual(['POST /v1/hr/payroll/legal-settings/overtimeMultiplierPercent', 'POST /v1/hr/payroll/legal-settings/overtimeMultiplierPercent']);
      await s.page.click('#lang');
      await says(s.page, '#ps-legal h3', /^தணிக்கையாளரின் சட்ட எண்கள்$/);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  }, 120_000);

  it('C15 · C16 · C19 · OB-209: the owner prepares, checks and compares — compute and show only', async () => {
    const s = await openAs(shop, browser, OWNER, '/payroll');
    try {
      await says(s.page, '#ps-hold', /stay on hold \(owner decision OB-209\)/);
      await s.page.fill('#ps-pr-emp', EMP); await s.page.fill('#ps-pr-period', '2026-01'); await s.page.fill('#ps-pr-date', '2026-02-07');
      await s.page.fill('#ps-pr-days', '31'); await s.page.fill('#ps-pr-basic', '15000');
      await s.page.click('#ps-pr-go');
      await says(s.page, '#ps-pr-result', /E-W5-1 · 2026-01Prepared for review — not issued\./);
      await says(s.page, '#ps-pr-result', /Hours worked16/);
      await says(s.page, '#ps-pr-notchecked', /^Not checked: .*minimum wage not checked/i);

      await s.page.fill('#ps-ck-period', '2026-01');
      await s.page.click('#ps-ck-go');
      await says(s.page, '#ps-ck-slips [data-employee="E-W5-1"]', /2026-02-07 · prepared by u-owner/);
      await says(s.page, '#ps-ck-hold', /Approving, locking and the bank file stay on hold \(OB-209\)/);

      await s.page.fill('#ps-ct-period', '2026-01');
      for (const id of ['#ps-ct-pfe', '#ps-ct-pfr', '#ps-ct-esie', '#ps-ct-esir']) await s.page.fill(id, '0');
      await s.page.click('#ps-ct-save');
      await says(s.page, '#ps-ct-status', /^Fill in every field first\.$/);
      await s.page.fill('#ps-ct-ref', 'ECR-SYNTH-01');
      await s.page.click('#ps-ct-save');
      await says(s.page, '#ps-ct-result', /No payslip issued for this month\./);

      await s.page.fill('#ps-lt-period', '2026-01');
      await s.page.click('#ps-lt-go');
      await says(s.page, '#ps-lt-rows [data-employee="E-W5-1"]', /E-W5-1/);

      await s.page.fill('#ps-is-emp', EMP);
      await s.page.click('#ps-is-go');
      await says(s.page, '#ps-is-rows', /^No payslip has been issued to this person\.$/);

      expect(s.writes).toEqual([`POST /v1/hr/payroll/statutory-payslips/${EMP}/2026-01`, 'POST /v1/hr/payroll/contributions/2026-01/totals']);
      for (const w of s.writes) expect(w).not.toMatch(/\/payslips\/|pay-run|bank-file|release-switch|journal/);
      expect(await s.page.locator('#stat-checks button', { hasText: /issue|approve|lock|bank/i }).count(), 'no issue, approve, lock or bank-file button').toBe(0);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
    // Head office's own record: prepared, never issued.
    const issued = await ok(call(OWNER, `/v1/hr/payroll/payslips/${EMP}`), 'issued') as { count: number };
    expect(issued.count).toBe(0);
  }, 120_000);

  it('C20 · OB-157: the committee keeps its register; the owner and the store manager are refused, by the page and by head office', async () => {
    const ic = await openAs(shop, browser, IC, '/posh-committee');
    try {
      await ic.page.waitForSelector('#reg-body:not([hidden])');
      await ic.page.click('#reg-show');
      await says(ic.page, '#reg-rows', /No complaint is in the register\./);
      await ic.page.fill('#rc-on', '2026-10-20'); await ic.page.fill('#rc-c', 'CMP-REF-A'); await ic.page.fill('#rc-r', 'RSP-REF-B'); await ic.page.fill('#rc-s', COMPLAINT_WORDS);
      await ic.page.click('#rc-save');
      await says(ic.page, '#rc-status', /^Recorded in the register\. PC-[0-9A-F]{20}$/);
      const id = (await ic.page.getAttribute('#reg-rows li[data-complaint]', 'data-complaint'))!;
      await says(ic.page, `#reg-rows li[data-complaint="${id}"]`, new RegExp(`${id} · Received.*${COMPLAINT_WORDS}`));
      await ic.page.selectOption(`#st-kind-${id}`, 'inquiry_started'); await ic.page.fill(`#st-on-${id}`, '2026-10-22');
      await ic.page.click(`#reg-rows li[data-complaint="${id}"] button`);
      await says(ic.page, `#reg-rows li[data-complaint="${id}"][data-status="under_inquiry"]`, /Under inquiry/);
      await ic.page.selectOption(`#st-kind-${id}`, 'disposed'); await ic.page.fill(`#st-on-${id}`, '2026-10-30');
      await ic.page.click(`#reg-rows li[data-complaint="${id}"] button`);
      await says(ic.page, `#reg-rows li[data-complaint="${id}"] .status`, /^Choose the step and give its date/);
      await ic.page.selectOption(`#st-outcome-${id}`, 'conciliation');
      await ic.page.click(`#reg-rows li[data-complaint="${id}"] button`);
      await says(ic.page, `#reg-rows li[data-complaint="${id}"][data-status="disposed"]`, /Outcomesettled by conciliation · Disposed of on 2026-10-30/);
      await ic.page.click('#log-show');
      await says(ic.page, '#log-rows', /u-ic · what posh\.complaint\.receive/);
      expect(ic.writes).toEqual(['POST /v1/hr/posh/complaints', `POST /v1/hr/posh/complaints/${id}/steps`, `POST /v1/hr/posh/complaints/${id}/steps`]);
      await ic.page.click('#lang');
      await says(ic.page, '#reg-h', /^புகார்ப் பதிவேடு \(குழு மட்டும்\)$/);
      expect(ic.errors).toEqual([]);
    } finally { await ic.close(); }

    for (const who of [OWNER, MGR]) {
      const s = await openAs(shop, browser, who, '/posh-committee');
      try {
        await says(s.page, '#reg-status', /^Only the Internal Committee may see the complaints register\.$/);
        expect(await s.page.isHidden('#reg-body')).toBe(true);
        expect(await s.page.content()).not.toContain(COMPLAINT_WORDS);
        expect(await s.page.content()).not.toContain('CMP-REF-A');
        expect(s.writes).toEqual([]);
        expect(s.errors).toEqual([]);
      } finally { await s.close(); }
      for (const path of ['/v1/hr/posh/complaints', '/v1/hr/posh/access-log']) expect((await call(who, path)).status, `${who} ${path}`).toBe(403);
      expect((await call(who, '/v1/hr/posh/complaints', { receivedOn: '2026-10-21', complainantRef: 'x', respondentRef: 'y', summary: 'z' })).status, `${who} records`).toBe(403);
    }
  }, 120_000);
});
