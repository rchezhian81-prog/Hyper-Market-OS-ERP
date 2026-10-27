import { describe, it, expect, afterEach } from 'vitest';
import { generateKeyPairSync, X509Certificate, createPrivateKey } from 'node:crypto';
import { mkdtemp, rm, readFile, readdir, stat, writeFile, unlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { connect as tlsConnect } from 'node:tls';
import { connect as netConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  issueAuthorityCertificate, issueSocketCertificate, isPermittedAddress, fingerprintOf, PERMITTED_RANGES,
} from '../../edge/store-edge/src/device-certificates';
import {
  ensureDeviceTls, socketAddressesFor, sayDeviceTlsEvent, DEVICE_TLS_FILES, SOCKET_CERT_DAYS, RENEW_WITHIN_DAYS,
} from '../../edge/store-edge/src/device-tls';
import { startDeviceServer, DEVICE_COOKIE, PLAIN_HTTP_REFUSAL, type DeviceServer } from '../../edge/store-edge/src/device-server';
import { DeviceEnrolments, type PackDevice } from '../../edge/store-edge/src/device-enrolments';
import { enrolmentCodeHash } from '../../packages/platform-admin/src/device-enrolment';
import { readPack } from '../../edge/store-edge/src/store-pack';
import type { ScreenInput } from '../../edge/store-edge/src/screen-data';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { trustingFetch } from '../support/box-tls';

/**
 * **OB-422 (owner, 27 Oct 2026) · ADR-0030 — the store computer's shop-network door is LOCKED.**
 *
 * The store computer makes its own signing authority and the door's certificate; each device trusts the authority once,
 * at enrolment. Proven here, on real sockets:
 *
 *   • the certificates are real X.509 — Node and OpenSSL both verify the chain; the authority may sign certificates only,
 *     and only for `localhost` and private / loopback IPv4 (critical name constraints, enforced by the TLS check itself);
 *   • the folder: private keys owner-only; made once; a second start changes nothing; renewal near the end, a new address
 *     or a key/certificate pair that does not belong together re-issues — always under the SAME authority; a broken
 *     authority is refused by name, never replaced; no key ever in the history or a said line;
 *   • the door: a TLS handshake succeeds for a device trusting the box's authority; plain http is refused in words (426)
 *     and nothing is served; a device that never trusted it — or trusts ANOTHER box — cannot connect; TLS 1.1 is refused;
 *     a renewed certificate keeps an enrolled device working with its same credential.
 */

const NOW = new Date('2026-10-27T10:00:00.000Z');
const DAY = 86_400_000;
const HAVE_OPENSSL = ((): boolean => { try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

const dirs: string[] = [];
const servers: DeviceServer[] = [];
const registers: DeviceEnrolments[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
  for (const r of registers.splice(0)) await r.close();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const tempDir = async (): Promise<string> => { const d = await mkdtemp(join(tmpdir(), 'sre-ob422-')); dirs.push(d); return d; };
const made = (dir: string, addresses: readonly string[] = ['127.0.0.1'], now = NOW) => {
  const out = ensureDeviceTls({ dir, addresses, now });
  if (!out.ok) throw new Error(out.problem);
  return out;
};

describe('the store computer\'s own certificates (device-certificates.ts)', () => {
  const pair = () => generateKeyPairSync('ec', { namedCurve: 'P-256' });

  it('an authority that may sign certificates only, for localhost and private shop addresses only — and a door certificate it verifies', async () => {
    const ca = pair();
    const leaf = pair();
    const authority = issueAuthorityCertificate({ publicKey: ca.publicKey, privateKey: ca.privateKey, commonName: 'Test authority', notBefore: NOW, notAfter: new Date(NOW.getTime() + 3650 * DAY) });
    const door = issueSocketCertificate({ publicKey: leaf.publicKey, authorityPublicKey: ca.publicKey, authorityPrivateKey: ca.privateKey, authorityCommonName: 'Test authority', addresses: ['127.0.0.1', '192.168.10.5'], notBefore: NOW, notAfter: new Date(NOW.getTime() + 90 * DAY) });
    const a = new X509Certificate(authority.pem);
    const d = new X509Certificate(door.pem);
    expect([a.ca, a.verify(ca.publicKey), d.ca, d.verify(ca.publicKey), d.checkIssued(a)]).toEqual([true, true, false, true, true]);
    expect(d.subjectAltName).toBe('DNS:localhost, IP Address:127.0.0.1, IP Address:192.168.10.5');
    expect([d.checkIP('192.168.10.5'), d.checkIP('192.168.10.6'), d.checkHost('localhost')]).toEqual(['192.168.10.5', undefined, 'localhost']);
    expect(d.keyUsage).toEqual(['1.3.6.1.5.5.7.3.1']);
    expect(fingerprintOf(authority.der)).toBe(a.fingerprint256);
    // It refuses to sign for anything its constraints would not allow — a public address, before anything is signed.
    expect(() => issueSocketCertificate({ publicKey: leaf.publicKey, authorityPublicKey: ca.publicKey, authorityPrivateKey: ca.privateKey, authorityCommonName: 'x', addresses: ['8.8.8.8'], notBefore: NOW, notAfter: NOW })).toThrow(/may not vouch for 8\.8\.8\.8/);
    expect(['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.254', '192.168.1.1'].every(isPermittedAddress)).toBe(true);
    expect(['8.8.8.8', '172.32.0.1', '192.169.0.1', '::1', 'store.example.com', '169.254.1.1'].some(isPermittedAddress)).toBe(false);
    expect(PERMITTED_RANGES.length).toBe(4);
  });

  it.skipIf(!HAVE_OPENSSL)('OpenSSL verifies the chain, reads the critical name constraints, and REFUSES a certificate the authority signs outside them', async () => {
    const dir = await tempDir();
    const out = made(join(dir, 'tls'), ['127.0.0.1', '10.0.0.7'], new Date());
    const caFile = join(dir, 'tls', DEVICE_TLS_FILES.authorityCert);
    const leafFile = join(dir, 'leaf.crt');
    await writeFile(leafFile, out.tls.socketChainPem.split('-----END CERTIFICATE-----')[0] + '-----END CERTIFICATE-----\n');
    expect(execFileSync('openssl', ['verify', '-CAfile', caFile, leafFile], { encoding: 'utf8' })).toContain(': OK');
    const text = execFileSync('openssl', ['x509', '-in', caFile, '-noout', '-text'], { encoding: 'utf8' });
    expect(text).toMatch(/X509v3 Name Constraints: critical/);
    expect(text).toMatch(/DNS:localhost/);
    expect(text).toMatch(/IP:192\.168\.0\.0\/255\.255\.0\.0/);
    expect(text).toMatch(/CA:TRUE, pathlen:0/);
    // A stolen authority key used OUTSIDE the constraints: OpenSSL signs a certificate for a bank's name and a public
    // address with it — and the chain check refuses it. A device trusting this box can only ever be told about the shop.
    const keyFile = join(dir, 'tls', DEVICE_TLS_FILES.authorityKey);
    const evilKey = join(dir, 'evil.key');
    const csr = join(dir, 'evil.csr');
    const ext = join(dir, 'evil.ext');
    const evil = join(dir, 'evil.crt');
    execFileSync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', evilKey], { stdio: 'ignore' });
    execFileSync('openssl', ['req', '-new', '-key', evilKey, '-subj', '/CN=bank.example', '-out', csr], { stdio: 'ignore' });
    await writeFile(ext, 'subjectAltName=DNS:bank.example,IP:8.8.8.8\nbasicConstraints=critical,CA:FALSE\n');
    execFileSync('openssl', ['x509', '-req', '-in', csr, '-CA', caFile, '-CAkey', keyFile, '-CAcreateserial', '-days', '30', '-extfile', ext, '-out', evil], { stdio: 'ignore' });
    let refused = '';
    try { execFileSync('openssl', ['verify', '-CAfile', caFile, evil], { encoding: 'utf8', stdio: 'pipe' }); } catch (e) { refused = String((e as { stdout?: string }).stdout ?? '') + String((e as { stderr?: string }).stderr ?? ''); }
    expect(refused).toMatch(/permitted subtree violation|name constraints/i);
  });
});

describe('the lock\'s folder (device-tls.ts)', () => {
  it('made once: owner-only keys, a public authority certificate, a history that names fingerprints and never a key; a second start changes nothing', async () => {
    const dir = join(await tempDir(), 'tls');
    const first = made(dir);
    expect(first.events.map((e) => e.kind)).toEqual(['authority_created', 'certificate_issued']);
    expect((await readdir(dir)).sort()).toEqual(Object.values(DEVICE_TLS_FILES).sort());
    if (process.platform !== 'win32') {
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
      expect((await stat(join(dir, DEVICE_TLS_FILES.authorityKey))).mode & 0o777).toBe(0o600);
      expect((await stat(join(dir, DEVICE_TLS_FILES.socketKey))).mode & 0o777).toBe(0o600);
    }
    const history = await readFile(join(dir, DEVICE_TLS_FILES.history), 'utf8');
    expect(history).toContain(first.tls.authorityFingerprint.replace(/:/g, ':'));
    expect(history).not.toMatch(/PRIVATE KEY|BEGIN/);
    for (const e of first.events) expect(sayDeviceTlsEvent(e)).not.toMatch(/PRIVATE KEY|BEGIN/);
    // The door's certificate: 90 days, the authority behind it in the chain, for this computer only.
    expect(new Date(first.tls.socketNotAfter).getTime() - NOW.getTime()).toBe(SOCKET_CERT_DAYS * 86_400_000);
    expect(first.tls.socketChainPem.endsWith(first.tls.authorityPem)).toBe(true);
    const again = made(dir);
    expect(again.events).toEqual([]);
    expect([again.tls.authorityFingerprint, again.tls.socketFingerprint]).toEqual([first.tls.authorityFingerprint, first.tls.socketFingerprint]);
  });

  it('renews the door\'s certificate when it has less than 30 days left, and for a new shop address — always under the SAME authority', async () => {
    const dir = join(await tempDir(), 'tls');
    const first = made(dir);
    const before = made(dir, ['127.0.0.1'], new Date(NOW.getTime() + (SOCKET_CERT_DAYS - RENEW_WITHIN_DAYS - 1) * DAY));
    expect(before.events).toEqual([]);
    const renewed = made(dir, ['127.0.0.1'], new Date(NOW.getTime() + (SOCKET_CERT_DAYS - RENEW_WITHIN_DAYS + 1) * DAY));
    expect(renewed.events.map((e) => e.kind)).toEqual(['certificate_renewed']);
    expect(renewed.tls.authorityFingerprint).toBe(first.tls.authorityFingerprint);
    expect(renewed.tls.socketFingerprint).not.toBe(first.tls.socketFingerprint);
    expect(sayDeviceTlsEvent(renewed.events[0]!)).toMatch(/same authority, so enrolled handhelds keep working/);
    const moved = made(dir, ['127.0.0.1', '192.168.10.5'], new Date(NOW.getTime() + (SOCKET_CERT_DAYS - RENEW_WITHIN_DAYS + 1) * DAY));
    expect(moved.events).toMatchObject([{ kind: 'certificate_renewed', why: 'it did not cover 192.168.10.5' }]);
    expect(moved.tls.authorityFingerprint).toBe(first.tls.authorityFingerprint);
    // A key and certificate that do not belong together (a stop between the two writes) are replaced, not presented.
    await writeFile(join(dir, DEVICE_TLS_FILES.socketKey), generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string);
    const healed = made(dir, ['127.0.0.1', '192.168.10.5'], new Date(NOW.getTime() + (SOCKET_CERT_DAYS - RENEW_WITHIN_DAYS + 1) * DAY));
    expect(healed.events).toMatchObject([{ kind: 'certificate_renewed', why: 'its key and certificate did not belong together' }]);
    const history = (await readFile(join(dir, DEVICE_TLS_FILES.history), 'utf8')).trim().split('\n');
    expect(history.length).toBe(5); // created, issued, renewed (time), renewed (address), renewed (pair) — append-only
  });

  it('never replaces or repairs a broken authority: a missing half, a key that is not its certificate\'s, an authority past its end — refused by name', async () => {
    const dir = join(await tempDir(), 'tls');
    made(dir);
    const keyText = await readFile(join(dir, DEVICE_TLS_FILES.authorityKey), 'utf8');
    await unlink(join(dir, DEVICE_TLS_FILES.authorityKey));
    const missing = ensureDeviceTls({ dir, addresses: ['127.0.0.1'], now: NOW });
    expect(missing).toMatchObject({ ok: false });
    expect(!missing.ok && missing.problem).toMatch(/incomplete \(authority-key\.pem is missing\)\. It was kept, not repaired/);
    expect(await readdir(dir)).not.toContain(DEVICE_TLS_FILES.authorityKey); // nothing was made in its place
    await writeFile(join(dir, DEVICE_TLS_FILES.authorityKey), generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string);
    const wrong = ensureDeviceTls({ dir, addresses: ['127.0.0.1'], now: NOW });
    expect(!wrong.ok && wrong.problem).toMatch(/does not read back as one key and its certificate/);
    await writeFile(join(dir, DEVICE_TLS_FILES.authorityKey), keyText);
    const ended = ensureDeviceTls({ dir, addresses: ['127.0.0.1'], now: new Date(NOW.getTime() + 11 * 365 * DAY) });
    expect(!ended.ok && ended.problem).toMatch(/can no longer lock the handheld door/);
    const soon = made(dir, ['127.0.0.1'], new Date(NOW.getTime() + 9.5 * 365 * DAY));
    expect(soon.events.map((e) => e.kind)).toContain('authority_ends_soon');
    expect(createPrivateKey(keyText).asymmetricKeyType).toBe('ec');
  });

  it('opens the door only on this computer or a private shop address; a public address or a name is refused in words', () => {
    expect(socketAddressesFor('127.0.0.1')).toEqual({ ok: true, addresses: ['127.0.0.1'] });
    expect(socketAddressesFor('192.168.10.5')).toEqual({ ok: true, addresses: ['127.0.0.1', '192.168.10.5'] });
    const all = socketAddressesFor('0.0.0.0', { eth0: [{ address: '10.0.0.9', family: 'IPv4', internal: false, netmask: '255.0.0.0', mac: '00:00:00:00:00:00', cidr: '10.0.0.9/8' }, { address: '203.0.113.9', family: 'IPv4', internal: false, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: null }] });
    expect(all).toEqual({ ok: true, addresses: ['127.0.0.1', '10.0.0.9'] });
    for (const host of ['8.8.8.8', 'store-pc.example.com', '::']) {
      const out = socketAddressesFor(host);
      expect(out.ok).toBe(false);
      expect(!out.ok && out.problem).toMatch(/not this computer's address on the staff wifi/);
    }
    expect(ensureDeviceTls({ dir: '/nonexistent-never', addresses: ['8.8.8.8'], now: NOW })).toMatchObject({ ok: false });
  });
});

describe('the door speaks TLS only (device-server.ts)', () => {
  const CODE = 'ABCDE-FGHJK-LMNPQ-RSTUV';
  const DEVICES: PackDevice[] = [{ deviceId: 'hh-01', kind: 'handheld', status: 'registered', label: 'Racking 1', enrolment: { codeHash: enrolmentCodeHash(CODE), expiresAt: '2099-01-01T00:00:00.000Z' } }] as PackDevice[];

  async function door(madeAt = new Date()): Promise<{ server: DeviceServer; dir: string; tlsDir: string }> {
    const dir = await tempDir();
    const tlsDir = join(dir, 'device-tls');
    const tls = made(tlsDir, ['127.0.0.1'], madeAt);
    const enrolments = await DeviceEnrolments.open({ dataDir: dir, capacityBytes: 10 * 1024 * 1024 });
    registers.push(enrolments);
    const pack = readPack({ version: 1, policies: { storeId: 'store-1', tradingDayCutoff: '00:00' } }, NOW.toISOString());
    const snapshot = (): ScreenInput => ({ pack, sales: [], unreadableRecords: 0, outbox: new SyncOutbox(), now: NOW.toISOString(), tradingDay: '2026-10-27' });
    const server = await startDeviceServer({
      port: 0, appsDir: 'apps', snapshot, enrolments, devices: () => DEVICES,
      relayDeviceEvents: async () => ({ acks: [] }), deviceEventStatus: () => [],
      syncStatus: () => ({ cloud: 'not_configured', unsent: 0, deadLettered: 0, lastSentAt: null, lastContactAt: null, now: NOW.toISOString(), staffMessage: '' }),
      operators: null, now: () => new Date().toISOString(),
      tls: { dir: tlsDir, addresses: ['127.0.0.1'], material: tls.tls },
    });
    servers.push(server);
    return { server, dir, tlsDir };
  }
  const handshake = (port: number, opts: { ca?: string; maxVersion?: 'TLSv1.1' | 'TLSv1.3' } = {}): Promise<{ authorized: boolean; error?: string; fingerprint?: string }> => new Promise((resolve) => {
    const socket = tlsConnect({ host: '127.0.0.1', port, ...(opts.ca === undefined ? {} : { ca: opts.ca }), ...(opts.maxVersion === undefined ? {} : { maxVersion: opts.maxVersion, minVersion: 'TLSv1' }) }, () => {
      resolve({ authorized: socket.authorized, fingerprint: socket.getPeerCertificate().fingerprint256 });
      socket.end();
    });
    socket.on('error', (e) => { resolve({ authorized: false, error: (e as NodeJS.ErrnoException).code ?? e.message }); });
  });
  const plain = (port: number, text: string): Promise<string> => new Promise((resolve) => {
    const socket = netConnect({ host: '127.0.0.1', port }, () => { socket.write(text); });
    const chunks: Buffer[] = [];
    socket.on('data', (c: Buffer) => chunks.push(c));
    socket.on('close', () => { resolve(Buffer.concat(chunks).toString('utf8')); });
    socket.on('error', () => { resolve(Buffer.concat(chunks).toString('utf8')); });
  });

  it('a device trusting this box\'s authority completes the handshake; one that never trusted it, or trusts another box, cannot connect; TLS 1.1 is refused', async () => {
    const { server } = await door();
    const other = made(join(await tempDir(), 'other-box'));
    expect(server.scheme).toBe('https');
    const trusted = await handshake(server.port, { ca: server.authority().pem });
    expect(trusted.authorized).toBe(true);
    expect(trusted.fingerprint).toBe(server.certificate().fingerprint);
    expect(await handshake(server.port)).toMatchObject({ authorized: false, error: 'SELF_SIGNED_CERT_IN_CHAIN' });
    expect((await handshake(server.port, { ca: other.tls.authorityPem })).authorized).toBe(false);
    expect((await handshake(server.port, { ca: server.authority().pem, maxVersion: 'TLSv1.1' })).authorized).toBe(false);
    // Node's own fetch (no authority installed) is refused too — the "click-through" path does not exist.
    await expect(fetch(`https://127.0.0.1:${server.port}/device/enrol`)).rejects.toThrow();
  });

  it('plain http on the door is refused in words (426) — nothing is read, nothing is served, no cookie is set', async () => {
    const { server } = await door();
    const reply = await plain(server.port, `POST /device/enrol HTTP/1.1\r\nhost: 127.0.0.1\r\ncontent-type: application/json\r\ncontent-length: 50\r\n\r\n${JSON.stringify({ deviceId: 'hh-01', code: CODE }).padEnd(50)}`);
    expect(reply.startsWith('HTTP/1.1 426 Upgrade Required\r\n')).toBe(true);
    expect(reply).toContain(PLAIN_HTTP_REFUSAL);
    expect(reply).toMatch(/https only \(OB-422\): plain http on the shop network is refused/);
    expect(reply).not.toMatch(/set-cookie/i);
    const get = await fetch(`http://127.0.0.1:${server.port}/warehouse/`);
    expect(get.status).toBe(426);
    expect(await get.text()).toContain('இது கடை கணினியின் கைக்கருவி வாசல்');
    // The code was not used by the refused request: a trusted device still enrols with it.
    const ok = await trustingFetch(server.authority().pem)(`https://127.0.0.1:${server.port}/device/enrol`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: 'hh-01', code: CODE }) });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('set-cookie')).toMatch(new RegExp(`^${DEVICE_COOKIE}=[^;]+; Path=/; HttpOnly; Secure; SameSite=Strict;`));
  });

  it('a renewed certificate keeps an enrolled device working: same authority, same credential, new certificate on the next connection', async () => {
    // The lock was made 65 days ago, so its 90-day certificate has 25 days left — inside the renewal window.
    const { server } = await door(new Date(Date.now() - 65 * DAY));
    const trusting = trustingFetch(server.authority().pem);
    const base = `https://127.0.0.1:${server.port}`;
    const enrolled = await trusting(`${base}/device/enrol`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: 'hh-01', code: CODE }) });
    const cookie = enrolled.headers.get('set-cookie')!.split(';')[0]!;
    const before = server.certificate();
    const authority = server.authority().fingerprint;
    expect((await trusting(`${base}/lane/sync-status`, { headers: { cookie } })).status).toBe(200);
    // Early (as it stood 10 days ago): nothing to do. Today, inside the last 30 days: renewed, in place, door open.
    expect(server.renew(new Date(Date.now() - 10 * DAY))).toEqual({ ok: true, events: [] });
    const renewal = server.renew(new Date());
    expect(renewal.ok && renewal.events.map((e) => e.kind)).toEqual(['certificate_renewed']);
    expect(server.certificate().fingerprint).not.toBe(before.fingerprint);
    expect(server.authority().fingerprint).toBe(authority);
    const after = await handshake(server.port, { ca: server.authority().pem });
    expect(after).toMatchObject({ authorized: true, fingerprint: server.certificate().fingerprint });
    const still = await trusting(`${base}/lane/sync-status`, { headers: { cookie } });
    expect(still.status).toBe(200);
    expect(await still.json()).toMatchObject({ cloud: 'not_configured' });
  });
});
