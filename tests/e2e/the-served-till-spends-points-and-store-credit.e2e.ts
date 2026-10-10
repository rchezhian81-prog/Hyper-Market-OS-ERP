import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { prepareTillBox, signInThroughScreen } from '../support/till-operator';
import { loyaltyMemberKey, memberRefFor } from '../../packages/loyalty/src/index';

/**
 * **The cashier splits a bill across a member's points, their store credit and cash, through the SCREEN (PF-09 step 3 ·
 * M12-FR-03 split tender · M17-FR-01/03 · OB-28 "C and 1").**
 *
 * In a real Chromium against a real store computer holding a copy of head office's balances (as it restores one from
 * disk after a pull): the member is named by mobile number; Tender → Split / points / store credit shows what they may
 * spend here and how old the balances are; points, then store credit, then cash with change. On the box's disk: the split
 * and the points the box took, under the member code — never the number. A second bill trying to spend the same points
 * again is refused by the store computer in the cashier's words.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['served', 'till', 'spends', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = 't-sre';
const MEMBER = memberRefFor(loyaltyMemberKey(KEY), '9840012345')!;

const PACK = JSON.stringify({
  version: 1,
  policies: { storeId: 'store-1', branchId: 'store-1', branchName: 'Main', tradingDayCutoff: '00:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, cashVarianceToleranceMinor: 10_000, privacySlaDays: 30, warehouseId: 'wh-1' },
  lossPreventionRules: [],
  products: [{ productId: 'P1', name: 'Toor dal 1kg', categoryId: 'grocery', unitPriceMinor: 48_000, uom: 'ea', barcodes: ['8901234567890'], availableMinor: 100, taxBps: 0, status: 'active' }],
});
/** Head office's balances as the box last pulled them: 100 points at ₹1, ₹200 store credit, a ₹500 daily till limit. */
const WALLETS = {
  tenantId: TENANT, receivedAt: new Date().toISOString(),
  feed: {
    tenantId: TENANT, generatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    rule: { pointsPer100Inr: 1, pointValuePaise: 100, tillSpendCapPaise: 50_000 },
    members: [{ memberRef: MEMBER, points: 100, storeCreditMinor: 20_000, appliedSpendRefs: [] }],
  },
};

describe.skipIf(!HAVE_BROWSER)('the cashier splits a bill across points, store credit and cash on the served till (PF-09 step 3)', () => {
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
  const options = async (page: Page): Promise<string[]> => {
    await page.waitForSelector('#pay:not([hidden])');
    return page.$$eval('#pay-kinds button', (b) => b.map((x) => x.textContent ?? ''));
  };
  const choose = async (page: Page, startsWith: string): Promise<void> => {
    const labels = await options(page);
    const label = labels.find((l) => l.startsWith(startsWith));
    if (label === undefined) throw new Error(`no "${startsWith}" among ${JSON.stringify(labels)}`);
    await page.click(`#pay-kinds button:text-is("${label}")`);
  };
  const quick = async (page: Page, startsWith: string): Promise<void> => {
    await page.waitForSelector('#sheet:not([hidden]) #quick:not([hidden])');
    const labels = await page.$$eval('#quick button', (b) => b.map((x) => x.textContent ?? ''));
    const label = labels.find((l) => l.startsWith(startsWith));
    if (label === undefined) throw new Error(`no quick "${startsWith}" among ${JSON.stringify(labels)}`);
    await page.click(`#quick button:text-is("${label}")`);
  };
  const scanDal = async (page: Page): Promise<void> => {
    await page.keyboard.type('8901234567890');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#lines tr');
  };
  const nameMember = async (page: Page): Promise<void> => {
    await page.click('#more');
    await choose(page, 'Loyalty member');
    await keyDigits(page, '9840012345');
    expect((await shown(page)).text).toContain('••••2345');
  };

  it('Tender → Split: ₹100 points + ₹200 store credit + ₹200 cash (₹20 change) on a ₹480 bill; the box keeps the split under the member code; the same points cannot be spent twice', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-served-till-spends-'));
    dirs.push(dir);
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, PACK, 'utf8');
    await writeFile(join(dir, 'loyalty-wallets.json'), `${JSON.stringify(WALLETS)}\n`, 'utf8');
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_PACK_FILE: packFile,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '8090', EDGE_LANE_ID: 'lane-1', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
      ...await prepareTillBox({ dir, key: KEY, pack: JSON.parse(PACK) as Record<string, unknown> }),
    }, () => {}))!;
    stops.push(() => edge.stop());

    const context = await browser.newContext();
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/pos/`, { waitUntil: 'load' });
    await page.waitForFunction(() => {
      const w = globalThis as unknown as { posSession?: { hasCatalogue(): boolean } };
      return w.posSession !== undefined && w.posSession.hasCatalogue();
    }, undefined, { timeout: 15_000 });
    await signInThroughScreen(page);

    await nameMember(page);
    await scanDal(page);
    await page.click('#tender');
    await choose(page, 'Split / points / store credit');
    // What the member may spend here, and how old the store computer's copy is.
    const wallet = await shown(page);
    expect(wallet.text).toMatch(/••••2345: 100 points \(₹100\.00\), store credit ₹200\.00\. Balances as of /);
    // Points: up to ₹100 (one tap), then store credit up to ₹200, then cash — ₹200 note for the ₹180 left.
    expect(await options(page)).toEqual(expect.arrayContaining(['Points — up to ₹100.00', 'Store credit — up to ₹200.00']));
    await choose(page, 'Points');
    await quick(page, 'up to ₹100.00');
    await choose(page, 'Store credit');
    await quick(page, 'up to ₹200.00');
    expect((await page.textContent('#pay-title')) ?? '').toContain('₹180.00');
    await choose(page, 'Cash');
    await quick(page, '₹200.00');
    const paid = await shown(page);
    expect(paid.title).toContain('₹20.00'); // change due

    const saved = (await readLog(edge.log.path)).map((r) => JSON.parse((r as { record: string }).record) as { customerRef?: string; total: number; tenders: { kind: string; amount: { minor: number }; points?: number }[] });
    expect(saved).toHaveLength(1);
    expect(saved[0]!.customerRef).toBe(MEMBER);
    expect(saved[0]!.total).toBe(48_000);
    expect(saved[0]!.tenders.map((t) => [t.kind, t.amount.minor, t.points])).toEqual([['loyalty_points', 10_000, 100], ['store_credit', 20_000, undefined], ['cash', 18_000, undefined]]);
    expect(JSON.stringify(saved)).not.toContain('9840012345');

    // A second bill: the member has nothing left on this box, so points and store credit are not even offered.
    await nameMember(page);
    await scanDal(page);
    await page.click('#tender');
    await choose(page, 'Split / points / store credit');
    expect((await shown(page)).text).toMatch(/0 points \(₹0\.00\), store credit ₹0\.00/);
    const second = await options(page);
    expect(second.some((l) => l.startsWith('Points') || l.startsWith('Store credit'))).toBe(false);
    await page.click('#pay-cancel');

    // And a till that tries anyway (a stale screen) is refused by the store computer, before the disk.
    const refused = await page.evaluate(async () => {
      const w = globalThis as unknown as { posSession: { nextReceipt(): Promise<string>; tenderSplit(i: unknown): Promise<string> } };
      try {
        await w.posSession.tenderSplit({ saleId: 'S-again', receiptNumber: await w.posSession.nextReceipt(), atIsoUtc: new Date().toISOString(), parts: [{ kind: 'loyalty_points', amountMinor: 10_000 }, { kind: 'cash', amountMinor: 38_000 }] });
        return 'committed';
      } catch (e) { return (e as { laneMessage?: string }).laneMessage ?? String(e); }
    });
    expect(refused).toMatch(/0 point\(s\).*Nothing was saved/);
    expect(await readLog(edge.log.path)).toHaveLength(1);
  }, 90_000);
});
