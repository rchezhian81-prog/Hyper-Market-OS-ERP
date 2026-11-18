import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { startOfficeBox } from '../support/office-box';
import { createDemoLoginHandler, FailureThrottle } from '../../infra/pilot/demo-login/login';

/**
 * Batch 16 · P-01 (owner: "the sign-in page uses the self-hosted Plus Jakarta Sans and Anek Tamil fonts, offline, with no
 * internet"), in real Chromium with EVERY request refused except to the box itself:
 *   • the store PC's front door draws its words in Plus Jakarta Sans, loaded from the box's own /fonts/;
 *   • after switching to தமிழ் the Tamil words are drawn in Anek Tamil, also from the box;
 *   • the "work is on the till" page shares the same faces;
 *   • the hosted demo sign-in does the same from its own /login/fonts/;
 *   • nothing is ever asked of any other host.
 * The browser is the environment's pre-installed Chromium; where none is present the suite SKIPS (CI provides one).
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const SHOT = process.env['SRE_SIGN_IN_SHOT'];
const FONTS = join(process.cwd(), 'packages/ui/web/fonts');

/** The page's (globalThis as unknown as { document: PageFonts }).document.fonts, typed here (this suite compiles without the DOM library). */
interface PageFonts { readonly fonts: Iterable<{ readonly family: string; readonly weight: string; readonly status: string }> & { readonly ready: Promise<unknown>; check(font: string, text?: string): boolean } }

/** Each declared face of `family` and its state, as the page's own (globalThis as unknown as { document: PageFonts }).document.fonts reports it. */
const faces = (page: Page, family: string): Promise<{ weight: string; status: string }[]> => page.evaluate((fam) =>
  [...(globalThis as unknown as { document: PageFonts }).document.fonts].filter((f) => f.family.replace(/"/g, '') === fam).map((f) => ({ weight: f.weight, status: f.status })), family);

/** Wait until at least one face of `family` has loaded (the browser fetches a face only when visible text needs it). */
async function loaded(page: Page, family: string): Promise<string[]> {
  await page.waitForFunction((fam) => [...(globalThis as unknown as { document: PageFonts }).document.fonts].some((f) => f.family.replace(/"/g, '') === fam && f.status === 'loaded'), family, { timeout: 15_000 });
  await page.evaluate(() => (globalThis as unknown as { document: PageFonts }).document.fonts.ready);
  return (await faces(page, family)).filter((f) => f.status === 'loaded').map((f) => f.weight);
}

describe.skipIf(!existsSync(CHROMIUM))('batch 16: the sign-in page draws its own fonts with the internet cut off', () => {
  let browser: Browser;
  const stops: (() => Promise<void>)[] = [];
  beforeAll(async () => { browser = await chromium.launch({ headless: true, executablePath: CHROMIUM }); }, 60_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });

  /** A browser that can reach `base` and nothing else; every other request is refused and remembered. */
  async function offline(base: string, deviceScaleFactor = 1): Promise<{ page: Page; refused: string[]; fonts: string[] }> {
    const context: BrowserContext = await browser.newContext({ viewport: { width: 1366, height: 860 }, deviceScaleFactor, serviceWorkers: 'block' });
    stops.push(() => context.close());
    const refused: string[] = [];
    const fonts: string[] = [];
    const host = new URL(base).host;
    await context.route('**/*', (route) => {
      const u = new URL(route.request().url());
      if (u.host !== host) { refused.push(u.href); return route.abort('internetdisconnected'); }
      return route.continue();
    });
    const page = await context.newPage();
    page.on('response', (r) => { if (r.request().resourceType() === 'font') fonts.push(`${r.status()} ${new URL(r.url()).pathname}`); });
    return { page, refused, fonts };
  }

  it('the store PC front door: Plus Jakarta Sans in English, Anek Tamil after switching to தமிழ், all from the box', async () => {
    const box = await startOfficeBox();
    stops.push(() => box.stop());
    const { page, refused, fonts } = await offline(box.base);
    expect((await page.goto(`${box.base}/`, { waitUntil: 'load' }))?.status()).toBe(200);
    expect(await page.title()).toBe('Sign in — SRE Hyper Market');

    expect(await loaded(page, 'Plus Jakarta Sans')).toContain('400');
    expect(await page.evaluate(() => (globalThis as unknown as { document: PageFonts }).document.fonts.check('16px "Plus Jakarta Sans"', 'Sign in'))).toBe(true);

    await page.click('label[for="sl-lang-ta"]');
    expect(await page.locator('#office-heading [lang="ta"]').isVisible()).toBe(true);
    expect((await loaded(page, 'Anek Tamil')).length).toBeGreaterThan(0);
    expect(await page.evaluate(() => (globalThis as unknown as { document: PageFonts }).document.fonts.check('16px "Anek Tamil"', 'மீண்டும் வருக'))).toBe(true);
    if (SHOT !== undefined) {
      await page.click('label[for="sl-lang-en"]');
      await page.evaluate(() => (globalThis as unknown as { document: PageFonts }).document.fonts.ready);
      mkdirSync(dirname(SHOT), { recursive: true });
      await page.screenshot({ path: SHOT, fullPage: true });
    }

    expect(fonts.length).toBeGreaterThan(0);
    for (const f of fonts) expect(f).toMatch(/^200 \/fonts\/(plus-jakarta-sans|anek-tamil)-\d{3}\.woff2$/);
    expect(refused).toEqual([]);
  }, 120_000);

  it('the "work is on the till" page shares the faces', async () => {
    const box = await startOfficeBox();
    stops.push(() => box.stop());
    const { page, refused } = await offline(box.base);
    await page.goto(`${box.base}/office/`, { waitUntil: 'load' });
    await page.fill('#office-staff', 'u-cashier');
    await page.fill('#office-pin', '998877');
    await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('#office-submit')]);
    expect(await page.locator('#office-heading [lang="en"]').innerText()).toBe('Your work is on the till');
    expect(await loaded(page, 'Plus Jakarta Sans')).toContain('400');
    expect(refused).toEqual([]);
  }, 120_000);

  it('the hosted demo sign-in draws the same faces from its own /login/fonts/', async () => {
    const handle = createDemoLoginHandler({
      logins: () => ({ version: 1, logins: [] }),
      idp: { secret: ['batch', 'sixteen', 'fonts'].join('-').padEnd(48, '0'), issuer: 'https://idp.test', audience: 'sre' },
      throttle: new FailureThrottle(), now: () => Date.now(), audit: () => {},
      font: (name) => readFileSync(join(FONTS, name)),
    });
    const server: Server = createServer((req, res) => {
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : v;
      const out = handle({ method: req.method ?? 'GET', url: req.url ?? '/', headers, body: '' });
      res.writeHead(out.status, out.headers).end(out.bytes ?? out.body);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    stops.push(() => new Promise<void>((r) => server.close(() => r())));
    const address = server.address();
    const base = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
    const { page, refused, fonts } = await offline(base);
    const violations: string[] = [];
    page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) violations.push(m.text()); });
    await page.goto(`${base}/login/`, { waitUntil: 'load' });
    expect(await loaded(page, 'Plus Jakarta Sans')).toContain('400');
    await page.click('button[data-language="ta"]');
    expect(await page.locator('html').getAttribute('lang')).toBe('ta');
    expect((await loaded(page, 'Anek Tamil')).length).toBeGreaterThan(0);
    for (const f of fonts) expect(f).toMatch(/^200 \/login\/fonts\/(plus-jakarta-sans|anek-tamil)-\d{3}\.woff2$/);
    expect(refused).toEqual([]);
    expect(violations).toEqual([]);
  }, 120_000);
});
