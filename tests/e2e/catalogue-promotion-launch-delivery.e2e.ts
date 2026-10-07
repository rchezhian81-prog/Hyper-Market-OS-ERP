import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import {
  newHeadOffice, startPricingHeadOffice, decideAsSomeoneElse, posts, CALLER, type PricingHeadOffice,
} from './lib/pricing-head-office';

/**
 * **The operator launches an offer, in a real browser — and an offer that loses margin needs a second person's OWN
 * approval (M05-FR-03/04 · ADR-0024 · §28 · audit PA-03 · ADR-0013 — the E2E matrix).**
 *
 * Every layer is unit-tested: the session's `launchToCloud`, `askLaunchApproval` and `launchWithApproval`, the
 * browser's `openPromotionLaunchPort`, and head office's engine and launch route. The one thing units cannot prove is
 * that a person filling the Offer form in an ACTUAL browser makes the right writes reach head office under their own
 * session — and that no approver's name exists anywhere on the screen any more. This drives headless Chromium against
 * a stub head office that behaves like the real routes (the engine's own `actionDetails`, `fingerprintOf` and
 * `takeApproval`, the real `simulatePromotion` and `approveForLaunch`):
 *
 *   • a margin-IMPROVING offer launches directly: one POST carrying the simulation INPUT, and nobody is asked;
 *   • a margin-LOSING offer: Start before asking is refused on the screen; Ask for approval records the proposer's own
 *     request for EXACTLY the launch body plus the offer's id; Start while it waits says so; once a DIFFERENT person
 *     approves it, Start launches naming the approval — no approver, no rationale in the body — and it is used once;
 *   • rejected → who and why, in English and Tamil; nothing is sent;
 *   • head office refuses a launch (422) → its own words, and the button stays;
 *   • a typed approver is refused by head office by name, and the screen has no box to type one.
 *
 * The browser binary is the environment's pre-installed Chromium; where none is present the suite SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);

/**
 * The slice of the browser's globals these callbacks touch, cast structurally INSIDE each `page.evaluate` /
 * `waitForFunction` — so the callback references no DOM lib and this test file needs none.
 */
interface BrowserGlobals {
  readonly catalogueSession?: { readonly canLaunchToCloud: boolean; readonly canAskForApproval: boolean };
  readonly document: { getElementById(id: string): { hidden: boolean; textContent: string | null } | null };
}

/** A store manager and the shop's margin floor. No list of approvers: head office decides who may approve. */
const pricingContext = (): Record<string, unknown> => ({
  userId: CALLER, storeId: 'store-1', today: '2026-10-07', marginFloorBps: 2000,
});

/** What the screen sends for the loss-leader offer as typed below — the simulation input, exactly. */
const LOSS_LEADER = {
  promotionId: 'loss-leader', description: 'loss-leader',
  normalPrice: { minor: 145_00, currency: 'INR' }, promoPrice: { minor: 80_00, currency: 'INR' },
  unitCost: { minor: 100_00, currency: 'INR' }, baselineUnits: 100, expectedUnits: 400,
};

describe.skipIf(!HAVE_BROWSER)('operator promotion-launch delivery under the two-person rule, end to end in a real browser (M05-FR-03/04 · ADR-0024)', () => {
  let browser: Browser;

  beforeAll(async () => {
    // Build the CURRENT web-erp bundle so the browser runs this branch's code, not a stale artifact.
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  /** Open the catalogue screen on the Offer tab, wired to the stub head office. */
  const openOfferTab = async (ho: PricingHeadOffice) => {
    const srv = await startPricingHeadOffice(ho);
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${srv.base}/`, { waitUntil: 'load' });
    // Boot is done once the tested session is wired to the window (and it can reach head office).
    await page.waitForFunction(
      () => {
        const s = (globalThis as unknown as BrowserGlobals).catalogueSession;
        return s?.canLaunchToCloud === true && s.canAskForApproval === true;
      },
      undefined, { timeout: 10_000 },
    );
    await page.click('#tab-promo');
    return { page, errors, teardown: async () => { await context.close(); await srv.stop(); } };
  };

  /** Fill the Offer form and work it out. Prices in rupees, exactly as a person types them. */
  const fillOffer = async (
    page: Page,
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
  const lossLeader = { id: 'loss-leader', normal: '145', promo: '80', cost: '100', baseline: '100', expected: '400' };

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

  it('a margin-improving offer launches with nobody asked: the POST carries the simulation INPUT, keyed', async () => {
    const ho = newHeadOffice(pricingContext());
    const { page, errors, teardown } = await openOfferTab(ho);
    try {
      await fillOffer(page, { id: 'pongal-dal', normal: '145', promo: '130', cost: '100', baseline: '100', expected: '200' });
      expect(await hidden(page, 'promo-approval'), 'a margin-improving offer shows no approval step').toBe(true);
      const said = await clickFor(page, '#launch', /pongal-dal/);
      expect(said.title).toBe('Offer started');

      const launch = posts(ho, '/v1/promotions/pongal-dal/launch');
      expect(launch, 'the launch was not POSTed').toHaveLength(1);
      expect(launch[0]!.body).toEqual({
        promotionId: 'pongal-dal', description: 'pongal-dal',
        normalPrice: { minor: 145_00, currency: 'INR' }, promoPrice: { minor: 130_00, currency: 'INR' },
        unitCost: { minor: 100_00, currency: 'INR' }, baselineUnits: 100, expectedUnits: 200,
      });
      expect(launch[0]!.headers['idempotency-key']).toBeTruthy();
      expect(posts(ho, '/v1/approvals/requests'), 'nobody is asked for a margin-improving offer').toHaveLength(0);
      expect(await hidden(page, 'launch')).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await teardown();
    }
  });

  it('a margin-losing offer: ask, wait, a DIFFERENT person approves, then Start names the approval — and nothing else', async () => {
    const ho = newHeadOffice(pricingContext());
    const { page, errors, teardown } = await openOfferTab(ho);
    try {
      await fillOffer(page, lossLeader);
      expect(await hidden(page, 'promo-approval')).toBe(false);
      expect(await page.getAttribute('#ask-launch', 'class')).toContain('primary');
      expect(await page.getAttribute('#launch', 'class')).not.toContain('primary');
      expect(await page.locator('#sheet, #choices, #sheet-reason').count(), 'an approver picker is still on the page').toBe(0);

      // Start BEFORE asking: refused on the screen, nothing sent.
      expect((await clickFor(page, '#launch', /nobody has been asked/)).text)
        .toBe('Not started — nobody has been asked to approve exactly this yet. Write why and press “Ask for approval” first.');
      expect(posts(ho, '/v1/promotions/loss-leader/launch')).toHaveLength(0);

      // Ask for approval — the proposer's OWN request, for exactly the launch body plus the offer's id.
      await page.fill('#promo-why', 'footfall driver for the Pongal weekend');
      const asked = await clickFor(page, '#ask-launch', /Waiting for a second person/);
      expect(asked.title).toBe('Waiting for approval');
      expect(asked.text).toBe('Asked. Waiting for a second person who may approve prices to approve it on the Approvals page. The offer has not started yet. Launch offer loss-leader — loses margin (₹80.00 instead of ₹145.00; it costs us ₹100.00)');
      const ask = posts(ho, '/v1/approvals/requests');
      expect(ask).toHaveLength(1);
      expect(ask[0]!.body).toEqual({
        kind: 'promotion_launch', subjectRef: 'loss-leader', details: LOSS_LEADER, valueMinor: null,
        summary: 'Launch offer loss-leader — loses margin (₹80.00 instead of ₹145.00; it costs us ₹100.00)',
        reason: 'footfall driver for the Pongal weekend',
      });
      expect(posts(ho, '/v1/promotions/loss-leader/launch'), 'asking launches nothing').toHaveLength(0);
      expect(await page.getAttribute('#launch', 'class')).toContain('primary');

      // Start while it waits: says so, nothing sent.
      expect((await clickFor(page, '#launch', /still waiting/)).text)
        .toBe('Not started — still waiting for a second person who may approve prices (not you) to approve it on their Approvals page.');
      expect(posts(ho, '/v1/promotions/loss-leader/launch')).toHaveLength(0);

      // A DIFFERENT person approves it, in their own session.
      decideAsSomeoneElse(ho, 'areq-1', 'approved', 'worth it for the festival footfall');

      // Start — names the approved request; no approver, no rationale in the body. Head office accepts it.
      const started = await clickFor(page, '#launch', /^Offer started/);
      expect(started.title).toBe('Offer started');
      expect(started.text).toBe('Offer started: loss-leader. The approval has now been used — another launch needs a new approval.');
      const launch = posts(ho, '/v1/promotions/loss-leader/launch');
      expect(launch).toHaveLength(1);
      expect(launch[0]!.body).toEqual({ ...LOSS_LEADER, approvalId: 'areq-1' });
      expect(launch[0]!.body).not.toHaveProperty('approvedBy');
      expect(launch[0]!.body).not.toHaveProperty('rationale');
      expect(launch[0]!.body).not.toHaveProperty('approval');
      expect(ho.approvals.get('areq-1')?.usedBy).toBe('promotion_launch:loss-leader');
      expect(await hidden(page, 'launch')).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await teardown();
    }
  });

  it('REJECTED: Start says who rejected it and why — in English and in Tamil — and nothing is sent', async () => {
    const ho = newHeadOffice(pricingContext());
    const { page, teardown } = await openOfferTab(ho);
    try {
      await fillOffer(page, lossLeader);
      await page.fill('#promo-why', 'footfall driver for the Pongal weekend');
      await clickFor(page, '#ask-launch', /Waiting for a second person/);
      decideAsSomeoneElse(ho, 'areq-1', 'rejected', 'too deep a cut');

      expect((await clickFor(page, '#launch', /rejected it/)).text)
        .toBe('Not started — u-owner rejected it: “too deep a cut”. Change what they said and ask again.');
      await page.click('#lang');
      await page.waitForFunction('document.documentElement.lang === "ta"');
      expect((await clickFor(page, '#launch', /மறுத்தார்/)).text)
        .toBe('தொடங்கப்படவில்லை — u-owner மறுத்தார்: “too deep a cut”. அவர் சொன்னதை மாற்றி மீண்டும் கேளுங்கள்.');
      expect(posts(ho, '/v1/promotions/loss-leader/launch'), 'a rejected offer must not be launched').toHaveLength(0);
    } finally {
      await teardown();
    }
  });

  it('head office refuses a launch (422): the screen shows its own words, never claims a launch, and the button stays', async () => {
    const ho = newHeadOffice(pricingContext());
    ho.forceRefusal = { code: 'not_readable_as_a_simulation', whatHappened: 'A promotion simulation needs whole baselineUnits and expectedUnits.' };
    const { page, teardown } = await openOfferTab(ho);
    try {
      await fillOffer(page, { id: 'pongal-dal', normal: '145', promo: '130', cost: '100', baseline: '100', expected: '200' });
      const said = await clickFor(page, '#launch', /whole baselineUnits/);
      expect(said.title).toBe('Please read this');
      expect(said.text).toBe('A promotion simulation needs whole baselineUnits and expectedUnits.');
      expect(posts(ho, '/v1/promotions/pongal-dal/launch')).toHaveLength(1);
      expect(await hidden(page, 'launch'), 'the button stays, so the person can correct the offer').toBe(false);
    } finally {
      await teardown();
    }
  });

  it('a TYPED approver is refused by head office by name — and the screen has nowhere to type one', async () => {
    const ho = newHeadOffice(pricingContext());
    const { page, teardown } = await openOfferTab(ho);
    try {
      await fillOffer(page, lossLeader);
      expect(await page.locator('#sheet, #choices, #sheet-reason').count()).toBe(0);
      const answer = await page.evaluate(async (body) => {
        const res = await fetch('/v1/promotions/loss-leader/launch', {
          method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'idempotency-key': 'typed-1' },
          body: JSON.stringify(body),
        });
        return { status: res.status, body: await res.json() as { error?: { code?: string } } };
      }, { ...LOSS_LEADER, approvedBy: 'u-owner', rationale: 'they said yes on the phone' });
      expect(answer.status).toBe(422);
      expect(answer.body.error?.code).toBe('approver_named_without_approval');
      expect(posts(ho, '/v1/approvals/requests')).toHaveLength(0);
    } finally {
      await teardown();
    }
  });
});
