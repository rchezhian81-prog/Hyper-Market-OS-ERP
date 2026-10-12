import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startInboxShop, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';

/**
 * **The Organisation page, in a real browser, on the PRODUCTION API over real PostgreSQL (M01-FR-01 · PA-05 — the M01
 * proof gap: "the org/branch hierarchy screen proven in a browser on the production API").**
 *
 * The page is served in front of the real API (no stub): who is looking comes from head office's own
 * `GET /v1/identity/me`; every `/v1` call goes to the API under the signed-in person's token. Through Chromium:
 *
 *   • the owner builds the hierarchy — a company, a store under it, a back store under the store — and the page draws
 *     the tree as head office kept it (read back from `GET /v1/org/nodes`, not from the page): each place under its
 *     parent, a draft until it has what it needs;
 *   • a renamed store is a new version that head office keeps — read back after a RESTART of the API;
 *   • activating a store with no GST registration is refused by head office and the page shows its words; the store
 *     stays a draft; a place that cannot sit where it was asked (a company under a store) is refused by name;
 *   • a store manager reads the same tree but is offered no change (no setup rights); nothing is written on open.
 *
 * Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['organisation', 'e2e', 'production', 'signing', 'key'].join('-').padEnd(48, '0');

interface Node { nodeId: string; kind: string; name: string; parentId: string | null; status: string; companyId?: string }

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('the Organisation page on the production API, in a real browser (M01-FR-01)', () => {
  let browser: Browser;
  let shop: InboxShop;

  const nodesAtHeadOffice = async (): Promise<Node[]> => ((await shop.cloud().request({ method: 'GET', path: '/v1/org/nodes', userId: OWNER })).body as { nodes: Node[] }).nodes;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      // The owner builds the tree from empty here; the br-1 manager is granted once br-1 exists (round 18: grants name known stores).
      deferManagerGrant: true,
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/organisation', html: 'organisation.html', dataGlobal: 'organisationData' },
      seed: async () => {},
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 120_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  // The br-1 manager signs in AT br-1 — their grant reaches that branch only.
  const open = async (who: string) => {
    const context = await browser.newContext();
    await shop.signIn(context, who, who === MGR ? 'br-1' : undefined);
    const page = await context.newPage();
    const writes: string[] = []; const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${u.pathname}`); });
    await page.goto(`${shop.base}/organisation`, { waitUntil: 'load' });
    return { page, writes, errors, close: () => context.close() };
  };
  const statusSays = async (page: Page, id: string, expected: RegExp): Promise<void> => {
    await page.waitForFunction(([i, source]) => new RegExp(source!).test((globalThis as unknown as { document: { getElementById(x: string): { textContent: string | null } | null } }).document.getElementById(i!)?.textContent ?? ''), [id, expected.source], { timeout: 30_000 });
  };
  const add = async (page: Page, kind: string, name: string, code: string, parent: string): Promise<void> => {
    await page.selectOption('#add-kind', kind);
    await page.fill('#add-name', name);
    await page.fill('#add-code', code);
    await page.selectOption('#add-parent', parent);
    await page.click('#add');
  };

  it('the owner builds company → store → back store; the tree is what head office kept; a rename survives a restart', async () => {
    let s = await open(OWNER);
    try {
      await statusSays(s.page, 'tree', /No places yet/);
      expect(s.writes, 'nothing is written on open').toEqual([]);
      await add(s.page, 'company', 'Synthetic Retail Pvt Ltd', 'C-E2E', '');
      await statusSays(s.page, 'add-status', /^Added/);
      await s.page.locator('#tree li[data-node="C-E2E"]').waitFor({ timeout: 15_000 });
      await add(s.page, 'branch', 'Store One', 'br-1', 'C-E2E');
      await statusSays(s.page, 'add-status', /^Added/);
      await s.page.locator('#tree li[data-node="br-1"]').waitFor({ timeout: 15_000 });
      await add(s.page, 'warehouse', 'Store One back store', 'br-1-back', 'br-1');
      await statusSays(s.page, 'add-status', /^Added/);
      await s.page.locator('#tree li[data-node="br-1-back"]').waitFor({ timeout: 15_000 });
      // Drawn as a tree, in order, each under its parent and a draft.
      const order = await s.page.locator('#tree li.place').evaluateAll((els) => els.map((e) => (e as unknown as { dataset: { node: string } }).dataset.node));
      expect(order).toEqual(['C-E2E', 'br-1', 'br-1-back']);
      expect(await s.page.locator('#tree li[data-node="br-1-back"]').innerText()).toMatch(/Back store[\s\S]*Draft — not yet trading[\s\S]*under Store One/);
      expect(s.writes).toEqual(['POST /v1/org/nodes/C-E2E', 'POST /v1/org/nodes/br-1', 'POST /v1/org/nodes/br-1-back']);

      // A company cannot sit under a store — head office refuses it by name; nothing is added.
      await add(s.page, 'company', 'Wrong place', 'C-BAD', 'br-1');
      await statusSays(s.page, 'add-status', /^Head office refused:/);
      // Activating the store without a GST registration: refused in head office's words; it stays a draft.
      await s.page.locator('#tree li[data-node="br-1"] button[data-act="activate"]').click();
      await statusSays(s.page, 'tree-status', /^Head office refused: br-1 is not ready to activate/);
      // Rename the store: a new version, kept.
      await s.page.locator('#tree li[data-node="br-1"] input').fill('Store One (Main Road)');
      await s.page.locator('#tree li[data-node="br-1"] button[data-act="rename"]').click();
      await statusSays(s.page, 'tree-status', /^Renamed/);
      await s.page.waitForFunction(() => /Store One \(Main Road\)/.test((globalThis as unknown as { document: { getElementById(x: string): { textContent: string | null } | null } }).document.getElementById('tree')?.textContent ?? ''), undefined, { timeout: 15_000 });
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }

    // Head office's own record, not the page — and after a restart of the API.
    await shop.restart();
    const nodes = await nodesAtHeadOffice();
    expect(nodes.find((n) => n.nodeId === 'C-BAD')).toBeUndefined();
    expect(nodes.find((n) => n.nodeId === 'br-1')).toMatchObject({ kind: 'branch', name: 'Store One (Main Road)', parentId: 'C-E2E', status: 'draft', companyId: 'C-E2E' });
    expect(nodes.find((n) => n.nodeId === 'br-1-back')).toMatchObject({ kind: 'warehouse', parentId: 'br-1', status: 'draft', companyId: 'C-E2E' });

    s = await open(OWNER);
    try {
      await s.page.locator('#tree li[data-node="br-1"]').waitFor({ timeout: 15_000 });
      expect(await s.page.locator('#tree li[data-node="br-1"] .name').innerText()).toBe('Store One (Main Road)');
    } finally { await s.close(); }
  }, 120_000);

  it('a store manager reads the same tree and is offered no change; nothing is written', async () => {
    // br-1 now exists (the first journey built it): the br-1 manager is granted here, asked by HR and approved by the owner.
    await shop.grantManager();
    const s = await open(MGR);
    try {
      await s.page.locator('#tree li[data-node="br-1"]').waitFor({ timeout: 15_000 });
      expect(await s.page.locator('#add-section').isHidden()).toBe(true);
      expect(await s.page.locator('#tree button').count()).toBe(0);
      await statusSays(s.page, 'tree-status', /changing it needs setup rights/);
      // In Tamil too.
      await s.page.click('#lang');
      expect(await s.page.locator('#title').innerText()).toBe('அமைப்பு');
      expect(s.writes).toEqual([]);
      expect(s.errors).toEqual([]);
    } finally { await s.close(); }
  }, 60_000);
});
