import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { PEOPLE, startOfficeBox, type OfficeBox } from '../support/office-box';
import { readLog } from '../../edge/store-edge/src/file-log';
import { tradingDateOf, makeTradingDayRule } from '../../packages/calendar/src/trading-day';

/**
 * BROWSER. **Fix batch 3 — the day close (daily-work defects D-008 · D-011 · D-012 · M14-FR-04 · M25-FR-02 · P-03 · P-08).**
 * A real store box with the office PIN sign-in on, the store rules' closing checklist in its pack (two items that "must be
 * done before the day closes", one that does not), and the store manager signed in with his own PIN — as in the shop:
 *
 *   • D-012: the Close the day screen NAMES the day the store computer closes (its most recently ENDED trading day, by the
 *     store's cutoff — never changed here), says the running day is still trading and from when it can be closed (after
 *     the cutoff), names that day on the button and in the confirmation, and the success says "<day> is closed and
 *     locked." — in English and in Tamil;
 *   • D-011: "Check what is still open" LISTS the blocking closing-checklist items that are not done, and the store
 *     computer REFUSES the close while one is open (even asked directly) — nothing is locked;
 *   • D-008: the Checklists page lists the SAME store-rules items Today counts, each can be ticked ("Done") — saved on the
 *     store computer in the manager's own name, append-only — and Today's count and the close both follow the ticks.
 * Synthetic data only.
 */

interface Doc { readonly document: { getElementById(id: string): { readonly textContent: string | null } | null } }
interface Win { readonly managerData?: { readonly today?: { readonly checklistOpen?: { readonly value?: number; readonly note?: string } }; readonly dayClose?: { readonly closes: string; readonly runningDay: string } } }

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);

/** The store rules' closing checklist as head office sends it in the pack (every item "not done": head office cannot know). */
const CHECKLIST = [
  { itemId: 'safe', description: 'Lock the cash safe', done: false, blocking: true },
  { itemId: 'chiller', description: 'Record the chiller temperature', done: false, blocking: true },
  { itemId: 'lights', description: 'Switch off the aisle lights', done: false, blocking: false },
];

const EN_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const TA_DAYS = ['ஞாயிறு', 'திங்கள்', 'செவ்வாய்', 'புதன்', 'வியாழன்', 'வெள்ளி', 'சனி'];
const TA_MONTHS = ['ஜனவரி', 'பிப்ரவரி', 'மார்ச்', 'ஏப்ரல்', 'மே', 'ஜூன்', 'ஜூலை', 'ஆகஸ்ட்', 'செப்டம்பர்', 'அக்டோபர்', 'நவம்பர்', 'டிசம்பர்'];
const words = (iso: string, ta = false): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${(ta ? TA_DAYS : EN_DAYS)[d.getUTCDay()]} ${d.getUTCDate()} ${(ta ? TA_MONTHS : EN_MONTHS)[d.getUTCMonth()]}`;
};
const shift = (iso: string, days: number): string => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

describe.skipIf(!HAVE_BROWSER)('fix batch 3: the day close names its day and waits for the closing checklist (D-008 · D-011 · D-012)', () => {
  let browser: Browser;
  const stops: (() => Promise<void>)[] = [];
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 240_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });

  async function managerSignedIn(): Promise<{ box: OfficeBox; page: Page }> {
    const box = await startOfficeBox({
      packExtras: { checklist: CHECKLIST, checklistPolicy: { permissions: [] } },
      managerPermissions: ['workforce.checklist.read', 'workforce.roster.manage'],
    });
    stops.push(() => box.stop());
    const context = await browser.newContext({ viewport: { width: 1366, height: 860 }, serviceWorkers: 'block' });
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`${box.base}/manager/`, { waitUntil: 'load' });
    await page.fill('#office-staff', PEOPLE.manager.userId);
    await page.fill('#office-pin', PEOPLE.manager.pin);
    await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('#office-submit')]);
    await page.locator('#sre-office-bar').waitFor({ state: 'visible', timeout: 15_000 });
    return { box, page };
  }
  const closeRecords = async (box: OfficeBox): Promise<Record<string, unknown>[]> =>
    (await readLog(box.edge.dayCloseLog.path)).flatMap((r) => (r.ok && r.record.includes('"closedBy"') ? [JSON.parse(r.record) as Record<string, unknown>] : []));
  const bannerTitle = (page: Page): Promise<string> => page.locator('#banner-title').innerText();
  const waitBanner = (page: Page, text: string): Promise<unknown> =>
    page.waitForFunction((want) => ((globalThis as unknown as Doc).document.getElementById('banner-title')?.textContent ?? '').includes(want), text, { timeout: 10_000 });

  it('the close names the day, lists the open checklist items and refuses; ticked on Checklists, the named day closes', async () => {
    const running = tradingDateOf(new Date().toISOString(), makeTradingDayRule('00:00'), 'Asia/Kolkata');
    const closes = shift(running, -1); // the most recently ENDED trading day — what the store computer closes (M14-FR-04)
    const { box, page } = await managerSignedIn();

    // The box told the screen which day it closes, by its own rule.
    expect(await page.evaluate(() => (globalThis as unknown as Win).managerData?.dayClose)).toEqual(expect.objectContaining({ closes, runningDay: running }));
    // Today counts the store rules' checklist: 3 open, 2 of them hold the close.
    expect(await page.evaluate(() => (globalThis as unknown as Win).managerData?.today?.checklistOpen)).toEqual(expect.objectContaining({ value: 3, note: '2 must be done before the day closes' }));

    // ── D-012: the Close the day screen names the day ──
    await page.click('#tab-close');
    const lead = await page.locator('#close-lead').innerText();
    expect(lead).toContain(`This closes ${words(closes)} — the last trading day that has ended.`);
    expect(lead).toContain(`Today, ${words(running)}, is still trading. It can be closed from 00:00 on ${words(shift(running, 1))}, after the store's day cutoff.`);

    // ── D-011: "Check what is still open" lists the two blocking items; no close is offered ──
    await page.click('#check-close');
    await page.waitForSelector('#blockers [data-kind="checklist_open"]', { timeout: 10_000 });
    const blocker = await page.locator('#blockers [data-kind="checklist_open"]').innerText();
    expect(blocker).toContain('2 closing-checklist item(s) must be done before the day closes');
    expect(blocker).toContain('Lock the cash safe');
    expect(blocker).toContain('Record the chiller temperature');
    expect(blocker).not.toContain('Switch off the aisle lights');
    expect(await page.locator('#do-close').isHidden()).toBe(true);
    expect(await bannerTitle(page)).toContain(`${words(closes)} cannot close yet`);
    await page.click('#banner-ok');

    // The store computer is the authority: asked directly, it refuses too — and names the items. Nothing is locked.
    const direct = await page.evaluate(async ([lane, who, pin]) => {
      const res = await fetch(`${lane}/lane/day-close`, { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'include', body: JSON.stringify({ dayCloseId: 'dc-forced', closedBy: who, closerPin: pin }) });
      return (await res.json()) as { closed: boolean; reason?: string };
    }, [box.lane, PEOPLE.manager.userId, PEOPLE.manager.pin] as const);
    expect(direct.closed).toBe(false);
    expect(direct.reason).toContain(`2 closing-checklist item(s) for ${closes} must be done before the day closes`);
    expect(direct.reason).toContain('Lock the cash safe');
    expect(await closeRecords(box)).toEqual([]);

    // ── D-008: the Checklists page lists the same items, for the day waiting to be closed and for today ──
    await page.goto(`${box.base}/checklist/`, { waitUntil: 'load' });
    const waiting = page.locator(`li.row[data-store-rules="true"][data-for-date="${closes}"]`);
    const today = page.locator(`li.row[data-store-rules="true"][data-for-date="${running}"]`);
    await waiting.waitFor({ state: 'visible', timeout: 10_000 });
    expect(await page.locator('#work-count').innerText()).not.toContain('none has been set up');
    expect(await waiting.innerText()).toContain(`${words(closes)} — must be finished before this day can be closed`);
    expect(await today.locator('li[data-item-id]').allInnerTexts()).toEqual([
      expect.stringContaining('Lock the cash safe'), expect.stringContaining('Record the chiller temperature'), expect.stringContaining('Switch off the aisle lights'),
    ]);

    // Tick the two blocking items of the day waiting to be closed, and one of today's.
    for (const [row, item] of [[waiting, 'safe'], [waiting, 'chiller'], [today, 'lights']] as const) {
      await Promise.all([page.waitForNavigation({ waitUntil: 'load', timeout: 15_000 }), row.locator(`li[data-item-id="${item}"] button.tick`).click()]);
    }
    // Ticked in the manager's own name, saved on the store computer — and the waiting day has nothing left to hold it.
    await today.waitFor({ state: 'visible', timeout: 10_000 });
    expect(await today.locator('li[data-item-id="lights"]').innerText()).toContain(`done by ${PEOPLE.manager.userId}`);
    expect(await page.locator(`li.row[data-for-date="${closes}"]`).count()).toBe(0);
    // Append-only: three tick records on the box's completions log, each naming who did it.
    const ticks = (await readLog(box.edge.completionsLog.path)).flatMap((r) => (r.ok ? [JSON.parse(r.record) as { completionKind: string; body: { checklistId: string; items: { itemId: string; done: boolean; doneBy?: string }[] } }] : []));
    expect(ticks.map((t) => t.body.checklistId)).toEqual([`${closes}-closing`, `${closes}-closing`, `${running}-closing`]);
    expect(ticks[2]!.body.items.find((i) => i.itemId === 'lights')).toEqual(expect.objectContaining({ done: true, doneBy: PEOPLE.manager.userId }));
    // Each tick is queued for head office, and (M14-FR-04) nothing unsent may be left when a day locks. This box has no
    // head office wired, so stand in for the sync agent: the line is up and head office has taken the three ticks.
    expect(box.edge.completionsOutbox.pending().map((i) => i.event.type)).toEqual(['ChecklistCompleted', 'ChecklistCompleted', 'ChecklistCompleted']);
    for (const item of box.edge.completionsOutbox.pending()) box.edge.completionsOutbox.acknowledge(item.key);

    // Today follows the ticks (one source): today's checklist now has 2 open, both holding today's close.
    await page.goto(`${box.base}/manager/`, { waitUntil: 'load' });
    expect(await page.evaluate(() => (globalThis as unknown as Win).managerData?.today?.checklistOpen)).toEqual(expect.objectContaining({ value: 2 }));

    // ── D-012 / D-011: nothing holds the named day now — the button and the confirmation name it, in Tamil too ──
    await page.click('#tab-close');
    await page.click('#check-close');
    await page.waitForSelector('#do-close:not([hidden])', { timeout: 10_000 });
    expect(await page.locator('#do-close').innerText()).toBe(`Close ${words(closes)}`);
    await waitBanner(page, `Nothing is open for ${words(closes)}`);
    expect(await page.locator('#banner-text').innerText()).toBe(`Key your till PIN, then press "Close ${words(closes)}".`);
    await page.click('#banner-ok');
    await page.click('#lang');
    expect(await page.locator('#do-close').innerText()).toBe(`${words(closes, true)} நாளை முடி`);
    expect(await page.locator('#close-lead').innerText()).toContain(`இது ${words(closes, true)} நாளை முடிக்கும்`);
    await page.click('#lang');
    // A language switch redraws the screen: check again, as the manager would, then key the PIN.
    await page.click('#check-close');
    await page.waitForSelector('#close-pin-row:not([hidden])', { timeout: 10_000 });
    await page.click('#banner-ok');

    await page.fill('#close-pin', PEOPLE.manager.pin);
    await page.click('#do-close');
    await waitBanner(page, 'is closed and locked');
    expect(await bannerTitle(page)).toBe(`${words(closes)} is closed and locked.`);
    expect(await closeRecords(box)).toEqual([expect.objectContaining({ tradingDay: closes, closedBy: PEOPLE.manager.userId, locked: true })]);
  }, 180_000);

  it('a person without the right to manage the checklist cannot tick it — the box refuses, nothing is saved', async () => {
    const box = await startOfficeBox({ packExtras: { checklist: CHECKLIST, checklistPolicy: { permissions: [] } }, managerPermissions: ['workforce.checklist.read'] });
    stops.push(() => box.stop());
    const context = await browser.newContext({ serviceWorkers: 'block' });
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`${box.base}/checklist/`, { waitUntil: 'load' });
    await page.fill('#office-staff', PEOPLE.manager.userId);
    await page.fill('#office-pin', PEOPLE.manager.pin);
    await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('#office-submit')]);
    await page.locator('li.row[data-store-rules="true"]').first().waitFor({ state: 'visible', timeout: 10_000 });
    // No "Done" button is offered…
    expect(await page.locator('button.tick').count()).toBe(0);
    // …and asked directly, the store computer refuses it (403 at the office door: the permission is not held).
    const running = tradingDateOf(new Date().toISOString(), makeTradingDayRule('00:00'), 'Asia/Kolkata');
    const status = await page.evaluate(async ([lane, day]) => (await fetch(`${lane}/lane/checklist-tick`, { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'include', body: JSON.stringify({ forDate: day, itemId: 'safe' }) })).status, [box.lane, running] as const);
    expect(status).toBe(403);
    expect((await readLog(box.edge.completionsLog.path)).length).toBe(0);
  }, 120_000);
});
