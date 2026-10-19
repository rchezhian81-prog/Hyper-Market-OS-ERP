import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { auditPage, type A11yFinding } from './lib/a11y-audit';
import { phoneHolderStrip, phoneSignInPage, withPhoneHolderStrip, SIGN_IN_ENDED_MESSAGE } from '../../edge/store-edge/src/handheld-sign-in';

/**
 * **OB-205 (owner, 19 Oct 2026, "look approved — now polish page by page"): the staff phones, polished, in real Chromium.**
 *
 * The warehouse, picker and driver handhelds, and the sign-in strip and page the store box puts on them, at the two phone
 * widths the shop's handhelds have (360 and 412), in English and in Tamil (Tamil is the longer). Each is proven on the
 * RENDERED page:
 *
 *   • nothing overflows its box, nothing sticks out past the screen, and the page never scrolls sideways;
 *   • no console error;
 *   • the accessibility audit (`auditPage`, at the handhelds' 56px target bar) is clean, in English and in Tamil;
 *   • the polish itself: one primary action, last in the footer, under the thumb, at least 56px tall; an icon from the one
 *     set beside the words of every footer action; progress said as "3 of 8"; quantities big; the sign-in strip's
 *     signed-in and time-left chips each with an icon beside their words, the ended state wearing the lock, not the clock;
 *     the door check-in's own labels in Tamil; the checklist's "n of m checked"; a hidden choice list kept hidden.
 *
 * Synthetic data, served as the store box serves it (the work injected where the box puts it). Skips without a browser.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WIDTHS = [360, 412] as const;
const HEIGHT = 740;
const TARGET = 56;

interface Shell { readonly app: string; readonly global: string; readonly ready: string; readonly data: () => Record<string, unknown> }

const RECEIVING = {
  checks: [{ checkId: 'dock-receiving', branchId: 'store-1', title: 'Chilled and frozen delivery', kind: 'receiving', graceMinutes: 0, active: true,
    assignedRole: 'store_manager', escalatesTo: 'u-owner', items: [{ itemId: 'temp', label: 'Temperature taken' }, { itemId: 'pack', label: 'Packaging intact' }, { itemId: 'seal', label: 'Seal unbroken' }] }],
  coldChainProductIds: ['p-icecream'],
};

const WAREHOUSE: Shell = {
  app: 'warehouse-app', global: 'warehouseData', ready: 'warehouseSession',
  data: () => ({
    assignmentId: 'A-1', workerId: 'u-worker', storeId: 'store-1', poId: 'po-1', grnId: 'grn-1',
    bins: [{ binId: 'BIN-A', storeId: 'store-1', capacityMinor: 1000, pickable: true, zone: 'ambient' }],
    ordered: [{ productId: 'p-rice', quantityMinor: 100, unitCost: { minor: 4000, currency: 'INR' } }, { productId: 'p-icecream', quantityMinor: 20, unitCost: { minor: 9000, currency: 'INR' } }],
    barcodes: [{ barcode: '890RICE', productId: 'p-rice', level: 'unit' }, { barcode: '890ICE', productId: 'p-icecream', level: 'unit' }],
    packs: [{ productId: 'p-rice', baseUom: 'ea', levels: [{ level: 'unit', containsMinor: 1, barcode: '890RICE' }] }, { productId: 'p-icecream', baseUom: 'ea', levels: [{ level: 'unit', containsMinor: 1, barcode: '890ICE' }] }],
    goodsIn: [
      { productId: 'p-good', batchId: null, quantityMinor: 6, uom: 'EA', state: 'good', expiry: null, recalled: false },
      { productId: 'p-recalled', batchId: 'b-9', quantityMinor: 3, uom: 'EA', state: 'good', expiry: null, recalled: true },
    ],
    recalledProductIds: ['p-recalled'],
    contents: { 'BIN-A|p-rice|': 40 },
    pickLines: [{ lineId: 'pl-1', orderRef: 'ORD-77', productId: 'p-rice', batchId: null, binId: 'BIN-A', quantityMinor: 12, uom: 'EA' }],
    indentLines: [{ indentId: 'ind-1', productId: 'p-rice', uom: 'EA', outstandingMinor: 6, requestedBy: 'u-floor', toLocationId: 'store-1' }],
    openDeliveries: [{ poId: 'po-1', number: 'PO-0042', supplierId: 'sup-aavin', ordered: [{ productId: 'p-rice', quantityMinor: 100, unitCost: { minor: 4000 } }, { productId: 'p-icecream', quantityMinor: 20, unitCost: { minor: 9000 } }] }],
    receivingChecklist: RECEIVING,
  }),
};
const PICKER: Shell = {
  app: 'picker-app', global: 'pickerData', ready: 'pickSession',
  data: () => ({
    waveId: 'W-1', pickerId: 'u-picker', orderedBy: 'shelf order',
    lines: [
      { lineId: 'l1', orderRef: 'ORD-1', productId: 'MILK', description: 'Aavin Milk 1L', bin: 'A-01', requiredQty: 2, uom: 'ea', unitPrice: { minor: 6000, currency: 'INR' } },
      { lineId: 'l2', orderRef: 'ORD-1', productId: 'DAL', description: 'Toor dal 1kg', bin: 'B-04', requiredQty: 1, uom: 'ea', unitPrice: { minor: 16000, currency: 'INR' } },
      { lineId: 'l3', orderRef: 'ORD-2', productId: 'TOMATO', description: 'Tomato', bin: 'C-02', requiredQty: 500, uom: 'kg', unitPrice: { minor: 4000, currency: 'INR' } },
    ],
  }),
};
const DRIVER: Shell = {
  app: 'delivery-app', global: 'driverData', ready: 'routeSession',
  data: () => ({
    routeId: 'R-1', driverId: 'u-driver',
    stops: [
      { stopId: 's1', orderRef: 'ORD-1041', area: 'Anna Nagar, 3rd St', codMinor: 250_00 },
      { stopId: 's2', orderRef: 'ORD-1044', area: 'Gandhipuram', codMinor: 0 },
    ],
  }),
};

/** The store box's proxy, minus the box: the shell's files, the work injected, and (optionally) the sign-in strip on top. */
async function serve(shell: Shell, strip?: string): Promise<{ base: string; stop: () => Promise<void> }> {
  const dir = join('apps', shell.app, 'web');
  const server: Server = createServer((req, res) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      const file = path === '/' || path === '/index.html' ? 'index.html' : path.replace(/^\//, '');
      try {
        let text = (await readFile(join(dir, file))).toString('utf8');
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.webmanifest') ? 'application/manifest+json' : 'application/octet-stream';
        if (file === 'index.html') {
          text = text.replace('<!--SCREEN-DATA-->', `<script>window.${shell.global} = ${JSON.stringify(shell.data()).replace(/</g, '\\u003c')};</script>`);
          if (strip !== undefined) text = withPhoneHolderStrip(text, strip);
        }
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
        res.end(text);
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

/**
 * What sticks out: an element wider than the screen or past its edge, and a box whose words or children overflow it
 * without a scroll of its own (a label spilling out of its button, a number over the next column). Hidden things and
 * things inside a scroller that is meant to scroll are not counted.
 */
const OVERFLOW = `(() => {
  const vw = document.documentElement.clientWidth;
  const out = [];
  const name = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).join('.') : '');
  for (const el of document.body.querySelectorAll('*')) {
    if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.left < -0.5 || r.right > vw + 0.5) out.push(name(el) + ' past the screen edge (' + Math.round(r.left) + '..' + Math.round(r.right) + ' of ' + vw + ')');
    if (cs.display.startsWith('inline') && cs.display !== 'inline-block' && cs.display !== 'inline-flex' && cs.display !== 'inline-grid') continue;
    const scrolls = /(auto|scroll|hidden|clip)/.test(cs.overflowX);
    if (!scrolls && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) out.push(name(el) + ' overflows its box (' + el.scrollWidth + ' > ' + el.clientWidth + ')');
  }
  if (document.documentElement.scrollWidth > vw + 0.5) out.push('the page scrolls sideways');
  return out;
})()`;

describe.skipIf(!HAVE_BROWSER)('OB-205: the staff phones, polished — at 360 and 412, in English and Tamil', () => {
  let browser: Browser;
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    for (const shell of [PICKER, DRIVER, WAREHOUSE]) execFileSync('node', ['scripts/build-app.mjs', shell.app], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });

  /** Open a shell at a width; console errors (bar the browser's own favicon probe) are collected. */
  async function open(shell: Shell, width: number, strip?: string): Promise<{ page: Page; errors: string[] }> {
    const srv = await serve(shell, strip);
    stops.push(srv.stop);
    const context = await browser.newContext({ viewport: { width, height: HEIGHT }, hasTouch: true, isMobile: true });
    stops.push(() => context.close());
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error' && !m.location().url.endsWith('/favicon.ico')) errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${srv.base}/`, { waitUntil: 'load' });
    await page.waitForFunction(`globalThis.${shell.ready} !== undefined`, undefined, { timeout: 15_000 });
    return { page, errors };
  }
  const tamil = async (page: Page): Promise<void> => { await page.click('#lang'); await page.waitForFunction('document.documentElement.lang === "ta"'); };
  const overflow = (page: Page): Promise<string[]> => page.evaluate(OVERFLOW) as Promise<string[]>;
  /** Icons found apart from their words: every icon must sit in a button, a link, a paragraph or an icon-and-word pair. */
  const loneIcons = (page: Page): Promise<string[]> => page.evaluate(`[...document.querySelectorAll('svg')].filter((s) => !s.parentElement.closest('a, button, p, li, label, .sre-with-icon, .sre-chip, .dot')).map((s) => s.getAttribute('data-icon') + ' in ' + (s.parentElement.id || s.parentElement.className))`) as Promise<string[]>;
  /** The rendered font size of the first element a selector names, in px. */
  const fontSize = async (page: Page, selector: string): Promise<number> => Number.parseFloat(await page.evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).fontSize`) as string);
  const audit = (page: Page, lang: 'en' | 'ta'): Promise<A11yFinding[]> => auditPage(page, { minTarget: TARGET, expectLang: lang });

  /** The footer's visible buttons, in order, with their height, icon and whether they are the primary action. */
  const footer = (page: Page): Promise<{ id: string; h: number; icon: boolean; primary: boolean; bottomGap: number }[]> => page.evaluate(`(() => {
    const f = document.querySelector('footer').getBoundingClientRect();
    return [...document.querySelectorAll('footer .actions > button')].filter((b) => getComputedStyle(b).display !== 'none').map((b) => {
      const r = b.getBoundingClientRect();
      return { id: b.id, h: r.height, icon: b.querySelector('.sre-with-icon > svg.sre-icon') !== null, primary: b.classList.contains('primary'), bottomGap: f.bottom - r.bottom };
    });
  })()`) as Promise<{ id: string; h: number; icon: boolean; primary: boolean; bottomGap: number }[]>;

  /** The rule the footer keeps: the last action is a primary one, at the bottom under the thumb, ≥ 56px; every action has its icon. */
  async function expectThumbFooter(page: Page): Promise<void> {
    const buttons = await footer(page);
    expect(buttons.length).toBeGreaterThan(0);
    const last = buttons[buttons.length - 1]!;
    expect(last.primary, `the last footer action (${last.id}) is the primary one`).toBe(true);
    expect(last.h).toBeGreaterThanOrEqual(TARGET);
    expect(last.bottomGap, 'the primary action sits at the bottom').toBeLessThanOrEqual(24);
    expect(buttons.filter((b) => !b.icon).map((b) => b.id), 'every footer action carries its icon beside its words').toEqual([]);
  }

  for (const width of WIDTHS) {
    it(`warehouse at ${width} — the list, the confirm step and the door check-in fit, are AA-clean, and keep the polish`, async () => {
      const { page, errors } = await open(WAREHOUSE, width);
      expect(await overflow(page)).toEqual([]);
      expect(await audit(page, 'en')).toEqual([]);
      await expectThumbFooter(page);
      expect(await loneIcons(page)).toEqual([]);
      // Big quantities, the number on its own; the words read exactly as before.
      expect(await page.textContent('#pick-lines .item .qty')).toBe('12 units · EA');
      expect(await fontSize(page, '#pick-lines .item .qty .n')).toBeGreaterThanOrEqual(22);
      // Each list says how many it holds — beside its words, which stay exactly the words.
      expect(await page.textContent('#pick-heading')).toBe('To pick');
      expect(await page.getAttribute('#pick-heading', 'data-count')).toBe('1');
      // The confirm step: the quantity unmissable.
      await page.keyboard.type('BIN-A'); await page.keyboard.press('Enter');
      await page.waitForSelector('#scan:not([hidden])');
      expect(await page.$('#scan-title svg.sre-icon')).not.toBeNull();
      await page.keyboard.type('890RICE'); await page.keyboard.press('Enter');
      await page.waitForSelector('#confirm:not([hidden])');
      expect(await page.textContent('#confirm-qty')).toBe('12 units · EA');
      expect(await fontSize(page, '#confirm-qty .n')).toBeGreaterThanOrEqual(48);
      expect(await overflow(page)).toEqual([]);
      expect(await audit(page, 'en')).toEqual([]);
      await page.click('#confirm-ok');
      await page.waitForSelector('#banner.good:not([hidden])');
      expect(await page.$('#banner-mark svg[data-icon="circle-check"]')).not.toBeNull();
      expect(await loneIcons(page)).toEqual([]);
      await page.click('#banner-ok');
      // Queued here, said calmly: the badge in amber words, the record's state a chip with its shape.
      expect(await page.textContent('#queue-text')).toBe('1 saved here');
      expect(await page.$('#sent-work .sent[data-state="saved_here"] .pill svg.sre-icon')).not.toBeNull();
      // The door check-in: started, one scan in — scanned against expected, big.
      await page.click('#dsd-open');
      await page.locator('#dsd-choices button').first().click();
      for (const d of '9876543210') await page.click(`#dsd-driver-keypad button:text-is("${d}")`);
      await page.click('#dsd-driver');
      await page.click('#dsd-start');
      await page.click('#banner-ok');
      await page.click('#dsd-scan');
      await page.waitForSelector('#scan:not([hidden])');
      await page.keyboard.type('890ICE'); await page.keyboard.press('Enter');
      await page.waitForSelector('#banner:not([hidden])');
      await page.click('#banner-ok');
      expect(await page.textContent('#dsd-lines [data-product="p-icecream"] .count .n')).toBe('1 / 20');
      expect(await overflow(page)).toEqual([]);
      expect(await audit(page, 'en')).toEqual([]);
      expect(errors).toEqual([]);
    });

    it(`picker at ${width} — the wave fits, is AA-clean, says "n of m done", and keeps one primary action under the thumb`, async () => {
      const { page, errors } = await open(PICKER, width);
      expect(await overflow(page)).toEqual([]);
      expect(await audit(page, 'en')).toEqual([]);
      await expectThumbFooter(page);
      expect(await page.textContent('#progress')).toBe('0 of 3 done');
      expect(await page.textContent('.line .qty')).toBe('Asked for 2');
      expect(await fontSize(page, '.line .qty .n')).toBeGreaterThanOrEqual(22);
      expect(await page.$('.line .state svg.sre-icon')).not.toBeNull();
      // A line picked: the progress moves, in words and on its bar.
      await page.keyboard.type('A-01'); await page.keyboard.press('Enter');
      await page.waitForSelector('#scan-substitute:not([hidden])');
      await page.keyboard.type('MILK'); await page.keyboard.press('Enter');
      await page.waitForSelector('#keypad:not([hidden])');
      expect(await overflow(page)).toEqual([]);
      await page.click('#sheet-ok');
      await page.waitForSelector('.line.picked');
      expect(await page.textContent('#progress')).toBe('1 of 3 done');
      expect(await page.getAttribute('#progress-bar', 'style')).toMatch(/transform: scaleX\(0\.33/);
      expect(errors).toEqual([]);
    });

    it(`driver at ${width} — the route fits, is AA-clean, and Delivered is the one green action at the bottom`, async () => {
      const { page, errors } = await open(DRIVER, width);
      expect(await overflow(page)).toEqual([]);
      expect(await audit(page, 'en')).toEqual([]);
      await expectThumbFooter(page);
      expect(await page.textContent('#progress')).toBe('0 of 2 stops done');
      expect(await page.textContent('#held')).toBe('₹0.00');
      // The blind cash count: every note's row fits on the phone.
      await page.click('#handover');
      await page.waitForSelector('#count:not([hidden])');
      expect(await overflow(page)).toEqual([]);
      expect(await audit(page, 'en')).toEqual([]);
      expect(errors).toEqual([]);
    });

    it(`the sign-in strip at ${width} — who and how long as chips with their icons; the ended state wears the lock`, async () => {
      const now = new Date();
      const live = phoneHolderStrip({ displayName: 'Murugan K', signOutAction: '/device/sign-out?screen=warehouse', expiresAt: new Date(now.getTime() + 239 * 60_000).toISOString(), now: now.toISOString() });
      const { page, errors } = await open(WAREHOUSE, width, live);
      expect(await page.textContent('[data-phone-holder]')).toContain('Signed in: Murugan K');
      expect(await page.$('[data-phone-holder] .hh-who svg[data-icon="user-round"]')).not.toBeNull();
      expect(await page.isVisible('[data-phone-holder] .hh-left svg[data-icon="clock"]')).toBe(true);
      expect(await page.isVisible('[data-phone-holder] .hh-left svg[data-icon="lock"]')).toBe(false);
      expect((await page.locator('[data-phone-holder] button[type="submit"]').boundingBox())!.height).toBeGreaterThanOrEqual(TARGET);
      expect(await loneIcons(page)).toEqual([]);
      expect(await overflow(page)).toEqual([]);
      expect(await audit(page, 'en')).toEqual([]);
      expect(errors).toEqual([]);

      const ended = phoneHolderStrip({ displayName: 'Murugan K', signOutAction: '/device/sign-out?screen=warehouse', expiresAt: new Date(now.getTime() - 60_000).toISOString(), now: now.toISOString() });
      const second = await open(WAREHOUSE, width, ended);
      expect(await second.page.getAttribute('[data-sign-in-left]', 'role')).toBe('alert');
      expect(await second.page.isVisible('[data-phone-holder] .hh-left svg[data-icon="lock"]')).toBe(true);
      expect(await second.page.isVisible('[data-phone-holder] .hh-left svg[data-icon="clock"]')).toBe(false);
      expect(await overflow(second.page)).toEqual([]);
      expect(await audit(second.page, 'en')).toEqual([]);
      expect(second.errors).toEqual([]);
    });

    it(`the phone's sign-in page at ${width} — the job as a chip, full-width fields and button, AA-clean, nothing sticking out`, async () => {
      const context = await browser.newContext({ viewport: { width, height: HEIGHT }, hasTouch: true, isMobile: true });
      stops.push(() => context.close());
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      await page.setContent(phoneSignInPage({ screen: 'warehouse', action: '/device/sign-in?screen=warehouse', message: SIGN_IN_ENDED_MESSAGE }), { waitUntil: 'load' });
      expect(await page.textContent('.job')).toBe('Warehouse · கிடங்கு');
      const form = (await page.locator('form').boundingBox())!;
      for (const sel of ['input[name="staffId"]', 'input[name="pin"]', 'button[type="submit"]']) {
        const box = (await page.locator(sel).boundingBox())!;
        expect(Math.round(box.width), `${sel} spans the form`).toBe(Math.round(form.width));
        expect(box.height).toBeGreaterThanOrEqual(TARGET);
      }
      expect(await overflow(page)).toEqual([]);
      expect(await audit(page, 'en')).toEqual([]);
      expect(errors).toEqual([]);
    });
  }

  it('in Tamil at 360 — the three phones fit and are AA-clean; the door check-in speaks Tamil; the checklist counts its checks', async () => {
    for (const shell of [WAREHOUSE, PICKER, DRIVER]) {
      const { page, errors } = await open(shell, 360);
      await tamil(page);
      expect(await overflow(page), shell.app).toEqual([]);
      expect(await audit(page, 'ta'), shell.app).toEqual([]);
      await expectThumbFooter(page);
      if (shell === PICKER) expect(await page.textContent('#progress')).toBe('3 இல் 0 முடிந்தது');
      if (shell === WAREHOUSE) {
        // The door sheet's own labels were English only; they follow the language now.
        await page.click('#dsd-open');
        expect(await page.textContent('#dsd-start')).toBe('சரிபார்ப்பைத் தொடங்கு');
        expect(await page.textContent('#dsd-title')).toBe('வாசலில் நேரடி டெலிவரி');
        expect(await overflow(page)).toEqual([]);
        expect(await audit(page, 'ta')).toEqual([]);
        await page.click('#dsd-cancel');
        // The receiving checklist: "n of m checked", and the corrective actions stay hidden until a check fails.
        await page.click('#receive');
        await page.waitForSelector('#scan:not([hidden])');
        await page.keyboard.type('890ICE'); await page.keyboard.press('Enter');
        await page.waitForSelector('#banner:not([hidden])');
        await page.click('#banner-ok');
        await page.click('#done-receiving');
        await page.waitForSelector('#checklist:not([hidden])');
        expect(await page.textContent('#checklist-progress')).toBe('3 இல் 0 சரிபார்க்கப்பட்டது');
        expect(await page.isVisible('#checklist-actions')).toBe(false);
        await page.click('#checklist-items button[data-item="temp"][data-result="pass"]');
        expect(await page.textContent('#checklist-progress')).toBe('3 இல் 1 சரிபார்க்கப்பட்டது');
        await page.click('#checklist-items button[data-item="pack"][data-result="fail"]');
        expect(await page.isVisible('#checklist-actions')).toBe(true);
        expect(await overflow(page)).toEqual([]);
        expect(await audit(page, 'ta')).toEqual([]);
      }
      expect(errors, shell.app).toEqual([]);
    }
  });

  it('tripwire — the overflow check bites: a label too long for its box and a row wider than the phone are both reported', async () => {
    const context = await browser.newContext({ viewport: { width: 360, height: HEIGHT } });
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.setContent('<!doctype html><html lang="en"><body><div id="box" style="width:100px;white-space:nowrap">a label much too long for its box</div><div id="wide" style="width:500px">wide</div></body></html>');
    const found = await overflow(page);
    expect(found.some((f) => f.startsWith('div#box overflows its box'))).toBe(true);
    expect(found.some((f) => f.startsWith('div#wide past the screen edge'))).toBe(true);
  });
});
