import { describe, it, expect } from 'vitest';
import { counterDecision, readConcessionTradingFeed, termsOf, type ConcessionTradingFeed, type CounterTerms } from '../../packages/concession/src/trading-feed';

// PF-13: the store computer decides a partner counter by its own calendar from the agreement terms head office published.

const terms = (over: Partial<CounterTerms> = {}): CounterTerms => ({
  contractId: 'ct-1', concessionaireId: 'p-1', branchId: 'br-1', startsOn: '2026-01-01', endsOn: '2026-12-31',
  insuranceUntil: '2026-12-31', approved: true, active: true, ...over,
});
const feed = (...contracts: CounterTerms[]): ConcessionTradingFeed => ({ tenantId: 't', generatedAt: '2026-10-10T00:00:00.000Z', contracts });

describe('counterDecision', () => {
  it('an approved, active, in-date agreement trades — and warns ahead of an expiry', () => {
    expect(counterDecision({ feed: feed(terms()), concessionaireId: 'p-1', today: '2026-10-10' })).toMatchObject({ mayTrade: true, contractId: 'ct-1' });
    const soon = counterDecision({ feed: feed(terms({ insuranceUntil: '2026-10-20' })), concessionaireId: 'p-1', today: '2026-10-10' });
    expect(soon).toMatchObject({ mayTrade: true });
    expect((soon as unknown as { warnings: string[] }).warnings.join(' ')).toMatch(/insurance runs out in 10/);
  });

  it.each([
    ['ended', terms({ endsOn: '2026-10-09' }), ['contract_expired']],
    ['not started', terms({ startsOn: '2026-11-01' }), ['contract_not_started']],
    ['insurance lapsed', terms({ insuranceUntil: '2026-10-09' }), ['insurance_lapsed']],
    ['no insurance at all', terms({ insuranceUntil: undefined }), ['insurance_lapsed']],
    ['licence lapsed', terms({ licenceUntil: '2026-01-01' }), ['licence_lapsed']],
    ['not approved by a second person', terms({ approved: false }), ['not_approved']],
    ['switched off', terms({ active: false }), ['inactive']],
  ] as const)('a counter whose agreement is %s is stopped, every reason at once, in words', (_, t, blockedBy) => {
    const d = counterDecision({ feed: feed(t as CounterTerms), concessionaireId: 'p-1', contractId: 'ct-1', today: '2026-10-10' });
    expect(d).toMatchObject({ mayTrade: false, blockedBy });
    expect((d as { laneMessage: string }).laneMessage).toMatch(/Do not take money/);
  });

  it('no agreement here, another store\'s agreement, or two covering today: not traded', () => {
    expect(counterDecision({ feed: feed(terms()), concessionaireId: 'p-9', today: '2026-10-10' })).toMatchObject({ mayTrade: false, blockedBy: ['no_agreement'] });
    expect(counterDecision({ feed: feed(terms()), concessionaireId: 'p-1', branchId: 'br-2', today: '2026-10-10' })).toMatchObject({ mayTrade: false, blockedBy: ['no_agreement'] });
    expect(counterDecision({ feed: feed(terms(), terms({ contractId: 'ct-2' })), concessionaireId: 'p-1', today: '2026-10-10' })).toMatchObject({ mayTrade: false, blockedBy: ['agreement_ambiguous'] });
  });

  it('the feed carries terms only — never the money terms — and a malformed one is refused whole', () => {
    const t = termsOf({ contractId: 'c', tenantId: 't', branchId: 'b', concessionaireId: 'p', name: 'n', startsOn: '2026-01-01', endsOn: '2026-12-31', basis: 'revenue_share', revenueShareBps: 1500, depositMinor: 100, active: true, approvedBy: 'u-acct' });
    expect(t).toEqual({ contractId: 'c', concessionaireId: 'p', branchId: 'b', startsOn: '2026-01-01', endsOn: '2026-12-31', approved: true, active: true });
    expect(readConcessionTradingFeed(feed(terms()))).toEqual(feed(terms()));
    expect(readConcessionTradingFeed({ ...feed(terms()), contracts: [{ ...terms(), endsOn: '31/12/2026' }] })).toBeUndefined();
  });
});
