import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, ok, type InboxShop } from './lib/ai-inbox-shop';
import { auditPage } from './lib/a11y-audit';

/**
 * OB-288 LP/workforce package — the people and loss-prevention pages in a real browser, on the PRODUCTION API over real
 * PostgreSQL: Help and procedures (M25-FR-04: a cashier sees the cashier procedure and acknowledges it in their own name),
 * Related parties (M15-FR-03 · OB-301: a relative's number shown masked; taken off the list by its own door, with a
 * reason), Training and adoption (QG-09 "not proven" until the owner approves a role's curriculum, OB-320), Appointment
 * letters (C17 · OB-323: the owner's words, a letter made from the record, the signed copy kept) and the Investigations
 * page's "From the shop's own records" (M15-FR-02: the owner's staff-buying numbers "not set"). English and Tamil; every
 * button its icon. Needs DATABASE_URL and Chromium; else it SKIPS. Synthetic data only.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['lpw', 'people', 'e2e', 'key'].join('-').padEnd(48, '0');
/** A 1×1 PNG — the photo of the signed letter, synthetic. */
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
const TODAY = new Date().toISOString().slice(0, 10);

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the people and loss-prevention pages (OB-288 LP/workforce) on the production API, in a real browser', () => {
  let browser: Browser;
  let shop: InboxShop;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/help', html: 'help.html', dataGlobal: 'helpData' },
      alsoPages: [
        { path: '/related-parties', html: 'related-parties.html', dataGlobal: 'relatedPartiesData' },
        { path: '/adoption', html: 'adoption.html', dataGlobal: 'adoptionData' },
        { path: '/appointment-letters', html: 'appointment-letters.html', dataGlobal: 'appointmentLettersData' },
        { path: '/loss-prevention', html: 'loss-prevention.html', dataGlobal: 'lossPreventionInboxData' },
      ],
      seed: async (cloud) => {
        await cloud.grant('u-mgr', 'store_manager');
        await cloud.grant('u-cash', 'cashier', undefined, ['br-1']);
        await ok(cloud.request({ method: 'POST', path: '/v1/hr/workforce/employees/u-cash', userId: 'u-mgr', idempotencyKey: 'emp-cash', body: { name: 'Asha', branchId: 'br-1', roles: ['cashier'], active: true, hourlyRateMinor: 12_500 } }), 'employee');
        // OB-357: a department of br-1, and a shift today with Asha on it — her hours, before she has a home department.
        await ok(cloud.request({ method: 'POST', path: '/v1/org/nodes/D-dairy', userId: 'u-owner', idempotencyKey: 'dept-dairy', body: { kind: 'department', name: 'Dairy', parentId: 'br-1' } }), 'department');
        await ok(cloud.request({ method: 'POST', path: '/v1/hr/workforce/shifts/SH-1', userId: 'u-mgr', idempotencyKey: 'shift-1', body: { branchId: 'br-1', startsAt: `${TODAY}T02:30:00.000Z`, endsAt: `${TODAY}T10:30:00.000Z`, requiredRoles: [{ role: 'cashier', count: 1 }] } }), 'shift');
        await ok(cloud.request({ method: 'POST', path: '/v1/hr/workforce/shifts/SH-1/assignments/u-cash', userId: 'u-mgr', idempotencyKey: 'assign-1', body: { role: 'cashier' } }), 'assign');
        await ok(cloud.request({ method: 'POST', path: '/v1/hr/workforce/help/built-in/SOP-01/publish', userId: 'u-mgr', idempotencyKey: 'pub-1', body: {} }), 'publish SOP-01');
        await ok(cloud.request({ method: 'POST', path: '/v1/hr/workforce/help/built-in/SOP-03/publish', userId: 'u-mgr', idempotencyKey: 'pub-3', body: {} }), 'publish SOP-03');
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  const open = async (who: string, path: string, branch?: string): Promise<{ page: Page; errors: string[]; close: () => Promise<void> }> => {
    const context = await browser.newContext();
    await shop.signIn(context, who, branch);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${shop.base}${path}`, { waitUntil: 'load' });
    return { page, errors, close: () => context.close() };
  };
  const waitText = (page: Page, selector: string, text: string) => page.waitForFunction(([sel, want]) => {
    const node = (globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector(sel!);
    return (node?.textContent ?? '').includes(want!);
  }, [selector, text], { timeout: 15_000 });

  it('help: a cashier reads the cashier procedure — never the owner\'s — and acknowledges it in their own name; Tamil', async () => {
    const { page, errors, close } = await open('u-cash', '/help', 'br-1');
    await page.locator('#sops article[data-sop="SOP-01"]').waitFor({ timeout: 15_000 });
    expect(await page.locator('#sops article[data-sop="SOP-03"]').count()).toBe(0);
    expect(await page.isHidden('#manage')).toBe(true);
    expect((await page.textContent('#contact-rows')) ?? '').toContain('not set');
    const ack = page.locator('#sops article[data-sop="SOP-01"] button[data-act="ack"]');
    expect(await ack.locator('svg').count()).toBe(1);
    await ack.click();
    await waitText(page, '#ack-status', 'Saved.');
    await waitText(page, '#sops article[data-sop="SOP-01"]', '✓ You have read this version');
    const help = (await shop.cloud().request({ method: 'GET', path: '/v1/hr/workforce/help', userId: 'u-cash', branchId: 'br-1' })).body as { sops: { sopId: string; upToDate: boolean }[] };
    expect(help.sops.find((s) => s.sopId === 'SOP-01')?.upToDate).toBe(true);
    expect(await auditPage(page, { expectLang: 'en' }), 'the help page').toEqual([]);
    await page.click('#lang');
    expect(await page.textContent('#page-h')).toBe('உதவி மற்றும் நடைமுறைகள்');
    expect(errors).toEqual([]);
    await close();
  }, 120_000);

  it('related parties: a relative\'s number shown masked; taken off the list with a reason; a cashier opens nothing', async () => {
    const { page, errors, close } = await open('u-owner', '/related-parties');
    await page.waitForSelector('#parties:not([hidden])');
    await page.fill('#p-id', 'RP-1'); await page.fill('#p-name', 'Ravi'); await page.selectOption('#p-kind', 'person');
    await page.fill('#p-relation', 'store manager\'s cousin'); await page.fill('#p-phones', '98400 12345');
    expect(await page.locator('#p-save svg').count()).toBe(1);
    await page.click('#p-save');
    await page.locator('#p-rows li[data-party="RP-1"]').waitFor({ timeout: 15_000 });
    expect((await page.textContent('#p-rows li[data-party="RP-1"]')) ?? '').toContain('98****2345');
    expect((await page.textContent('#p-rows li[data-party="RP-1"]')) ?? '').not.toContain('9840012345');
    await page.click('#p-rows li[data-party="RP-1"] button[data-act="take-off"]');
    await waitText(page, '#p-status', 'Write why it comes off the list first.');
    await page.fill('#p-rows li[data-party="RP-1"] input.take-off-why', 'no longer related');
    await page.click('#p-rows li[data-party="RP-1"] button[data-act="take-off"]');
    await waitText(page, '#p-rows li[data-party="RP-1"]', '(taken off)');
    expect(await auditPage(page, { expectLang: 'en' }), 'the related-parties page').toEqual([]);
    // The entry's facts were kept: still matched on the stored number, not on the masked one shown.
    const list = (await shop.cloud().request({ method: 'GET', path: '/v1/loss-prevention/related-parties', userId: 'u-owner' })).body as { count: number; active: number };
    expect([list.count, list.active]).toEqual([1, 0]);
    expect(errors).toEqual([]);
    await close();
    const c = await open('u-cash', '/related-parties', 'br-1');
    expect(await c.page.textContent('#page-status')).toBe('Your role cannot open this page.');
    await c.close();
  }, 120_000);

  it('training and adoption: QG-09 is "not proven" until the owner approves the role\'s list on screen', async () => {
    const { page, errors, close } = await open('u-owner', '/adoption');
    await waitText(page, '#gate-verdict', 'Not proven');
    expect(await page.getAttribute('#gate-verdict', 'data-verdict')).toBe('NOT_PROVEN');
    const cashier = page.locator('#cur-roles .role-block[data-role="cashier"]');
    await cashier.waitFor({ timeout: 15_000 });
    expect((await cashier.textContent()) ?? '').toContain('not approved');
    await cashier.locator('button[data-approve="cashier"]').click();
    await waitText(page, '#cur-status', 'Saved.');
    await waitText(page, '#cur-roles .role-block[data-role="cashier"]', 'approved, version 1');
    // OB-357: sales per labour hour — Asha has no home department yet: her 8 hours are "not attributed", by name.
    await page.fill('#pr-from', TODAY); await page.fill('#pr-to', TODAY);
    await page.click('#pr-read');
    await waitText(page, '#pr-rows li[data-row="not-attributed"]', 'Asha (u-cash, 8)');
    expect(await page.locator('#pr-read svg').count()).toBe(1);
    // The manager sets her home department on the staff record; the hours then count to dairy.
    await page.waitForSelector('#home-dept:not([hidden])');
    await page.fill('#hd-emp', 'u-cash');
    await page.waitForFunction(() => (globalThis as unknown as { document: { querySelector(s: string): { options: { length: number } } | null } }).document.querySelector('#hd-dept')!.options.length > 1);
    await page.selectOption('#hd-dept', 'D-dairy');
    expect(await page.locator('#hd-set svg').count()).toBe(1);
    await page.click('#hd-set');
    await waitText(page, '#hd-status', 'Saved.');
    await page.click('#pr-read');
    await waitText(page, '#pr-rows li[data-row="D-dairy"]', '8 rostered hours');
    expect(await page.locator('#pr-rows li[data-row="not-attributed"]').count()).toBe(0);
    expect(await auditPage(page, { expectLang: 'en' }), 'the adoption page').toEqual([]);
    await page.click('#lang');
    expect(await page.textContent('#page-h')).toBe('பயிற்சி மற்றும் ஏற்பு');
    expect(await page.textContent('#hd-h')).toBe('சொந்தப் பிரிவு (பணியாளர் பதிவில்)');
    expect(errors).toEqual([]);
    await close();
  }, 120_000);

  it('appointment letters: "not set" until the owner writes the words; a letter made from the record; the signed copy kept', async () => {
    const owner = await open('u-owner', '/appointment-letters');
    await waitText(owner.page, '#wording-now', 'not set');
    await owner.page.fill('#wd-en', 'Dear {{employeeName}}, you are appointed as {{roles}} from {{effectiveFrom}}.');
    await owner.page.fill('#wd-ta', 'அன்புள்ள {{employeeName}}, நீங்கள் {{effectiveFrom}} முதல் {{roles}} ஆக நியமிக்கப்படுகிறீர்கள்.');
    await owner.page.click('#wd-save');
    await waitText(owner.page, '#wording-now', 'version 1');
    expect(owner.errors).toEqual([]);
    await owner.close();

    const { page, errors, close } = await open('u-mgr', '/appointment-letters');
    await page.waitForSelector('#make:not([hidden])');
    expect(await page.isHidden('#wording-form')).toBe(true); // the words are the owner's
    await page.fill('#mk-emp', 'u-cash'); await page.fill('#mk-from', TODAY);
    await page.click('#mk-save');
    await waitText(page, '#mk-status', 'Saved.');
    const row = page.locator('#letter-rows li[data-employee="u-cash"]');
    await row.waitFor({ timeout: 15_000 });
    expect((await row.textContent()) ?? '').toContain(`Dear Asha, you are appointed as cashier from ${TODAY}.`);
    expect((await row.textContent()) ?? '').toContain('Signed copy not kept yet');
    await row.locator('input[type="file"]').setInputFiles({ name: 'signed.png', mimeType: 'image/png', buffer: PNG });
    await row.locator('button[data-act="keep"]').click();
    await waitText(page, '#letter-rows li[data-employee="u-cash"]', '✓ Signed copy kept');
    expect(await auditPage(page, { expectLang: 'en' }), 'the appointment-letters page').toEqual([]);
    expect(errors).toEqual([]);
    await close();
  }, 120_000);

  it('investigations: the shop\'s own records read on a click; the owner\'s staff-buying numbers say "not set"', async () => {
    const { page, errors, close } = await open('u-owner', '/loss-prevention');
    await page.waitForSelector('#rec:not([hidden])');
    expect(await page.locator('#rec-read svg').count()).toBe(1);
    await page.click('#rec-read');
    await page.waitForSelector('#rec-result:not([hidden])', { timeout: 15_000 });
    expect((await page.textContent('#rec-policy')) ?? '').toContain('Staff discount (owner): not set');
    expect((await page.textContent('#rec-sources')) ?? '').toContain('Coupons:');
    expect((await page.textContent('#rec-bank-note')) ?? '').toContain('staff salary accounts compared');
    expect(errors).toEqual([]);
    await close();
  }, 120_000);
});
