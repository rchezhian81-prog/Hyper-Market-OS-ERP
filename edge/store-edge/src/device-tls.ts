// The lock on the store computer's shop-network door (OB-422 · ADR-0030 · ADR-0019 · ADR-0028 · hard rules #4/#6 · P-04 ·
// P-08).
//
// The device socket — the one door the handhelds, the queue till and anything else on the staff wifi use — speaks TLS
// only. This file keeps what that needs, in ONE folder on the store computer (`EDGE_DEVICE_TLS_DIR`), outside the till's
// data folder so a backup never carries a private key off the box:
//
//   authority-key.pem       the store computer's own signing authority's PRIVATE key — made here, never leaves this folder
//   authority.crt           its certificate (public): what each handheld trusts ONCE, when it is enrolled
//   device-socket-key.pem   the door's own private key — made here, replaced at every renewal
//   device-socket.crt       the door's certificate, signed by the authority, for `localhost` and the shop address only
//   device-tls-history.log  what was made or renewed, when, with fingerprints and expiry — never a key (append-only)
//
// `ensureDeviceTls` is the only entry: at install (the till installer runs `start.js device-authority`), at every start,
// and on the renewal timer. It makes the authority once, and (re)issues the door's certificate when there is none, when it
// is within RENEW_WITHIN_DAYS of its end, when it does not cover the address the door is opened on, or when its key and
// certificate do not belong together. A renewed certificate is signed by the SAME authority, so every enrolled device
// keeps working without anybody touching it.
//
// What it never does: overwrite or "repair" an authority that is there but broken (a key that does not match its
// certificate, one half missing, an authority past its end). That would silently change what every handheld trusts.
// It refuses by name instead (P-08, hard rule #10): the door stays shut, the till keeps selling on its own loopback
// (hard rule #1), and the boot log and the doctor say what to do.

import { createPrivateKey, createPublicKey, generateKeyPairSync, createHash, X509Certificate, type KeyObject } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { fingerprintOf, isPermittedAddress, issueAuthorityCertificate, issueSocketCertificate } from './device-certificates';

export const DEVICE_TLS_FILES = Object.freeze({
  authorityKey: 'authority-key.pem',
  authorityCert: 'authority.crt',
  socketKey: 'device-socket-key.pem',
  socketCert: 'device-socket.crt',
  history: 'device-tls-history.log',
});

/** How long the door's certificate is made for. Short, because the box renews it itself and nobody has to touch a device. */
export const SOCKET_CERT_DAYS = 90;
/** Renew when this little is left — weeks of margin for a store computer that was switched off for a holiday. */
export const RENEW_WITHIN_DAYS = 30;
/** How long the authority is made for. Replacing it means every handheld trusts the new one (re-enrolment). */
export const AUTHORITY_YEARS = 10;
/** Start warning this long before the authority itself ends. */
export const AUTHORITY_WARN_DAYS = 365;
/** How often a running store computer checks whether the door's certificate needs renewing. */
export const RENEW_CHECK_MS = 6 * 3_600_000;

const DAY_MS = 86_400_000;

export interface DeviceTlsMaterial {
  /** The authority's certificate, PEM — public; what an enrolled device trusts. */
  readonly authorityPem: string;
  /** SHA-256 of the authority certificate, colon hex — what a person compares by eye at enrolment. */
  readonly authorityFingerprint: string;
  /** SHA-256 of the authority's public key (base64) — the form a browser's key pin takes. */
  readonly authorityKeyPin: string;
  readonly authorityNotAfter: string;
  /** The door's certificate chain, PEM (its certificate, then the authority's). */
  readonly socketChainPem: string;
  /** The door's private key, PEM — in memory only, handed to the TLS server, never logged or returned to a caller. */
  readonly socketKeyPem: string;
  readonly socketFingerprint: string;
  readonly socketNotAfter: string;
  readonly addresses: readonly string[];
}

export type DeviceTlsEvent =
  | { readonly kind: 'authority_created'; readonly fingerprint: string; readonly notAfter: string }
  | { readonly kind: 'certificate_issued' | 'certificate_renewed'; readonly fingerprint: string; readonly notAfter: string; readonly addresses: readonly string[]; readonly why: string }
  | { readonly kind: 'authority_ends_soon'; readonly notAfter: string };

export type EnsureDeviceTls =
  | { readonly ok: true; readonly tls: DeviceTlsMaterial; readonly events: readonly DeviceTlsEvent[] }
  | { readonly ok: false; readonly problem: string };

/**
 * The addresses the door's certificate must cover, from the address the door is opened on. Loopback → this computer only;
 * a private shop-network address → that and loopback; `0.0.0.0` → every private IPv4 address this computer has now. Any
 * other host (a public address, a name, IPv6) is refused: the authority may not vouch for it.
 */
export function socketAddressesFor(host: string, interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()):
  { readonly ok: true; readonly addresses: readonly string[] } | { readonly ok: false; readonly problem: string } {
  const h = host.trim();
  if (h === '127.0.0.1' || h === 'localhost') return { ok: true, addresses: ['127.0.0.1'] };
  if (h === '0.0.0.0') {
    const own = Object.values(interfaces).flatMap((list) => list ?? []).filter((i) => i.family === 'IPv4' && !i.internal).map((i) => i.address).filter(isPermittedAddress);
    return { ok: true, addresses: ['127.0.0.1', ...new Set(own)] };
  }
  if (isPermittedAddress(h)) return { ok: true, addresses: h.startsWith('127.') ? [h] : ['127.0.0.1', h] };
  return {
    ok: false,
    problem: `EDGE_DEVICE_HOST is "${h}", which is not this computer's address on the staff wifi. Name its private address (10.x.x.x, 172.16–31.x.x or 192.168.x.x) — the handheld door is only ever opened, locked, on the shop's own network`,
  };
}

// ── Files: written whole (temp → fsync → rename), private keys owner-only ─────────────────────────────────────────────

function syncDir(dir: string): void {
  try { const fd = openSync(dir, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } } catch { /* Windows cannot open a folder; its rename is durable */ }
}
function writeWhole(dir: string, file: string, text: string, mode: number): void {
  const path = join(dir, file);
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'w', mode);
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  try { chmodSync(tmp, mode); } catch { /* Windows: the folder's own permissions apply */ }
  renameSync(tmp, path);
  syncDir(dir);
}
/** One framed record (`<bytes> <json>\n`, the edge's own log framing), appended and fsync'd. Never a key. */
function appendHistory(dir: string, record: Record<string, unknown>): void {
  const line = JSON.stringify(record);
  const fd = openSync(join(dir, DEVICE_TLS_FILES.history), 'a', 0o600);
  try { writeSync(fd, `${Buffer.byteLength(line, 'utf8')} ${line}\n`); fsyncSync(fd); } finally { closeSync(fd); }
}
const read = (dir: string, file: string): string | undefined => {
  const path = join(dir, file);
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
};

const spkiOf = (key: KeyObject): Buffer => key.export({ type: 'spki', format: 'der' });
const sameKey = (a: KeyObject, b: KeyObject): boolean => spkiOf(a).equals(spkiOf(b));
const keyPinOf = (key: KeyObject): string => createHash('sha256').update(spkiOf(key)).digest('base64');

/**
 * Make or renew what the door needs, in `dir`. Pure apart from that folder; the clock is passed in. Never throws for a
 * problem a person must fix — it returns it in words.
 */
export function ensureDeviceTls(input: { readonly dir: string; readonly addresses: readonly string[]; readonly now: Date; readonly commonName?: string }): EnsureDeviceTls {
  const { dir, now } = input;
  const addresses = [...new Set(input.addresses)];
  const outside = addresses.filter((a) => !isPermittedAddress(a));
  if (outside.length > 0) return { ok: false, problem: `the handheld door cannot be locked for ${outside.join(', ')} — only for loopback and private shop-network addresses` };
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { chmodSync(dir, 0o700); } catch { /* Windows */ }
  } catch (e) {
    return { ok: false, problem: `the folder for the handheld door's lock (${dir}) could not be made (${(e as NodeJS.ErrnoException).code ?? 'error'})` };
  }
  const events: DeviceTlsEvent[] = [];
  const at = now.toISOString();
  const commonName = input.commonName ?? 'SRE store computer signing authority';

  // ── The authority: made once; never replaced or repaired here ──
  let authorityKey: KeyObject;
  let authorityCertPem: string;
  const keyText = read(dir, DEVICE_TLS_FILES.authorityKey);
  const certText = read(dir, DEVICE_TLS_FILES.authorityCert);
  if (keyText === undefined && certText === undefined) {
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const issued = issueAuthorityCertificate({
      publicKey: pair.publicKey, privateKey: pair.privateKey, commonName,
      notBefore: new Date(now.getTime() - 3_600_000), notAfter: new Date(now.getTime() + AUTHORITY_YEARS * 365 * DAY_MS),
    });
    try {
      writeWhole(dir, DEVICE_TLS_FILES.authorityKey, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, 0o600);
      writeWhole(dir, DEVICE_TLS_FILES.authorityCert, issued.pem, 0o644);
    } catch (e) {
      return { ok: false, problem: `the store computer's signing authority could not be written in ${dir} (${(e as NodeJS.ErrnoException).code ?? 'error'})` };
    }
    authorityKey = pair.privateKey;
    authorityCertPem = issued.pem;
    const x = new X509Certificate(issued.pem);
    const made = { kind: 'authority_created', fingerprint: fingerprintOf(issued.der), notAfter: new Date(x.validTo).toISOString() } as const;
    events.push(made);
    appendHistory(dir, { ...made, at });
  } else if (keyText === undefined || certText === undefined) {
    return { ok: false, problem: `the store computer's signing authority in ${dir} is incomplete (${keyText === undefined ? DEVICE_TLS_FILES.authorityKey : DEVICE_TLS_FILES.authorityCert} is missing). It was kept, not repaired. See the in-store install runbook, "The handheld door's lock"` };
  } else {
    try {
      authorityKey = createPrivateKey(keyText);
      authorityCertPem = certText;
      const x = new X509Certificate(certText);
      if (!sameKey(createPublicKey(authorityKey), x.publicKey) || !x.ca) throw new Error('mismatch');
    } catch {
      return { ok: false, problem: `the store computer's signing authority in ${dir} does not read back as one key and its certificate. It was kept, not repaired. See the in-store install runbook, "The handheld door's lock"` };
    }
  }
  const authority = new X509Certificate(authorityCertPem);
  const authorityEnds = new Date(authority.validTo);
  if (authorityEnds.getTime() <= now.getTime() + DAY_MS) {
    return { ok: false, problem: `the store computer's signing authority ends on ${authorityEnds.toISOString()} — it can no longer lock the handheld door. A new one must be made and every handheld enrolled again (runbook, "The handheld door's lock")` };
  }
  if (authorityEnds.getTime() - now.getTime() < AUTHORITY_WARN_DAYS * DAY_MS) events.push({ kind: 'authority_ends_soon', notAfter: authorityEnds.toISOString() });

  // ── The door's certificate: renewed by the box itself, always signed by the same authority ──
  const authorityPublic = createPublicKey(authorityKey);
  let why: string | null = null;
  let socketKeyPem = read(dir, DEVICE_TLS_FILES.socketKey);
  let socketCertPem = read(dir, DEVICE_TLS_FILES.socketCert);
  if (socketKeyPem === undefined || socketCertPem === undefined) why = 'there was none';
  else {
    try {
      const x = new X509Certificate(socketCertPem.split('-----END CERTIFICATE-----')[0] + '-----END CERTIFICATE-----\n');
      if (!x.verify(authorityPublic)) why = 'it was not signed by this store computer\'s authority';
      else if (!sameKey(createPublicKey(createPrivateKey(socketKeyPem)), x.publicKey)) why = 'its key and certificate did not belong together';
      else if (addresses.some((a) => x.checkIP(a) === undefined)) why = `it did not cover ${addresses.filter((a) => x.checkIP(a) === undefined).join(', ')}`;
      else if (new Date(x.validTo).getTime() - now.getTime() < RENEW_WITHIN_DAYS * DAY_MS) why = `it ends on ${new Date(x.validTo).toISOString()}`;
    } catch {
      why = 'it could not be read';
    }
  }
  if (why !== null) {
    const hadOne = socketCertPem !== undefined;
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const notAfter = new Date(Math.min(now.getTime() + SOCKET_CERT_DAYS * DAY_MS, authorityEnds.getTime()));
    let issued;
    try {
      issued = issueSocketCertificate({
        publicKey: pair.publicKey, authorityPublicKey: authorityPublic, authorityPrivateKey: authorityKey,
        authorityCommonName: authority.subject.split('\n').find((l) => l.startsWith('CN='))?.slice(3) ?? commonName,
        addresses, notBefore: new Date(now.getTime() - 3_600_000), notAfter,
      });
    } catch (e) {
      return { ok: false, problem: e instanceof Error ? e.message : String(e) };
    }
    socketKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    socketCertPem = `${issued.pem}${authorityCertPem}`;
    try {
      // The key first, then the certificate: a stop between the two leaves a pair that does not belong together, which the
      // next start sees ("did not belong together") and replaces — never a door presenting a certificate for a lost key.
      writeWhole(dir, DEVICE_TLS_FILES.socketKey, socketKeyPem, 0o600);
      writeWhole(dir, DEVICE_TLS_FILES.socketCert, socketCertPem, 0o644);
    } catch (e) {
      return { ok: false, problem: `the handheld door's certificate could not be written in ${dir} (${(e as NodeJS.ErrnoException).code ?? 'error'})` };
    }
    const done = { kind: hadOne ? 'certificate_renewed' : 'certificate_issued', fingerprint: fingerprintOf(issued.der), notAfter: notAfter.toISOString(), addresses, why } as const;
    events.push(done);
    appendHistory(dir, { ...done, at });
  }

  const leafPem = socketCertPem!.split('-----END CERTIFICATE-----')[0] + '-----END CERTIFICATE-----\n';
  const leaf = new X509Certificate(leafPem);
  return {
    ok: true,
    events,
    tls: {
      authorityPem: authorityCertPem,
      authorityFingerprint: authority.fingerprint256,
      authorityKeyPin: keyPinOf(authority.publicKey),
      authorityNotAfter: authorityEnds.toISOString(),
      socketChainPem: `${leafPem}${authorityCertPem}`,
      socketKeyPem: socketKeyPem!,
      socketFingerprint: leaf.fingerprint256,
      socketNotAfter: new Date(leaf.validTo).toISOString(),
      addresses,
    },
  };
}

/** One plain line per event, for the boot log and the command — fingerprints and dates only, never a key. */
export function sayDeviceTlsEvent(e: DeviceTlsEvent): string {
  switch (e.kind) {
    case 'authority_created':
      return `handheld door: this store computer made its own signing authority (fingerprint ${e.fingerprint}, until ${e.notAfter}). Each handheld trusts it once, when it is enrolled. A NEW authority means every handheld already set up must trust it again.`;
    case 'certificate_issued':
      return `handheld door: certificate made for ${e.addresses.join(', ')} until ${e.notAfter} (${e.why}).`;
    case 'certificate_renewed':
      return `handheld door: certificate renewed for ${e.addresses.join(', ')} until ${e.notAfter} (${e.why}); signed by the same authority, so enrolled handhelds keep working.`;
    case 'authority_ends_soon':
      return `handheld door: WARNING — this store computer's signing authority ends on ${e.notAfter}. Before then a new one must be made and every handheld enrolled again (runbook, "The handheld door's lock").`;
  }
}
