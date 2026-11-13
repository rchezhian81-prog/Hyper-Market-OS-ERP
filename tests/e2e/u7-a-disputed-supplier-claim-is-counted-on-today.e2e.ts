import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { prepareTillBox } from '../support/till-operator';

/**
 * **U7 · OB-726 (owner, in writing: B) — the store computer's Today page counts the disputed supplier claims, in English and
 * Tamil, and says "not known" with the reason when head office has not told it.** Two real store computers (disk, screens),
 * one whose signed pack carries head office's two counts (3 open, 1 overdue) and one whose pack does not. In a real Chromium:
 *
 *   • the told box's "Store today" card shows "Disputed supplier claims open" 3, its note "1 overdue — settle them on Supplier
 *     claims", and the attention list names them; after the language toggle the label and the note read in Tamil;
 *   • the untold box shows "Not known" with the reason (never a zero), in English and then in Tamil.
 * Skips where no browser binary is present, like its siblings.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const KEY = ['dispute', 'today', 'key'].join('-').padEnd(48, '0');
// The manager holds what the Supplier claims page needs (purchase.commitment.read), so the rail offers it.
const PEOPLE = [{ userId: 'u-mgr', displayName: 'Manager', manager: true, permissions: ['pos.sale.sync', 'till.dayclose.read', 'purchase.commitment.read'] }];

type Doc = { document: { querySelector(s: string): { textContent: string | null } | null; documentElement: { lang: string } } };

describe.skipIf(!existsSync(CHROMIUM))('U7 · OB-726: disputed supplier claims on the Today page', () => {
  let browser: Browser;
  const boxes: EdgeProcess[] = [];
  const dirs: string[] = [];
  const startBox = async (pack: Record<string, unknown>): Promise<EdgeProcess> => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-dispute-today-'));
    dirs.push(dir);
    const ready = await prepareTillBox({ dir, key: KEY, people: PEOPLE, laneId: null, pack: { managerPolicy: { userId: 'u-mgr', approvalLimitMinor: 500_000 }, ...pack } });
    const edge = (await startEdge({ EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', ...ready }, () => {}))!;
    boxes.push(edge);
    return edge;
  };
  let told: EdgeProcess;
  let untold: EdgeProcess;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    told = await startBox({ supplierClaimDisputes: { open: 3, overdue: 1 } });
    untold = await startBox({});
  }, 180_000);
  afterAll(async () => {
    await browser?.close();
    for (const b of boxes) await b.stop();
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  const figure = (page: Page): Promise<string> => page.$$eval('#ops .op', (els) => (els.map((e) => e.textContent ?? '').find((t) => /Disputed supplier claims open|சர்ச்சைக்குரிய/.test(t))) ?? '');
  const toTamil = async (page: Page) => {
    await page.click('#lang');
    await page.waitForFunction(() => (globalThis as unknown as Doc).document.documentElement.lang === 'ta');
  };
  const open = async (edge: EdgeProcess): Promise<{ page: Page; errors: string[] }> => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/manager/`, { waitUntil: 'load' });
    await page.waitForSelector('#ops .op');
    return { page, errors };
  };

  it('a told box counts them, names the overdue ones, and reads in Tamil after the toggle', async () => {
    const { page, errors } = await open(told);
    const en = await figure(page);
    expect(en).toContain('3');
    expect(en).toContain('Disputed supplier claims open');
    expect(en).toContain('1 overdue — settle them on Supplier claims');
    expect(await page.textContent('#attention')).toContain('disputed supplier claims to settle — open Supplier claims');
    // One tap to where they are settled: the figure's link opens Supplier claims (the rail item the manager holds).
    const href = await page.$$eval('#ops .op', (els) => els.find((e) => /Disputed supplier claims open/.test(e.textContent ?? ''))?.querySelector('a.go')?.getAttribute('href') ?? null);
    expect(href).toBe('/supplier-claims');
    await toTamil(page);
    await page.waitForFunction(() => /தாமதமானவை/.test([...(globalThis as unknown as { document: { querySelectorAll(s: string): Iterable<{ textContent: string | null }> } }).document.querySelectorAll('#ops .op')].map((e) => e.textContent ?? '').join(' ')));
    const ta = await figure(page);
    expect(ta).toContain('திறந்த சர்ச்சைக்குரிய விநியோகஸ்தர் உரிமைக்கோரல்கள்');
    expect(ta).toContain('1 தாமதமானவை — விநியோகஸ்தர் உரிமைக்கோரல்கள் பக்கத்தில் தீர்க்கவும்');
    expect(ta).not.toContain('overdue');
    expect(errors).toEqual([]);
  }, 60_000);

  it('an untold box says "Not known" with the reason — never a zero — in English and Tamil', async () => {
    const { page, errors } = await open(untold);
    const en = await figure(page);
    expect(en).toContain('Not known');
    expect(en).toContain('the store computer has not been given the disputed supplier claims');
    await toTamil(page);
    await page.waitForFunction(() => /வழங்கப்படவில்லை/.test([...(globalThis as unknown as { document: { querySelectorAll(s: string): Iterable<{ textContent: string | null }> } }).document.querySelectorAll('#ops .op')].map((e) => e.textContent ?? '').join(' ')));
    expect(await figure(page)).toContain('கடைக் கணினிக்கு சர்ச்சைக்குரிய விநியோகஸ்தர் உரிமைக்கோரல்கள் வழங்கப்படவில்லை');
    expect(errors).toEqual([]);
  }, 60_000);
});
