import { describe, it, expect } from 'vitest';
import {
  maskBankAccount, maskUan, maskPan, maskAadhaar, maskIdentifiers, NOT_PROVIDED,
} from '../../packages/payroll/src/mask';

/**
 * **Masking the sensitive identifiers a payroll screen must never show in full (owner directive; DPDP).**
 *
 * The rule is: a person can recognise their own account/PAN/UAN/Aadhaar from the last few characters, and a
 * shoulder-surfer, a screenshot or a print-out learns nothing more. Aadhaar in particular is NEVER returned
 * whole — there is no reveal on this path.
 */

describe('bank account', () => {
  it('shows only the last four digits', () => {
    expect(maskBankAccount('123456789012')).toBe('XXXXXXXX9012');
    // Grouping spaces do not change the visible tail.
    expect(maskBankAccount('1234 5678 9012')).toBe('XXXXXXXX9012');
  });
  it('fully masks something too short to have a safe tail', () => {
    expect(maskBankAccount('12')).toBe('XX');
  });
  it('says "not provided" for absent/blank, never a blank that reads as empty', () => {
    expect(maskBankAccount(undefined)).toBe(NOT_PROVIDED);
    expect(maskBankAccount(null)).toBe(NOT_PROVIDED);
    expect(maskBankAccount('   ')).toBe(NOT_PROVIDED);
  });
});

describe('PAN', () => {
  it('shows only the last four, uppercased, hiding the identifying first five', () => {
    expect(maskPan('abcde1234f')).toBe('XXXXXX234F');
    expect(maskPan('ABCDE1234F')).toBe('XXXXXX234F');
  });
});

describe('UAN', () => {
  it('shows only the last four', () => {
    expect(maskUan('100987654321')).toBe('XXXXXXXX4321');
  });
});

describe('Aadhaar', () => {
  it('shows only the last four, grouped like the card, and NEVER in full', () => {
    const masked = maskAadhaar('234512345678');
    expect(masked).toBe('XXXX XXXX 5678');
    // The whole number never appears.
    expect(masked).not.toContain('2345123');
    expect(masked.replace(/\D/g, '')).toBe('5678');
  });
  it('handles grouped input and absence', () => {
    expect(maskAadhaar('2345 1234 5678')).toBe('XXXX XXXX 5678');
    expect(maskAadhaar(undefined)).toBe(NOT_PROVIDED);
  });
});

describe('maskIdentifiers', () => {
  it('masks every sensitive field at once and never carries a raw value through', () => {
    const raw = { bankAccount: '123456789012', pan: 'ABCDE1234F', uan: '100987654321', aadhaar: '234512345678' };
    const masked = maskIdentifiers(raw);
    expect(masked).toEqual({
      bankAccountMasked: 'XXXXXXXX9012', panMasked: 'XXXXXX234F', uanMasked: 'XXXXXXXX4321', aadhaarMasked: 'XXXX XXXX 5678',
    });
    const blob = JSON.stringify(masked);
    for (const rawValue of Object.values(raw)) expect(blob).not.toContain(rawValue);
  });
});
