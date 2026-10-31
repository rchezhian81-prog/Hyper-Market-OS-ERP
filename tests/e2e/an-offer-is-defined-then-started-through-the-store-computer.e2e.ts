import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { decide } from '../support/approval-request';

/**
 * **An offer is defined, then started, on the Products and prices page's Offer tab — in a real browser, served by the store
 * computer, over head office's REAL routes (M05-FR-03 · M05-FR-04 · re-audit 30 Oct 2026 · ADR-0024 · §28).**
 *
 * The re-audit found the Offer tab's Start refused by head office with `promotion_not_defined` for every new offer — no
 * screen defined one — and its browser test passing only against a stub head office. Here the real store computer serves
 * the page; head office's API surface runs in memory with its real routes, permission checks and approval engine, and every
 * `/v1` call reaches it as the signed-in person, on the box's own origin. Through Chromium:
 *   • Start before the rule is refused by head office — said on the page in plain words, nothing started;
 *   • the manager records the rule (percent off, two products, the shop's days, a coupon, members only, an exclusive group,
 *     an abuse cap) — head office keeps it as a DRAFT; Start then launches it and head office switches THAT rule on;
 *   • the same name again is refused in head office's own words;
 *   • a margin-losing offer still needs a DIFFERENT person's own approval (the owner, on head office's approval engine):
 *     Start while it waits says so; once approved, Start launches it;
 *   • the rule step speaks Tamil.
 * Synthetic data only. Without a browser binary it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['offer', 'define', 'box', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = randomUUID();
const MANAGER = 'u-mgr';
const OWNER = 'u-owner';

interface CatWindow { readonly catalogueSession?: { canDefineOffer: boolean; canLaunchToCloud: boolean } }

describe.skipIf(!HAVE_BROWSER)('the Offer tab defines the offer at head office, then Start works — through the store computer (M05-FR-03/04)', () => {
  let browser: Browser;
  let ho: ApiHarness;
  let edge: EdgeProcess;
  let dir: string;
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    ho = apiHarness();
    await ho.seedOwner(TENANT, OWNER);
    await ho.provisionRole(TENANT, MANAGER, 'store_manager');

    dir = await mkdtemp(join(tmpdir(), 'sre-offer-define-'));
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, JSON.stringify({
      version: 1, lossPreventionRules: [], policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1' },
      pricingPolicy: { userId: MANAGER, approvers: [OWNER], marginFloorBps: 2000 },
      roles: [{ id: 'manager', name: 'Store manager', permissions: ['identity.self.read', 'catalogue.pack.read', 'price.change.propose', 'promotion.launch'] }],
      roleAssignments: [{ userId: MANAGER, roleId: 'manager', branchScope: 'all' }],
    }), 'utf8');
    edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
      EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile, EDGE_SCREEN_TRUST_FORWARDED_USER: '1',
    }, () => {}))!;
  }, 240_000);
  afterAll(async () => { await browser?.close(); await edge?.stop(); if (dir !== undefined) await rm(dir, { recursive: true, force: true }); });
  afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });

  /** The Offer tab on the box's origin as `who`; head office's API carried on that origin as that person. */
  const open = async (who: string): Promise<{ page: Page; errors: string[] }> => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', extraHTTPHeaders: { 'x-sre-user': who } });
    stops.push(() => context.close());
    await context.route('**/v1/**', async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const raw = req.postData();
      const answer = await ho.request({
        method: req.method() as 'GET', path: url.pathname, userId: who, tenantId: TENANT,
        ...(raw === null ? {} : { body: JSON.parse(raw) as unknown }),
        ...(req.headers()['idempotency-key'] === undefined ? {} : { idempotencyKey: req.headers()['idempotency-key'] }),
        ...(url.search === '' ? {} : { query: Object.fromEntries(url.searchParams) }),
      });
      await route.fulfill({ status: answer.status, contentType: 'application/json', body: JSON.stringify(answer.body ?? {}) });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const res = await page.goto(`http://127.0.0.1:${edge.screens!.port}/catalogue/?tab=promo`, { waitUntil: 'load' });
    expect(res?.status(), 'the page is served by the store computer').toBe(200);
    await page.waitForFunction(() => { const s = (globalThis as unknown as CatWindow).catalogueSession; return s?.canDefineOffer === true && s.canLaunchToCloud === true; });
    return { page, errors };
  };
  /** Name the offer and work out its margin (prices in rupees, as typed). */
  const workOut = async (page: Page, o: { id: string; normal: string; promo: string; cost: string; baseline: string; expected: string }) => {
    await page.fill('#promo-id', o.id);
    await page.fill('#promo-normal', o.normal);
    await page.fill('#promo-price', o.promo);
    await page.fill('#promo-cost', o.cost);
    await page.fill('#promo-baseline', o.baseline);
    await page.fill('#promo-expected', o.expected);
    await page.click('#simulate');
    await page.waitForSelector('#launch:not([hidden])');
  };
  /** Fill the rule's common fields and record it; returns what the page said. */
  const record = async (page: Page, rule: { products: string; percent: string; coupon?: string; exclusive?: string; cap?: string; memberOnly?: boolean }) => {
    await page.selectOption('#rule-kind', 'percent_off');
    await page.fill('#rule-products', rule.products);
    await page.fill('#rule-percent', rule.percent);
    await page.fill('#rule-coupon', rule.coupon ?? '');
    await page.fill('#rule-exclusive', rule.exclusive ?? '');
    await page.fill('#rule-cap', rule.cap ?? '');
    if (rule.memberOnly === true) await page.check('#rule-member-only');
    await page.evaluate(() => { (globalThis as unknown as { document: { getElementById(id: string): { textContent: string } } }).document.getElementById('define-status').textContent = ''; });
    await page.click('#define-offer');
    await page.waitForFunction(() => ((globalThis as unknown as { document: { getElementById(id: string): { textContent: string | null } } }).document.getElementById('define-status').textContent ?? '') !== '');
    return ((await page.textContent('#define-status')) ?? '').trim();
  };
  const clickFor = async (page: Page, button: string): Promise<{ title: string; text: string }> => {
    await page.click(button);
    await page.waitForSelector('#banner:not([hidden])');
    const said = { title: ((await page.textContent('#banner-title')) ?? '').trim(), text: ((await page.textContent('#banner-text')) ?? '').trim() };
    await page.click('#banner-ok');
    await page.waitForSelector('#banner', { state: 'hidden' });
    return said;
  };
  const definition = async (id: string) => (await ho.request({ method: 'GET', path: `/v1/promotions/${id}/definition`, userId: OWNER, tenantId: TENANT })).body as Record<string, unknown>;

  it('Start before the rule is refused; the rule is recorded as a draft; Start then switches THAT rule on; the same name again is refused in head office\'s words', async () => {
    const { page, errors } = await open(MANAGER);
    // Only the chosen kind's boxes are shown.
    expect(await page.isVisible('#rule-percent')).toBe(true);
    expect(await page.isHidden('#rule-multi-qty')).toBe(true);
    await workOut(page, { id: 'pongal-dal', normal: '145', promo: '130', cost: '100', baseline: '100', expected: '200' });

    const early = await clickFor(page, '#launch');
    expect(early.title).toBe('Please read this');
    expect(early.text).toBe('Not started — head office has no rule for this offer yet. Fill in “The offer’s rule” with the same name and press “Record this rule at head office” first. Nothing was started.');
    expect((await ho.request({ method: 'GET', path: '/v1/promotions/pongal-dal', userId: OWNER, tenantId: TENANT })).body).toMatchObject({ launched: false });

    const today = await page.inputValue('#rule-starts');
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const said = await record(page, { products: 'p-dal, p-rice', percent: '10', coupon: 'PONGAL', exclusive: 'festival', cap: '2', memberOnly: true });
    expect(said).toBe(`Rule recorded at head office as a draft. It does nothing until you press “Start this offer”. pongal-dal · ${today} – ${today}`);
    expect(await definition('pongal-dal')).toMatchObject({
      kind: 'percent_off', status: 'draft', productIds: ['p-dal', 'p-rice'], percentBps: 1000, requiresCoupon: 'PONGAL',
      requiresMember: true, exclusiveGroup: 'festival', maxApplications: 2,
    });

    const started = await clickFor(page, '#launch');
    expect(started.title).toBe('Offer started');
    expect(await definition('pongal-dal')).toMatchObject({ status: 'active', exclusiveGroup: 'festival', maxApplications: 2 });

    const twice = await record(page, { products: 'p-dal', percent: '5' });
    expect(twice.startsWith('Head office refused: Promotion pongal-dal already exists')).toBe(true);
    expect(errors).toEqual([]);
  });

  it('a margin-losing offer, once its rule is recorded, still needs a DIFFERENT person\'s own approval before Start launches it', async () => {
    const { page, errors } = await open(MANAGER);
    await workOut(page, { id: 'loss-leader', normal: '145', promo: '80', cost: '100', baseline: '100', expected: '400' });
    expect(await page.isHidden('#promo-approval')).toBe(false);
    expect(await record(page, { products: 'p-oil', percent: '45' })).toContain('Rule recorded at head office as a draft.');

    await page.fill('#promo-why', 'footfall driver for the Pongal weekend');
    const asked = await clickFor(page, '#ask-launch');
    expect(asked.title).toBe('Waiting for approval');
    const waiting = await clickFor(page, '#launch');
    expect(waiting.text).toContain('still waiting for a second person');
    expect(await definition('loss-leader')).toMatchObject({ status: 'draft' });

    // The owner approves it, in their own session, on head office's approval engine.
    const inbox = (await ho.request({ method: 'GET', path: '/v1/approvals/requests', userId: OWNER, tenantId: TENANT })).body as { waitingForMe: { requestId: string; subjectRef: string }[] };
    const request = inbox.waitingForMe.find((r) => r.subjectRef === 'loss-leader')!;
    expect((await decide(ho, TENANT, OWNER, request.requestId, 'approved', 'worth it for the festival footfall')).status).toBe(201);

    const started = await clickFor(page, '#launch');
    expect(started.title).toBe('Offer started');
    expect(await definition('loss-leader')).toMatchObject({ status: 'active' });

    await page.click('#lang');
    await page.waitForFunction(() => (globalThis as unknown as { document: { documentElement: { lang: string } } }).document.documentElement.lang === 'ta');
    expect(await page.textContent('#rule-title')).toBe('சலுகையின் விதி');
    expect(await page.textContent('#define-offer')).toBe('இந்த விதியைத் தலைமை அலுவலகத்தில் பதிவு செய்');
    expect(errors).toEqual([]);
  });
});
