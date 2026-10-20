// OB-264 (owner, 20 Oct 2026, "Key old bill number") — the OLD ERP's bill number on every mirror-pilot sale.
//
// In the mirror pilot (OB-248) the customer is billed on the old ERP and holds only the old ERP's bill. The keyer types
// that bill's number on the new till's sale, so that:
//   • a mirror refund finds its sale on the new till by the number on the customer's bill (OB-264, OB-258);
//   • the day book and the evening check can list the new till's sales bill by bill against the old ERP's numbers, if
//     the evening check ends up bill-wise (OB-263, still pending).
//
// The rules, and where each comes from (nothing here is a guess):
//   • REQUIRED on every sale while the mirror pilot is on; refused while it is off (the field means nothing then) — the
//     same on/off shape as the "Paid on old system" tender (OB-256, `paid-on-old-erp.ts`).
//   • THE OLD ERP'S BILL IS THE LEGAL GST INVOICE (OB-248), so its number obeys CGST Rule 46(b): at most 16 characters,
//     letters, digits, "-" (hyphen or dash) and "/" (slash), unique within a financial year. The same bound and the same
//     characters the new till's own bill numbers keep (`packages/contracts/src/receipt-number.ts`). Typed letters are
//     kept as capitals, so "sre/12" and "SRE/12" are one bill.
//   • NO PERSONAL DATA (OB-252 guest sales only · P-04 · hard rule #3): a value shaped like an Indian mobile number, a
//     12-digit Aadhaar number or a card number is refused — a bill number is never any of those, and a keyer who types
//     one by mistake is told, before the disk.
//   • KEYED TWICE → REFUSED, in words, before the disk (hard rule #10: never silently doubled). Why refused and not
//     recorded-and-flagged: a refund must find exactly ONE sale by the number (OB-264), a bill number is unique within a
//     financial year (Rule 46(b)), and the store computer already refuses a bill number used on another record (PF-04).
//     A refusal loses nothing: the customer was billed on the old ERP, the basket stays on the till, and the keyer is told
//     to check the number. A sale whose whole value has since been refunded on the new till no longer holds its number,
//     so a bill keyed wrongly can be refunded and keyed again; its stock and value then net to the one bill.
//
// Pure, no clock, no I/O: the till decides before its disk and the store computer decides again before ITS disk with the
// same sentences (hard rule #1: no network in either).

import { normaliseMobile } from '../../loyalty/src/mobile';

/** CGST Rule 46(b): an invoice's serial number is at most 16 characters (`GST_INVOICE_NUMBER_MAX`). */
export const OLD_ERP_BILL_MAX = 16;

/** What the till and the store computer say, in English. The till shows the same in Tamil from its own word list. */
export const OLD_ERP_BILL_WORDS = {
  /** The question on the till. */
  ask: 'Old bill number',
  /** Under the question. */
  hint: 'Type the bill number printed on the old system\'s bill, exactly as printed: letters, digits, "-" and "/", up to 16.',
  /** A mirror sale with no old bill number. */
  missing: 'Mirror pilot: type the old system\'s bill number for this sale — it is printed on the customer\'s old bill. Nothing was saved.',
  /** Not a bill number by Rule 46(b). */
  notValid: 'That is not an old bill number. A bill number is up to 16 letters, digits, "-" or "/", as printed on the old bill — no spaces or other marks. Nothing was saved.',
  /** Shaped like a phone, Aadhaar or card number. */
  looksPersonal: 'That looks like a phone, Aadhaar or card number, not a bill number. Never type a customer\'s details here. Type the number printed on the old bill. Nothing was saved.',
  /** An old bill number while the mirror pilot is off. */
  notOn: 'An old bill number is kept only in the mirror pilot, and this store computer is not set for it. Nothing was saved.',
  /** The question when a mirror refund looks the sale up. */
  refundAsk: 'Old bill number on the customer\'s bill',
  /** No sale carries it. */
  refundNotFound: 'No sale on this store computer carries that old bill number. Check the number on the customer\'s old bill and try again. Nothing was recorded.',
} as const;

/** The words for a number already on another live sale this financial year. Names the new bill that holds it. */
export const oldErpBillRepeatedWords = (oldBill: string, heldBy: string): string =>
  `Old bill number ${oldBill} is already keyed on another sale (new bill ${heldBy}). Check the number on the old bill. If it is right, this bill was already keyed — do not key it twice. Nothing was saved.`;

export type OldErpBillRefusal = 'old_bill_missing' | 'old_bill_not_valid' | 'old_bill_looks_personal' | 'old_bill_not_on' | 'old_bill_repeated';

export interface OldErpBillRefused { readonly refusedBecause: OldErpBillRefusal; readonly laneMessage: string }

const refused = (refusedBecause: OldErpBillRefusal, laneMessage: string): OldErpBillRefused => ({ refusedBecause, laneMessage });

const CHARS = /^[A-Z0-9/-]+$/;
/** 12 to 16 digits in a row (an Aadhaar number, a card number), or the same in groups of four with hyphens. */
const LONG_DIGITS = /^\d{12,16}$/;
const GROUPED_DIGITS = /^\d{4}(-\d{4}){2,3}$/;

/**
 * Read what the keyer typed as an old bill number: trimmed, letters made capitals, then judged. `ok` carries the number
 * exactly as it is kept on the sale record.
 */
export function readOldErpBillNumber(raw: unknown): ({ readonly ok: true; readonly value: string }) | ({ readonly ok: false } & OldErpBillRefused) {
  const typed = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (typed === '') return { ok: false, ...refused('old_bill_missing', OLD_ERP_BILL_WORDS.missing) };
  // Personal data first, so the keyer is told what it looks like even when it would also be too long.
  if (normaliseMobile(typed) !== undefined || LONG_DIGITS.test(typed) || GROUPED_DIGITS.test(typed)) {
    return { ok: false, ...refused('old_bill_looks_personal', OLD_ERP_BILL_WORDS.looksPersonal) };
  }
  if (typed.length > OLD_ERP_BILL_MAX || !CHARS.test(typed)) return { ok: false, ...refused('old_bill_not_valid', OLD_ERP_BILL_WORDS.notValid) };
  return { ok: true, value: typed };
}

/** Is this already an old bill number in the form it is kept (so the store computer and head office keep it unchanged)? */
export function isOldErpBillNumber(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const read = readOldErpBillNumber(v);
  return read.ok && read.value === v;
}

/**
 * May a SALE record carry this old bill number? `undefined` = yes. With the mirror pilot on it is required and must be in
 * its kept form; with it off there must be none. (Whether another sale already holds it is `oldErpBillHolder`.)
 */
export function oldErpBillRefusal(input: { readonly mirrorOn: boolean; readonly value: unknown }): OldErpBillRefused | undefined {
  const given = input.value !== undefined && input.value !== null && input.value !== '';
  if (!input.mirrorOn) return given ? refused('old_bill_not_on', OLD_ERP_BILL_WORDS.notOn) : undefined;
  const read = readOldErpBillNumber(input.value);
  if (!read.ok) return refused(read.refusedBecause, read.laneMessage);
  // The till keeps it in capitals, trimmed; a record in any other form did not come through the till's own rule.
  return read.value === input.value ? undefined : refused('old_bill_not_valid', OLD_ERP_BILL_WORDS.notValid);
}

/** The Indian financial year (1 April – 31 March) a trading day falls in, e.g. "2026-27". Undefined if not a day. */
export function financialYearOf(tradingDay: string): string | undefined {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(tradingDay);
  if (m === null) return undefined;
  const year = Number(m[1]);
  const start = Number(m[2]) >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** One sale that carries an old bill number, as the store computer knows it from its own logs. */
export interface OldErpBillSale {
  readonly saleId: string;
  /** The new till's bill number. */
  readonly number: string;
  readonly tradingDay: string;
  readonly totalMinor: number;
  /** Every refund already against it, any tender. */
  readonly refundedMinor: number;
  readonly oldErpBillNumber: string;
}

/** A sale still holds its old bill number until its whole value has come back on the new till. */
export const stillHoldsItsNumber = (s: OldErpBillSale): boolean => s.refundedMinor < s.totalMinor || s.totalMinor <= 0;

/**
 * The sale that already holds this old bill number, if any: another sale (not this one — a re-send of the same sale is
 * the same sale), in the same financial year, that still holds its number. Undefined = the number is free.
 */
export function oldErpBillHolder(input: {
  readonly oldErpBillNumber: string;
  readonly saleId: string;
  readonly tradingDay: string;
  readonly sales: readonly OldErpBillSale[];
}): OldErpBillSale | undefined {
  const year = financialYearOf(input.tradingDay);
  return input.sales.find((s) => s.oldErpBillNumber === input.oldErpBillNumber && s.saleId !== input.saleId
    && (year === undefined || financialYearOf(s.tradingDay) === undefined || financialYearOf(s.tradingDay) === year) && stillHoldsItsNumber(s));
}

/** The refusal for a number another sale holds, or undefined. */
export function oldErpBillRepeatRefusal(input: Parameters<typeof oldErpBillHolder>[0]): OldErpBillRefused | undefined {
  const holder = oldErpBillHolder(input);
  return holder === undefined ? undefined : refused('old_bill_repeated', oldErpBillRepeatedWords(input.oldErpBillNumber, holder.number));
}

/**
 * The sale a mirror refund is against, found by the old bill number on the customer's bill: the latest sale that still
 * holds the number; else (every one fully refunded) the latest that carried it, so the till can say nothing is left.
 */
export function saleForOldErpBill(oldErpBillNumber: string, sales: readonly OldErpBillSale[]): OldErpBillSale | undefined {
  const carrying = sales.filter((s) => s.oldErpBillNumber === oldErpBillNumber);
  return [...carrying].reverse().find(stillHoldsItsNumber) ?? carrying.at(-1);
}
