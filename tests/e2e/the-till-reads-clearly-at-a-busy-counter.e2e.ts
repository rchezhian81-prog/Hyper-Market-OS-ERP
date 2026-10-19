import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { auditPage } from './lib/a11y-audit';
import { contrastRatio } from '../../packages/a11y/src/contrast';

/**
 * **OB-205 (the till): the screen a cashier reads all day, at a busy counter, on a 1366×768, 1280×800 or 1024×768
 * touchscreen — calm, crisp and fast to read, inside the approved look.**
 *
 * In real Chromium, the real till page with the real bundled session (no store computer behind it; a stand-in answers
 * the badge's `GET /lane/sync-status`, so the page logs nothing it did not cause):
 *
 *   1. the status strip is ONE line at every desk width: the lane and cashier, Sign in, the connection chip (its state's
 *      shape + the state word), the unsent count and the language — no button pushed onto a second row, even when the
 *      box is gone and the words are at their longest, in English and in Tamil;
 *   2. the bill has clear columns: the batch and the HUID as tags under the item, the amount right-aligned in tabular
 *      figures, the selected line marked by a bar (a shape, not only a colour), a voided line struck through WITH the
 *      word and its reason;
 *   3. the total is named "Total to pay" — in the cashier's language — and is the largest words on the screen;
 *   4. the five actions keep their names, sit in one row, are at least 56px tall, and Tender is the widest;
 *   5. the panels (tender, cash, the age check, the drawer count, a refusal) fit the screen: a clear title, every
 *      denomination of the count on screen at once with its label inside its own cell, big buttons;
 *   6. nothing overflows its box, the page logs no error, and the accessibility audit is clean in English and Tamil;
 *   7. the customer display: the bill and the amount to pay on panels, the amount the largest figure, clean in both;
 *   8. (OB-238) the banner's tone: a completed cash sale's "Change due" is green with the tick, a recalled scan stays
 *      red with the stop mark, every part of both AA, the OK button 56px with its focus ring, in English and Tamil.
 *      Both checks failed with the OB-205 page put back (every banner red, no mark), and the stop check fails when the
 *      recall refusal is given the success tone.
 *
 * Every check here failed on the page before OB-205 (checked by putting the old page back once): the strip took two
 * rows, a voided line looked live, the column heads and "Total to pay" stayed English in Tamil, the page language never
 * changed, the drawer count scrolled and its labels ran into the buttons, and the customer display had no panels.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const DIR = 'apps/pos/web';
const DESKS = [
  { width: 1366, height: 768 },
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
] as const;

async function serve(globals: Record<string, unknown>): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      const file = path === '/' ? 'index.html' : path.replace(/^\//, '');
      // The browser asks for a tab icon on its own; the store computer has none to give, and that is not the page's error.
      if (file === 'favicon.ico') { res.writeHead(204); res.end(); return; }
      try {
        let text = (await readFile(join(DIR, file))).toString('utf8');
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.webmanifest') ? 'application/manifest+json' : 'application/octet-stream';
        if (file.endsWith('.html')) {
          const tags = Object.entries(globals).map(([name, value]) => `<script>window.${name} = ${JSON.stringify(value)};</script>`).join('');
          text = text.replace('<!--SCREEN-DATA-->', tags);
        }
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
        res.end(text);
      } catch {
        res.writeHead(404); res.end('not found');
      }
    })();
  });
  return listen(server);
}

/**
 * The till's own store computer, answering on the till's loopback socket (127.0.0.1:8090) inside this browser only —
 * never a real port, so it cannot meet another test's box: head office out of reach and two sales waiting; nobody
 * signed in; nothing held; a float out (so More offers Close till). "The box is gone" refuses every call instead.
 */
async function storeComputer(context: BrowserContext, gone: boolean): Promise<void> {
  const at = new Date(Date.now() - 60_000).toISOString();
  await context.route('http://127.0.0.1:8090/**', async (route) => {
    if (gone) { await route.abort('connectionrefused'); return; }
    const path = new URL(route.request().url()).pathname;
    const body = path === '/lane/sync-status' ? { cloud: 'offline', unsent: 2, deadLettered: 0, lastSentAt: at, lastContactAt: at, now: new Date().toISOString(), staffMessage: '' }
      : path === '/lane/operator' ? { signInBy: 'pin' }
        : path === '/lane/held-bills' ? { held: [] }
          : path === '/lane/till-cash' ? { shiftOpen: true }
            : {};
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  });
}

function listen(server: Server): Promise<{ base: string; stop: () => Promise<void> }> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolve({ base: `http://127.0.0.1:${port}`, stop: () => new Promise((done) => { server.close(() => { done(); }); server.closeAllConnections(); }) });
    });
  });
}

/** Ring six lines through the real session: one with a batch, one gold piece with its HUID, one voided "scanned twice". */
const RING = String.raw`(() => {
  const s = globalThis.posSession;
  for (const [productId, description, unitPriceMinor, qty] of [
    ['P1', 'Amul Ghee Gold 1L', 64000, 1], ['P2', 'Paneer 200g', 9000, 2], ['P3', 'Gold ring 22K', 4500000, 1],
    ['P4', 'Toor dal 1kg', 14500, 3], ['P5', 'Aachi Sambar Powder 200g', 6500, 1], ['P6', 'Sunflower oil 1L', 16000, 1],
  ]) s.scan({ productId, description, unitPriceMinor, qty });
  const own = s.basket.bind(s);
  s.basket = () => own().map((l) => l.productId === 'P2' ? { ...l, batchId: 'B-2' } : l.productId === 'P3' ? { ...l, huid: 'AB12CD' } : l);
  s.voidLine(own()[4].lineId, 'scanned_twice');
  return true;
})()`;

/** Every visible element that runs past its own box or past the window, by selector. */
const OVERFLOWS = String.raw`(() => {
  const out = [];
  const vw = document.documentElement.clientWidth, vh = window.innerHeight;
  const visible = (el) => { const r = el.getBoundingClientRect(); if (r.width === 0 || r.height === 0) return false; for (let n = el; n; n = n.parentElement) { const s = getComputedStyle(n); if (s.display === 'none' || s.visibility === 'hidden') return false; } return true; };
  const name = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).join('.') : '') + ' "' + (el.textContent || '').trim().slice(0, 24) + '"';
  for (const el of document.querySelectorAll('header *, footer *, td, th, .sheet:not([hidden]) .sheet-inner *, .refusal:not([hidden]) *')) {
    // a screen-reader-only join is a 1px clipped box by design
    if (!visible(el) || el.closest('svg') || el.classList.contains('sr-only')) continue;
    const r = el.getBoundingClientRect();
    if (r.right > vw + 1 || r.left < -1) out.push('off the window sideways: ' + name(el));
    if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'auto' && el.clientWidth > 0) out.push('runs past its box: ' + name(el));
  }
  for (const el of document.querySelectorAll('.sheet:not([hidden]) .sheet-inner, .refusal:not([hidden])')) {
    const r = el.getBoundingClientRect();
    if (r.top < -1 || r.bottom > vh + 1) out.push('panel off the screen: ' + name(el));
  }
  return out;
})()`;

/** The strip's geometry: every control's row against the lane's, and the chip's shape and words. */
const STRIP = String.raw`(() => {
  const mid = (el) => { const r = el.getBoundingClientRect(); return Math.round(r.top + r.height / 2); };
  const lane = mid(document.getElementById('lane'));
  const controls = ['signin', 'conn', 'unsent', 'lang'].map((id) => ({ id, off: Math.abs(mid(document.getElementById(id)) - lane) }));
  const conn = document.getElementById('conn');
  return { controls, tone: conn.dataset.tone, shape: conn.querySelector('#conn-dot svg')?.getAttribute('data-icon') ?? null,
    state: document.getElementById('conn-state').textContent, height: Math.round(document.querySelector('header').getBoundingClientRect().height) };
})()`;

/** The bill as drawn: per row its classes, the item's tags, struck parts, and the selected row's marks. */
const BILL = String.raw`(() => [...document.querySelectorAll('#lines tr')].map((tr) => {
  const [item, qty, amount] = tr.querySelectorAll('td');
  const cs = (el) => getComputedStyle(el);
  return {
    desc: item.querySelector('.desc')?.textContent ?? item.textContent,
    tags: [...item.querySelectorAll('.meta, .void-note')].map((t) => t.textContent),
    struck: cs(item.querySelector('.desc') ?? item).textDecorationLine.includes('line-through') && cs(amount).textDecorationLine.includes('line-through'),
    selected: tr.getAttribute('aria-selected') === 'true',
    bar: cs(item).boxShadow,
    background: cs(item).backgroundColor,
    amountAlign: cs(amount).textAlign, qtyAlign: cs(qty).textAlign,
    figures: cs(amount).fontVariantNumeric,
  };
}))()`;

const ACTIONS = String.raw`(() => ['qty', 'void', 'hold', 'more', 'tender'].map((id) => {
  const b = document.getElementById(id); const r = b.getBoundingClientRect();
  return { id, words: b.textContent.trim(), top: Math.round(r.top), height: Math.round(r.height), width: Math.round(r.width), icon: b.querySelector('svg')?.getAttribute('data-icon') ?? null };
}))()`;

describe.skipIf(!HAVE_BROWSER)('OB-205: the till reads clearly at a busy counter, in English and Tamil', () => {
  let browser: Browser;
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'pos'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });

  async function till(viewport: { width: number; height: number }, opts: { boxGone?: boolean } = {}): Promise<{ page: Page; errors: string[] }> {
    const srv = await serve({});
    stops.push(srv.stop);
    const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
    stops.push(() => context.close());
    await storeComputer(context, opts.boxGone === true);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    await page.goto(`${srv.base}/index.html`, { waitUntil: 'load' });
    await page.waitForFunction('globalThis.posSession !== undefined && typeof globalThis.sreIcon === "function" && globalThis.posBadge.state().asked', undefined, { timeout: 15_000 });
    return { page, errors };
  }
  const tamil = async (page: Page): Promise<void> => {
    await page.click('#lang');
    await page.waitForFunction('document.documentElement.lang === "ta"', undefined, { timeout: 3_000 });
  };
  const ring = async (page: Page): Promise<void> => {
    await page.evaluate(RING);
    await page.click('#lang'); await page.click('#lang'); // the shell draws the bill on its own events
    await page.click('#lines tr:nth-child(4)'); // select Toor dal
  };

  for (const vp of DESKS) {
    for (const lang of vp.width === 1366 ? (['en', 'ta'] as const) : (['en'] as const)) {
      it(`at ${vp.width}×${vp.height} in ${lang === 'en' ? 'English' : 'Tamil'}: one-line strip, clear bill, named total, one row of actions, nothing overflows, audit clean`, async () => {
        const { page, errors } = await till(vp);
        if (lang === 'ta') await tamil(page);
        await ring(page);

        // 1. the strip — one line, the chip in its tone with its shape and its word
        const strip = await page.evaluate(STRIP) as { controls: { id: string; off: number }[]; tone: string; shape: string | null; state: string; height: number };
        for (const c of strip.controls) expect(c.off, `${c.id} sits on another row of the strip`).toBeLessThanOrEqual(12);
        expect(strip.height, 'the strip is one row of 56px targets').toBeLessThanOrEqual(100);
        expect(strip.tone).toBe('degraded');
        expect(strip.shape).toBe('clock');
        expect(strip.state).toBe(lang === 'en' ? 'Selling offline — head office cannot be reached' : 'ஆஃப்லைனில் விற்பனை — தலைமை அலுவலகத்தை அடைய முடியவில்லை');
        expect(await page.textContent('#unsent')).toBe(lang === 'en' ? 'Unsent: 2' : 'அனுப்பப்படாதவை: 2');
        expect(await page.getAttribute('#unsent', 'data-waiting')).toBe('');

        // 2. the bill
        const rows = await page.evaluate(BILL) as { desc: string; tags: string[]; struck: boolean; selected: boolean; bar: string; background: string; amountAlign: string; qtyAlign: string; figures: string }[];
        expect(rows.map((r) => r.desc)).toEqual(['Amul Ghee Gold 1L', 'Paneer 200g', 'Gold ring 22K', 'Toor dal 1kg', 'Aachi Sambar Powder 200g', 'Sunflower oil 1L']);
        expect(rows[1]!.tags).toEqual([lang === 'en' ? 'Batch B-2' : 'தொகுதி B-2']);
        expect(rows[2]!.tags).toEqual(['HUID AB12CD']);
        expect(rows[4]!.struck, 'a voided line is struck through').toBe(true);
        expect(rows[4]!.tags).toEqual([lang === 'en' ? 'Voided: Scanned twice' : 'நீக்கப்பட்டது: இருமுறை ஸ்கேன் ஆனது']);
        expect(rows.filter((r) => r.struck)).toHaveLength(1);
        expect(rows[3]!.selected).toBe(true);
        expect(rows[3]!.bar, 'the selected line carries a bar — a shape, not only a colour').toMatch(/inset/);
        expect(rows[3]!.background).not.toBe(rows[0]!.background);
        for (const r of rows) { expect(r.amountAlign).toBe('right'); expect(r.qtyAlign).toBe('right'); expect(r.figures).toContain('tabular-nums'); }
        // the line still reads as one sentence of words
        expect(await page.textContent('#lines')).toContain('Paneer 200g · ');
        expect(await page.locator('th').allTextContents()).toEqual(lang === 'en' ? ['Item', 'Qty', 'Amount'] : ['பொருள்', 'எண்ணிக்கை', 'தொகை']);

        // 3. the total
        expect(await page.textContent('#total-label')).toBe(lang === 'en' ? 'Total to pay' : 'செலுத்த வேண்டிய மொத்தம்');
        expect(await page.textContent('#total')).toBe('₹46,415.00');
        const biggest = await page.evaluate(`Math.max(...[...document.querySelectorAll('body *')].filter((e) => e.id !== 'total' && e.closest('#total') === null && e.offsetParent !== null && (e.textContent || '').trim() !== '').map((e) => parseFloat(getComputedStyle(e).fontSize)))`) as number;
        const total = await page.evaluate(`parseFloat(getComputedStyle(document.getElementById('total')).fontSize)`) as number;
        expect(total, 'the total is the largest words on the screen').toBeGreaterThan(biggest);

        // 4. the actions
        const actions = await page.evaluate(ACTIONS) as { id: string; words: string; top: number; height: number; width: number; icon: string | null }[];
        expect(actions.map((a) => a.words)).toEqual(lang === 'en' ? ['Qty', 'Void', 'Hold', 'More', 'Tender'] : ['எண்ணிக்கை', 'நீக்கு', 'நிறுத்து', 'மேலும்', 'பணம் பெறு']);
        expect(new Set(actions.map((a) => a.top)).size, 'the actions sit in one row').toBe(1);
        for (const a of actions) { expect(a.height, `${a.id} is a 56px target`).toBeGreaterThanOrEqual(56); expect(a.icon, `${a.id} wears its mark`).not.toBeNull(); }
        expect(actions[4]!.width, 'Tender is the widest').toBeGreaterThan(Math.max(...actions.slice(0, 4).map((a) => a.width)));

        // 6. nothing overflows, the audit is clean, nothing logged
        expect(await page.evaluate(OVERFLOWS)).toEqual([]);
        expect(await auditPage(page, { expectLang: lang }), 'the sale screen').toEqual([]);
        expect(await page.evaluate('document.getAnimations().length'), 'nothing moves on the till').toBe(0);
        expect(errors).toEqual([]);
      }, 60_000);
    }

    it(`at ${vp.width}×${vp.height}: the panels fit — tender, cash, the age check, the drawer count, a refusal — and the audit stays clean`, async () => {
      const { page, errors } = await till(vp);
      await ring(page);
      const check = async (what: string): Promise<void> => {
        expect(await page.evaluate(OVERFLOWS), what).toEqual([]);
        expect(await auditPage(page, { expectLang: 'en' }), what).toEqual([]);
      };

      // tender: the four ways to pay, each with its mark beside its words
      await page.click('#tender');
      await page.waitForSelector('#pay:not([hidden])');
      expect(await page.$$eval('#pay-kinds button', (b) => b.map((x) => [x.textContent, x.querySelector('svg')?.getAttribute('data-icon') ?? null]))).toEqual([
        ['Cash — ₹46,415.00', 'banknote'], ['Card — ₹46,415.00', 'wallet'], ['UPI — ₹46,415.00', 'monitor-smartphone'], ['Split / points / store credit', 'arrow-left-right'],
      ]);
      // the mark never hides the words from the button: a choice is still found by its exact words
      expect(await page.locator('#pay-kinds button:text-is("Split / points / store credit")').count()).toBe(1);
      expect(await page.isHidden('#pay-kicker')).toBe(true);
      await check('the tender panel');
      // cash: the keypad, the one-tap amounts and OK all on screen
      await page.click('#pay-kinds button:first-child');
      await page.waitForSelector('#sheet:not([hidden]) #quick:not([hidden])');
      await check('the cash panel');
      await page.click('#sheet-cancel');

      // the age check: labelled as one, two big answers with their marks, the question word for word
      await page.evaluate(`(() => { const s = globalThis.posSession; s.hasCatalogue = () => true;
        s.scanBarcode = () => { throw Object.assign(new Error('age'), { name: 'AgeCheckRequiredError', description: 'Cigarettes 10s', minimumAge: 18, productId: 'P-CIG' }); }; })()`);
      await page.keyboard.type('8901234567890');
      await page.keyboard.press('Enter');
      await page.waitForSelector('#pay:not([hidden])');
      expect(await page.textContent('#pay-kicker')).toBe('Age check — ask for ID');
      expect(await page.getAttribute('#pay-kicker svg', 'data-icon')).toBe('shield-alert');
      expect(await page.textContent('#pay-title')).toBe('Cigarettes 10s is age restricted. Check the customer\'s identification. Is the customer 18 or over?');
      expect(await page.$$eval('#pay-kinds button', (b) => b.map((x) => [x.textContent, x.querySelector('svg')?.getAttribute('data-icon') ?? null]))).toEqual([['Yes — ID checked, 18 or over', 'check'], ['No — do not sell', 'x']]);
      await check('the age check');
      await page.click('#pay-cancel');

      // a refusal: the title, the reason, one big button beside them
      await page.evaluate(`(() => { const s = globalThis.posSession;
        s.scanBarcode = () => { throw Object.assign(new Error('x'), { name: 'TillRuleRefusedError', laneMessage: 'Paneer 200g batch B-1 is under recall and must not be sold. Put it aside for the manager and scan another pack.' }); }; })()`);
      await page.keyboard.type('8901234567890');
      await page.keyboard.press('Enter');
      await page.waitForSelector('#refusal:not([hidden])');
      expect(await page.textContent('#refusal-title')).toBe('Cannot be sold');
      const ok = await page.evaluate(`(() => { const r = document.getElementById('refusal-ok').getBoundingClientRect(); return { h: r.height, w: r.width }; })()`) as { h: number; w: number };
      expect(ok.h).toBeGreaterThanOrEqual(56);
      expect(ok.w).toBeGreaterThanOrEqual(150);
      await check('the refusal');
      await page.click('#refusal-ok');

      // the drawer count: all nine notes and coins on screen at once, each label inside its own cell, nothing expected
      await page.click('#more');
      await page.waitForSelector('#pay:not([hidden])');
      await page.locator('#pay-kinds button', { hasText: 'Close till' }).first().click();
      await page.waitForSelector('#count:not([hidden])');
      const denoms = await page.evaluate(`(() => { const box = document.getElementById('denoms'); const b = box.getBoundingClientRect();
        return { scrolls: box.scrollHeight > box.clientHeight + 1, rows: [...box.querySelectorAll('.denom')].map((row) => { const [label, minus] = row.children; const r = row.getBoundingClientRect();
          return { label: label.textContent, inside: label.getBoundingClientRect().right <= minus.getBoundingClientRect().left + 1, shown: r.top >= b.top - 1 && r.bottom <= b.bottom + 1 && r.bottom <= innerHeight }; }) }; })()`) as { scrolls: boolean; rows: { label: string; inside: boolean; shown: boolean }[] };
      expect(denoms.rows).toHaveLength(9);
      expect(denoms.scrolls, 'the whole drawer is on screen').toBe(false);
      for (const r of denoms.rows) { expect(r.inside, `${r.label} runs into its − button`).toBe(true); expect(r.shown, `${r.label} is on screen`).toBe(true); }
      expect(await page.getAttribute('#denoms .denom:first-child button:last-child', 'aria-label')).toBe('one more ₹500.00');
      expect(await page.textContent('#count')).not.toMatch(/expected/i);
      await check('the drawer count');
      expect(errors).toEqual([]);
    }, 90_000);
  }

  it('the box gone, at 1024 in Tamil — the longest words the strip ever holds — still one line, nothing overflows, audit clean', async () => {
    const { page, errors } = await till({ width: 1024, height: 768 }, { boxGone: true });
    await tamil(page);
    const strip = await page.evaluate(STRIP) as { controls: { id: string; off: number }[]; tone: string; shape: string | null; state: string };
    for (const c of strip.controls) expect(c.off, `${c.id} sits on another row of the strip`).toBeLessThanOrEqual(12);
    expect(strip.tone).toBe('error');
    expect(strip.shape).toBe('x');
    expect(await page.textContent('#conn-text')).toMatch(/^இணைப்பு இல்லை — கடைப் பெட்டி பதிலளிக்கவில்லை/);
    expect(await page.evaluate(OVERFLOWS)).toEqual([]);
    expect(await auditPage(page, { expectLang: 'ta' })).toEqual([]);
    // only the refused fetch to the vanished box — the page itself raised nothing
    expect(errors.filter((e) => !/ERR_CONNECTION_REFUSED|Failed to load resource/.test(e))).toEqual([]);
  }, 60_000);

  // OB-238 (owner, 19 Oct 2026): good news is green with the tick, a stop stays red with the stop mark — never the other
  // way round. The cash sale is the real click path (Tender → Cash → the ₹500 note); only the two calls that need a
  // signed-in cashier and the store computer's receipt range are answered by a stand-in, the same way the refusal below
  // stands in for the recall engine.
  for (const lang of ['en', 'ta'] as const) {
    it(`OB-238 at 1366 in ${lang === 'en' ? 'English' : 'Tamil'}: change due is green with the tick, a recalled scan is red with the stop mark, both AA`, async () => {
      const { page, errors } = await till({ width: 1366, height: 768 });
      if (lang === 'ta') await tamil(page);
      await page.evaluate(`(() => { const s = globalThis.posSession;
        s.scan({ productId: 'P1', description: 'Amul Ghee Gold 1L', unitPriceMinor: 48000, qty: 1 });
        s.nextReceipt = async () => 'R-0042';
        s.tenderCash = async (_saleId, receiptNumber) => receiptNumber; })()`);
      await page.click('#lang'); await page.click('#lang'); // the shell draws the bill on its own events

      const banner = async (): Promise<{ tone: string | undefined; icon: string | null; title: string; text: string; pairs: { what: string; fg: string; bg: string; px: number }[]; okH: number; focused: boolean; ring: string }> =>
        page.evaluate(`(() => { const r = document.getElementById('refusal'); const cs = (el) => getComputedStyle(el); const ok = document.getElementById('refusal-ok');
          const title = document.getElementById('refusal-title'); const icon = title.querySelector('svg');
          return { tone: r.dataset.tone, icon: icon ? icon.getAttribute('data-icon') : null, title: title.textContent, text: document.getElementById('refusal-text').textContent,
            pairs: [
              { what: 'title', fg: cs(title).color, bg: cs(r).backgroundColor, px: parseFloat(cs(title).fontSize) },
              { what: 'text', fg: cs(document.getElementById('refusal-text')).color, bg: cs(r).backgroundColor, px: parseFloat(cs(document.getElementById('refusal-text')).fontSize) },
              { what: 'mark', fg: icon ? cs(icon).color : '', bg: cs(r).backgroundColor, px: 0 },
              { what: 'button', fg: cs(ok).color, bg: cs(ok).backgroundColor, px: parseFloat(cs(ok).fontSize) },
            ],
            okH: ok.getBoundingClientRect().height, focused: document.activeElement === ok, ring: cs(ok).outlineStyle + ' ' + cs(ok).outlineWidth }; })()`);
      // OB238_SHOTS=<folder> saves the two banners as pictures for a person to look at; unset, nothing is written.
      const shot = async (name: string): Promise<void> => {
        const dir = process.env['OB238_SHOTS'];
        if (dir) await page.screenshot({ path: join(dir, `ob238-${name}-1366-${lang}.png`) });
      };
      const hex = (rgb: string): string => `#${(rgb.match(/\d+/g) ?? []).slice(0, 3).map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`;
      const aa = (b: Awaited<ReturnType<typeof banner>>, what: string): void => {
        for (const p of b.pairs) {
          const ratio = contrastRatio(hex(p.fg), hex(p.bg)) ?? 0;
          // words: 4.5:1 (3:1 at 24px and over); the mark is a graphic beside the words: 3:1 (WCAG 1.4.11)
          const need = p.what === 'mark' || p.px >= 24 ? 300 : 450;
          expect(ratio, `${what}: the ${p.what} ${p.fg} on ${p.bg}`).toBeGreaterThanOrEqual(need);
        }
        expect(b.okH, `${what}: the button is a 56px target`).toBeGreaterThanOrEqual(56);
        expect(b.focused, `${what}: the button takes the focus`).toBe(true);
      };

      // a completed cash sale, ₹480 paid with a ₹500 note → "Change due: ₹20.00", in the success tone with the tick
      await page.click('#tender');
      await page.waitForSelector('#pay:not([hidden])');
      await page.click('#pay-kinds button:first-child');
      await page.waitForSelector('#sheet:not([hidden]) #quick:not([hidden])');
      await page.locator('#quick button', { hasText: '₹500.00' }).click();
      await page.waitForSelector('#refusal:not([hidden])');
      const done = await banner();
      expect(done.title).toBe(lang === 'en' ? 'Change due: ₹20.00' : 'மீதம் தர வேண்டியது: ₹20.00');
      expect(done.text).toContain('R-0042');
      expect(done.tone, 'change due is good news').toBe('success');
      expect(done.icon, 'good news carries the tick').toBe('circle-check');
      aa(done, 'change due');
      expect(await auditPage(page, { expectLang: lang }), 'the change-due banner').toEqual([]);
      expect(await page.evaluate(OVERFLOWS)).toEqual([]);
      await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab'); // a keyboard focus: the ring shows
      expect((await banner()).ring, 'the focus ring stays on the green banner').toMatch(/^solid [1-9]/);
      await shot('change-due');
      await page.click('#refusal-ok');

      // a recalled batch is scanned → "Cannot be sold", in the stop tone with the stop mark
      await page.evaluate(`(() => { const s = globalThis.posSession; s.hasCatalogue = () => true;
        s.scanBarcode = () => { throw Object.assign(new Error('x'), { name: 'TillRuleRefusedError', laneMessage: 'Paneer 200g batch B-1 is under recall and must not be sold. Put it aside for the manager and scan another pack.' }); }; })()`);
      await page.keyboard.type('8901234567890');
      await page.keyboard.press('Enter');
      await page.waitForSelector('#refusal:not([hidden])');
      const stop = await banner();
      expect(stop.title).toBe(lang === 'en' ? 'Cannot be sold' : 'இதை விற்க முடியாது');
      expect(stop.tone, 'a refusal is never green').toBe('stop');
      expect(stop.icon, 'a refusal carries the stop mark').toBe('circle-alert');
      expect(stop.pairs[0]!.bg, 'the stop banner is not the success surface').not.toBe(done.pairs[0]!.bg);
      aa(stop, 'the recall refusal');
      expect(await auditPage(page, { expectLang: lang }), 'the refusal banner').toEqual([]);
      expect(await page.evaluate(OVERFLOWS)).toEqual([]);
      await shot('refusal');
      expect(await page.evaluate('document.getAnimations().length'), 'nothing moves on the till').toBe(0);
      expect(errors).toEqual([]);
    }, 60_000);
  }

  for (const lang of ['en', 'ta'] as const) {
    it(`the customer display in ${lang === 'en' ? 'English' : 'Tamil'}: the bill and the amount to pay on panels, the amount the largest figure, nothing overflows, audit clean`, async () => {
      for (const vp of DESKS) {
        const srv = await serve({});
        stops.push(srv.stop);
        const context = await browser.newContext({ viewport: vp, serviceWorkers: 'block' });
        stops.push(() => context.close());
        const page = await context.newPage();
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
        page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
        await page.goto(`${srv.base}/customer-display.html${lang === 'ta' ? '?lang=ta' : ''}`, { waitUntil: 'load' });
        expect(await auditPage(page, { expectLang: lang }), 'welcome').toEqual([]);
        await page.evaluate(`new BroadcastChannel('sre-customer-display').postMessage({ state: 'basket', laneId: 'lane-1', savedMinor: 4000, payableMinor: 114000,
          lines: [{ description: 'Amul Ghee Gold 1L', qty: 1, amountMinor: 64000 }, { description: 'Toor dal 1kg', qty: 3, amountMinor: 43500 }, { description: 'Aachi Sambar Powder 200g', qty: 1, amountMinor: 6500 }] })`);
        await page.waitForSelector('#bill:not([hidden])');
        const look = await page.evaluate(`(() => { const bg = (id) => getComputedStyle(document.getElementById(id)).backgroundColor; const fs = (el) => parseFloat(getComputedStyle(el).fontSize);
          return { bill: bg('bill'), pay: bg('pay'), canvas: getComputedStyle(document.body).backgroundColor, amount: fs(document.getElementById('pay-amount')),
            others: Math.max(...[...document.querySelectorAll('td, #pay-label, #saved, h1')].map(fs)) }; })()`) as { bill: string; pay: string; canvas: string; amount: number; others: number };
        expect(look.bill, 'the bill sits on a panel').not.toBe(look.canvas);
        expect(look.pay, 'the amount to pay sits on a panel').not.toBe(look.canvas);
        expect(look.amount, 'the amount to pay is the largest figure').toBeGreaterThan(look.others);
        expect(await page.textContent('#pay-amount')).toBe('₹1,140.00');
        expect(await page.evaluate(`document.documentElement.scrollWidth - document.documentElement.clientWidth`)).toBeLessThanOrEqual(1);
        expect(await auditPage(page, { expectLang: lang }), `the bill at ${vp.width}`).toEqual([]);
        expect(errors).toEqual([]);
      }
    }, 90_000);
  }
});
