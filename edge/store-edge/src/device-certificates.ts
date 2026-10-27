// The store computer's own certificates for the shop-network device socket (OB-422 · ADR-0030 · hard rule #4 · P-04).
//
// The store computer is its own small signing AUTHORITY: one key pair it makes at install, never copied off the box, and a
// certificate for it that each handheld trusts ONCE, when it is enrolled. With that key it signs the certificate the device
// socket presents. That certificate can then be renewed by the box itself, as often as it likes, and every enrolled
// device keeps trusting it — because they trust the authority, not the certificate.
//
// Node can make keys and sign bytes, but it has no API that WRITES an X.509 certificate (`X509Certificate` only reads).
// So this file encodes the few DER structures a certificate needs, by hand, with nothing but `node:crypto` (no new
// dependency: an ADR line would be needed for one). Everything here is pure: the keys, the clock and the serial numbers
// arrive as arguments, and the output is checked by Node's own `X509Certificate` and by OpenSSL in the tests.
//
// ── What the authority may vouch for (name constraints) ──────────────────────
//
// A device that trusts an authority trusts EVERYTHING it signs. A store computer's authority that could sign a
// certificate for "a bank's website" would make every handheld a phone that a stolen store-computer key could listen in
// on. So the authority's own certificate carries critical NAME CONSTRAINTS: it may only vouch for `localhost` and for
// addresses in the private ranges a shop network uses (10/8, 172.16/12, 192.168/16) and loopback (127/8). A certificate
// it signs for any other name or address is refused by the device's own TLS check (OpenSSL and Chrome both enforce it).

import { createHash, randomBytes, sign, type KeyObject } from 'node:crypto';
import { isIPv4 } from 'node:net';

// ── DER, the few shapes a certificate uses ─────────────────────────────────────────────────────────────────────────

const lengthOf = (n: number): Buffer => {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};
const tlv = (tag: number, value: Buffer): Buffer => Buffer.concat([Buffer.from([tag]), lengthOf(value.length), value]);
const seq = (...items: Buffer[]): Buffer => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]): Buffer => tlv(0x31, Buffer.concat(items));
const octets = (b: Buffer): Buffer => tlv(0x04, b);
const bits = (b: Buffer, unused = 0): Buffer => tlv(0x03, Buffer.concat([Buffer.from([unused]), b]));
const bool = (v: boolean): Buffer => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
const utf8 = (s: string): Buffer => tlv(0x0c, Buffer.from(s, 'utf8'));
const explicit = (n: number, inner: Buffer): Buffer => tlv(0xa0 | n, inner);

/** A non-negative INTEGER from big-endian bytes (a leading zero added when the top bit is set, none kept otherwise). */
function integer(bytes: Buffer): Buffer {
  let b = bytes;
  while (b.length > 1 && b[0] === 0 && (b[1]! & 0x80) === 0) b = b.subarray(1);
  if ((b[0]! & 0x80) !== 0) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}
const smallInteger = (n: number): Buffer => integer(Buffer.from([n]));

function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number);
  const out: number[] = [40 * parts[0]! + parts[1]!];
  for (const part of parts.slice(2)) {
    const chunk: number[] = [];
    let v = part;
    do { chunk.unshift(v & 0x7f); v = Math.floor(v / 128); } while (v > 0);
    for (let i = 0; i < chunk.length - 1; i += 1) chunk[i]! |= 0x80;
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

/** UTCTime up to 2049, GeneralizedTime from 2050 (RFC 5280 §4.1.2.5), always whole seconds in UTC. */
function time(at: Date): Buffer {
  // An instant in UTC, as a certificate wants it — never a shop date (the shop clock is packages/calendar's).
  const two = (n: number): string => String(n).padStart(2, '0');
  const rest = `${two(at.getUTCMonth() + 1)}${two(at.getUTCDate())}${two(at.getUTCHours())}${two(at.getUTCMinutes())}${two(at.getUTCSeconds())}Z`;
  const year = at.getUTCFullYear();
  return year < 2050 ? tlv(0x17, Buffer.from(`${two(year % 100)}${rest}`, 'ascii')) : tlv(0x18, Buffer.from(`${year}${rest}`, 'ascii'));
}

const OID = Object.freeze({
  ecdsaWithSha256: '1.2.840.10045.4.3.2',
  commonName: '2.5.4.3',
  organization: '2.5.4.10',
  subjectKeyIdentifier: '2.5.29.14',
  keyUsage: '2.5.29.15',
  subjectAltName: '2.5.29.17',
  basicConstraints: '2.5.29.19',
  nameConstraints: '2.5.29.30',
  authorityKeyIdentifier: '2.5.29.35',
  extKeyUsage: '2.5.29.37',
  serverAuth: '1.3.6.1.5.5.7.3.1',
});

const algorithm = (): Buffer => seq(oid(OID.ecdsaWithSha256));
const name = (commonName: string, organization: string): Buffer =>
  seq(set(seq(oid(OID.organization), utf8(organization))), set(seq(oid(OID.commonName), utf8(commonName))));
const extension = (id: string, critical: boolean, value: Buffer): Buffer =>
  seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));

const ipv4Bytes = (address: string): Buffer => Buffer.from(address.split('.').map(Number));
/** A subjectAltName / name-constraint entry: dNSName is [2] IA5String, iPAddress is [7] OCTET STRING. */
const dnsName = (dns: string): Buffer => tlv(0x82, Buffer.from(dns, 'ascii'));
const ipAddress = (bytes: Buffer): Buffer => tlv(0x87, bytes);

/** The key identifier of a public key: SHA-1 over the subjectPublicKey bits (RFC 5280 §4.2.1.2, method 1). */
export function keyIdOf(publicKey: KeyObject): Buffer {
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  // SubjectPublicKeyInfo = SEQUENCE { AlgorithmIdentifier, BIT STRING }. The BIT STRING is the last element; for an EC
  // P-256 key it is the 65-byte uncompressed point after a one-byte "unused bits" count.
  const point = spki.subarray(spki.length - 65);
  return createHash('sha1').update(point).digest();
}

// ── What the store computer's authority may vouch for ──────────────────────────────────────────────────────────────

/** The private and loopback IPv4 ranges a shop network uses — the only addresses the authority may sign for. */
export const PERMITTED_RANGES: readonly { readonly base: string; readonly mask: string }[] = Object.freeze([
  { base: '127.0.0.0', mask: '255.0.0.0' },
  { base: '10.0.0.0', mask: '255.0.0.0' },
  { base: '172.16.0.0', mask: '255.240.0.0' },
  { base: '192.168.0.0', mask: '255.255.0.0' },
]);
/** The only DNS name the authority may sign for: this computer itself. */
export const PERMITTED_DNS = 'localhost';

const toInt = (address: string): number => address.split('.').reduce((n, part) => n * 256 + Number(part), 0);
/** Is this an IPv4 address the store computer's authority may vouch for (loopback or a private shop-network range)? */
export function isPermittedAddress(address: string): boolean {
  if (!isIPv4(address)) return false;
  const a = toInt(address);
  return PERMITTED_RANGES.some((r) => (a & toInt(r.mask)) >>> 0 === toInt(r.base));
}

// ── Issuing ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface IssuedCertificate {
  readonly pem: string;
  readonly der: Buffer;
}

const pemOf = (der: Buffer): string => `-----BEGIN CERTIFICATE-----\n${der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')}\n-----END CERTIFICATE-----\n`;

/** A fresh 16-byte serial (positive, never zero): the CA/B rule of at least 64 random bits, kept here too. */
export const newSerial = (): Buffer => { const b = randomBytes(16); b[0] = (b[0]! & 0x7f) | 0x01; return b; };

function certificate(tbs: Buffer, signingKey: KeyObject): IssuedCertificate {
  const signature = sign('sha256', tbs, { key: signingKey, dsaEncoding: 'der' });
  const der = seq(tbs, algorithm(), bits(signature));
  return { der, pem: pemOf(der) };
}

/**
 * The authority's own certificate: self-signed, CA:true with no CA below it (path length 0), may sign certificates only,
 * and constrained (critical) to `localhost` and the private and loopback IPv4 ranges.
 */
export function issueAuthorityCertificate(input: {
  readonly publicKey: KeyObject;
  readonly privateKey: KeyObject;
  readonly commonName: string;
  readonly notBefore: Date;
  readonly notAfter: Date;
  readonly serial?: Buffer;
}): IssuedCertificate {
  const subject = name(input.commonName, 'SRE Retail OS store computer');
  const keyId = keyIdOf(input.publicKey);
  const permitted = explicit(0, Buffer.concat([
    seq(dnsName(PERMITTED_DNS)),
    ...PERMITTED_RANGES.map((r) => seq(ipAddress(Buffer.concat([ipv4Bytes(r.base), ipv4Bytes(r.mask)])))),
  ]));
  const extensions = seq(
    extension(OID.basicConstraints, true, seq(bool(true), smallInteger(0))),
    // keyCertSign (bit 5) and cRLSign (bit 6): 0b0000_0110, one unused bit.
    extension(OID.keyUsage, true, bits(Buffer.from([0x06]), 1)),
    extension(OID.subjectKeyIdentifier, false, octets(keyId)),
    extension(OID.nameConstraints, true, seq(permitted)),
  );
  const tbs = seq(
    explicit(0, smallInteger(2)),
    integer(input.serial ?? newSerial()),
    algorithm(),
    subject,
    seq(time(input.notBefore), time(input.notAfter)),
    subject,
    input.publicKey.export({ type: 'spki', format: 'der' }),
    explicit(3, extensions),
  );
  return certificate(tbs, input.privateKey);
}

/**
 * The device socket's certificate: signed by the authority, for `localhost` and the named IPv4 addresses only (every one
 * inside the authority's constraints — anything else is refused here, before it is signed), server authentication only.
 */
export function issueSocketCertificate(input: {
  readonly publicKey: KeyObject;
  readonly authorityPublicKey: KeyObject;
  readonly authorityPrivateKey: KeyObject;
  readonly authorityCommonName: string;
  readonly addresses: readonly string[];
  readonly notBefore: Date;
  readonly notAfter: Date;
  readonly serial?: Buffer;
}): IssuedCertificate {
  const outside = input.addresses.filter((a) => !isPermittedAddress(a));
  if (outside.length > 0) throw new Error(`the store computer's authority may not vouch for ${outside.join(', ')} — only loopback and private shop-network addresses`);
  const addresses = [...new Set(input.addresses)];
  const extensions = seq(
    extension(OID.basicConstraints, true, seq()),
    // digitalSignature (bit 0): 0b1000_0000, seven unused bits.
    extension(OID.keyUsage, true, bits(Buffer.from([0x80]), 7)),
    extension(OID.extKeyUsage, false, seq(oid(OID.serverAuth))),
    extension(OID.subjectAltName, true, seq(dnsName(PERMITTED_DNS), ...addresses.map((a) => ipAddress(ipv4Bytes(a))))),
    extension(OID.subjectKeyIdentifier, false, octets(keyIdOf(input.publicKey))),
    extension(OID.authorityKeyIdentifier, false, seq(tlv(0x80, keyIdOf(input.authorityPublicKey)))),
  );
  const tbs = seq(
    explicit(0, smallInteger(2)),
    integer(input.serial ?? newSerial()),
    algorithm(),
    name(input.authorityCommonName, 'SRE Retail OS store computer'),
    seq(time(input.notBefore), time(input.notAfter)),
    // An empty subject is allowed when the subjectAltName is critical (RFC 5280 §4.1.2.6); a short name reads better.
    name('SRE store computer — handheld door', 'SRE Retail OS store computer'),
    input.publicKey.export({ type: 'spki', format: 'der' }),
    explicit(3, extensions),
  );
  return certificate(tbs, input.authorityPrivateKey);
}

/** The SHA-256 fingerprint a person compares by eye: upper-case hex pairs separated by colons. */
export function fingerprintOf(der: Buffer): string {
  return (createHash('sha256').update(der).digest('hex').toUpperCase().match(/../g) ?? []).join(':');
}
