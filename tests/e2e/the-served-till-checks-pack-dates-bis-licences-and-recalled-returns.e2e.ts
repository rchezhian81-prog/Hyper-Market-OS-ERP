import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { writeSignedPack } from '../../edge/store-edge/src/signed-pack-file';
import { hmacSigner, publishPack } from '../../services/catalogue/src/index';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import { prepareTillBox, signInThroughScreen, pinOf } from '../support/till-operator';
import { auditPage } from './lib/a11y-audit';

/**
 * **The served till, in a real Chromium against a real store computer (no head office at all): B8 · OB-298 the pack date
 * of a perishable confirmed with ONE tap before the line is added; B12 · OB-325 a BIS-controlled item whose licence ran
 * out refused in words; M13-FR-02 a recalled item returned at the till held, never put back for sale.**
 *
 *   • milk (perishable, plain barcode) → the big-button question "Is it still in date today?" in English and Tamil; the
 *     item is NOT on the bill while it is open; **No** → not sold, said; **Yes** → on the bill; a second pack is asked
 *     again; the sale lands on the box's disk with who confirmed each pack's date, and the "no" kept as evidence;
 *   • packaged water whose BIS licence ran out → "Cannot be sold" with the licence and its last day named; nothing added;
 *   • a no-receipt return of the recalled ghee, chosen "resell" → the box's disk says quarantine (held).
 * Screenshots only when SRE_SHOTS names a directory. Skips where no browser binary is present.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const SHOTS = process.env['SRE_SHOTS'];
const KEY = ['served', 'till', 'pack', 'date', 'key'].join('-').padEnd(48, '0');
const MILK = '8902000000017';
const WATER = '8901000000028';
const GHEE = '8901234567890';

function signedCatalogue() {
  const snapshot: CatalogueSnapshot = {
    tenantId: 't-sre', version: 3, builtAt: new Date().toISOString(),
    products: [
      { productId: 'p-milk', sku: 'MILK', name: 'Milk 500ml', baseUom: 'ea', unitPriceMinor: 3_000, taxBps: 0, status: 'active', regulatedFlags: { perishable: true } },
      { productId: 'p-water', sku: 'WATER', name: 'Drinking water 1L', baseUom: 'ea', unitPriceMinor: 2_000, taxBps: 1_800, status: 'active', regulatedFlags: { bisControlled: true, bisLicenceNo: 'CM/L-1111111111', bisLicenceValidUntil: '2020-03-31' } },
      { productId: 'p-ghee', sku: 'GHEE', name: 'Ghee 1L', baseUom: 'ea', unitPriceMinor: 64_000, taxBps: 1_200, status: 'active', recallBlock: true },
    ],
    barcodes: [{ code: MILK, productId: 'p-milk', kind: 'standard' }, { code: WATER, productId: 'p-water', kind: 'standard' }, { code: GHEE, productId: 'p-ghee', kind: 'standard' }],
  };
  const r = publishPack({ snapshot, approvals: [], signer: hmacSigner(KEY), publishedBy: 'u-hq', publishedAt: snapshot.builtAt });
  if (!r.ok || r.pack === undefined) throw new Error(r.detail);
  return r.pack;
}
const PACK = {
  version: 1,
  policies: { storeId: 'store-1', branchId: 'store-1', branchName: 'Main', tradingDayCutoff: '00:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, cashVarianceToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'wh-1' },
  servicePolicy: { returnWindowDays: 30, approvalThresholdMinor: 0, noReceiptCapMinor: 100_000, agentAuthorityMinor: 0, compensationCapMinor: 0 },
  lossPreventionRules: [],
};

interface PosWindow { readonly posSession?: { hasCatalogue(): boolean; basket(): unknown[] } }
interface Doc { readonly document: { querySelector(selector: string): { hidden: boolean } | null } }

describe.skipIf(!HAVE_BROWSER)('the served till checks pack dates, BIS licences and recalled returns', () => {
  let browser: Browser;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'pos'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 120_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function till(): Promise<{ edge: EdgeProcess; page: Page }> {
    const dir = await mkdtemp(join(tmpdir(), 'sre-served-pack-date-'));
    dirs.push(dir);
    await writeSignedPack(dir, signedCatalogue());
    const edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_LANE_PORT: '0', EDGE_LANE_ID: 'lane-1',
      ...await prepareTillBox({ dir, key: KEY, pack: PACK, people: [{ userId: 'u-lanecash', displayName: 'Lane Cashier' }, { userId: 'u-mgr', displayName: 'Manager', manager: true }] }),
    }, () => {}))!;
    stops.push(() => edge.stop());
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    stops.push(() => context.close());
    const page = await context.newPage();
    page.setDefaultTimeout(8_000);
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/pos/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession?.hasCatalogue() === true, undefined, { timeout: 15_000 });
    await signInThroughScreen(page);
    return { edge, page };
  }
  const scan = async (page: Page, code: string): Promise<void> => { await page.keyboard.type(code); await page.keyboard.press('Enter'); };
  const lines = (page: Page): Promise<number> => page.evaluate(() => (globalThis as unknown as PosWindow).posSession!.basket().length);
  const panelOpen = (page: Page, id: string): Promise<unknown> => page.waitForFunction((i) => !((globalThis as unknown as Doc).document.querySelector(`#${i}`) as { hidden: boolean }).hidden, id);
  const shot = async (page: Page, name: string): Promise<void> => {
    if (SHOTS === undefined) return;
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  };

  it('B8: one tap on the pack date before the milk joins the bill; No is not sold; the sale lands with who looked', async () => {
    const { edge, page } = await till();
    await scan(page, MILK);
    await panelOpen(page, 'pay');
    expect(await page.textContent('#pay-title')).toBe('Milk 500ml is perishable. Look at the use-by / expiry date printed on the pack. Is it still in date today?');
    expect(await page.$$eval('#pay-kinds button', (b) => b.map((x) => x.textContent))).toEqual(['Yes — date is good', 'No — past its date, do not sell']);
    // Icons beside the words, and the buttons big enough for a busy counter.
    expect(await page.$$eval('#pay-kinds button', (b) => b.every((x) => x.querySelector('svg') !== null))).toBe(true);
    expect(await lines(page), 'not on the bill while the question is open').toBe(0);
    expect(await auditPage(page, { expectLang: 'en' }), 'the pack-date question').toEqual([]);
    await shot(page, 'till-pack-date-question');
    await page.click('#pay-kinds button:nth-child(2)'); // No
    await panelOpen(page, 'refusal');
    expect(await page.textContent('#refusal-title')).toBe('Item not sold');
    expect(await page.textContent('#refusal-text')).toContain('was not added to the bill');
    await page.click('#refusal-ok');
    expect(await lines(page)).toBe(0);

    for (let n = 1; n <= 2; n += 1) {
      await scan(page, MILK);
      await panelOpen(page, 'pay');
      await page.click('#pay-kinds button:first-child'); // Yes — date is good
      await page.waitForFunction((k) => (globalThis as unknown as PosWindow).posSession!.basket().length === k, n);
    }
    await page.click('#tender');
    await page.waitForSelector('#pay-kinds button');
    await page.click('#pay-kinds button:first-child'); // Cash
    await page.waitForSelector('#quick button');
    await page.click('#quick button:first-child'); // Exact
    await expect.poll(async () => (await readLog(edge.log.path)).length, { timeout: 10_000 }).toBe(1);
    const [first] = await readLog(edge.log.path);
    const saved = JSON.parse(first?.ok === true ? first.record : '{}') as { lines: { packDateCheck?: { confirmedBy: string } }[]; packDateAnswers: { outcome: string; by: string }[] };
    expect(saved.lines.map((l) => l.packDateCheck?.confirmedBy)).toEqual(['u-lanecash', 'u-lanecash']);
    expect(saved.packDateAnswers.map((a) => a.outcome)).toEqual(['out_of_date', 'in_date', 'in_date']);
  });

  it('B8 in Tamil; B12: water whose BIS licence ran out is refused in words; Cancel adds nothing', async () => {
    const { page } = await till();
    await page.click('#lang');
    await scan(page, MILK);
    await panelOpen(page, 'pay');
    expect(await page.textContent('#pay-title')).toContain('விரைவில் கெடும் பொருள்');
    expect(await page.$$eval('#pay-kinds button', (b) => b.map((x) => x.textContent))).toEqual(['ஆம் — தேதி சரி', 'இல்லை — தேதி கடந்துவிட்டது, விற்க வேண்டாம்']);
    await shot(page, 'till-pack-date-question-ta');
    await page.click('#pay-cancel');
    expect(await lines(page)).toBe(0);
    await page.click('#lang');

    await scan(page, WATER);
    await panelOpen(page, 'refusal');
    expect(await page.textContent('#refusal-title')).toBe('Cannot be sold');
    expect(await page.textContent('#refusal-text')).toBe('Drinking water 1L: its BIS (ISI mark) licence CM/L-1111111111 ran out on 2020-03-31. It cannot be sold — keep it off the bill and tell the manager.');
    await shot(page, 'till-bis-licence-ran-out');
    await page.click('#refusal-ok');
    expect(await lines(page)).toBe(0);
  });

  it('M13-FR-02: a recalled item returned at the served till, chosen "resell", is held on the box', async () => {
    const { edge, page } = await till();
    const outcome = await page.evaluate(async (pin) => {
      const s = (globalThis as unknown as { posSession: {
        approveAtTill(r: Record<string, unknown>): Promise<{ approved: boolean; approvalId?: string; approvedBy?: string }>;
        nextReceipt(): Promise<string>;
        noReceiptReturn(): { submit(d: Record<string, unknown>): Promise<{ kind: string }> } | null;
      } }).posSession;
      const a = await s.approveAtTill({ managerId: 'u-mgr', pin, kind: 'no_receipt_return', valueMinor: 64_000, reason: 'faulty' });
      const desk = s.noReceiptReturn();
      return desk!.submit({
        returnId: 'RT-E2E-1', number: await s.nextReceipt(), reasonCode: 'faulty', refundMinor: 64_000, refundTender: 'cash',
        approval: { by: a.approvedBy, reason: 'faulty', approvalId: a.approvalId },
        lines: [{ productId: 'p-ghee', uom: 'ea', quantityMinor: 1, disposition: 'resell' }],
      });
    }, pinOf('u-mgr'));
    expect(outcome.kind).toBe('settled');
    const [ret] = await readLog(edge.returnsLog.path);
    expect((JSON.parse(ret?.ok === true ? ret.record : '{}') as { lines: unknown[] }).lines).toEqual([
      { productId: 'p-ghee', uom: 'ea', quantityMinor: 1, disposition: 'quarantine', recallHeld: true, chosenDisposition: 'resell' },
    ]);
  });
});
