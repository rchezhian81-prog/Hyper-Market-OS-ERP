import { describe, it, expect } from 'vitest';
import {
  financialYearOf, formatInvoiceNumber, assertInvoiceNumberValid, allocateInvoiceNumber,
  InvalidInvoiceNumber, MAX_INVOICE_NUMBER_LENGTH, type InvoiceSeriesState,
} from '../../packages/numbering/src/invoice-series';

// Roadmap v2.1 A2 — the GST invoice series is gap-free, ≤16 chars, and resets each financial year.

describe('financialYearOf — Indian FY (April–March)', () => {
  it('puts April–December in the year that started that April', () => {
    expect(financialYearOf('2026-04-01')).toMatchObject({ startYear: 2026, endYear: 2027, label: '2026-27', compact: '2627' });
    expect(financialYearOf('2026-12-31').compact).toBe('2627');
  });
  it('puts January–March in the year that started the previous April', () => {
    expect(financialYearOf('2027-03-31')).toMatchObject({ startYear: 2026, endYear: 2027, compact: '2627' });
    expect(financialYearOf('2026-03-31').compact).toBe('2526');
  });
  it('rejects a bad date', () => {
    expect(() => financialYearOf('2026-13-01')).toThrow(InvalidInvoiceNumber);
    expect(() => financialYearOf('not-a-date')).toThrow(InvalidInvoiceNumber);
  });
});

describe('assertInvoiceNumberValid — Rule 46 ≤16 chars', () => {
  it('accepts a ≤16-char alphanumeric/"/"/"-" number', () => {
    expect(() => assertInvoiceNumberValid('INV/2627/000001')).not.toThrow(); // 15 chars
  });
  it('rejects a >16-char number', () => {
    const long = formatInvoiceNumber({ prefix: 'INVOICE', fyCompact: '2627', seq: 1, padTo: 6 }); // "INVOICE/2627/000001" = 19
    expect(long.length).toBeGreaterThan(MAX_INVOICE_NUMBER_LENGTH);
    expect(() => assertInvoiceNumberValid(long)).toThrow(InvalidInvoiceNumber);
  });
  it('rejects illegal characters', () => {
    expect(() => assertInvoiceNumberValid('INV#2627#1')).toThrow(InvalidInvoiceNumber);
  });
});

describe('allocateInvoiceNumber — gap-free, FY-reset, ≤16', () => {
  it('is gap-free and consecutive within a financial year', () => {
    let state: InvoiceSeriesState = { fyCompact: '2627', next: 1 };
    const seqs: number[] = [];
    for (let i = 0; i < 3; i++) {
      const a = allocateInvoiceNumber(state, { prefix: 'INV', padTo: 6, dateISO: '2026-08-10' });
      seqs.push(a.seq);
      state = a.state;
    }
    expect(seqs).toEqual([1, 2, 3]); // no gaps, strictly increasing (never reused)
    expect(state.next).toBe(4);
  });

  it('RESETS the sequence to 1 when the date rolls into a new financial year', () => {
    // Series is at seq 250 for FY 2626/2627 (compact "2627"); a document dated in the next FY resets.
    const state: InvoiceSeriesState = { fyCompact: '2627', next: 250 };
    const a = allocateInvoiceNumber(state, { prefix: 'INV', padTo: 6, dateISO: '2027-04-01' }); // FY 2027-28
    expect(a.seq).toBe(1);
    expect(a.financialYear.compact).toBe('2728');
    expect(a.number).toBe('INV/2728/000001');
    expect(a.state).toEqual({ fyCompact: '2728', next: 2 });
  });

  it('rejects an allocation whose number would exceed 16 characters', () => {
    const state: InvoiceSeriesState = { fyCompact: '2627', next: 1 };
    expect(() => allocateInvoiceNumber(state, { prefix: 'INVOICE', padTo: 6, dateISO: '2026-08-10' })).toThrow(InvalidInvoiceNumber);
  });
});
