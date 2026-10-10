import { describe, it, expect } from 'vitest';
import { budgetDecision, budgetPeriodOf, type MessagingBudget } from '../../packages/notifications/src/index';

// PA-08 round 4 · M31-FR-04 · D3: the messaging budget fails SAFE — no budget, or no cost for a channel, sends nothing;
// a message that would take the month past its cap is refused. The engine both the enqueue and the send re-check use.
const B: MessagingBudget = { capMinor: 100, costMinorByChannel: { sms: 40 }, version: 1, setBy: 'u-owner', setAt: '2026-10-01T00:00:00.000Z' };

describe('the messaging budget', () => {
  it('no budget set: nothing is sent (off until the owner sets one)', () => {
    expect(budgetDecision({ budget: undefined, spentMinor: 0, channel: 'sms' })).toMatchObject({ ok: false, reason: 'no_budget_set' });
  });
  it('a channel with no cost set is not sent on', () => {
    expect(budgetDecision({ budget: B, spentMinor: 0, channel: 'whatsapp' })).toMatchObject({ ok: false, reason: 'channel_not_costed' });
  });
  it('fits up to the cap exactly, and not one paisa over', () => {
    expect(budgetDecision({ budget: B, spentMinor: 60, channel: 'sms' })).toEqual({ ok: true, costMinor: 40 });
    expect(budgetDecision({ budget: B, spentMinor: 61, channel: 'sms' })).toMatchObject({ ok: false, reason: 'over_budget' });
  });
  it('the period is the calendar month', () => {
    expect(budgetPeriodOf('2026-10-31T23:59:59.000Z')).toBe('2026-10');
    expect(budgetPeriodOf('2026-11-01T00:00:00.000Z')).toBe('2026-11');
  });
});
