import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { auditPage } from './lib/a11y-audit';
import { serveShell } from './lib/device-screens';
import { Tally } from './lib/tally';

/**
 * **U6 · OB-700 (owner, 7 Nov 2026, decision 3 = B) · M19 · §31 — on the driver's phone, in real Chromium at a phone's
 * size: "Ask the store to call the customer" is ONE tap on the stop the driver is at.** The phone holds no customer number
 * (the words say so), the request is listed under "Sent from this phone" as saved here until the store computer takes it,
 * the stop carries the mark, a second tap is refused by name, a finished stop takes none — in English and Tamil, every view
 * audited at 56px.
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HANDHELD = { viewport: { width: 360, height: 640 }, hasTouch: true, isMobile: true };
const DRIVER_DATA = {
  routeId: 'R-1', driverId: 'u-driver',
  stops: [
    { stopId: 's1', orderRef: 'ORD-1041', area: 'Anna Nagar, 3rd St', codMinor: 250_00 },
    { stopId: 's2', orderRef: 'ORD-1044', area: 'Gandhipuram', codMinor: 0 },
  ],
};

describe.skipIf(!existsSync(CHROMIUM))('the driver asks the store to call the customer (OB-700)', () => {
  let browser: Browser;
  const stops: (() => Promise<void>)[] = [];
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'delivery-app'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });

  async function open(): Promise<Page> {
    const srv = await serveShell('delivery-app', { driverData: DRIVER_DATA });
    stops.push(srv.stop);
    const context = await browser.newContext(HANDHELD);
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`${srv.base}/`, { waitUntil: 'load' });
    await page.waitForFunction('globalThis.routeSession !== undefined', undefined, { timeout: 15_000 });
    return page;
  }

  it('one tap on the stop the driver is at; said; listed as sent work; marked on the stop; refused a second time; audited in both languages', async () => {
    const page = await open();
    // The words say the phone holds no number, before the driver taps anything.
    expect(await page.textContent('#ask-call-note')).toBe('This phone holds no customer number. The store calls them for you.');
    expect(await page.textContent('#ask-call')).toContain('Ask the store to call the customer');
    expect(await page.getAttribute('.stop:first-child', 'aria-selected')).toBe('true');
    const taps = new Tally(page);
    await taps.tap('#ask-call');
    await page.waitForSelector('#banner.good:not([hidden])');
    expect(taps.reset(), 'ask the store to call').toBe(1);
    expect(await page.textContent('#banner-title')).toBe('The store has been told');
    expect(await page.textContent('#banner-text')).toContain('ORD-1041');
    expect(await page.textContent('#banner-text')).toContain('You will not see their number on this phone.');
    expect(await auditPage(page, { minTarget: 56, expectLang: 'en' })).toEqual([]);
    await page.click('#banner-ok');

    // Listed, saved here (no store computer behind this page), marked on the stop, never a customer detail on the page.
    await page.waitForSelector('#sent-work .sent[data-kind="call"][data-id="s1"][data-state="saved_here"]');
    expect(await page.textContent('#sent-work .sent[data-id="s1"] .what')).toBe('Call request · Anna Nagar, 3rd St · ORD-1041 — ask the store to call the customer');
    expect(await page.textContent('.stop:first-child .flag.asked')).toContain('store asked to call');
    expect(await page.textContent('main')).not.toMatch(/\+91|@|customer name/i);

    // A second tap: refused by name, nothing added.
    await page.click('#ask-call');
    await page.waitForSelector('#banner:not([hidden])');
    expect(await page.textContent('#banner-text')).toBe('The store has already been asked to call this customer.');
    await page.click('#banner-ok');
    expect(await page.locator('#sent-work .sent[data-kind="call"]').count()).toBe(1);

    // Tamil: the same view, audited.
    await page.click('#lang');
    expect(await page.textContent('#ask-call')).toContain('வாடிக்கையாளரை அழைக்கக் கடையிடம் கேள்');
    expect(await page.textContent('#ask-call-note')).toBe('இந்த ஃபோனில் வாடிக்கையாளர் எண் இல்லை. கடை உங்களுக்காக அவர்களை அழைக்கும்.');
    expect(await page.textContent('.stop:first-child .flag.asked')).toContain('அழைக்கக் கடையிடம் கேட்டாச்சு');
    expect(await auditPage(page, { minTarget: 56, expectLang: 'ta' })).toEqual([]);
  });

  // A finished stop takes no call request: the session's rule, proven in the unit test — the screen always acts on the stop
  // the driver is at, and a finished stop is never that one.
});
