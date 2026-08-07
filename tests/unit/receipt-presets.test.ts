import { describe, it, expect } from 'vitest';
import {
  buildReceipt,
  renderReceipt,
  paperFormat,
  standardReceiptTemplate,
  PAPER_58,
  PAPER_80,
  PAPER_112,
  PAPER_FORMATS,
  DEFAULT_PAPER_FORMAT,
  BUILTIN_TEMPLATE_SET_ID,
  UnknownPaperFormatError,
  StoreNameRequiredError,
  InvalidGstinError,
  type BuildReceiptInput,
} from '../../packages/receipt/src/index';

// The product ships standard thermal formats (58/80/112 mm) and a neutral header/footer
// template a tenant only supplies its own facts to — branding, not a code fork
// (OC-15 / M31-FR-02 / M36-FR-02).

function input(over: Partial<BuildReceiptInput> = {}): BuildReceiptInput {
  return {
    number: 'S-0001',
    saleId: 'sale-1',
    tradingDay: '2026-08-07',
    committedAt: '2026-08-07T12:00:00Z',
    laneId: 'lane-1',
    cashierId: 'clerk-1',
    currency: 'INR',
    lines: [{ description: 'Rice 1kg', quantityMinor: 1, uom: 'ea', unitPriceMinor: 100_00, lineTotalMinor: 100_00 }],
    taxBands: [],
    netMinor: 100_00,
    taxMinor: 0,
    totalMinor: 100_00,
    tenders: [{ kind: 'cash', amountMinor: 100_00 }],
    header: [],
    footer: [],
    ...over,
  };
}

describe('paper formats', () => {
  it('ships 58, 80 and 112 mm (2/3/4 inch), narrowest first, columns rising with width', () => {
    expect(PAPER_FORMATS).toEqual([PAPER_58, PAPER_80, PAPER_112]);
    expect(PAPER_FORMATS.map((f) => f.widthMm)).toEqual([58, 80, 112]);
    expect(PAPER_FORMATS.map((f) => f.widthChars)).toEqual([32, 48, 64]);
  });

  it('maps each width to its Font-A character columns', () => {
    expect(PAPER_58.widthChars).toBe(32);
    expect(PAPER_80.widthChars).toBe(48);
    expect(PAPER_112.widthChars).toBe(64);
  });

  it('has unique ids and defaults to 80 mm', () => {
    const ids = PAPER_FORMATS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(DEFAULT_PAPER_FORMAT).toBe(PAPER_80);
  });

  it('looks a format up by id, and refuses an unknown id by name', () => {
    expect(paperFormat('thermal-80')).toBe(PAPER_80);
    expect(() => paperFormat('thermal-999')).toThrow(UnknownPaperFormatError);
    expect(() => paperFormat('thermal-999')).toThrow(/thermal-58, thermal-80, thermal-112/);
  });
});

describe('renderReceipt on a paper format', () => {
  it('renders to the format width — the rule line is exactly that many columns', () => {
    const doc = buildReceipt(input());
    for (const format of PAPER_FORMATS) {
      const lines = renderReceipt(doc, format);
      expect(lines.some((l) => l === '-'.repeat(format.widthChars))).toBe(true);
    }
  });

  it('defaults to 80 mm when no format is given', () => {
    const doc = buildReceipt(input());
    expect(renderReceipt(doc).some((l) => l === '-'.repeat(PAPER_80.widthChars))).toBe(true);
  });
});

describe('standardReceiptTemplate', () => {
  it('needs the store name — it prints on every bill', () => {
    expect(() => standardReceiptTemplate({ storeName: '   ' })).toThrow(StoreNameRequiredError);
  });

  it('builds header from the store facts, GSTIN uppercased and labelled', () => {
    const t = standardReceiptTemplate({
      storeName: 'SRE Hyper Market',
      addressLines: ['12 Main Rd', 'Tamil Nadu'],
      phone: '044-1234',
      gstin: '33abcde0000f1z5',
    });
    expect(t.header[0]).toBe('SRE Hyper Market');
    expect(t.header).toContain('12 Main Rd');
    expect(t.header).toContain('Ph: 044-1234');
    expect(t.header).toContain('GSTIN: 33ABCDE0000F1Z5');
  });

  it('omits optional facts rather than printing blank lines', () => {
    const t = standardReceiptTemplate({ storeName: 'Corner Shop' });
    expect(t.header).toEqual(['Corner Shop']);
    expect(t.footer).toEqual(['Thank you — please visit again']);
  });

  it('uses a given thanks line and appends extra footer lines', () => {
    const t = standardReceiptTemplate({
      storeName: 'Corner Shop',
      thanksLine: 'Nandri, vaanga!',
      footerLines: ['No returns without a bill', ''],
    });
    expect(t.footer).toEqual(['Nandri, vaanga!', 'No returns without a bill']);
  });

  it('refuses a GSTIN that is not 15 characters', () => {
    expect(() => standardReceiptTemplate({ storeName: 'Shop', gstin: '33ABC' })).toThrow(InvalidGstinError);
  });

  it('feeds a real receipt — the store name renders at the top', () => {
    const template = standardReceiptTemplate({ storeName: 'SRE Hyper Market', gstin: '33ABCDE0000F1Z5' });
    const doc = buildReceipt(input({ header: template.header, footer: template.footer }));
    const lines = renderReceipt(doc, PAPER_80);
    expect(lines[0]?.trim()).toBe('SRE Hyper Market');
    expect(lines.some((l) => l.includes('GSTIN: 33ABCDE0000F1Z5'))).toBe(true);
    expect(lines.some((l) => l.includes('Thank you'))).toBe(true);
  });

  it('the built-in template set id matches the branding default', () => {
    expect(BUILTIN_TEMPLATE_SET_ID).toBe('builtin:default');
  });
});
