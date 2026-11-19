import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { startEdge } from '../../edge/store-edge/src/main';
import { writeSignedPack } from '../../edge/store-edge/src/signed-pack-file';
import { headOfficeSignInPage } from '../../edge/store-edge/src/head-office-link';
import { hmacSigner, publishPack } from '../../services/catalogue/src/index';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import { ROLE_CATALOGUE } from '../../services/api/src/roles';
import { prepareTillBox, pinOf } from '../support/till-operator';

/**
 * **Batch 18a — the leftovers from batch 17, in a real Chromium, on a store-PC copy as installed (office PIN sign-in on):**
 *
 *   1. OB-855 — the store computer's own system pages (About, Licence, Software update, Handheld seal, Head office sign-in)
 *      open in English only; their switch shows Tamil only; the choice is remembered on this device (the next system page
 *      opens in it), and English again on the switch.
 *   2. The sign-in page opens in the language last chosen on this device.
 *   3. Buying: the Open orders and Reorder tabs carry their real names, never "tab" / "lead".
 *   4. The Sign out bar covers nothing, at 1366 and at 360 wide: it is part of the menu (or the top of the page), never
 *      floating over a page's boxes.
 *
 * Screenshots (deviceScaleFactor 1) go to SRE_SCREENSHOT_DIR when it is set. Synthetic data only. Skips without a browser.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const SHOTS = process.env['SRE_SCREENSHOT_DIR'];
const KEY = ['b18a', 'store', 'pc', 'key'].join('-').padEnd(48, '0');
const TAMIL = /[஀-௿]/;
const OWNER_PERMISSIONS = [...(ROLE_CATALOGUE.find((r) => r.id === 'owner') as unknown as { permissions: readonly string[] }).permissions];
const STORE = 'store-1';

function signedCatalogue(tenantId: string) {
  const snapshot: CatalogueSnapshot = {
    tenantId, version: 3, builtAt: new Date().toISOString(),
    products: [{ productId: 'P1', sku: 'DAL', name: 'Toor dal 1kg', baseUom: 'ea', unitPriceMinor: 10_500, taxBps: 500, hsnCode: '071360', status: 'active' }],
    barcodes: [{ code: '8901234567890', productId: 'P1', kind: 'standard' }],
  };
  const result = publishPack({ snapshot, approvals: [], signer: hmacSigner(KEY), publishedBy: 'u-owner', publishedAt: snapshot.builtAt });
  if (!result.ok || result.pack === undefined) throw new Error(result.detail);
  return result.pack;
}

/** The visible text of the page's <main> (or body), with the language switch's own label left out. */
const visibleText = (page: Page): Promise<string> => page.evaluate<string>("(document.querySelector('main') || document.body).innerText");

describe.skipIf(!HAVE_BROWSER)('batch 18a — system pages in one language, the Buying tabs, the Sign out bar', () => {
  let browser: Browser;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    if (SHOTS !== undefined) await mkdir(SHOTS, { recursive: true });
  }, 120_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });
  const shot = async (page: Page, name: string): Promise<void> => { if (SHOTS !== undefined) await page.screenshot({ path: join(SHOTS, name) }); };

  async function storePc(): Promise<string> {
    const tenantId = randomUUID();
    const dir = await mkdtemp(join(tmpdir(), 'sre-b18a-'));
    dirs.push(dir, `${dir}-witness`);
    await writeSignedPack(dir, signedCatalogue(tenantId));
    const pack = {
      version: 1,
      policies: { storeId: STORE, branchId: STORE, branchName: 'SRE Hyper Market', tradingDayCutoff: '00:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, cashVarianceToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'wh-1' },
      servicePolicy: { returnWindowDays: 30, approvalThresholdMinor: 1_000_000, noReceiptCapMinor: 0, agentAuthorityMinor: 0, compensationCapMinor: 0 },
      lossPreventionRules: [],
      roles: [{ id: 'owner', name: 'Owner', permissions: OWNER_PERMISSIONS }],
      roleAssignments: [{ userId: 'u-owner', roleId: 'owner', branchScope: 'all' }],
    };
    const people = [{ userId: 'u-owner', displayName: 'The Owner' }];
    const edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: tenantId, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_LANE_ID: 'lane-1', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_OFFICE_SIGN_IN: 'pin',
      ...await prepareTillBox({ dir, key: KEY, pack, people }),
    }, () => {}))!;
    stops.push(() => edge.stop());
    return `http://127.0.0.1:${edge.screens!.port}`;
  }
  async function context(width = 1366, height = 768): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
    const c = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, serviceWorkers: 'block' });
    stops.push(() => c.close());
    const page = await c.newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    return { context: c, page, errors };
  }
  async function signIn(page: Page, base: string, path = '/manager/'): Promise<void> {
    await page.goto(`${base}${path}`, { waitUntil: 'load' });
    await page.fill('#office-staff', 'u-owner');
    await page.fill('#office-pin', pinOf('u-owner'));
    await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('#office-submit')]);
  }

  it('OB-855: About, Licence, Software update, Handheld seal and Head office sign-in — English only, Tamil only on the switch, remembered', async () => {
    const base = await storePc();
    const { page, errors } = await context();
    await signIn(page, base);
    const pages = [['/about/', 'about'], ['/licence/', 'licence'], ['/update/', 'update'], ['/handheld-seal/', 'handheld-seal']] as const;
    for (const [path, name] of pages) {
      await page.goto(`${base}${path}`, { waitUntil: 'load' });
      expect(await page.evaluate('document.documentElement.lang'), `${path} opens in English`).toBe('en');
      const en = await visibleText(page);
      expect(en.length, `${path} says something`).toBeGreaterThan(20);
      expect(en, `${path} in English shows no Tamil`).not.toMatch(TAMIL);
      expect(await page.textContent('#sre-lang-switch')).toContain('தமிழ்');
      await shot(page, `b18a-${name}-en-1366.png`);
    }
    // தமிழ் on the last page: Tamil only, no English sentence beside it
    await page.click('#sre-lang-switch');
    await page.waitForFunction('document.documentElement.lang === "ta"');
    const ta = await visibleText(page);
    expect(ta).toMatch(TAMIL);
    expect(ta).not.toMatch(/A new handheld trusts|This store computer has no handheld door|Handheld seal/);
    await shot(page, 'b18a-handheld-seal-ta-1366.png');
    // remembered on this device: every other system page now opens in Tamil
    for (const [path, name] of pages.slice(0, 3)) {
      await page.goto(`${base}${path}`, { waitUntil: 'load' });
      expect(await page.evaluate('document.documentElement.lang'), `${path} remembered Tamil`).toBe('ta');
      const text = await visibleText(page);
      expect(text).toMatch(TAMIL);
      expect(text, `${path} in Tamil shows no English heading`).not.toMatch(/About this store computer|Software update|The licence|Whatever the licence says/);
      await shot(page, `b18a-${name}-ta-1366.png`);
    }
    // the Head office sign-in page (served when head office cannot be reached) — the same rule, in the same browser
    await page.goto(`${base}/about/`, { waitUntil: 'load' });
    await page.setContent(headOfficeSignInPage({ problem: 'unreachable', next: '/finance-close/' }));
    expect(await page.evaluate('document.documentElement.lang')).toBe('ta');
    expect(await visibleText(page)).not.toMatch(/Head office sign-in|Back to the store computer/);
    await shot(page, 'b18a-head-office-sign-in-ta-1366.png');
    // English again on the switch — remembered too
    await page.click('#sre-lang-switch');
    await page.waitForFunction('document.documentElement.lang === "en"');
    expect(await visibleText(page)).not.toMatch(TAMIL);
    await shot(page, 'b18a-head-office-sign-in-en-1366.png');
    await page.goto(`${base}/about/`, { waitUntil: 'load' });
    expect(await page.evaluate('document.documentElement.lang')).toBe('en');
    expect(errors).toEqual([]);
  }, 180_000);

  it('the sign-in page opens in the language last chosen on this device', async () => {
    const base = await storePc();
    const { page, errors } = await context();
    await page.goto(`${base}/manager/`, { waitUntil: 'load' });
    expect(await page.evaluate('document.documentElement.lang')).toBe('en');
    await page.click('label[for="sl-lang-ta"]');
    await page.waitForFunction('document.documentElement.lang === "ta"');
    await page.reload({ waitUntil: 'load' });
    expect(await page.evaluate('document.documentElement.lang')).toBe('ta');
    expect(await page.isChecked('#sl-lang-ta')).toBe(true);
    expect(await page.isVisible('#office-heading [lang="en"]')).toBe(false);
    await shot(page, 'b18a-sign-in-ta-remembered-1366.png');
    await page.click('label[for="sl-lang-en"]');
    await page.reload({ waitUntil: 'load' });
    expect(await page.isChecked('#sl-lang-en')).toBe(true);
    expect(await page.evaluate('document.documentElement.lang')).toBe('en');
    expect(errors).toEqual([]);
  }, 120_000);

  for (const [width, height] of [[1366, 768], [360, 740]] as const) {
    it(`Buying's tabs carry their real names, and the Sign out bar covers nothing — at ${width} wide`, async () => {
      const base = await storePc();
      const { page, errors } = await context(width, height);
      await signIn(page, base, '/buying/');
      await page.waitForFunction('globalThis.sreChrome !== undefined');
      expect((await page.textContent('#tab-orders'))!.trim()).toMatch(/^Open orders\s*What is still on order/);
      expect((await page.textContent('#tab-reorder'))!.trim()).toMatch(/^Reorder\s*The reorder settings/);
      const tabCards = await page.evaluate<string>('document.body.innerText');
      expect(tabCards).not.toMatch(/(^|\n)tab(\n|$)/);
      expect(tabCards).not.toMatch(/(^|\n)lead(\n|$)/);
      // The bar is never fixed over the page: whatever is under its box is the bar itself (or its menu).
      const bar = await page.evaluate<{ position: string; inMenu: boolean } | null>(`(() => {
        const b = document.getElementById('sre-office-bar');
        if (b === null) return null;
        return { position: getComputedStyle(b).position, inMenu: b.closest('#sre-menu') !== null };
      })()`);
      expect(bar).not.toBeNull();
      expect(bar!.position).not.toBe('fixed');
      expect(bar!.inMenu).toBe(true);
      // No form box anywhere on the page sits under something else that is not its own (scroll each into view and look).
      const covered = await page.evaluate<string[]>(`(async () => {
        const out = [];
        for (const el of Array.from(document.querySelectorAll('main input, main select, main button, main textarea'))) {
          if (el.offsetParent === null) continue;
          el.scrollIntoView({ block: 'center' });
          await new Promise((r) => requestAnimationFrame(() => r(null)));
          const r = el.getBoundingClientRect();
          for (const [x, y] of [[r.right - 4, r.top + r.height / 2], [r.left + 4, r.top + r.height / 2]]) {
            if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
            const hit = document.elementFromPoint(x, y);
            if (hit !== null && hit.closest('#sre-office-bar') !== null) out.push(el.id || el.tagName);
          }
        }
        return out;
      })()`);
      expect(covered, 'nothing under the Sign out bar').toEqual([]);
      await page.evaluate('window.scrollTo(0, 0)');
      await shot(page, `b18a-buying-tabs-and-sign-out-${width}.png`);
      if (width === 360) {
        // On a phone the Sign out is in the Screens list, under the person — in the list, not over the page.
        await page.click('#sre-menu-button');
        await page.locator('#sre-office-sign-out').scrollIntoViewIfNeeded();
        expect(await page.isVisible('#sre-office-sign-out')).toBe(true);
        await shot(page, 'b18a-sign-out-in-the-screens-list-360.png');
      }
      expect(errors).toEqual([]);
    }, 120_000);
  }
});
