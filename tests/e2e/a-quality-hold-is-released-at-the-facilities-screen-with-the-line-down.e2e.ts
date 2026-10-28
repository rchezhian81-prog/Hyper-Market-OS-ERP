import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { writeHeldWorkFeeds } from '../../edge/store-edge/src/work-feeds-file';

/**
 * **OB-333 — a quality-hold release at the facilities screen with the line down, in a real browser on the REAL store box.**
 *
 * The box starts with NO cloud and with head office's held batches restored from its own disk. At the actual screen a
 * person with the quality-release right sees the batches on hold (as the box last heard, and when), releases one — refused
 * first, in words, with nothing checked written down — and the release reaches the box's fsync'd device-events log in
 * their name. A person WITHOUT the right sees the batches and no release button. Nothing on the screen places a hold.
 * A reload sends nothing twice. Head office re-checking the person and booking it once is proven by
 * tests/integration/a-quality-hold-is-released-at-the-store-offline-and-booked-once.test.ts.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['quality', 'release', 'offline', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = 't-sre';

interface QhWindow {
  readonly qualityReleaseQueue?: { view(lang: 'en'): { rows: { batchId: string; state: string; saved?: { state: string } }[] } };
  readonly qualityReleaseRelay?: unknown;
}

const packJson = (permissions: readonly string[]) => JSON.stringify({
  version: 1, lossPreventionRules: [],
  policies: { tradingDayCutoff: '02:00', storeId: 'S1', branchId: 'S1' },
  facilitiesPolicy: { userId: 'u-qc', permissions },
});

async function boxWithHeldBatches(dir: string): Promise<void> {
  const asAt = new Date(Date.now() - 30 * 60_000).toISOString();
  await writeHeldWorkFeeds(dir, TENANT, {
    'quality-holds': {
      receivedAt: asAt,
      feed: { name: 'quality-holds', asAt, body: { holds: [
        // Round 6 · M10-FR-02: each hold carries the samples recorded on it at head office.
        { batchId: 'B-1', productId: 'CURD', reason: 'chiller ran warm overnight', heldAt: asAt, heldBy: 'u-owner', samples: [{ sampleId: 'S-1', test: 'listeria', result: 'pass', takenBy: 'u-qc', takenAt: asAt }] },
        { batchId: 'B-2', productId: 'PANEER', reason: 'supplier notice pending', heldAt: asAt, heldBy: 'u-owner', samples: [{ sampleId: 'S-2', test: 'coliform', result: 'fail', takenBy: 'u-qc', takenAt: asAt }] },
      ] } },
    },
  });
}

describe.skipIf(!HAVE_BROWSER)('a quality-hold release at the facilities screen with the line down, on the real box (OB-333)', () => {
  let browser: Browser;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  const open = async (permissions: readonly string[]): Promise<{ page: Page; edge: EdgeProcess; errors: string[] }> => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-qh-e2e-')); dirs.push(dir);
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, packJson(permissions), 'utf8');
    await boxWithHeldBatches(dir);
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile,
    }, () => {}))!;
    stops.push(() => edge.stop());
    const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
    stops.push(() => context.close());
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/facilities/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as QhWindow).qualityReleaseQueue !== undefined && (globalThis as unknown as QhWindow).qualityReleaseRelay !== undefined, undefined, { timeout: 15_000 });
    await page.waitForSelector('#qh:not([hidden])');
    return { page, edge, errors };
  };
  const waitText = (page: Page, selector: string, text: string) => page.waitForFunction(([sel, want]) => {
    const node = (globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector(sel!);
    return (node?.textContent ?? '').includes(want!);
  }, [selector, text], { timeout: 15_000 });
  const row = (b: string) => `#qh-rows li[data-batch="${b}"]`;

  it('a person with the release right releases B-1 through the box with no cloud; refused first with nothing written; a reload sends nothing twice', async () => {
    const { page, edge, errors } = await open(['facilities.overdue.read', 'quality.hold.release']);
    expect(errors).toEqual([]);
    expect((await page.textContent('#qh-heading')) ?? '').toContain('Batches on quality hold');
    expect((await page.textContent('#qh-asof')) ?? '').toContain('as the store computer last heard them');
    expect(await page.getAttribute(row('B-1'), 'data-state')).toBe('held');
    expect((await page.textContent(row('B-1'))) ?? '').toContain('chiller ran warm overnight');
    // Nothing on this screen places a hold.
    expect(await page.locator('#qh button').filter({ hasText: /hold/i }).count()).toBe(0);
    // M10-FR-02: the samples recorded on each hold, in words beside their icons; a failed one takes the release away, said.
    await waitText(page, row('B-1'), 'listeria — Passed');
    expect(await page.getAttribute(`${row('B-1')} .qh-samples li`, 'data-result')).toBe('pass');
    await waitText(page, row('B-2'), 'coliform — Failed');
    await waitText(page, row('B-2'), 'A sample failed — this batch cannot be released for sale.');
    expect(await page.locator(`${row('B-2')} button.qh-release`).count()).toBe(0);

    // With nothing written about what was checked, refused in words and nothing saved.
    await page.click(`${row('B-1')} button.qh-release`);
    await waitText(page, '#qh-result-text', 'Write what you checked');
    expect(edge.deviceEventsOutbox.all()).toHaveLength(0);
    // The button carries its icon beside its word; the target is a finger's width.
    expect(await page.locator(`${row('B-1')} button.qh-release svg`).count()).toBe(1);
    expect((await page.locator(`${row('B-1')} button.qh-release`).boundingBox())!.height).toBeGreaterThanOrEqual(48);

    await page.fill(`${row('B-1')} textarea.qh-notes`, 'probe reads 3°C for 2 hours; sample tasted and smelt fine');
    await page.click(`${row('B-1')} button.qh-release`);
    await waitText(page, '#qh-result-text', 'Release saved on this screen');
    await page.waitForFunction(() => (globalThis as unknown as QhWindow).qualityReleaseQueue!.view('en').rows.find((r) => r.batchId === 'B-1')?.saved?.state === 'handed_to_box', undefined, { timeout: 20_000 });
    // The row is repainted on the screen's next status tick — wait for the words, never read them before they are painted.
    await waitText(page, row('B-1'), 'With the store computer');

    const records = (await readLog(edge.deviceEventsLog.path)).filter((r) => r.ok).map((r) => JSON.parse(r.ok ? r.record : '{}') as { type: string; payload: Record<string, unknown> });
    expect(records.map((r) => r.type)).toEqual(['QualityHoldReleaseDecided']);
    expect(records[0]?.payload).toMatchObject({ batchId: 'B-1', storeId: 'S1', releasedBy: 'u-qc', source: 'facilities-screen' });

    // Tamil: the section speaks Tamil.
    await page.click('#lang');
    expect((await page.textContent('#qh-heading')) ?? '').toContain('தரத் தடை');
    await waitText(page, row('B-1'), 'listeria — தேர்ச்சி');
    await page.click('#lang');

    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as QhWindow).qualityReleaseQueue !== undefined, undefined, { timeout: 15_000 });
    expect(await page.getAttribute(row('B-1'), 'data-state')).toBe('released_here');
    await page.waitForTimeout(500);
    expect(edge.deviceEventsOutbox.all()).toHaveLength(1);
    expect(errors).toEqual([]);
  }, 90_000);

  it('a person without the release right sees the held batches and no release button', async () => {
    const { page, errors } = await open(['facilities.overdue.read', 'facilities.task.record']);
    expect(await page.getAttribute(row('B-2'), 'data-state')).toBe('held');
    expect(await page.locator('#qh-rows button').count()).toBe(0);
    expect(errors).toEqual([]);
  });
});
