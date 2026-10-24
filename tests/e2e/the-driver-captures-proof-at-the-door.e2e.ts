import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContextOptions, type Page } from 'playwright-core';
import { takeThePhoto } from './lib/proof-photo';

/**
 * **OB-294 (owner, 23 Oct 2026) · M19-FR-03 · D09-FR-05 — on the driver's phone, in a real browser, the proof is CAPTURED:**
 *
 *   • the customer's 4-digit code on the keypad — every digit counted ("0042" stays "0042"); three digits are refused on
 *     the screen and nothing is queued; the banner says the code is checked at head office when the phone is back;
 *   • a photo through the camera input — made small on the phone and queued as its OWN record before the stop, the stop
 *     carrying only its kind and fingerprint; with location allowed, the phone's position rides on the hand-over only;
 *   • the customer's signature with a finger on the screen — Done is offered only after a stroke;
 *   • Tamil words on the new panels; icons beside the words.
 *
 * No network call is made for any of it (§31). Synthetic data. Self-skips where no browser is present.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const WEB_DIR = 'apps/delivery-app/web';
const PHONE: BrowserContextOptions = { viewport: { width: 360, height: 640 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const ROUTE = {
  routeId: 'R-9', driverId: 'u-driver',
  stops: [
    { stopId: 's1', orderRef: 'ORD-1', area: 'Slot 10:30–12:00', codMinor: 0 },
    { stopId: 's2', orderRef: 'ORD-2', area: 'Slot 10:30–12:00', codMinor: 0 },
    { stopId: 's3', orderRef: 'ORD-3', area: 'Slot 12:00–13:30', codMinor: 0 },
  ],
};

interface Queued { type: string; payload: Record<string, unknown> }
interface PhoneGlobals { routeSession?: unknown; driverOutbox?: { all(): { event: Queued }[] } }

async function startShell(): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      const file = path === '/' ? 'index.html' : path.replace(/^\//, '');
      try {
        let body = (await readFile(join(WEB_DIR, file))).toString('utf8');
        if (file.endsWith('.html')) body = body.replace('<!--SCREEN-DATA-->', `<script>window.driverData = ${JSON.stringify(ROUTE)};</script>`);
        res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream', 'cache-control': 'no-store' });
        res.end(body);
      } catch { res.writeHead(404); res.end(); }
    })();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const a = server.address();
      resolve({ base: `http://127.0.0.1:${typeof a === 'object' && a !== null ? a.port : 0}`, stop: () => new Promise((done) => { server.close(() => done()); server.closeAllConnections(); }) });
    });
  });
}

describe.skipIf(!existsSync(CHROMIUM))('the driver captures proof at the door (OB-294 · M19-FR-03 · D09-FR-05)', () => {
  let browser: Browser;
  let shell: { base: string; stop: () => Promise<void> };
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'delivery-app'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    shell = await startShell();
  }, 120_000);
  afterAll(async () => { await browser?.close(); await shell?.stop(); });

  const queued = (page: Page) => page.evaluate(() => ((globalThis as unknown as PhoneGlobals).driverOutbox?.all() ?? []).map((i) => ({ type: i.event.type, payload: i.event.payload })));
  const chooseProof = async (page: Page, label: string) => {
    await page.click('#deliver');
    await page.waitForSelector('#choices:not([hidden])');
    await page.locator('#choices button', { hasText: label }).click();
  };

  it('the code, every digit counted; a photo queued as its own record with the phone\'s position on the hand-over; a signature after a stroke; Tamil', async () => {
    const context = await browser.newContext({ ...PHONE, geolocation: { latitude: 11.0201, longitude: 76.9601, accuracy: 15 }, permissions: ['geolocation'] });
    const page = await context.newPage();
    const calls: string[] = [];
    const errors: string[] = [];
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') || u.pathname.startsWith('/lane/')) calls.push(u.pathname); });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${shell.base}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as PhoneGlobals).routeSession !== undefined);

    // ── The code: three digits are refused on the screen; nothing is queued.
    await chooseProof(page, '4-digit code');
    await page.waitForSelector('#keypad:not([hidden])');
    expect(await page.textContent('#sheet-title')).toBe('Ask the customer for the 4 numbers in their app');
    for (const k of ['0', '4', '2']) await page.click(`#keypad button:text-is("${k}")`);
    await page.click('#sheet-ok');
    await page.waitForSelector('#banner:not([hidden])');
    expect(await page.textContent('#banner-text')).toBe('The code is 4 numbers. Ask the customer to read it again.');
    await page.click('#banner-ok');
    expect((await queued(page)).filter((q) => q.type === 'DeliveryStopUpdated' && q.payload['state'] === 'delivered')).toEqual([]);
    // Four digits, a leading zero kept; a fifth is not taken.
    await chooseProof(page, '4-digit code');
    for (const k of ['0', '0', '4', '2', '9']) await page.click(`#keypad button:text-is("${k}")`);
    expect(await page.textContent('#entry')).toBe('0042');
    await page.click('#sheet-ok');
    await page.waitForSelector('#banner.good:not([hidden])');
    expect(await page.textContent('#banner-text')).toContain('checked at head office');
    await page.click('#banner-ok');
    const afterCode = await queued(page);
    expect(afterCode.at(-1)).toMatchObject({ type: 'DeliveryStopUpdated', payload: { stopId: 's1', state: 'delivered', proofKind: 'otp', proofCode: '0042', deviceFix: { lat: 11.0201, lon: 76.9601, accuracyMetres: 15 } } });

    // ── The photo: through the camera input; queued as its own record before the stop; the stop carries the fingerprint.
    await chooseProof(page, 'Photo at the door');
    expect(await page.textContent('#photo-title')).toBe('Take a photo of the parcel at the door');
    expect(await page.locator('#photo-open .sre-icon, #photo-title .sre-icon').count()).toBeGreaterThan(0);
    await takeThePhoto(page);
    await page.waitForSelector('#banner.good:not([hidden])');
    await page.click('#banner-ok');
    const afterPhoto = (await queued(page)).slice(afterCode.length);
    expect(afterPhoto.map((q) => [q.type, q.payload['state'] ?? q.payload['kind']])).toEqual([['DeliveryStopUpdated', 'out_for_delivery'], ['DeliveryProofCaptured', 'photo'], ['DeliveryStopUpdated', 'delivered']]);
    const image = afterPhoto[1]!.payload as { mediaType: string; contentBase64: string; sha256: string };
    expect(image.mediaType).toBe('image/jpeg');
    expect(image.contentBase64.length).toBeGreaterThan(100);
    expect(image.contentBase64.length).toBeLessThanOrEqual(60_000);
    expect(afterPhoto[2]!.payload).toMatchObject({ proofKind: 'photo', proofSha256: image.sha256, proofCode: null });
    expect(JSON.stringify(afterPhoto[2]!.payload)).not.toContain(image.contentBase64.slice(0, 40));
    expect(afterPhoto[0]!.payload['deviceFix']).toBeNull(); // the position rides on the hand-over only
    // "Sent from this phone" lists the picture by its stop.
    await page.waitForSelector('#sent-work .sent[data-kind="proof"][data-id="s2"]');

    // ── The signature: Done waits for a stroke.
    await chooseProof(page, 'signs on the screen');
    await page.waitForSelector('#sign:not([hidden])');
    expect(await page.isDisabled('#sign-done')).toBe(true);
    const pad = (await page.locator('#sign-pad').boundingBox())!;
    await page.mouse.move(pad.x + 20, pad.y + 40);
    await page.mouse.down();
    await page.mouse.move(pad.x + 120, pad.y + 90, { steps: 8 });
    await page.mouse.move(pad.x + 220, pad.y + 30, { steps: 8 });
    await page.mouse.up();
    expect(await page.isDisabled('#sign-done')).toBe(false);
    await page.click('#sign-done');
    await page.waitForSelector('#banner.good:not([hidden])');
    await page.click('#banner-ok');
    const sig = (await queued(page)).find((q) => q.type === 'DeliveryProofCaptured' && q.payload['kind'] === 'signature');
    expect(sig?.payload).toMatchObject({ stopId: 's3', mediaType: 'image/png' });

    // ── Tamil on the new panels.
    await page.click('#lang');
    await page.click('#failed'); // any stop is finished now — the screen says so in Tamil
    await page.waitForSelector('#banner:not([hidden])');
    await page.click('#banner-ok');
    expect(calls).toEqual([]); // nothing asked of any network for any of it (§31)
    expect(errors).toEqual([]);
    await context.close();
  }, 120_000);

  it('a photo panel cancelled, or location refused, records nothing and blocks nothing', async () => {
    const context = await browser.newContext({ ...PHONE });
    const page = await context.newPage();
    await page.goto(`${shell.base}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as PhoneGlobals).routeSession !== undefined);
    await chooseProof(page, 'Photo at the door');
    await page.waitForSelector('#photo:not([hidden])');
    await page.click('#photo-cancel');
    await page.waitForSelector('#banner:not([hidden])');
    expect(await page.textContent('#banner-text')).toBe('A delivery is not complete without proof. Take a photo, get the OTP, or get a signature.');
    await page.click('#banner-ok');
    expect((await queued(page))).toEqual([]);
    await page.click('#lang'); // the next panel is drawn in Tamil
    // Location not allowed: the delivery still goes through, with no position.
    await chooseProof(page, 'வாசலில் புகைப்படம்');
    expect(await page.textContent('#photo-title')).toBe('வாசலில் பொதியைப் புகைப்படம் எடுக்கவும்');
    await takeThePhoto(page);
    await page.waitForSelector('#banner.good:not([hidden])', { timeout: 15_000 });
    expect((await queued(page)).at(-1)?.payload).toMatchObject({ state: 'delivered', proofKind: 'photo', deviceFix: null });
    await context.close();
  }, 120_000);
});
