import { describe, it, expect } from 'vitest';
import { journeyTriggers, nextOccasionDate } from '../../packages/service-desk/src/journey-facts';
import { journeyCampaignId } from '../../services/customer/src/journeys';

// M21-FR-02: journey triggers are worked out from facts — a held basket with no order since, an occasion the week before,
// a last purchase past the lapsing line — each with a ref naming exactly what fired it.

const base = { carts: [], occasions: [], purchases: [], today: '2026-10-23', lapsingAfterDays: 60 };

describe('journey triggers from facts (M21-FR-02)', () => {
  it('a held basket is a trigger until an order is placed after it', () => {
    const carts = [{ customerRef: 'a', lineCount: 2, valueMinor: 120_00, updatedAt: '2026-10-23T05:00:00.000Z' }, { customerRef: 'b', lineCount: 1, valueMinor: 50_00, updatedAt: '2026-10-22T05:00:00.000Z' }, { customerRef: 'c', lineCount: 0, valueMinor: 0, updatedAt: '2026-10-22T05:00:00.000Z' }];
    const out = journeyTriggers({ ...base, kind: 'abandoned_cart', carts, purchases: [{ customerRef: 'b', at: '2026-10-22T09:00:00.000Z', valueMinor: 50_00 }] });
    expect(out.triggers).toEqual([{ customerRef: 'a', kind: 'abandoned_cart', triggeredAt: '2026-10-23T05:00:00.000Z', valueMinor: 120_00, ref: 'cart:a:2026-10-23T05:00:00.000Z' }]);
    expect(out.completedRefs).toEqual(['b']);
  });

  it('an occasion fires the week before its next date; a removed one never', () => {
    const occasions = [{ occasionId: 'o1', customerRef: 'a', kind: 'birthday' as const, monthDay: '10-26' }, { occasionId: 'o2', customerRef: 'b', kind: 'birthday' as const, monthDay: '12-25' }, { occasionId: 'o3', customerRef: 'c', kind: 'anniversary' as const, monthDay: '10-25', removed: true }];
    const out = journeyTriggers({ ...base, kind: 'occasion', occasions });
    expect(out.triggers.map((t) => t.ref)).toEqual(['occasion:o1:2026-10-26']);
    expect(nextOccasionDate('10-01', '2026-10-23')).toBe('2027-10-01');
    expect(nextOccasionDate('02-29', '2026-10-23')).toBe('2027-02-28');
  });

  it('a last purchase past the lapsing line wins back; a recent one does not', () => {
    const out = journeyTriggers({ ...base, kind: 'win_back', purchases: [{ customerRef: 'a', at: '2026-08-01T10:00:00.000Z', valueMinor: 500_00 }, { customerRef: 'a', at: '2026-07-01T10:00:00.000Z', valueMinor: 1 }, { customerRef: 'b', at: '2026-10-01T10:00:00.000Z', valueMinor: 1 }] });
    expect(out.triggers).toEqual([{ customerRef: 'a', kind: 'win_back', triggeredAt: '2026-09-30T10:00:00.000Z', valueMinor: 500_00, ref: 'winback:a:2026-08-01T10:00:00.000Z' }]);
  });

  it('one campaign per trigger, within the send\'s id rule', () => {
    const id = journeyCampaignId('abandoned_cart', 'cart:a:2026-10-23T05:00:00.000Z');
    expect(id).toMatch(/^[A-Za-z0-9-]{1,48}$/);
    expect(journeyCampaignId('abandoned_cart', 'cart:a:2026-10-23T05:00:00.000Z')).toBe(id);
    expect(journeyCampaignId('abandoned_cart', 'cart:a:2026-10-24T05:00:00.000Z')).not.toBe(id);
  });
});
