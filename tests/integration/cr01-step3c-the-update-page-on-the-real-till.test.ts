import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { openFileLog, readLog } from '../../edge/store-edge/src/file-log';
import { UPDATE_LOG, UPDATE_PATHS, UPDATE_PROGRESS_FILE, UPDATE_REQUEST_FILE, UPDATER_MARK_FILE } from '../../edge/store-edge/src/update-page';
import { prepareTillBox, pinOf } from '../support/till-operator';

/**
 * **CR-01 step 3c · OI-05 · OB-718 · OB-719 on the REAL till service (`startEdge`), office PIN sign-in on.**
 *
 *   /update/ shows what the last update check found (status\update-check.json beside the store computer's status file);
 *   the owner — signed in with his own PIN — types his PIN again and the request is written to update-requests.log and
 *   left as update-request.json; the store manager sees the page but no button and is refused; a wrong PIN is refused;
 *   an open till shift (a float issued in this box's own till-cash log) refuses the request; a request from another
 *   site is refused; and nobody signed in is sent to the sign-in page. Every outcome is in the log.
 */

const KEY = ['cr01', '3c', 'update', 'page'].join('-').padEnd(48, '0');
const PACK = {
  version: 1,
  policies: { storeId: 'store-1', branchId: 'store-1', tradingDayCutoff: '00:00', warehouseId: 'wh-1' },
  lossPreventionRules: [], devices: [],
  roles: [
    { id: 'owner', name: 'Owner', permissions: ['identity.self.read', 'platform.setup.write'] },
    { id: 'store_manager', name: 'Store manager', permissions: ['identity.self.read', 'pos.sale.sync'] },
  ],
  roleAssignments: [{ userId: 'u-owner', roleId: 'owner', branchScope: 'all' }, { userId: 'u-mgr', roleId: 'store_manager', branchScope: 'all' }],
};
const READY = { kind: 'sre-store-pc-update-check-v1', checkedAt: '2026-11-12T03:00:00.000Z', running: '1.0.2005', withKey: false, state: 'available', latest: '1.0.2012', tag: 'store-pc-v1.0.2012', commit: 'a'.repeat(40), sha256: 'b'.repeat(64), said: 'version 1.0.2012 is ready, signed and checked' };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

async function box(opts: { openShift?: boolean } = {}): Promise<{ edge: EdgeProcess; dir: string; url: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'sre-cr01-3c-'));
  cleanups.push(async () => { await rm(dir, { recursive: true, force: true }); await rm(`${dir}-witness`, { recursive: true, force: true }); });
  const env = await prepareTillBox({ dir, key: KEY, pack: PACK, people: [{ userId: 'u-owner', displayName: 'The Owner' }, { userId: 'u-mgr', displayName: 'Manager' }, { userId: 'u-lanecash', displayName: 'Lane Cashier' }] });
  const statusDir = join(dir, 'status');
  await mkdir(statusDir, { recursive: true });
  await writeFile(join(statusDir, 'update-check.json'), JSON.stringify(READY), 'utf8');
  if (opts.openShift === true) {
    const cash = await openFileLog({ dataDir: dir, capacityBytes: 10_485_760, fileName: 'till-cash.log' });
    await cash.append(JSON.stringify({ kind: 'movement', movementId: 'cm-1', tillId: 'lane-1', laneId: 'lane-1', movementKind: 'float_issue', amountMinor: 200_000, deltaMinor: 200_000, currency: 'INR', custodianId: 'u-lanecash', performedBy: 'u-mgr', tradingDay: '2026-11-12', at: '2026-11-12T03:30:00.000Z' }));
    await cash.close();
  }
  const edge = (await startEdge({
    EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
    EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_OFFICE_SIGN_IN: 'pin',
    EDGE_STORE_COMPUTER_STATUS_FILE: join(statusDir, 'store-computer-status.json'), ...env,
  }, () => {}))!;
  cleanups.push(async () => { await edge.stop(); });
  return { edge, dir, url: `http://127.0.0.1:${edge.screens!.port}` };
}

async function signIn(url: string, userId: string): Promise<string> {
  const r = await fetch(`${url}/office/sign-in`, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ staffId: userId, pin: pinOf(userId), next: UPDATE_PATHS.page }).toString(),
  });
  expect(r.status).toBe(303);
  expect(r.headers.get('location')).toBe(UPDATE_PATHS.page);
  return r.headers.get('set-cookie')!.split(';')[0]!;
}

const ask = (url: string, cookie: string | undefined, pin: string, site = 'same-origin'): Promise<Response> => fetch(`${url}${UPDATE_PATHS.request}`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': site, ...(cookie === undefined ? {} : { cookie }) }, body: JSON.stringify({ pin }),
});

const logged = async (dir: string): Promise<Record<string, unknown>[]> =>
  (await readLog(join(dir, UPDATE_LOG))).flatMap((r) => (r.ok ? [JSON.parse(r.record) as Record<string, unknown>] : []));

describe('the Software update page on the real till (CR-01 step 3c)', () => {
  it('the owner sees the ready version, confirms with his own PIN, and the request is written down and left for the updater', async () => {
    const { url, dir } = await box();
    expect((await fetch(`${url}${UPDATE_PATHS.page}`)).status).toBe(401); // nobody signed in → the sign-in page
    const cookie = await signIn(url, 'u-owner');
    const page = await fetch(`${url}${UPDATE_PATHS.page}`, { headers: { cookie } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('A new version is ready: 1.0.2012');
    expect(html).toContain('id="update-button"');
    expect(html).toContain('The Owner');

    const wrong = await ask(url, cookie, '000000');
    expect(wrong.status).toBe(403);
    expect(await wrong.json()).toMatchObject({ ok: false, refusedBecause: 'pin_not_confirmed' });
    expect(existsSync(join(dir, UPDATE_REQUEST_FILE))).toBe(false);

    const right = await ask(url, cookie, pinOf('u-owner'));
    expect(right.status).toBe(200);
    expect(await right.json()).toMatchObject({ ok: true, version: '1.0.2012' });
    const left = JSON.parse(await readFile(join(dir, UPDATE_REQUEST_FILE), 'utf8'));
    expect(left).toMatchObject({ kind: 'sre-store-pc-update-request-v1', requestedBy: 'u-owner', version: '1.0.2012', commit: 'a'.repeat(40), sha256: 'b'.repeat(64), from: '1.0.2005' });

    const log = await logged(dir);
    expect(log.map((r) => r['outcome'])).toEqual(['refused:pin_not_confirmed', 'requested']);
    expect(JSON.stringify(log)).not.toContain(pinOf('u-owner'));
  });

  it('the store manager sees the page but no button, and a request in his name is refused as not the owner', async () => {
    const { url, dir } = await box();
    const cookie = await signIn(url, 'u-mgr');
    const html = await (await fetch(`${url}${UPDATE_PATHS.page}`, { headers: { cookie } })).text();
    expect(html).toContain('Only the owner may update the store computer.');
    expect(html).not.toContain('id="update-button"');
    const r = await ask(url, cookie, pinOf('u-mgr'));
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ refusedBecause: 'not_the_owner' });
    expect(existsSync(join(dir, UPDATE_REQUEST_FILE))).toBe(false);
    expect((await logged(dir)).map((x) => [x['userId'], x['outcome']])).toEqual([['u-mgr', 'refused:not_the_owner']]);
  });

  it('OB-718: an open till shift refuses the owner\'s request, naming the till', async () => {
    const { url, dir } = await box({ openShift: true });
    const cookie = await signIn(url, 'u-owner');
    const html = await (await fetch(`${url}${UPDATE_PATHS.page}`, { headers: { cookie } })).text();
    expect(html).toContain('lane-1 — u-lanecash');
    expect(html).toMatch(/id="update-button" disabled/);
    const r = await ask(url, cookie, pinOf('u-owner'));
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ refusedBecause: 'shift_open' });
    expect(existsSync(join(dir, UPDATE_REQUEST_FILE))).toBe(false);
  });

  it('a request from another site, or with nobody signed in, is refused', async () => {
    const { url, dir } = await box();
    const cookie = await signIn(url, 'u-owner');
    expect((await ask(url, cookie, pinOf('u-owner'), 'cross-site')).status).toBe(403);
    const anon = await ask(url, undefined, pinOf('u-owner'));
    expect(anon.status).toBe(401);
    expect(existsSync(join(dir, UPDATE_REQUEST_FILE))).toBe(false);
  });

  it('the About screen links to the Software update page', async () => {
    const { url } = await box();
    expect(await (await fetch(`${url}/about/`)).text()).toContain('href="/update/"');
  });
});

describe('CR-01 step 3d on the real till: the updater\'s question, and its word on the page', () => {
  it('OB-718: /update/open-shifts answers the updater from this box\'s own till-cash log — till ids only, no sign-in needed on this PC', async () => {
    const shut = await box();
    expect(await (await fetch(`${shut.url}${UPDATE_PATHS.openShifts}`)).json()).toEqual({ kind: 'sre-open-shifts-v1', open: [] });
    const open = await box({ openShift: true });
    const r = await fetch(`${open.url}${UPDATE_PATHS.openShifts}`);
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(JSON.parse(text)).toEqual({ kind: 'sre-open-shifts-v1', open: [{ tillId: 'lane-1' }] });
    expect(text).not.toContain('u-lanecash');
    expect((await fetch(`${open.url}${UPDATE_PATHS.openShifts}`, { method: 'POST' })).status).toBe(405);
  });

  it('with the updater set up: a waiting request hides the button; the updater\'s word is shown', async () => {
    const { url, dir } = await box();
    await writeFile(join(dir, 'status', UPDATER_MARK_FILE), JSON.stringify({ kind: 'sre-store-pc-updater-v1' }), 'utf8');
    const cookie = await signIn(url, 'u-owner');
    let html = await (await fetch(`${url}${UPDATE_PATHS.page}`, { headers: { cookie } })).text();
    expect(html).toContain('id="updater-note"');
    expect(html).not.toContain('id="updater-pending"');
    expect((await ask(url, cookie, pinOf('u-owner'))).status).toBe(200);
    html = await (await fetch(`${url}${UPDATE_PATHS.page}`, { headers: { cookie } })).text();
    expect(html).toContain('id="waiting"');
    expect(html).not.toContain('id="update-button"');
    await rm(join(dir, UPDATE_REQUEST_FILE));
    await writeFile(join(dir, 'status', UPDATE_PROGRESS_FILE), JSON.stringify({ kind: 'sre-store-pc-update-progress-v1', at: '2026-11-12T04:20:00.000Z', version: '1.0.2012', from: '1.0.2005', state: 'rolled-back', said: 'Version 1.0.2005 was put back by itself and every check passed.' }), 'utf8');
    html = await (await fetch(`${url}${UPDATE_PATHS.page}`, { headers: { cookie } })).text();
    expect(html).toContain('the old version was put back by itself');
    expect(html).toContain('Version 1.0.2005 was put back by itself and every check passed.');
  });

  it('with no updater set up on this PC, the page says so beside the button', async () => {
    const { url } = await box();
    const cookie = await signIn(url, 'u-owner');
    const html = await (await fetch(`${url}${UPDATE_PATHS.page}`, { headers: { cookie } })).text();
    expect(html).toContain('id="updater-pending"');
  });
});
