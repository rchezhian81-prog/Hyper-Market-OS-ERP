import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { HANDHELD_SEAL_PATHS, SEAL_NOT_READY_WORDS } from '../../edge/store-edge/src/handheld-seal';
import { prepareTillBox } from '../support/till-operator';
import { readQr, matrixFromQrSvg } from '../support/qr-reader';

/**
 * **OB-424 (owner, 27 Oct 2026) · ADR-0030 in a real browser, against a REAL store computer with no cloud.**
 *
 * The manager opens the store PC's own "Handheld seal" page (the screens server, the PC's loopback): it shows the QR
 * code, the short code to compare on the handheld and the download link. The QR, read back off the page, is the
 * certificate the door is locked under; the link downloads `authority.crt`, that same certificate. On a box with no
 * handheld door the page says so in English and Tamil and shows no seal. Skips where no browser binary is present.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['ob424', 'seal', 'e2e', 'key'].join('-').padEnd(48, '0');
const PACK = { version: 1, policies: { storeId: 'store-1', branchId: 'store-1', tradingDayCutoff: '00:00', warehouseId: 'wh-1' }, lossPreventionRules: [], devices: [] };

describe.skipIf(!HAVE_BROWSER)('OB-424: the handheld seal on the store PC\'s own screen', () => {
  let browser: Browser;
  const cleanups: Array<() => Promise<void>> = [];
  beforeAll(async () => { browser = await chromium.launch({ headless: true, executablePath: CHROMIUM }); }, 120_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

  const boxWith = async (devicePort: boolean): Promise<EdgeProcess> => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-ob424-e2e-'));
    cleanups.push(async () => { await rm(dir, { recursive: true, force: true }); await rm(`${dir}-device-tls`, { recursive: true, force: true }); await rm(`${dir}-witness`, { recursive: true, force: true }); });
    const env = await prepareTillBox({ dir, key: KEY, pack: PACK });
    const edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0', ...(devicePort ? { EDGE_DEVICE_PORT: '0' } : {}), EDGE_APPS_DIR: 'apps', ...env,
    }, () => {}))!;
    cleanups.push(async () => { await edge.stop(); });
    return edge;
  };

  it('shows the QR, the code to compare and the download link — all of the door\'s own authority', async () => {
    const edge = await boxWith(true);
    const authority = edge.devices!.authority();
    const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
    cleanups.push(async () => { await context.close(); });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${edge.screens!.port}${HANDHELD_SEAL_PATHS.page}`);

    await expect.poll(() => page.locator('#seal-heading').innerText()).toContain('Handheld seal');
    expect(await page.locator('#seal-heading').innerText()).toContain('கைக்கருவி முத்திரை');
    // The QR is on screen, at a size a phone can read off it.
    const qr = page.locator('#seal-qr svg');
    expect(await qr.isVisible()).toBe(true);
    const box = (await qr.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(250);
    // …and it carries the door's own authority certificate.
    const svg = await page.locator('#seal-qr').innerHTML();
    const carried = readQr(matrixFromQrSvg(svg)).bytes.toString('utf8');
    expect(new X509Certificate(carried).fingerprint256).toBe(authority.fingerprint);

    // The code to compare by eye: the start and the end of the fingerprint.
    const pairs = authority.fingerprint.split(':');
    expect(await page.locator('#seal-code').innerText()).toBe(`${pairs.slice(0, 4).join(':')} … ${pairs.slice(-4).join(':')}`);
    expect(await page.locator('#seal-code').isVisible()).toBe(true);
    expect(await page.locator('#seal-fingerprint').innerText()).toContain(authority.fingerprint);

    // The download link gives authority.crt — the same certificate, and nothing secret.
    const link = page.locator('#seal-download');
    expect(await link.isVisible()).toBe(true);
    const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
    expect(download.suggestedFilename()).toBe('authority.crt');
    const file = await readFile((await download.path())!);
    expect(new X509Certificate(file).fingerprint256).toBe(authority.fingerprint);
    expect(new X509Certificate(file).ca).toBe(true);
    expect(file.toString('latin1')).not.toMatch(/PRIVATE KEY/);
    expect(await page.content()).not.toMatch(/PRIVATE KEY/);
  }, 60_000);

  it('on a box with no handheld door it says so, in English and Tamil, and shows no seal', async () => {
    const edge = await boxWith(false);
    const page = await browser.newPage();
    cleanups.push(async () => { await page.close(); });
    await page.goto(`http://127.0.0.1:${edge.screens!.port}${HANDHELD_SEAL_PATHS.page}`);
    const problem = page.locator('#seal-problem');
    expect(await problem.isVisible()).toBe(true);
    expect(await problem.getAttribute('role')).toBe('alert');
    const text = await problem.innerText();
    expect(text).toContain(SEAL_NOT_READY_WORDS.no_door.en);
    expect(text).toContain(SEAL_NOT_READY_WORDS.no_door.ta);
    expect(await page.locator('#seal-qr').count()).toBe(0);
    expect(await page.locator('#seal-code').count()).toBe(0);
    expect(await page.locator('#seal-download').count()).toBe(0);
  }, 60_000);
});
