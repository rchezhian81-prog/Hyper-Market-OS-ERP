import { describe, it, expect } from 'vitest';
import {
  createWasteReviewSession, formatMoney, WASTE_REVIEW_COPY, COPY_KEYS,
  type WasteReviewPorts, type WriteOffRow,
} from '../../apps/web-erp/src/waste-review-session';
import { bilingualGaps } from '../../packages/ui/src/index';

/**
 * **Waste & write-off review — the shrinkage triage view (M28-FR-01; P-03 control by exception).**
 *
 * The screen shows the day's losses by type and value, with the MATERIAL ones — the losses big enough to have
 * needed a second person's approval (§28) — surfaced first, so shrinkage is seen by exception rather than
 * buried in a total. It is read-gated the same way the server is, and it is read-only (recording a write-off
 * is the audited write path, never done here).
 */

const ROWS: WriteOffRow[] = [
  { id: 'wo-small', productId: 'MILK', lossType: 'expiry', qtyRemoved: 6, uom: 'ea', valueMinor: 30_000, requiredApproval: false },
  { id: 'wo-big', productId: 'RICE', lossType: 'damage', qtyRemoved: 4, uom: 'ea', valueMinor: 240_000, requiredApproval: true, evidenceRef: 'photo-1', raisedBy: 'u-floor' },
  { id: 'wo-mid', productId: 'OIL', lossType: 'wastage', qtyRemoved: 2, uom: 'l', valueMinor: 90_000, requiredApproval: true, evidenceRef: 'photo-2' },
  { id: 'wo-give', productId: 'BREAD', lossType: 'donation', qtyRemoved: 10, uom: 'ea', valueMinor: 20_000, requiredApproval: false },
];

const ports = (over: Partial<WasteReviewPorts> = {}): WasteReviewPorts => ({
  rows: () => ROWS,
  mayRead: () => true,
  ...over,
});

const session = (over: Partial<WasteReviewPorts> = {}, userId: string | null = 'u-mgr') =>
  createWasteReviewSession({ userId }, ports(over));

describe('formatMoney', () => {
  it('renders paise as rupees with thousands separators, two decimals', () => {
    expect(formatMoney(240_000)).toBe('₹2,400.00');
    expect(formatMoney(30_000)).toBe('₹300.00');
    expect(formatMoney(0)).toBe('₹0.00');
    expect(formatMoney(12_345_678)).toBe('₹123,456.78'); // large value, thousands-grouped
  });
});

describe('view', () => {
  it('puts the MATERIAL losses (needed approval) first, then by value; totals the day', () => {
    const v = session().view('en');
    expect(v.total).toBe(4);
    expect(v.attentionCount).toBe(2); // wo-big + wo-mid
    // The two material ones lead, larger value first; then the rest by value.
    expect(v.rows.map((r) => r.id)).toEqual(['wo-big', 'wo-mid', 'wo-small', 'wo-give']);
    expect(v.totalValue).toBe(formatMoney(30_000 + 240_000 + 90_000 + 20_000));
    // Every status carries a non-empty word + icon (never a bare colour) and a known tone.
    for (const r of v.rows) {
      expect(r.status.label.length).toBeGreaterThan(0);
      expect(r.status.icon.trim().length).toBeGreaterThan(0);
      expect(['ok', 'degraded', 'error', 'idle']).toContain(r.status.tone);
    }
  });

  it('a material loss reads as attention (error tone) and carries its value + evidence flag', () => {
    const big = session().view('en').rows.find((r) => r.id === 'wo-big');
    expect(big?.needsAttention).toBe(true);
    expect(big?.status.tone).toBe('error');
    expect(big?.neededApproval).toBe(true);
    expect(big?.value).toBe('₹2,400.00');
    expect(big?.hasEvidence).toBe(true);
    expect(big?.raisedBy).toBe('u-floor');
  });

  it('an immaterial loss is not attention, and a deliberate disposal (donation) reads idle, not an alarm', () => {
    const small = session().view('en').rows.find((r) => r.id === 'wo-small');
    expect(small?.needsAttention).toBe(false);
    const give = session().view('en').rows.find((r) => r.id === 'wo-give');
    expect(give?.needsAttention).toBe(false);
    expect(give?.status.tone).toBe('idle'); // a donation is deliberate, not a loss to alarm on
  });

  it('flags no-evidence honestly on a loss that has none', () => {
    const small = session().view('en').rows.find((r) => r.id === 'wo-small');
    expect(small?.hasEvidence).toBe(false);
  });

  it('refuses the whole list when the user may not read it — no losses leak', () => {
    const v = session({ mayRead: () => false }).view('en');
    expect(v.rows).toEqual([]);
    expect(v.total).toBe(0);
    expect(v.screenState.tone).toBe('error');
  });

  it('shows an empty state (not an error) when no loss has been recorded', () => {
    const v = session({ rows: () => [] }).view('en');
    expect(v.total).toBe(0);
    expect(v.attentionCount).toBe(0);
    expect(v.screenState.tone).toBe('idle');
    expect(v.totalValue).toBe('₹0.00');
  });

  it('flags nobody-named when the box was not told who is looking', () => {
    expect(session({}, null).view('en').nobodyNamed).toBe(true);
    expect(session({}, 'u-mgr').view('en').nobodyNamed).toBe(false);
  });

  it('renders in Tamil too — the loss-type label changes with the language', () => {
    const en = session().view('en').rows.find((r) => r.id === 'wo-big')?.status.label;
    const ta = session().view('ta').rows.find((r) => r.id === 'wo-big')?.status.label;
    expect(en).toBeTruthy();
    expect(ta).toBeTruthy();
    expect(ta).not.toBe(en);
  });
});

describe('the copy is complete in both languages', () => {
  it('has an English AND a Tamil word for every key the screen uses (packages/ui bilingualGaps)', () => {
    const gaps = bilingualGaps(WASTE_REVIEW_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });
});
