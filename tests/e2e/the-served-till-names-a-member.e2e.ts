import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { prepareTillBox, signInThroughScreen } from '../support/till-operator';
import { readdir, readFile, stat } from 'node:fs/promises';
import { loyaltyMemberKey, memberRefFor } from '../../packages/loyalty/src/index';

/**
 * **The cashier names a loyalty member by mobile number through the SCREEN, and the number never reaches the store
 * computer's disk (PF-09 step 2 · OB-28 "1" · P-04 · M17-FR-01).**
 *
 * In a real Chromium against a real edge: More → Loyalty member → the customer's 10 digits on the till's own keypad →
 * the till says the member is on the bill, showing only the last four digits. A number that is not one is refused in the
 * cashier's words. The sale is rung and paid; on the box's disk is the member code the box made — not the number. The
 * member can be removed from the bill from the same menu.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['served', 'till', 'member', 'signing', 'key'].join('-').padEnd(48, '0');

/** A store pack with the shop's cut-off and a ₹100 cash tolerance, and one sellable item. */
const PACK = JSON.stringify({
  version: 1,
  policies: { storeId: 'store-1', branchId: 'store-1', branchName: 'Main', tradingDayCutoff: '02:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, cashVarianceToleranceMinor: 10_000, privacySlaDays: 30, warehouseId: 'wh-1' },
  lossPreventionRules: [],
  products: [{ productId: 'P1', name: 'Toor dal 1kg', categoryId: 'grocery', unitPriceMinor: 48_000, uom: 'ea', barcodes: ['8901234567890'], availableMinor: 100, taxBps: 0, status: 'active' }],
});

interface PosWindow {
  readonly posSession?: {
    hasCatalogue(): boolean;
    tenderCash(saleId: string, receiptNumber: string, atIsoUtc: string): Promise<string>;
    /** The next receipt number, from the store computer (audit PF-04). */
    nextReceipt(): Promise<string>;
    signIn(cashierId: string): void;
    operator(): string | undefined;
    newSale(): void;
  };
}

async function everythingOnDisk(dir: string): Promise<string> {
  const out: string[] = [];
  for (const name of await readdir(dir)) {
    const path = join(dir, name);
    if ((await stat(path)).isDirectory()) out.push(await everythingOnDisk(path));
    else out.push(await readFile(path, 'utf8'));
  }
  return out.join('\n');
}

describe.skipIf(!HAVE_BROWSER)('the cashier names a loyalty member by mobile number, and the number never reaches a disk (PF-09 step 2)', () => {
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

  const keyDigits = async (page: Page, digits: string): Promise<void> => {
    await page.waitForSelector('#sheet:not([hidden])');
    for (const digit of digits) await page.click(`#keypad button:text-is("${digit}")`);
    await page.click('#sheet-ok');
  };
  const shown = async (page: Page): Promise<{ title: string; text: string }> => {
    await page.waitForSelector('#refusal:not([hidden])');
    const title = (await page.textContent('#refusal-title')) ?? '';
    const text = (await page.textContent('#refusal-text')) ?? '';
    await page.click('#refusal-ok');
    return { title, text };
  };
  const more = async (page: Page): Promise<string[]> => {
    await page.click('#more');
    await page.waitForSelector('#pay:not([hidden])');
    return page.$$eval('#pay-kinds button', (b) => b.map((x) => x.textContent ?? ''));
  };
  const choose = async (page: Page, label: string): Promise<void> => { await page.click(`#pay-kinds button:text-is("${label}")`); };

  it('More → Loyalty member → keypad → only ••••2345 shown; the sale is on the box with the member code and not the number', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-served-till-member-'));
    dirs.push(dir);
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, PACK, 'utf8');
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_PACK_FILE: packFile,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '8090', EDGE_LANE_ID: 'lane-1', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
      ...await prepareTillBox({ dir, key: KEY, pack: JSON.parse(PACK) as Record<string, unknown> }),
    }, () => {}))!;
    stops.push(() => edge.stop());

    const context = await browser.newContext();
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/pos/`, { waitUntil: 'load' });
    await page.waitForFunction(() => {
      const w = globalThis as unknown as PosWindow;
      return w.posSession !== undefined && w.posSession.hasCatalogue();
    }, undefined, { timeout: 15_000 });
    await signInThroughScreen(page);

    // A number that is not a mobile is refused in the cashier's words — nothing is set.
    expect(await more(page)).toContain('Loyalty member');
    await choose(page, 'Loyalty member');
    await keyDigits(page, '12345');
    expect((await shown(page)).text).toMatch(/not a 10-digit mobile number/);

    // The customer's number on the till's own keypad: only the last four digits are ever shown.
    await more(page);
    await choose(page, 'Loyalty member');
    await keyDigits(page, '9840012345');
    const set = await shown(page);
    expect(set.text).toContain('••••2345');
    expect(set.text).not.toContain('98400');
    expect(await more(page)).toContain('Remove loyalty member ••••2345');
    await page.click('#pay-cancel');

    // Ring and pay the ₹480 item.
    await page.keyboard.type('8901234567890');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#lines tr');
    await page.evaluate(async () => {
      const w = globalThis as unknown as PosWindow;
      await w.posSession!.tenderCash('S-member-1', await w.posSession!.nextReceipt(), new Date().toISOString());
      w.posSession!.newSale();
    });

    const disk = await everythingOnDisk(dir);
    expect(disk).toContain(memberRefFor(loyaltyMemberKey(KEY), '9840012345')!);
    expect(disk).not.toContain('9840012345');
    // The next bill names nobody.
    expect(await more(page)).toContain('Loyalty member');
  }, 60_000);
});
