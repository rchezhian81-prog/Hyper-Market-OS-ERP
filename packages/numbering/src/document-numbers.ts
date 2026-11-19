// DOCUMENT NUMBERS, FORMAT A — one rule for every document the shop issues (owner, 18 Nov 2026, in writing:
// "Document numbers, format A" — OB-847; "OB-844 A, OB-845 A, OB-846 A" · M01-FR-02 · CGST Rule 46(b) · hard rules #1, #2, #10).
//
//   • Every document gets a number made automatically — never typed, never reused.
//   • The form is `PREFIX/YY-YY/NNNNN`: a prefix of at most 4 characters, the Indian financial year (1 April – 31 March)
//     the document is dated in, by the SHOP's own date (Asia/Kolkata unless the shop names another zone), and a 5-digit
//     count that starts again at 00001 every 1 April. So every number is at most 4 + 1 + 5 + 1 + 5 = 16 characters — GST's
//     limit for an invoice's serial number.
//   • OB-846 A: a separate range for each GST document type — the prefix names the type (and, on a till, the till).
//   • OB-844 A: 5 digits. A TILL that reaches 99,999 in a year moves to its next range by itself — its lane code + 50
//     (`1L01` → `1L51`); a warning shows from 90,000. Every other range refuses by name at 99,999 (it never wraps, never
//     re-uses a number) and warns from 90,000 too (OB-848, decided under OB-801).
//   • OB-845 A: the new numbers start the day this is installed — a new range for the rest of 2026-27. Existing documents
//     keep their old numbers; nothing old is renumbered.
//
// This module is PURE (no clock, no store): the prefixes, the financial year, the format and its checks. Where a number is
// TAKEN is elsewhere — on the till's store computer for till bills (edge/store-edge/src/receipt-numbers.ts), and in the same
// atomic save as the document for everything else (services/platform/src/document-number-issue.ts).

import { DEFAULT_SHOP_CALENDAR, shopDateIn } from '../../calendar/src/shop-clock';

/** GST (CGST Rule 46(b)): an invoice's serial number is at most 16 characters. */
export const DOCUMENT_NUMBER_MAX_LENGTH = 16;
/** The longest prefix: 4 + "/YY-YY/" (7) + 5 digits = 16. */
export const DOCUMENT_PREFIX_MAX = 4;
/** The count is always exactly 5 digits (OB-844 A). */
export const DOCUMENT_COUNT_DIGITS = 5;
/** The highest count in one range in one year. */
export const DOCUMENT_COUNT_MAX = 99_999;
/** From this count on, the range is said to be running out (OB-844 A: "a warning shows at 90,000"). */
export const DOCUMENT_COUNT_WARN_AT = 90_000;
/** A till lane's overflow range is its lane code plus this (OB-844 A: `1L01` → `1L51`). */
export const TILL_OVERFLOW_STEP = 50;
/**
 * Lane codes head office gives tills run 01…49; 51…99 are kept for their overflow ranges (49 + 50 = 99, the most two digits
 * hold — so code 50, whose overflow would be 100, is never given: OB-848, decided under OB-801).
 */
export const TILL_LANE_MAX = 49;

/** Every kind of document that is numbered — one range per GST document type (OB-846 A). */
export type DocumentNumberKind =
  // On each till, numbered on the till's own store computer, offline (per lane):
  | 'sale_bill' | 'till_return'
  // Numbered by the store computer, one range per store (the prefix's last digit is the store number):
  | 'goods_receipt' | 'stock_count' | 'write_off' | 'transfer_out' | 'return_to_supplier' | 'floor_indent' | 'money_receipt'
  // R2 (batch 18c · OB-873, decided under OB-801): a correction of a saved goods receipt, `GRC1/26-27/00001`.
  | 'goods_receipt_correction'
  // Company-wide (head office — whose API runs on the store computer, ADR-0032):
  | 'purchase_order' | 'supplier_payment' | 'supplier_advance' | 'supplier_debit_note'
  | 'customer_credit_note' | 'customer_debit_note' | 'business_invoice';

export type DocumentNumberScope = 'till' | 'store' | 'company';

export interface DocumentKindRule {
  readonly kind: DocumentNumberKind;
  readonly scope: DocumentNumberScope;
  /** The agreed prefix (company), or its letters before the store digit (store). Tills: see `tillCode`. */
  readonly letters: string;
  /** What the owner calls it. */
  readonly words: string;
}

/** The agreed prefixes (owner, 18 Nov 2026). */
export const DOCUMENT_KINDS: Readonly<Record<DocumentNumberKind, DocumentKindRule>> = Object.freeze({
  sale_bill: { kind: 'sale_bill', scope: 'till', letters: 'L', words: 'Sale bill' },
  till_return: { kind: 'till_return', scope: 'till', letters: 'R', words: 'Return / refund at the till' },
  goods_receipt: { kind: 'goods_receipt', scope: 'store', letters: 'GRN', words: 'Goods received (GRN)' },
  stock_count: { kind: 'stock_count', scope: 'store', letters: 'CNT', words: 'Stock count' },
  write_off: { kind: 'write_off', scope: 'store', letters: 'WOF', words: 'Write-off' },
  transfer_out: { kind: 'transfer_out', scope: 'store', letters: 'TRF', words: 'Transfer out' },
  return_to_supplier: { kind: 'return_to_supplier', scope: 'store', letters: 'RTS', words: 'Return to supplier' },
  floor_indent: { kind: 'floor_indent', scope: 'store', letters: 'IND', words: 'Floor indent' },
  money_receipt: { kind: 'money_receipt', scope: 'store', letters: 'RCT', words: 'Money received (receipt)' },
  goods_receipt_correction: { kind: 'goods_receipt_correction', scope: 'store', letters: 'GRC', words: 'Goods receipt correction' },
  purchase_order: { kind: 'purchase_order', scope: 'company', letters: 'PO', words: 'Purchase order' },
  supplier_payment: { kind: 'supplier_payment', scope: 'company', letters: 'SPAY', words: 'Supplier payment' },
  supplier_advance: { kind: 'supplier_advance', scope: 'company', letters: 'SADV', words: 'Supplier advance' },
  supplier_debit_note: { kind: 'supplier_debit_note', scope: 'company', letters: 'SDN', words: 'Supplier debit note' },
  customer_credit_note: { kind: 'customer_credit_note', scope: 'company', letters: 'CCN', words: 'Customer credit note' },
  customer_debit_note: { kind: 'customer_debit_note', scope: 'company', letters: 'CDN', words: 'Customer debit note' },
  business_invoice: { kind: 'business_invoice', scope: 'company', letters: 'BINV', words: 'Business customer invoice' },
});

export class DocumentNumberError extends Error {
  constructor(readonly code: 'not_a_store_number' | 'not_a_lane_code' | 'prefix_too_long' | 'not_a_date' | 'count_out_of_range' | 'not_a_prefix', detail: string) {
    super(detail);
    this.name = 'DocumentNumberError';
  }
}

/** The financial year an instant (or a YYYY-MM-DD date) is in, by the SHOP's date: "26-27" for 1 Apr 2026 – 31 Mar 2027. */
export function financialYearLabel(instantOrDate: string, timeZone: string = DEFAULT_SHOP_CALENDAR.timeZone): string {
  let date: string;
  if (/^\d{4}-\d{2}-\d{2}$/.test(instantOrDate)) date = instantOrDate;
  else {
    if (typeof instantOrDate !== 'string' || Number.isNaN(Date.parse(instantOrDate))) throw new DocumentNumberError('not_a_date', `"${String(instantOrDate)}" is not a date`);
    date = shopDateIn(instantOrDate, timeZone);
  }
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  if (!Number.isFinite(y) || m < 1 || m > 12) throw new DocumentNumberError('not_a_date', `"${instantOrDate}" is not a date`);
  const start = m >= 4 ? y : y - 1;
  return `${String(start % 100).padStart(2, '0')}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** "2026-27" (the till machinery's way of writing a year) → "26-27". */
export function shortYear(financialYear: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(financialYear);
  if (m === null) throw new DocumentNumberError('not_a_date', `"${financialYear}" is not a financial year written like 2026-27`);
  return `${m[1]!.slice(2)}-${m[2]}`;
}

const assertStoreNumber = (n: number): void => {
  if (!Number.isSafeInteger(n) || n < 1 || n > 9) throw new DocumentNumberError('not_a_store_number', `the store number must be 1 to 9 (one digit, so every prefix is at most 4 characters), not ${String(n)}`);
};

/** A store-ranged prefix: `GRN1`, `CNT1`, … — the last digit is the store number. */
export function storePrefix(kind: DocumentNumberKind, storeNumber: number): string {
  const rule = DOCUMENT_KINDS[kind];
  if (rule.scope !== 'store') throw new DocumentNumberError('not_a_prefix', `${kind} is not numbered per store`);
  assertStoreNumber(storeNumber);
  return `${rule.letters}${storeNumber}`;
}

/** A company-wide prefix: `PO`, `SPAY`, … */
export function companyPrefix(kind: DocumentNumberKind): string {
  const rule = DOCUMENT_KINDS[kind];
  if (rule.scope !== 'company') throw new DocumentNumberError('not_a_prefix', `${kind} is not numbered company-wide`);
  return rule.letters;
}

/** The letter a till's lane code starts with: `L` a till, `Q` a handheld queue till, `T` a temporary range (restore). */
export type TillLetter = 'L' | 'Q' | 'T';

/**
 * A till's prefix: store digit + letter + two digits (`1L01`, `1Q01`, `1T01`), always 4 characters. A till's RETURNS use the
 * same lane number under `R` (`1R01`) — a separate range, because a return is a different GST document (OB-846 A).
 */
export function tillPrefix(storeNumber: number, letter: TillLetter | 'R', laneNumber: number): string {
  assertStoreNumber(storeNumber);
  if (!Number.isSafeInteger(laneNumber) || laneNumber < 1 || laneNumber > 99) throw new DocumentNumberError('not_a_lane_code', `a lane number is 01 to 99, not ${String(laneNumber)}`);
  return `${storeNumber}${letter}${String(laneNumber).padStart(2, '0')}`;
}

/** A till prefix read back: its store, letter and lane number; undefined when it is not one. */
export function readTillPrefix(prefix: string): { readonly storeNumber: number; readonly letter: TillLetter | 'R'; readonly laneNumber: number } | undefined {
  const m = /^([1-9])([LQTR])(\d{2})$/.exec(prefix);
  if (m === null || m[3] === '00') return undefined;
  return { storeNumber: Number(m[1]), letter: m[2] as TillLetter | 'R', laneNumber: Number(m[3]) };
}

/**
 * The till's NEXT range when one is full (OB-844 A): lane code + 50 (`1L01` → `1L51`, `1R01` → `1R51`). Undefined when there
 * is none — an overflow range itself (51…99), or a temporary one — and the till then refuses by name (no money taken).
 */
export function tillOverflowPrefix(prefix: string): string | undefined {
  const t = readTillPrefix(prefix);
  if (t === undefined || t.letter === 'T' || t.laneNumber > TILL_LANE_MAX) return undefined;
  return tillPrefix(t.storeNumber, t.letter, t.laneNumber + TILL_OVERFLOW_STEP);
}

const PREFIX_FORM = /^[A-Z0-9]{1,4}$/;

/** `PREFIX/YY-YY/NNNNN`, checked: at most 16 characters, the characters GST allows. */
export function formatDocumentNumber(prefix: string, yearLabel: string, count: number): string {
  if (!PREFIX_FORM.test(prefix)) throw new DocumentNumberError(prefix.length > DOCUMENT_PREFIX_MAX ? 'prefix_too_long' : 'not_a_prefix', `the prefix "${prefix}" must be 1 to ${DOCUMENT_PREFIX_MAX} capital letters or digits`);
  if (!/^\d{2}-\d{2}$/.test(yearLabel)) throw new DocumentNumberError('not_a_date', `"${yearLabel}" is not a financial year written like 26-27`);
  if (!Number.isSafeInteger(count) || count < 1 || count > DOCUMENT_COUNT_MAX) throw new DocumentNumberError('count_out_of_range', `the count must be 1 to ${DOCUMENT_COUNT_MAX}, not ${String(count)}`);
  const n = `${prefix}/${yearLabel}/${String(count).padStart(DOCUMENT_COUNT_DIGITS, '0')}`;
  if (n.length > DOCUMENT_NUMBER_MAX_LENGTH) throw new DocumentNumberError('prefix_too_long', `"${n}" is longer than ${DOCUMENT_NUMBER_MAX_LENGTH} characters`);
  return n;
}

/** The leading part a range's numbers share: `1L01/26-27/` — the till machinery's "prefix" for a format-A range. */
export function rangeHead(prefix: string, yearLabel: string): string {
  return `${prefix}/${yearLabel}/`;
}

const FORMAT_A = /^([A-Z0-9]{1,4})\/(\d{2})-(\d{2})\/(\d{5})$/;

/** A format-A number read back; undefined for anything else (every number from before OB-847 keeps its own form). */
export function readDocumentNumber(n: unknown): { readonly prefix: string; readonly yearLabel: string; readonly count: number; readonly head: string } | undefined {
  if (typeof n !== 'string') return undefined;
  const m = FORMAT_A.exec(n);
  if (m === null) return undefined;
  const a = Number(m[2]); const b = Number(m[3]);
  if ((a + 1) % 100 !== b || m[4] === '00000') return undefined;
  const yearLabel = `${m[2]}-${m[3]}`;
  return { prefix: m[1]!, yearLabel, count: Number(m[4]), head: rangeHead(m[1]!, yearLabel) };
}

export const isDocumentNumber = (n: unknown): boolean => readDocumentNumber(n) !== undefined;

/** Whether a count is in the warning band (from 90,000), and how many remain after it. */
export function rangeWarning(count: number): { readonly warn: boolean; readonly remaining: number } {
  return { warn: count >= DOCUMENT_COUNT_WARN_AT, remaining: Math.max(0, DOCUMENT_COUNT_MAX - count) };
}
