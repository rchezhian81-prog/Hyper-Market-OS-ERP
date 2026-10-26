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
import { prepareTillBox, signInThroughScreen } from '../support/till-operator';
import { auditPage } from './lib/a11y-audit';

/**
 * **M13-FR-02 — the served till, in a real Chromium against a real store computer (no head office at all): a unit of a
 * batch that has since EXPIRED, returned against its bill and chosen "Good — back on the shelf", is held, and the cashier
 * is told to put it in the held bin — English and Tamil.**
 *
 *   • curd sold from batch B-OLD by its 2D code (the bill keeps the batch);
 *   • head office's expiry move puts B-OLD on a new signed pack; the store computer is stopped and started again on the same
 *     disk with it (a cold restart); the till page reloads from it;
 *   • More → Refund → the bill → the curd → "Good — back on the shelf" → Cash: "Refund recorded", with "past its date …
 *     held (quarantine) bin"; the box's disk says quarantine + expiredHeld + batch B-OLD;
 *   • the second unit, in Tamil: the Tamil words; the curd's 2D code of B-OLD is refused at the scan.
 * Screenshots only when SRE_SHOTS names a directory. Skips where no browser binary is present.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const SHOTS = process.env['SRE_SHOTS'];
const KEY = ['served', 'till', 'expired', 'return', 'key'].join('-').padEnd(48, '0');
const CURD = '8901000000026';
const TWO_D = `(01)0${CURD}(10)B-OLD`;

function signedCatalogue(version: number, expired: boolean) {
  const snapshot: CatalogueSnapshot = {
    tenantId: 't-sre', version, builtAt: new Date(Date.now() - (expired ? 0 : 60_000)).toISOString(),
    products: [{
      productId: 'p-curd', sku: 'CURD', name: 'Curd 400g', baseUom: 'ea', unitPriceMinor: 6_000, taxBps: 500, status: 'active', batchTracked: true,
      ...(expired ? { expiredBatches: [{ batchId: 'B-OLD', expiry: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10) }] } : {}),
    }],
    barcodes: [{ code: CURD, productId: 'p-curd', kind: 'standard' }],
  };
  const r = publishPack({ snapshot, approvals: [], signer: hmacSigner(KEY), publishedBy: 'u-hq', publishedAt: snapshot.builtAt });
  if (!r.ok || r.pack === undefined) throw new Error(r.detail);
  return r.pack;
}
const PACK = {
  version: 1,
  policies: { storeId: 'store-1', branchId: 'store-1', branchName: 'Main', tradingDayCutoff: '00:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, cashVarianceToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'wh-1' },
  // A refund this small needs no second person here, so the screen walks straight to the outcome.
  servicePolicy: { returnWindowDays: 30, approvalThresholdMinor: 100_000, noReceiptCapMinor: 100_000, agentAuthorityMinor: 0, compensationCapMinor: 0 },
  lossPreventionRules: [],
};

interface PosWindow { readonly posSession?: { hasCatalogue(): boolean; basket(): unknown[] } }

describe.skipIf(!HAVE_BROWSER)('the served till holds an expired batch coming back (M13-FR-02)', () => {
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

  const shows = (page: Page, panelId: string, titleId: string, has: string): Promise<unknown> => page.waitForFunction(
    `(() => { const p = document.getElementById(${JSON.stringify(panelId)}); const t = document.getElementById(${JSON.stringify(titleId)});`
    + ` return p !== null && !p.hidden && t !== null && (t.textContent || '').includes(${JSON.stringify(has)}); })()`,
    undefined, { timeout: 15_000 },
  );
  const shot = async (page: Page, name: string): Promise<void> => {
    if (SHOTS === undefined) return;
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  };
  const open = async (edge: EdgeProcess): Promise<Page> => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    stops.push(() => context.close());
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/pos/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession?.hasCatalogue() === true, undefined, { timeout: 15_000 });
    await signInThroughScreen(page);
    return page;
  };
  /** The refund against `receipt`, through the screen's own steps; `w` are the words of the language the till is in. */
  /** OB-390: the till asks how many only when more than one can come back; the reason is one tap; the amount starts at the
   *  line's value on the bill (shown on the how-is-it-given question), so nothing is keyed for it. */
  const refundOne = async (page: Page, receipt: string, w: { more: string; refund: string; find: string; which: string; howMany: string; why: string; condition: string; how: string }, asksHowMany: boolean): Promise<{ title: string; text: string }> => {
    await page.click('#more');
    await shows(page, 'pay', 'pay-title', w.more);
    await page.click(`#pay-kinds button:text-is("${w.refund}")`);
    await shows(page, 'sheet', 'sheet-title', w.find);
    await page.keyboard.type(receipt);
    await page.keyboard.press('Enter');
    await shows(page, 'pay', 'pay-title', w.which);
    await page.click('#pay-kinds button:first-child');
    if (asksHowMany) {
      await shows(page, 'sheet', 'sheet-title', w.howMany);
      await page.click('#sheet-ok');
    }
    await shows(page, 'sheet', 'sheet-title', w.why);
    await page.click('#reasons button:first-child');
    await shows(page, 'pay', 'pay-title', w.condition);
    await page.click('#pay-kinds button:first-child'); // Good — back on the shelf
    await shows(page, 'pay', 'pay-title', w.how);
    await page.click('#pay-kinds button:first-child'); // Cash
    await page.waitForSelector('#refusal:not([hidden])');
    return { title: (await page.textContent('#refusal-title')) ?? '', text: (await page.textContent('#refusal-text')) ?? '' };
  };

  it('a B-OLD unit sold before its batch expired comes back: held, and the cashier is told — after a cold restart, English and Tamil', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-served-expired-return-'));
    dirs.push(dir);
    await writeSignedPack(dir, signedCatalogue(3, false));
    const env = {
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_LANE_PORT: '0', EDGE_LANE_ID: 'lane-1',
      ...await prepareTillBox({ dir, key: KEY, pack: PACK, people: [{ userId: 'u-lanecash', displayName: 'Lane Cashier' }] }),
    };
    const edge = (await startEdge(env, () => {}))!;
    let page = await open(edge);

    // Two units of curd from batch B-OLD, by the 2D code on the pack — the bill keeps the batch.
    for (let n = 1; n <= 2; n += 1) {
      await page.keyboard.type(TWO_D);
      await page.keyboard.press('Enter');
      await page.waitForFunction((k) => ((globalThis as unknown as PosWindow).posSession!.basket() as { qty: number }[]).reduce((q, l) => q + l.qty, 0) === k, n);
    }
    await page.click('#tender');
    await page.waitForSelector('#pay-kinds button');
    await page.click('#pay-kinds button:first-child'); // Cash
    await page.waitForSelector('#quick button');
    await page.click('#quick button:first-child'); // Exact
    await expect.poll(async () => (await readLog(edge.log.path)).length, { timeout: 10_000 }).toBe(1);
    const [soldRec] = await readLog(edge.log.path);
    const sold = JSON.parse(soldRec?.ok === true ? soldRec.record : '{}') as { number: string; lines: { batchId?: string; quantityMinor: number }[] };
    expect(sold.lines.map((l) => l.batchId)).toEqual(sold.lines.map(() => 'B-OLD'));
    expect(sold.lines.reduce((n, l) => n + l.quantityMinor, 0)).toBe(2);

    // Head office's expiry move puts B-OLD on a new signed pack. The store computer is stopped and started again on the same
    // disk with it (a COLD restart), and the till page reloads from it.
    await edge.stop();
    await writeSignedPack(dir, signedCatalogue(4, true));
    const back = (await startEdge(env, () => {}))!;
    stops.push(() => back.stop());
    page = await open(back);

    const en = { more: 'More', refund: 'Refund', find: 'Scan the receipt, or key the bill number', which: 'Which item is coming back?', howMany: 'How many are coming back?', why: 'Why is it coming back?', condition: 'What condition is the item in?', how: 'How is the refund given?' };
    const said = await refundOne(page, sold.number, en, true); // two on the bill: how many is asked
    expect(said.title).toContain('Refund recorded');
    expect(said.text).toContain('1 item(s) are from a batch past its date. Do not put them back on the shelf — put them in the held (quarantine) bin.');
    expect(await auditPage(page, { expectLang: 'en' }), 'the refund outcome').toEqual([]);
    await shot(page, 'till-expired-return-held');
    await page.click('#refusal-ok');
    await expect.poll(async () => (await readLog(back.returnsLog.path)).length, { timeout: 10_000 }).toBe(1);
    const [ret] = await readLog(back.returnsLog.path);
    expect((JSON.parse(ret?.ok === true ? ret.record : '{}') as { lines: unknown[] }).lines).toEqual([
      { productId: 'p-curd', uom: 'ea', quantityMinor: 1, disposition: 'quarantine', batchId: 'B-OLD', expiredHeld: true, chosenDisposition: 'resell' },
    ]);

    // The second unit, in Tamil.
    await page.click('#lang');
    const ta = { more: 'மேலும்', refund: 'திரும்பப் பணம்', find: 'ரசீதை ஸ்கேன் செய்யவும்', which: 'எந்தப் பொருள் திரும்புகிறது?', howMany: 'எத்தனை திரும்புகின்றன?', why: 'ஏன் திரும்புகிறது?', condition: 'பொருளின் நிலை என்ன?', how: 'திரும்பப் பணம் எப்படித் தரப்படுகிறது?' };
    const saidTa = await refundOne(page, sold.number, ta, false); // one left: nothing to ask
    expect(saidTa.text).toContain('காலாவதியான தொகுதியைச் சேர்ந்தவை');
    await shot(page, 'till-expired-return-held-ta');
    await page.click('#refusal-ok');
    await expect.poll(async () => (await readLog(back.returnsLog.path)).length, { timeout: 10_000 }).toBe(2);

    // And the same batch's 2D code is now refused at the scan, offline — the served page carries the expired set.
    await page.keyboard.type(TWO_D);
    await page.keyboard.press('Enter');
    await page.waitForSelector('#refusal:not([hidden])');
    expect(await page.textContent('#refusal-text')).toContain('past its use-by date');
    expect(await page.evaluate(() => (globalThis as unknown as PosWindow).posSession!.basket().length)).toBe(0);
  }, 90_000);
});
