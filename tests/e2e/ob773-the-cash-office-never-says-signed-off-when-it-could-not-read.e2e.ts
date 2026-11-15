import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { prepareTillBox, signInAtLane, operatorHeader } from '../support/till-operator';

/**
 * **D-2 — BLOCKS PILOT (pilot-first audit · OB-795 / OB-773 · M14-FR-02 · P-08): a till closed ₹500 short and the cash
 * office's over/short page said "No over/shorts to account for — every drawer is signed off".**
 *
 * On the store PC the office pages often cannot read head office. The page booted on an empty worklist and kept it when
 * its read failed — so a failed read wore the all-clear. This drives the audit's repro on a REAL store computer: a float
 * of ₹2,000 issued to a cashier who signed in with her own PIN, and a close counting ₹1,500 (₹500 short, past the
 * tolerance, with her reason). The store manager then opens Cash over / short in a real browser:
 *
 *   • head office cannot be reached → "Not known — head office could not be reached …", the drawer THIS store computer
 *     recorded closing short is listed (Short ₹500.00, lane-1), and nothing offers to sign it off;
 *   • head office refuses the read → "Not known — head office would not show the over/shorts …";
 *   • head office answers with nothing open → only then "every drawer is signed off";
 *   • Today says the drawer closed short, and that its "Exceptions open" figure does not count it.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['ob740', 'cash', 'office', 'not', 'known', 'key'].join('-').padEnd(48, '0');
const ALL_CLEAR = 'No over/shorts to account for — every drawer is signed off.';
const PACK = {
  version: 1, policies: { tradingDayCutoff: '02:00' }, managerPolicy: { userId: 'u-mgr' }, lossPreventionRules: [],
  cashOfficePolicy: { userId: 'u-mgr', permissions: ['till.shift.read', 'till.overshort.review'] },
};

describe.skipIf(!HAVE_BROWSER)('the cash office never says "every drawer is signed off" over a read that failed (D-2)', () => {
  let browser: Browser;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 120_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  /** A real store computer with a till, on which a drawer has just closed ₹500 short — the audit's repro. */
  async function boxWithAShortDrawer(): Promise<{ edge: EdgeProcess; base: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'sre-ob773-'));
    dirs.push(dir);
    const tillEnv = await prepareTillBox({
      dir, key: KEY, pack: PACK,
      people: [{ userId: 'u-mgr', displayName: 'Manager', manager: true }, { userId: 'u-ravi', displayName: 'Ravi' }],
    });
    const edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', ...tillEnv,
    }, () => {}))!;
    stops.push(() => edge.stop());
    const lane = `http://127.0.0.1:${edge.lane!.port}`;
    const post = async (path: string, body: unknown, headers: Record<string, string>) =>
      (await (await fetch(`${lane}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })).json()) as Record<string, unknown>;
    const ravi = operatorHeader(await signInAtLane(edge.lane!.port, 'u-ravi'));
    const now = Date.now();
    expect(await post('/lane/cash-movements', { movementId: 'cm-float', movementKind: 'float_issue', amountMinor: 200_000, at: new Date(now - 3_600_000).toISOString(), custodianId: 'u-ravi' }, ravi))
      .toMatchObject({ committed: true });
    const closed = await post('/lane/shift-close', { shiftId: 'sh-short', closedAt: new Date(now - 60_000).toISOString(), cashierId: 'u-ravi', countedMinor: 150_000, reasonCode: 'gave_wrong_change' }, ravi);
    expect(closed).toMatchObject({ closed: true });
    return { edge, base: `http://127.0.0.1:${edge.screens!.port}` };
  }

  /** The manager's browser; `/v1` (head office) answers as `headOffice` says — cut off, refusing, or with nothing open. */
  async function asManager(base: string, path: string, headOffice: 'unreachable' | 'refused' | 'nothing_open'): Promise<Page> {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    stops.push(() => context.close());
    await context.route('**/v1/**', async (route) => {
      if (headOffice === 'unreachable') { await route.abort('internetdisconnected'); return; }
      if (headOffice === 'refused') { await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' }); return; }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ overShort: [], openCount: 0, totalVarianceMinor: 0 }) });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    // The page asks head office once at load; the second load sees the box's re-read of its own till-cash log.
    await page.goto(`${base}${path}`, { waitUntil: 'load' });
    await page.goto(`${base}${path}`, { waitUntil: 'load' });
    await page.waitForFunction('globalThis.sreChrome !== undefined');
    return page;
  }

  it('head office unreachable: "Not known — why", the box\'s own short drawer listed, no sign-off offered — in Tamil too', async () => {
    const { base } = await boxWithAShortDrawer();
    const page = await asManager(base, '/cash-office', 'unreachable');
    await page.waitForFunction('document.getElementById("open-count").textContent.startsWith("Not known")');
    const said = await page.textContent('#open-count');
    expect(said).toBe('Not known — head office could not be reached, so whether any drawer is waiting to be signed off cannot be told');
    expect(await page.textContent('main')).not.toContain(ALL_CLEAR);
    expect(await page.isVisible('#box')).toBe(true);
    expect(await page.textContent('#box-heading')).toBe('Recorded on this store computer');
    expect((await page.textContent('#box-rows'))?.replace(/\s+/g, ' ')).toMatch(/Short — lane-1\s*₹500\.00/);
    expect(await page.isVisible('#signer')).toBe(false);
    expect(await page.getAttribute('#state .sre-state', 'data-state')).toBe('unknown');

    await page.click('#lang');
    await page.waitForFunction('document.documentElement.lang === "ta"');
    expect(await page.textContent('#open-count')).toMatch(/^தெரியவில்லை — தலைமை அலுவலகத்தை அடைய முடியவில்லை/);
  });

  it('head office refuses the read: "Not known", saying it would not show them — never the all-clear', async () => {
    const { base } = await boxWithAShortDrawer();
    const page = await asManager(base, '/cash-office', 'refused');
    await page.waitForFunction('document.getElementById("open-count").textContent.includes("would not show")');
    expect(await page.textContent('#open-count')).toMatch(/^Not known — head office would not show the over\/shorts for your sign-in/);
    expect(await page.textContent('main')).not.toContain(ALL_CLEAR);
  });

  it('only a read that SUCCEEDED and found nothing open says every drawer is signed off', async () => {
    const { base } = await boxWithAShortDrawer();
    const page = await asManager(base, '/cash-office', 'nothing_open');
    await page.waitForFunction(`document.getElementById("open-count").textContent === ${JSON.stringify(ALL_CLEAR)}`);
    expect(await page.isVisible('#box')).toBe(false);
  });

  it('Today names the drawer that closed short and says "Exceptions open" does not count it', async () => {
    const { base } = await boxWithAShortDrawer();
    const page = await asManager(base, '/manager', 'unreachable');
    await page.waitForFunction('document.getElementById("attention").textContent.includes("closed over or short today")');
    const attention = (await page.textContent('#attention'))?.replace(/\s+/g, ' ') ?? '';
    expect(attention).toMatch(/1 drawer\(s\) closed over or short today — sign-off is on Cash over \/ short \(lane-1 short ₹500\.00/);
    expect(await page.textContent('#tiles')).toContain('not counted here: 1 drawer(s) closed over or short today');
  });
});
