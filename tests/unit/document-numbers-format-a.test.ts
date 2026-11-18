import { describe, it, expect } from 'vitest';
import {
  DOCUMENT_KINDS, DOCUMENT_NUMBER_MAX_LENGTH, DOCUMENT_COUNT_MAX, DocumentNumberError,
  financialYearLabel, shortYear, storePrefix, companyPrefix, tillPrefix, tillOverflowPrefix, readTillPrefix,
  formatDocumentNumber, readDocumentNumber, rangeWarning, type DocumentNumberKind,
} from '../../packages/numbering/src/document-numbers';
import { splitReceiptNumber, receiptNumberFor, isStoreComputerDefaultReceipt } from '../../packages/contracts/src/receipt-number';

// OB-847 (owner, 18 Nov 2026: "Document numbers, format A") · OB-844 A · OB-846 A — the pure rule every document number obeys.

describe('format A: PREFIX/YY-YY/NNNNN, never longer than GST\'s 16 characters', () => {
  it('every agreed prefix, at its highest count (99,999), is at most 16 characters', () => {
    const all: string[] = [];
    for (const kind of Object.keys(DOCUMENT_KINDS) as DocumentNumberKind[]) {
      const rule = DOCUMENT_KINDS[kind];
      if (rule.scope === 'company') all.push(companyPrefix(kind));
      else if (rule.scope === 'store') for (let store = 1; store <= 9; store += 1) all.push(storePrefix(kind, store));
    }
    for (let store = 1; store <= 9; store += 1) {
      for (let lane = 1; lane <= 99; lane += 1) for (const l of ['L', 'Q', 'R', 'T'] as const) all.push(tillPrefix(store, l, lane));
    }
    for (const p of all) {
      expect(p.length).toBeLessThanOrEqual(4);
      const n = formatDocumentNumber(p, '26-27', DOCUMENT_COUNT_MAX);
      expect(n.length).toBeLessThanOrEqual(DOCUMENT_NUMBER_MAX_LENGTH);
      expect(n).toMatch(/^[A-Z0-9]{1,4}\/\d{2}-\d{2}\/\d{5}$/);
    }
    // The agreed prefixes, exactly (store 1).
    expect(['goods_receipt', 'stock_count', 'write_off', 'transfer_out', 'return_to_supplier', 'floor_indent', 'money_receipt'].map((k) => storePrefix(k as DocumentNumberKind, 1)))
      .toEqual(['GRN1', 'CNT1', 'WOF1', 'TRF1', 'RTS1', 'IND1', 'RCT1']);
    expect(['purchase_order', 'supplier_payment', 'supplier_advance', 'supplier_debit_note', 'customer_credit_note', 'customer_debit_note', 'business_invoice'].map((k) => companyPrefix(k as DocumentNumberKind)))
      .toEqual(['PO', 'SPAY', 'SADV', 'SDN', 'CCN', 'CDN', 'BINV']);
    expect([tillPrefix(1, 'L', 1), tillPrefix(1, 'R', 1), tillPrefix(1, 'Q', 1), tillPrefix(1, 'T', 1)]).toEqual(['1L01', '1R01', '1Q01', '1T01']);
    expect(formatDocumentNumber('1L01', '26-27', 1)).toBe('1L01/26-27/00001');
    expect(formatDocumentNumber('SPAY', '26-27', 99_999)).toBe('SPAY/26-27/99999');
  });

  it('refuses anything that could pass 16 characters or is not a count', () => {
    expect(() => formatDocumentNumber('GRN10', '26-27', 1)).toThrow(DocumentNumberError);
    expect(() => storePrefix('goods_receipt', 10)).toThrow(/1 to 9/);
    expect(() => formatDocumentNumber('PO', '26-27', 0)).toThrow(DocumentNumberError);
    expect(() => formatDocumentNumber('PO', '26-27', 100_000)).toThrow(DocumentNumberError);
    expect(() => formatDocumentNumber('po', '26-27', 1)).toThrow(DocumentNumberError);
  });

  it('reads a format-A number back, and never mistakes an older number for one', () => {
    expect(readDocumentNumber('GRN1/26-27/00042')).toEqual({ prefix: 'GRN1', yearLabel: '26-27', count: 42, head: 'GRN1/26-27/' });
    for (const old of ['DN-000001', 'CN-000003', 'R-lane-1-000123', 'ZZABCDEF-000001', 'S2L1-000010', 'GRN1/26-28/00001', 'PO/26-27/00000']) expect(readDocumentNumber(old)).toBeUndefined();
    // The till machinery's split: a format-A number's head and its 5-digit count; an old number's prefix and 6-digit count.
    expect(splitReceiptNumber('1L01/26-27/00042')).toEqual({ prefix: '1L01/26-27/', counter: 42 });
    expect(splitReceiptNumber('S2L1-000010')).toEqual({ prefix: 'S2L1-', counter: 10 });
    expect(receiptNumberFor('1L01/26-27/', 42)).toBe('1L01/26-27/00042');
    expect(receiptNumberFor('S2L1-', 10)).toBe('S2L1-000010');
    // A temporary till range (a restore) is flagged like the older store-coded fallback.
    expect(isStoreComputerDefaultReceipt('1T01/26-27/00001')).toBe(true);
    expect(isStoreComputerDefaultReceipt('1L01/26-27/00001')).toBe(false);
  });
});

describe('the financial year restarts each 1 April, by the SHOP\'s date (Asia/Kolkata), not UTC', () => {
  it('31 March 23:59 IST is still the old year; 1 April 00:00 IST is the new one', () => {
    // 1 April 00:00 IST is 31 March 18:30 UTC — UTC still says March, the shop says April.
    expect(financialYearLabel('2027-03-31T18:29:59.000Z')).toBe('26-27');
    expect(financialYearLabel('2027-03-31T18:30:00.000Z')).toBe('27-28');
    expect(financialYearLabel('2026-04-01')).toBe('26-27');
    expect(financialYearLabel('2027-03-31')).toBe('26-27');
    expect(financialYearLabel('2099-12-31T10:00:00.000Z')).toBe('99-00');
    expect(shortYear('2026-27')).toBe('26-27');
    expect(() => financialYearLabel('not a date')).toThrow(DocumentNumberError);
  });
});

describe('OB-844 A: 5 digits; a till at 99,999 moves to lane code + 50 by itself; a warning from 90,000', () => {
  it('the overflow range is the lane code + 50, and there is none beyond it', () => {
    expect(tillOverflowPrefix('1L01')).toBe('1L51');
    expect(tillOverflowPrefix('1L49')).toBe('1L99');
    expect(tillOverflowPrefix('1L50')).toBeUndefined(); // code 50 is never given: 50 + 50 would not fit two digits
    expect(tillOverflowPrefix('1R07')).toBe('1R57');
    expect(tillOverflowPrefix('2Q03')).toBe('2Q53');
    expect(tillOverflowPrefix('1L51')).toBeUndefined();
    expect(tillOverflowPrefix('1T01')).toBeUndefined();
    expect(readTillPrefix('1L51')).toEqual({ storeNumber: 1, letter: 'L', laneNumber: 51 });
    expect(readTillPrefix('1L00')).toBeUndefined();
  });

  it('the warning starts at the 90,000th number', () => {
    expect(rangeWarning(89_999)).toEqual({ warn: false, remaining: 10_000 });
    expect(rangeWarning(90_000)).toEqual({ warn: true, remaining: 9_999 });
    expect(rangeWarning(99_999)).toEqual({ warn: true, remaining: 0 });
  });
});
