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
 * **M10-FR-02 "evidence captured offline; queued" with OB-513 — a held FOOD batch is sampled and released at the facilities
 * screen with the line down, in a real browser on the REAL store box.**
 *
 * The box starts with NO cloud and head office's held batches restored from its own disk: B-1 is food with no sample, so it
 * is not offered for release. A person with the quality-hold and release rights records a sample — refused first, in words,
 * with nothing tested written down — and the screen says plainly it is saved on the store computer, waiting to reach head
 * office. The release is then offered and goes behind the sample on the same queue, naming the sample it rests on. A pending
 * sample's result is recorded with one button. A reload keeps the sample in view and sends nothing twice. Head office
 * re-checking the person and the hold and booking both once is proven by
 * tests/integration/a-held-food-batch-is-sampled-and-released-at-the-store-offline.test.ts.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['quality', 'sample', 'offline', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = 't-sre';

interface QhWindow {
  readonly qualityReleaseQueue?: { view(lang: 'en'): { rows: { batchId: string; samples: { sampleId: string; here?: { state: string } }[] | null }[] } };
  readonly qualityReleaseRelay?: unknown;
}

async function open(browser: Browser, dirs: string[], stops: (() => Promise<void>)[], permissions: readonly string[]): Promise<{ page: Page; edge: EdgeProcess; errors: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), 'sre-qs-e2e-')); dirs.push(dir);
  const packFile = join(dir, 'store-pack.json');
  await writeFile(packFile, JSON.stringify({
    version: 1, lossPreventionRules: [], policies: { tradingDayCutoff: '02:00', storeId: 'S1', branchId: 'S1' },
    facilitiesPolicy: { userId: 'u-qc', permissions },
  }), 'utf8');
  const asAt = new Date(Date.now() - 30 * 60_000).toISOString();
  await writeHeldWorkFeeds(dir, TENANT, {
    'quality-holds': {
      receivedAt: asAt,
      feed: { name: 'quality-holds', asAt, body: { holds: [
        { batchId: 'B-1', productId: 'CURD', reason: 'chiller ran warm overnight', heldAt: asAt, heldBy: 'u-owner', samples: [], sampleRule: { required: true, because: 'food', detail: 'food' } },
        { batchId: 'B-2', productId: 'PANEER', reason: 'supplier notice', heldAt: asAt, heldBy: 'u-owner', samples: [], sampleRule: { required: true, because: 'food', detail: 'food' } },
      ] } },
    },
  });
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
}

const waitText = (page: Page, selector: string, text: string) => page.waitForFunction(([sel, want]) => {
  const node = (globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector(sel!);
  return (node?.textContent ?? '').includes(want!);
}, [selector, text], { timeout: 20_000 });
const row = (b: string) => `#qh-rows li[data-batch="${b}"]`;
const deviceLog = async (edge: EdgeProcess) => (await readLog(edge.deviceEventsLog.path)).filter((r) => r.ok)
  .map((r) => JSON.parse(r.ok ? r.record : '{}') as { type: string; payload: Record<string, unknown> });

describe.skipIf(!HAVE_BROWSER)('a held food batch is sampled at the facilities screen with the line down, on the real box (M10-FR-02 · OB-513)', () => {
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

  it('records a sample with no cloud, says it waits for head office, then releases behind it; a pending result comes back; a reload sends nothing twice', async () => {
    const { page, edge, errors } = await open(browser, dirs, stops, ['facilities.overdue.read', 'quality.hold.manage', 'quality.hold.release']);
    // B-1 is food with no sample: not offered for release, said in words; the sample form is there.
    await waitText(page, row('B-1'), 'No sample is recorded yet');
    expect(await page.locator(`${row('B-1')} button.qh-release`).count()).toBe(0);
    expect((await page.textContent(`${row('B-1')} .qs-heading`)) ?? '').toContain('Record a quality sample');
    // Nothing on this screen places a hold.
    expect(await page.locator('#qh button').filter({ hasText: /hold/i }).count()).toBe(0);

    // Nothing tested written down: refused in words, nothing saved.
    await page.click(`${row('B-1')} button.qs-record`);
    await waitText(page, '#qh-result-text', 'Write what was tested');
    expect(edge.deviceEventsOutbox.all()).toHaveLength(0);
    // The button carries its icon beside its word; the target is a finger's width.
    expect(await page.locator(`${row('B-1')} button.qs-record svg`).count()).toBe(1);
    expect((await page.locator(`${row('B-1')} button.qs-record`).boundingBox())!.height).toBeGreaterThanOrEqual(48);

    await page.fill(`${row('B-1')} input.qs-test`, 'probe and smell');
    await page.selectOption(`${row('B-1')} select.qs-result`, 'pass');
    await page.fill(`${row('B-1')} input.qs-notes`, 'probe 3°C');
    await page.click(`${row('B-1')} button.qs-record`);
    await waitText(page, '#qh-result-text', 'Sample saved on the store computer — it is waiting to reach head office');
    await waitText(page, row('B-1'), 'probe and smell — Passed');
    // Once the box has it, the sample says so plainly — and the release is offered.
    await waitText(page, `${row('B-1')} .qh-samples li`, 'Saved on the store computer — waiting to reach head office');
    await page.waitForSelector(`${row('B-1')} button.qh-release`);

    await page.fill(`${row('B-1')} textarea.qh-notes`, 'sample passed; probe 3°C for 2 hours');
    await page.click(`${row('B-1')} button.qh-release`);
    await waitText(page, '#qh-result-text', 'Release saved on this screen');
    await waitText(page, row('B-1'), 'With the store computer');

    // B-2: a pending sample, then its result with one button.
    await page.fill(`${row('B-2')} input.qs-test`, 'listeria');
    await page.selectOption(`${row('B-2')} select.qs-result`, 'pending');
    await page.click(`${row('B-2')} button.qs-record`);
    await waitText(page, row('B-2'), 'listeria — Waiting for the result');
    await waitText(page, row('B-2'), 'has not come back yet');
    await page.click(`${row('B-2')} button.qs-pass`);
    await waitText(page, row('B-2'), 'listeria — Passed');
    await page.waitForSelector(`${row('B-2')} button.qh-release`);

    // On the box's fsync'd log, in order: the sample, then the release that names it; then B-2's two versions.
    await page.waitForFunction(() => (globalThis as unknown as QhWindow).qualityReleaseQueue!.view('en').rows.find((r) => r.batchId === 'B-2')?.samples?.[0]?.here?.state === 'on_box', undefined, { timeout: 20_000 });
    const records = await deviceLog(edge);
    expect(records.map((r) => `${r.type}:${String(r.payload['batchId'])}:${String(r.payload['result'] ?? '')}`)).toEqual([
      'QualitySampleRecorded:B-1:pass', 'QualityHoldReleaseDecided:B-1:', 'QualitySampleRecorded:B-2:pending', 'QualitySampleRecorded:B-2:pass',
    ]);
    const sampleId = String(records[0]?.payload['sampleId']);
    expect(records[0]?.payload).toMatchObject({ test: 'probe and smell', recordedBy: 'u-qc', storeId: 'S1', notes: 'probe 3°C', source: 'facilities-screen' });
    expect(records[1]?.payload).toMatchObject({ releasedBy: 'u-qc', samplesRecordedHere: [{ sampleId, result: 'pass' }] });
    expect(records[3]?.payload['sampleId']).toBe(records[2]?.payload['sampleId']);

    // Tamil: the new words speak Tamil.
    await page.click('#lang');
    await waitText(page, `${row('B-2')} .qs-heading`, 'தர மாதிரியைப் பதிவு செய்');
    await waitText(page, `${row('B-2')} .qh-samples li`, 'கடைக் கணினியில் சேமிக்கப்பட்டது');
    await page.click('#lang');

    // A reload: the samples are still in view (the box holds them), nothing is sent twice.
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as QhWindow).qualityReleaseQueue !== undefined, undefined, { timeout: 15_000 });
    await waitText(page, row('B-2'), 'listeria — Passed');
    expect(await page.getAttribute(row('B-1'), 'data-state')).toBe('released_here');
    await page.waitForTimeout(500);
    expect(edge.deviceEventsOutbox.all()).toHaveLength(4);
    expect(errors).toEqual([]);
  }, 120_000);

  it('a person with the release right but not the quality-hold right sees no sample form', async () => {
    const { page, errors } = await open(browser, dirs, stops, ['facilities.overdue.read', 'quality.hold.release']);
    await waitText(page, row('B-1'), 'No sample is recorded yet');
    expect(await page.locator('#qh-rows form.qs-form').count()).toBe(0);
    expect(await page.locator('#qh-rows button').count()).toBe(0);
    expect(errors).toEqual([]);
  });
});
