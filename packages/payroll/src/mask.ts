// Masking for the sensitive identifiers a payroll screen must never show in full by default
// (owner directive, 14 Aug 2026 · P-04 least privilege · DPDP). Bank account, PAN, UAN and Aadhaar are
// each shown as their last few characters only, so a person can recognise "yes, that's my account ending
// 3210" without the screen ever putting the whole number in front of a shoulder-surfer, a screenshot, a
// screen-share or a print-out.
//
// Pure and deterministic. The same last-4 shape as `packages/ops/src/logging.ts maskPii`, but format-aware
// per identifier. Defence in depth: the server should send these already masked, and the screen masks again
// on the way to the DOM, so a raw value that slips into a payload is still never rendered whole.
//
// **Aadhaar is special (Aadhaar Act §7 / UIDAI).** It is never returned in full by anything here — there is
// no `revealAadhaar`. A lawful full-Aadhaar workflow, if one is ever needed, is a separate, audited path.

/** What we print when there is genuinely nothing to mask — never an empty string that reads as "blank". */
export const NOT_PROVIDED = '—';

/** Keep the last `keep` characters, replace the rest with `maskChar`. A value too short is fully masked. */
function maskAllButLast(raw: string, keep: number, maskChar = 'X'): string {
  const value = raw.trim();
  if (value === '') return NOT_PROVIDED;
  if (value.length <= keep) return maskChar.repeat(value.length);
  return maskChar.repeat(value.length - keep) + value.slice(value.length - keep);
}

/**
 * A bank account number → all but the last 4 digits masked (e.g. `XXXXXX3210`).
 *
 * Digits only for length, so grouping spaces in the input do not change the visible tail.
 */
export function maskBankAccount(raw: string | undefined | null): string {
  if (raw == null) return NOT_PROVIDED;
  const digits = raw.replace(/\s+/g, '');
  return maskAllButLast(digits, 4);
}

/**
 * A UAN (12-digit Universal Account Number) → last 4 shown (`XXXXXXXX1234`).
 */
export function maskUan(raw: string | undefined | null): string {
  if (raw == null) return NOT_PROVIDED;
  return maskAllButLast(raw.replace(/\s+/g, ''), 4);
}

/**
 * A PAN (`AAAAA9999A`) → last 4 shown, uppercased (`XXXXXX999A`).
 *
 * The last four (the serial digits + the check letter) are enough for a person to recognise their own PAN;
 * the first five (name/status/holder letters) are the identifying part and stay hidden.
 */
export function maskPan(raw: string | undefined | null): string {
  if (raw == null) return NOT_PROVIDED;
  return maskAllButLast(raw.trim().toUpperCase(), 4);
}

/**
 * Aadhaar (12 digits) → last 4 shown, grouped like the card (`XXXX XXXX 1234`). **Never returned in full.**
 *
 * The last four digits are the officially shareable part (masked-Aadhaar / UIDAI); everything before them is
 * hidden, always, with no reveal on this path.
 */
export function maskAadhaar(raw: string | undefined | null): string {
  if (raw == null) return NOT_PROVIDED;
  const digits = raw.replace(/\s+/g, '');
  if (digits.trim() === '') return NOT_PROVIDED;
  const masked = maskAllButLast(digits, 4);
  // Group into 4-4-4 so it reads like the card, e.g. "XXXX XXXX 1234".
  return masked.replace(/(.{4})(.{4})(.{0,4})/, (_m, a, b, c) => [a, b, c].filter(Boolean).join(' '));
}

/** The sensitive fields a payroll row may carry, and their masked forms. One place, so none is missed. */
export interface MaskedIdentifiers {
  readonly bankAccountMasked: string;
  readonly panMasked: string;
  readonly uanMasked: string;
  readonly aadhaarMasked: string;
}

export interface RawIdentifiers {
  readonly bankAccount?: string | null;
  readonly pan?: string | null;
  readonly uan?: string | null;
  readonly aadhaar?: string | null;
}

/** Mask every sensitive identifier on a record at once — the single call a display layer uses. */
export function maskIdentifiers(raw: RawIdentifiers): MaskedIdentifiers {
  return {
    bankAccountMasked: maskBankAccount(raw.bankAccount),
    panMasked: maskPan(raw.pan),
    uanMasked: maskUan(raw.uan),
    aadhaarMasked: maskAadhaar(raw.aadhaar),
  };
}
