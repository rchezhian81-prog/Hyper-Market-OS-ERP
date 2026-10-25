import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';

/**
 * **OB-366 (owner, 24–25 Oct 2026, in writing): the OA-12 plan prices are SRE's own subscription, labelled "SRE only, not
 * offered to outside shops" on every screen that shows them; pricing for outside shops stays "not set".**
 *
 * The site's two pages that show a plan price — the landing page's plan cards and the subscribe page — opened in a real
 * browser from the shipped files: every price shown sits with the label, in English and Tamil, and the landing page says
 * outside shops' pricing is "not set". Static files only; where no Chromium is installed the suite SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const WEB = 'apps/site/web';
const LABEL_EN = 'SRE only, not offered to outside shops';
const LABEL_TA = 'SRE-க்கு மட்டும் — வெளிக் கடைகளுக்கு வழங்கப்படவில்லை';

describe.skipIf(!existsSync(CHROMIUM))('the plan prices say "SRE only" in a real browser (OB-366)', () => {
  let browser: Browser;
  let server: Server;
  let base = '';
  beforeAll(async () => {
    server = createServer((req, res) => {
      void (async () => {
        const path = (req.url ?? '/').split('?')[0]!;
        const file = path === '/' ? 'index.html' : path.replace(/^\//, '');
        try {
          const body = await readFile(join(WEB, file));
          res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream' });
          res.end(body);
        } catch { res.writeHead(404); res.end('not found'); }
      })();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const a = server.address();
    base = `http://127.0.0.1:${typeof a === 'object' && a !== null ? a.port : 0}`;
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 60_000);
  afterAll(async () => { await browser?.close(); await new Promise<void>((r) => { server?.close(() => r()); server?.closeAllConnections(); }); });

  it('the landing page: each of the three plan prices carries the label, and outside shops\' pricing is "not set"', async () => {
    const page = await browser.newPage();
    await page.goto(`${base}/index.html`, { waitUntil: 'load' });
    const cards = page.locator('#plans .plan');
    expect(await cards.count()).toBe(3);
    for (let i = 0; i < 3; i += 1) {
      const card = cards.nth(i);
      expect(await card.locator('.price').innerText()).toMatch(/₹1[035],000/);
      const label = card.locator('.sre-only');
      expect(await label.isVisible()).toBe(true);
      expect(await label.innerText()).toContain(LABEL_EN);
      expect(await label.innerText()).toContain(LABEL_TA);
    }
    expect(await page.locator('[data-outside-pricing="not set"]').innerText()).toContain('Prices for outside shops: not set.');
    await page.close();
  });

  it('the subscribe page: the plan price and the monthly debit both carry the label', async () => {
    const page = await browser.newPage();
    await page.goto(`${base}/subscribe.html?plan=growth`, { waitUntil: 'load' });
    expect(await page.locator('#price').innerText()).toBe('₹15,000');
    expect(await page.locator('#debit-amt').innerText()).toContain('₹15,000');
    const labels = page.locator('.sre-only');
    expect(await labels.count()).toBe(2);
    for (let i = 0; i < 2; i += 1) {
      expect(await labels.nth(i).isVisible()).toBe(true);
      expect(await labels.nth(i).innerText()).toContain(LABEL_EN);
    }
    await page.close();
  });
});
