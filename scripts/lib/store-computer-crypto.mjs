// The store computer's backup encryption — OB-249 (automatic hourly ENCRYPTED backup of everything), audit rows 2–3
// (lane B: B7 "backups are not encrypted", B6/Q8 "an encrypted copy of the settings file").
//
// ── The approach, and why ──────────────────────────────────────────────────────────────────────────────────────────
// The hourly backup runs unattended, with nobody at the keyboard to type a passphrase. A passphrase-only scheme would
// therefore have to keep the passphrase (or a key made from it) on the PC, and then anyone holding the PC holds every
// backup. So this is the shape the hosted demo already uses with `age` (infra/pilot/backup/encrypted-backup.sh), built
// from Node's own crypto so the Windows PC needs nothing installed:
//
//   • ONE key pair, made once (X25519). Its PUBLIC half stays on the PC; every backup is encrypted TO it. Making a
//     backup needs no secret at all.
//   • Its PRIVATE half is sealed with the owner's passphrase — scrypt (N = 2^17, r = 8, p = 1: about 128 MB and a
//     fraction of a second per try, which makes guessing slow) → AES-256-GCM — and that sealed file is the ONLY thing
//     kept. The passphrase itself is never stored, never printed and never logged. The sealed key IS the verifier: the
//     passphrase is right exactly when GCM's tag says the sealed key opened. A copy of the sealed key goes onto each
//     backup drive, so a new PC can open the backups with the drive and the passphrase alone.
//   • Each file: a fresh ephemeral X25519 key, ECDH with the public key, HKDF-SHA-256 → a 256-bit key for that file
//     only, then AES-256-GCM in 1 MiB chunks. Every chunk's additional data binds the header, its index and a "last
//     chunk" flag, so a reordered, swapped, cut-short or extended file is refused — never half-trusted.
//
// What this protects: a backup drive that is lost or stolen is unreadable without the passphrase (DPDP Act s.8(5),
// roadmap §33/§35 "encrypted backups"). What it does not: someone who learns the passphrase. If the passphrase is
// forgotten, the backups cannot be opened by anyone — the guide says so, and says to write it on paper kept away from
// the PC.
//
// Node built-ins only. Everything that touches files takes `fs` from the caller, so tests drive it on a temp folder.

import {
  createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync,
  hkdfSync, randomBytes, scryptSync, timingSafeEqual,
} from 'node:crypto';

export const KEY_FILE_KIND = 'sre-backup-key';
export const SCHEME = 'x25519-hkdf-sha256/aes-256-gcm';
const MAGIC = Buffer.from('SREENC1\n', 'latin1');
export const CHUNK_BYTES = 1024 * 1024;
/** scrypt cost. 2^17 × r 8 = 128 MiB per try: fine on an 8 GB PC, slow for a guesser. Tests pass a smaller N. */
export const SCRYPT = Object.freeze({ N: 2 ** 17, r: 8, p: 1 });
/** The shortest passphrase accepted. Long enough that a guesser at scrypt speed gets nowhere; short enough to type. */
export const MIN_PASSPHRASE = 12;

const b64 = (b) => Buffer.from(b).toString('base64');
const unb64 = (s) => Buffer.from(String(s), 'base64');
const sha256 = (b) => createHash('sha256').update(b).digest();
const normal = (passphrase) => String(passphrase).normalize('NFC');
const maxmemFor = ({ N, r }) => 128 * N * r * 2 + 1024 * 1024;

/** What is wrong with a new passphrase, or undefined. Never echoes it. */
export function passphraseProblem(first, second) {
  const a = normal(first ?? '');
  if (a.trim().length < MIN_PASSPHRASE) return `the passphrase must be at least ${MIN_PASSPHRASE} characters (a short sentence you will remember is good)`;
  if (second !== undefined && a !== normal(second)) return 'the two passphrases you typed are not the same';
  return undefined;
}

/** The public key's short id: the first 16 hex characters of SHA-256 over its DER form. Not a secret. */
export function keyIdOf(publicKeyObject) {
  return sha256(publicKeyObject.export({ format: 'der', type: 'spki' })).toString('hex').slice(0, 16);
}

/**
 * Make the backup key pair and seal its private half with the passphrase. Returns the key file's content (JSON-ready).
 * `random` is the CSPRNG (injectable for nothing but tests of the format); `scrypt` the cost (tests use a cheaper one).
 */
export function makeBackupKey(passphrase, { now = new Date(), random = randomBytes, scrypt = SCRYPT } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const keyId = keyIdOf(publicKey);
  const salt = random(32);
  const iv = random(12);
  const kek = scryptSync(normal(passphrase), salt, 32, { ...scrypt, maxmem: maxmemFor(scrypt) });
  const c = createCipheriv('aes-256-gcm', kek, iv);
  c.setAAD(Buffer.from(`${KEY_FILE_KIND}/v1|${keyId}`, 'utf8'));
  const ct = Buffer.concat([c.update(privateKey.export({ format: 'der', type: 'pkcs8' })), c.final()]);
  return {
    kind: KEY_FILE_KIND,
    version: 1,
    keyId,
    createdAt: now.toISOString(),
    scheme: SCHEME,
    publicKey: b64(publicKey.export({ format: 'der', type: 'spki' })),
    sealedPrivateKey: { kdf: 'scrypt', N: scrypt.N, r: scrypt.r, p: scrypt.p, salt: b64(salt), iv: b64(iv), tag: b64(c.getAuthTag()), ct: b64(ct) },
    note: 'The backup key. Its private half opens only with the passphrase the owner chose; the passphrase is not in this file and is kept nowhere on any computer.',
  };
}

/** Is this a key file this module wrote? Returns the problem, or undefined. */
export function keyFileProblem(k) {
  if (k === null || typeof k !== 'object') return 'it is not a backup key file';
  if (k.kind !== KEY_FILE_KIND || k.version !== 1 || k.scheme !== SCHEME) return 'it is not a backup key file written by store-computer';
  if (typeof k.keyId !== 'string' || !/^[0-9a-f]{16}$/.test(k.keyId) || typeof k.publicKey !== 'string') return 'its key id or public key is missing';
  const s = k.sealedPrivateKey;
  if (s === null || typeof s !== 'object' || s.kdf !== 'scrypt' || ![s.N, s.r, s.p].every(Number.isInteger)) return 'its sealed private key is malformed';
  try { if (keyIdOf(publicKeyOf(k)) !== k.keyId) return 'its key id does not match its public key'; } catch { return 'its public key cannot be read'; }
  return undefined;
}

/** The public key from a key file (no passphrase needed — this is what every backup is encrypted to). */
export function publicKeyOf(keyFile) {
  return createPublicKey({ key: unb64(keyFile.publicKey), format: 'der', type: 'spki' });
}

/**
 * Open the private key with the passphrase. Returns { ok: true, privateKey } or { ok: false, problem } — a wrong
 * passphrase is an answer, not a crash. The passphrase is used for scrypt and dropped; it is never returned or kept.
 */
export function unlockBackupKey(keyFile, passphrase) {
  const problem = keyFileProblem(keyFile);
  if (problem !== undefined) return { ok: false, problem };
  const s = keyFile.sealedPrivateKey;
  const cost = { N: s.N, r: s.r, p: s.p };
  let der;
  try {
    const kek = scryptSync(normal(passphrase), unb64(s.salt), 32, { ...cost, maxmem: maxmemFor(cost) });
    // QG-03 SAST (gcm-no-tag-length): only a full 16-byte tag is accepted — a truncated tag is easier to forge.
    const d = createDecipheriv('aes-256-gcm', kek, unb64(s.iv), { authTagLength: 16 });
    d.setAAD(Buffer.from(`${KEY_FILE_KIND}/v1|${keyFile.keyId}`, 'utf8'));
    d.setAuthTag(unb64(s.tag));
    der = Buffer.concat([d.update(unb64(s.ct)), d.final()]);
  } catch {
    return { ok: false, problem: 'that passphrase does not open this backup key', wrongPassphrase: true };
  }
  const privateKey = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const pub = createPublicKey(privateKey);
  const a = pub.export({ format: 'der', type: 'spki' });
  const b = unb64(keyFile.publicKey);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, problem: 'the sealed private key does not belong to this key file\'s public key' };
  return { ok: true, privateKey };
}

/** The per-file key: ECDH(ephemeral, recipient) → HKDF-SHA-256 with the file's salt and purpose. */
function fileKey(privateKey, publicKey, salt, purpose) {
  const shared = diffieHellman({ privateKey, publicKey });
  return Buffer.from(hkdfSync('sha256', shared, salt, Buffer.from(`sre-backup/v1|${purpose}`, 'utf8'), 32));
}

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const aadFor = (headerHash, index, last) => Buffer.concat([headerHash, u32(index), Buffer.from([last ? 1 : 0])]);
const nonceFor = (prefix, index) => Buffer.concat([prefix, u32(index)]);

function readExactly(fs, fd, length, position) {
  const buf = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const n = fs.readSync(fd, buf, got, length - got, position === null ? null : position + got);
    if (n === 0) break;
    got += n;
  }
  return got === length ? buf : buf.subarray(0, got);
}

function writeAll(fs, fd, buf) {
  let done = 0;
  while (done < buf.length) done += fs.writeSync(fd, buf, done, buf.length - done);
}

/**
 * Encrypt `plainPath` into a NEW file `outPath` ('wx': never overwriting), to `publicKeyObject`, for `purpose`
 * ('database', 'files', 'settings'). Reads and writes in chunks — never the whole file in memory. Returns the
 * plaintext's size and SHA-256 (for the manifest) and the encrypted file's size and SHA-256.
 */
export function encryptFile(fs, plainPath, outPath, publicKeyObject, { purpose, keyId, random = randomBytes, chunkBytes = CHUNK_BYTES }) {
  const eph = generateKeyPairSync('x25519');
  const salt = random(32);
  const noncePrefix = random(8);
  const header = Buffer.from(JSON.stringify({
    v: 1, scheme: SCHEME, keyId, purpose, epk: b64(eph.publicKey.export({ format: 'der', type: 'spki' })), salt: b64(salt), noncePrefix: b64(noncePrefix), chunkBytes,
  }), 'utf8');
  const key = fileKey(eph.privateKey, publicKeyObject, salt, purpose);
  const headerHash = sha256(header);
  const plainHash = createHash('sha256');
  const outHash = createHash('sha256');
  let plainBytes = 0;
  let outBytes = 0;
  const inFd = fs.openSync(plainPath, 'r');
  const outFd = fs.openSync(outPath, 'wx', 0o600);
  const put = (b) => { writeAll(fs, outFd, b); outHash.update(b); outBytes += b.length; };
  try {
    put(MAGIC);
    put(u32(header.length));
    put(header);
    let index = 0;
    let pending = readExactly(fs, inFd, chunkBytes, null);
    for (;;) {
      const next = pending.length < chunkBytes ? Buffer.alloc(0) : readExactly(fs, inFd, chunkBytes, null);
      const last = next.length === 0;
      plainHash.update(pending);
      plainBytes += pending.length;
      const c = createCipheriv('aes-256-gcm', key, nonceFor(noncePrefix, index));
      c.setAAD(aadFor(headerHash, index, last));
      const ct = Buffer.concat([c.update(pending), c.final()]);
      put(Buffer.from([last ? 1 : 0]));
      put(u32(ct.length));
      put(ct);
      put(c.getAuthTag());
      if (last) break;
      pending = next;
      index += 1;
    }
    try { fs.fsyncSync(outFd); } catch { /* a drive that cannot sync still holds what was written */ }
  } finally {
    fs.closeSync(inFd);
    fs.closeSync(outFd);
  }
  return { plainBytes, plainSha256: plainHash.digest('hex'), bytes: outBytes, sha256: outHash.digest('hex') };
}

/** The header of an encrypted file, without the key. Returns { ok, header } or { ok: false, problem }. */
export function readEncryptedHeader(fs, file) {
  const fd = fs.openSync(file, 'r');
  try {
    const magic = readExactly(fs, fd, MAGIC.length, 0);
    if (!magic.equals(MAGIC)) return { ok: false, problem: 'it is not an encrypted backup file' };
    const len = readExactly(fs, fd, 4, MAGIC.length);
    if (len.length !== 4 || len.readUInt32BE() > 64 * 1024) return { ok: false, problem: 'its header is damaged' };
    const raw = readExactly(fs, fd, len.readUInt32BE(), MAGIC.length + 4);
    let header;
    try { header = JSON.parse(raw.toString('utf8')); } catch { return { ok: false, problem: 'its header is damaged' }; }
    if (header?.v !== 1 || header.scheme !== SCHEME) return { ok: false, problem: 'it was encrypted some other way' };
    return { ok: true, header, raw, bodyAt: MAGIC.length + 4 + raw.length };
  } finally { fs.closeSync(fd); }
}

/**
 * Decrypt `encPath` into a NEW file `outPath` ('wx') with the unlocked private key. Every chunk is checked; any damage,
 * reordering, truncation or extra bytes is refused and the output is left incomplete for the caller to remove.
 * Returns { ok: true, plainBytes, plainSha256, purpose } or { ok: false, problem }.
 */
export function decryptFile(fs, encPath, outPath, privateKeyObject, { expectPurpose } = {}) {
  const h = readEncryptedHeader(fs, encPath);
  if (!h.ok) return h;
  if (expectPurpose !== undefined && h.header.purpose !== expectPurpose) return { ok: false, problem: `it holds the ${h.header.purpose} part, not the ${expectPurpose} part` };
  let key;
  try {
    const epk = createPublicKey({ key: unb64(h.header.epk), format: 'der', type: 'spki' });
    key = fileKey(privateKeyObject, epk, unb64(h.header.salt), h.header.purpose);
  } catch { return { ok: false, problem: 'its header is damaged' }; }
  const prefix = unb64(h.header.noncePrefix);
  const headerHash = sha256(h.raw);
  const inFd = fs.openSync(encPath, 'r');
  const outFd = fs.openSync(outPath, 'wx', 0o600);
  const plainHash = createHash('sha256');
  let plainBytes = 0;
  let at = h.bodyAt;
  try {
    for (let index = 0; ; index += 1) {
      const head = readExactly(fs, inFd, 5, at);
      if (head.length !== 5) return { ok: false, problem: 'it is cut short (the last part is missing)' };
      const last = head[0] === 1;
      const len = head.readUInt32BE(1);
      if (len > (h.header.chunkBytes ?? CHUNK_BYTES)) return { ok: false, problem: 'it is damaged' };
      const ct = readExactly(fs, inFd, len, at + 5);
      const tag = readExactly(fs, inFd, 16, at + 5 + len);
      if (ct.length !== len || tag.length !== 16) return { ok: false, problem: 'it is cut short (the last part is missing)' };
      at += 5 + len + 16;
      let pt;
      try {
        const d = createDecipheriv('aes-256-gcm', key, nonceFor(prefix, index), { authTagLength: 16 });
        d.setAAD(aadFor(headerHash, index, last));
        d.setAuthTag(tag);
        pt = Buffer.concat([d.update(ct), d.final()]);
      } catch { return { ok: false, problem: 'it does not open with this key, or it was changed after it was written' }; }
      writeAll(fs, outFd, pt);
      plainHash.update(pt);
      plainBytes += pt.length;
      if (last) {
        if (readExactly(fs, inFd, 1, at).length !== 0) return { ok: false, problem: 'it has extra bytes after its end' };
        break;
      }
    }
  } finally {
    fs.closeSync(inFd);
    fs.closeSync(outFd);
  }
  return { ok: true, plainBytes, plainSha256: plainHash.digest('hex'), purpose: h.header.purpose };
}

/** Seal a small JSON value (the money totals in a manifest) to the public key. */
export function sealJson(value, publicKeyObject, { random = randomBytes } = {}) {
  const eph = generateKeyPairSync('x25519');
  const salt = random(32);
  const iv = random(12);
  const key = fileKey(eph.privateKey, publicKeyObject, salt, 'sealed-json');
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(value), 'utf8')), c.final()]);
  return { scheme: SCHEME, epk: b64(eph.publicKey.export({ format: 'der', type: 'spki' })), salt: b64(salt), iv: b64(iv), tag: b64(c.getAuthTag()), ct: b64(ct) };
}

/** Open what `sealJson` sealed. Returns { ok, value } or { ok: false, problem }. */
export function openJson(sealed, privateKeyObject) {
  try {
    const epk = createPublicKey({ key: unb64(sealed.epk), format: 'der', type: 'spki' });
    const key = fileKey(privateKeyObject, epk, unb64(sealed.salt), 'sealed-json');
    const d = createDecipheriv('aes-256-gcm', key, unb64(sealed.iv), { authTagLength: 16 });
    d.setAuthTag(unb64(sealed.tag));
    return { ok: true, value: JSON.parse(Buffer.concat([d.update(unb64(sealed.ct)), d.final()]).toString('utf8')) };
  } catch { return { ok: false, problem: 'the sealed totals do not open with this key, or were changed' }; }
}
