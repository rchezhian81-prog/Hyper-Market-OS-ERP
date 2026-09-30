import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';

/**
 * **A manager's approval decided in a real browser survives a reload and lands on the store computer (SP-2a · F11 ·
 * M02-FR-03 · P-01 · hard rules #1/#6/#10).**
 *
 * The audit's F11, at the surface: the served manager screen returned "Decided", and on reload the same request was
 * offered again — the decision had lived in a `new SyncOutbox()` and died with the tab. Everything below the browser
 * is production: the real `startEdge` serves the real manager shell with `window.laneWriteBase` injected, opens the
 * real lane socket, and stands its device-events pipeline behind `/lane/outbox`. A REAL headless Chromium:
 *
 *   • decides the one waiting approval (three taps, as the budget suite counts them). The banner says where the
 *     decision IS — saved on this screen — and within a moment the decisions list says it is with the store computer,
 *     because the box has it on its fsync'd device-events log and in its queue for head office;
 *   • RELOADS. The request is no longer offered (the durable device queue is the authority for "decided"), the
 *     decision is still listed with its state, and a second decision is impossible — nothing was lost with the page;
 *   • with the box's socket gone, a decision stays "saved on this screen … trying again", survives a reload, and is
 *     never shown as sent or refused (a link failure is not a refusal).
 *
 * No cloud is configured: the box holds the decision durably and will carry it up when one is (P-01). Head office
 * delivery from the box is proven by `tests/integration/manager-decisions-reach-the-cloud-through-the-edge.test.ts`.
 * The browser binary is the environment's pre-installed Chromium; where none is present the suite SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['manager', 'decisions', 'reload', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = 't-sre';

/** One approval the served manager may clear, in the pack's own branch, from somebody else, within the named limit. */
const PACK_JSON = JSON.stringify({
  version: 1,
  policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1' },
  managerPolicy: { userId: 'u-mgr', approvalLimitMinor: 500_000 },
  lossPreventionRules: [],
  approvals: [{ id: 'a1', subjectType: 'price_change', subjectRef: 'Toor dal 1kg', requestedBy: 'u-buyer', branchId: 'store-1', valueMinor: 45_000 }],
});

interface ManagerWindow {
  readonly laneWriteBase?: string;
  readonly managerSession?: { decisions(): { requestId: string; state: string }[]; floor(): { heldHere: number } };
  readonly managerRelay?: unknown;
  readonly document: { querySelector(selector: string): { hidden: boolean; textContent: string | null; getAttribute(n: string): string | null } | null; querySelectorAll(selector: string): { length: number } };
}

describe.skipIf(!HAVE_BROWSER)('the manager\'s decision survives a reload and reaches the store computer (SP-2a · F11)', () => {
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

  async function box(): Promise<{ edge: EdgeProcess; base: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'sre-mgr-decisions-'));
    dirs.push(dir);
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, PACK_JSON, 'utf8');
    const edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile,
    }, () => {}))!;
    stops.push(() => edge.stop());
    return { edge, base: `http://127.0.0.1:${edge.screens!.port}` };
  }

  async function openManager(base: string): Promise<Page> {
    const context = await browser.newContext();
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`${base}/manager`, { waitUntil: 'load' });
    await ready(page);
    return page;
  }
  const ready = (page: Page) => page.waitForFunction(
    () => (globalThis as unknown as ManagerWindow).managerSession !== undefined && typeof (globalThis as unknown as ManagerWindow).laneWriteBase === 'string',
    undefined, { timeout: 15_000 },
  );

  /** Decide the one waiting approval: next approval → Approve → the first reason. */
  async function decideTheOne(page: Page): Promise<void> {
    await page.waitForSelector('#next-approval:not([hidden])');
    await page.click('#next-approval');
    await page.waitForSelector('#view-approvals:not([hidden]) .row-actions button');
    await page.click('#approval-rows .row-actions button.primary');
    await page.waitForSelector('#choices button');
    await page.click('#choices button:first-child');
    await page.waitForFunction(() => !((globalThis as unknown as ManagerWindow).document.querySelector('#banner') as { hidden: boolean }).hidden);
  }
  const stateOf = (page: Page, requestId: string) => page.evaluate(
    (id) => (globalThis as unknown as ManagerWindow).managerSession!.decisions().find((d) => d.requestId === id)?.state,
    requestId,
  );

  it('decided → saved here → with the store computer (durable on the box); reload → still decided, not offered again', async () => {
    const { edge, base } = await box();
    const page = await openManager(base);
    expect(await page.evaluate(() => (globalThis as unknown as ManagerWindow).managerRelay !== undefined)).toBe(true);

    await decideTheOne(page);
    // The banner says WHERE the decision is — never a bare "decided" (P-08).
    expect(await page.textContent('#banner-title')).toBe('Decided');
    expect(await page.textContent('#banner-text')).toContain('Toor dal 1kg');
    expect(await page.textContent('#banner-text')).toMatch(/Saved on this screen|With the store computer/);

    // Within a moment the relay has handed it to the box: the list says so, and the BOX has it — on its fsync'd
    // device-events log and in its queue for head office. This is what F11 said existed nowhere.
    await page.waitForFunction(() => (globalThis as unknown as ManagerWindow).managerSession!.decisions()[0]?.state === 'handed_to_box', undefined, { timeout: 10_000 });
    await page.click('#banner-ok');
    await page.waitForSelector('#decision-rows .row.decision[data-state="handed_to_box"]');
    expect(await page.textContent('#decision-rows .row.decision .pill')).toContain('With the store computer');
    expect(edge.deviceEventsOutbox.pending().map((i) => [i.event.type, i.key])).toEqual([['ApprovalDecided', 'approval-decision-a1']]);
    const records = (await readLog(edge.deviceEventsLog.path)).filter((r) => r.ok).map((r) => JSON.parse(r.ok ? r.record : '{}') as { type: string; payload: { id: string; status: string; decidedBy: string } });
    expect(records).toHaveLength(1);
    expect(records[0]?.payload).toMatchObject({ id: 'a1', status: 'approved', decidedBy: 'u-mgr' });
    // The request has left the open list; the home screen offers nothing to clear.
    expect(await page.evaluate(() => (globalThis as unknown as ManagerWindow).document.querySelectorAll('#approval-rows .row').length)).toBe(0);

    // RELOAD. Before SP-2a this offered "Clear the next approval (1)" again — the decision had died with the tab.
    await page.reload({ waitUntil: 'load' });
    await ready(page);
    await page.waitForSelector('#tiles .tile');
    expect(await page.locator('#next-approval').getAttribute('hidden')).not.toBeNull();
    await page.click('#tab-approvals');
    await page.waitForSelector('#approvals-empty:not([hidden])');
    expect(await page.evaluate(() => (globalThis as unknown as ManagerWindow).document.querySelectorAll('#approval-rows .row').length)).toBe(0);
    await page.waitForSelector('#decision-rows .row.decision[data-request-id="a1"]');
    expect(await stateOf(page, 'a1')).toBe('handed_to_box');
    expect(await page.evaluate(() => (globalThis as unknown as ManagerWindow).managerSession!.floor().heldHere)).toBe(0);
    // Still exactly one record on the box: the reload re-sent nothing new (the device had already acknowledged it).
    expect(edge.deviceEventsOutbox.all()).toHaveLength(1);
  });

  it('with the store computer unreachable the decision stays saved here — retrying, never sent, never refused — and survives a reload', async () => {
    const { edge, base } = await box();
    const page = await openManager(base);
    // The lane socket goes away AFTER the page learned its address: the screen can no longer hand anything over.
    await edge.lane!.stop();

    await decideTheOne(page);
    expect(await page.textContent('#banner-text')).toContain('Saved on this screen');
    await page.waitForFunction(() => (globalThis as unknown as ManagerWindow).managerSession!.decisions()[0]?.state === 'retrying', undefined, { timeout: 10_000 });
    await page.click('#banner-ok');
    await page.waitForSelector('#decision-rows .row.decision[data-state="retrying"]');
    expect(await page.textContent('#decision-rows .row.decision .pill')).toContain('trying again');
    expect(edge.deviceEventsOutbox.all()).toHaveLength(0);

    await page.reload({ waitUntil: 'load' });
    await ready(page);
    await page.waitForSelector('#tiles .tile');
    expect(await page.locator('#next-approval').getAttribute('hidden')).not.toBeNull();
    expect(await page.evaluate(() => (globalThis as unknown as ManagerWindow).managerSession!.floor().heldHere)).toBe(1);
    await page.click('#tab-approvals');
    await page.waitForSelector('#decision-rows .row.decision[data-request-id="a1"]');
    expect(['saved_here', 'retrying']).toContain(await stateOf(page, 'a1'));
    // The home tile counts it as not yet sent, and says how many are only on this screen.
    await page.click('#tab-home');
    await page.waitForSelector('#tiles .tile');
    expect(await page.textContent('#tiles')).toContain('saved on this screen');
  });
});
