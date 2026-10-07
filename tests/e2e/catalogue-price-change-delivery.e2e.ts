import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { auditPage } from './lib/a11y-audit';
import {
  newHeadOffice, startPricingHeadOffice, decideAsSomeoneElse, posts, CALLER, type PricingHeadOffice,
} from './lib/pricing-head-office';

/**
 * **The operator changes a price, in a real browser — and a loss-making price needs a second person's OWN approval
 * (M05-FR-02 · ADR-0024 · §28 · audit PA-03 · ADR-0013 — the E2E matrix).**
 *
 * Every layer is unit-tested: the session's `changePriceInCloud`, `askPriceApproval` and `savePriceWithApproval`, the
 * browser's `openPriceChangePort`, and head office's engine and price route. The one thing units cannot prove is that a
 * person filling the *Change a price* form in an ACTUAL browser makes the right writes reach head office under their
 * own session — and that no approver's name exists anywhere on the screen any more. This drives headless Chromium
 * against a stub head office that behaves like the real routes (it is built from the engine's own `actionDetails`,
 * `fingerprintOf` and `takeApproval`, and the real `checkPrice`):
 *
 *   • a CLEAN price saves directly: one POST carrying exactly the six figures, and nobody is asked;
 *   • a BELOW-COST price: Save before asking is refused on the screen (nothing sent); Ask without a reason is refused;
 *     Ask for approval records the setter's own request for EXACTLY the figures the change will send; Save while it
 *     waits says so (nothing sent); once a DIFFERENT person approves it, Save sends the change naming the approval —
 *     with no approver, no reason and no name in the body — and head office accepts it and uses it once;
 *   • rejected → who and why, in English and Tamil; a figure changed after asking → "ask again"; an approval refusal
 *     at the last moment → the same plain words; nothing is sent in any of them;
 *   • a typed approver is refused by head office by name, and the screen has no box to type one.
 *
 * The browser binary is the environment's pre-installed Chromium; where none is present the suite SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);

/** The slice of the browser's globals these callbacks touch, cast structurally inside each evaluate. */
interface BrowserGlobals {
  readonly catalogueSession?: { readonly canChangePriceInCloud: boolean; readonly canAskForApproval: boolean };
  readonly document: { getElementById(id: string): { hidden: boolean; textContent: string | null } | null };
}

/** A store manager setting prices, a product with an MRP and a landed cost, and the shop's margin floor. No list of
 *  approvers: head office decides who may approve, and the screen names nobody. */
const pricingContext = (): Record<string, unknown> => ({
  userId: CALLER, storeId: 'store-1', today: '2026-10-07',
  marginFloorBps: 2000,
  categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }],
  products: [{
    productId: 'p1', tenantId: 't1', sku: 'SKU-DAL', name: 'Toor dal 1kg', brand: 'Aachi',
    primaryCategoryId: 'grocery', baseUom: 'ea', taxClass: '0713', attributes: {},
    mrpHistory: [{ value: { minor: 160_00, currency: 'INR' }, effectiveFrom: '2026-01-01' }],
    lifecycle: 'active',
  }],
  costsMinor: { p1: 100_00 },
});

/** The six figures the change sends for Toor dal at ₹90 — and therefore exactly what the approval is for. */
const BELOW_COST = { productId: 'p1', priceMinor: 90_00, mrpMinor: 160_00, costMinor: 100_00, currency: 'INR', marginFloorBps: 2000 };

describe.skipIf(!HAVE_BROWSER)('operator price-change delivery under the two-person rule, end to end in a real browser (M05-FR-02 · ADR-0024)', () => {
  let browser: Browser;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  /** Open the catalogue screen on the Change-a-price tab, wired to the stub head office. */
  const openPriceTab = async (ho: PricingHeadOffice) => {
    const srv = await startPricingHeadOffice(ho);
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${srv.base}/`, { waitUntil: 'load' });
    await page.waitForFunction(
      () => {
        const s = (globalThis as unknown as BrowserGlobals).catalogueSession;
        return s?.canChangePriceInCloud === true && s.canAskForApproval === true;
      },
      undefined, { timeout: 10_000 },
    );
    await page.click('#tab-price');
    return { page, errors, teardown: async () => { await context.close(); await srv.stop(); } };
  };

  /** Fill the price form and check it, so the Save button appears. */
  const checkPrice = async (page: Page, sku: string, rupees: string) => {
    await page.fill('#price-item', sku);
    await page.fill('#new-price', rupees);
    await page.fill('#price-from', '2026-10-07');
    await page.click('#check-price');
    await page.waitForSelector('#save-price:not([hidden])', { timeout: 10_000 });
  };

  /** Click, wait for the banner to say THIS click's answer, read it, and dismiss it (it covers the top of the page). */
  const clickFor = async (page: Page, button: string, expected: RegExp): Promise<{ title: string; text: string; cls: string }> => {
    await page.click(button);
    await page.waitForFunction(
      (source) => {
        const doc = (globalThis as unknown as BrowserGlobals).document;
        const banner = doc.getElementById('banner');
        return banner !== null && !banner.hidden && new RegExp(source).test(doc.getElementById('banner-text')?.textContent ?? '');
      },
      expected.source, { timeout: 10_000 },
    );
    const said = {
      title: ((await page.textContent('#banner-title')) ?? '').trim(),
      text: ((await page.textContent('#banner-text')) ?? '').trim(),
      cls: (await page.getAttribute('#banner', 'class')) ?? '',
    };
    await page.click('#banner-ok');
    return said;
  };

  const hidden = (page: Page, id: string) => page.evaluate((i) => (globalThis as unknown as BrowserGlobals).document.getElementById(i)?.hidden ?? true, id);

  it('a clean price saves with nobody asked: the POST carries exactly the six figures', async () => {
    const ho = newHeadOffice(pricingContext());
    const { page, errors, teardown } = await openPriceTab(ho);
    try {
      await checkPrice(page, 'SKU-DAL', '150'); // below MRP 160, above the 20% floor at cost 100
      expect(await hidden(page, 'price-approval'), 'a clean price shows no approval step').toBe(true);
      expect(await page.textContent('#save-price')).toBe('Save this price');
      const said = await clickFor(page, '#save-price', /starts on the day you gave/);
      expect(said.title).toBe('Price saved');

      const change = posts(ho, '/v1/prices/changes');
      expect(change).toHaveLength(1);
      expect(change[0]!.body).toEqual({ ...BELOW_COST, priceMinor: 150_00 });
      expect(change[0]!.headers['idempotency-key'], 'the change carries an idempotency key').toBeTruthy();
      expect(posts(ho, '/v1/approvals/requests'), 'nobody is asked for a clean price').toHaveLength(0);
      expect(await hidden(page, 'save-price')).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await teardown();
    }
  });

  it('a below-cost price: ask, wait, a DIFFERENT person approves, then Save names the approval — and nothing else', async () => {
    const ho = newHeadOffice(pricingContext());
    const { page, errors, teardown } = await openPriceTab(ho);
    try {
      await checkPrice(page, 'SKU-DAL', '90'); // below the ₹100 cost — a deliberate loss that needs a second person
      // The ask is on the page: a reason box and "Ask for approval" as the one main action. No approver to pick.
      expect(await hidden(page, 'price-approval')).toBe(false);
      expect(await page.getAttribute('#ask-price', 'class')).toContain('primary');
      expect(await page.getAttribute('#save-price', 'class')).not.toContain('primary');
      expect(await page.textContent('#save-price')).toBe('Save it');
      expect(await page.locator('#sheet, #choices, #sheet-reason').count(), 'an approver picker is still on the page').toBe(0);

      // Save BEFORE asking: refused on the screen, nothing sent.
      const early = await clickFor(page, '#save-price', /nobody has been asked/);
      expect(early.text).toBe('Not saved — nobody has been asked to approve exactly this yet. Write why and press “Ask for approval” first.');
      expect(posts(ho, '/v1/prices/changes')).toHaveLength(0);

      // Ask without a reason: refused on the screen, nothing asked.
      expect((await clickFor(page, '#ask-price', /Write why/)).text).toMatch(/^Write why this is needed/);
      expect(posts(ho, '/v1/approvals/requests')).toHaveLength(0);

      // Ask for approval — the setter's OWN request, for exactly the figures the change will send.
      await page.fill('#price-why', 'clearing short-dated stock before it is written off');
      const asked = await clickFor(page, '#ask-price', /Waiting for a second person/);
      expect(asked.title).toBe('Waiting for approval');
      expect(asked.text).toBe('Asked. Waiting for a second person who may approve prices to approve it on the Approvals page. Nothing is saved yet. Price of Toor dal 1kg to ₹90.00 (below cost ₹100.00)');
      expect(asked.cls).toContain('pending');
      const ask = posts(ho, '/v1/approvals/requests');
      expect(ask).toHaveLength(1);
      expect(ask[0]!.body).toEqual({
        kind: 'price_change', subjectRef: 'p1', details: BELOW_COST, valueMinor: 90_00,
        summary: 'Price of Toor dal 1kg to ₹90.00 (below cost ₹100.00)', reason: 'clearing short-dated stock before it is written off',
      });
      expect(ask[0]!.headers['idempotency-key'], 'the ask carries an idempotency key').toBeTruthy();
      expect(posts(ho, '/v1/prices/changes'), 'asking saves nothing').toHaveLength(0);
      // Now "Save it" is the main action.
      expect(await page.getAttribute('#save-price', 'class')).toContain('primary');
      expect(await page.getAttribute('#ask-price', 'class')).not.toContain('primary');

      // Save while it waits: says so, nothing sent.
      expect((await clickFor(page, '#save-price', /still waiting/)).text)
        .toBe('Not saved — still waiting for a second person who may approve prices (not you) to approve it on their Approvals page.');
      expect(posts(ho, '/v1/prices/changes')).toHaveLength(0);

      // A DIFFERENT person approves it, in their own session (on their Approvals page).
      decideAsSomeoneElse(ho, 'areq-1', 'approved', 'agreed — the batch expires on Friday');

      // Save — names the approved request; no approver, no reason, no name in the body. Head office accepts it.
      const saved = await clickFor(page, '#save-price', /^Price saved/);
      expect(saved.title).toBe('Price saved');
      expect(saved.text).toBe('Price saved: ₹90.00. The approval has now been used — another change needs a new approval.');
      const change = posts(ho, '/v1/prices/changes');
      expect(change).toHaveLength(1);
      expect(change[0]!.body).toEqual({ ...BELOW_COST, approvalId: 'areq-1' });
      expect(change[0]!.body).not.toHaveProperty('approval');
      expect(change[0]!.body).not.toHaveProperty('approvedBy');
      expect(change[0]!.body).not.toHaveProperty('rationale');
      // Head office used the approval once.
      expect(ho.approvals.get('areq-1')?.usedBy).toBe('price_change:p1');
      expect(await hidden(page, 'save-price')).toBe(true);
      expect(await hidden(page, 'price-approval')).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await teardown();
    }
  });

  it('the ask step and the waiting banner pass the same accessibility audit as every page — in English and in Tamil', async () => {
    const ho = newHeadOffice(pricingContext());
    const { page, teardown } = await openPriceTab(ho);
    try {
      await checkPrice(page, 'SKU-DAL', '90');
      // Contrast, names, labels (the reason box has one), 48px targets, one language — with the ask step showing.
      expect(await auditPage(page, { minTarget: 48 }), 'the ask step').toEqual([]);
      await page.fill('#price-why', 'clearing short-dated stock before it is written off');
      await page.click('#ask-price');
      await page.waitForSelector('#banner.pending:not([hidden])', { timeout: 10_000 });
      expect(await auditPage(page, { minTarget: 48 }), 'the waiting banner').toEqual([]);
      await page.click('#banner-ok');
      await page.click('#lang');
      await page.waitForFunction('document.documentElement.lang === "ta"');
      expect(await page.textContent('#price-why-label')).toBe('இது ஏன் தேவை (அனுமதிப்பவர் இதைப் படிப்பார்)');
      expect(await auditPage(page, { minTarget: 48, expectLang: 'ta' }), 'the ask step in Tamil').toEqual([]);
    } finally {
      await teardown();
    }
  });

  it('REJECTED: Save says who rejected it and why — in English and in Tamil — and nothing is sent', async () => {
    const ho = newHeadOffice(pricingContext());
    const { page, teardown } = await openPriceTab(ho);
    try {
      await checkPrice(page, 'SKU-DAL', '90');
      await page.fill('#price-why', 'clearing short-dated stock before it is written off');
      await clickFor(page, '#ask-price', /Waiting for a second person/);
      decideAsSomeoneElse(ho, 'areq-1', 'rejected', 'dal is not short-dated');

      expect((await clickFor(page, '#save-price', /rejected it/)).text)
        .toBe('Not saved — u-owner rejected it: “dal is not short-dated”. Change what they said and ask again.');
      expect(posts(ho, '/v1/prices/changes'), 'a rejected price must not be sent').toHaveLength(0);

      await page.click('#lang');
      await page.waitForFunction('document.documentElement.lang === "ta"');
      expect(await page.textContent('#ask-price')).toBe('அனுமதி கேள்');
      const ta = await clickFor(page, '#save-price', /மறுத்தார்/);
      expect(ta.text).toBe('சேமிக்கப்படவில்லை — u-owner மறுத்தார்: “dal is not short-dated”. அவர் சொன்னதை மாற்றி மீண்டும் கேளுங்கள்.');
      expect(posts(ho, '/v1/prices/changes')).toHaveLength(0);
    } finally {
      await teardown();
    }
  });

  it('a figure CHANGED after asking: Save says ask again, and nothing is sent under the old approval', async () => {
    const ho = newHeadOffice(pricingContext());
    const { page, teardown } = await openPriceTab(ho);
    try {
      await checkPrice(page, 'SKU-DAL', '90');
      await page.fill('#price-why', 'clearing short-dated stock before it is written off');
      await clickFor(page, '#ask-price', /Waiting for a second person/);
      decideAsSomeoneElse(ho, 'areq-1', 'approved', 'fine');

      // The setter changes the price AFTER the approval was given.
      await checkPrice(page, 'SKU-DAL', '85');
      expect((await clickFor(page, '#save-price', /not exactly what was approved/)).text)
        .toBe('Not saved — this is not exactly what was approved (a figure changed after you asked). Ask for approval again for exactly this.');
      expect(posts(ho, '/v1/prices/changes'), 'a changed price must not be sent under the old approval').toHaveLength(0);
    } finally {
      await teardown();
    }
  });

  it('an approval refusal at the last moment is said in the same plain words, and the button stays', async () => {
    const ho = newHeadOffice(pricingContext());
    const { page, teardown } = await openPriceTab(ho);
    try {
      await checkPrice(page, 'SKU-DAL', '90');
      await page.fill('#price-why', 'clearing short-dated stock before it is written off');
      await clickFor(page, '#ask-price', /Waiting for a second person/);
      decideAsSomeoneElse(ho, 'areq-1', 'approved', 'fine');
      // Between the read and the save, the approver lost the authority — head office refuses by code.
      ho.forceRefusal = { code: 'checker_may_not_approve', whatHappened: 'u-owner no longer holds the authority to approve this.' };

      expect((await clickFor(page, '#save-price', /no longer may approve prices/)).text)
        .toBe('Not saved — the person who approved it no longer may approve prices, so their approval does not count. Ask again.');
      expect(await hidden(page, 'save-price'), 'the button stays, so the person can ask again').toBe(false);
    } finally {
      await teardown();
    }
  });

  it('a TYPED approver is refused by head office by name — and the screen has nowhere to type one', async () => {
    const ho = newHeadOffice(pricingContext());
    const { page, teardown } = await openPriceTab(ho);
    try {
      await checkPrice(page, 'SKU-DAL', '90');
      expect(await page.locator('#sheet, #choices, #sheet-reason').count()).toBe(0);
      // The audit's body, sent from the page's own origin and session: a name where the approval should be.
      const answer = await page.evaluate(async (body) => {
        const res = await fetch('/v1/prices/changes', {
          method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'idempotency-key': 'typed-1' },
          body: JSON.stringify(body),
        });
        return { status: res.status, body: await res.json() as { error?: { code?: string } } };
      }, { ...BELOW_COST, approval: { decidedBy: 'u-owner', reason: 'they said yes on the phone' } });
      expect(answer.status).toBe(422);
      expect(answer.body.error?.code).toBe('approver_named_without_approval');
    } finally {
      await teardown();
    }
  });
});
