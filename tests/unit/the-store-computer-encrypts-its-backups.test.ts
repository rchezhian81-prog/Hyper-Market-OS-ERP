import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MIN_PASSPHRASE, decryptFile, encryptFile, keyFileProblem, makeBackupKey, openJson, passphraseProblem, publicKeyOf, sealJson, unlockBackupKey,
} from '../../scripts/lib/store-computer-crypto.mjs';

/**
 * OB-249 (audit rows 2–3, lane B B7 and B6/Q8) — the store computer's backups are ENCRYPTED, with Node's own crypto so the
 * Windows PC needs nothing installed. Every backup is encrypted to a PUBLIC key (the hourly job needs no secret); the
 * private key is sealed with the owner's passphrase (scrypt → AES-256-GCM); the passphrase is never stored. Each file is
 * AES-256-GCM in chunks, each chunk bound to the header, its place and a last-chunk flag — so a changed, cut, extended or
 * reordered file is refused, never half-trusted.
 */

const CHEAP = { N: 2 ** 12, r: 8, p: 1 };
const PASS = 'a synthetic passphrase for tests';
const dir = (): string => mkdtempSync(join(tmpdir(), 'sre-crypto-'));

describe('the backup key: a public half for every backup, a private half only the passphrase opens', () => {
  it('opens with the passphrase, and only with it; the file holds neither the passphrase nor the private key in the clear', () => {
    const k = makeBackupKey(PASS, { scrypt: CHEAP });
    expect(keyFileProblem(k)).toBeUndefined();
    expect(k.keyId).toMatch(/^[0-9a-f]{16}$/);
    const text = JSON.stringify(k);
    expect(text).not.toContain(PASS);
    expect(text).not.toContain(Buffer.from(PASS).toString('base64'));
    const u = unlockBackupKey(k, PASS);
    expect(u.ok).toBe(true);
    // The passphrase is normalised (NFC): the same words typed on another keyboard still open it.
    expect(unlockBackupKey(k, PASS.normalize('NFD')).ok).toBe(true);
    const wrong = unlockBackupKey(k, 'not the passphrase');
    expect(wrong).toMatchObject({ ok: false, wrongPassphrase: true });
  });

  it('a key file whose id does not match its public key, or that is not one at all, is refused', () => {
    const k = makeBackupKey(PASS, { scrypt: CHEAP });
    expect(keyFileProblem({ ...k, keyId: '0000000000000000' })).toMatch(/does not match/);
    expect(keyFileProblem({ kind: 'something' })).toMatch(/not a backup key file/);
    expect(unlockBackupKey({ kind: 'x' }, PASS)).toMatchObject({ ok: false });
    // Another key's public half under this key's sealed private half: the pair is checked.
    const other = makeBackupKey(PASS, { scrypt: CHEAP });
    const mixed = { ...k, publicKey: other.publicKey, keyId: other.keyId };
    expect(unlockBackupKey(mixed, PASS).ok).toBe(false);
  });

  it(`a new passphrase must be at least ${MIN_PASSPHRASE} characters and typed the same twice — said without echoing it`, () => {
    expect(passphraseProblem('short', 'short')).toMatch(/at least 12 characters/);
    expect(passphraseProblem(PASS, `${PASS}!`)).toMatch(/not the same/);
    expect(passphraseProblem(PASS, PASS)).toBeUndefined();
    for (const p of [passphraseProblem('short'), passphraseProblem(PASS, 'other words entirely')]) expect(p).not.toContain('short words');
  });
});

describe('a file encrypted to the key', () => {
  it('round-trips byte for byte across many chunks and an empty file; the size and SHA-256 of both sides are reported', () => {
    const d = dir();
    const k = makeBackupKey(PASS, { scrypt: CHEAP });
    const u = unlockBackupKey(k, PASS);
    if (!u.ok) throw new Error('unlock');
    const plain = Buffer.alloc(300_000);
    for (let i = 0; i < plain.length; i += 1) plain[i] = (i * 31) % 251;
    writeFileSync(join(d, 'p'), plain);
    const e = encryptFile(fs, join(d, 'p'), join(d, 'e'), publicKeyOf(k), { purpose: 'database', keyId: k.keyId, chunkBytes: 64 * 1024 });
    expect(e.plainBytes).toBe(plain.length);
    expect(readFileSync(join(d, 'e')).includes(plain.subarray(1000, 1064))).toBe(false);
    const back = decryptFile(fs, join(d, 'e'), join(d, 'o'), u.privateKey, { expectPurpose: 'database' });
    expect(back).toMatchObject({ ok: true, plainBytes: plain.length, plainSha256: e.plainSha256 });
    expect(readFileSync(join(d, 'o')).equals(plain)).toBe(true);
    writeFileSync(join(d, 'z'), '');
    encryptFile(fs, join(d, 'z'), join(d, 'ze'), publicKeyOf(k), { purpose: 'settings', keyId: k.keyId });
    expect(decryptFile(fs, join(d, 'ze'), join(d, 'zo'), u.privateKey)).toMatchObject({ ok: true, plainBytes: 0 });
    // Never overwrites: the same output name twice is an error, not a replaced backup.
    expect(() => encryptFile(fs, join(d, 'p'), join(d, 'e'), publicKeyOf(k), { purpose: 'database', keyId: k.keyId })).toThrow(/EEXIST/);
  });

  it('refuses a changed byte, a cut-short file, extra bytes, swapped chunks, the wrong key, and the wrong part', () => {
    const d = dir();
    const k = makeBackupKey(PASS, { scrypt: CHEAP });
    const u = unlockBackupKey(k, PASS);
    if (!u.ok) throw new Error('unlock');
    writeFileSync(join(d, 'p'), Buffer.alloc(200_000, 7));
    encryptFile(fs, join(d, 'p'), join(d, 'e'), publicKeyOf(k), { purpose: 'files', keyId: k.keyId, chunkBytes: 50_000 });
    const good = readFileSync(join(d, 'e'));
    let n = 0;
    const tryWith = (bytes: Buffer, opts: { expectPurpose?: string } = {}, key = u.privateKey): { ok: boolean; problem?: string } => {
      n += 1;
      writeFileSync(join(d, `t${n}`), bytes);
      return decryptFile(fs, join(d, `t${n}`), join(d, `o${n}`), key, opts);
    };
    const flipped = Buffer.from(good); flipped[good.length - 30] = flipped[good.length - 30]! ^ 0x01;
    expect(tryWith(flipped)).toMatchObject({ ok: false, problem: expect.stringMatching(/changed after it was written/) });
    expect(tryWith(good.subarray(0, good.length - 50_021))).toMatchObject({ ok: false });
    expect(tryWith(good.subarray(0, good.length - 7))).toMatchObject({ ok: false, problem: expect.stringMatching(/cut short/) });
    expect(tryWith(Buffer.concat([good, Buffer.from('x')]))).toMatchObject({ ok: false, problem: expect.stringMatching(/extra bytes/) });
    // Swap the first two chunks: each is bound to its place.
    const headerLen = 8 + 4 + good.readUInt32BE(8);
    const chunk = 1 + 4 + 50_000 + 16;
    const swapped = Buffer.concat([good.subarray(0, headerLen), good.subarray(headerLen + chunk, headerLen + 2 * chunk), good.subarray(headerLen, headerLen + chunk), good.subarray(headerLen + 2 * chunk)]);
    expect(tryWith(swapped)).toMatchObject({ ok: false });
    const other = unlockBackupKey(makeBackupKey(PASS, { scrypt: CHEAP }), PASS);
    if (!other.ok) throw new Error('unlock');
    expect(tryWith(good, {}, other.privateKey)).toMatchObject({ ok: false });
    expect(tryWith(good, { expectPurpose: 'settings' })).toMatchObject({ ok: false, problem: expect.stringMatching(/holds the files part, not the settings part/) });
    expect(tryWith(Buffer.from('PGDMP plain dump'))).toMatchObject({ ok: false, problem: 'it is not an encrypted backup file' });
    // And the untouched file still opens.
    expect(tryWith(good)).toMatchObject({ ok: true });
  });

  it('small sealed values (the money totals in a manifest) open only with the key', () => {
    const k = makeBackupKey(PASS, { scrypt: CHEAP });
    const u = unlockBackupKey(k, PASS);
    const other = unlockBackupKey(makeBackupKey(PASS, { scrypt: CHEAP }), PASS);
    if (!u.ok || !other.ok) throw new Error('unlock');
    const sealed = sealJson({ SaleCommitted: 100_000 }, publicKeyOf(k));
    expect(JSON.stringify(sealed)).not.toContain('100000');
    expect(openJson(sealed, u.privateKey)).toEqual({ ok: true, value: { SaleCommitted: 100_000 } });
    expect(openJson(sealed, other.privateKey).ok).toBe(false);
  });
});
