import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { PEOPLE, startOfficeBox } from '../support/office-box';
import { readLog } from '../../edge/store-edge/src/file-log';
import { tradingDateOf, makeTradingDayRule } from '../../packages/calendar/src/trading-day';

/**
 * BROWSER. **Fix batch 4a — D-060 (M14-FR-04 · P-08 · one truth).** A ticked closing-checklist item is one more record
 * waiting to reach head office, and the store computer refuses the close while anything is unsent. Before this, the
 * screen's "Check what is still open" listed only the sales outbox, so it said nothing was open while the store computer
 * refused. Now the screen lists EXACTLY what the store computer counts — the ticks included — and the two agree:
 *   • ticks unsent → the screen lists them under "have not reached the cloud", offers no close, and the box refuses too;
 *   • ticks taken by head office → the screen offers the close for the named day.
 * Synthetic data only.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);

const CHECKLIST = [
  { itemId: 'safe', description: 'Lock the cash safe', done: false, blocking: true },
  { itemId: 'chiller', description: 'Record the chiller temperature', done: false, blocking: true },
];
const shift = (iso: string, days: number): string => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

describe.skipIf(!HAVE_BROWSER)('fix batch 4a: "Check what is still open" counts unsent checklist ticks, as the store computer does (D-060)', () => {
  let browser: Browser;
  const stops: (() => Promise<void>)[] = [];
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 240_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });

  it('ticks not yet sent are listed and hold the close on the screen and on the store computer alike; once sent, the day closes', async () => {
    const running = tradingDateOf(new Date().toISOString(), makeTradingDayRule('00:00'), 'Asia/Kolkata');
    const closes = shift(running, -1);
    const box = await startOfficeBox({
      packExtras: { checklist: CHECKLIST, checklistPolicy: { permissions: [] } },
      managerPermissions: ['workforce.checklist.read', 'workforce.roster.manage'],
    });
    stops.push(() => box.stop());
    const context = await browser.newContext({ viewport: { width: 1366, height: 860 }, serviceWorkers: 'block' });
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`${box.base}/checklist/`, { waitUntil: 'load' });
    await page.fill('#office-staff', PEOPLE.manager.userId);
    await page.fill('#office-pin', PEOPLE.manager.pin);
    await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('#office-submit')]);

    // Tick both items of the day waiting to be closed. The internet is "down": no sync agent takes them.
    const waiting = page.locator(`li.row[data-store-rules="true"][data-for-date="${closes}"]`);
    await waiting.waitFor({ state: 'visible', timeout: 15_000 });
    for (const item of ['safe', 'chiller']) {
      await Promise.all([page.waitForNavigation({ waitUntil: 'load', timeout: 15_000 }), waiting.locator(`li[data-item-id="${item}"] button.tick`).click()]);
    }
    expect(box.edge.completionsOutbox.pending().map((i) => i.event.type)).toEqual(['ChecklistCompleted', 'ChecklistCompleted']);

    // ── The screen: the two unsent ticks are listed, and no close is offered ──
    await page.goto(`${box.base}/manager/`, { waitUntil: 'load' });
    await page.locator('#sre-office-bar').waitFor({ state: 'visible', timeout: 15_000 });
    await page.click('#tab-close');
    await page.click('#check-close');
    await page.waitForSelector('#blockers [data-kind="items_unsent"]', { timeout: 10_000 });
    const unsent = await page.locator('#blockers [data-kind="items_unsent"]').innerText();
    expect(unsent).toContain('2 item(s) have not reached the cloud');
    expect(unsent).toContain('ChecklistCompleted');
    expect(await page.locator('#blockers [data-kind="checklist_open"]').count()).toBe(0);
    expect(await page.locator('#do-close').isHidden()).toBe(true);
    await page.click('#banner-ok');

    // ── The store computer agrees: asked directly, it refuses for the same two unsent items. Nothing is locked. ──
    const direct = await page.evaluate(async ([lane, who, pin]) => {
      const res = await fetch(`${lane}/lane/day-close`, { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'include', body: JSON.stringify({ dayCloseId: 'dc-d060', closedBy: who, closerPin: pin }) });
      return (await res.json()) as { closed: boolean; reason?: string };
    }, [box.lane, PEOPLE.manager.userId, PEOPLE.manager.pin] as const);
    expect(direct.closed).toBe(false);
    expect(direct.reason).toMatch(/\b2\b.*unsent|unsent.*\b2\b/i);
    expect((await readLog(box.edge.dayCloseLog.path)).filter((r) => r.ok && r.record.includes('"closedBy"'))).toEqual([]);

    // ── The line is back: head office takes the ticks. The screen now offers the close, and it closes. ──
    for (const item of box.edge.completionsOutbox.pending()) box.edge.completionsOutbox.acknowledge(item.key);
    await page.goto(`${box.base}/manager/`, { waitUntil: 'load' });
    await page.click('#tab-close');
    await page.click('#check-close');
    await page.waitForSelector('#do-close:not([hidden])', { timeout: 10_000 });
    expect(await page.locator('#blockers [data-kind="items_unsent"]').count()).toBe(0);
  }, 180_000);
});
