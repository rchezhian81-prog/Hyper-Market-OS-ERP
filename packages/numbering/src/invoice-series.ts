// GST invoice series — gap-free, ≤16 chars, resets each financial year (roadmap v2.1 A2 / CGST Rule 46).
//
// A tax-invoice number carries three duties the generic gap-free series (numbering.ts) does not encode:
//   • it must be no longer than 16 characters (Rule 46);
//   • it must be unique for the whole FINANCIAL YEAR, and a fresh series starts each year;
//   • it is consecutive with no gaps, and a number is never reused.
//
// The resolution is to put the financial year INSIDE the number (INV/2627/000001) so the sequence can
// safely restart at 1 every April without ever colliding with last year's, and to reject at allocation
// time anything that would breach the 16-char limit — a too-long number is caught before it is issued,
// not discovered on a filed return. The allocator is pure: it takes the series state and returns the
// next number plus the new state, so the caller (cloud series or an offline reserved range) owns
// persistence and there is no hidden clock.

/** Rule 46: a tax-invoice number is at most 16 characters. */
export const MAX_INVOICE_NUMBER_LENGTH = 16;
/** Rule 46 permits digits, letters, and "/" or "-" only. */
const INVOICE_NUMBER_FORM = /^[0-9A-Za-z/-]{1,16}$/;

export class InvalidInvoiceNumber extends Error {
  constructor(detail: string) {
    super(`Invalid invoice number: ${detail}`);
    this.name = 'InvalidInvoiceNumber';
  }
}

/** The Indian financial year (1 April – 31 March) a date falls in. */
export interface FinancialYear {
  readonly startYear: number;
  readonly endYear: number;
  /** Human label, e.g. "2026-27". */
  readonly label: string;
  /** Compact form for embedding in a number, e.g. "2627". */
  readonly compact: string;
}

/**
 * The financial year a date (YYYY-MM-DD) falls in. April–March: a date in Jan–Mar belongs to the year
 * that began the previous April.
 *
 * @throws InvalidInvoiceNumber if the date is not a valid YYYY-MM-DD.
 */
export function financialYearOf(dateISO: string): FinancialYear {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO) || Number.isNaN(Date.parse(`${dateISO}T00:00:00.000Z`))) {
    throw new InvalidInvoiceNumber(`"${dateISO}" is not a valid YYYY-MM-DD date`);
  }
  const year = Number(dateISO.slice(0, 4));
  const month = Number(dateISO.slice(5, 7));
  const startYear = month >= 4 ? year : year - 1;
  const endYear = startYear + 1;
  return {
    startYear,
    endYear,
    label: `${startYear}-${String(endYear).slice(2)}`,
    compact: `${String(startYear).slice(2)}${String(endYear).slice(2)}`,
  };
}

/** Render an invoice number as `<prefix>/<FYcompact>/<zero-padded seq>`, e.g. INV/2627/000001. */
export function formatInvoiceNumber(parts: {
  readonly prefix: string;
  readonly fyCompact: string;
  readonly seq: number;
  readonly padTo: number;
}): string {
  return `${parts.prefix}/${parts.fyCompact}/${String(parts.seq).padStart(parts.padTo, '0')}`;
}

/**
 * Assert a formatted invoice number is legal under Rule 46 — at most 16 characters and only
 * digits/letters/"/"/"-".
 *
 * @throws InvalidInvoiceNumber when too long or malformed.
 */
export function assertInvoiceNumberValid(formatted: string): void {
  if (formatted.length > MAX_INVOICE_NUMBER_LENGTH) {
    throw new InvalidInvoiceNumber(`"${formatted}" is ${formatted.length} characters — the limit is ${MAX_INVOICE_NUMBER_LENGTH}`);
  }
  if (!INVOICE_NUMBER_FORM.test(formatted)) {
    throw new InvalidInvoiceNumber(`"${formatted}" uses characters outside digits, letters, "/" and "-"`);
  }
}

/** The state of one invoice series: the financial year it is counting in, and the next sequence. */
export interface InvoiceSeriesState {
  readonly fyCompact: string;
  readonly next: number;
}

export interface InvoiceAllocation {
  readonly number: string;
  readonly seq: number;
  readonly financialYear: FinancialYear;
  readonly state: InvoiceSeriesState;
}

/**
 * Allocate the next invoice number for a document dated `dateISO` (A2). Gap-free and consecutive within
 * a financial year; when the date's financial year differs from the state's, the sequence RESETS to 1
 * (a fresh series for the new year). The result is validated against the 16-char Rule 46 limit before
 * it is returned — a too-long number throws rather than being issued.
 *
 * @throws InvalidInvoiceNumber on a bad date or a number that would exceed 16 characters.
 */
export function allocateInvoiceNumber(
  state: InvoiceSeriesState,
  opts: { readonly prefix: string; readonly padTo: number; readonly dateISO: string },
): InvoiceAllocation {
  const fy = financialYearOf(opts.dateISO);
  const seq = fy.compact === state.fyCompact ? state.next : 1; // reset each financial year
  const number = formatInvoiceNumber({ prefix: opts.prefix, fyCompact: fy.compact, seq, padTo: opts.padTo });
  assertInvoiceNumberValid(number);
  return { number, seq, financialYear: fy, state: { fyCompact: fy.compact, next: seq + 1 } };
}
