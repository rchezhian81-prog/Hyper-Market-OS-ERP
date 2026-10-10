import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';

/**
 * **PF-13 in a real browser: a partner counter whose agreement lapsed is stopped on the served concession-tag panel,
 * with the cable out, before money changes hands (M27-FR-04).**
 *
 * The store computer holds the counters' agreement terms as it last pulled them (restored from its disk; no cloud is
 * configured). In real Chromium the cashier records a docket line for the silver counter, whose insurance has lapsed:
 * the panel shows the store computer's words — the counter may not trade, do not take money — and nothing reaches the
 * box's log. The gold counter, in date, saves as before.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['served', 'tags', 'pf13', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = 't-sre';
const year = new Date().getUTCFullYear();
const TERMS = {
  feed: {
    tenantId: TENANT, generatedAt: new Date(Date.now() - 3_600_000).toISOString(),
    contracts: [
      { contractId: 'ct-gold', concessionaireId: 'jeweller-1', branchId: 'br-1', startsOn: `${year - 1}-01-01`, endsOn: `${year + 1}-12-31`, insuranceUntil: `${year + 1}-06-30`, approved: true, active: true },
      { contractId: 'ct-silver', concessionaireId: 'silver-1', branchId: 'br-1', startsOn: `${year - 1}-01-01`, endsOn: `${year + 1}-12-31`, insuranceUntil: `${year - 1}-12-31`, approved: true, active: true },
    ],
  },
  receivedAt: new Date().toISOString(),
};

describe.skipIf(!HAVE_BROWSER)('a lapsed partner counter is refused on the served concession-tag panel, offline (PF-13)', () => {
  let browser: Browser;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => { browser = await chromium.launch({ headless: true, executablePath: CHROMIUM }); }, 60_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  const fill = async (page: Page, concessionaireId: string, saleId: string): Promise<void> => {
    const values: Record<string, string> = {
      capturedBy: 'cashier-anita', tillId: 'till-1', saleId, concessionaireId, counterId: `counter-${concessionaireId}`,
      productId: 'item-1', qty: '1', grossMinor: '50000', discountMinor: '0', taxMinor: '1500', source: 'docket-1',
    };
    for (const [id, v] of Object.entries(values)) await page.fill(`#${id}`, v);
  };
  const statusSays = (page: Page, text: string) => page.waitForFunction(
    (t) => (globalThis as unknown as { document: { getElementById(id: string): { textContent: string | null } | null } }).document.getElementById('status')?.textContent?.includes(t) === true,
    text, { timeout: 10_000 },
  );

  it('the silver counter (insurance lapsed) is refused in the store computer\'s words and nothing is saved; the gold counter saves', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-pf13-panel-'));
    dirs.push(dir);
    await writeFile(join(dir, 'concession-trading.json'), `${JSON.stringify(TERMS)}\n`, 'utf8');
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
    }, () => {}))!;
    stops.push(() => edge.stop());
    const context = await browser.newContext();
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/pos/concession-tag.html?lane=${edge.lane!.port}`, { waitUntil: 'load' });

    await fill(page, 'silver-1', 'S-1');
    await page.click('#record');
    await statusSays(page, 'may not trade');
    const said = (await page.locator('#status').innerText());
    expect(said).toMatch(/insurance is not in date/);
    expect(said).toMatch(/Do not take money/);
    expect(await readLog(edge.concessionTagsLog.path)).toHaveLength(0);
    expect(edge.concessionTagsOutbox.unsentCount()).toBe(0);

    await fill(page, 'jeweller-1', 'S-2');
    await page.click('#record');
    await statusSays(page, 'Saved');
    expect(await readLog(edge.concessionTagsLog.path)).toHaveLength(1);
  }, 60_000);
});
