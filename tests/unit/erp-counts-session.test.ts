import { describe, it, expect } from 'vitest';
import {
  createCountsReviewSession, formatMoney, varianceKind, COUNTS_REVIEW_COPY, COPY_KEYS,
  type CountsReviewPorts, type CountRow,
} from '../../apps/web-erp/src/counts-session';
import { bilingualGaps } from '../../packages/ui/src/index';

/**
 * **Stock-count review — the blind-count variance triage view (M09-FR-04; P-03 control by exception).**
 *
 * The screen shows the day's reconciled blind counts against the system, with the MATERIAL variances — the
 * ones big enough to have needed a second person's approval (§28) — surfaced first, so shrinkage is
 * investigated by exception rather than buried in a total. It is read-gated the same way the server is, and it
 * is read-only (reconciling a count is the audited write path; the expected quantity is computed server-side).
 */

const ROWS: CountRow[] = [
  // matched: counted === expected, no variance, no attention.
  { id: 'c-match', productId: 'MILK', expectedMinor: 12, countedMinor: 12, varianceMinor: 0, valueMinor: 0, uom: 'ea', requiredApproval: false, adjusted: false },
  // material shortage: needed a separate approver.
  { id: 'c-big', productId: 'RICE', expectedMinor: 20, countedMinor: 16, varianceMinor: -4, valueMinor: 240_000, uom: 'ea', requiredApproval: true, adjusted: true, counterId: 'u-floor', approvedBy: 'u-mgr', reasonCode: 'shrinkage' },
  // material overage: found stock, still needed approval.
  { id: 'c-mid', productId: 'OIL', expectedMinor: 8, countedMinor: 11, varianceMinor: 3, valueMinor: 90_000, uom: 'l', requiredApproval: true, adjusted: true, counterId: 'u-floor', approvedBy: 'u-mgr', reasonCode: 'found' },
  // immaterial shortage: a variance was corrected but did not need a second approval.
  { id: 'c-small', productId: 'BREAD', expectedMinor: 30, countedMinor: 28, varianceMinor: -2, valueMinor: 20_000, uom: 'ea', requiredApproval: false, adjusted: true, counterId: 'u-floor' },
];

const ports = (over: Partial<CountsReviewPorts> = {}): CountsReviewPorts => ({
  rows: () => ROWS,
  mayRead: () => true,
  ...over,
});

const session = (over: Partial<CountsReviewPorts> = {}, userId: string | null = 'u-mgr') =>
  createCountsReviewSession({ userId }, ports(over));

describe('varianceKind', () => {
  it('reads the sign of counted − expected: matched / shortage / overage', () => {
    expect(varianceKind(0)).toBe('matched');
    expect(varianceKind(-4)).toBe('shortage');
    expect(varianceKind(3)).toBe('overage');
  });
});

describe('formatMoney', () => {
  it('renders paise as rupees with thousands separators, two decimals', () => {
    expect(formatMoney(240_000)).toBe('₹2,400.00');
    expect(formatMoney(0)).toBe('₹0.00');
    expect(formatMoney(12_345_678)).toBe('₹123,456.78');
  });
});

describe('view', () => {
  it('puts the MATERIAL variances (needed approval) first, then by value; totals the value at variance', () => {
    const v = session().view('en');
    expect(v.total).toBe(4);
    expect(v.attentionCount).toBe(2); // c-big + c-mid
    // The two material ones lead, larger value first; then the rest by value (c-small before the ₹0 match).
    expect(v.rows.map((r) => r.id)).toEqual(['c-big', 'c-mid', 'c-small', 'c-match']);
    expect(v.totalValue).toBe(formatMoney(240_000 + 90_000 + 20_000 + 0));
    // Every status carries a non-empty word + icon (never a bare colour) and a known tone.
    for (const r of v.rows) {
      expect(r.status.label.length).toBeGreaterThan(0);
      expect(r.status.icon.trim().length).toBeGreaterThan(0);
      expect(['ok', 'degraded', 'error', 'idle']).toContain(r.status.tone);
    }
  });

  it('a material variance reads as attention (error tone) and carries value, direction, counted vs system', () => {
    const big = session().view('en').rows.find((r) => r.id === 'c-big');
    expect(big?.needsAttention).toBe(true);
    expect(big?.status.tone).toBe('error');
    expect(big?.neededApproval).toBe(true);
    expect(big?.value).toBe('₹2,400.00');
    expect(big?.variance).toBe('-4 ea');   // shrinkage keeps its sign
    expect(big?.counted).toBe('16 ea');
    expect(big?.expected).toBe('20 ea');
    expect(big?.approvedBy).toBe('u-mgr');
    expect(big?.counterId).toBe('u-floor');
  });

  it('an overage shows its + sign; a match reads ok and is not attention', () => {
    const over = session().view('en').rows.find((r) => r.id === 'c-mid');
    expect(over?.variance).toBe('+3 l');
    const match = session().view('en').rows.find((r) => r.id === 'c-match');
    expect(match?.needsAttention).toBe(false);
    expect(match?.status.tone).toBe('ok');
    expect(match?.variance).toBe('0 ea');
    expect(match?.value).toBe('₹0.00');
  });

  it('an immaterial variance is corrected but not attention (degraded, not error)', () => {
    const small = session().view('en').rows.find((r) => r.id === 'c-small');
    expect(small?.needsAttention).toBe(false);
    expect(small?.status.tone).toBe('degraded');
  });

  it('refuses the whole list when the user may not read it — no counts leak', () => {
    const v = session({ mayRead: () => false }).view('en');
    expect(v.rows).toEqual([]);
    expect(v.total).toBe(0);
    expect(v.screenState.tone).toBe('error');
  });

  it('shows an empty state (not an error) when no count has been reconciled', () => {
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

  it('renders in Tamil too — the variance label changes with the language', () => {
    const en = session().view('en').rows.find((r) => r.id === 'c-big')?.status.label;
    const ta = session().view('ta').rows.find((r) => r.id === 'c-big')?.status.label;
    expect(en).toBeTruthy();
    expect(ta).toBeTruthy();
    expect(ta).not.toBe(en);
  });
});

describe('the copy is complete in both languages', () => {
  it('has an English AND a Tamil word for every key the screen uses (packages/ui bilingualGaps)', () => {
    const gaps = bilingualGaps(COUNTS_REVIEW_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });
});
