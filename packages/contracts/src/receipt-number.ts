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

/**
 * The store computer's own store-coded prefix for a till with no usable issued one (9 characters: `ZZ` + 6 + `-`).
 *
 * OB-85 "A" (owner, 12 Oct 2026): worked out from the box's OWN store code, the till, and — when given — the box's own
 * identity (`boxIdentity`, made once on the box's disk, edge/store-edge/src/receipt-numbers.ts). With the identity, two
 * boxes never share a fallback even when neither knows its store, and a REPLACED box (its disk lost) starts a fresh
 * prefix rather than re-using its predecessor's count. Deterministic: the same box after a restart keeps the same prefix.
 */
export function storeComputerDefaultPrefix(storeId: string, laneId: string, boxIdentity?: string): string {
  const who = boxIdentity === undefined || boxIdentity === '' ? '' : `\u0000${boxIdentity}`;
  const a = fnv1a(`${storeId}\u0000${laneId}${who}`);
  const b = fnv1a(`${laneId}\u0000${storeId}\u0000sre${who}`);
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

// ── A2 (roadmap v2.1 addendum · CGST Rule 46(b)): the series is per FINANCIAL YEAR ───────────────────────────────────────
//
// Rule 46(b) asks for a consecutive serial number "unique for a financial year", and the addendum's A2 that the series
// resets on the financial-year boundary. Head office issues each till a prefix FOR a financial year (India's: 1 April to
// 31 March, by the bill's date in India time); the store computer numbers each bill under the prefix of the year the bill
// is dated in, so the count starts again at 000001 on 1 April under that year's prefix. Uniqueness across years is the
// same argument as across tills: head office never issues a prefix any till held in ANY year (its own earlier year
// included), so two bills — and two `S-<receipt>` sale ids — can never be equal, and every number is still ≤ 16 characters.

/** A financial year as written here: "2026-27" (1 April 2026 – 31 March 2027). */
export const FINANCIAL_YEAR_PATTERN = /^(\d{4})-(\d{2})$/;

/** Whether `v` is a financial year written "YYYY-YY" whose second part is the year after the first. */
export function isFinancialYear(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const m = FINANCIAL_YEAR_PATTERN.exec(v);
  return m !== null && (Number(m[1]) + 1) % 100 === Number(m[2]);
}

/** India time is UTC+05:30 all year. */
const IST_OFFSET_MS = 330 * 60_000;

/**
 * The financial year an instant falls in, by its date in India time (the date the tax invoice carries): 31 March 23:59 IST
 * is still the old year, 1 April 00:00 IST the new one. Undefined when the instant cannot be read.
 */
export function financialYearOf(isoUtc: string): string | undefined {
  const ms = Date.parse(isoUtc);
  if (Number.isNaN(ms)) return undefined;
  const local = new Date(ms + IST_OFFSET_MS);
  const y = local.getUTCFullYear();
  const start = local.getUTCMonth() >= 3 ? y : y - 1; // April is month 3
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** The financial year after one ("2026-27" → "2027-28"). */
export function nextFinancialYear(fy: string): string {
  const start = Number(fy.slice(0, 4)) + 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** A published series line (the store pack's `receiptSeries`), as the box receives it. */
export interface PublishedSeriesLine {
  readonly prefix: unknown;
  readonly padTo: unknown;
  readonly rangeStart: unknown;
  readonly rangeEnd: unknown;
  /** A2: the financial year this series numbers ("2026-27"). Absent → a series with no year (it never resets). */
  readonly financialYear?: unknown;
}

/**
 * Verifier r17 OB81-3: whether a published series obeys the OB-81 rule — the same rule head office applies when it issues a
 * prefix. A prefix head office may issue (≤ 10 characters, GST's characters, not a reserved start), a 6-digit counter, and
 * a range inside 1 … 999 999 — so every number it gives is at most 16 characters and cannot collide with any other till's.
 */
export function readPublishedSeries(s: PublishedSeriesLine): { readonly ok: true } | { readonly ok: false; readonly words: string } {
  const p = readReceiptPrefix(s.prefix);
  if (!p.ok) return { ok: false, words: `its prefix ${JSON.stringify(s.prefix)} is not one head office may issue (${p.words})` };
  if (s.padTo !== RECEIPT_COUNTER_DIGITS) return { ok: false, words: `its counter is ${JSON.stringify(s.padTo)} digits, not ${RECEIPT_COUNTER_DIGITS}` };
  const a = s.rangeStart; const b = s.rangeEnd;
  if (typeof a !== 'number' || typeof b !== 'number' || !Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 1 || b > RECEIPT_COUNTER_MAX || a > b) {
    return { ok: false, words: `its range ${JSON.stringify(a)}…${JSON.stringify(b)} is not inside 1…${RECEIPT_COUNTER_MAX}` };
  }
  if (s.financialYear !== undefined && !isFinancialYear(s.financialYear)) {
    return { ok: false, words: `its financial year ${JSON.stringify(s.financialYear)} is not one written like 2026-27` };
  }
  return { ok: true };
}

/**
 * A bill number split into the prefix it was made under and its 6-digit counter (every number is |P| + 6 characters, so
 * the prefix is everything before the last six); undefined when it does not end in six digits.
 */
export function splitReceiptNumber(receiptNumber: unknown): { readonly prefix: string; readonly counter: number } | undefined {
  if (typeof receiptNumber !== 'string' || receiptNumber.length <= RECEIPT_COUNTER_DIGITS || !/\d{6}$/.test(receiptNumber)) return undefined;
  return { prefix: receiptNumber.slice(0, -RECEIPT_COUNTER_DIGITS), counter: Number(receiptNumber.slice(-RECEIPT_COUNTER_DIGITS)) };
}
