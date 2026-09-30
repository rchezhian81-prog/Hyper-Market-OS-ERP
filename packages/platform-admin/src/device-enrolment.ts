// A handheld's ENROLMENT CODE (SP-3a · ADR-0019 · M33 · hard rule #4).
//
// A handheld on the shop wifi is a device on the shop LAN, and so is a guest's phone (ADR-0004). The store box's
// device socket therefore trusts nothing that cannot prove it is one of the shop's REGISTERED handhelds. The proof
// starts here: head office mints a one-time code for a registered handheld, keeps only its hash, and shows the code
// once to the admin who is setting the device up. The device enrols at the box with that code; the box compares
// hashes (the pack carries the hash, never the code) and mints the device its own session credential.
//
// Pure helpers, shared by the cloud (mint + hash) and the box (hash + compare): no I/O, no clock.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Letters and digits a person can read back over the phone: no I, O, 0, 1. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ENROLMENT_CODE_LENGTH = 20;

/** Mint a fresh code: 20 characters from a 32-letter alphabet (100 bits), shown as 4 groups of 5. */
export function mintEnrolmentCode(random: (n: number) => Buffer = randomBytes): string {
  const bytes = random(ENROLMENT_CODE_LENGTH);
  let out = '';
  for (let i = 0; i < ENROLMENT_CODE_LENGTH; i += 1) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
    if ((i + 1) % 5 === 0 && i + 1 < ENROLMENT_CODE_LENGTH) out += '-';
  }
  return out;
}

/** The form a code is compared in: upper case, groups and spaces removed. What a person types survives this. */
export function normalizeEnrolmentCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z2-9]/g, '');
}

/** SHA-256 of the normalized code — what head office stores, what the pack carries, what the box compares. */
export function enrolmentCodeHash(code: string): string {
  return createHash('sha256').update(normalizeEnrolmentCode(code), 'utf8').digest('hex');
}

/** Constant-time comparison of a typed code against a stored hash. */
export function enrolmentCodeMatches(code: string, storedHash: string): boolean {
  const a = Buffer.from(enrolmentCodeHash(code), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** SHA-256 of a device session token — the box keeps only this, never the token (hard rule #4). */
export function deviceTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** A device session token: 32 random bytes as hex. Minted by the box at enrolment, shown to nobody. */
export function mintDeviceToken(random: (n: number) => Buffer = randomBytes): string {
  return random(32).toString('hex');
}
