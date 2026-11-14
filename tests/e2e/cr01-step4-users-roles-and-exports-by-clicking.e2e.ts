import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright-core';
import { apiHarness, TEST_IDP, type ApiHarness } from '../support/api-harness';
import { aStoreWithRules } from '../support/store-rules';
import { ROLE_CATALOGUE } from '../../services/api/src/roles';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { issueTillCredential, tillPinKey } from '../../packages/identity/src/till-pin';
import { readTillCredentials } from '../../edge/store-edge/src/till-operators';

/**
 * **CR-01 step 4 (OI-06 · OI-07 · OI-09), by clicking, in a real browser, on a real store edge talking to a real API.**
 *
 *   The store PC's till (store edge) runs with its office PIN sign-in and the Office centre on (EDGE_OFFICE_HEAD_OFFICE=
 *   this-pc); the shop's API answers on this PC's loopback. No head-office internet sign-in anywhere.
 *     1. the manager opens the menu's Users & roles (/users) → the office centre → signs in with staff ID + PIN → asks the
 *        cashier role for a NEW person, confirming with their PIN;
 *     2. the owner signs in, sees it waiting, approves it with his PIN — the new person now holds the role;
 *     3. the manager lets the new person set their own first PIN — the till's own PIN file now holds it;
 *     4. the owner exports products from Import & export — the file downloads Excel-safe (byte-order mark first);
 *     5. the old-system import opens inside the Office app, already signed in as the office person.
 *   Every page carries Tamil beside English.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const KEY = ['cr01', 'step4', 'pack', 'key', 'for', 'tests'].join('-').padEnd(64, '0');
const STORE = 'SRE-T1';
const OWNER = { userId: 'owner-01', pin: '135790', roleId: 'owner' };
const MANAGER = { userId: 'manager-01', pin: '246801', roleId: 'store_manager' };
const NEW = 'cashier-07';

describe.skipIf(!existsSync(CHROMIUM))('Users & roles and Import & export on the store PC, by clicking (CR-01 step 4)', () => {
  let browser: Browser; let api: Server; let edge: EdgeProcess; let base = ''; let dataDir = ''; let h: ApiHarness;
  beforeAll(async () => {
    h = apiHarness();
    const T = randomUUID();
    await h.seedOwner(T, OWNER.userId);
    await aStoreWithRules(h, T, OWNER.userId, STORE, 0);
    await h.provisionRole(T, MANAGER.userId, 'store_manager');
    // This PC's API on loopback: the harness, over HTTP.
    api = createServer((req, res) => {
      const parts: Buffer[] = [];
      req.on('data', (c: Buffer) => parts.push(c));
      req.on('end', () => {
        void (async () => {
          const u = new URL(req.url ?? '/', 'http://x');
          const text = Buffer.concat(parts).toString('utf8');
          const r = await h.raw({
            method: (req.method ?? 'GET') as 'GET', path: u.pathname, ...(u.search === '' ? {} : { query: Object.fromEntries(u.searchParams) }),
            token: String(req.headers['authorization'] ?? '').replace(/^Bearer /, ''),
            ...(text === '' ? {} : { body: JSON.parse(text) as unknown }),
            ...(typeof req.headers['idempotency-key'] === 'string' ? { idempotencyKey: req.headers['idempotency-key'] } : {}),
          });
          res.writeHead(r.status, { 'content-type': 'application/json' }).end(JSON.stringify(r.body ?? {}));
        })();
      });
    });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', () => r()));
    const apiBase = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

    dataDir = await mkdtemp(join(tmpdir(), 'sre-cr01-step4-'));
    const people = [OWNER, MANAGER];
    await writeFile(join(dataDir, 'store-pack.json'), JSON.stringify({
      version: 1,
      policies: { storeId: STORE, branchId: STORE, branchName: 'Test store', warehouseId: null, tradingDayCutoff: '00:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 0 },
      lossPreventionRules: [],
      people: people.map((p) => ({ userId: p.userId, displayName: p.userId, roleId: p.roleId })),
      roles: ROLE_CATALOGUE.filter((r) => r.id === 'owner' || r.id === 'store_manager'),
      roleAssignments: people.map((p) => ({ userId: p.userId, roleId: p.roleId, branchScope: [STORE] })),
    }), 'utf8');
    const at = new Date().toISOString();
    await writeFile(join(dataDir, 'till-credentials.json'), JSON.stringify({ version: 1, credentials: people.map((p) => issueTillCredential({ userId: p.userId, pin: p.pin, key: tillPinKey(KEY), issuedAt: at, issuedBy: 'test' })) }), { mode: 0o600 });
    const policy = TEST_IDP.policy();
    const started = await startEdge({
      EDGE_DATA_DIR: dataDir, EDGE_TENANT_ID: T, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_LANE_ID: 'lane-1', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: join(dataDir, 'store-pack.json'),
      EDGE_OFFICE_SIGN_IN: 'pin', EDGE_STORE_ID: STORE,
      EDGE_OFFICE_HEAD_OFFICE: 'this-pc', CLOUD_API_URL: apiBase, IDP_SIGNING_KEY: policy.secret, IDP_ISSUER: policy.issuer, IDP_AUDIENCE: policy.audience,
      EDGE_IMPORTS_DIR: join(dataDir, 'imports'), MIGRATION_TARGET_KIND: 'rehearsal',
    }, () => {});
    if (started === undefined || started.screens === null || started.screens === undefined) throw new Error('the box did not start');
    edge = started;
    base = `http://127.0.0.1:${started.screens.port}`;
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 120_000);
  afterAll(async () => { await browser?.close(); await edge?.stop(); await new Promise<void>((r) => api.close(() => r())); });

  const signedIn = async (who: { userId: string; pin: string }, path: string): Promise<Page> => {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true })).newPage();
    await page.goto(`${base}${path}`, { waitUntil: 'load' });
    await page.fill('#office-staff', who.userId);
    await page.fill('#office-pin', who.pin);
    await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('#office-submit')]);
    return page;
  };
  const answer = async (page: Page): Promise<string> => { await page.waitForSelector('#answer:not([hidden])'); return page.innerText('#answer'); };

  it('add a person by two people, their own PIN, an Excel-safe export, and the import inside the Office app', { timeout: 120_000 }, async () => {
    // 1 — the menu's Users & roles opens the office centre; the manager asks for a new person's first role.
    const mgr = await signedIn(MANAGER, '/users');
    expect(new URL(mgr.url()).pathname).toBe('/people/');
    await mgr.waitForSelector('#give-role option[value="cashier"]', { state: 'attached' });
    expect(await mgr.innerText('h1')).toContain('பயனர்களும் பங்குகளும்');
    await mgr.fill('#give-user', NEW);
    await mgr.fill('#give-name', 'Test Person');
    await mgr.selectOption('#give-role', 'cashier');
    await mgr.fill('#give-why', 'new cashier for the evening');
    await mgr.click('#give-form button[type=submit]');
    expect(await answer(mgr)).toContain('Type your own six-digit PIN'); // no PIN: nothing done
    await mgr.fill('#pin', MANAGER.pin);
    await mgr.click('#give-form button[type=submit]');
    await mgr.waitForFunction(() => (globalThis as unknown as { document: { getElementById(i: string): { textContent: string } } }).document.getElementById('answer').textContent.includes('Asked, in your name'));
    expect(await mgr.inputValue('#pin')).toBe(''); // the PIN never stays on the screen

    // 2 — the owner approves it with his own PIN.
    const own = await signedIn(OWNER, '/people/');
    const row = own.locator('#decide-list .item', { hasText: NEW });
    await row.waitFor();
    await own.fill('#pin', OWNER.pin);
    await row.getByRole('button', { name: /Approve/ }).click();
    expect(await answer(own)).toContain('Approved — the role is given');
    await own.locator('#holder-list .item', { hasText: NEW }).waitFor();
    expect(await own.locator('#holder-list .item', { hasText: NEW }).innerText()).toContain('No PIN yet');

    // 3 — the new person types their own first PIN; the till's PIN file now holds it.
    await mgr.reload({ waitUntil: 'load' });
    await mgr.waitForSelector('#pin-form');
    await mgr.fill('#pin', MANAGER.pin);
    await mgr.fill('#pin-user', NEW);
    await mgr.fill('#pin-new', '583920');
    await mgr.fill('#pin-again', '583920');
    await mgr.click('#pin-form button[type=submit]');
    expect(await answer(mgr)).toContain('Their own PIN is set');
    const creds = readTillCredentials(JSON.parse(readFileSync(join(dataDir, 'till-credentials.json'), 'utf8')) as unknown);
    expect(creds.get(NEW)).toMatchObject({ userId: NEW, issuedBy: MANAGER.userId });
    expect(readFileSync(join(dataDir, 'till-credentials.json'), 'utf8')).not.toContain('583920');

    // 4 — the owner exports products: the download is Excel-safe and in his name.
    const io = await signedIn(OWNER, '/data-io');
    expect(new URL(io.url()).pathname).toBe('/import-export/');
    await io.waitForSelector('#domain option[value="products"]', { state: 'attached' });
    await io.selectOption('#domain', 'products');
    await io.fill('#pin', OWNER.pin);
    const [download] = await Promise.all([io.waitForEvent('download'), io.click('#export-form button[type=submit]')]);
    expect(download.suggestedFilename()).toMatch(/^products-\d{4}-\d{2}-\d{2}\.csv$/);
    const file = readFileSync((await download.path())!);
    expect([...file.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    await io.locator('#log .item', { hasText: 'products' }).first().waitFor();

    // 5 — the old-system import opens inside the Office app, signed in as the office person (no second sign-in).
    await io.click('a[href="/import/"]');
    await io.waitForSelector('#start:not([hidden])');
    expect(await io.innerText('#who')).toContain(`Signed in: ${OWNER.userId}`);
    expect(await io.innerText('h1')).toContain('பழைய அமைப்பிலிருந்து இறக்குமதி');

    // The Office centre's own log on this PC has every act, and never a PIN.
    const log = readFileSync(join(dataDir, 'office-centre.log'), 'utf8');
    expect(log).toContain('"outcome":"approved"');
    for (const pin of [OWNER.pin, MANAGER.pin, '583920']) expect(log).not.toContain(pin);
  });
});
