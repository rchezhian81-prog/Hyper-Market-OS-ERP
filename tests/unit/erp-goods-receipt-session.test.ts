import { describe, it, expect } from 'vitest';
import {
  GOODS_RECEIPT_COPY, COPY_KEYS, createGoodsReceiptSession,
  type GoodsReceiptPorts, type GoodsReceiptData, type GrnRecordView, type GrnDiscrepancyView,
} from '../../apps/web-erp/src/goods-receipt-session';
import { bilingualGaps } from '../../packages/ui/src/index';

// The goods-receipt REVIEW screen (M07-FR-02/03 · API-04 · P-03 control-by-exception · P-08 no silent failure).
// A read-only manager view over the durable GRN records: deliveries needing a second person first (§28), then
// the ones with a valued difference from the order (worst money first), then the clean ones. Nothing here writes.

const session = (
  data: GoodsReceiptData,
  ports: Partial<GoodsReceiptPorts> = {},
  userId: string | null = 'u-mgr',
) =>
  createGoodsReceiptSession({ userId }, {
    snapshot: () => data,
    mayRead: () => true,
    ...ports,
  });

const disc = (over: Partial<GrnDiscrepancyView> = {}): GrnDiscrepancyView => ({
  kind: 'short', productId: 'p1', quantityMinor: 10_00, valueMinor: 50_00, currency: 'INR',
  requiresApproval: false, detail: 'less arrived than ordered', ...over,
});

const grn = (over: Partial<GrnRecordView> = {}): GrnRecordView => ({
  grnId: 'grn-1', number: 'GRN-001', poId: 'po-1', warehouseId: 'W1',
  receivedBy: 'u-recv', receivedAt: '2026-09-19T08:00:00.000Z',
  requiresApproval: false, discrepancyValueMinor: 0, currency: 'INR',
  sellableMinor: 100_00, quarantinedMinor: 0, rejectedMinor: 0, discrepancies: [],
  ...over,
});

describe('the goods-receipt copy is complete in both languages', () => {
  it('has no gap in either language across the whole vocabulary', () => {
    const gaps = bilingualGaps(GOODS_RECEIPT_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });

  it('tripwire — the detector fires on a key genuinely absent', () => {
    const holey = { en: { ...GOODS_RECEIPT_COPY.en }, ta: { ...GOODS_RECEIPT_COPY.ta, scrReady: '' } };
    expect(bilingualGaps(holey, COPY_KEYS).ta).toContain('scrReady');
  });
});

describe('the screen refuses to show anything without the read permission', () => {
  it('a reader without inventory.availability.read sees a not-permitted state and no deliveries', () => {
    const view = session({ receipts: [grn()] }, { mayRead: () => false }).view('en');
    expect(view.screenState.tone).toBe('error');
    expect(view.screenState.label.length).toBeGreaterThan(0);
    expect(view.receipts).toEqual([]);
    expect(view.count).toBe(0);
    expect(view.asOf).toBeNull();
  });
});

describe('two empty states, told apart (P-08)', () => {
  it('with no list given at all, the state is empty — a data gap, not "no deliveries"', () => {
    const view = session({}).view('en');
    expect(view.screenState.tone).not.toBe('error');
    expect(view.receipts).toEqual([]);
    expect(view.screenState.label).toBe(GOODS_RECEIPT_COPY.en.scrEmpty);
  });

  it('with an empty list, it says no deliveries have been recorded (and keeps the as-of)', () => {
    const view = session({ receipts: [], asAt: '2026-09-19T09:00:00.000Z' }).view('en');
    expect(view.receipts).toEqual([]);
    expect(view.screenState.label).toBe(GOODS_RECEIPT_COPY.en.scrNoReceipts);
    expect(view.asOf).toBe('2026-09-19T09:00:00.000Z');
  });
});

describe('exceptions come first (P-03), and read as attention never colour alone', () => {
  it('needs-approval first, then by value of the difference, then clean last', () => {
    const needsApproval = grn({ grnId: 'a', number: 'A', requiresApproval: true, discrepancyValueMinor: 10_00, discrepancies: [disc({ kind: 'excess', requiresApproval: true, valueMinor: 10_00 })] });
    const bigDiff = grn({ grnId: 'b', number: 'B', discrepancyValueMinor: 500_00, discrepancies: [disc({ valueMinor: 500_00 })] });
    const clean = grn({ grnId: 'c', number: 'C' });
    const view = session({ receipts: [clean, bigDiff, needsApproval] }).view('en');
    expect(view.receipts.map((r) => r.number)).toEqual(['A', 'B', 'C']);
  });

  it('a delivery needing a second person is an error tone with an icon and a word, flagged attention', () => {
    const view = session({ receipts: [grn({ requiresApproval: true, discrepancyValueMinor: 20_00, discrepancies: [disc({ kind: 'damaged', requiresApproval: true, valueMinor: 20_00 })] })] }).view('en');
    const r = view.receipts[0]!;
    expect(r.needsApproval).toBe(true);
    expect(r.status.tone).toBe('error');
    expect(r.status.needsAttention).toBe(true);
    expect(r.status.label.length).toBeGreaterThan(0);
    expect(r.status.icon.trim().length).toBeGreaterThan(0);
  });

  it('a delivery with a difference but no approval reads as degraded attention', () => {
    const view = session({ receipts: [grn({ discrepancyValueMinor: 50_00, discrepancies: [disc({ valueMinor: 50_00 })] })] }).view('en');
    const r = view.receipts[0]!;
    expect(r.needsApproval).toBe(false);
    expect(r.status.tone).toBe('degraded');
    expect(r.status.needsAttention).toBe(true);
    expect(r.status.icon.trim().length).toBeGreaterThan(0);
  });

  it('a clean delivery reads as a settled OK — an icon and a word, not attention', () => {
    const view = session({ receipts: [grn()] }).view('en');
    const r = view.receipts[0]!;
    expect(r.status.tone).toBe('ok');
    expect(r.status.needsAttention).toBe(false);
    expect(r.discrepancies).toEqual([]);
    expect(r.status.icon.trim().length).toBeGreaterThan(0);
  });
});

describe('every difference is valued and named (P-08)', () => {
  it('within a delivery the discrepancies are worst-money-first, each with a word and the server detail', () => {
    const view = session({
      receipts: [grn({
        discrepancyValueMinor: 100_00,
        discrepancies: [
          disc({ kind: 'short', valueMinor: 20_00, detail: 'ten short' }),
          disc({ kind: 'mrp_mismatch', valueMinor: 80_00, detail: 'printed 145, master 150' }),
        ],
      })],
    }).view('en');
    const ds = view.receipts[0]!.discrepancies;
    expect(ds.map((d) => d.valueMinor)).toEqual([80_00, 20_00]);
    expect(ds[0]!.kind).toBe('mrp_mismatch');
    expect(ds[0]!.label.length).toBeGreaterThan(0);
    expect(ds[0]!.detail).toBe('printed 145, master 150');
    // The kind word differs per kind (not a single generic string).
    expect(ds[0]!.label).not.toBe(ds[1]!.label);
  });

  it('carries the sellable / quarantined / refused split and the difference value through as-is', () => {
    const view = session({ receipts: [grn({ sellableMinor: 90_00, quarantinedMinor: 5_00, rejectedMinor: 5_00, discrepancyValueMinor: 250_00 })] }).view('en');
    const r = view.receipts[0]!;
    expect(r.sellableMinor).toBe(90_00);
    expect(r.quarantinedMinor).toBe(5_00);
    expect(r.rejectedMinor).toBe(5_00);
    expect(r.discrepancyValueMinor).toBe(250_00);
  });
});

describe('the summary and freshness are facts on the page', () => {
  it('counts the deliveries and how many need a second person', () => {
    const view = session({
      receipts: [
        grn({ grnId: '1', requiresApproval: true, discrepancies: [disc({ requiresApproval: true })] }),
        grn({ grnId: '2', requiresApproval: true, discrepancies: [disc({ requiresApproval: true })] }),
        grn({ grnId: '3' }),
      ],
    }).view('en');
    expect(view.count).toBe(3);
    expect(view.needingApprovalCount).toBe(2);
  });

  it('the overall "as of" is the timestamp the list was read', () => {
    const view = session({ receipts: [grn()], asAt: '2026-09-19T08:30:00.000Z' }).view('en');
    expect(view.asOf).toBe('2026-09-19T08:30:00.000Z');
  });
});
