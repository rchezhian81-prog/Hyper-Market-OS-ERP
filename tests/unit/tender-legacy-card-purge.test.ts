import { describe, it, expect } from 'vitest';
import { checkLegacyCardPurge, type LegacyRecord } from '../../packages/tender/src/legacy-card-purge';
import { generateLegacyDataset } from '../../packages/migration/src/synthetic';

// C10 (v2.1 addendum · MG-04 · hard rule #3): the legacy-card-purge check. A legacy extract passes only when it holds no
// card number, security code or card expiry anywhere; every finding names where, never the value. Synthetic data only —
// the published test card numbers, assembled at run time.

const TEST_VISA = ['4111', '1111', '1111', '1111'].join('');
const TEST_AMEX = ['3782', '822463', '10005'].join('');

const rec = (rowRef: string, fields: Record<string, unknown>, source = 'old-pos.sales'): LegacyRecord => ({ source, rowRef, fields });

describe('the legacy-card-purge check (C10)', () => {
  it('passes a clean extract — barcodes, GSTINs, batch use-by dates and phone numbers are not card data', () => {
    const r = checkLegacyCardPurge([
      rec('1', { billNo: 'B-1001', barcode: '8901030865278', carton: '18901030865275', gstin: '33AABCS1429B1ZB', expiry: '2026-12-31', phone: '9876543210', tender: 'CARD', total: 1250 }),
      rec('2', { billNo: 'B-1002', 'Expiry Date': '31/12/26', remarks: 'paid by UPI ref 412345678901' }),
    ]);
    expect(r.passed).toBe(true);
    expect(r.findings).toEqual([]);
    expect(r.recordsScanned).toBe(2);
    expect(r.valuesScanned).toBe(11);
    expect(r.detail).toContain('may go on to be loaded');
  });

  it('fails on a full card number anywhere — a column of its own or buried in remarks — and never repeats it', () => {
    const r = checkLegacyCardPurge([
      rec('7', { billNo: 'B-7', remarks: `card ${TEST_VISA.replace(/(\d{4})(?=\d)/g, '$1 ')} swiped` }),
      rec('8', { billNo: 'B-8', ref: TEST_AMEX }),
    ]);
    expect(r.passed).toBe(false);
    expect(r.findings.map((f) => [f.rowRef, f.column, f.kind])).toEqual([
      ['7', 'remarks', 'card_number_value'],
      ['8', 'ref', 'card_number_value'],
    ]);
    const words = JSON.stringify(r);
    expect(words).not.toContain(TEST_VISA);
    expect(words).not.toContain(TEST_AMEX);
    expect(words).not.toContain('4111 1111');
  });

  it('fails on card-number, security-code and card-expiry columns, and lists them to drop', () => {
    const r = checkLegacyCardPurge([
      rec('3', { 'Card No.': 'XXXX', CVV2: '000', 'Card Expiry': '12/29', amount: 500 }),
      rec('4', { billNo: 'B-4', cc_exp: '0130' }, 'old-erp.receipts'),
    ]);
    expect(r.passed).toBe(false);
    expect(r.findings.map((f) => f.kind).sort()).toEqual(['card_expiry_column', 'card_expiry_column', 'card_number_column', 'card_security_code_column']);
    expect(r.columnsToDrop).toEqual(['old-erp.receipts:cc_exp', 'old-pos.sales:CVV2', 'old-pos.sales:Card Expiry', 'old-pos.sales:Card No.']);
    expect(JSON.stringify(r.findings)).not.toContain('12/29');
  });

  it('treats a plain expiry as the card\'s only when the same record holds card data', () => {
    const withCard = checkLegacyCardPurge([rec('5', { remarks: TEST_VISA, expiry: '12/29' })]);
    expect(withCard.findings.map((f) => f.kind).sort()).toEqual(['card_expiry_column', 'card_number_value']);
    const groceries = checkLegacyCardPurge([rec('6', { item: 'Milk 500ml', expiry: '2026-10-20' }, 'old-erp.stock')]);
    expect(groceries.passed).toBe(true);
  });

  it('fails on a masked card that shows more than the last four digits, passes one that shows only the last four', () => {
    expect(checkLegacyCardPurge([rec('9', { masked: '411111******1111' })]).findings.map((f) => f.kind)).toEqual(['masked_card_beyond_last4']);
    expect(checkLegacyCardPurge([rec('10', { masked: 'XXXX XXXX XXXX 1111' })]).passed).toBe(true);
  });

  it('does not mistake the Indian income-tax PAN column for a card', () => {
    expect(checkLegacyCardPurge([rec('11', { PAN: 'ABCPS1234D', name: 'A Supplier' }, 'old-erp.suppliers')]).passed).toBe(true);
  });

  it('the synthetic legacy dataset the rehearsals load passes the check', () => {
    const ds = generateLegacyDataset();
    const records: LegacyRecord[] = [
      ...ds.products.map((p, i) => rec(String(i), p as unknown as Record<string, unknown>, 'synthetic.products')),
      ...ds.stock.map((p, i) => rec(String(i), p as unknown as Record<string, unknown>, 'synthetic.stock')),
      ...ds.customers.map((p, i) => rec(String(i), p as unknown as Record<string, unknown>, 'synthetic.customers')),
      ...ds.suppliers.map((p, i) => rec(String(i), p as unknown as Record<string, unknown>, 'synthetic.suppliers')),
      ...ds.documents.map((p, i) => rec(String(i), p as unknown as Record<string, unknown>, 'synthetic.documents')),
      ...ds.lines.map((p, i) => rec(String(i), p as unknown as Record<string, unknown>, 'synthetic.lines')),
    ];
    expect(records.length).toBeGreaterThan(100);
    const r = checkLegacyCardPurge(records);
    expect(r.findings).toEqual([]);
    expect(r.passed).toBe(true);
  });
});
