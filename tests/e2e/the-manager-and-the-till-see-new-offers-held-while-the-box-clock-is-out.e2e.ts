import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { writeSignedPack } from '../../edge/store-edge/src/signed-pack-file';
import { hmacSigner, publishPack } from '../../services/catalogue/src/index';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import { prepareTillBox } from '../support/till-operator';

/**
 * **§31.1 · OB-403 "A" (owner, 27 Oct 2026, in writing) — in a real browser on the REAL box, with its clock 26 hours out by its
 * own fsync'd clock log and no head office at all:**
 *   • the manager's clock strip says "Price change held: store clock is … min out" beside a shape, naming the held offer,
 *     in English and Tamil;
 *   • the served till does not apply the offer that started after the clock went out, and keeps the running one; when the
 *     box's badge answer says the hold has lifted, the till applies it again with no reload (nothing lost) — and a badge
 *     read that cannot reach the box never lifts it.
 * The box side (the hold itself, the restart, head office and the owner's alert) is proven by
 * tests/integration/a-store-computer-whose-clock-is-out-holds-new-prices-and-offers-and-tells-head-office.test.ts.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['ob403', 'clock', 'hold', 'e2e', 'key'].join('-').padEnd(48, '0');
const TENANT = 't-sre';
const AHEAD_SECONDS = 26 * 3_600;

interface PosWindow { readonly posSession?: { hasCatalogue(): boolean; heldOffers(): string[] }; readonly posBadge?: { refresh(): Promise<void> } }

describe.skipIf(!HAVE_BROWSER)('OB-403 — the manager and the till see new offers held while the box clock is out, on the real box', () => {
  let browser: Browser;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    execFileSync('node', ['scripts/build-app.mjs', 'pos'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 240_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it('the strip names the hold in both languages; the till leaves the new offer out, and takes it back when the box says so', async () => {
    const now = Date.now();
    const iso = (ms: number): string => new Date(ms).toISOString();
    const dir = await mkdtemp(join(tmpdir(), 'sre-ob403-e2e-')); dirs.push(dir);
    const snapshot: CatalogueSnapshot = {
      tenantId: TENANT, version: 2, builtAt: iso(now - 86_400_000),
      products: [
        { productId: 'p-oil', sku: 'OIL', name: 'Oil 1L', baseUom: 'ea', unitPriceMinor: 20_000, taxBps: 500, status: 'active' },
        { productId: 'p-dal', sku: 'DAL', name: 'Toor dal 1kg', baseUom: 'ea', unitPriceMinor: 10_000, taxBps: 500, status: 'active' },
      ],
      barcodes: [{ code: '8901234567890', productId: 'p-oil', kind: 'standard' }, { code: '8901234567883', productId: 'p-dal', kind: 'standard' }],
      promotions: [
        { id: 'dal-5-running', kind: 'percent_off', startsAt: iso(now - 30 * 86_400_000), endsAt: iso(now + 30 * 86_400_000), status: 'active', productIds: ['p-dal'], percentBps: 500 },
        { id: 'oil-10-new', kind: 'percent_off', startsAt: iso(now - 3_600_000), endsAt: iso(now + 30 * 86_400_000), status: 'active', productIds: ['p-oil'], percentBps: 1000 },
      ],
    };
    const signed = publishPack({ snapshot, approvals: [], signer: hmacSigner(KEY), publishedBy: 'u-hq', publishedAt: iso(now - 86_400_000) });
    if (!signed.ok || signed.pack === undefined) throw new Error(signed.detail);
    await writeSignedPack(dir, signed.pack);
    await writeFile(join(dir, 'clock-checks.log'), `${JSON.stringify({ at: iso(now - 600_000), verdict: 'flag_bills', offsetSeconds: -AHEAD_SECONDS })}\n`, 'utf8');
    const tillEnv = await prepareTillBox({
      dir, key: KEY, people: [{ userId: 'u-cash', displayName: 'Cashier' }],
      pack: { version: 1, policies: { tradingDayCutoff: '00:00', timeZone: 'Asia/Kolkata', storeId: 'store-1', branchId: 'store-1' }, managerPolicy: { userId: 'u-mgr', approvalLimitMinor: 500_000 }, lossPreventionRules: [] },
    });
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', ...tillEnv,
    }, () => {}))!;
    stops.push(() => edge.stop());
    expect(edge.activationHold().heldPromotions.map((p) => p.id)).toEqual(['oil-10-new']);

    const context = await browser.newContext();
    stops.push(() => context.close());
    const errors: string[] = [];

    // ── The manager's strip.
    const manager = await context.newPage();
    manager.on('pageerror', (e) => errors.push(e.message));
    await manager.goto(`http://127.0.0.1:${edge.screens!.port}/manager`, { waitUntil: 'load' });
    await manager.waitForSelector('#box-hold-words:not([hidden])', { timeout: 15_000 });
    const words = (await manager.textContent('#box-hold-words')) ?? '';
    expect(words).toContain('Price change held: store clock is');
    expect(words).toContain('offer oil-10-new');
    expect(words).toContain('Selling goes on');
    expect(await manager.getAttribute('#box-clock', 'data-tone')).toBe('error');
    await manager.waitForSelector('#box-hold-words svg', { timeout: 10_000 });
    await manager.click('#lang');
    await manager.waitForFunction("/[஀-௿]/.test(document.querySelector('#box-hold-words')?.textContent ?? '')", undefined, { timeout: 10_000 });

    // ── The till.
    const pos = await context.newPage();
    pos.on('pageerror', (e) => errors.push(e.message));
    await pos.goto(`http://127.0.0.1:${edge.screens!.port}/pos/`, { waitUntil: 'load' });
    await pos.waitForFunction(() => { const w = globalThis as unknown as PosWindow; return w.posSession !== undefined && w.posSession.hasCatalogue(); }, undefined, { timeout: 15_000 });
    expect(await pos.evaluate(() => (globalThis as unknown as PosWindow).posSession!.heldOffers())).toEqual(['oil-10-new']);
    // A badge read that cannot reach the box never lifts the hold.
    await pos.route('**/lane/sync-status', (route) => route.abort());
    await pos.evaluate(async () => { await (globalThis as unknown as PosWindow).posBadge!.refresh(); });
    expect(await pos.evaluate(() => (globalThis as unknown as PosWindow).posSession!.heldOffers())).toEqual(['oil-10-new']);
    // The box answers that its clock is back in step: the till applies the offer again, with no reload.
    await pos.unroute('**/lane/sync-status');
    await pos.route('**/lane/sync-status', async (route) => {
      const real = await route.fetch();
      const body = await real.json() as Record<string, unknown>;
      await route.fulfill({ response: real, json: { ...body, offerHold: { held: false, cutoffAt: null } } });
    });
    await pos.evaluate(async () => { await (globalThis as unknown as PosWindow).posBadge!.refresh(); });
    expect(await pos.evaluate(() => (globalThis as unknown as PosWindow).posSession!.heldOffers())).toEqual([]);
    expect(errors).toEqual([]);
  }, 60_000);
});
