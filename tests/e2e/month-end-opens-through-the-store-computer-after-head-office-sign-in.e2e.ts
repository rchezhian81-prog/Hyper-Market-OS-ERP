import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { issueTillPins, pinOf } from '../support/till-operator';
import { startStandInIdentityServer, standInPerson, type StandInIdentityServer } from '../support/stand-in-identity-server';
import { startStandInHeadOffice, type StandInHeadOffice } from '../support/stand-in-head-office';

/**
 * **OB-388 (owner, 26 Oct 2026) · ADR-0029 — in a real browser on the store PC: Month-end opens through the store computer
 * after the person's own head-office sign-in, and its figures are head office's answer to THEM.**
 *
 * A real store computer (office PIN on) serves the page; the identity server is a stand-in on ANOTHER site (`localhost`, as
 * a real one is), so the strict session cookie must survive the trip back exactly as it will in the shop. The person types
 * their staff ID and PIN, is sent to the head-office sign-in, types their password and one-time code, comes back, and
 * Month-end shows head office's answer ("No card or UPI payment is waiting for an answer"). Head office saw the call carry
 * THEIR token. Then head office goes down: the page says, in its own words, that head office cannot be reached; and with
 * the identity server down, the sign-in says so plainly instead of a browser error. The company report (OB-391) opens the
 * same way and shows head office's own branch name. Skips where no browser binary is present.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['month', 'end', 'ho', 'signin', 'key'].join('-').padEnd(48, '0');
const TENANT = 't-sre';

interface Doc { readonly document: { readonly body: { readonly innerText: string } } }

describe.skipIf(!HAVE_BROWSER)('OB-388: Month-end through the store computer after head-office sign-in', () => {
  let browser: Browser;
  let idp: StandInIdentityServer;
  let ho: StandInHeadOffice;
  let edge: EdgeProcess;
  let dir = '';
  const owner = standInPerson({ sreUserId: 'u-owner', tenantId: TENANT });

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    idp = await startStandInIdentityServer();
    idp.people.set(owner.username, owner);
    ho = await startStandInHeadOffice({ issuer: idp.issuer, publicKey: idp.publicKey, tenantId: TENANT, machineToken: randomBytes(24).toString('hex') });
    dir = await mkdtemp(join(tmpdir(), 'sre-month-end-ho-'));
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, JSON.stringify({
      version: 1, lossPreventionRules: [], policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1' },
      people: [{ userId: 'u-owner', displayName: 'Owner Person', roleId: 'owner' }],
      roles: [{ id: 'owner', name: 'Owner', permissions: ['identity.self.read', 'finance.period.read', 'reporting.report.read', 'org.branch.read'] }],
      roleAssignments: [{ userId: 'u-owner', roleId: 'owner', branchScope: 'all' }],
    }), 'utf8');
    await issueTillPins(dir, KEY, ['u-owner']);
    edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_PACK_FILE: packFile,
      EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_OFFICE_SIGN_IN: 'pin',
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

  it('PIN → head-office password and one-time code → back → Month-end shows head office\'s answer to this person; down is said', async () => {
    const base = `http://127.0.0.1:${edge.screens!.port}`;
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);

    // 1 — the office PIN on the store PC.
    await page.goto(`${base}/finance-close/`, { waitUntil: 'load' });
    await page.fill('#office-staff', 'u-owner');
    await page.fill('#office-pin', pinOf('u-owner'));
    await Promise.all([page.waitForURL(/\/realms\/sre-store\/protocol\/openid-connect\/auth/), page.click('#office-submit')]);

    // 2 — the head-office sign-in, on the identity server's own site: password AND the one-time code.
    expect(new URL(page.url()).host).toBe(new URL(idp.issuer).host);
    await page.fill('#username', owner.username);
    await page.fill('#password', owner.password);
    await page.fill('#otp', owner.otp!);
    await Promise.all([page.waitForURL(`${base}/finance-close/`), page.click('#kc-login')]);

    // 3 — Month-end, through the store computer, with head office's own answer for this person.
    await page.waitForFunction(() => /No card or UPI payment is waiting for an answer/.test((globalThis as unknown as Doc).document.body.innerText));
    const call = ho.calls.filter((c) => c.path === '/v1/finance/payment-exceptions').at(-1);
    expect(call).toMatchObject({ as: 'u-owner', cookie: false });
    expect(await page.textContent('#sre-office-bar')).toContain('Owner Person');
    const cookies = await context.cookies(); // (a Secure cookie on this PC's loopback: Playwright lists it unfiltered)
    const session = cookies.find((c) => c.name === 'sre_session')!;
    expect(session).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict' });

    // 4 — the company report (OB-391) opens the same way, with head office's own names.
    await page.goto(`${base}/company-report/`, { waitUntil: 'load' });
    await page.locator('#rows tr[data-branch="B-TEST"]', { hasText: 'Test Branch (B-TEST)' }).waitFor();

    // 5 — head office goes down: the page says so in its own words; nothing is shown as current.
    await ho.stop();
    await page.goto(`${base}/finance-close/`, { waitUntil: 'load' });
    await page.waitForFunction(() => /Head office cannot be reached/i.test((globalThis as unknown as Doc).document.body.innerText));

    // 6 — the identity server down too: a new sign-in is refused plainly, in English and Tamil, never a browser error.
    await idp.down();
    await page.click('#sre-office-sign-out');
    await page.waitForSelector('#office-staff');
    await page.fill('#office-staff', 'u-owner');
    await page.fill('#office-pin', pinOf('u-owner'));
    await page.click('#office-submit');
    await page.goto(`${base}/finance-close/`, { waitUntil: 'load' });
    await page.waitForFunction(() => /Head office cannot be reached from this computer right now/.test((globalThis as unknown as Doc).document.body.innerText));
    expect(await page.textContent('#ho-problem')).toContain('தலைமை அலுவலகத்தை அடைய முடியவில்லை');
    await context.close();
  }, 120_000);
});
