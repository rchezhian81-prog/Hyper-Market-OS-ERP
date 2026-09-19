import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';

/**
 * **The operator launches an offer, in a real browser (M05-FR-03/04, ADR-0013 — the E2E matrix).**
 *
 * Every layer of "a person launches a promotion, and it is RECORDED at head office under their own session" is
 * unit-tested — the session's `launchToCloud`, the browser's `openPromotionLaunchPort`, the cloud's launch
 * route with its §28 re-check. The one thing units cannot prove is that a person filling the Offer form in an
 * actual browser, pressing **Start this offer**, makes that launch reach the cloud, keyed for idempotency,
 * under that operator's own session — and that the screen then shows exactly what the cloud decided and invents
 * no verdict of its own. This drives headless Chromium against a stub cloud to prove that end to end:
 *
 *   • a margin-IMPROVING offer → launches with nobody's signature; the POST arrives carrying the simulation
 *     INPUT (not a client verdict); the banner says it started and the button hides;
 *   • a margin-LOSING offer → the screen asks for a §28 approver (a DIFFERENT person, with a written reason)
 *     on an on-screen panel, and the launch POST then carries that approver + reason for the cloud to verify;
 *   • the cloud REFUSES (422) → the screen surfaces the reason verbatim and NEVER claims a launch (P-08); the
 *     button stays, so the person can fix it and try again.
 *
 * The browser binary is the environment's pre-installed Chromium; where none is present the suite SKIPS rather
 * than failing, exactly like the other e2e suites.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/web-erp/web';

/**
 * The slice of the browser's globals these callbacks touch, cast structurally INSIDE each `page.evaluate` /
 * `waitForFunction` — so the callback references no DOM lib and this test file needs none. The cast is erased
 * at compile time; the browser receives plain `globalThis`.
 */
interface BrowserGlobals {
  readonly catalogueSession?: { readonly canLaunchToCloud: boolean };
}

/** What the ERP would inject about the signed-in operator and the shop's pricing policy. */
interface Recorder {
  catalogueData: Record<string, unknown>;
  launchStatus: number;
  launchBody: Record<string, unknown>;
  readonly requests: { method: string; path: string; body: unknown }[];
}

/** A server that BOTH serves the catalogue shell (GET, with the operator context injected) AND answers the
 *  launch route the operator-session port POSTs to — the same origin, so `credentials: 'same-origin'` and a
 *  relative `/v1/...` reach it exactly as they do in production. */
async function startShellAndCloud(rec: Recorder): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      if (req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks).toString('utf8');
        rec.requests.push({ method: 'POST', path, body: raw === '' ? undefined : JSON.parse(raw) });
        res.writeHead(rec.launchStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify(rec.launchBody));
        return;
      }
      const file = path === '/' || path === '/catalogue' ? 'catalogue.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
        let body = buf.toString('utf8');
        if (file.endsWith('.html')) {
          const inject = `<script>window.catalogueData = ${JSON.stringify(rec.catalogueData).replace(/</g, '\\u003c')};</script>`;
          body = body.replace('<!--SCREEN-DATA-->', inject);
        }
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end('not found');
      }
    })();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolve({ base: `http://127.0.0.1:${port}`, stop: () => new Promise((done) => { server.close(() => { done(); }); }) });
    });
  });
}

/** A pricing operator with a margin floor and a DIFFERENT person named as an approver (§28). */
const pricingContext = (): Record<string, unknown> => ({
  userId: 'u-pricing', storeId: 'store-1', today: '2026-09-18',
  marginFloorBps: 2000, approvers: ['u-owner'],
});

describe.skipIf(!HAVE_BROWSER)('operator promotion-launch delivery, end to end in a real browser (M05-FR-03/04)', () => {
  let browser: Browser;

  beforeAll(async () => {
    // Build the CURRENT web-erp bundle so the browser runs this branch's code, not a stale artifact.
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  /** Open the catalogue screen on the Offer tab with the given operator context. */
  const openOfferTab = async (rec: Recorder) => {
    const srv = await startShellAndCloud(rec);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${srv.base}/`, { waitUntil: 'load' });
    // Boot is done once the tested session is wired to the window (and it can reach head office).
    await page.waitForFunction(
      () => (globalThis as unknown as BrowserGlobals).catalogueSession?.canLaunchToCloud === true,
      undefined, { timeout: 10_000 },
    );
    await page.click('#tab-promo');
    return { srv, context, page, teardown: async () => { await context.close(); await srv.stop(); } };
  };

  /** Fill the Offer form. Prices in rupees, exactly as a person types them. */
  const fillOffer = async (
    page: import('playwright-core').Page,
    o: { id: string; normal: string; promo: string; cost: string; baseline: string; expected: string },
  ) => {
    await page.fill('#promo-id', o.id);
    await page.fill('#promo-normal', o.normal);
    await page.fill('#promo-price', o.promo);
    await page.fill('#promo-cost', o.cost);
    await page.fill('#promo-baseline', o.baseline);
    await page.fill('#promo-expected', o.expected);
    await page.click('#simulate');
    await page.waitForSelector('#launch:not([hidden])', { timeout: 10_000 });
  };

  const launchHidden = (page: import('playwright-core').Page) =>
    page.evaluate(() => {
      const el = (globalThis as unknown as { document: { getElementById(id: string): { hidden?: boolean } | null } })
        .document.getElementById('launch');
      return el === null ? true : Boolean(el.hidden);
    });

  it('a margin-improving offer launches with nobody’s signature: the POST carries the simulation INPUT, keyed', async () => {
    const rec: Recorder = {
      catalogueData: pricingContext(), launchStatus: 201,
      launchBody: { launched: true, verdict: 'improves_margin', approvedBy: null }, requests: [],
    };
    const { page, teardown } = await openOfferTab(rec);
    try {
      await fillOffer(page, { id: 'pongal-dal', normal: '145', promo: '130', cost: '100', baseline: '100', expected: '200' });
      await page.click('#launch');
      await page.waitForSelector('#banner:not([hidden])', { timeout: 10_000 });

      // The launch reached the cloud, at the offer's own route, under the operator's own session.
      const launchReq = rec.requests.find((r) => r.path === '/v1/promotions/pongal-dal/launch');
      expect(launchReq, 'the launch was not POSTed').toBeDefined();
      // The body carries the simulation INPUT (the cloud re-simulates from it) — not a client-computed verdict.
      const body = launchReq!.body as { promotionId?: string; promoPrice?: { minor?: number }; approvedBy?: string };
      expect(body.promotionId).toBe('pongal-dal');
      expect(body.promoPrice?.minor).toBe(130_00);
      // A margin-improving offer carries no approver.
      expect(body.approvedBy).toBeUndefined();

      // The screen shows what the cloud decided and the button hides — the offer is away.
      expect(((await page.textContent('#banner-title')) ?? '').toLowerCase()).toContain('offer');
      expect(await launchHidden(page)).toBe(true);
    } finally {
      await teardown();
    }
  });

  it('a margin-losing offer asks for a §28 approver on screen, and the launch carries that approver + reason', async () => {
    const rec: Recorder = {
      catalogueData: pricingContext(), launchStatus: 201,
      launchBody: { launched: true, verdict: 'below_floor', approvedBy: 'u-owner' }, requests: [],
    };
    const { page, teardown } = await openOfferTab(rec);
    try {
      // Offer price BELOW cost — a deliberate margin loss that needs a different, authorised approver.
      await fillOffer(page, { id: 'loss-leader', normal: '145', promo: '80', cost: '100', baseline: '100', expected: '400' });
      await page.click('#launch');

      // The on-screen approver panel opens (never a browser prompt); nothing has been sent yet.
      await page.waitForSelector('#sheet:not([hidden])', { timeout: 10_000 });
      expect(rec.requests).toHaveLength(0);

      // A written reason is required, then the approver — the only choice offered is u-owner (me is filtered out).
      await page.fill('#sheet-reason', 'footfall driver for Pongal weekend');
      await page.click('#choices button');
      await page.waitForSelector('#banner:not([hidden])', { timeout: 10_000 });

      const launchReq = rec.requests.find((r) => r.path === '/v1/promotions/loss-leader/launch');
      expect(launchReq, 'the launch was not POSTed').toBeDefined();
      const body = launchReq!.body as { approvedBy?: string; rationale?: string };
      // The name and reason ride alongside the input; the cloud verifies the authority — a typed name is not one.
      expect(body.approvedBy).toBe('u-owner');
      expect(body.rationale).toBe('footfall driver for Pongal weekend');
      expect(await launchHidden(page)).toBe(true);
    } finally {
      await teardown();
    }
  });

  it('the cloud refuses (422): the screen surfaces the reason verbatim and never claims a launch (P-08)', async () => {
    const rec: Recorder = {
      catalogueData: pricingContext(), launchStatus: 422,
      launchBody: { launched: false, whatHappened: 'this offer loses margin and needs an authorised approver' }, requests: [],
    };
    const { page, teardown } = await openOfferTab(rec);
    try {
      await fillOffer(page, { id: 'pongal-dal', normal: '145', promo: '130', cost: '100', baseline: '100', expected: '200' });
      await page.click('#launch');
      await page.waitForSelector('#banner:not([hidden])', { timeout: 10_000 });

      // The cloud was asked, and refused; the screen shows its reason and does NOT report a launch.
      expect(rec.requests.some((r) => r.path === '/v1/promotions/pongal-dal/launch')).toBe(true);
      expect((await page.textContent('#banner-text')) ?? '').toContain('needs an authorised approver');
      // The button stays, so the person can correct the offer and try again.
      expect(await launchHidden(page)).toBe(false);
    } finally {
      await teardown();
    }
  });
});
