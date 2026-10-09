import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { prepareTillBox, signInOnPage } from '../support/till-operator';

/**
 * **PF-06 in a real browser, through the till's own buttons — the card machine that never answered (Wave 4 ·
 * M12-FR-03).**
 *
 * The cashier taps Tender → Card: the attempt is on the store computer's disk before the machine question appears. The
 * machine "has not answered": the screen says do not hand over the goods, and the no-answer is on the disk. Tender →
 * Card again: the screen does NOT offer the machine — it offers to check that payment with the provider, and (no provider
 * connected in this build) says so and that the card must not be run again. Then an approved card payment on a NEW
 * basket goes through and carries its reference. Skips where no browser binary is present.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['served', 'till', 'card', 'attempt', 'key'].join('-').padEnd(48, '0');

interface PosWindow {
  readonly posSession?: {
    scan(item: { productId: string; description: string; unitPriceMinor: number; qty: number }): void;
    newSale(): void;
  };
}
type Doc = { document: { querySelector(s: string): { textContent: string | null; hidden?: boolean } | null } };

describe.skipIf(!HAVE_BROWSER)('the served till records a card payment before the machine is asked (audit PF-06)', () => {
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

  const pick = async (page: Page, label: RegExp): Promise<void> => {
    await page.waitForSelector('#pay:not([hidden])', { timeout: 5_000 });
    await page.locator('#pay-kinds button', { hasText: label }).first().click();
  };
  const notice = async (page: Page): Promise<string> => {
    await page.waitForSelector('#refusal:not([hidden])', { timeout: 5_000 });
    const text = (await page.locator('#refusal-text').textContent()) ?? '';
    await page.click('#refusal-ok');
    return text;
  };

  it('no answer → kept on the disk → the screen offers a check, not the machine → an approved payment carries its reference', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-served-till-card-'));
    dirs.push(dir);
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '8090', EDGE_LANE_ID: 'lane-1', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
      ...await prepareTillBox({ dir, key: KEY }),
    }, () => {}))!;
    stops.push(() => edge.stop());
    const context = await browser.newContext();
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/pos/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession !== undefined, undefined, { timeout: 15_000 });
    await signInOnPage(page);
    await page.evaluate(() => (globalThis as unknown as PosWindow).posSession!.scan({ productId: 'P1', description: 'Ghee 1L', unitPriceMinor: 64_000, qty: 1 }));
    const attempts = async () => (await readLog(join(dir, 'payment-attempts.log'))).flatMap((r) => (r.ok ? [JSON.parse(r.record) as { kind: string; outcome?: string; attemptId: string }] : []));

    // Tender → Card: the attempt is on the disk BEFORE the machine question is answered.
    await page.click('#tender');
    await pick(page, /^Card/);
    await page.waitForFunction(() => /What did the card machine say/.test((globalThis as unknown as Doc).document.querySelector('#pay-title')?.textContent ?? ''), undefined, { timeout: 5_000 });
    expect((await attempts()).map((a) => a.kind)).toEqual(['asked']);
    await pick(page, /It has not answered/);
    expect(await notice(page)).toMatch(/do not hand over the goods/);
    expect((await attempts()).map((a) => a.outcome ?? a.kind)).toEqual(['asked', 'no_answer']);

    // Tender → Card again: the machine is NOT offered. A check is — and with no provider connected, it says so.
    await page.click('#tender');
    await pick(page, /^Card/);
    await page.waitForFunction(() => /Do not ask the machine again/.test((globalThis as unknown as Doc).document.querySelector('#pay-title')?.textContent ?? ''), undefined, { timeout: 5_000 });
    await pick(page, /Check that payment/);
    expect(await notice(page)).toMatch(/No payment provider is connected.*Do not run the card again/);
    expect(await readLog(edge.log.path)).toHaveLength(0); // no sale, no goods handed over

    // A new basket (new bill): approved on the machine → the sale lands with the payment's reference.
    await page.evaluate(() => {
      const w = globalThis as unknown as PosWindow;
      w.posSession!.newSale();
      w.posSession!.scan({ productId: 'P2', description: 'Sugar 1kg', unitPriceMinor: 5_000, qty: 1 });
    });
    await page.click('#tender');
    await pick(page, /^Card/);
    await pick(page, /^Approved$/);
    expect(await notice(page)).toMatch(/R-lane-1-/);
    const sold = (await readLog(edge.log.path)).flatMap((r) => (r.ok ? [JSON.parse(r.record) as { tenders: { kind: string; ref?: string }[] }] : []));
    const approvedAttempt = (await attempts()).filter((a) => a.outcome === 'approved').map((a) => a.attemptId);
    expect(sold).toHaveLength(1);
    expect(sold[0]!.tenders).toEqual([expect.objectContaining({ kind: 'card', ref: approvedAttempt[0] })]);
  });
});
