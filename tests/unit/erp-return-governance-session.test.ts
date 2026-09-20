import { describe, it, expect } from 'vitest';
import {
  createReturnGovernanceSession, RETURN_GOVERNANCE_COPY, COPY_KEYS,
  type ReturnGovernancePorts, type ReturnGovernanceData, type FlaggedReturnView,
} from '../../apps/web-erp/src/return-governance-session';
import { bilingualGaps } from '../../packages/ui/src/index';
import type { RefundGovernanceFinding } from '../../packages/returns/src/assess-return';

// The return-governance exceptions review screen's DOM-free session model (M13-FR-01/03 · M17 · §28 · P-03
// · P-08 · hard rule #10). A read-only control-by-exception surface: a refund that reconciled with a breach
// is shown so it is SEEN, never a row nobody reads. Every governance flag carries a bilingual human label;
// every exception reads as attention with an icon and a word, never colour alone.

const ALL_FLAGS: readonly RefundGovernanceFinding[] = [
  'given_without_approval', 'approved_by_the_processor', 'approver_lacks_authority',
  'over_returned_goods', 'refund_exceeds_paid', 'store_credit_over_cap', 'store_credit_no_customer',
];

const flagged = (over: Partial<FlaggedReturnView> & Pick<FlaggedReturnView, 'returnId'>): FlaggedReturnView => ({
  originalSaleId: 'S1', laneId: 'lane-1', processedBy: 'u-lanecash', approvedBy: 'u-mgr',
  customerRef: 'c-asha', reasonCode: 'customer_changed_mind', refundMinor: 5000, refundTender: 'store_credit',
  processedAt: '2026-09-18T10:00:00Z', governanceFlags: ['store_credit_over_cap'], ...over,
});

const data = (exceptions: readonly FlaggedReturnView[]): ReturnGovernanceData => ({
  exceptionCount: exceptions.length,
  totalRefundMinor: exceptions.reduce((s, e) => s + e.refundMinor, 0),
  exceptions,
});

const session = (over: Partial<ReturnGovernancePorts> = {}, userId: string | null = 'u-owner') =>
  createReturnGovernanceSession({ userId }, {
    exceptions: () => data([flagged({ returnId: 'RT-1' })]),
    mayRead: () => true,
    ...over,
  });

describe('return-governance copy is complete in both languages', () => {
  it('has no gap in either language across the whole vocabulary', () => {
    const gaps = bilingualGaps(RETURN_GOVERNANCE_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });

  it('tripwire — the detector fires on a key that is genuinely absent', () => {
    const holey = { en: { ...RETURN_GOVERNANCE_COPY.en }, ta: { ...RETURN_GOVERNANCE_COPY.ta, scrReady: '' } };
    expect(bilingualGaps(holey, COPY_KEYS).ta).toContain('scrReady');
  });
});

describe('every governance flag has a human label in both languages', () => {
  it('each of the seven findings renders a non-empty EN and TA label on a row', () => {
    for (const code of ALL_FLAGS) {
      const s = session({ exceptions: () => data([flagged({ returnId: `RT-${code}`, governanceFlags: [code] })]) });
      for (const lang of ['en', 'ta'] as const) {
        const flag = s.view(lang).exceptions[0]!.flags[0]!;
        expect(flag.code).toBe(code);
        expect(flag.label.trim().length, `${code} has no ${lang} label`).toBeGreaterThan(0);
      }
    }
  });
});

describe('an exception reads as attention, never colour alone', () => {
  it('a flagged return is attention (degraded) with a word, an icon, and an announcement naming what broke', () => {
    const row = session().view('en').exceptions[0]!;
    expect(row.needsAttention).toBe(true);
    expect(row.status.tone).toBe('degraded');
    expect(row.status.label.length).toBeGreaterThan(0);        // the word "Exception"
    expect(row.status.icon.trim().length).toBeGreaterThan(0);  // an icon rides with the tone
    expect(row.status.announcement).toContain('cap');          // names the store-credit-over-cap breach
  });

  it('surfaces every flag on a multi-breach return', () => {
    const s = session({ exceptions: () => data([flagged({ returnId: 'RT-multi', governanceFlags: ['given_without_approval', 'refund_exceeds_paid'] })]) });
    const row = s.view('en').exceptions[0]!;
    expect(row.flags.map((f) => f.code)).toEqual(['given_without_approval', 'refund_exceeds_paid']);
  });
});

describe('the view formats money and fills in the missing-value fallbacks', () => {
  it('formats the refund and the total in ₹, and totals across the flagged returns', () => {
    const s = session({ exceptions: () => data([flagged({ returnId: 'RT-1', refundMinor: 5000 }), flagged({ returnId: 'RT-2', refundMinor: 12345 })]) });
    const v = s.view('en');
    expect(v.exceptionCount).toBe(2);
    expect(v.exceptions[0]!.amount).toBe('₹50.00');
    expect(v.totalRefundedMinor).toBe(17345);
    expect(v.totalRefunded).toBe('₹173.45');
  });

  it('shows "nobody named" for a missing approver and "no customer" for a missing customer', () => {
    const s = session({ exceptions: () => data([flagged({ returnId: 'RT-x', approvedBy: undefined, customerRef: undefined, governanceFlags: ['given_without_approval', 'store_credit_no_customer'] })]) });
    const row = s.view('en').exceptions[0]!;
    expect(row.approvedBy).toBe(RETURN_GOVERNANCE_COPY.en.noneNamed);
    expect(row.customerRef).toBe(RETURN_GOVERNANCE_COPY.en.noCustomer);
  });

  it('carries a no-receipt return through as a null original bill', () => {
    const s = session({ exceptions: () => data([flagged({ returnId: 'RT-nr', originalSaleId: null })]) });
    expect(s.view('en').exceptions[0]!.originalSaleId).toBeNull();
  });
});

describe('screen states: not-permitted, empty, ready, nobody-named', () => {
  it('a user without lp.case.read is refused and shown nothing', () => {
    const v = session({ mayRead: () => false }).view('en');
    expect(v.screenState.label).toBe(RETURN_GOVERNANCE_COPY.en.stateNotPermitted);
    expect(v.screenState.needsAttention).toBe(true);
    expect(v.exceptions).toEqual([]);
    expect(v.exceptionCount).toBe(0);
  });

  it('no exceptions reads as a clean, empty state (all refunds followed the rules)', () => {
    const v = session({ exceptions: () => data([]) }).view('en');
    expect(v.screenState.label).toBe(RETURN_GOVERNANCE_COPY.en.scrEmpty);
    expect(v.screenState.needsAttention).toBe(false);
    expect(v.exceptionCount).toBe(0);
    expect(v.totalRefundedMinor).toBe(0);
  });

  it('exceptions present read as a ready state', () => {
    expect(session().view('en').screenState.label).toBe(RETURN_GOVERNANCE_COPY.en.scrReady);
  });

  it('flags when the store computer was not told who is looking', () => {
    expect(session({}, null).view('en').nobodyNamed).toBe(true);
    expect(session({}, 'u-owner').view('en').nobodyNamed).toBe(false);
  });
});
