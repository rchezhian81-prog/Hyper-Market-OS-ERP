import { describe, it, expect } from 'vitest';
import {
  createSupplierPortalSession, SUPPLIER_PORTAL_COPY, COPY_KEYS,
  type SubmissionView, type StatementView, type SupplierPortalData,
} from '../../apps/supplier-app/src/supplier-portal-session';
import { bilingualGaps } from '../../packages/ui/src/index';

// The supplier self-service portal (M24-FR-01 · API-03 · §35 · P-03 · P-04) is READ-ONLY: a supplier reads its
// OWN submissions and its OWN statement, and nothing else. These are unit tests on the tested session model —
// the DOM and the fetch are proven separately (slice 2 guardrail, slice 3 browser e2e).

const submission = (over: Partial<SubmissionView> & { submissionId: string }): SubmissionView => ({
  kind: 'invoice', requiresReview: false, receivedAt: '2026-09-20T10:00:00Z', ...over,
});

const statement = (over: Partial<StatementView> = {}): StatementView => ({
  partnerId: 'p-1', accessible: true, openingMinor: 0, invoicedMinor: 500000, debitedMinor: 0,
  creditedMinor: 0, paidMinor: 200000, closingMinor: 300000, disputedMinor: 0, reconciles: true,
  detail: '300000 outstanding', ...over,
});

const data = (over: Partial<SupplierPortalData> = {}): SupplierPortalData =>
  ({ submissions: [], statement: statement(), asAt: '2026-09-22T10:00:00Z', ...over });

const session = (d: SupplierPortalData, mayRead = true, userId: string | null = 'u-supplier') =>
  createSupplierPortalSession({ userId }, { portal: () => d, mayRead: () => mayRead });

describe('the supplier portal is offered in both languages', () => {
  it('has no gap in either language across the whole vocabulary', () => {
    const gaps = bilingualGaps(SUPPLIER_PORTAL_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });

  it('tripwire — the detector fires on a key genuinely absent', () => {
    const holey = { en: { ...SUPPLIER_PORTAL_COPY.en }, ta: { ...SUPPLIER_PORTAL_COPY.ta, title: '' } };
    expect(bilingualGaps(holey, COPY_KEYS).ta).toContain('title');
  });
});

describe('submissions: what the supplier is waiting on leads', () => {
  it('splits awaiting-review from processed, newest first within each', () => {
    const view = session(data({
      submissions: [
        submission({ submissionId: 's-old-done', requiresReview: false, receivedAt: '2026-09-18T09:00:00Z' }),
        submission({ submissionId: 's-new-wait', requiresReview: true, receivedAt: '2026-09-21T09:00:00Z', kind: 'asn' }),
        submission({ submissionId: 's-old-wait', requiresReview: true, receivedAt: '2026-09-19T09:00:00Z', kind: 'claim' }),
      ],
    })).view('en');
    expect(view.awaiting.map((s) => s.submissionId)).toEqual(['s-new-wait', 's-old-wait']); // newest awaiting first
    expect(view.processed.map((s) => s.submissionId)).toEqual(['s-old-done']);
    expect(view.awaitingCount).toBe(2);
    expect(view.anyAttention).toBe(true);
  });

  it('an awaiting submission reads "waiting on us" (never "accepted"); a processed one reads OK — icon + word', () => {
    const view = session(data({ submissions: [submission({ submissionId: 's-w', requiresReview: true }), submission({ submissionId: 's-p', requiresReview: false })] })).view('en');
    const w = view.awaiting[0]!;
    expect(w.awaiting).toBe(true);
    expect(w.status.tone).toBe('degraded');
    expect(w.status.icon.trim().length).toBeGreaterThan(0);
    expect(w.status.label.length).toBeGreaterThan(0);
    const p = view.processed[0]!;
    expect(p.status.tone).toBe('ok');
    expect(p.status.icon.trim().length).toBeGreaterThan(0);
  });

  it('labels each submission kind (a claim is not an invoice)', () => {
    const view = session(data({ submissions: [submission({ submissionId: 's', kind: 'claim' })] })).view('en');
    expect(view.processed[0]!.kindLabel).toBe(SUPPLIER_PORTAL_COPY.en.kindClaim);
  });
});

describe('statement: outstanding, disputed shown separately, accessible is not zero', () => {
  it('presents the figures and reconciles OK', () => {
    const view = session(data({ statement: statement({ closingMinor: 300000, reconciles: true }) })).view('en');
    expect(view.statement).not.toBeNull();
    expect(view.statement!.closing).toBe('₹3,000.00');
    expect(view.statement!.status.tone).toBe('ok');
    expect(view.statementInaccessible).toBe(false);
  });

  it('a non-reconciling statement reads as an error the supplier should raise', () => {
    const view = session(data({ statement: statement({ reconciles: false }) })).view('en');
    expect(view.statement!.status.tone).toBe('error');
    expect(view.anyAttention).toBe(true);
  });

  it('a disputed amount is carried separately from the outstanding balance', () => {
    const view = session(data({ statement: statement({ closingMinor: 300000, disputedMinor: 50000 }) })).view('en');
    expect(view.statement!.disputed).toBe('₹500.00');
    expect(view.statement!.closing).toBe('₹3,000.00'); // disputed is NOT folded into outstanding
  });

  it('a login without the statement grant sees "not accessible", never a balance of zero', () => {
    const view = session(data({ statement: statement({ accessible: false, closingMinor: 0 }) })).view('en');
    expect(view.statement).toBeNull();          // no misleading figures
    expect(view.statementInaccessible).toBe(true); // the screen shows the "ask us to turn it on" line
    expect(view.screenState.tone).not.toBe('error'); // it is a permission answer, not a screen error
  });
});

describe('permission and empty states', () => {
  it('a non-supplier login sees a not-permitted state and nothing else', () => {
    const view = session(data({ submissions: [submission({ submissionId: 's' })] }), false).view('en');
    expect(view.screenState.tone).toBe('error');
    expect(view.awaiting).toEqual([]);
    expect(view.processed).toEqual([]);
    expect(view.statement).toBeNull();
    expect(view.anyAttention).toBe(false);
  });

  it('a supplier with nothing sent and a clear statement is a calm empty state', () => {
    const view = session(data({ submissions: [], statement: statement({ closingMinor: 0, invoicedMinor: 0, paidMinor: 0, detail: 'clear' }) })).view('en');
    expect(view.anyAttention).toBe(false);
    expect(view.awaitingCount).toBe(0);
    expect(view.screenState.tone).not.toBe('error');
  });

  it('flags when the login was not identified', () => {
    expect(session(data(), true, null).view('en').notIdentified).toBe(true);
    expect(session(data(), true, 'u-supplier').view('en').notIdentified).toBe(false);
  });

  it('renders the statement in Tamil too (labels come from the one bilingual object)', () => {
    const en = session(data(), true).view('en');
    const ta = session(data(), true).view('ta');
    expect(en.statement!.closing).toBe(ta.statement!.closing); // money formatting is language-neutral
    expect(session(data({ statement: statement({ reconciles: false }) }), true).view('ta').statement!.status.label)
      .toBe(SUPPLIER_PORTAL_COPY.ta.notReconciledLabel);
  });
});
