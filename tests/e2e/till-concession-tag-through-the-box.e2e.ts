import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';

/**
 * **The till's concession-tag panel, in a real browser, saving to the STORE BOX offline (M27-FR-03 · Item 3 · §31).**
 *
 * ONE edge process serves the real POS pages and owns the loopback write socket; **no cloud is configured, so
 * the box is offline** — the case the panel exists to work in. A real Chromium opens the served panel, a
 * cashier fills in a partner-counter docket line and clicks **Record line**. That drives, in one real browser:
 *   - the cross-origin POST to `/lane/concession-tags` (the page's port → the socket's port), authorised as a
 *     loopback caller (RR-F01);
 *   - the durable-first write to the box's OWN concession-tags log, and the queue for the cloud's synced route;
 *   - the panel's honest words: "saved on the store computer … reaches head office when the connection is up";
 *   - and that an incomplete line is refused on the page — nothing reaches the box.
 *
 * It proves the till's offline-first hop rather than asserting it. Skips where no browser binary is present.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['served', 'till', 'tags', 'pc', 'signing', 'key'].join('-').padEnd(48, '0');

describe.skipIf(!HAVE_BROWSER)('the served concession-tag panel saves a docket line to the store box, offline', () => {
  let browser: Browser;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 60_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    for (const stop of stops.splice(0)) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  const openPanel = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-served-tags-'));
    dirs.push(dir);
    // The edge exactly as a one-PC install runs it, with NO cloud configured — the offline case.
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
    }, () => {}))!;
    stops.push(() => edge.stop());
    const context = await browser.newContext();
    stops.push(() => context.close());
    const page = await context.newPage();
    // The panel is told where the box's write socket listens (`?lane=`), as the shell would tell it.
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/pos/concession-tag.html?lane=${edge.lane!.port}`, { waitUntil: 'load' });
    return { edge, page };
  };

  const fillLine = async (page: import('playwright-core').Page, over: Record<string, string> = {}) => {
    const values: Record<string, string> = {
      capturedBy: 'cashier-anita', tillId: 'till-1', saleId: 'S-77', concessionaireId: 'jeweller-1', counterId: 'counter-gold',
      productId: 'ring-22k', qty: '1', grossMinor: '100000', discountMinor: '0', taxMinor: '3000', source: 'docket-8842', ...over,
    };
    for (const [id, v] of Object.entries(values)) await page.fill(`#${id}`, v);
  };

  it('a cashier\'s docket line lands on this box\'s concession-tags log and is queued for head office — and the page says so', async () => {
    const { edge, page } = await openPanel();
    await fillLine(page);
    await page.click('#record');
    await page.waitForFunction(() => (globalThis as unknown as { document: { getElementById(id: string): { textContent: string | null } | null } }).document.getElementById('status')?.textContent?.includes('Saved') === true, undefined, { timeout: 10_000 });

    // Durable on THIS box's own log, as the till wrote it — the cashier named as author, the partner named.
    const records = await readLog(edge.concessionTagsLog.path);
    expect(records).toHaveLength(1);
    const saved = records[0]?.ok === true ? JSON.parse(records[0].record) as Record<string, unknown> : undefined;
    expect(saved).toMatchObject({ tagId: 'till-1:S-77:line-1', saleId: 'S-77', lineId: 'line-1', concessionaireId: 'jeweller-1', capturedBy: 'cashier-anita', byRole: 'cashier', grossMinor: 100_000, source: 'docket-8842' });
    // Queued once for the cloud's synced route — offline-first, not lost; the other queues untouched.
    expect(edge.concessionTagsOutbox.unsentCount()).toBe(1);
    expect(edge.outbox.unsentCount()).toBe(0);
    expect(edge.returnsOutbox.unsentCount()).toBe(0);
    // The page shows the line as saved, with its gross and net, and says where it is.
    expect(await page.locator('#rows tr').count()).toBe(1);
    expect(await page.locator('#rows tr').first().innerText()).toContain('till-1:S-77:line-1');
    expect(await page.locator('#t-net').innerText()).toBe('100000');
    expect(await page.locator('#status').innerText()).toContain('store computer');

    // A second line on the same bill takes the next line id — a different tag, recorded once more.
    await page.fill('#productId', 'chain-22k');
    await page.fill('#grossMinor', '50000');
    await page.click('#record');
    await page.waitForFunction(() => (globalThis as unknown as { document: { querySelectorAll(s: string): { length: number } } }).document.querySelectorAll('#rows tr').length === 2, undefined, { timeout: 10_000 });
    expect((await readLog(edge.concessionTagsLog.path)).map((r) => (r.ok ? (JSON.parse(r.record) as { tagId: string }).tagId : ''))).toEqual(['till-1:S-77:line-1', 'till-1:S-77:line-2']);
    expect(edge.concessionTagsOutbox.unsentCount()).toBe(2);
  });

  it('an incomplete line is refused on the page — nothing reaches the box', async () => {
    const { edge, page } = await openPanel();
    await fillLine(page, { concessionaireId: '' });
    await page.click('#record');
    await page.waitForFunction(() => (globalThis as unknown as { document: { getElementById(id: string): { textContent: string | null } | null } }).document.getElementById('status')?.textContent?.includes('concessionaireId') === true, undefined, { timeout: 10_000 });
    expect(await readLog(edge.concessionTagsLog.path)).toHaveLength(0);
    expect(edge.concessionTagsOutbox.unsentCount()).toBe(0);
  });
});
