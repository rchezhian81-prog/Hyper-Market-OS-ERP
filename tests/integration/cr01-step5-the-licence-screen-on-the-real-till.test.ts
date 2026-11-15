import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { LICENCE_PATHS } from '../../edge/store-edge/src/licence-page';
import { UPDATE_PATHS, UPDATE_REQUEST_FILE } from '../../edge/store-edge/src/update-page';
import { gstinOk, signLicence, type LicenceTerms } from '../../scripts/lib/licence.mjs';
import { prepareTillBox, pinOf } from '../support/till-operator';

/**
 * **CR-01 step 5 · OI-10 · OB-710 on the REAL till service (`startEdge`), office PIN sign-in on.**
 *
 *   /licence/ (About / Licence) shows the licence's standing on the shop's day, in English and Tamil; the OWNER loads the
 *   licence file the seller sent with his own PIN again, checked OFFLINE against the public key the release carries; a
 *   forged, edited or copied licence is refused by name; the store manager sees the screen but cannot load; every load and
 *   refusal is in the licence history; the request to send the seller downloads. While there is no licence, every office
 *   page carries one notice; the till's own screen never does. In REDUCED mode the Software update page refuses (OB-750)
 *   — and the till still sells. Synthetic data only.
 */

const KEY = ['cr01', '5', 'licence', 'screen'].join('-').padEnd(48, '0');
const TENANT = '0b6f1c2e-6a57-4f0a-9d3b-2f4a1e7c9d10';
const GSTIN = ((): string => { for (const c of '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ') { const g = `33ABCDE1234F1Z${c}`; if (gstinOk(g)) return g; } throw new Error('x'); })();
const seller = generateKeyPairSync('ed25519');
const PRIV = seller.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const PUB = seller.publicKey.export({ type: 'spki', format: 'pem' }) as string;
const terms = (over: Partial<LicenceTerms> = {}): LicenceTerms => ({ licenceId: 'LIC-20261114-00000001', kind: 'shop', tenantId: TENANT, shopName: 'Test Shop Two', gstin: GSTIN, tills: 2, stores: 1, modules: ['all'], issuedOn: '2026-11-14', expiresOn: '2099-11-13', ...over });

const PACK = {
  version: 1,
  policies: { storeId: 'store-1', branchId: 'store-1', tradingDayCutoff: '00:00', warehouseId: 'wh-1' },
  lossPreventionRules: [], devices: [],
  roles: [
    { id: 'owner', name: 'Owner', permissions: ['identity.self.read', 'platform.setup.write', 'erp.dashboard.view'] },
    { id: 'store_manager', name: 'Store manager', permissions: ['identity.self.read', 'pos.sale.sync', 'erp.dashboard.view'] },
  ],
  roleAssignments: [{ userId: 'u-owner', roleId: 'owner', branchScope: 'all' }, { userId: 'u-mgr', roleId: 'store_manager', branchScope: 'all' }],
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

/** A till box whose RELEASE folder carries the seller's public key (or none), its apps linked from the repository. */
async function box(opts: { key?: boolean; firstSeenOn?: string; update?: boolean } = {}): Promise<{ edge: EdgeProcess; dir: string; url: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'sre-cr01-5-'));
  const release = await mkdtemp(join(tmpdir(), 'sre-cr01-5-release-'));
  cleanups.push(async () => { await rm(dir, { recursive: true, force: true }); await rm(`${dir}-witness`, { recursive: true, force: true }); await rm(release, { recursive: true, force: true }); });
  await symlink(resolve('apps'), join(release, 'apps'), 'dir');
  if (opts.key !== false) await writeFile(join(release, 'licence-signing.pub'), PUB);
  if (opts.firstSeenOn !== undefined) {
    await mkdir(join(dir, 'licence'), { recursive: true });
    await writeFile(join(dir, 'licence', 'licensing-first-seen.json'), JSON.stringify({ kind: 'sre-licensing-first-seen-v1', firstSeenOn: opts.firstSeenOn }));
  }
  const env = await prepareTillBox({ dir, key: KEY, pack: PACK, people: [{ userId: 'u-owner', displayName: 'The Owner' }, { userId: 'u-mgr', displayName: 'Manager' }] });
  const statusDir = join(dir, 'status');
  await mkdir(statusDir, { recursive: true });
  if (opts.update === true) {
    await writeFile(join(statusDir, 'update-check.json'), JSON.stringify({ kind: 'sre-store-pc-update-check-v1', checkedAt: '2026-11-12T03:00:00.000Z', running: '1.0.2005', withKey: false, state: 'available', latest: '1.0.2012', tag: 'store-pc-v1.0.2012', commit: 'a'.repeat(40), sha256: 'b'.repeat(64), said: 'ready' }), 'utf8');
  }
  const edge = (await startEdge({
    EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
    EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: join(release, 'apps'), EDGE_OFFICE_SIGN_IN: 'pin',
    EDGE_STORE_COMPUTER_STATUS_FILE: join(statusDir, 'store-computer-status.json'), ...env,
  }, () => {}))!;
  cleanups.push(async () => { await edge.stop(); });
  return { edge, dir, url: `http://127.0.0.1:${edge.screens!.port}` };
}

async function signIn(url: string, userId: string): Promise<string> {
  const r = await fetch(`${url}/office/sign-in`, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ staffId: userId, pin: pinOf(userId), next: LICENCE_PATHS.page }).toString(),
  });
  expect(r.status).toBe(303);
  return r.headers.get('set-cookie')!.split(';')[0]!;
}

const load = (url: string, cookie: string | undefined, pin: string, licence: string, site = 'same-origin'): Promise<Response> => fetch(`${url}${LICENCE_PATHS.load}`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': site, ...(cookie === undefined ? {} : { cookie }) }, body: JSON.stringify({ pin, licence }),
});

const history = async (dir: string): Promise<Record<string, unknown>[]> =>
  (await readFile(join(dir, 'licence', 'licence-history.log'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);

describe('the Licence screen on the real till (CR-01 step 5)', () => {
  it('the owner loads the seller\'s licence with his own PIN; the screen then says Licensed, in English and Tamil', async () => {
    const { url, dir } = await box();
    expect((await fetch(`${url}${LICENCE_PATHS.page}`)).status).toBe(401);
    const cookie = await signIn(url, 'u-owner');
    const before = await (await fetch(`${url}${LICENCE_PATHS.page}`, { headers: { cookie } })).text();
    expect(before).toContain('data-state="no_licence"');
    expect(before).toContain('இன்னும் உரிமம் ஏற்றப்படவில்லை');
    expect(before).toContain('id="licence-form"');
    expect(before).toContain('the till keeps selling');

    const wrongPin = await load(url, cookie, '000000', signLicence(terms(), PRIV));
    expect(wrongPin.status).toBe(403);
    expect(await wrongPin.json()).toMatchObject({ refusedBecause: 'pin_not_confirmed' });

    const ok = await load(url, cookie, pinOf('u-owner'), signLicence(terms(), PRIV));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true });
    const after = await (await fetch(`${url}${LICENCE_PATHS.page}`, { headers: { cookie } })).text();
    expect(after).toContain('data-state="valid"');
    expect(after).toContain('Test Shop Two');
    expect(after).toContain('LIC-20261114-00000001');
    const h = await history(dir);
    expect(h.map((x) => x['outcome'])).toEqual(['refused:pin_not_confirmed', 'loaded']);
    expect(h[1]).toMatchObject({ by: 'u-owner', via: 'licence_screen' });
    expect(JSON.stringify(h)).not.toContain(pinOf('u-owner'));
  });

  it.each([
    ['forged (another key)', () => signLicence(terms(), generateKeyPairSync('ed25519').privateKey), 'unknown_seller_key'],
    ['edited (more tills)', () => signLicence(terms(), PRIV).replace('"tills": 2', '"tills": 99'), 'not_signed_by_the_seller'],
    ['copied (another shop\'s tenant id)', () => signLicence(terms({ tenantId: '7d1e9a44-2c3b-4e5f-8a90-b1c2d3e4f5a6' }), PRIV), 'another_shop'],
  ])('a %s licence is refused by name, nothing put in force', async (_w, make, why) => {
    const { url, dir } = await box();
    const cookie = await signIn(url, 'u-owner');
    const r = await load(url, cookie, pinOf('u-owner'), make());
    expect(r.status).toBe(422);
    expect(await r.json()).toMatchObject({ ok: false, refusedBecause: why });
    expect(existsSync(join(dir, 'licence', 'licence.json'))).toBe(false);
    expect((await history(dir)).map((x) => x['outcome'])).toEqual([`refused:${why}`]);
  });

  it('the store manager sees the screen but no form; a load in his name is refused as not the owner; another site is refused', async () => {
    const { url, dir } = await box();
    const cookie = await signIn(url, 'u-mgr');
    const html = await (await fetch(`${url}${LICENCE_PATHS.page}`, { headers: { cookie } })).text();
    expect(html).toContain('Only the owner may load a licence.');
    expect(html).not.toContain('id="licence-form"');
    const r = await load(url, cookie, pinOf('u-mgr'), signLicence(terms(), PRIV));
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ refusedBecause: 'not_the_owner' });
    const owner = await signIn(url, 'u-owner');
    expect((await load(url, owner, pinOf('u-owner'), signLicence(terms(), PRIV), 'cross-site')).status).toBe(403);
    expect(existsSync(join(dir, 'licence', 'licence.json'))).toBe(false);
  });

  it('the licence request downloads: names only (tenant id), never a secret', async () => {
    const { url } = await box();
    const cookie = await signIn(url, 'u-owner');
    const r = await fetch(`${url}${LICENCE_PATHS.request}`, { headers: { cookie } });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-disposition')).toContain('licence-request.json');
    expect(await r.json()).toMatchObject({ kind: 'sre-retail-os-licence-request-v1', tenantId: TENANT });
  });

  it('with no licence, an office page carries the notice; the till\'s own screen never does', async () => {
    const { url } = await box();
    const cookie = await signIn(url, 'u-owner');
    const office = await (await fetch(`${url}/approvals`, { headers: { cookie } })).text();
    expect(office).toContain('id="sre-licence-notice"');
    expect(office).toContain('No licence loaded yet');
    const till = await (await fetch(`${url}/pos/`)).text();
    expect(till).not.toContain('sre-licence-notice');
  });

  it('a release with no seller key: licensing not switched on, no notice, nothing to load', async () => {
    const { url } = await box({ key: false });
    const cookie = await signIn(url, 'u-owner');
    const html = await (await fetch(`${url}${LICENCE_PATHS.page}`, { headers: { cookie } })).text();
    expect(html).toContain('data-state="not_in_force"');
    expect(html).toContain('id="no-key"');
    expect(await (await fetch(`${url}/approvals`, { headers: { cookie } })).text()).not.toContain('sre-licence-notice');
  });

  it('REDUCED mode (setup period long over): the Software update page refuses, the till screen still serves, a licence lifts it', async () => {
    const { url, dir } = await box({ firstSeenOn: '2020-01-01', update: true });
    const cookie = await signIn(url, 'u-owner');
    const page = await (await fetch(`${url}${LICENCE_PATHS.page}`, { headers: { cookie } })).text();
    expect(page).toContain('data-state="reduced"');
    const ask = (): Promise<Response> => fetch(`${url}${UPDATE_PATHS.request}`, { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', cookie }, body: JSON.stringify({ pin: pinOf('u-owner') }) });
    const refused = await ask();
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ refusedBecause: 'licence_reduced' });
    expect(existsSync(join(dir, UPDATE_REQUEST_FILE))).toBe(false);
    expect((await fetch(`${url}/pos/`)).status).toBe(200);
    expect((await load(url, cookie, pinOf('u-owner'), signLicence(terms(), PRIV))).status).toBe(200);
    const allowed = await ask();
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({ ok: true });
  });

  it('the About screen links to the Licence screen', async () => {
    const { url } = await box();
    expect(await (await fetch(`${url}/about/`)).text()).toContain('href="/licence/"');
  });
});
