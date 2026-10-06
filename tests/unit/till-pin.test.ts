import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  TILL_PIN_LENGTH, isTillPin, newTillPin, tillPinKey, tillPinVerifier, issueTillCredential, tillPinMatches,
} from '../../packages/identity/src/till-pin';
import { testPin } from '../support/till-operator';

/**
 * **A till PIN is kept only as a keyed, slow verifier — never the PIN (ADR-0020 §1 · audit PF-02 · hard rule #4).**
 *
 * The box checks a cashier's six digits offline. What it keeps must not let anyone read a PIN back, and a copied
 * credentials file alone must not let anyone even try guesses: the verifier is scrypt (slow), then an HMAC under a key
 * derived from the box's own pack signing key. Every PIN and key here is built at run time.
 */

const BOX_KEY = ['till', 'pin', 'unit', 'box', 'key'].join('-').padEnd(48, '0');
const OTHER_BOX_KEY = ['another', 'store', 'box', 'key'].join('-').padEnd(48, '0');
const AT = '2026-10-06T08:00:00.000Z';

describe('the PIN itself', () => {
  it('is six digits and nothing else', () => {
    expect(TILL_PIN_LENGTH).toBe(6);
    expect(isTillPin(testPin(1))).toBe(true);
    for (const bad of ['', '12345', '1234567', '12a456', ' 123456', '123456 ', '１２３４５６']) expect(isTillPin(bad), JSON.stringify(bad)).toBe(false);
  });

  it('a new PIN comes from the random source given, six digits long', () => {
    const digits = [3, 1, 4, 1, 5, 9];
    let i = 0;
    expect(newTillPin(() => digits[i++]!)).toBe('314159');
    expect(isTillPin(newTillPin())).toBe(true);
  });
});

describe('the verifier', () => {
  it('matches its own PIN, and no other', () => {
    const key = tillPinKey(BOX_KEY);
    const pin = testPin(11);
    const credential = issueTillCredential({ userId: 'u-meena', pin, key, issuedAt: AT, issuedBy: 'Store admin' });
    expect(tillPinMatches(pin, credential, key)).toBe(true);
    expect(tillPinMatches(testPin(12), credential, key)).toBe(false);
  });

  it('never contains the PIN, and the same PIN issued twice gives two different verifiers (a fresh salt each time)', () => {
    const key = tillPinKey(BOX_KEY);
    const pin = testPin(21);
    const a = issueTillCredential({ userId: 'u-meena', pin, key, issuedAt: AT, issuedBy: 'Store admin' });
    const b = issueTillCredential({ userId: 'u-meena', pin, key, issuedAt: AT, issuedBy: 'Store admin' });
    expect(JSON.stringify(a)).not.toContain(pin);
    expect(a.salt).not.toBe(b.salt);
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.verifier).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is keyed to the box: a credentials file copied to another box does not match there', () => {
    const pin = testPin(31);
    const credential = issueTillCredential({ userId: 'u-meena', pin, key: tillPinKey(BOX_KEY), issuedAt: AT, issuedBy: 'Store admin' });
    expect(tillPinMatches(pin, credential, tillPinKey(OTHER_BOX_KEY))).toBe(false);
  });

  it('is deterministic for a given salt and key — what the box recomputes at sign-in', () => {
    const key = tillPinKey(BOX_KEY);
    const salt = randomBytes(16);
    const pin = testPin(41);
    const credential = issueTillCredential({ userId: 'u-meena', pin, key, issuedAt: AT, issuedBy: 'Store admin', salt });
    expect(tillPinVerifier(pin, salt.toString('hex'), key)).toBe(credential.verifier);
  });

  it('a revoked or damaged credential matches nothing', () => {
    const key = tillPinKey(BOX_KEY);
    const pin = testPin(51);
    const credential = issueTillCredential({ userId: 'u-meena', pin, key, issuedAt: AT, issuedBy: 'Store admin' });
    expect(tillPinMatches(pin, { ...credential, revoked: true }, key)).toBe(false);
    expect(tillPinMatches(pin, { ...credential, verifier: credential.verifier.slice(2) }, key)).toBe(false);
    expect(tillPinMatches(pin, { ...credential, salt: 'not-hex' }, key)).toBe(false);
    expect(tillPinMatches('', credential, key)).toBe(false);
  });

  it('refuses to issue without a named person, a named issuer, or a six-digit PIN; refuses a short box key', () => {
    const key = tillPinKey(BOX_KEY);
    expect(() => issueTillCredential({ userId: ' ', pin: testPin(61), key, issuedAt: AT, issuedBy: 'Store admin' })).toThrow(/named person/);
    expect(() => issueTillCredential({ userId: 'u-meena', pin: testPin(61), key, issuedAt: AT, issuedBy: '' })).toThrow(/named person/);
    expect(() => issueTillCredential({ userId: 'u-meena', pin: '1234', key, issuedAt: AT, issuedBy: 'Store admin' })).toThrow(/6 digits/);
    expect(() => tillPinKey('short')).toThrow(/full pack signing key/);
  });
});
