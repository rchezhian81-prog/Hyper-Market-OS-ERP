import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { prepareTillBox, signInThroughScreen } from '../support/till-operator';
import { readLog } from '../../edge/store-edge/src/file-log';
import { auditPage } from './lib/a11y-audit';

/**
 * **The till asks the age question before an age-restricted item joins the bill — in a real browser, on the served
 * screen, with the sale landing on the store computer's disk (M12-FR-04 · Wave 2b · audit PF-03).**
 *
 * The audit's finding was that the served scan handler threw the "age check required" answer away. This drives a real
 * Chromium against a REAL store computer (one edge process serves the till and owns the lane socket, as a shop PC does)
 * whose pack carries a cigarette pack restricted to 18+:
 *
 *   • the cashier scans it → the big-button question appears ("Is the customer 18 or over?") and the item is NOT on the
 *     bill; **No — do not sell** → nothing added, the screen says it was not sold;
 *   • scanned again → **Yes — ID checked** → the item is on the bill; a second scan of the same item is not asked again
 *     (the same customer); the sale is taken in cash and lands on the box's disk carrying, on that line, the age it
 *     needed and the signed-in cashier who confirmed it — and the refusal earlier, as evidence;
 *   • the question is in Tamil when the till is, and the panel passes the in-browser accessibility audit.
 *
 * Screenshots for the owner are written only when SRE_SHOTS names a directory. Skips where no browser binary is present.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const SHOTS = process.env['SRE_SHOTS'];
const KEY = ['age', 'question', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = 't-sre';
const CIG = '8900000000028';
const RICE = '8901234567890';

/** A store pack with one ordinary item and one restricted to 18+ (synthetic). */
const PACK = JSON.stringify({
  version: 1,
  policies: { tradingDayCutoff: '02:00', storeId: 'store-1' },
  lossPreventionRules: [],
  products: [
    { productId: 'P1', name: 'Toor dal 1kg', categoryId: 'grocery', unitPriceMinor: 16_000, uom: 'ea', barcodes: [RICE], availableMinor: 100, taxBps: 0, status: 'active' },
    { productId: 'P-CIG', name: 'Cigarettes 10s (demo)', categoryId: 'tobacco', unitPriceMinor: 18_000, uom: 'ea', barcodes: [CIG], availableMinor: 50, taxBps: 2800, status: 'active', ageRestricted: true },
  ],
});

interface PosWindow { readonly posSession?: { hasCatalogue(): boolean; operator(): string | undefined; basket(): unknown[] } }
interface Doc { readonly document: { querySelector(selector: string): { hidden: boolean; textContent: string | null } | null } }

describe.skipIf(!HAVE_BROWSER)('the till asks the age question on the served screen (PF-03)', () => {
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
    const dir = await mkdtemp(join(tmpdir(), 'sre-age-question-'));
    dirs.push(dir);
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, PACK, 'utf8');
    const edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_PACK_FILE: packFile,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_LANE_PORT: '8090', EDGE_LANE_ID: 'lane-1',
      ...await prepareTillBox({ dir, key: KEY, pack: JSON.parse(PACK) as Record<string, unknown> }),
    }, () => {}))!;
    stops.push(() => edge.stop());
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/pos/`, { waitUntil: 'load' });
    await page.waitForFunction(() => { const w = globalThis as unknown as PosWindow; return w.posSession !== undefined && w.posSession.hasCatalogue(); }, undefined, { timeout: 15_000 });
    // The cashier signs in for the shift (SP-4b): the answer to the age question is given in their name.
    await signInThroughScreen(page); // staff ID, then the till PIN — checked by the box (ADR-0020)
    return { edge, page };
  }
  const scan = async (page: Page, code: string): Promise<void> => { await page.keyboard.type(code); await page.keyboard.press('Enter'); };
  const lines = (page: Page): Promise<number> => page.evaluate(() => (globalThis as unknown as PosWindow).posSession!.basket().length);
  const shot = async (page: Page, name: string): Promise<void> => {
    if (SHOTS === undefined) return;
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  };

  it('asks before the item joins the bill; No adds nothing; Yes adds it once; the sale lands with who checked, and the refusal kept', async () => {
    const { edge, page } = await till();

    // ── the question, and "No" ──────────────────────────────────────────────────────────────────────────────────
    await scan(page, CIG);
    await page.waitForFunction(() => !((globalThis as unknown as Doc).document.querySelector('#pay') as { hidden: boolean }).hidden);
    expect(await page.textContent('#pay-title')).toBe('Cigarettes 10s (demo) is age restricted. Check the customer\'s identification. Is the customer 18 or over?');
    expect(await page.$$eval('#pay-kinds button', (b) => b.map((x) => x.textContent))).toEqual(['Yes — ID checked, 18 or over', 'No — do not sell']);
    expect(await lines(page), 'the item is NOT on the bill while the question is open').toBe(0);
    expect(await auditPage(page, { expectLang: 'en' }), 'the age question panel').toEqual([]);
    await shot(page, 'till-age-question');
    await page.click('#pay-kinds button:nth-child(2)'); // No — do not sell
    await page.waitForFunction(() => !((globalThis as unknown as Doc).document.querySelector('#refusal') as { hidden: boolean }).hidden);
    expect(await page.textContent('#refusal-title')).toBe('Item not sold');
    expect(await page.textContent('#refusal-text')).toContain('was not added to the bill');
    expect(await lines(page)).toBe(0);
    await page.click('#refusal-ok');

    // ── the question again, and "Yes" ───────────────────────────────────────────────────────────────────────────
    await scan(page, RICE);
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession!.basket().length === 1);
    await scan(page, CIG);
    await page.waitForFunction(() => !((globalThis as unknown as Doc).document.querySelector('#pay') as { hidden: boolean }).hidden);
    await page.click('#pay-kinds button:first-child'); // Yes — ID checked
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession!.basket().length === 2);
    // The same customer: a second pack is not asked again.
    await scan(page, CIG);
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession!.basket().length === 3);
    expect(await page.isHidden('#pay')).toBe(true);
    expect(await page.textContent('#total')).toBe('₹520.00');

    // ── take cash; the sale lands on the box's disk with its evidence ─────────────────────────────────────────────
    await page.click('#tender');
    await page.waitForSelector('#pay-kinds button');
    await page.click('#pay-kinds button:first-child'); // Cash
    await page.waitForSelector('#quick button');
    await page.click('#quick button:first-child'); // Exact
    await expect.poll(async () => (await readLog(edge.log.path)).length, { timeout: 10_000 }).toBe(1);
    const [first] = await readLog(edge.log.path);
    if (first?.ok !== true) throw new Error('the sale did not land on the box');
    const saved = JSON.parse(first.record) as { cashierId: string; lines: { productId: string; quantityMinor: number; ageCheck?: Record<string, unknown> }[]; ageAnswers: { outcome: string; minimumAge: number; by: string }[] };
    expect(saved.cashierId).toBe('u-lanecash');
    const cigLines = saved.lines.filter((l) => l.productId === 'P-CIG');
    expect(cigLines).toHaveLength(2);
    for (const l of cigLines) expect(l.ageCheck).toMatchObject({ minimumAge: 18, confirmedAtLeast: 18, confirmedBy: 'u-lanecash' });
    expect(saved.lines.find((l) => l.productId === 'P1')?.ageCheck).toBeUndefined();
    expect(saved.ageAnswers.map((a) => [a.outcome, a.minimumAge, a.by])).toEqual([['refused', 18, 'u-lanecash'], ['confirmed', 18, 'u-lanecash']]);
    // Queued for head office too — the box queues it a moment AFTER the disk write the poll above saw, so wait for it.
    await expect.poll(() => edge.outbox.unsentCount(), { timeout: 10_000 }).toBe(1);
  });

  it('the question is in Tamil when the till is, and Cancel adds nothing and records nothing', async () => {
    const { page } = await till();
    await page.click('#lang');
    await scan(page, CIG);
    await page.waitForFunction(() => !((globalThis as unknown as Doc).document.querySelector('#pay') as { hidden: boolean }).hidden);
    expect(await page.textContent('#pay-title')).toContain('வயது வரம்புள்ள பொருள்');
    expect(await page.textContent('#pay-title')).toContain('18');
    expect(await page.$$eval('#pay-kinds button', (b) => b.map((x) => x.textContent))).toEqual(['ஆம் — அடையாளம் சரிபார்க்கப்பட்டது, 18 அல்லது அதற்கு மேல்', 'இல்லை — விற்க வேண்டாம்']);
    // The scanner's Enter did not also press the language button the cashier had just tapped (it would flip the till
    // back to English mid-question) — the whole panel, Cancel included, stays in Tamil.
    expect(await page.textContent('#pay-cancel')).toBe('ரத்து');
    expect(await page.textContent('#tender')).toBe('பணம் பெறு');
    await shot(page, 'till-age-question-ta');
    await page.click('#pay-cancel');
    expect(await lines(page)).toBe(0);
    expect(await page.evaluate(() => (globalThis as unknown as { posSession: { ageConfirmedAtLeast(): number } }).posSession.ageConfirmedAtLeast())).toBe(0);
  });
});

