import { describe, it, expect } from 'vitest';
import { presentRequest, createApprovalsSession, type ApprovalRequestView, type ApprovalNames } from '../../apps/web-erp/src/approvals-session';
import { approvalNamesOf } from '../../apps/web-erp/src/browser-entry';
import { priceHistoryRows, priceHistory, type PriceEntry } from '../../packages/price-list/src/price-list';
import { MARKDOWN_COPY } from '../../apps/web-erp/src/markdown-session';

/**
 * Fix batch 6 of THE PLAN (OB-800) — the store manager's and the owner's "Annoys" rows.
 *   • D-014: Approvals reads item and place names, plain labels ("Basis: Share of sales", "Deposit"), and hides internal ids.
 *   • D-022: the price history is one row per thing said — identical entries name all their versions — and the record is kept whole.
 *   • D-025: the markdown form's words for a row it was filled from, in both languages.
 */

const row = (over: Partial<ApprovalRequestView> = {}): ApprovalRequestView => ({
  requestId: 'areq-1', kind: 'stock_write_off', label: 'Write off stock', subjectRef: 'wo-uat06-demo-oil-leak', valueMinor: 114_000,
  details: {}, summary: 'Write off 3 × Sunflower oil 1 L — leak', reason: 'Leaking', requestedBy: 'u-mgr', requestedAt: '2026-11-16T04:00:00.000Z', status: 'waiting', ...over,
});
const NAMES: ApprovalNames = {
  product: (id) => ({ 'prod-oil': 'Sunflower oil 1 L' } as Record<string, string>)[id],
  place: (id) => ({ 'pilot-demo-wh': 'The back store', 'pilot-demo-branch': 'SRE Hyper Market' } as Record<string, string>)[id],
};
const lines = (lang: 'en' | 'ta', r: ApprovalRequestView, names: ApprovalNames = NAMES) =>
  Object.fromEntries(presentRequest(lang, r, true, names).details.map((d) => [d.key, `${d.label}: ${d.value}`]));

describe('D-014: Approvals says what will happen in names and plain words, never codes', () => {
  it('a write-off names the item and the place, says the unit and the evidence, and hides its own ids', () => {
    const r = row({ details: { productId: 'prod-oil', locationId: 'pilot-demo-wh', qty: 3, uom: 'ea', evidenceRef: 'photo-demo-oil-leak-1', writeOffId: 'wo-uat06-demo-oil-leak', movementId: 'mv-1' } });
    expect(lines('en', r)).toEqual({
      productId: 'Item: Sunflower oil 1 L', locationId: 'Where: The back store', qty: 'Quantity: 3', uom: 'Unit: each (pieces)', evidenceRef: 'Evidence: Photo attached',
    });
    const shown = JSON.stringify(presentRequest('en', r, true, NAMES));
    expect(presentRequest('en', r, true, NAMES).about).toBeNull(); // "About: wo-uat06-demo-oil-leak" is gone
    expect(shown).not.toContain('"value":"prod-oil"');
    expect(Object.values(lines('ta', r)).join(' ')).toContain('புகைப்படம் இணைக்கப்பட்டுள்ளது');
  });

  it('a code nobody can name is shown as it is — never a guess, never blank', () => {
    const r = row({ details: { productId: 'prod-unknown', locationId: 'aisle-9' } });
    expect(lines('en', r)).toEqual({ productId: 'Item: prod-unknown', locationId: 'Where: aisle-9' });
  });

  it('a concession contract reads "Basis: Share of sales", "Deposit", "Share of sales" — no field names, no contract id', () => {
    const r = row({ kind: 'concession_contract', label: 'Approve a concession contract', subjectRef: 'cc-91', valueMinor: null,
      details: { contractId: 'cc-91', concessionaireId: 'Lakshmi Bangles', branchId: 'pilot-demo-branch', basis: 'revenue_share', depositMinor: 2_500_000, revenueShareBps: 1200, startsOn: '2026-12-01' } });
    expect(lines('en', r)).toEqual({
      concessionaireId: 'Concessionaire: Lakshmi Bangles', branchId: 'Store: SRE Hyper Market', basis: 'Basis: Share of sales',
      depositMinor: 'Deposit: ₹25,000.00', revenueShareBps: 'Share of sales: 12.00%', startsOn: 'Starts on: 2026-12-01',
    });
    for (const line of Object.values(lines('ta', r))) expect(line).not.toMatch(/minor|bps|revenue_share/i);
  });

  it('a refund\'s reason is in words; words someone wrote as the subject stay', () => {
    expect(lines('en', row({ kind: 'order_refund', details: { basis: 'short_pick' } }))['basis']).toBe('Reason for the refund: Short picked');
    expect(presentRequest('en', row({ subjectRef: 'September price list' }), true, NAMES).about).toBe('September price list');
    expect(presentRequest('en', row({ subjectRef: 'pilot-demo-wh' }), true, NAMES).about).toBe('The back store');
  });

  it('the session reads the names the page loaded, and the page builds them from the box\'s catalogue and directory', () => {
    const r = row({ details: { productId: 'prod-oil', locationId: 'pilot-demo-wh' } });
    const book = approvalNamesOf(new Map([['prod-oil', 'Sunflower oil 1 L']]), { places: [{ id: 'pilot-demo-wh', name: 'The back store' }], store: { id: 'pilot-demo-branch', name: 'SRE Hyper Market' } });
    expect(book.place('pilot-demo-branch')).toBe('SRE Hyper Market');
    expect(approvalNamesOf(new Map(), null).place('x')).toBeUndefined();
    const s = createApprovalsSession({ userId: 'u-owner' }, {
      inbox: () => ({ waitingForMe: [r], mine: [], asAt: null }), mayUse: () => true,
      decide: async () => ({ result: 'lost_link' as const }), names: () => book,
    });
    expect(s.view('en').waiting[0]!.details.map((d) => d.value)).toEqual(['Sunflower oil 1 L', 'The back store']);
  });
});

describe('D-022: the price history says each price once, and keeps every entry', () => {
  const e = (version: number, minor: number, from = '2026-11-01'): PriceEntry => ({
    id: `pe-${version}`, productId: 'prod-biscuit', scope: 'store', scopeRef: 'b1', price: { minor, currency: 'INR' }, effectiveFrom: from, status: 'active', version,
  });
  it('two identical "₹30.00 active" entries are one row naming versions 1, 2; the new ₹32 is its own row', () => {
    const entries = [e(1, 3_000), e(2, 3_000), e(3, 3_200, '2026-11-16')];
    const rows = priceHistoryRows(entries, 'prod-biscuit');
    expect(rows.map((r) => [r.price.minor, r.versions, r.version])).toEqual([[3_000, [1, 2], 2], [3_200, [3], 3]]);
    expect(priceHistory(entries, 'prod-biscuit')).toHaveLength(3); // the record itself is untouched (append-only)
  });
  it('a different date, price, state or batch is never merged', () => {
    const rows = priceHistoryRows([e(1, 3_000), { ...e(2, 3_000), status: 'rolled_back' as PriceEntry['status'] }, { ...e(3, 3_000), batchId: 'B-1' }, e(4, 3_000, '2026-11-02')], 'prod-biscuit');
    expect(rows).toHaveLength(4);
  });
});

describe('D-025: the markdown form says the row it was filled from', () => {
  it('in English and Tamil, with the same slots', () => {
    for (const k of ['pickHint', 'picked', 'pickedNoBatch', 'typeInstead', 'typeChange'] as const) {
      expect(MARKDOWN_COPY.en[k]).toBeTruthy();
      expect(MARKDOWN_COPY.ta[k]).toMatch(/[஀-௿]/);
      const slots = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(slots(MARKDOWN_COPY.ta[k])).toEqual(slots(MARKDOWN_COPY.en[k]));
    }
  });
});
