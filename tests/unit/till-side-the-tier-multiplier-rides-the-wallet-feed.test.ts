import { describe, it, expect } from 'vitest';
import { readWalletFeed, walletAvailable } from '../../packages/loyalty/src/wallet';
import { buildWalletFeed, type LoyaltyWalletDeps } from '../../services/customer/src/loyalty-wallets';

/**
 * **OB-295 (M17-FR-01) — the tier multiplier goes into the till's wallet feed, OFF until the owner sets tiers.** The feed
 * carries each member's tier and its multiplier only while tiers are set; the box reads it defensively (a malformed tier
 * refuses the whole feed — never half-served) and the till is told the tier, or "not set".
 */

const M1 = `m-${'a'.repeat(24)}`;
const M2 = `m-${'b'.repeat(24)}`;
const AT = '2026-10-24T09:00:00.000Z';

const deps = (tierAt?: LoyaltyWalletDeps['tierAt']): LoyaltyWalletDeps => ({
  rule: () => ({ pointsPer100Inr: 1, pointValuePaise: 100, tillSpendCapPaise: 50_000 }),
  allMembers: () => [{ memberRef: M1, status: 'member' }, { memberRef: M2, status: 'member' }] as never,
  pointsBalance: () => 40, pointsVersion: () => 0, storeCredit: async () => [], spendsApplied: async () => [],
  recordPointsSpend: async () => {}, recordCreditSpend: async () => {}, recordSpendApplied: async () => {}, now: () => AT,
  ...(tierAt === undefined ? {} : { tierAt }),
});

describe('OB-295 — the tier multiplier in the wallet feed', () => {
  it('no tiers set: the feed carries no tier, and the till is told nothing about one ("not set")', async () => {
    const feed = await buildWalletFeed(deps(async () => undefined), 't');
    expect(feed.members.every((m) => m.tier === undefined)).toBe(true);
    const read = readWalletFeed(JSON.parse(JSON.stringify(feed)))!;
    const a = walletAvailable({ feed: read, memberRef: M1, localSpends: [], tradingDay: '2026-10-24' });
    expect(a.tierMultiplierBps).toBeUndefined();
    expect(a.tierName).toBeUndefined();
  });

  it('tiers set: each member carries their tier and multiplier as at the feed\'s build; below the lowest tier is 1× with no name', async () => {
    const feed = await buildWalletFeed(deps(async (_t, memberRef, at) => {
      expect(at).toBe(AT);
      return memberRef === M1 ? { tierName: 'Gold', multiplierBps: 15_000 } : { tierName: null, multiplierBps: 10_000 };
    }), 't');
    const read = readWalletFeed(JSON.parse(JSON.stringify(feed)))!;
    expect(walletAvailable({ feed: read, memberRef: M1, localSpends: [], tradingDay: '2026-10-24' })).toMatchObject({ tierName: 'Gold', tierMultiplierBps: 15_000 });
    expect(walletAvailable({ feed: read, memberRef: M2, localSpends: [], tradingDay: '2026-10-24' })).toMatchObject({ tierName: null, tierMultiplierBps: 10_000 });
  });

  it('a malformed tier refuses the whole feed — never half-served', () => {
    const base = { tenantId: 't', generatedAt: AT, rule: { pointsPer100Inr: 1, pointValuePaise: 100, tillSpendCapPaise: 0 } };
    const member = { memberRef: M1, points: 1, storeCreditMinor: 0, appliedSpendRefs: [] };
    expect(readWalletFeed({ ...base, members: [{ ...member, tier: { name: 'Gold', multiplierBps: 15_000 } }] })).toBeDefined();
    expect(readWalletFeed({ ...base, members: [{ ...member, tier: { name: 'Gold', multiplierBps: 5_000 } }] })).toBeUndefined();
    expect(readWalletFeed({ ...base, members: [{ ...member, tier: { name: '', multiplierBps: 15_000 } }] })).toBeUndefined();
    expect(readWalletFeed({ ...base, members: [{ ...member, tier: 'gold' }] })).toBeUndefined();
  });
});
