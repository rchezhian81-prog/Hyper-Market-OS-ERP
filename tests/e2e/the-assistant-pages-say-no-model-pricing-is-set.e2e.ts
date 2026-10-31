import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';

/**
 * **The assistant pages say the REAL reason the assistant did not run (Round B · P-08 · A09 · A07 · A05).** When the shop
 * has no model pricing set, head office admits no model call and answers 429 with `error.code: 'no_pricing'` (the model
 * gateway's own refusal, `services/ai/src/model-gateway.ts`). The Assistant drafts page said "switched off or out of
 * budget" — the wrong switch. Now it says no model pricing is set for this shop; a kill switch or a spent budget is still
 * said as before. Nothing here turns the assistant on or sets any pricing.
 *
 * The page is served from apps/web-erp/web; every `/v1` call is answered by a stand-in. Skips where no browser is present.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const CASE = { caseId: 'case-1', kind: 'complaint', priority: 'normal', state: 'open', firstResponse: { status: 'within' }, resolution: { status: 'within' } };
const DESK = { userId: 'u-desk', permissions: ['service.case.read', 'service.case.manage'] };
const WHO = { userId: 'u-owner', permissions: ['ai.proposal.read', 'document.template.manage', 'lp.case.read', 'lp.case.manage'] };
let refusal: { status: number; code: string } = { status: 429, code: 'no_pricing' };

function startServer(): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const json = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (url.pathname === '/v1/notifications/templates') return json(200, { templates: [] });
      if (url.pathname === '/v1/service/cases') return json(200, { cases: [CASE] });
      if (url.pathname === '/v1/service/root-causes') return json(200, { byCause: [], resolvedWithoutRootCause: [] });
      if (req.method === 'GET' && url.pathname.startsWith('/v1/service/cases/')) return json(404, { error: { code: 'not_here', whatHappened: '' } });
      if (url.pathname === '/v1/ai/security/anomaly-summaries' && req.method === 'GET') return json(200, { summaries: [] });
      if (url.pathname.startsWith('/v1/')) {
        return json(refusal.status, { error: { code: refusal.code, whatHappened: 'no model pricing is configured for this shop, so no call can be admitted', wasItSaved: 'saved', nextSafeAction: 'x' } });
      }
      const file = url.pathname.replace(/^\/+/, '') || 'ai-drafts.html';
      const injected = file === 'service-desk.html' ? `window.serviceDeskData = ${JSON.stringify(DESK)};` : `window.aiDraftsData = ${JSON.stringify(WHO)};`;
      try {
        let body = (await readFile(join('apps/web-erp/web', file))).toString('utf8');
        if (file.endsWith('.html')) body = body.replace('<!--SCREEN-DATA-->', `<script>${injected}</script>`);
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
        res.end(body);
      } catch {
        res.writeHead(404); res.end('not found');
      }
    })();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolve({ base: `http://127.0.0.1:${port}`, stop: () => new Promise((done) => { server.close(() => { done(); }); server.closeAllConnections(); }) });
    });
  });
}

describe.skipIf(!HAVE_BROWSER)('the assistant drafts page says no model pricing is set', () => {
  let browser: Browser;
  let shell: { base: string; stop: () => Promise<void> };
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    shell = await startServer();
  }, 60_000);
  afterAll(async () => { await shell?.stop(); await browser?.close(); });

  async function ask(button: '#ask-campaign' | '#ask-summary', status: string, lang: 'en' | 'ta' = 'en'): Promise<string> {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    try {
      const page = await context.newPage();
      await page.goto(`${shell.base}/ai-drafts.html`, { waitUntil: 'load' });
      await page.waitForFunction(`(() => { const x = document.querySelector(${JSON.stringify(button)}); return x !== null && !x.disabled; })()`);
      if (lang === 'ta') await page.click('#lang');
      if (button === '#ask-campaign') await page.fill('#tpl-id', 'diwali-offer');
      await page.click(button);
      await page.waitForFunction(`((document.getElementById(${JSON.stringify(status)}) || {}).textContent || '').trim() !== ''`);
      return (await page.textContent(`#${status}`)) ?? '';
    } finally { await context.close(); }
  }

  it('no model pricing: both asks say so, in English and Tamil — never "switched off or out of budget"', async () => {
    refusal = { status: 429, code: 'no_pricing' };
    const campaign = await ask('#ask-campaign', 'camp-status');
    expect(campaign).toContain('no model pricing is set for this shop');
    expect(campaign).not.toContain('switched off or out of budget');
    expect(await ask('#ask-summary', 'anom-status')).toContain('no model pricing is set for this shop');
    const ta = await ask('#ask-campaign', 'camp-status', 'ta');
    expect(ta).toContain('model pricing');
    expect(ta).not.toContain('நிறுத்தப்பட்டுள்ளார்');
  });

  it('the service desk\'s "ask the assistant for a reply" says no model pricing is set too', async () => {
    refusal = { status: 429, code: 'no_pricing' };
    const context = await browser.newContext({ serviceWorkers: 'block' });
    try {
      const page = await context.newPage();
      await page.goto(`${shell.base}/service-desk.html`, { waitUntil: 'load' });
      await page.click('tr[data-case-id="case-1"]');
      await page.waitForSelector('#ask-draft:not([disabled])');
      await page.click('#ask-draft');
      await page.waitForFunction(`((document.getElementById('draft-status') || {}).textContent || '').trim() !== ''`);
      const said = (await page.textContent('#draft-status')) ?? '';
      expect(said).toContain('no model pricing is set for this shop');
      expect(said).not.toContain('switched off or out of budget');
    } finally { await context.close(); }
  });

  it('a kill switch (503) is still said as switched off or out of budget', async () => {
    refusal = { status: 503, code: 'killed' };
    expect(await ask('#ask-campaign', 'camp-status')).toContain('switched off or out of budget');
  });
});
