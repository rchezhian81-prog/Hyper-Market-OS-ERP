// Round 4c: one fixture for the people-and-administration office pages in a real browser. The REAL store computer serves the
// page as the person the front signed in (OB-380); head office's API runs in memory (the production route set, `apiHarness`)
// and every `/v1` call the page makes reaches it AS THAT PERSON on the box's own origin — reads and writes, with their body
// and idempotency key. Nothing in between answers for head office. Synthetic data only.

import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../../edge/store-edge/src/main';
import { apiHarness, type ApiHarness } from '../../support/api-harness';

export const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
export const HAVE_BROWSER = existsSync(CHROMIUM);

export interface PackPerson { readonly userId: string; readonly permissions: readonly string[] }

export interface BoxPageShop {
  readonly ho: ApiHarness;
  readonly tenantId: string;
  readonly store: string;
  /** A head-office write or read as `who` (for the setup a second person does outside the page). */
  call(method: 'GET' | 'POST' | 'PUT', path: string, who: string, body?: unknown): Promise<{ status: number; body: unknown }>;
  /** Open `path` on the box as `who`; every write the page sends is listed. */
  open(who: string, path: string): Promise<{ page: Page; errors: string[]; writes: string[]; close(): Promise<void> }>;
  stop(): Promise<void>;
}

/**
 * Start the shop: head office (seeded by `seed`), and a store computer whose signed pack names each person with the words
 * the box checks before it serves a page (head office still re-checks every call).
 */
export async function startBoxPageShop(input: {
  readonly name: string;
  readonly people: readonly PackPerson[];
  readonly seed: (ho: ApiHarness, tenantId: string, store: string) => Promise<void>;
  /** More sections of the signed store pack (a box-served page's own policy, e.g. `fleetPolicy`). */
  readonly pack?: Record<string, unknown>;
  /** The box's own store (default `store-1`). */
  readonly store?: string;
}): Promise<BoxPageShop> {
  execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
  const tenantId = randomUUID();
  const store = input.store ?? 'store-1';
  const ho = apiHarness();
  await input.seed(ho, tenantId, store);
  const browser: Browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  const dir = await mkdtemp(join(tmpdir(), `sre-r4c-${input.name}-`));
  const packFile = join(dir, 'store-pack.json');
  await writeFile(packFile, JSON.stringify({
    version: 1, lossPreventionRules: [], policies: { tradingDayCutoff: '02:00', storeId: store, branchId: store },
    roles: input.people.map((p) => ({ id: `r-${p.userId}`, name: p.userId, permissions: ['identity.self.read', ...p.permissions] })),
    roleAssignments: input.people.map((p) => ({ userId: p.userId, roleId: `r-${p.userId}`, branchScope: [store] })),
    ...(input.pack ?? {}),
  }), 'utf8');
  const key = ['r4c', input.name, 'box', 'key'].join('-').padEnd(48, '0');
  const edge: EdgeProcess = (await startEdge({
    EDGE_DATA_DIR: dir, EDGE_TENANT_ID: tenantId, PACK_SIGNING_KEY: key, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
    EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile, EDGE_SCREEN_TRUST_FORWARDED_USER: '1',
  }, () => {}))!;

  const call: BoxPageShop['call'] = async (method, path, who, body) => {
    const url = new URL(path, 'http://x');
    const r = await ho.request({
      method, path: url.pathname, userId: who, tenantId, branchId: store,
      ...(url.search === '' ? {} : { query: Object.fromEntries(url.searchParams) }),
      ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }),
    });
    return { status: r.status, body: r.body };
  };

  return {
    ho, tenantId, store, call,
    open: async (who, path) => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', extraHTTPHeaders: { 'x-sre-user': who } });
      const writes: string[] = [];
      await context.route('**/v1/**', async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        if (req.method() !== 'GET') writes.push(`${req.method()} ${url.pathname}`);
        const raw = req.postData();
        const answer = await ho.request({
          method: req.method() as 'GET', path: url.pathname, userId: who, tenantId, branchId: store,
          ...(url.search === '' ? {} : { query: Object.fromEntries(url.searchParams) }),
          ...(req.method() === 'GET' ? {} : { idempotencyKey: req.headers()['idempotency-key'] ?? `k-${randomUUID()}` }),
          ...(raw === null || raw === '' ? {} : { body: JSON.parse(raw) as unknown }),
        });
        await route.fulfill({ status: answer.status, contentType: 'application/json', body: JSON.stringify(answer.body ?? {}) });
      });
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const res = await page.goto(`http://127.0.0.1:${edge.screens!.port}${path}`, { waitUntil: 'load' });
      if (res?.status() !== 200) throw new Error(`${path} as ${who}: the store computer answered ${res?.status()}`);
      return { page, errors, writes, close: () => context.close() };
    },
    stop: async () => { await browser.close(); await edge.stop(); await rm(dir, { recursive: true, force: true }); },
  };
}

/** Wait until `selector`'s text matches; on a timeout, say what it did say. */
export async function says(page: Page, selector: string, pattern: RegExp): Promise<void> {
  await page.waitForFunction(
    ([sel, src]) => new RegExp(src!).test((globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector(sel!)?.textContent ?? ''),
    [selector, pattern.source], { timeout: 15_000 },
  ).catch(async (e: unknown) => {
    const seen = await page.evaluate((sel) => (globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector(sel)?.textContent ?? '(none)', selector);
    throw new Error(`${selector} never said ${pattern.source}; it says: ${JSON.stringify(seen)} (${String(e)})`);
  });
}
