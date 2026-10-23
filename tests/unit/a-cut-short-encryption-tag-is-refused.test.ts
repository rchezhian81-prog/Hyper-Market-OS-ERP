import { describe, it, expect } from 'vitest';
import { makeBackupKey, openJson, publicKeyOf, sealJson, unlockBackupKey } from '../../scripts/lib/store-computer-crypto.mjs';

/**
 * QG-03 SAST finding `javascript.node-crypto.security.gcm-no-tag-length` (Semgrep, HIGH; OB-288 gates lane). AES-GCM in
 * Node accepts an authentication tag as short as 4 bytes unless the tag length is pinned — and a 4-byte tag that is the
 * first 4 bytes of the real one still "verifies". A tag cut short is far easier to forge, so every GCM open now pins
 * the full 16 bytes: a cut-short tag is refused, never trusted.
 */

const CHEAP = { N: 2 ** 12, r: 8, p: 1 };
const PASS = 'a synthetic passphrase for tests';
const cut = (b64: string, bytes: number): string => Buffer.from(b64, 'base64').subarray(0, bytes).toString('base64');

describe('a cut-short GCM authentication tag is refused (gcm-no-tag-length)', () => {
  it('the backup key file: the right passphrase with a 4-byte tag does not open it', () => {
    const k = makeBackupKey(PASS, { scrypt: CHEAP });
    expect(unlockBackupKey(k, PASS).ok).toBe(true);
    const shortTag = { ...k, sealedPrivateKey: { ...k.sealedPrivateKey, tag: cut(k.sealedPrivateKey.tag, 4) } };
    expect(unlockBackupKey(shortTag, PASS).ok).toBe(false);
  });

  it('sealed totals: the right key with an 8-byte tag does not open them', () => {
    const k = makeBackupKey(PASS, { scrypt: CHEAP });
    const unlocked = unlockBackupKey(k, PASS);
    if (!unlocked.ok) throw new Error('the key should open');
    const sealed = sealJson({ rows: 3, totalMinor: 12_345 }, publicKeyOf(k));
    expect(openJson(sealed, unlocked.privateKey)).toMatchObject({ ok: true, value: { rows: 3, totalMinor: 12_345 } });
    expect(openJson({ ...sealed, tag: cut(sealed.tag, 8) }, unlocked.privateKey).ok).toBe(false);
  });
});
