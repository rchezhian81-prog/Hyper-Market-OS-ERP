import { describe, it, expect } from 'vitest';
import {
  DATA_QUALITY_INBOX_COPY, COPY_KEYS, createDataQualityInboxSession,
  type DataQualityInboxPorts, type DataQualityWorklistData, type DataQualityWorklistEntry,
} from '../../apps/web-erp/src/data-quality-inbox-session';
import { bilingualGaps } from '../../packages/ui/src/index';
import type { DataQualityFinding } from '../../packages/product/src/index';

// The Data Quality inbox screen (A08 · API-13 · P-05). It shows the OPEN suggestions to look at and the
// DISMISSED ones a steward set aside; open ones read as attention, dismissed ones do not; it is bilingual and
// never a bare colour; and it honours governance — when the agent is off there is a plain-English note, never
// an empty screen a person reads as "all clear". Read-only: nothing here changes a product.

const finding = (over: Partial<DataQualityFinding> & Pick<DataQualityFinding, 'findingId' | 'kind'>): DataQualityFinding => ({
  productIds: ['p1'],
  confidence: 'certain',
  headline: 'a gap',
  detail: 'why it matters',
  evidence: [{ productId: 'p1', sku: 'SKU-1', name: 'Tata Salt 1kg', note: 'no barcode' }],
  ...over,
});
const openEntry = (id: string): DataQualityWorklistEntry => ({ finding: finding({ findingId: id, kind: 'missing_barcode' }), status: 'open' });
const dismissedEntry = (id: string): DataQualityWorklistEntry => ({
  finding: finding({ findingId: id, kind: 'suspected_duplicate', headline: 'looks like a duplicate' }),
  status: 'dismissed',
  dismissal: { by: 'u-steward', at: '2026-09-13T00:00:00Z', reason: 'genuinely different pack sizes' },
});

const worklist = (over: Partial<DataQualityWorklistData> = {}): DataQualityWorklistData =>
  ({ agentActive: true, open: [], dismissed: [], ...over });
const session = (w: DataQualityWorklistData, ports: Partial<DataQualityInboxPorts> = {}, userId: string | null = 'u-owner') =>
  createDataQualityInboxSession({ userId }, { worklist: () => w, mayRead: () => true, ...ports });

describe('the data quality inbox copy is complete in both languages', () => {
  it('has no gap in either language across the whole vocabulary', () => {
    const gaps = bilingualGaps(DATA_QUALITY_INBOX_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });

  it('tripwire — the detector fires on a key genuinely absent', () => {
    const holey = { en: { ...DATA_QUALITY_INBOX_COPY.en }, ta: { ...DATA_QUALITY_INBOX_COPY.ta, scrReady: '' } };
    expect(bilingualGaps(holey, COPY_KEYS).ta).toContain('scrReady');
  });
});

describe('open suggestions read as attention; dismissed ones do not', () => {
  it('an open finding is attention (degraded) and cites the real product; a dismissed one is idle with its reason', () => {
    const view = session(worklist({ open: [openEntry('dq-missing-barcode:p1')], dismissed: [dismissedEntry('dq-duplicate:p1:p2')] })).view('en');
    expect(view.openCount).toBe(1);
    expect(view.dismissedCount).toBe(1);

    const open = view.open[0]!;
    expect(open.needsAttention).toBe(true);
    expect(open.status.tone).toBe('degraded');
    expect(open.affects).toContain('Tata Salt 1kg (SKU-1)');

    const dismissed = view.dismissed[0]!;
    expect(dismissed.needsAttention).toBe(false);
    expect(dismissed.status.tone).toBe('idle');
    expect(dismissed.dismissedBy).toBe('u-steward');
    expect(dismissed.dismissedReason).toBe('genuinely different pack sizes');
  });

  it('every rendered status carries a word and an icon — never colour alone', () => {
    const view = session(worklist({ open: [openEntry('a')], dismissed: [dismissedEntry('b')] })).view('en');
    for (const row of [...view.open, ...view.dismissed]) {
      expect(row.status.label.length).toBeGreaterThan(0);
      expect(row.status.icon.trim().length).toBeGreaterThan(0);
    }
  });

  it('a clean worklist reads as empty (ready state), not an error', () => {
    const view = session(worklist()).view('en');
    expect(view.openCount).toBe(0);
    expect(view.dismissed).toEqual([]);
    expect(view.screenState.tone).not.toBe('error');
  });
});

describe('governance and permission', () => {
  it('when the agent is not active, shows a plain-English note and no rows — never a bare "all clear"', () => {
    const view = session(worklist({ agentActive: false, note: 'The kill switch is on.' })).view('en');
    expect(view.agentActive).toBe(false);
    expect(view.open).toEqual([]);
    expect(view.screenState.label).toBe('The kill switch is on.');
    expect(view.screenState.tone).not.toBe('error'); // off is not a fault
  });

  it('refuses to show anything without read permission', () => {
    const view = session(worklist({ open: [openEntry('a')] }), { mayRead: () => false }).view('en');
    expect(view.screenState.tone).toBe('error');
    expect(view.open).toEqual([]);
  });

  it('flags nobody-named when the box was not told who is looking', () => {
    const view = session(worklist(), {}, null).view('en');
    expect(view.nobodyNamed).toBe(true);
  });
});
