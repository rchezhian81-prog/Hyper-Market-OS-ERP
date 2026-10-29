import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { issueTillPins, pinOf } from '../support/till-operator';
import { startStandInIdentityServer, standInPerson, type StandInIdentityServer, type StandInPerson } from '../support/stand-in-identity-server';
import { startStandInHeadOffice, type StandInHeadOffice } from '../support/stand-in-head-office';
import { ROLE_CATALOGUE } from '../../services/api/src/roles';

/**
 * **Round 10 · R10-A in a real browser on the REAL store computer (office PIN on, head office's sign-in on).**
 *   • OB-540 — the Devices page shows head office's list of handheld work done on a withdrawn or too-old app version, read
 *     through the store computer as the person: first "Not known" with no head-office sign-in (the store computer's own
 *     words), then the finding (which handheld, version, what was done, when, the finding) after the person signs in, in
 *     English and Tamil; then "head office could not be reached" when head office goes down — never an empty "all well".
 *   • OB-543 — the ACCOUNTANT (her real role words: no stock read) opens the goods-receipt screen on the store computer, the page
 *     reads the screen's own narrow list, and she presses "Match the bill"; the person who RECEIVED the goods gets no button;
 *     the chartered accountant (who holds neither word) may not open the screen at all.
 * A stand-in identity server and head office answer on their own sites. Skips where no browser binary is present.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['r10a', 'devices', 'accountant', 'key'].join('-').padEnd(48, '0');
const TENANT = 't-sre';
const AT = '2030-06-01T04:30:00.000Z';

const FINDING = {
  exceptionId: 'ex-1', kind: 'handheld_work_on_an_unsupported_app_version', severity: 'material', verdict: 'version_killed', client: 'picker',
  appVersion: '1.2.0', markedByStoreComputer: 'version_killed', route: '/v1/fulfilment/waves/:waveId/lines/:lineId/synced',
  recordRef: 'waveId=W-7&lineId=L-3#abc123', store: 'store-1', relayedBy: 'u-box', at: AT,
  detail: 'The record waveId=W-7&lineId=L-3 was done on the picker on app 1.2.0, which head office has withdrawn (the store computer marked it too)',
  ownerAction: 'Update that handheld.',
};
const receipt = (billCosts: unknown[] | undefined) => ({
  grnId: 'g-1', number: 'GRN-7', poId: null, warehouseId: 'store-1', receivedBy: 'u-recv', receivedAt: AT, availableMinor: 10,
  captured: {
    requiresApproval: false, discrepancyValue: { minor: 0, currency: 'INR' }, discrepancies: [],
    lines: [{ lineId: 'L1', productId: 'p-brm', sellableMinor: 10, quarantinedMinor: 0, rejectedMinor: 0, disposition: 'sellable', uom: 'ea', batchId: null, expiry: null, unitCost: { minor: 0, currency: 'INR' }, costNotKnown: true }],
  },
  costNotKnown: [{ lineId: 'L1', productId: 'p-brm', quantityMinor: 10, uom: 'ea', because: 'no_issued_order', detail: 'x' }],
  ...(billCosts === undefined ? {} : { billCosts }),
});
const MATCHED = { lineId: 'L1', productId: 'p-brm', invoiceId: 'INV-1', unitCost: { minor: 4_200, currency: 'INR' }, quantityMinor: 10, valueMinor: 42_000, matchedBy: 'u-acct', matchedAt: AT };
const permissionsOf = (roleId: string): readonly string[] => ROLE_CATALOGUE.find((r) => r.id === roleId)!.permissions;

interface Doc { readonly document: { readonly body: { readonly innerText: string } } }

describe.skipIf(!HAVE_BROWSER)('R10-A: the Devices page\'s handheld-version section and the accountant\'s goods-receipt screen, on the store computer', () => {
  let browser: Browser;
  let idp: StandInIdentityServer;
  let ho: StandInHeadOffice;
  let edge: EdgeProcess;
  let dir = '';
  let matched = false;
  const people: Record<string, StandInPerson> = Object.fromEntries(['u-mgr', 'u-acct', 'u-recv', 'u-ca'].map((id) => [id, standInPerson({ sreUserId: id, tenantId: TENANT })]));

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    idp = await startStandInIdentityServer();
    for (const p of Object.values(people)) idp.people.set(p.username, p);
    ho = await startStandInHeadOffice({
      issuer: idp.issuer, publicKey: idp.publicKey, tenantId: TENANT, machineToken: randomBytes(24).toString('hex'),
      versionExceptions: () => ({ material: [FINDING], informational: 1, informationalExceptions: [], asAt: AT }),
      versionExceptionReaders: ['u-mgr'],
      answer: ({ method, path, as, body }) => {
        // OB-543: the accountant holds no stock read — head office refuses her the broad list, and answers the screen's own.
        if (method === 'GET' && path === '/v1/inventory/goods-receipt') {
          return as === 'u-acct' ? { status: 403, body: { error: { code: 'forbidden', whatHappened: 'This account does not hold "inventory.availability.read".' } } }
            : { status: 200, body: { receipts: [receipt(matched ? [MATCHED] : undefined)], count: 1, needingApprovalCount: 0 } };
        }
        if (method === 'GET' && path === '/v1/inventory/goods-receipt-review') {
          return as === 'u-acct' ? { status: 200, body: { receipts: [receipt(matched ? [MATCHED] : undefined)], count: 1, needingApprovalCount: 0 } }
            : { status: 403, body: { error: { code: 'forbidden', whatHappened: 'This account does not hold "inventory.goodsreceipt.read".' } } };
        }
        if (method === 'POST' && path === '/v1/inventory/goods-receipt/g-1/bill-match') {
          if (as === 'u-recv') return { status: 403, body: { error: { code: 'self_match', whatHappened: 'u-recv received these goods.' } } };
          if ((JSON.parse(body) as { invoiceId?: string }).invoiceId !== 'INV-1') return { status: 404, body: { error: { code: 'bill_unknown', whatHappened: 'No such supplier bill.' } } };
          matched = true;
          return { status: 201, body: { grnId: 'g-1', matched: [MATCHED], stillNotKnown: [], alreadyMatched: false } };
        }
        return undefined;
      },
    });
    dir = await mkdtemp(join(tmpdir(), 'sre-r10a-'));
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, JSON.stringify({
      version: 1, lossPreventionRules: [],
      policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1', timeZone: 'Asia/Kolkata' },
      fleetPolicy: { permissions: [] }, goodsReceiptPolicy: { permissions: [] },
      people: [
        { userId: 'u-mgr', displayName: 'Manager Person', roleId: 'store_manager' }, { userId: 'u-acct', displayName: 'Accountant Person', roleId: 'accountant' },
        { userId: 'u-recv', displayName: 'Receiver Person', roleId: 'store_manager' }, { userId: 'u-ca', displayName: 'CA Person', roleId: 'chartered_accountant' },
      ],
      roles: [
        { id: 'store_manager', name: 'Store manager', permissions: ['identity.self.read', 'platform.health.read', 'inventory.availability.read', 'purchase.invoice.match'] },
        // The accountant's REAL words from the role catalogue — no `inventory.availability.read`.
        { id: 'accountant', name: 'Accountant', permissions: permissionsOf('accountant') },
        { id: 'chartered_accountant', name: 'Chartered accountant', permissions: permissionsOf('chartered_accountant') },
      ],
      roleAssignments: [
        { userId: 'u-mgr', roleId: 'store_manager', branchScope: ['store-1'] }, { userId: 'u-acct', roleId: 'accountant', branchScope: ['store-1'] },
        { userId: 'u-recv', roleId: 'store_manager', branchScope: ['store-1'] }, { userId: 'u-ca', roleId: 'chartered_accountant', branchScope: ['store-1'] },
      ],
    }), 'utf8');
    await issueTillPins(dir, KEY, Object.keys(people));
    edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_PACK_FILE: packFile,
      EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_OFFICE_SIGN_IN: 'pin',
      CLOUD_API_URL: ho.base, CLOUD_API_TOKEN: randomBytes(24).toString('hex'), EDGE_HEAD_OFFICE_SIGN_IN_ISSUER: idp.issuer,
    }, () => {}))!;
  }, 240_000);
  afterAll(async () => {
    await browser?.close();
    await edge?.stop();
    await ho?.stop();
    await idp?.stop();
    if (dir !== '') await rm(dir, { recursive: true, force: true });
  });

  const base = (): string => `http://127.0.0.1:${edge.screens!.port}`;
  const says = (page: Page, selector: string, text: string) => page.waitForFunction(([sel, want]) => {
    const node = (globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector(sel!);
    return (node?.textContent ?? '').includes(want!);
  }, [selector, text], { timeout: 15_000 });
  /** The office PIN on the store PC, at a page; the page then opens (or says the person may not open it). */
  const pinAt = async (page: Page, path: string, userId: string): Promise<void> => {
    await page.goto(`${base()}${path}`, { waitUntil: 'load' });
    await page.fill('#office-staff', userId);
    await page.fill('#office-pin', pinOf(userId));
    await Promise.all([page.waitForLoadState('load'), page.click('#office-submit')]);
  };
  /** The person's own head-office sign-in on this PC: password AND the one-time code, then back to the page. */
  const headOfficeSignIn = async (page: Page, path: string, userId: string): Promise<void> => {
    const person = people[userId]!;
    await page.goto(`${base()}/login/?next=${encodeURIComponent(path)}`, { waitUntil: 'load' });
    await page.fill('#username', person.username);
    await page.fill('#password', person.password);
    await page.fill('#otp', person.otp!);
    await Promise.all([page.waitForURL(`${base()}${path}`), page.click('#kc-login')]);
  };
  const fresh = async (): Promise<{ context: BrowserContext; page: Page; errors: string[] }> => {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    return { context, page, errors };
  };

  it('OB-543: the accountant opens the goods-receipt screen, reads its own narrow list and matches the bill; the receiver gets no button; the chartered accountant may not open it', async () => {
    // The accountant: PIN, then her own head-office sign-in, on the goods-receipt screen.
    const a = await fresh();
    await pinAt(a.page, '/goods-receipt/', 'u-acct');
    expect(await a.page.textContent('body')).not.toContain('may not open this screen');
    await headOfficeSignIn(a.page, '/goods-receipt/', 'u-acct');
    await says(a.page, '#rows .bill-match-btn', 'Match the bill');
    // The page read the screen's OWN list as her — never the broad stock read.
    expect(ho.calls.filter((c) => c.path.startsWith('/v1/inventory/goods-receipt') && c.method === 'GET').map((c) => [c.path, c.as])).toEqual([['/v1/inventory/goods-receipt-review', 'u-acct']]);
    expect(await a.page.$('#rows .bill-match-btn svg')).not.toBeNull();
    await a.page.fill('#rows .bill-invoice', 'INV-1');
    await a.page.click('#rows .bill-match-btn');
    await says(a.page, '#result-text', 'Bill matched to this delivery.');
    await says(a.page, '#rows .bill-match', 'Bill INV-1 matched: p-brm at ₹42.00 each — by u-acct');
    expect(ho.calls.filter((c) => c.method === 'POST' && c.path === '/v1/inventory/goods-receipt/g-1/bill-match').map((c) => [c.as, c.body])).toEqual([['u-acct', JSON.stringify({ invoiceId: 'INV-1' })]]);
    await a.page.click('#lang');
    await says(a.page, '#rows .bill-match', 'பில் INV-1 பொருத்தப்பட்டது: p-brm ஒன்றுக்கு ₹42.00 — பொருத்தியவர் u-acct');
    expect(a.errors).toEqual([]);
    await a.context.close();

    // The person who RECEIVED the goods: the screen says someone else matches it — no button, nothing sent.
    matched = false;
    const r = await fresh();
    await pinAt(r.page, '/goods-receipt/', 'u-recv');
    await headOfficeSignIn(r.page, '/goods-receipt/', 'u-recv');
    await says(r.page, '#rows .bill-match', 'You received these goods, so someone else (the buyer or the accountant) matches their supplier bill.');
    expect(await r.page.$('#rows .bill-match-btn')).toBeNull();
    expect(ho.calls.filter((c) => c.method === 'POST' && c.as === 'u-recv')).toEqual([]);
    expect(r.errors).toEqual([]);
    await r.context.close();

    // The chartered accountant (an office role, her real words) holds neither word: the store computer will not open the screen.
    const c = await fresh();
    await pinAt(c.page, '/goods-receipt/', 'u-ca');
    await says(c.page, '#office-heading', 'CA Person may not open this screen');
    await c.context.close();
  }, 180_000);

  it('OB-540: the Devices page says "Not known" without a head-office sign-in, lists the finding after it (English and Tamil), and says head office could not be reached when it is down', async () => {
    const { context, page, errors } = await fresh();
    await pinAt(page, '/fleet/', 'u-mgr');
    // 1 — no head-office sign-in on this PC: the store computer refuses to carry the read; the section says it is not known.
    await says(page, '#vx-text', 'Not known — this computer has no head-office sign-in for you.');
    expect(await page.textContent('#vx-h')).toBe('Handheld work on a withdrawn or too-old app version');
    expect(await page.$$('#vx-rows li')).toHaveLength(0);
    expect(await page.textContent('#vx-text')).not.toContain('No handheld work was done');

    // 2 — the manager signs in to head office with their own login and second step: head office's finding is listed.
    await headOfficeSignIn(page, '/fleet/', 'u-mgr');
    await says(page, '#vx-text', '1 piece(s) of handheld work were done on a withdrawn or too-old version');
    const row = await page.textContent('#vx-rows li');
    for (const want of ['Picker\'s handheld', '1.2.0', 'A pick on a wave line (record waveId=W-7&lineId=L-3)', '2030-06-01 10:00', 'Version withdrawn by head office (the store computer marked it too)']) expect(row).toContain(want);
    await says(page, '#vx-info', '1 record(s) came from a handheld too old to report its version');
    expect(ho.calls.filter((c) => c.path === '/v1/platform/handheld-work/version-exceptions').at(-1)).toMatchObject({ as: 'u-mgr', cookie: false });
    await page.click('#lang');
    await says(page, '#vx-h', 'திரும்பப் பெற்ற அல்லது மிகப் பழைய செயலிப் பதிப்பில் கைக்கருவி செய்த பணி');
    await says(page, '#vx-rows li', 'பொருள் எடுப்பவரின் கைக்கருவி');
    await says(page, '#vx-rows li', 'தலைமை அலுவலகம் திரும்பப் பெற்ற பதிப்பு');

    // 3 — head office goes down: the section says it could not be reached — the old finding is NOT shown as current.
    await ho.stop();
    await page.goto(`${base()}/fleet/`, { waitUntil: 'load' });
    await says(page, '#vx-text', 'head office could not be reached');
    expect(await page.$$('#vx-rows li')).toHaveLength(0);
    expect((await page.evaluate(() => (globalThis as unknown as Doc).document.body.innerText))).not.toContain('No handheld work was done');
    expect(errors).toEqual([]);
    await context.close();
  }, 180_000);
});
