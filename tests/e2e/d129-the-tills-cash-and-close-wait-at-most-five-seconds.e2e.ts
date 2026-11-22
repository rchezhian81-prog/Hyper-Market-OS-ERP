import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { prepareTillBox, signInThroughScreen } from '../support/till-operator';
import { readLog } from '../../edge/store-edge/src/file-log';
import { readTillCashRecord } from '../../edge/store-edge/src/till-cash';

/**
 * **D-129 · OB-911 · P-08 in a real Chromium against a real store computer: the till's float, cash loan, pickup, safe drop
 * and close wait at most 5 seconds — and are recorded ONCE when pressed again.**
 *
 * The test stands on the wire between the served till and its store computer:
 *   • the store computer TAKES the call (writes the float) and its answer is lost → within a few seconds the till says
 *     "did not answer in time — the till does not know if this cash was recorded. Do not move the cash again; press the same
 *     button to check" (English and Tamil); never "recorded", never "NOT recorded". The same button, pressed again, sends the
 *     SAME movement and the store computer's disk holds ONE;
 *   • the store computer cannot be reached at all → "the cash is NOT recorded yet" (true), and the same button sends it again;
 *   • the store computer refuses → its own words, "NOT recorded";
 *   • the close's answer is lost → "does not know if the till was closed"; Close till pressed again sends the SAME close —
 *     no second count — and the disk holds ONE close that counts every movement once.
 * Screenshots (deviceScaleFactor 1) go to SRE_SCREENSHOT_DIR when it is set. Synthetic data only.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const SHOTS = process.env['SRE_SCREENSHOT_DIR'];
const KEY = ['d129', 'till', 'cash', 'no', 'answer', 'key'].join('-').padEnd(48, '0');
const POLICIES = { storeId: 'store-1', branchId: 'store-1', branchName: 'Main', tradingDayCutoff: '02:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, cashVarianceToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'wh-1' };
const CASH_ROUTE = '**/lane/cash-movements';
const CLOSE_ROUTE = '**/lane/shift-close';

describe.skipIf(!HAVE_BROWSER)('D-129 — the till\'s cash and close wait at most five seconds, and are recorded once', () => {
  let browser: Browser;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'pos'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    if (SHOTS !== undefined) await mkdir(SHOTS, { recursive: true });
  }, 90_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });
  const shot = async (page: Page, name: string): Promise<void> => { if (SHOTS !== undefined) await page.screenshot({ path: join(SHOTS, name) }); };

  const servedTill = async (): Promise<{ edge: EdgeProcess; page: Page }> => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-d129-till-'));
    dirs.push(dir);
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_LANE_ID: 'lane-1', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
      ...await prepareTillBox({ dir, key: KEY, pack: { policies: POLICIES, lossPreventionRules: [] } }),
    }, () => {}))!;
    stops.push(() => edge.stop());
    // The page's own service worker is kept out, so the test can stand between the till and its store computer.
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1366, height: 800 }, deviceScaleFactor: 1 });
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/pos/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as { posSession?: unknown }).posSession !== undefined, undefined, { timeout: 15_000 });
    await signInThroughScreen(page);
    return { edge, page };
  };
  const keyAmount = async (page: Page, rupees: string): Promise<void> => {
    await page.waitForSelector('#sheet:not([hidden])');
    for (const digit of rupees) await page.click(`#keypad button:text-is("${digit}")`);
    await page.click('#sheet-ok');
    await page.waitForSelector('#sheet:not([hidden]) #consequence:not([hidden])');
    await page.click('#sheet-ok');
  };
  const said = async (page: Page, name?: string): Promise<{ title: string; text: string }> => {
    await page.waitForSelector('#refusal:not([hidden])', { timeout: 15_000 });
    const title = (await page.textContent('#refusal-title')) ?? '';
    const text = (await page.textContent('#refusal-text')) ?? '';
    if (name !== undefined) await shot(page, name);
    await page.click('#refusal-ok');
    return { title, text };
  };
  const more = async (page: Page): Promise<string[]> => {
    await page.click('#more');
    await page.waitForSelector('#pay:not([hidden])');
    return page.$$eval('#pay-kinds button', (b) => b.map((x) => x.textContent ?? ''));
  };
  const press = async (page: Page, label: string): Promise<void> => { await page.click(`#pay-kinds button:text-is("${label}")`); };
  const records = async (edge: EdgeProcess) => (await readLog(edge.tillCashLog.path)).flatMap((r) => (r.ok ? [readTillCashRecord(JSON.parse(r.record))!] : []));
  const movements = async (edge: EdgeProcess) => (await records(edge)).flatMap((r) => (r.kind === 'movement' ? [[r.movementKind, r.amountMinor]] : []));
  /** The store computer takes the call and writes it; its answer never reaches the till. */
  const answerLost = async (page: Page, glob: string): Promise<{ carried: () => number }> => {
    let n = 0;
    await page.route(glob, async (route) => {
      n += 1;
      await route.fetch().catch(() => undefined);
      // …and never answer the till.
    });
    return { carried: () => n };
  };

  it('float, loan, pickup, safe drop: no answer → "not known", never "recorded" or "NOT recorded"; the same button again → recorded ONCE; cannot reach → "NOT recorded yet"; refused → NOT recorded', async () => {
    const { edge, page } = await servedTill();

    // ── The float: the store computer writes it, the answer is lost.
    const lost = await answerLost(page, CASH_ROUTE);
    await more(page);
    await press(page, 'Take float (open the till)');
    await keyAmount(page, '2000');
    const started = Date.now();
    const noAnswer = await said(page, 'd129-float-no-answer-1366-en.png');
    expect(Date.now() - started).toBeLessThan(12_000);
    expect(noAnswer.title).toContain('Not known yet — do not move the cash');
    expect(noAnswer.text).toBe('The store computer did not answer in time — the till does not know if this cash was recorded. Do not move the cash again; press the same button to check.');
    expect(noAnswer.text).not.toMatch(/NOT recorded|Float taken/);
    expect(lost.carried()).toBe(1);
    expect(await movements(edge)).toEqual([['float_issue', 200_000]]); // it IS on the store computer — hence "not known"

    // The store computer answers again. The float button is still offered (the float is out now) — pressing it CHECKS.
    await page.unroute(CASH_ROUTE);
    const offered = await more(page);
    expect(offered).toContain('Take float (open the till)');
    await press(page, 'Take float (open the till)');
    const checked = await said(page, 'd129-float-pressed-again-recorded-once-1366-en.png');
    expect(checked.title).toContain('A cash movement from before was still waiting — it has now been recorded.');
    expect(checked.text).toContain('₹2,000.00');
    expect(await page.isHidden('#sheet')).toBe(true); // no new amount asked: the press checked the waiting one
    expect(await movements(edge)).toEqual([['float_issue', 200_000]]); // ONE float

    // ── A cash loan in Tamil: the answer lost → the same words in Tamil.
    await page.click('#lang');
    await answerLost(page, CASH_ROUTE);
    await more(page);
    await press(page, 'பணக் கடன் (டிராயருக்குச் சில்லறை சேர்)');
    await keyAmount(page, '500');
    const ta = await said(page, 'd129-loan-no-answer-1366-ta.png');
    expect(ta.text).toContain('கடை கணினி நேரத்தில் பதில் தரவில்லை');
    expect(ta.text).toContain('அதே பொத்தானை அழுத்தவும்');
    await page.unroute(CASH_ROUTE);
    await more(page);
    await press(page, 'பணக் கடன் (டிராயருக்குச் சில்லறை சேர்)');
    expect((await said(page)).title).toContain('முன்பு காத்திருந்த பணப் பதிவு இப்போது பதிவு செய்யப்பட்டது.');
    await page.click('#lang');
    expect(await movements(edge)).toEqual([['float_issue', 200_000], ['loan', 50_000]]);

    // ── A pickup the store computer cannot be reached for at all: "NOT recorded yet" is true and said.
    await page.route(CASH_ROUTE, (route) => route.abort('connectionrefused'));
    await more(page);
    await press(page, 'Pickup (manager takes cash to the safe)');
    await keyAmount(page, '300');
    const unreachable = await said(page, 'd129-pickup-cannot-reach-1366-en.png');
    expect(unreachable.title).toContain('NOT recorded');
    expect(unreachable.text).toContain('The till cannot reach the store computer. The cash is NOT recorded yet');
    expect(await movements(edge)).toHaveLength(2);
    await page.unroute(CASH_ROUTE);
    await more(page);
    await press(page, 'Pickup (manager takes cash to the safe)');
    expect((await said(page)).title).toContain('it has now been recorded');

    // ── A safe drop the store computer takes and never answers, and never writes either: still "not known" — the till
    // cannot tell the two apart, so it never guesses. Pressed again, it is recorded — once.
    await page.route(CASH_ROUTE, () => { /* the call is taken and nothing comes back */ });
    await more(page);
    await press(page, 'Safe drop (cashier puts cash in the safe)');
    await keyAmount(page, '200');
    expect((await said(page)).text).toContain('does not know if this cash was recorded');
    await page.unroute(CASH_ROUTE);
    await more(page);
    await press(page, 'Safe drop (cashier puts cash in the safe)');
    expect((await said(page)).title).toContain('it has now been recorded');

    // ── A refusal is a definite answer: NOT recorded, in the store computer's words; nothing kept to send again.
    await more(page);
    await press(page, 'Safe drop (cashier puts cash in the safe)');
    await keyAmount(page, '9000');
    const refused = await said(page);
    expect(refused.title).toContain('NOT recorded');
    expect(refused.text).toContain('The drawer does not hold that much');
    expect(await page.evaluate((k) => (globalThis as unknown as { sessionStorage: { getItem(key: string): string | null } }).sessionStorage.getItem(k), 'sre-pos-pending-cash')).toBeNull();

    expect(await movements(edge)).toEqual([['float_issue', 200_000], ['loan', 50_000], ['pickup', 30_000], ['safe_drop', 20_000]]);
  }, 150_000);

  it('the close: the answer lost → "not known if the till closed", never "Till closed"; Close till again sends the SAME close (no second count) → ONE close that counts each movement once', async () => {
    const { edge, page } = await servedTill();
    await more(page);
    await press(page, 'Take float (open the till)');
    await keyAmount(page, '2000');
    expect((await said(page)).title).toContain('Float taken');

    await answerLost(page, CLOSE_ROUTE);
    await more(page);
    await press(page, 'Close till');
    await page.waitForSelector('#count:not([hidden])');
    for (let i = 0; i < 4; i += 1) await page.click('button[aria-label="one more ₹500.00"]');
    await page.click('#count-ok');
    const lost = await said(page, 'd129-close-no-answer-1366-en.png');
    expect(lost.title).toContain('Not known yet if the till closed');
    expect(lost.text).toContain('does not know if the till was closed');
    expect(lost.text).toContain('Do not count the drawer again');
    expect(lost.text).not.toMatch(/Till closed|balances/);
    expect((await records(edge)).filter((r) => r.kind === 'close')).toHaveLength(1); // it IS closed on the store computer

    // The store computer now says the till is free — Close till is still offered, so the cashier can press it to check.
    await page.unroute(CLOSE_ROUTE);
    const offered = await more(page);
    expect(offered).toContain('Close till');
    expect(offered).toContain('Take float (open the till)');
    await press(page, 'Close till');
    const closed = await said(page, 'd129-close-pressed-again-1366-en.png');
    expect(await page.isHidden('#count')).toBe(true); // the drawer was NOT counted a second time
    expect(closed.title).toBe('The drawer balances exactly.');
    expect(closed.text).toContain('Till closed — Counted: ₹2,000.00');
    const closes = (await records(edge)).filter((r) => r.kind === 'close');
    expect(closes).toHaveLength(1);
    expect(closes[0]).toMatchObject({ countedMinor: 200_000, expectedMinor: 200_000, varianceMinor: 0 });
    expect(await page.evaluate((k) => (globalThis as unknown as { sessionStorage: { getItem(key: string): string | null } }).sessionStorage.getItem(k), 'sre-pos-pending-close')).toBeNull();

    // Tamil: the same "not known" for a close, on a second shift.
    await page.click('#lang');
    await more(page);
    await press(page, 'ஆரம்பப் பணம் எடு (டில்லைத் திற)');
    await keyAmount(page, '1000');
    await said(page);
    await answerLost(page, CLOSE_ROUTE);
    await more(page);
    await press(page, 'டில்லை மூடு');
    await page.waitForSelector('#count:not([hidden])');
    // The "one more" button beside ₹500 (its words are Tamil now): the button just after the ₹500 count.
    for (let i = 0; i < 2; i += 1) await page.click('#n-50000 + button');
    await page.click('#count-ok');
    const ta = await said(page, 'd129-close-no-answer-1366-ta.png');
    expect(ta.text).toContain('டில் மூடப்பட்டதா என்று டில்லுக்குத் தெரியவில்லை');
    await page.unroute(CLOSE_ROUTE);
    await page.click('#lang');
  }, 150_000);
});
