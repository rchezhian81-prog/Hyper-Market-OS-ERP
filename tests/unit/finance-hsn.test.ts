import { describe, it, expect } from 'vitest';
import { requiredHsnDigits, validateHsnForTurnover, HSN_SIX_DIGIT_TURNOVER_THRESHOLD_MINOR, InvalidHsnInput } from '../../packages/finance/src/hsn';

// Roadmap v2.1 A4 — HSN digit count by turnover: 6 digits above ₹5 crore aggregate turnover, else 4;
// and a code with fewer digits than required FAILS (a too-short HSN is a non-compliant invoice).

// ₹5 crore in paisa, pinned so a mis-grouped literal can never slip through.
const FIVE_CRORE = 5_000_000_000;

describe('requiredHsnDigits — A4', () => {
  it('pins the ₹5 crore threshold in paisa', () => {
    expect(HSN_SIX_DIGIT_TURNOVER_THRESHOLD_MINOR).toBe(FIVE_CRORE);
    expect(FIVE_CRORE).toBe(50_000_000 * 100); // ₹50,000,000 (= ₹5 crore) × 100 paisa
  });

  it('requires 4 digits at or below ₹5 crore and 6 digits strictly above it', () => {
    expect(requiredHsnDigits(0)).toBe(4);
    expect(requiredHsnDigits(FIVE_CRORE - 1)).toBe(4);
    expect(requiredHsnDigits(FIVE_CRORE)).toBe(4);       // exactly ₹5 crore → 4 (not "over")
    expect(requiredHsnDigits(FIVE_CRORE + 1)).toBe(6);   // just over → 6
    expect(requiredHsnDigits(FIVE_CRORE * 3)).toBe(6);
  });

  it('refuses a negative or non-whole turnover', () => {
    expect(() => requiredHsnDigits(-1)).toThrow(InvalidHsnInput);
    expect(() => requiredHsnDigits(10.5)).toThrow(InvalidHsnInput);
  });
});

describe('validateHsnForTurnover — A4: a too-short code fails', () => {
  it('accepts a code with at least the required digits, including a more specific longer one', () => {
    // Small shop (≤ ₹5cr): 4 digits required.
    expect(validateHsnForTurnover({ hsnCode: '1006', annualTurnoverMinor: 1_000_000 }).valid).toBe(true);
    expect(validateHsnForTurnover({ hsnCode: '100630', annualTurnoverMinor: 1_000_000 }).valid).toBe(true); // 6 ≥ 4
  });

  it('fails a 4-digit code for a large shop that needs 6 digits', () => {
    const r = validateHsnForTurnover({ hsnCode: '1006', annualTurnoverMinor: FIVE_CRORE + 1 });
    expect(r.requiredDigits).toBe(6);
    expect(r.providedDigits).toBe(4);
    expect(r.valid).toBe(false);
    expect(r.detail).toContain('non-compliant');
  });

  it('accepts a 6- or 8-digit code for a large shop', () => {
    expect(validateHsnForTurnover({ hsnCode: '100630', annualTurnoverMinor: FIVE_CRORE + 1 }).valid).toBe(true);
    expect(validateHsnForTurnover({ hsnCode: '10063010', annualTurnoverMinor: FIVE_CRORE + 1 }).valid).toBe(true);
  });

  it('refuses a malformed HSN rather than treat it as compliant', () => {
    expect(() => validateHsnForTurnover({ hsnCode: '10A6', annualTurnoverMinor: 1_000_000 })).toThrow(InvalidHsnInput); // non-digit
    expect(() => validateHsnForTurnover({ hsnCode: '10063', annualTurnoverMinor: 1_000_000 })).toThrow(InvalidHsnInput); // 5 digits — not a plausible HSN length
  });
});
