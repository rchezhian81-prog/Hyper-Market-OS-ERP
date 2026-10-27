import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { connect as tlsConnect, type DetailedPeerCertificate } from 'node:tls';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { DEVICE_TLS_FILES } from '../../edge/store-edge/src/device-tls';
import { HANDHELD_SEAL_PATHS, SEAL_NOT_READY_WORDS } from '../../edge/store-edge/src/handheld-seal';
import { SCREEN_HOST } from '../../edge/store-edge/src/screen-server';
import { prepareTillBox, pinOf } from '../support/till-operator';
import { trustingFetch } from '../support/box-tls';
import { readQr, matrixFromQrSvg } from '../support/qr-reader';

/**
 * **OB-424 (owner, 27 Oct 2026) · ADR-0030 on the REAL store computer (`startEdge`), with no head office and no internet.**
 *
 * The seal — the authority the handheld door is locked under (OB-422) — reaches a new handheld from the store PC's OWN
 * screen: the screens server, plain http on the PC's loopback only. Proved here:
 *   • the panel's download IS the authority the door presents (the door's chain names it as its issuer, byte for byte),
 *     the fingerprint and the short code on the page are that certificate's, and the QR carries that certificate;
 *   • a device that trusts ONLY what it took from this screen opens the door;
 *   • no private key is anywhere in what the screen serves;
 *   • the shop-network door does NOT serve the panel or the file — and no new listener was opened for it;
 *   • with no door, or the door shut by a broken lock, the panel says so in words and offers no seal;
 *   • with the office PIN on, the panel is for a person signed in to the office screens.
 */

const KEY = ['ob424', 'seal', 'screen', 'key'].join('-').padEnd(48, '0');
const TENANT = 't-sre';
const PACK = {
  version: 1,
  policies: { storeId: 'store-1', branchId: 'store-1', tradingDayCutoff: '00:00', warehouseId: 'wh-1' },
  lossPreventionRules: [],
  devices: [],
  roles: [{ id: 'store_manager', name: 'Store manager', permissions: ['identity.self.read', 'pos.sale.sync'] }],
  roleAssignments: [{ userId: 'u-mgr', roleId: 'store_manager', branchScope: 'all' }],
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

async function box(): Promise<{ dir: string; start: (extra?: Record<string, string>, without?: readonly string[]) => Promise<{ edge: EdgeProcess; said: string[] }> }> {
  const dir = await mkdtemp(join(tmpdir(), 'sre-ob424-box-'));
  cleanups.push(async () => { await rm(dir, { recursive: true, force: true }); await rm(`${dir}-device-tls`, { recursive: true, force: true }); await rm(`${dir}-witness`, { recursive: true, force: true }); });
  const env = await prepareTillBox({ dir, key: KEY, pack: PACK, people: [{ userId: 'u-lanecash', displayName: 'Lane Cashier' }, { userId: 'u-mgr', displayName: 'Manager' }] });
  const start = async (extra: Record<string, string> = {}, without: readonly string[] = []): Promise<{ edge: EdgeProcess; said: string[] }> => {
    const said: string[] = [];
    const settings: Record<string, string> = {
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0', EDGE_DEVICE_PORT: '0', EDGE_APPS_DIR: 'apps', ...env, ...extra,
    };
    for (const k of without) delete settings[k];
    const edge = (await startEdge(settings, (line: string) => { said.push(line); }))!;
    cleanups.push(async () => { await edge.stop(); });
    return { edge, said };
  };
  return { dir, start };
}

const screens = (edge: EdgeProcess): string => `http://127.0.0.1:${edge.screens!.port}`;
const derToPem = (der: Buffer): string => `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;

/** The door's chain as a device sees it, trusting only `ca`. */
const doorChain = (port: number, ca: string): Promise<{ authorized: boolean; issuerRaw?: Buffer; error?: string }> => new Promise((resolve) => {
  const s = tlsConnect({ host: '127.0.0.1', port, ca }, () => {
    const peer = s.getPeerCertificate(true) as DetailedPeerCertificate;
    resolve({ authorized: s.authorized, issuerRaw: peer.issuerCertificate?.raw });
    s.end();
  });
  s.on('error', (e) => { resolve({ authorized: false, error: (e as NodeJS.ErrnoException).code ?? e.message }); });
});

describe('OB-424: the store PC\'s own screen hands a new handheld the seal — on loopback only', () => {
  it('the panel serves the very authority the door is locked under: same certificate, same fingerprint, same code, in the QR too', async () => {
    const { dir, start } = await box();
    const { edge } = await start();
    expect(edge.screens!.host).toBe(SCREEN_HOST); // the PC's loopback — nothing on the shop network
    const door = edge.devices!;

    const pageRes = await fetch(`${screens(edge)}${HANDHELD_SEAL_PATHS.page}`);
    expect(pageRes.status).toBe(200);
    const page = await pageRes.text();
    expect(page).toContain('data-seal="ready"');

    const crtRes = await fetch(`${screens(edge)}${HANDHELD_SEAL_PATHS.certificate}`);
    expect(crtRes.status).toBe(200);
    expect(crtRes.headers.get('content-type')).toBe('application/x-x509-ca-cert');
    expect(crtRes.headers.get('content-disposition')).toBe('attachment; filename="authority.crt"');
    const der = Buffer.from(await crtRes.arrayBuffer());
    const cert = new X509Certificate(der);
    expect(cert.ca).toBe(true);

    // The SAME authority the door uses: its own record, the file in the lock folder, and the issuer in the chain it presents.
    expect(cert.fingerprint256).toBe(door.authority().fingerprint);
    expect(Buffer.compare(der, Buffer.from(new X509Certificate(await readFile(join(`${dir}-device-tls`, DEVICE_TLS_FILES.authorityCert), 'utf8')).raw))).toBe(0);
    const seen = await doorChain(door.port, derToPem(der));
    expect(seen.authorized).toBe(true); // a device trusting ONLY what it took from this screen opens the door
    expect(Buffer.compare(seen.issuerRaw!, der)).toBe(0);

    // The code and the fingerprint on the page are that certificate's.
    const pairs = cert.fingerprint256.split(':');
    expect(page).toContain(`<p class="code" id="seal-code">${pairs.slice(0, 4).join(':')} … ${pairs.slice(-4).join(':')}</p>`);
    expect(page).toContain(cert.fingerprint256);
    // The QR on the page carries that certificate — read back by a separate reader, as a phone would.
    const svg = /<figure id="seal-qr"[^>]*>(<svg[\s\S]*?<\/svg>)<\/figure>/.exec(page)![1]!;
    const carried = readQr(matrixFromQrSvg(svg)).bytes.toString('utf8');
    expect(Buffer.compare(Buffer.from(new X509Certificate(carried).raw), der)).toBe(0);
  });

  it('no private key is anywhere in what the screen serves', async () => {
    const { dir, start } = await box();
    const { edge } = await start();
    const page = await (await fetch(`${screens(edge)}${HANDHELD_SEAL_PATHS.page}`)).text();
    const der = Buffer.from(await (await fetch(`${screens(edge)}${HANDHELD_SEAL_PATHS.certificate}`)).arrayBuffer());
    const svg = /<figure id="seal-qr"[^>]*>(<svg[\s\S]*?<\/svg>)<\/figure>/.exec(page)![1]!;
    const carried = readQr(matrixFromQrSvg(svg)).bytes.toString('utf8');
    for (const keyFile of [DEVICE_TLS_FILES.authorityKey, DEVICE_TLS_FILES.socketKey]) {
      const keyText = await readFile(join(`${dir}-device-tls`, keyFile), 'utf8');
      const secret = Buffer.from(createPrivateKey(keyText).export({ format: 'jwk' }).d!, 'base64url'); // the private scalar itself
      for (const served of [page, carried, der.toString('latin1')]) {
        expect(served).not.toMatch(/PRIVATE KEY/);
        expect(served).not.toContain(keyText.split('\n')[1]!);
      }
      expect(secret.length).toBe(32);
      for (const served of [der, Buffer.from(page, 'utf8'), Buffer.from(carried, 'utf8')]) expect(served.includes(secret)).toBe(false); // not even the raw key bytes
    }
  });

  it('the shop-network door does NOT serve the seal panel or the file', async () => {
    const { start } = await box();
    const { edge } = await start();
    const door = edge.devices!;
    const trusting = trustingFetch(door.authority().pem);
    for (const path of [HANDHELD_SEAL_PATHS.page, HANDHELD_SEAL_PATHS.certificate, '/handheld-seal']) {
      const res = await trusting(`https://127.0.0.1:${door.port}${path}`);
      expect(res.status, path).not.toBe(200);
      const body = await res.text();
      expect(body).not.toContain('BEGIN CERTIFICATE');
      expect(body).not.toContain('seal-qr');
    }
    // And plain http to the door is still refused in words, whatever the path.
    expect((await fetch(`http://127.0.0.1:${door.port}${HANDHELD_SEAL_PATHS.certificate}`)).status).toBe(426);
  });

  it('a box with no handheld door says so, and offers no seal', async () => {
    const { start } = await box();
    const { edge } = await start({}, ['EDGE_DEVICE_PORT']);
    expect(edge.devices).toBeNull();
    const page = await (await fetch(`${screens(edge)}${HANDHELD_SEAL_PATHS.page}`)).text();
    expect(page).toContain('data-reason="no_door"');
    expect(page).toContain(SEAL_NOT_READY_WORDS.no_door.en);
    expect(page).toContain(SEAL_NOT_READY_WORDS.no_door.ta);
    expect(page).not.toContain('<svg');
    const crt = await fetch(`${screens(edge)}${HANDHELD_SEAL_PATHS.certificate}`);
    expect(crt.status).toBe(404);
    expect(await crt.text()).toContain(SEAL_NOT_READY_WORDS.no_door.en);
  });

  it('a broken lock keeps the door shut — and the panel says so in plain words, never invents a seal', async () => {
    const { dir, start } = await box();
    const first = await start();
    await first.edge.stop();
    await rm(join(`${dir}-device-tls`, DEVICE_TLS_FILES.authorityKey));
    const { edge } = await start();
    expect(edge.devices).toBeNull();
    const page = await (await fetch(`${screens(edge)}${HANDHELD_SEAL_PATHS.page}`)).text();
    expect(page).toContain('data-reason="door_shut"');
    expect(page).toContain(SEAL_NOT_READY_WORDS.door_shut.en);
    expect(page).toContain(SEAL_NOT_READY_WORDS.door_shut.ta);
    expect(page).toMatch(/authority-key\.pem is missing/);
    expect(page).not.toContain('<svg');
    expect(page).not.toContain('id="seal-code"');
    expect((await fetch(`${screens(edge)}${HANDHELD_SEAL_PATHS.certificate}`)).status).toBe(404);
  });

  it('with the office PIN on, the panel opens only for a person signed in to the office screens', async () => {
    const { start } = await box();
    const { edge } = await start({ EDGE_OFFICE_SIGN_IN: 'pin' });
    const anon = await fetch(`${screens(edge)}${HANDHELD_SEAL_PATHS.certificate}`);
    expect(anon.status).toBe(401);
    expect(await anon.text()).not.toContain('BEGIN CERTIFICATE');
    const signIn = await fetch(`${screens(edge)}/office/sign-in`, {
      method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ staffId: 'u-mgr', pin: pinOf('u-mgr'), next: HANDHELD_SEAL_PATHS.page }).toString(),
    });
    expect(signIn.status).toBe(303);
    expect(signIn.headers.get('location')).toBe(HANDHELD_SEAL_PATHS.page);
    const cookie = signIn.headers.get('set-cookie')!.split(';')[0]!;
    const page = await fetch(`${screens(edge)}${HANDHELD_SEAL_PATHS.page}`, { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('data-seal="ready"');
    const crt = await fetch(`${screens(edge)}${HANDHELD_SEAL_PATHS.certificate}`, { headers: { cookie } });
    expect(new X509Certificate(Buffer.from(await crt.arrayBuffer())).fingerprint256).toBe(edge.devices!.authority().fingerprint);
  });
});
