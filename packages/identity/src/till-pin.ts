// A person's TILL PIN — the offline-capable credential the store computer checks (ADR-0020 · Wave 2b · audit PF-02 ·
// M02-FR-01 "limited cached POS identity" · hard rule #4).
//
// The PIN itself is never kept anywhere. What is kept is a VERIFIER: scrypt of the PIN with a random salt (slow on
// purpose), then HMAC-SHA256 under a key derived from the store computer's pack signing key. The scrypt makes each guess
// cost time; the keyed HMAC means a copied credentials file is not enough to try guesses at all — the key lives in the
// box's settings, never beside the verifiers. Comparison is constant-time.
//
// Pure apart from `node:crypto`: no clock, no file, no network. The box and (later) head office share it.

import { createHmac, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';

/** Six digits: keyed on a till keypad in a second, and bounded by the box's lockouts. */
export const TILL_PIN_LENGTH = 6;
const PIN_PATTERN = /^\d{6}$/;
/** scrypt cost: ~16 MB and tens of milliseconds per check on a shop PC — fine for a sign-in, ruinous for a guesser. */
const SCRYPT = { N: 1 << 14, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const LABEL = 'sre-till-pin-v1';

/** A credential as the box keeps it: who, the salt, the verifier, when and by whom it was issued — never the PIN. */
export interface TillCredential {
  readonly userId: string;
  readonly salt: string;
  readonly verifier: string;
  readonly issuedAt: string;
  readonly issuedBy: string;
  /** A revoked credential signs nobody in. Revocation is a new entry, never an edit (hard rule #2). */
  readonly revoked?: boolean;
}

/** Is this what a till PIN looks like? Six digits, nothing else. */
export function isTillPin(pin: string): boolean {
  return PIN_PATTERN.test(pin);
}

/** A fresh PIN: six digits from the operating system's random source, never from Math.random. */
export function newTillPin(random: (max: number) => number = (max) => randomInt(max)): string {
  let pin = '';
  for (let i = 0; i < TILL_PIN_LENGTH; i += 1) pin += String(random(10));
  return pin;
}

/** The verifier key, derived from the box's pack signing key under this credential's own label. */
export function tillPinKey(packSigningKey: string): Buffer {
  if (packSigningKey.length < 32) throw new RangeError('the till PIN key needs the box\'s full pack signing key');
  return createHmac('sha256', packSigningKey).update(LABEL, 'utf8').digest();
}

/** The verifier for a PIN under a salt and the box's key (hex). */
export function tillPinVerifier(pin: string, saltHex: string, key: Buffer): string {
  const stretched = scryptSync(pin, Buffer.from(saltHex, 'hex'), 32, SCRYPT);
  return createHmac('sha256', key).update(stretched).digest('hex');
}

/** Issue a credential for a PIN: a new random salt and its verifier. */
export function issueTillCredential(input: {
  readonly userId: string;
  readonly pin: string;
  readonly key: Buffer;
  readonly issuedAt: string;
  readonly issuedBy: string;
  readonly salt?: Buffer;
}): TillCredential {
  if (!isTillPin(input.pin)) throw new RangeError(`a till PIN is ${TILL_PIN_LENGTH} digits`);
  if (input.userId.trim() === '' || input.issuedBy.trim() === '') throw new RangeError('a till PIN is issued to a named person by a named person');
  const salt = (input.salt ?? randomBytes(16)).toString('hex');
  return { userId: input.userId, salt, verifier: tillPinVerifier(input.pin, salt, input.key), issuedAt: input.issuedAt, issuedBy: input.issuedBy };
}

/** Does this PIN match this credential? Constant-time; a revoked or malformed credential never matches. */
export function tillPinMatches(pin: string, credential: TillCredential, key: Buffer): boolean {
  if (credential.revoked === true || !isTillPin(pin) || !/^[0-9a-f]{32}$/.test(credential.salt) || !/^[0-9a-f]{64}$/.test(credential.verifier)) return false;
  const expected = Buffer.from(credential.verifier, 'hex');
  const actual = Buffer.from(tillPinVerifier(pin, credential.salt, key), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
