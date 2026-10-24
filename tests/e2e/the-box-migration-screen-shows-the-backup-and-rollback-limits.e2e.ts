import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';

/**
 * **MG-11 on the store box, in a real browser (OB-288 P5 follow-up): the migration screen the box serves shows the backup
 * and the owner's rollback limits, from head office's register — and "not known" (never passed) until they arrive.**
 *
 * A REAL store computer pulls `GET /v1/migration/screen` from a stand-in head office:
 *   • first with neither the limits nor the backup register: both checks read "NOBODY CAN ANSWER THIS", and the verdict
 *     is not GO;
 *   • then with the owner's four limits and a good off-site backup an hour old: both checks read "passed", the limits'
 *     numbers in the words under them; in Tamil the check names are Tamil;
 *   • the box restarts with head office gone: still shown, the backup judged again by the box's own clock.
 * Synthetic data only. Skips where no browser binary is present.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['box', 'migration', 'mg11', 'key'].join('-').padEnd(48, '0');
const TENANT = 't-sre';
const TOKEN = ['edge', 'cloud', 'token'].join('-').padEnd(40, 'm');
const BASE_FEED = {
  tenantId: TENANT,
  policy: { cutoverId: 'cut-1', requiredCleanDays: 3, maxParallelDays: 14, startedOn: '2026-10-01', dailyReconcilerUserId: 'u-recon' },
  loadOperator: 'u-loader', refusedDecisions: [], parallelDays: [], parallelDifferences: [], rollbacks: [],
  verification: { findings: [], covered: [], missing: [], ownerKnown: true, extractionOperatorKnown: true, signaturesOverThisPage: 0, detail: '' },
};
const LIMITS = { controlTotalDifferenceMinor: 100_00, edgeOutageMinutes: 30, windowMinutes: 240, backupMaxAgeHours: 24, version: 1, setBy: 'u-owner', setAt: '2026-10-20T08:00:00.000Z' };

describe.skipIf(!HAVE_BROWSER)('the box\'s migration screen shows the backup and the rollback limits (MG-11)', () => {
  let browser: Browser;
  let server: Server;
  let cloud = '';
  let served: Record<string, unknown> = {};
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    server = createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/v1/migration/screen') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(served)); return; }
      res.writeHead(404); res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const a = server.address();
    cloud = typeof a === 'object' && a !== null ? `http://127.0.0.1:${a.port}` : '';
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 120_000);
  afterAll(async () => { await browser?.close(); await new Promise<void>((resolve) => server.close(() => resolve())); });

  const boot = (dir: string, cloudUrl = cloud): Promise<EdgeProcess> => startEdge({
    EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
    CLOUD_API_URL: cloudUrl, CLOUD_API_TOKEN: TOKEN, EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
  }, () => {}) as Promise<EdgeProcess>;
  const checkRow = async (page: Page, words: string): Promise<string> => {
    const row = page.locator('#check-list .row', { hasText: words }).first();
    await row.waitFor({ timeout: 15_000 });
    return (await row.textContent()) ?? '';
  };

  it('"not known" until head office says; then passed with the owner\'s numbers; Tamil; across a restart offline', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-box-mg11-'));
    const edges: EdgeProcess[] = [];
    try {
      served = { ...BASE_FEED, generatedAt: '2026-10-20T08:00:00.000Z' };
      const edge = await boot(dir); edges.push(edge);
      await edge.refreshMigrationFeed!();
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`http://127.0.0.1:${edge.screens!.port}/migration`, { waitUntil: 'load' });
      expect(await checkRow(page, 'A good backup, copied off-site')).toContain('NOBODY CAN ANSWER THIS');
      expect(await checkRow(page, 'The owner has set every rollback limit')).toContain('NOBODY CAN ANSWER THIS');
      await context.close();

      served = { ...BASE_FEED, generatedAt: '2026-10-21T08:00:00.000Z', rollbackLimits: LIMITS, backups: [{ backupId: 'B-7', at: new Date(Date.now() - 3_600_000).toISOString(), ok: true, encrypted: true, offsite: true }] };
      expect((await edge.refreshMigrationFeed!()).status).toBe('updated');
      const c2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const p2 = await c2.newPage();
      p2.on('pageerror', (e) => errors.push(e.message));
      await p2.goto(`http://127.0.0.1:${edge.screens!.port}/migration`, { waitUntil: 'load' });
      const backup = await checkRow(p2, 'A good backup, copied off-site');
      expect(backup).toContain('— passed');
      expect(backup).toContain('B-7');
      const limits = await checkRow(p2, 'The owner has set every rollback limit');
      expect(limits).toContain('— passed');
      expect(limits).toContain('10000 paise, 30 minute(s) cut off, 240 minute(s) from GO, a backup at most 24 hour(s) old');
      await p2.click('#lang');
      expect(await checkRow(p2, 'வெளியிடத்திற்கு நகலெடுக்கப்பட்ட')).toContain('தேர்ச்சி');
      await c2.close();
      await edge.stop(); edges.splice(0);

      // Head office gone, the box restarted on the same disk: both still shown, still passed.
      const back = await boot(dir, 'http://127.0.0.1:1'); edges.push(back);
      const c3 = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const p3 = await c3.newPage();
      await p3.goto(`http://127.0.0.1:${back.screens!.port}/migration`, { waitUntil: 'load' });
      expect(await checkRow(p3, 'A good backup, copied off-site')).toContain('— passed');
      expect(await checkRow(p3, 'The owner has set every rollback limit')).toContain('— passed');
      await c3.close();
      expect(errors).toEqual([]);
    } finally {
      for (const e of edges) await e.stop();
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
