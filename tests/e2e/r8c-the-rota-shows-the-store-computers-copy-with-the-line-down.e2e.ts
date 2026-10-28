import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { wallClockIn } from '../../packages/calendar/src/trading-day';

/**
 * **Round 8 · OB-531 (M25-FR-01 · P-01 · P-08) in a real browser on the REAL store computer with NO head office at all.**
 *
 * The manager opens the Rota page. Head office cannot be reached (nothing in front of the box carries `/v1`), so the page
 * shows the STORE COMPUTER'S COPY of the roster from its signed pack: it says so in plain words, with the time head office
 * last sent it and how old it is; the gaps (one shift short of a cashier) and who is on each shift from today; it is
 * read-only — the "put someone on a short shift" form is not offered and nothing is sent. In Tamil the same. With no roster
 * in the pack, the page says head office cannot be reached and there is no copy — never "no gaps". Skips without a browser.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['r8c', 'rota', 'offline', 'signing', 'key'].join('-').padEnd(48, '0');
const asAt = new Date(Date.now() - 3 * 3_600_000 - 5 * 60_000).toISOString(); // three hours and five minutes ago
const inDays = (n: number, hh: string): string => new Date(Date.now() + n * 86_400_000).toISOString().replace(/T.*/, `T${hh}:00:00.000Z`);
const ROSTER = {
  storeId: 'S1', asAt,
  employees: [{ employeeId: 'E-RANI', name: 'Rani', roles: ['cashier'], active: true }, { employeeId: 'E-ASHA', name: 'Asha', roles: ['cashier'], active: true }],
  shifts: [{ shiftId: 'SH-1', branchId: 'S1', startsAt: inDays(1, '00'), endsAt: inDays(1, '08'), requiredRoles: [{ role: 'cashier', count: 2 }] }],
  assignments: [{ shiftId: 'SH-1', employeeId: 'E-RANI', role: 'cashier' }],
  published: [],
};
const pack = (roster: unknown) => JSON.stringify({
  version: 1, lossPreventionRules: [],
  policies: { tradingDayCutoff: '02:00', storeId: 'S1', branchId: 'S1', timeZone: 'Asia/Kolkata' },
  rosteringPolicy: { userId: 'u-mgr', permissions: ['workforce.roster.read', 'workforce.roster.manage'] },
  ...(roster === undefined ? {} : { roster }),
});

describe.skipIf(!HAVE_BROWSER)('the manager\'s Rota shows the store computer\'s copy, read-only, with the line down (OB-531)', () => {
  let browser: Browser;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });
  const boxWith = async (roster: unknown): Promise<EdgeProcess> => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-r8c-rota-')); dirs.push(dir);
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, pack(roster), 'utf8');
    const edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile,
    }, () => {}))!;
    stops.push(() => edge.stop());
    return edge;
  };
  const openRota = async (edge: EdgeProcess): Promise<{ page: Page; errors: string[]; writes: string[] }> => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    stops.push(() => context.close());
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    const writes: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { if (r.method() !== 'GET') writes.push(`${r.method()} ${new URL(r.url()).pathname}`); });
    const res = await page.goto(`http://127.0.0.1:${edge.screens!.port}/rostering/`, { waitUntil: 'load' });
    expect(res?.status()).toBe(200);
    return { page, errors, writes };
  };
  const waitText = (page: Page, selector: string, text: string) => page.waitForFunction(([sel, want]) => {
    const node = (globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector(sel!);
    return (node?.textContent ?? '').includes(want!);
  }, [selector, text], { timeout: 15_000 });

  it('the copy, said plainly with its time and age; the gaps and who is on; read-only; Tamil', async () => {
    const { page, errors, writes } = await openRota(await boxWith(ROSTER));
    const sentAt = wallClockIn(asAt, 'Asia/Kolkata').replace('T', ' ');
    await waitText(page, '#held-text', "Head office cannot be reached. This is the STORE COMPUTER'S COPY of the roster");
    expect(await page.textContent('#held-text')).toBe(`Head office cannot be reached. This is the STORE COMPUTER'S COPY of the roster, as head office last sent it at ${sentAt} (3 hour(s) old). It may be out of date.`);
    expect(await page.textContent('#read-only-text')).toBe('Read-only: changing the roster needs head office. Try again when the connection is back.');
    expect(await page.textContent('#gap-count')).toBe('1 to fill');
    expect(await page.textContent('#rows')).toContain('cashier');
    await waitText(page, '#rota-rows', 'Rani (cashier)');
    expect(await page.isVisible('#rota')).toBe(true);
    // Read-only: no assign form, and nothing was sent.
    expect(await page.isHidden('#assigner')).toBe(true);
    expect(await page.isVisible('#sample')).toBe(false);
    expect(writes).toEqual([]);
    await page.click('#lang');
    await waitText(page, '#held-text', 'கடைக் கணினி நகல்');
    expect(await page.textContent('#held-text')).toContain('3 மணி நேரம் பழையது');
    expect(await page.textContent('#rota-heading')).toBe('கடைக் கணினி நகலில் உள்ள பணி முறை');
    expect(errors).toEqual([]);
  });

  it('with no roster on the store computer: said plainly — never "no gaps"', async () => {
    const { page, errors } = await openRota(await boxWith(undefined));
    await waitText(page, '#state-text', 'Head office cannot be reached, and this store computer holds no copy of the roster yet');
    expect(await page.textContent('#gap-count')).toBe('');
    expect((await page.textContent('body')) ?? '').not.toContain('No gaps');
    expect(await page.isHidden('#assigner')).toBe(true);
    expect(errors).toEqual([]);
  });
});
