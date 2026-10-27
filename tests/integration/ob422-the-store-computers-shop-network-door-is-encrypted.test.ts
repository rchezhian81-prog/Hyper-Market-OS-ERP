import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { connect as tlsConnect } from 'node:tls';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { DEVICE_TLS_FILES, ensureDeviceTls } from '../../edge/store-edge/src/device-tls';
import { enrolmentCodeHash } from '../../packages/platform-admin/src/device-enrolment';
import { prepareTillBox, signInAtLane, operatorHeader, receiptNumberAt } from '../support/till-operator';
import { trustingFetch } from '../support/box-tls';

/**
 * **OB-422 (owner, 27 Oct 2026) · ADR-0030 on the REAL store computer (`startEdge`), with no head office and no internet.**
 *
 *   • the box makes its own authority and the door's certificate at first start, in a folder BESIDE its data folder —
 *     never inside it, so a backup of the data never carries a private key off the box; no boot line names a key;
 *   • the handheld door is https: a device trusting this box's authority enrols and is served; plain http to the door is
 *     refused in words; a device that never trusted the box cannot connect;
 *   • the till's sale path is untouched (hard rule #1): the lane socket still answers plain http on the PC's own loopback,
 *     and a sale commits there with no network at all, whatever the door is doing;
 *   • a cold restart keeps the same authority and certificate, and the enrolled device's credential still works;
 *   • a certificate in its last 30 days is renewed at start — same authority — and the enrolled device keeps working;
 *   • a door named on a public address is NOT opened, and the box says why — and the till still sells.
 *
 * Nothing here is stored in PostgreSQL (the store computer keeps files, ADR-0004), so there is no database half.
 */

const KEY = ['ob422', 'door', 'lock', 'key'].join('-').padEnd(48, '0');
const TENANT = 't-sre';
const CODE = 'ABCDE-FGHJK-LMNPQ-RSTUV';
const DAY = 86_400_000;
const PACK = {
  version: 1,
  policies: { storeId: 'store-1', branchId: 'store-1', tradingDayCutoff: '00:00', warehouseId: 'wh-1' },
  lossPreventionRules: [],
  devices: [{ deviceId: 'hh-01', kind: 'handheld', status: 'registered', label: 'Back door', enrolment: { codeHash: enrolmentCodeHash(CODE), expiresAt: '2099-01-01T00:00:00.000Z' } }],
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

async function box(): Promise<{ dir: string; start: (extra?: Record<string, string>) => Promise<{ edge: EdgeProcess; said: string[] }> }> {
  const dir = await mkdtemp(join(tmpdir(), 'sre-ob422-box-'));
  cleanups.push(async () => { await rm(dir, { recursive: true, force: true }); await rm(`${dir}-device-tls`, { recursive: true, force: true }); await rm(`${dir}-witness`, { recursive: true, force: true }); });
  const env = await prepareTillBox({ dir, key: KEY, pack: PACK });
  const start = async (extra: Record<string, string> = {}): Promise<{ edge: EdgeProcess; said: string[] }> => {
    const said: string[] = [];
    const edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0', EDGE_DEVICE_PORT: '0', EDGE_APPS_DIR: 'apps', ...env, ...extra,
    }, (line: string) => { said.push(line); }))!;
    cleanups.push(async () => { await edge.stop(); });
    return { edge, said };
  };
  return { dir, start };
}

const handshake = (port: number, ca?: string): Promise<{ authorized: boolean; fingerprint?: string; error?: string }> => new Promise((resolve) => {
  const s = tlsConnect({ host: '127.0.0.1', port, ...(ca === undefined ? {} : { ca }) }, () => { resolve({ authorized: s.authorized, fingerprint: s.getPeerCertificate().fingerprint256 }); s.end(); });
  s.on('error', (e) => { resolve({ authorized: false, error: (e as NodeJS.ErrnoException).code ?? e.message }); });
});

/** A sale on the lane socket, over plain http on the PC's own loopback — the till's own path. */
async function ringOnTheLane(edge: EdgeProcess, id: string): Promise<boolean> {
  const token = await signInAtLane(edge.lane!.port, 'u-lanecash');
  const number = await receiptNumberAt(edge.lane!.port, token);
  const res = await fetch(`http://127.0.0.1:${edge.lane!.port}/lane/sales`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...operatorHeader(token) }, body: JSON.stringify({ id, number, total: 1, cashierId: 'u-lanecash' }),
  });
  return ((await res.json()) as { committed: boolean }).committed;
}

const filesUnder = async (dir: string): Promise<string[]> => {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await filesUnder(p)); else out.push(p);
  }
  return out;
};

describe('OB-422: the store computer\'s shop-network door is encrypted', () => {
  it('first start: the lock is made beside the data folder; the door is https; a trusting device enrols; plain http is refused; an untrusting one cannot connect; the till sells on loopback', async () => {
    const { dir, start } = await box();
    const { edge, said } = await start();
    const door = edge.devices!;
    expect(door.scheme).toBe('https');
    // Made beside the data folder, never inside it; nothing in the data folder holds a private key.
    const tlsDir = `${dir}-device-tls`;
    expect((await readdir(tlsDir)).sort()).toEqual(Object.values(DEVICE_TLS_FILES).sort());
    for (const f of await filesUnder(dir)) expect(await readFile(f, 'utf8').catch(() => ''), f).not.toMatch(/PRIVATE KEY/);
    if (process.platform !== 'win32') expect((await stat(join(tlsDir, DEVICE_TLS_FILES.authorityKey))).mode & 0o777).toBe(0o600);
    // The boot log says it in words — the fingerprint a person compares — and never a key.
    const log = said.join('\n');
    expect(log).toMatch(/made its own signing authority \(fingerprint [0-9A-F:]{95}/);
    expect(log).toMatch(new RegExp(`device socket on https://127\\.0\\.0\\.1:${door.port}`));
    expect(log).toContain(`locked (OB-422): https only, plain http refused; a handheld trusts this store computer's authority once, at enrolment — fingerprint ${door.authority().fingerprint}`);
    expect(log).not.toMatch(/PRIVATE KEY|BEGIN/);
    const keyBody = (await readFile(join(tlsDir, DEVICE_TLS_FILES.authorityKey), 'utf8')).split('\n')[1]!;
    expect(log).not.toContain(keyBody);

    const base = `https://127.0.0.1:${door.port}`;
    const trusting = trustingFetch(door.authority().pem);
    // Plain http on the door: refused in words, before anything is read.
    const refused = await fetch(`http://127.0.0.1:${door.port}/device/enrol`);
    expect(refused.status).toBe(426);
    expect(await refused.text()).toMatch(/https only \(OB-422\)/);
    // A device that never trusted this store computer cannot even complete the handshake.
    expect(await handshake(door.port)).toMatchObject({ authorized: false });
    await expect(fetch(`${base}/device/enrol`)).rejects.toThrow();
    // A device that trusts it (enrolment) completes it, enrols, and is served.
    expect(await handshake(door.port, door.authority().pem)).toMatchObject({ authorized: true, fingerprint: door.certificate().fingerprint });
    const enrolled = await trusting(`${base}/device/enrol`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: 'hh-01', code: CODE }) });
    expect(enrolled.status).toBe(200);
    const cookie = enrolled.headers.get('set-cookie')!;
    expect(cookie).toMatch(/; HttpOnly; Secure; SameSite=Strict;/);
    expect((await trusting(`${base}/lane/sync-status`, { headers: { cookie: cookie.split(';')[0]! } })).status).toBe(200);

    // Hard rule #1: the till's own path is the loopback lane socket, plain http, and it sells with no network at all.
    expect((await fetch(`http://127.0.0.1:${edge.lane!.port}/lane/sync-status`)).status).toBe(200);
    expect(await ringOnTheLane(edge, 'S-ob422-1')).toBe(true);
    expect((await fetch(`http://127.0.0.1:${edge.screens!.port}/pos/`)).status).toBe(200);
  });

  it('a cold restart keeps the same authority and certificate, and the enrolled device\'s credential still works', async () => {
    const { start } = await box();
    const first = await start();
    const trusting = trustingFetch(first.edge.devices!.authority().pem);
    const enrolled = await trusting(`https://127.0.0.1:${first.edge.devices!.port}/device/enrol`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: 'hh-01', code: CODE }) });
    const cookie = enrolled.headers.get('set-cookie')!.split(';')[0]!;
    const authority = first.edge.devices!.authority().fingerprint;
    const certificate = first.edge.devices!.certificate().fingerprint;
    await first.edge.stop();
    cleanups.pop();
    const again = await start();
    expect(again.said.join('\n')).not.toMatch(/made its own signing authority|certificate made for|certificate renewed for/);
    expect([again.edge.devices!.authority().fingerprint, again.edge.devices!.certificate().fingerprint]).toEqual([authority, certificate]);
    const status = await trusting(`https://127.0.0.1:${again.edge.devices!.port}/lane/sync-status`, { headers: { cookie } });
    expect(status.status).toBe(200);
  });

  it('a certificate in its last 30 days is renewed at start, by the same authority — the enrolled device keeps working, unchanged', async () => {
    const { dir, start } = await box();
    // The lock as the installer made it 65 days ago: its 90-day certificate now has 25 days left.
    const madeThen = ensureDeviceTls({ dir: `${dir}-device-tls`, addresses: ['127.0.0.1'], now: new Date(Date.now() - 65 * DAY) });
    expect(madeThen.ok).toBe(true);
    const old = madeThen.ok ? madeThen.tls : undefined;
    const first = await start();
    const log = first.said.join('\n');
    expect(log).toMatch(/certificate renewed for 127\.0\.0\.1 until .*signed by the same authority, so enrolled handhelds keep working/);
    expect(first.edge.devices!.authority().fingerprint).toBe(old!.authorityFingerprint);
    expect(first.edge.devices!.certificate().fingerprint).not.toBe(old!.socketFingerprint);
    // The device trusted the authority at enrolment — that trust is all it needs for the renewed certificate.
    const trusting = trustingFetch(old!.authorityPem);
    const base = `https://127.0.0.1:${first.edge.devices!.port}`;
    const enrolled = await trusting(`${base}/device/enrol`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: 'hh-01', code: CODE }) });
    expect(enrolled.status).toBe(200);
    const cookie = enrolled.headers.get('set-cookie')!.split(';')[0]!;
    // And a renewal while it runs (the timer's path) changes nothing for it either.
    const later = first.edge.devices!.renew(new Date());
    expect(later).toEqual({ ok: true, events: [] });
    expect((await trusting(`${base}/lane/sync-status`, { headers: { cookie } })).status).toBe(200);
    const history = (await readFile(join(`${dir}-device-tls`, DEVICE_TLS_FILES.history), 'utf8')).trim().split('\n');
    expect(history.map((l) => (JSON.parse(l.slice(l.indexOf(' ') + 1)) as { kind: string }).kind)).toEqual(['authority_created', 'certificate_issued', 'certificate_renewed']);
  });

  it('a door named on a public address is not opened, and the box says why — the till still sells', async () => {
    const { dir, start } = await box();
    const { edge, said } = await start({ EDGE_DEVICE_HOST: '8.8.8.8' });
    expect(edge.devices).toBeNull();
    expect(said.join('\n')).toMatch(/handheld door NOT opened: EDGE_DEVICE_HOST is "8\.8\.8\.8", which is not this computer's address on the staff wifi.*The till keeps selling/);
    expect(existsSync(`${dir}-device-tls`)).toBe(false);
    expect(await ringOnTheLane(edge, 'S-ob422-2')).toBe(true);
  });

  it('a lock folder named by the settings is used instead of the default — and a broken authority keeps the door shut, said, never replaced', async () => {
    const { dir, start } = await box();
    const named = join(dir, '..', `${dir.split('/').pop()}-named-lock`);
    cleanups.push(async () => { await rm(named, { recursive: true, force: true }); });
    const first = await start({ EDGE_DEVICE_TLS_DIR: named });
    expect(existsSync(join(named, DEVICE_TLS_FILES.authorityCert))).toBe(true);
    expect(existsSync(`${dir}-device-tls`)).toBe(false);
    await first.edge.stop();
    cleanups.pop();
    await rm(join(named, DEVICE_TLS_FILES.authorityKey));
    const broken = await start({ EDGE_DEVICE_TLS_DIR: named });
    expect(broken.edge.devices).toBeNull();
    expect(broken.said.join('\n')).toMatch(/handheld door NOT opened: the store computer's signing authority in .* is incomplete \(authority-key\.pem is missing\)\. It was kept, not repaired/);
    expect(existsSync(join(named, DEVICE_TLS_FILES.authorityKey))).toBe(false);
    expect(await ringOnTheLane(broken.edge, 'S-ob422-3')).toBe(true);
  });
});
