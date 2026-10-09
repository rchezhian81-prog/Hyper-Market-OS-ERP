import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
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
 * **SF-01 (offers) in a real browser — the box holds head office's signed catalogue with a launched offer, and the
 * served till gives it (Wave 4 · M05-FR-03 · P-01).**
 *
 * The integration proof (`a-launched-offer-is-the-offer-the-till-gives`) follows the offer from launch to the signed
 * pack and a till session. This is the last hop on the deployable arrangement: the box restores the signed pack from its
 * own disk (no cloud), serves the real till shell, and a real Chromium rings the product — the total is the offer's,
 * judged by the lane's own clock. Skips where no browser binary is present.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['served', 'till', 'offer', 'signing', 'key'].join('-').padEnd(48, '0');
const day = (offset: number): string => new Date(Date.now() + offset * 864e5).toISOString();

interface PosWindow {
  readonly posSession?: {
    scan(item: { productId: string; description: string; unitPriceMinor: number; qty: number }): void;
    payableMinor(): number;
  };
}

/** Head office's signed pack: ghee at ₹640, and (optionally) a launched 10% offer on it. */
function signedPack(withOffer: boolean) {
  const snapshot: CatalogueSnapshot = {
    tenantId: 't-sre', version: 3, builtAt: day(0),
    products: [{ productId: 'P1', sku: 'GHEE-1L', name: 'Amul Ghee Gold 1L', baseUom: 'each', unitPriceMinor: 64_000, taxBps: 500, mrpMinor: 70_000, status: 'active' }],
    barcodes: [{ code: '8901234567890', productId: 'P1', kind: 'standard' }],
    ...(withOffer ? { promotions: [{ id: 'ghee-10', kind: 'percent_off' as const, percentBps: 1000, productIds: ['P1'], startsAt: day(-1), endsAt: day(30), status: 'active' as const }] } : {}),
  };
  const result = publishPack({ snapshot, approvals: [], signer: hmacSigner(KEY), publishedBy: 'u-manager', publishedAt: day(0) });
  if (!result.ok || result.pack === undefined) throw new Error(result.detail);
  return result.pack;
}

describe.skipIf(!HAVE_BROWSER)('the served till gives the offer head office launched', () => {
  let browser: Browser;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'pos'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 90_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  const ringGhee = async (withOffer: boolean): Promise<number> => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-served-till-offer-'));
    dirs.push(dir);
    await writeSignedPack(dir, signedPack(withOffer));
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_LANE_ID: 'lane-1', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
      ...await prepareTillBox({ dir, key: KEY }),
    }, () => {}))!;
    stops.push(() => edge.stop());
    const context = await browser.newContext();
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/pos/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession !== undefined, undefined, { timeout: 15_000 });
    return page.evaluate(() => {
      const w = globalThis as unknown as PosWindow;
      w.posSession!.scan({ productId: 'P1', description: 'Amul Ghee Gold 1L', unitPriceMinor: 64_000, qty: 2 });
      return w.posSession!.payableMinor();
    });
  };

  it('2 × ₹640 with the launched 10% offer in the signed pack: the till asks ₹1,152', async () => {
    expect(await ringGhee(true)).toBe(115_200);
  });

  it('the same pack without the offer: the till asks the full ₹1,280', async () => {
    expect(await ringGhee(false)).toBe(128_000);
  });
});
