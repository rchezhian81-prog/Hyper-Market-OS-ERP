import { describe, it, expect } from 'vitest';
import { buildBrief, type BuildBriefInput, type PendingApproval } from '../../apps/owner-app/src/index';
import type { SaleFact } from '../../packages/reporting/src/index';
import { evaluateLossPrevention, type ActivityEvent, type LpRule } from '../../packages/loss-prevention/src/index';

// The owner brief is control by exception: the day's numbers, the three things
// needing attention, grouped alerts that drill to transactions, and honest
// freshness — deterministic, so it renders with AI off (M29 / P-03 / P-08).

const ASOF = '2026-08-02T20:00:00Z';
const SYNCED = '2026-08-02T19:59:00Z'; // 60s old

function sale(id: string, over: Partial<SaleFact> = {}): SaleFact {
  return {
    saleId: id,
    netMinor: 100_00,
    taxMinor: 18_00,
    totalMinor: 118_00,
    cogsMinor: 70_00,
    units: 3,
    tender: 'cash',
    currency: 'INR',
    ...over,
  };
}

function input(over: Partial<BuildBriefInput> = {}): BuildBriefInput {
  return {
    asOf: ASOF,
    lastSyncedAt: SYNCED,
    staleAfterSeconds: 300,
    sales: [sale('s1'), sale('s2')],
    exceptions: [],
    approvals: [],
    ...over,
  };
}

describe('buildBrief', () => {
  it('states the day in plain sentences with the numbers beside the words', () => {
    const brief = buildBrief(input());
    expect(brief.headline).toContain('2 bills today');
    expect(brief.headline).toContain('₹236.00 taken');
    expect(brief.headline).toContain('margin ₹60.00 (30.0%)');
    expect(brief.headline).toContain('average basket ₹118.00');
    expect(brief.kpis.basketCount).toBe(2);
  });

  it('always reports freshness and never shows stale data as live', () => {
    const fresh = buildBrief(input());
    expect(fresh.freshness.state).toBe('fresh');
    expect(fresh.headline).not.toContain('NOT live');

    const stale = buildBrief(input({ lastSyncedAt: '2026-08-02T12:00:00Z' })); // 8h old
    expect(stale.freshness.state).toBe('stale');
    expect(stale.headline).toContain('NOT live');

    const never = buildBrief(input({ lastSyncedAt: null }));
    expect(never.freshness.state).toBe('missing');
    expect(never.headline).toContain('No data has synced');
  });

  it('handles a day with no sales without pretending', () => {
    const brief = buildBrief(input({ sales: [] }));
    expect(brief.headline).toContain('No sales recorded yet today');
    expect(brief.kpis.grossSalesMinor).toBe(0);
  });

  it('groups alerts so a spike is one line, not a storm', () => {
    // six separate void exceptions for one cashier become a single grouped line
    const events: ActivityEvent[] = Array.from({ length: 6 }, (_, i) => ({
      txnId: `t${i}`,
      kind: 'void',
      cashierId: 'c1',
      at: ASOF,
    }));
    const rules: LpRule[] = [{ kind: 'void', maxCount: 2 }];
    const exceptions = evaluateLossPrevention(events, rules);

    const brief = buildBrief(input({ exceptions }));
    expect(brief.alerts).toHaveLength(1); // one line, not six
    expect(brief.alerts[0]?.sentence).toContain('voided bills over the limit');
    expect(brief.alerts[0]?.linkedTxnIds).toHaveLength(6); // but every txn is linked
  });

  // OB-435 · OB-439: each alert and "needs attention" line carries its Tamil twin; the English is the sentence as before.
  it('gives every alert and attention line in English and Tamil (OB-435)', () => {
    const events: ActivityEvent[] = Array.from({ length: 3 }, (_, i) => ({ txnId: `t${i}`, kind: 'void', cashierId: 'c1', at: ASOF }));
    const exceptions = evaluateLossPrevention(events, [{ kind: 'void', maxCount: 2 }]);
    const brief = buildBrief(input({ exceptions, approvals: [{ id: 'a1', subjectType: 'purchase_order', subjectRef: 'po-1', requestedBy: 'buyer-1', valueMinor: 812_000_00 }] }));
    const alert = brief.alerts[0]!;
    expect(alert.words.en).toBe(alert.sentence);
    expect(alert.words.ta).toMatch(/[\u0B80-\u0BFF]/);
    expect(alert.words.ta).toContain('ரத்து செய்த பில்கள்');
    expect(alert.words.ta).not.toMatch(/voided|over the limit/);
    const approval = brief.attention.find((a) => a.source === 'approval')!;
    expect(approval.sentence).toBe('Approval waiting: purchase order from buyer-1 for ₹8,12,000.00.');
    expect(approval.words).toEqual({ en: approval.sentence, ta: 'ஒப்புதல் காத்திருக்கிறது: buyer-1 இடமிருந்து கொள்முதல் ஆணை, ₹8,12,000.00.' });
    expect(brief.attention.find((a) => a.source === 'exception')!.words).toEqual(alert.words);
  });

  it('puts urgent escalations above ordinary flags', () => {
    const exceptions = [
      ...evaluateLossPrevention(
        [{ txnId: 'r1', kind: 'refund', cashierId: 'c1', valueMinor: 500_00, at: ASOF }],
        [{ kind: 'refund', maxTotalValueMinor: 100_00 }],
      ),
      ...evaluateLossPrevention(
        Array.from({ length: 9 }, (_, i) => ({ txnId: `n${i}`, kind: 'no_sale' as const, cashierId: 'c1', at: ASOF })),
        [{ kind: 'no_sale', maxCount: 3, escalateAtMultiple: 3 }],
      ),
    ];
    const brief = buildBrief(input({ exceptions }));
    expect(brief.alerts[0]?.severity).toBe('escalate');
    expect(brief.alerts[0]?.sentence).toContain('Urgent:');
  });

  it('names exactly three things needing attention, alerts before approvals', () => {
    const exceptions = evaluateLossPrevention(
      [
        { txnId: 'r1', kind: 'refund', cashierId: 'c1', valueMinor: 900_00, at: ASOF },
        { txnId: 'd1', kind: 'discount', cashierId: 'c1', valueMinor: 400_00, at: ASOF },
      ],
      [
        { kind: 'refund', maxTotalValueMinor: 100_00 },
        { kind: 'discount', maxTotalValueMinor: 100_00 },
      ],
    );
    const approvals: PendingApproval[] = [
      { id: 'a1', subjectType: 'price_change', subjectRef: 'p1', requestedBy: 'manager-1', valueMinor: 50_000_00 },
      { id: 'a2', subjectType: 'stock_adjustment', subjectRef: 'adj-1', requestedBy: 'clerk-1', valueMinor: 1_000_00 },
    ];

    const brief = buildBrief(input({ exceptions, approvals }));
    expect(brief.attention).toHaveLength(3);
    expect(brief.attention.map((a) => a.rank)).toEqual([1, 2, 3]);
    expect(brief.attention[0]?.source).toBe('exception'); // risks outrank approvals
    expect(brief.attention[2]?.source).toBe('approval');
    expect(brief.attention[2]?.sentence).toContain('₹50,000.00'); // the biggest one first
  });

  it('shows fewer than three when there is less to worry about', () => {
    const brief = buildBrief(input({ approvals: [{ id: 'a1', subjectType: 'refund', subjectRef: 'r1', requestedBy: 'clerk-1', valueMinor: null }] }));
    expect(brief.attention).toHaveLength(1);
    expect(brief.attention[0]?.sentence).toContain('Approval waiting: refund from clerk-1');
  });

  it('orders the approvals inbox by value, highest first', () => {
    const approvals: PendingApproval[] = [
      { id: 'small', subjectType: 'refund', subjectRef: 'r1', requestedBy: 'c1', valueMinor: 100_00 },
      { id: 'big', subjectType: 'price_change', subjectRef: 'p1', requestedBy: 'c2', valueMinor: 10_000_00 },
    ];
    const brief = buildBrief(input({ approvals }));
    expect(brief.approvals.map((a) => a.id)).toEqual(['big', 'small']);
  });

  it('is deterministic — the same facts always give the same brief', () => {
    expect(buildBrief(input())).toEqual(buildBrief(input()));
  });
});
