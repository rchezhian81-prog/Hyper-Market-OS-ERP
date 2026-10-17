import { describe, it, expect } from 'vitest';
import { checkLegacyCardPurge, containsGroupedCardNumber, type LegacyRecord } from '../../packages/tender/src/legacy-card-purge';
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

// L4 (verifier lane 2): card numbers written with separators other than a space or a dash. Synthetic test numbers only.
describe('the legacy-card-purge check finds a card number with ANY separator, and stays quiet on dates and phones (C10, L4)', () => {
  const TEST_MC = ['5555', '5555', '5555', '4444'].join('');
  const TEST_VISA19 = ['4111', '1111', '1111', '1111', '003'].join('');
  const group = (digits: string, sizes: readonly number[], sep: string): string => {
    const out: string[] = []; let at = 0;
    for (const n of sizes) { out.push(digits.slice(at, at + n)); at += n; }
    return out.join(sep);
  };
  const SEPARATORS = ['.', '/', '_', '\\', '|', ':', '·', '  ', ' . ', ' / ', '+', '~', '*', '=', '-', ' '];

  it('the verifier\'s three cases now FAIL the check', () => {
    for (const v of ['4111.1111.1111.1111', '4111/1111/1111/1111', '4111_1111_1111_1111']) {
      const r = checkLegacyCardPurge([rec('1', { remarks: v })]);
      expect(r.passed, v).toBe(false);
      expect(r.findings.map((f) => f.kind)).toEqual(['card_number_value']);
      expect(JSON.stringify(r)).not.toContain(v);
    }
  });

  it('finds Visa, Mastercard, a 19-digit card and Amex in their printed groups with every separator, inside text too', () => {
    for (const sep of SEPARATORS) {
      for (const [digits, sizes] of [[TEST_VISA, [4, 4, 4, 4]], [TEST_MC, [4, 4, 4, 4]], [TEST_VISA19, [4, 4, 4, 4, 3]], [TEST_AMEX, [4, 6, 5]]] as const) {
        const v = group(digits, sizes, sep);
        expect(containsGroupedCardNumber(`paid by card ${v} at counter 2`), JSON.stringify(v)).toBe(true);
        expect(checkLegacyCardPurge([rec('x', { remarks: `ref:${v}` })]).passed, JSON.stringify(v)).toBe(false);
      }
    }
  });

  it('finds a grouped number followed by its expiry or preceded by other text in the same run', () => {
    expect(containsGroupedCardNumber(`${group(TEST_VISA, [4, 4, 4, 4], '.')}/12-29`)).toBe(true);
    expect(containsGroupedCardNumber(`B-1001/${group(TEST_VISA, [4, 4, 4, 4], '/')}`)).toBe(true);
    expect(containsGroupedCardNumber(`2026.${group(TEST_VISA, [4, 4, 4, 4], '.')}`)).toBe(true);
  });

  it('does not read a non-card grouping, a mixed separator or a failed Luhn as a card', () => {
    expect(containsGroupedCardNumber(group(TEST_VISA, [2, 6, 4, 4], '.'))).toBe(false); // not a printed card grouping
    expect(containsGroupedCardNumber('4111.1111/1111_1111')).toBe(false); // separators differ
    expect(containsGroupedCardNumber('4111.1111.1111.1112')).toBe(false); // fails Luhn
    expect(containsGroupedCardNumber('4111,1111,1111,1111')).toBe(false); // a list of four numbers, not a card
  });

  it('PASSES dates in every common format and separator, over ten years (no false positive)', () => {
    const p2 = (n: number) => String(n).padStart(2, '0');
    let samples = 0;
    for (let t = Date.parse('2020-01-01T00:00:00Z'); t < Date.parse('2030-01-01T00:00:00Z'); t += 86_400_000 * 3 + 3_601_000) {
      const d = new Date(t);
      const [Y, M, D, h, m, s] = [d.getUTCFullYear(), p2(d.getUTCMonth() + 1), p2(d.getUTCDate()), p2(d.getUTCHours()), p2(d.getUTCMinutes()), p2(d.getUTCSeconds())];
      for (const sep of SEPARATORS) {
        const forms = [
          [D, M, Y].join(sep), [Y, M, D].join(sep), [M, D, Y].join(sep), `${[D, M, Y].join(sep)} ${h}:${m}:${s}`,
          `${[Y, M, D].join(sep)}${sep}${h}${sep}${m}${sep}${s}`, `${[D, M, String(Y).slice(2)].join(sep)}`,
          `${[D, M, Y].join(sep)} to ${[D, M, Y + 1].join(sep)}`,
        ];
        for (const f of forms) {
          samples += 1;
          expect(containsGroupedCardNumber(f), f).toBe(false);
          expect(checkLegacyCardPurge([rec('d', { billDate: f, remarks: `delivered ${f}` })]).passed, f).toBe(true);
        }
      }
    }
    expect(samples).toBeGreaterThan(10_000);
  }, 60_000); // exhaustive (10,000+ samples): ~3.5 s locally, longer on a shared CI runner

  it('PASSES Indian mobile and landline numbers in every common format and separator (no false positive)', () => {
    let seed = 7;
    const next = () => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed; };
    let samples = 0;
    for (let i = 0; i < 400; i += 1) {
      const mobile = `${6 + (next() % 4)}${String(next() % 1_000_000_000).padStart(9, '0')}`;
      const std = `0${String(40 + (next() % 60))}`;
      const local = String(next() % 100_000_000).padStart(8, '0');
      for (const sep of SEPARATORS) {
        const forms = [
          mobile, `+91${sep}${mobile}`, `91${sep}${mobile}`, `0${mobile}`,
          [mobile.slice(0, 5), mobile.slice(5)].join(sep), `+91${sep}${[mobile.slice(0, 5), mobile.slice(5)].join(sep)}`,
          [mobile.slice(0, 3), mobile.slice(3, 6), mobile.slice(6)].join(sep), `+91${sep}${[mobile.slice(0, 3), mobile.slice(3, 6), mobile.slice(6)].join(sep)}`,
          [mobile.slice(0, 4), mobile.slice(4, 7), mobile.slice(7)].join(sep),
          [std, local.slice(0, 4), local.slice(4)].join(sep), `+91${sep}${std.slice(1)}${sep}${local}`, [std, local].join(sep),
          `${mobile.slice(0, 5)}${sep}${mobile.slice(5)} / ${[std, local].join(sep)}`,
        ];
        for (const f of forms) {
          samples += 1;
          expect(containsGroupedCardNumber(f), f).toBe(false);
          expect(checkLegacyCardPurge([rec('p', { phone: f, remarks: `call ${f}` })]).passed, f).toBe(true);
        }
      }
    }
    expect(samples).toBeGreaterThan(50_000);
  }, 60_000); // exhaustive (50,000+ samples)
});
