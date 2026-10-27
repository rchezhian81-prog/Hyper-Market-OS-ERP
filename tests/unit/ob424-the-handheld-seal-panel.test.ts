import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { createHash, X509Certificate } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureDeviceTls, type DeviceTlsMaterial } from '../../edge/store-edge/src/device-tls';
import { handheldSealPage, handheldSealPanel, sealCode, HANDHELD_SEAL_PATHS, SEAL_NOT_READY_WORDS } from '../../edge/store-edge/src/handheld-seal';
import { encodeQr } from '../../packages/receipt/src/qr-code';
import { readQr, matrixFromQrSvg } from '../support/qr-reader';

/**
 * **OB-424 (owner, 27 Oct 2026) · ADR-0030: the "Handheld seal" panel's data.**
 *
 * The seal (the store computer's authority certificate, OB-422) reaches a new handheld from the store PC's own screen:
 *   • a download of `authority.crt` — the certificate itself, DER, public; never a key;
 *   • a QR code that CARRIES the certificate (its PEM) — read back here by a separate reader, as a phone would read it;
 *   • the short code staff compare by eye — the start and the end of the SHA-256 fingerprint Android shows.
 * With no seal to show (no door, the door shut, a seal that does not agree with itself) the panel says so in English and
 * Tamil and shows no QR, no code and no download — it never makes one up.
 */

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

async function lock(): Promise<DeviceTlsMaterial> {
  const dir = await mkdtemp(join(tmpdir(), 'sre-ob424-'));
  dirs.push(dir);
  const made = ensureDeviceTls({ dir: join(dir, 'device-tls'), addresses: ['127.0.0.1', '192.168.1.20'], now: new Date() });
  if (!made.ok) throw new Error(made.problem);
  return made.tls;
}
const door = (tls: DeviceTlsMaterial, pem = tls.authorityPem, fingerprint = tls.authorityFingerprint) =>
  ({ kind: 'door' as const, authority: { pem, fingerprint, notAfter: tls.authorityNotAfter } });
const shaColon = (der: Buffer): string => (createHash('sha256').update(der).digest('hex').toUpperCase().match(/../g) ?? []).join(':');

describe('OB-424: the test QR reader reads what the encoder writes', () => {
  it('reads short and long texts back, across versions with one block and with many', () => {
    for (const text of ['SRE', 'x'.repeat(120), 'certificate '.repeat(70)]) {
      for (const ecl of ['L', 'M'] as const) {
        const symbol = encodeQr(text, { ecl });
        const read = readQr(symbol.dark);
        expect(read.version).toBe(symbol.version);
        expect(read.ecl).toBe(ecl);
        expect(read.bytes.toString('utf8')).toBe(text);
      }
    }
  });
});

describe('OB-424: the handheld seal panel', () => {
  it('shows the door\'s own authority: the download is that certificate, the QR carries it, the code is its fingerprint', async () => {
    const tls = await lock();
    const panel = handheldSealPanel(door(tls));
    expect(panel.ok).toBe(true);
    if (!panel.ok) return;
    // The download is the certificate the door is locked under, in DER — the same certificate, byte for byte.
    expect(Buffer.compare(panel.certificateDer, Buffer.from(new X509Certificate(tls.authorityPem).raw))).toBe(0);
    expect(shaColon(panel.certificateDer)).toBe(tls.authorityFingerprint);
    expect(panel.fingerprint).toBe(tls.authorityFingerprint);
    expect(new X509Certificate(panel.certificateDer).ca).toBe(true);
    expect(panel.download).toEqual({ path: HANDHELD_SEAL_PATHS.certificate, fileName: 'authority.crt', type: 'application/x-x509-ca-cert' });
    // The short code: the first four and the last four pairs of the SAME fingerprint.
    const pairs = tls.authorityFingerprint.split(':');
    expect(panel.code).toBe(`${pairs.slice(0, 4).join(':')} … ${pairs.slice(-4).join(':')}`);
    expect(sealCode(tls.authorityFingerprint)).toBe(panel.code);
    // The QR, read back from its own SVG by a separate reader, is the certificate itself — and nothing else.
    const read = readQr(matrixFromQrSvg(panel.qr.svg));
    expect(read.version).toBe(panel.qr.version);
    expect(read.bytes.toString('utf8')).toBe(panel.certificatePem);
    expect(new X509Certificate(read.bytes.toString('utf8')).fingerprint256).toBe(tls.authorityFingerprint);
    expect(panel.qr.carries).toBe('certificate_pem');
    // Small enough for a phone to read off a PC screen (version 25 is 117 modules a side).
    expect(panel.qr.version).toBeLessThanOrEqual(25);
  });

  it('carries no private key anywhere: not in the data, not in the page, not in the QR', async () => {
    const tls = await lock();
    const panel = handheldSealPanel(door(tls));
    if (!panel.ok) throw new Error('not ready');
    const page = handheldSealPage(panel);
    const qrText = readQr(matrixFromQrSvg(panel.qr.svg)).bytes.toString('utf8');
    const keyBody = tls.socketKeyPem.split('\n')[1]!;
    for (const text of [JSON.stringify({ ...panel, certificateDer: panel.certificateDer.toString('base64') }), page, qrText, panel.certificateDer.toString('latin1')]) {
      expect(text).not.toMatch(/PRIVATE KEY/);
      expect(text).not.toContain(keyBody);
    }
  });

  it('the page shows the QR, the code, the full fingerprint and the download link, in English and Tamil', async () => {
    const tls = await lock();
    const panel = handheldSealPanel(door(tls));
    if (!panel.ok) throw new Error('not ready');
    const page = handheldSealPage(panel);
    expect(page).toContain('id="handheld-seal" data-seal="ready"');
    expect(page).toMatch(/<figure id="seal-qr" data-carries="certificate_pem"[^>]*><svg /);
    expect(page).toContain(`<p class="code" id="seal-code">${panel.code}</p>`);
    expect(page).toContain(tls.authorityFingerprint);
    expect(page).toContain(`href="${HANDHELD_SEAL_PATHS.certificate}" download="authority.crt"`);
    expect(page).toContain('கைக்கருவி முத்திரை');
    expect(page).toContain('lang="ta"');
  });

  it('with no seal to show it says why in English and Tamil, and shows no QR, no code and no download', () => {
    const cases = [
      { source: { kind: 'no_door' as const }, reason: 'no_door' as const },
      { source: { kind: 'starting' as const }, reason: 'starting' as const },
      { source: { kind: 'shut' as const, problem: 'the handheld door\'s authority is there but its key does not match its certificate' }, reason: 'door_shut' as const },
    ];
    for (const c of cases) {
      const panel = handheldSealPanel(c.source);
      expect(panel).toMatchObject({ ok: false, reason: c.reason, en: SEAL_NOT_READY_WORDS[c.reason].en, ta: SEAL_NOT_READY_WORDS[c.reason].ta });
      const page = handheldSealPage(panel);
      expect(page).toContain('role="alert"');
      expect(page).toContain(SEAL_NOT_READY_WORDS[c.reason].en);
      expect(page).toContain(SEAL_NOT_READY_WORDS[c.reason].ta);
      for (const absent of ['<svg', 'id="seal-code"', 'id="seal-download"', 'BEGIN CERTIFICATE']) expect(page).not.toContain(absent);
      if (c.source.kind === 'shut') expect(page).toContain('its key does not match its certificate');
    }
  });

  it('refuses, by name, a seal that does not agree with itself — never shows it', async () => {
    const tls = await lock();
    const socketCert = `${tls.socketChainPem.split('-----END CERTIFICATE-----')[0]!}-----END CERTIFICATE-----\n`;
    const other = await lock();
    const bad = [
      door(tls, `${tls.authorityPem}${tls.socketKeyPem}`), // a key riding with the certificate
      door(tls, tls.authorityPem, other.authorityFingerprint), // the door says one fingerprint, the certificate is another
      door(tls, socketCert, new X509Certificate(socketCert).fingerprint256), // not an authority at all
      door(tls, '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n'), // not readable
    ];
    for (const source of bad) {
      const panel = handheldSealPanel(source);
      expect(panel).toMatchObject({ ok: false, reason: 'seal_does_not_agree' });
      expect(handheldSealPage(panel)).not.toContain('<svg');
    }
  });
});
