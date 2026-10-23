import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { PEOPLE, startOfficeBox, type OfficeBox } from '../support/office-box';
import { OFFICE_ACT_WORDS } from '../../edge/store-edge/src/office-sign-in';
import { readLog } from '../../edge/store-edge/src/file-log';

/**
 * OB-259 completeness in real Chromium, on a real store box whose office screens ask for the PIN: the manager signs in
 * with their own PIN and closes the day from the manager's screen — the browser carries the office sign-in to the box's
 * lane socket (another port), and the box closes the day IN THE MANAGER'S NAME. When the office sign-in has gone (signed
 * out in another tab), the same button is refused by the box, and the screen says why — in English, and in Tamil after
 * the language switch. Nothing is locked then.
 */

/** The tiny slice of the DOM these checks touch, cast structurally so the file needs no DOM lib. */
interface Doc { readonly document: { getElementById(id: string): { readonly textContent: string | null } | null; readonly documentElement: { readonly lang: string } } }

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);

describe.skipIf(!HAVE_BROWSER)('the manager\'s day close needs the office sign-in, in English and Tamil (OB-259)', () => {
  let browser: Browser;
  const stops: (() => Promise<void>)[] = [];
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 240_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });

  async function managerSignedIn(): Promise<{ box: OfficeBox; page: Page }> {
    const box = await startOfficeBox();
    stops.push(() => box.stop());
    const context = await browser.newContext({ viewport: { width: 1366, height: 860 }, serviceWorkers: 'block' });
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`${box.base}/manager/`, { waitUntil: 'load' });
    await page.fill('#office-staff', PEOPLE.manager.userId);
    await page.fill('#office-pin', PEOPLE.manager.pin);
    await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('#office-submit')]);
    await page.locator('#sre-office-bar').waitFor({ state: 'visible', timeout: 15_000 });
    await page.click('#tab-close');
    return { box, page };
  }
  const closeRecords = async (box: OfficeBox): Promise<Record<string, unknown>[]> =>
    (await readLog(box.edge.dayCloseLog.path)).flatMap((r) => (r.ok && r.record.includes('"closedBy"') ? [JSON.parse(r.record) as Record<string, unknown>] : []));
  const bannerText = (page: Page): Promise<string> => page.locator('#banner-text').innerText();

  it('signed in, the manager closes the day on the box, in the manager\'s own name', async () => {
    const { box, page } = await managerSignedIn();
    await page.click('#check-close');
    await page.waitForSelector('#do-close:not([hidden])', { timeout: 10_000 });
    await page.fill('#close-pin', PEOPLE.manager.pin);
    await page.click('#do-close');
    await page.waitForFunction(() => ((globalThis as unknown as Doc).document.getElementById('banner-title')?.textContent ?? '').includes('closed and locked'), undefined, { timeout: 10_000 });
    expect(await closeRecords(box)).toEqual([expect.objectContaining({ closedBy: PEOPLE.manager.userId, locked: true })]);
  }, 120_000);

  it('once the office sign-in has gone, the box refuses the close and the screen says why — in English, then in Tamil', async () => {
    const { box, page } = await managerSignedIn();
    await page.click('#check-close');
    await page.waitForSelector('#do-close:not([hidden])', { timeout: 10_000 });
    // Signed out in another tab of the same browser: the page still shows, but the sign-in is over.
    // Every step has its own time limit, so a slow runner fails at the step it stalled on, never as one silent 120 s wait.
    const other = await page.context().newPage();
    await other.goto(`${box.base}/migration/`, { waitUntil: 'load', timeout: 30_000 });
    const signOut = other.locator('#sre-office-sign-out');
    await signOut.waitFor({ state: 'visible', timeout: 15_000 });
    // The sign-out button submits a form: wait for that navigation to land before the tab is closed.
    await Promise.all([other.waitForNavigation({ waitUntil: 'load', timeout: 30_000 }), signOut.click({ timeout: 15_000 })]);
    await other.close();

    await page.fill('#close-pin', PEOPLE.manager.pin);
    await page.click('#do-close');
    await page.waitForFunction((words) => ((globalThis as unknown as Doc).document.getElementById('banner-text')?.textContent ?? '') === words, OFFICE_ACT_WORDS.office_sign_in_needed.en, { timeout: 10_000 });
    expect(await bannerText(page)).toBe('Sign in to the office screens first, with your own staff ID and PIN. Nothing was done.');
    expect(await page.inputValue('#close-pin')).toBe(''); // the PIN never stays on the screen

    await page.click('#banner-ok'); // the manager reads it and presses OK, as at the till
    await page.click('#lang');
    expect(await page.evaluate(() => (globalThis as unknown as Doc).document.documentElement.lang)).toBe('ta');
    await page.click('#check-close');
    await page.waitForSelector('#do-close:not([hidden])', { timeout: 10_000 });
    await page.fill('#close-pin', PEOPLE.manager.pin);
    await page.click('#do-close');
    await page.waitForFunction((words) => ((globalThis as unknown as Doc).document.getElementById('banner-text')?.textContent ?? '') === words, OFFICE_ACT_WORDS.office_sign_in_needed.ta, { timeout: 10_000 });
    expect(await bannerText(page)).toBe('முதலில் உங்கள் சொந்தப் பணியாளர் எண்ணாலும் PIN-ஆலும் அலுவலகத் திரைகளில் உள்நுழையுங்கள். எதுவும் செய்யப்படவில்லை.');
    expect(await closeRecords(box)).toEqual([]);
  }, 120_000);
});
