// R3 lane 3 — a REAL store computer serving the REAL till shell to a real Chromium, holding head office's SIGNED catalogue
// pack (D-20 · SF-08 · B13). No cloud is configured: everything the till decides here it decides offline (P-01).

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../../edge/store-edge/src/main';
import { writeSignedPack } from '../../../edge/store-edge/src/signed-pack-file';
import { hmacSigner, publishPack } from '../../../services/catalogue/src/index';
import type { CatalogueProduct, CatalogueBarcode } from '../../../packages/catalogue/src/catalogue';
import { prepareTillBox, signInThroughScreen } from '../../support/till-operator';

export const R3_TENANT = 't-sre';
const keyOf = (name: string): string => ['r3', name, 'till', 'signing', 'key'].join('-').padEnd(48, '0');

export interface ServedTill {
  readonly edge: EdgeProcess;
  readonly page: Page;
  readonly stop: () => Promise<void>;
}

/** Start a box holding a signed pack of these products, open its till in the browser and sign a cashier in. */
export async function servedTill(browser: Browser, name: string, products: readonly CatalogueProduct[], barcodes: readonly CatalogueBarcode[], existingDir?: string): Promise<ServedTill & { readonly dir: string }> {
  const dir = existingDir ?? await mkdtemp(join(tmpdir(), `sre-r3-${name}-`));
  const key = keyOf(name);
  if (existingDir === undefined) {
    const snapshot = { tenantId: R3_TENANT, version: 7, builtAt: new Date().toISOString(), products, barcodes };
    const result = publishPack({ snapshot, approvals: [], signer: hmacSigner(key), publishedBy: 'u-manager', publishedAt: snapshot.builtAt });
    if (!result.ok || result.pack === undefined) throw new Error(result.detail);
    await writeSignedPack(dir, result.pack);
  }
  const edge = (await startEdge({
    EDGE_DATA_DIR: dir, EDGE_TENANT_ID: R3_TENANT, PACK_SIGNING_KEY: key,
    EDGE_CAPACITY_BYTES: '10485760', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_LANE_PORT: '0',
    ...await prepareTillBox({ dir, key, pack: { version: 1, policies: { tradingDayCutoff: '00:00', storeId: 'store-1' }, lossPreventionRules: [] } }),
  }, () => {}))!;
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${edge.screens!.port}/pos/`, { waitUntil: 'load' });
  await page.waitForFunction(() => {
    const w = globalThis as unknown as { posSession?: { hasCatalogue(): boolean } };
    return w.posSession !== undefined && w.posSession.hasCatalogue();
  }, undefined, { timeout: 15_000 });
  await signInThroughScreen(page);
  return {
    edge, page, dir,
    stop: async () => { await context.close(); await edge.stop(); if (existingDir === undefined) { /* the caller removes the dir */ } },
  };
}

export const removeDir = (dir: string): Promise<void> => rm(dir, { recursive: true, force: true });

/** A scanner: types the code and presses Enter. `gs` places a group separator (Ctrl+]) between parts. */
export async function scan(page: Page, ...parts: readonly string[]): Promise<void> {
  for (let i = 0; i < parts.length; i += 1) {
    if (i > 0) await page.keyboard.press('Control+BracketRight');
    await page.keyboard.type(parts[i]!);
  }
  await page.keyboard.press('Enter');
}

/** What the refusal panel says, then close it — or null when it did not open. */
export async function refusalSaid(page: Page): Promise<string | null> {
  const open = await page.waitForSelector('#refusal:not([hidden])', { timeout: 3_000 }).then(() => true, () => false);
  if (!open) return null;
  const text = await page.textContent('#refusal-text');
  await page.click('#refusal-ok');
  return text;
}

export interface BasketRow { readonly productId: string; readonly batchId?: string; readonly huid?: string; readonly unitPriceMinor: number }
export const basket = (page: Page): Promise<BasketRow[]> =>
  page.evaluate(() => (globalThis as unknown as { posSession: { basket(): BasketRow[] } }).posSession.basket());

/** Pay the bill in exact cash, the way a cashier does, and return what the till said afterwards. */
export async function payCash(page: Page): Promise<string | null> {
  await page.click('#tender');
  await page.waitForSelector('#pay-kinds button');
  await page.click('#pay-kinds button:first-child'); // Cash
  await page.waitForSelector('#quick button');
  await page.click('#quick button:first-child'); // Exact
  return refusalSaid(page);
}
