import { describe, it, expect } from 'vitest';
import {
  planErasure,
  fulfilRequest,
  overdueRequests,
  type DataSubjectRequest,
  type DataCategory,
} from '../../packages/customer/src/data-rights';

// M16-FR-03: "erasure conflicting with a legal-retention/financial record → the record is
// RETAINED PER LAW AND THE CUSTOMER IS TOLD WHAT AND WHY (honest, P-08)."

const REQUEST: DataSubjectRequest = {
  requestId: 'DSR-1',
  tenantId: 't-1',
  customerRef: 'c-4471',
  kind: 'erasure',
  raisedAt: '2026-08-01T10:00:00Z',
  verifiedBy: 'u-dpo',
  verifiedAt: '2026-08-01T11:00:00Z',
  state: 'verified',
  dueBy: '2026-08-31',
};

const CATEGORIES: DataCategory[] = [
  { category: 'Marketing preferences', recordCount: 1 },
  { category: 'Browsing and app activity', recordCount: 412 },
  { category: 'Sales invoices', recordCount: 38, retentionBasis: 'tax_invoice', retainUntil: '2034-03-31', minimisable: true },
  { category: 'GST records', recordCount: 38, retentionBasis: 'gst_record', retainUntil: '2032-12-31', minimisable: true },
  { category: 'Audit trail', recordCount: 96, retentionBasis: 'audit_evidence', minimisable: true },
];

describe('erasure tells the truth about what it cannot delete (M16-FR-03)', () => {
  it('deletes what it can, minimises what must survive, and counts each', () => {
    const plan = planErasure({ request: REQUEST, categories: CATEGORIES, at: '2026-08-02T09:00:00Z' });

    expect(plan.erasedRecordCount).toBe(413); // preferences + activity
    expect(plan.minimisedRecordCount).toBe(172); // invoices + GST + audit
    expect(plan.retainedRecordCount).toBe(0);
    expect(plan.partial).toBe(true);
  });

  it('NAMES THE LAW for every record it keeps', () => {
    const plan = planErasure({ request: REQUEST, categories: CATEGORIES, at: '2026-08-02T09:00:00Z' });
    const statement = plan.customerStatement.join(' ');

    expect(statement).toContain('income-tax law requires sales invoices to be kept for eight years');
    expect(statement).toContain('GST law requires these records to be kept for six years');
    expect(statement).toContain('until 2034-03-31');
    // And it is honest about why we would rather say it.
    expect(statement).toContain('rather tell you exactly which than let you believe they were gone');
    expect(statement).toContain('not used for marketing');
  });

  it('NEVER erases audit evidence — it minimises the person out of it (hard rule #6)', () => {
    const plan = planErasure({ request: REQUEST, categories: CATEGORIES, at: '2026-08-02T09:00:00Z' });
    const audit = plan.plan.find((p) => p.category === 'Audit trail');
    expect(audit?.disposition).toBe('minimise');
    expect(audit?.explanation).toContain('can never be deleted by anyone, including us');
    // Nothing in the whole plan erases it.
    expect(plan.plan.filter((p) => p.disposition === 'erase').map((p) => p.category)).not.toContain('Audit trail');
  });

  it('retains in full — not minimised — where the record must stay identifiable', () => {
    const plan = planErasure({
      request: REQUEST,
      categories: [{ category: 'Open fraud case', recordCount: 1, retentionBasis: 'fraud_investigation' }],
      at: '2026-08-02T09:00:00Z',
    });
    expect(plan.plan[0]?.disposition).toBe('retain');
    expect(plan.retainedRecordCount).toBe(1);
    expect(plan.customerStatement.join(' ')).toContain('evidence in an open investigation');
  });

  it('says plainly when nothing at all is retained', () => {
    const plan = planErasure({
      request: REQUEST,
      categories: [{ category: 'Marketing preferences', recordCount: 1 }],
      at: '2026-08-02T09:00:00Z',
    });
    expect(plan.partial).toBe(false);
    expect(plan.customerStatement[plan.customerStatement.length - 1]).toBe('Nothing about you is retained.');
  });

  it('honours a legal hold', () => {
    const plan = planErasure({
      request: REQUEST,
      categories: [{ category: 'Correspondence', recordCount: 12, retentionBasis: 'legal_hold' }],
      at: '2026-08-02T09:00:00Z',
    });
    expect(plan.plan[0]?.explanation).toContain('legal hold');
  });
});

describe('verification comes first, always', () => {
  it('REFUSES to fulfil an unverified request', () => {
    const result = fulfilRequest({
      request: { ...REQUEST, kind: 'access', verifiedBy: undefined, verifiedAt: undefined, state: 'raised' },
      held: { orders: [1, 2, 3] },
      fulfilledBy: 'u-dpo',
      at: '2026-08-02T09:00:00Z',
    });
    expect(result.fulfilled).toBe(false);
    expect(result.outcome).toBe('not_verified');
    expect(result.detail).toContain("another person's account");
    expect(result.payload).toBeUndefined();
  });

  it('fulfils a verified access request with the data held', () => {
    const result = fulfilRequest({
      request: { ...REQUEST, kind: 'access' },
      held: { orders: [1, 2], preferences: { sms: false } },
      fulfilledBy: 'u-dpo',
      at: '2026-08-02T09:00:00Z',
    });
    expect(result.fulfilled).toBe(true);
    expect(result.request.state).toBe('fulfilled');
    expect(result.payload).toEqual({ orders: [1, 2], preferences: { sms: false } });
  });

  it('treats "we hold nothing" as a complete, fulfilled answer', () => {
    const result = fulfilRequest({
      request: { ...REQUEST, kind: 'access' },
      held: {},
      fulfilledBy: 'u-dpo',
      at: '2026-08-02T09:00:00Z',
    });
    expect(result.fulfilled).toBe(true);
    expect(result.outcome).toBe('nothing_held');
    expect(result.request.state).toBe('fulfilled');
  });

  it('refuses to fulfil twice', () => {
    const done = fulfilRequest({ request: { ...REQUEST, state: 'fulfilled' }, held: {}, fulfilledBy: 'u', at: 'x' });
    expect(done.outcome).toBe('wrong_state');
  });
});

describe('a privacy request that quietly ages is the one a regulator asks about', () => {
  it('surfaces overdue requests, latest first, and calls out unverified ones', () => {
    const list = overdueRequests(
      [
        { ...REQUEST, requestId: 'DSR-late', dueBy: '2026-08-01', state: 'verified' },
        { ...REQUEST, requestId: 'DSR-unver', dueBy: '2026-08-05', verifiedBy: undefined, state: 'raised' },
        { ...REQUEST, requestId: 'DSR-ok', dueBy: '2026-09-30', state: 'verified' },
        { ...REQUEST, requestId: 'DSR-done', dueBy: '2026-07-01', state: 'fulfilled' },
      ],
      '2026-08-10',
    );

    expect(list.map((r) => r.requestId)).toEqual(['DSR-late', 'DSR-unver']);
    expect(list[0]?.daysOverdue).toBe(9);
    expect(list[1]?.detail).toContain('STILL NOT VERIFIED');
    expect(list[1]?.detail).toContain('entirely ours and has not been worked');
  });

  it('is quiet when nothing is late', () => {
    expect(overdueRequests([REQUEST], '2026-08-10')).toEqual([]);
  });
});
