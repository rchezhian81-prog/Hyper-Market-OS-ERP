// BILL NUMBERS ACROSS STORES — the one rule head office, the store computer and the screen share
// (OB-81 "A", owner, 12 Oct 2026 · OB-80 · M01-FR-02 · audit PF-04 · CGST Rule 46(b)).
//
// Head office issues each till a short prefix per (store, till); the store computer numbers that till's bills
// `<prefix><6-digit counter>`; the till prints it and derives its sale id `S-<receipt>` from it. So:
//
//   • THE 16-CHARACTER BOUND (GST invoice serial number). A prefix is at most 10 characters and the counter is exactly
//     6 digits (1 … 999 999, zero-padded), so every number is `prefix.length + 6 ≤ 16` characters. The counter never
//     grows past 6 digits: a spent range refuses (the box's register), it never widens.
//   • DISTINCT PREFIXES ⇒ DISTINCT NUMBERS. Every number under a prefix P is exactly |P| + 6 characters long and begins
//     with P. Two equal numbers have equal length, so their prefixes have equal length and are both the leading |P|
//     characters of the same string — the same prefix. Head office refuses a prefix any other till ever held, so two
//     tills never share one, and no two tills' numbers (nor their `S-<receipt>` sale ids) can be equal.
//   • THE CHARACTERS GST allows in an invoice number: capital letters, digits, `-` and `/`.
//   • RESERVED, never issued by head office: `R-…` (the store computer's own `R-<lane>-` numbering of a single-store
//     business, kept as it was) and `ZZ…` (the store computer's store-qualified default below). So head office's
//     prefixes cannot collide with either.
//   • A TILL WITH NO ISSUED PREFIX once the business has a second store still sells (P-01 — the box never asks head
//     office before a sale), under `storeComputerDefaultPrefix(store, till)`: `ZZ` + six letters/digits worked out from
//     the store and the till + `-` (9 characters, so its numbers are 15). Deterministic: the same box after a restart
//     keeps the same prefix and carries on its count. Head office flags every sale numbered this way for the owner.

/** GST: an invoice's serial number is at most 16 characters. */
export const GST_INVOICE_NUMBER_MAX = 16;
/** The counter is always exactly this many digits. */
export const RECEIPT_COUNTER_DIGITS = 6;
/** The highest counter under one prefix. */
export const RECEIPT_COUNTER_MAX = 999_999;
/** The longest prefix head office may issue: 10 + 6 = 16. */
export const RECEIPT_PREFIX_MAX = GST_INVOICE_NUMBER_MAX - RECEIPT_COUNTER_DIGITS;
export const RECEIPT_PREFIX_MIN = 2;

const PREFIX_CHARS = /^[A-Z0-9/-]+$/;

export type PrefixProblem = 'not_text' | 'too_short' | 'too_long' | 'characters' | 'reserved_box_numbering' | 'reserved_store_default';

/** Whether a prefix may be issued by head office, and if not why — in words a person reads. */
export function readReceiptPrefix(v: unknown): { readonly ok: true; readonly prefix: string } | { readonly ok: false; readonly problem: PrefixProblem; readonly words: string } {
  if (typeof v !== 'string') return { ok: false, problem: 'not_text', words: 'The prefix must be text, for example S2L1-.' };
  const p = v;
  if (p.length < RECEIPT_PREFIX_MIN) return { ok: false, problem: 'too_short', words: `The prefix must be at least ${RECEIPT_PREFIX_MIN} characters.` };
  if (p.length > RECEIPT_PREFIX_MAX) {
    return { ok: false, problem: 'too_long', words: `The prefix may be at most ${RECEIPT_PREFIX_MAX} characters, so that with the 6-digit count the bill number stays within GST's ${GST_INVOICE_NUMBER_MAX}.` };
  }
  if (!PREFIX_CHARS.test(p)) return { ok: false, problem: 'characters', words: 'The prefix may use only capital letters, digits, "-" and "/" (the characters GST allows in an invoice number), with no spaces.' };
  if (p.startsWith('R-')) return { ok: false, problem: 'reserved_box_numbering', words: 'A prefix starting "R-" is kept for the numbering a store computer used before head office issued prefixes; choose another.' };
  if (p.startsWith('ZZ')) return { ok: false, problem: 'reserved_store_default', words: 'A prefix starting "ZZ" is kept for the store computer\'s own fallback numbering; choose another.' };
  return { ok: true, prefix: p };
}

/** A bill number under a prefix: the prefix and the 6-digit counter. */
export function receiptNumberFor(prefix: string, counter: number): string {
  return `${prefix}${String(counter).padStart(RECEIPT_COUNTER_DIGITS, '0')}`;
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** FNV-1a (32-bit) — deterministic, the same in the browser, the box and head office. Not a secret, only a spread. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** The store computer's own store-qualified prefix for a till with no issued one (9 characters: `ZZ` + 6 + `-`). */
export function storeComputerDefaultPrefix(storeId: string, laneId: string): string {
  const a = fnv1a(`${storeId}\u0000${laneId}`);
  const b = fnv1a(`${laneId}\u0000${storeId}\u0000sre`);
  // 30 bits: 15 from each spread, as six base-32 letters/digits.
  let bits = ((a & 0x7fff) * 0x8000) + (b & 0x7fff);
  let out = '';
  for (let i = 0; i < 6; i += 1) { out = BASE32[bits % 32] + out; bits = Math.floor(bits / 32); }
  return `ZZ${out}-`;
}

/** Whether a bill number was made under a store computer's fallback prefix (a till head office never issued one). */
export function isStoreComputerDefaultReceipt(receiptNumber: unknown): boolean {
  return typeof receiptNumber === 'string' && /^ZZ[A-Z2-7]{6}-\d{6}$/.test(receiptNumber);
}
