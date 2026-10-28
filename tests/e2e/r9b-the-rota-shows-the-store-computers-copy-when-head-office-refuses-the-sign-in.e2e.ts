import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { wallClockIn } from '../../packages/calendar/src/trading-day';
import { startStandInIdentityServer, standInPerson, type StandInIdentityServer } from '../support/stand-in-identity-server';
import { startStandInHeadOffice, type StandInHeadOffice } from '../support/stand-in-head-office';

/**
 * **Round 9 · OB-539 (M25-FR-01 · ADR-0029 · P-08) in a real browser on the REAL store computer with head office's sign-in on.**
 *
 * The manager opens the Rota on the store PC:
 *   1. nobody is signed in to head office on this PC, so the store computer refuses to carry the roster read (401): the page
 *      shows the STORE COMPUTER'S COPY of the roster, saying plainly that head office refused this computer's head-office
 *      sign-in, with when head office last sent it and how old it is — READ-ONLY (no assign form, nothing sent); in Tamil too;
 *   2. the manager signs in to head office with their own login and second step: head office's live roster comes back, with
 *      the assign form — the copy's words are gone;
 *   3. head office then stops believing that sign-in (signed out everywhere — 401 from head office itself): on reload the page
 *      is back on the store computer's copy, saying head office refused the sign-in, never an empty "no gaps".
 * Skips where no browser binary is present.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['r9b', 'rota', 'sign', 'in', 'key'].join('-').padEnd(48, '0');
const TENANT = 't-sre';
const asAt = new Date(Date.now() - 2 * 3_600_000 - 5 * 60_000).toISOString(); // two hours and five minutes ago
const inDays = (n: number, hh: string): string => new Date(Date.now() + n * 86_400_000).toISOString().replace(/T.*/, `T${hh}:00:00.000Z`);
const SHIFT = { shiftId: 'SH-1', branchId: 'store-1', startsAt: inDays(1, '00'), endsAt: inDays(1, '08'), requiredRoles: [{ role: 'cashier', count: 2 }] };
const EMPLOYEES = [{ employeeId: 'E-RANI', name: 'Rani', branchId: 'store-1', roles: ['cashier'], active: true }, { employeeId: 'E-ASHA', name: 'Asha', branchId: 'store-1', roles: ['cashier'], active: true }];
const ROSTER = { storeId: 'store-1', asAt, employees: EMPLOYEES, shifts: [SHIFT], assignments: [{ shiftId: 'SH-1', employeeId: 'E-RANI', role: 'cashier' }], published: [] };

interface Doc { readonly document: { readonly body: { readonly innerText: string } } }

describe.skipIf(!HAVE_BROWSER)('OB-539: the Rota shows the store computer\'s copy when head office refuses the store PC\'s sign-in', () => {
  let browser: Browser;
  let idp: StandInIdentityServer;
  let ho: StandInHeadOffice;
  let edge: EdgeProcess;
  let dir = '';
  const manager = standInPerson({ sreUserId: 'u-mgr', tenantId: TENANT });

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    idp = await startStandInIdentityServer();
    idp.people.set(manager.username, manager);
    ho = await startStandInHeadOffice({
      issuer: idp.issuer, publicKey: idp.publicKey, tenantId: TENANT, machineToken: randomBytes(24).toString('hex'),
      // Head office's live roster: Asha has since been put on the shift too — nothing is short.
      roster: () => ({ employees: EMPLOYEES, shifts: [SHIFT], assignments: [{ shiftId: 'SH-1', employeeId: 'E-RANI', role: 'cashier' }, { shiftId: 'SH-1', employeeId: 'E-ASHA', role: 'cashier' }] }),
      rosterGaps: () => [],
    });
    dir = await mkdtemp(join(tmpdir(), 'sre-r9b-rota-'));
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, JSON.stringify({
      version: 1, lossPreventionRules: [],
      policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1', timeZone: 'Asia/Kolkata' },
      rosteringPolicy: { userId: 'u-mgr', permissions: ['workforce.roster.read', 'workforce.roster.manage'] },
      roster: ROSTER,
      people: [{ userId: 'u-mgr', displayName: 'Manager Person', roleId: 'store_manager' }],
      roles: [{ id: 'store_manager', name: 'Store manager', permissions: ['workforce.roster.read', 'workforce.roster.manage'] }],
      roleAssignments: [{ userId: 'u-mgr', roleId: 'store_manager', branchScope: ['store-1'] }],
    }), 'utf8');
    edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_PACK_FILE: packFile,
      EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
      CLOUD_API_URL: ho.base, CLOUD_API_TOKEN: randomBytes(24).toString('hex'), EDGE_HEAD_OFFICE_SIGN_IN_ISSUER: idp.issuer,
    }, () => {}))!;
  }, 240_000);
  afterAll(async () => {
    await browser?.close();
    await edge?.stop();
    await ho?.stop();
    await idp?.stop();
    if (dir !== '') await rm(dir, { recursive: true, force: true });
  });

  const waitText = (page: Page, selector: string, text: string) => page.waitForFunction(([sel, want]) => {
    const node = (globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector(sel!);
    return (node?.textContent ?? '').includes(want!);
  }, [selector, text], { timeout: 15_000 });

  it('no head-office sign-in → the copy, saying head office refused it, read-only; signed in → live; signed out everywhere → the copy again', async () => {
    const base = `http://127.0.0.1:${edge.screens!.port}`;
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    const writes: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { if (r.method() !== 'GET' && new URL(r.url()).pathname.startsWith('/v1/')) writes.push(`${r.method()} ${new URL(r.url()).pathname}`); });
    const sentAt = wallClockIn(asAt, 'Asia/Kolkata').replace('T', ' ');
    const copyWords = `Head office refused this computer's head-office sign-in. This is the STORE COMPUTER'S COPY of the roster, as head office last sent it at ${sentAt} (2 hour(s) old). It may be out of date.`;

    // 1 — nobody signed in to head office on this PC: the box answers the roster read 401, and the page shows its copy.
    await page.goto(`${base}/rostering/`, { waitUntil: 'load' });
    await waitText(page, '#held-text', 'Head office refused this computer');
    expect(await page.textContent('#held-text')).toBe(copyWords);
    expect(await page.textContent('#read-only-text')).toBe('Read-only: changing the roster needs head office. Sign in to head office again on this computer, with your own login and second step, then reload.');
    expect(await page.textContent('#gap-count')).toBe('1 to fill');
    await waitText(page, '#rota-rows', 'Rani (cashier)');
    expect(await page.isHidden('#assigner')).toBe(true);
    expect(ho.calls.filter((c) => c.path.startsWith('/v1/hr/'))).toEqual([]); // the box carried nothing without a sign-in
    await page.click('#lang');
    await waitText(page, '#held-text', 'தலைமை அலுவலக உள்நுழைவைத் தலைமை அலுவலகம் மறுத்தது');
    expect(await page.textContent('#held-text')).toContain('கடைக் கணினி நகல்');
    expect(await page.textContent('#read-only-text')).toContain('படிக்க மட்டும்');

    // 2 — the manager signs in to head office with their own password and one-time code: head office's live roster.
    await page.goto(`${base}/login/?next=${encodeURIComponent('/rostering/')}`, { waitUntil: 'load' });
    await page.fill('#username', manager.username);
    await page.fill('#password', manager.password);
    await page.fill('#otp', manager.otp!);
    await Promise.all([page.waitForURL(`${base}/rostering/`), page.click('#kc-login')]);
    await waitText(page, '#gap-count', 'No gaps');
    expect(await page.isHidden('#held')).toBe(true);
    expect(ho.calls.filter((c) => c.path === '/v1/hr/workforce/roster').at(-1)).toMatchObject({ as: 'u-mgr', cookie: false });

    // 3 — head office stops believing the sign-in (signed out everywhere): it answers 401; the page is on the copy again.
    ho.revoked.add('u-mgr');
    await page.goto(`${base}/rostering/`, { waitUntil: 'load' });
    await waitText(page, '#held-text', 'Head office refused this computer');
    expect(await page.textContent('#held-text')).toBe(copyWords);
    expect(await page.isHidden('#assigner')).toBe(true);
    expect((await page.evaluate(() => (globalThis as unknown as Doc).document.body.innerText))).not.toContain('No gaps');
    expect(writes).toEqual([]);
    expect(errors).toEqual([]);
    await context.close();
  }, 120_000);
});
