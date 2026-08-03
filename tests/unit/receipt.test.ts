import { describe, it, expect } from 'vitest';
import {
  buildReceipt,
  renderText,
  encodeEscPos,
  printReceipt,
  CardDataOnReceiptError,
  ReceiptTotalsError,
  ReprintReasonRequiredError,
  type BuildReceiptInput,
  type PrinterPort,
} from '../../packages/receipt/src/index';

// A receipt is built from the committed sale, balances exactly, never carries a card
// number, marks a reprint, and prints offline — a printer failure never costs the
// sale (M31-FR-02 / M12-FR-02 / hard rules #1 and #3).

function input(over: Partial<BuildReceiptInput> = {}): BuildReceiptInput {
  return {
    number: 'S-0001',
    saleId: 'sale-1',
    tradingDay: '2026-08-02',
    committedAt: '2026-08-02T12:00:00Z',
    laneId: 'lane-1',
    cashierId: 'clerk-1',
    currency: 'INR',
    lines: [
      { description: 'Rice 1kg', quantityMinor: 2, uom: 'ea', unitPriceMinor: 100_00, lineTotalMinor: 200_00 },
      { description: 'Tomato', quantityMinor: 1234, uom: 'kg', unitPriceMinor: 80_00, lineTotalMinor: 98_72 },
    ],
    taxBands: [{ rateBps: 1800, netMinor: 298_72, taxMinor: 53_77 }],
    netMinor: 298_72,
    taxMinor: 53_77,
    totalMinor: 352_49,
    tenders: [{ kind: 'cash', amountMinor: 400_00 }],
    changeMinor: 47_51,
    header: ['SRE HYPER MARKET', 'GSTIN 33XXXXX0000X1Z5'],
    footer: ['Thank you — வருக!'],
    ...over,
  };
}

describe('buildReceipt', () => {
  it('builds a receipt from a committed sale', () => {
    const doc = buildReceipt(input());
    expect(doc.number).toBe('S-0001');
    expect(doc.isReprint).toBe(false);
  });

  it('refuses a card-number-like reference (hard rule #3)', () => {
    expect(() =>
      buildReceipt(input({ tenders: [{ kind: 'card', amountMinor: 352_49, reference: '4111111111111111' }] })),
    ).toThrow(CardDataOnReceiptError);
    expect(() =>
      buildReceipt(input({ tenders: [{ kind: 'card', amountMinor: 352_49, reference: '4111-1111-1111-1111' }] })),
    ).toThrow(CardDataOnReceiptError);
  });

  it('accepts a provider reference token', () => {
    const doc = buildReceipt(
      input({ tenders: [{ kind: 'upi', amountMinor: 352_49, reference: 'TXN-9F3A' }] }),
    );
    expect(doc.tenders[0]?.reference).toBe('TXN-9F3A');
  });

  it('refuses totals that do not balance', () => {
    expect(() => buildReceipt(input({ totalMinor: 999_00 }))).toThrow(ReceiptTotalsError);
    expect(() => buildReceipt(input({ taxBands: [{ rateBps: 1800, netMinor: 298_72, taxMinor: 1_00 }] }))).toThrow(
      ReceiptTotalsError,
    );
  });

  it('refuses a reprint with no reason', () => {
    expect(() =>
      buildReceipt(input({ reprintOf: { reason: '  ', by: 'clerk-1', at: '2026-08-02T13:00:00Z' } })),
    ).toThrow(ReprintReasonRequiredError);
  });
});

describe('renderText', () => {
  it('prints the bill with exact amounts and a balancing total', () => {
    const text = renderText(buildReceipt(input()), 42).join('\n');
    expect(text).toContain('SRE HYPER MARKET');
    expect(text).toContain('Bill: S-0001');
    expect(text).toContain('Rice 1kg');
    expect(text).toMatch(/Subtotal\s+298\.72/);
    expect(text).toMatch(/GST 18%\s+53\.77/);
    expect(text).toMatch(/TOTAL\s+352\.49/);
    expect(text).toMatch(/Change\s+47\.51/);
  });

  it('prints a weighed line with its true weight and unit price', () => {
    const text = renderText(buildReceipt(input()), 42).join('\n');
    expect(text).toContain('1.234 kg x 80.00');
    expect(text).toMatch(/98\.72/);
  });

  it('marks a reprint unmistakably, with its reason', () => {
    const doc = buildReceipt(
      input({ reprintOf: { reason: 'customer lost original', by: 'mgr-1', at: '2026-08-02T13:00:00Z' } }),
    );
    const text = renderText(doc, 42).join('\n');
    expect(text).toContain('*** REPRINT ***');
    expect(text).toContain('customer lost original');
  });

  it('fits the paper width and wraps a long description instead of truncating', () => {
    const doc = buildReceipt(
      input({
        lines: [
          {
            description: 'Extra long product name that will not fit on one line of paper',
            quantityMinor: 1,
            uom: 'ea',
            unitPriceMinor: 298_72,
            lineTotalMinor: 298_72,
          },
        ],
      }),
    );
    const lines = renderText(doc, 32);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(32);
    expect(lines.join('\n')).toContain('not fit on one line'); // wrapped, not lost
  });
});

describe('encodeEscPos', () => {
  it('initialises, prints each line, feeds and cuts', () => {
    const bytes = encodeEscPos(['HELLO'], { feedLines: 2 });
    expect(Array.from(bytes.slice(0, 2))).toEqual([0x1b, 0x40]); // ESC @ init
    expect(Array.from(bytes.slice(2, 7))).toEqual([72, 69, 76, 76, 79]); // "HELLO"
    expect(Array.from(bytes.slice(-4))).toEqual([0x1d, 0x56, 0x42, 0x00]); // partial cut
  });

  it('kicks the drawer only when asked', () => {
    const withDrawer = Array.from(encodeEscPos(['X'], { openDrawer: true }));
    expect(withDrawer.slice(-5, -3)).toEqual([0x1b, 0x70]); // ESC p
    expect(Array.from(encodeEscPos(['X']))).not.toContain(0x70);
  });

  it('never emits garbled bytes for non-ASCII text', () => {
    const bytes = Array.from(encodeEscPos(['வருக']));
    // Printed as '?' rather than mojibake — visible, not silently wrong.
    expect(bytes.filter((b) => b === 0x3f).length).toBeGreaterThan(0);
    expect(bytes.every((b) => b <= 0xff)).toBe(true);
  });
});

describe('printReceipt', () => {
  it('reports success when the printer accepts the bytes', async () => {
    const written: Uint8Array[] = [];
    const printer: PrinterPort = { write: (b) => { written.push(b); return Promise.resolve(); } };
    const outcome = await printReceipt(printer, renderText(buildReceipt(input())));
    expect(outcome).toEqual({ status: 'printed' });
    expect(written).toHaveLength(1);
  });

  it('returns a printer failure instead of throwing — the sale stays committed', async () => {
    const printer: PrinterPort = { write: () => Promise.reject(new Error('printer offline')) };
    const outcome = await printReceipt(printer, ['X']);
    expect(outcome).toEqual({ status: 'failed', reason: 'printer offline' });
  });
});
