import { describe, it, expect } from 'vitest';
import * as storedValueModule from '../../packages/loyalty/src/stored-value';
import {
  balanceOf,
  householdBalance,
  redeemValue,
  issueRefundCredit,
  findDoubleSpends,
  reconcileLiability,
  flagVelocity,
  type Instrument,
  type ValueMovement,
} from '../../packages/loyalty/src/stored-value';

// M17-FR-03: "gift/store-credit are LIABILITIES; balances reconcile; over-redemption
// blocked; no card data." M17-FR-04: "concurrent burn across channels resolved WITHOUT
// DOUBLE-SPEND (§31.1 — conflict as exception, never last-write-wins)."

const CARD: Instrument = {
  instrumentId: 'GC-1',
  kind: 'gift_card',
  ownerRef: 'hh-patel',
  issuedAt: '2026-07-01T00:00:00Z',
  expiresOn: '2027-06-30',
};

const mv = (over: Partial<ValueMovement>): ValueMovement => ({
  movementId: 'm-1',
  instrumentId: 'GC-1',
  kind: 'redeem',
  deltaMinor: -20_000,
  at: '2026-08-04T14:00:00Z',
  channel: 'store',
  ...over,
});

const LOADED = [mv({ movementId: 'm-load', kind: 'issue', deltaMinor: 100_000, at: '2026-07-01T00:00:00Z' })];

describe('a balance is projected, never stored (hard rule #2)', () => {
  it('sums the movements', () => {
    expect(balanceOf([...LOADED, mv({})], 'GC-1')).toBe(80_000);
  });

  it('exposes NO way to set a balance directly', () => {
    const api = Object.keys(storedValueModule);
    expect(api.filter((n) => /setBalance|updateBalance|writeBalance|adjustTo/i.test(n))).toEqual([]);
    expect(api).toContain('balanceOf');
  });

  it('pools one balance across a household\'s instruments (M17-FR-04)', () => {
    const second: Instrument = { ...CARD, instrumentId: 'GC-2' };
    const movements = [
      ...LOADED,
      mv({ movementId: 'm-2', instrumentId: 'GC-2', kind: 'issue', deltaMinor: 50_000 }),
      mv({ movementId: 'm-3', instrumentId: 'GC-2', deltaMinor: -10_000 }),
    ];
    expect(householdBalance(movements, [CARD, second], 'hh-patel')).toBe(140_000);
    // Another household sees nothing of it.
    expect(householdBalance(movements, [CARD, second], 'hh-other')).toBe(0);
  });
});

describe('a gift card cannot be overdrawn, and offline is capped not forbidden', () => {
  it('redeems within the balance', () => {
    const result = redeemValue({ instrument: CARD, movements: LOADED, movement: mv({}) });
    expect(result.redeemed).toBe(true);
    expect(result.balanceAfterMinor).toBe(80_000);
  });

  it('REFUSES to overdraw', () => {
    const result = redeemValue({ instrument: CARD, movements: LOADED, movement: mv({ deltaMinor: -150_000 }) });
    expect(result.redeemed).toBe(false);
    expect(result.outcome).toBe('insufficient_balance');
    expect(result.detail).toContain('cannot be overdrawn');
  });

  it('ALLOWS an offline redemption within the cap — the shop must honour its own cards', () => {
    const result = redeemValue({
      instrument: CARD,
      movements: LOADED,
      movement: mv({ deltaMinor: -30_000, capturedOffline: true }),
      policy: { offlineCapMinor: 50_000 },
    });
    expect(result.redeemed).toBe(true);
  });

  it('refuses an offline redemption above the cap, without refusing the card itself', () => {
    const result = redeemValue({
      instrument: CARD,
      movements: LOADED,
      movement: mv({ deltaMinor: -80_000, capturedOffline: true }),
      policy: { offlineCapMinor: 50_000 },
    });
    expect(result.outcome).toBe('offline_cap_exceeded');
    expect(result.detail).toContain('needs the connection back');

    // Online, the same amount is fine.
    expect(
      redeemValue({ instrument: CARD, movements: LOADED, movement: mv({ deltaMinor: -80_000 }) }).redeemed,
    ).toBe(true);
  });

  it('is idempotent, refuses an expired card, and refuses a non-negative "redemption"', () => {
    expect(
      redeemValue({ instrument: CARD, movements: [...LOADED, mv({})], movement: mv({}) }).outcome,
    ).toBe('duplicate_movement');
    expect(
      redeemValue({ instrument: CARD, movements: LOADED, movement: mv({ at: '2027-08-01T10:00:00Z' }) }).outcome,
    ).toBe('expired');
    expect(
      redeemValue({ instrument: CARD, movements: LOADED, movement: mv({ deltaMinor: 5_000 }) }).outcome,
    ).toBe('invalid_amount');
  });
});

describe('a refund issued as store credit becomes a real spendable balance (M13-FR-03 / M17)', () => {
  const AT = '2026-08-05T10:00:00Z';

  it('opens a fresh store-credit instrument with a refund_to_credit movement', () => {
    const r = issueRefundCredit({ ownerRef: 'c-asha', amountMinor: 20_000, returnId: 'RT-9', at: AT, capMinor: 100_000 });
    expect(r.ok).toBe(true);
    expect(r.outcome).toBe('issued');
    expect(r.instrument).toEqual({ instrumentId: 'store-credit:RT-9', kind: 'store_credit', ownerRef: 'c-asha', issuedAt: AT });
    expect(r.movement?.kind).toBe('refund_to_credit');
    expect(r.movement?.deltaMinor).toBe(20_000); // positive — value added to the customer's account
    expect(r.movement?.customerRef).toBe('c-asha');
    expect(r.balanceAfterMinor).toBe(20_000);
    // The issued credit is spendable AND counts as a liability the shop owes (M23).
    expect(balanceOf([r.movement!], r.instrumentId)).toBe(20_000);
    expect(reconcileLiability({ movements: [r.movement!], postedLiabilityMinor: 20_000 }).reconciles).toBe(true);
  });

  it('tops up an existing store-credit account instead of opening a new one', () => {
    const existing: Instrument = { instrumentId: 'SC-asha', kind: 'store_credit', ownerRef: 'c-asha', issuedAt: '2026-07-01T00:00:00Z' };
    const existingMovements: ValueMovement[] = [
      { movementId: 'seed', instrumentId: 'SC-asha', kind: 'issue', deltaMinor: 5_000, at: '2026-07-01T00:00:00Z', channel: 'store' },
    ];
    const r = issueRefundCredit({ ownerRef: 'c-asha', amountMinor: 15_000, returnId: 'RT-10', at: AT, capMinor: 100_000, existing, existingMovements });
    expect(r.ok).toBe(true);
    expect(r.instrument).toBeUndefined(); // no new instrument
    expect(r.instrumentId).toBe('SC-asha');
    expect(r.movement?.deltaMinor).toBe(15_000);
    expect(r.balanceAfterMinor).toBe(20_000); // 5,000 + 15,000
  });

  it('is idempotent on the return id — a retry issues no second credit', () => {
    const first = issueRefundCredit({ ownerRef: 'c-asha', amountMinor: 20_000, returnId: 'RT-9', at: AT, capMinor: 100_000 });
    const retry = issueRefundCredit({ ownerRef: 'c-asha', amountMinor: 20_000, returnId: 'RT-9', at: AT, capMinor: 100_000, existingMovements: [first.movement!] });
    expect(retry.ok).toBe(false);
    expect(retry.outcome).toBe('duplicate_movement');
    expect(retry.movement).toBeUndefined();
  });

  it('issues NOTHING when the owner has not set a cap (fail safe, never a guessed default)', () => {
    const r = issueRefundCredit({ ownerRef: 'c-asha', amountMinor: 20_000, returnId: 'RT-11', at: AT });
    expect(r.ok).toBe(false);
    expect(r.outcome).toBe('cap_not_configured');
    expect(r.movement).toBeUndefined();
  });

  it('refuses issuance past the owner cap, counting what was already issued in the window', () => {
    const under = issueRefundCredit({ ownerRef: 'c-asha', amountMinor: 20_000, returnId: 'RT-12', at: AT, capMinor: 50_000, alreadyIssuedMinor: 20_000 });
    expect(under.ok).toBe(true); // 20k + 20k = 40k ≤ 50k
    const over = issueRefundCredit({ ownerRef: 'c-asha', amountMinor: 20_000, returnId: 'RT-13', at: AT, capMinor: 50_000, alreadyIssuedMinor: 40_000 });
    expect(over.ok).toBe(false); // 40k + 20k = 60k > 50k
    expect(over.outcome).toBe('cap_exceeded');
  });

  it('refuses a non-positive or fractional amount', () => {
    for (const bad of [0, -100, 12.5]) {
      expect(issueRefundCredit({ ownerRef: 'c-asha', amountMinor: bad, returnId: 'RT-x', at: AT, capMinor: 100_000 }).outcome).toBe('invalid_amount');
    }
  });
});

describe('a cross-channel double-spend is an exception, never last-write-wins (§31.1)', () => {
  it('KEEPS BOTH MOVEMENTS and names both channels', () => {
    // ₹500 on the card. Mother spends it at the till; son spends it on the app at the
    // same moment. Both are offline-captured and both arrive on sync.
    const household: ValueMovement[] = [
      mv({ movementId: 'm-load', kind: 'issue', deltaMinor: 50_000, at: '2026-07-01T00:00:00Z' }),
      mv({ movementId: 'm-till', deltaMinor: -50_000, channel: 'store', customerRef: 'c-mother', capturedOffline: true, at: '2026-08-04T14:00:00Z' }),
      mv({ movementId: 'm-app', deltaMinor: -50_000, channel: 'app', customerRef: 'c-son', at: '2026-08-04T14:00:20Z' }),
    ];

    const found = findDoubleSpends(household, [CARD]);
    expect(found).toHaveLength(1);
    expect(found[0]?.overspentMinor).toBe(50_000);
    expect(found[0]?.channels).toEqual(['app', 'store']);
    // Both redemptions survive — neither is silently reversed.
    expect(found[0]?.movements.map((m) => m.movementId)).toEqual(['m-till', 'm-app']);
    expect(found[0]?.detail).toContain('both are kept');
    expect(found[0]?.detail).toContain('nothing is silently reversed');
  });

  it('is quiet when the balance never went negative', () => {
    expect(findDoubleSpends([...LOADED, mv({})], [CARD])).toEqual([]);
  });

  it('ranks the worst overspend first', () => {
    const second: Instrument = { ...CARD, instrumentId: 'GC-2' };
    const movements = [
      mv({ movementId: 'a1', kind: 'issue', deltaMinor: 10_000 }),
      mv({ movementId: 'a2', deltaMinor: -20_000 }),
      mv({ movementId: 'b1', instrumentId: 'GC-2', kind: 'issue', deltaMinor: 10_000 }),
      mv({ movementId: 'b2', instrumentId: 'GC-2', deltaMinor: -90_000 }),
    ];
    expect(findDoubleSpends(movements, [CARD, second]).map((d) => d.instrumentId)).toEqual(['GC-2', 'GC-1']);
  });
});

describe('every unspent rupee is money the shop owes (M17-FR-03 / M23)', () => {
  const movements: ValueMovement[] = [
    mv({ movementId: 'i1', kind: 'issue', deltaMinor: 100_000 }),
    mv({ movementId: 'i2', kind: 'load', deltaMinor: 50_000 }),
    mv({ movementId: 'r1', kind: 'redeem', deltaMinor: -30_000 }),
    mv({ movementId: 'e1', kind: 'expire', deltaMinor: -5_000 }),
  ];

  it('reconciles exactly against the posted liability', () => {
    const result = reconcileLiability({ movements, postedLiabilityMinor: 115_000 });
    expect(result.outstandingMinor).toBe(115_000);
    expect(result.reconciles).toBe(true);
    expect(result.detail).toContain('the liability is correctly stated');
  });

  it('CALLS A DIFFERENCE UNRECORDED DEBT rather than a rounding note', () => {
    const result = reconcileLiability({ movements, postedLiabilityMinor: 100_000 });
    expect(result.reconciles).toBe(false);
    expect(result.differenceMinor).toBe(-15_000);
    expect(result.detail).toContain('unrecorded debt until it is explained');
  });

  it('breaks the figure down so the difference can be found', () => {
    const result = reconcileLiability({ movements, postedLiabilityMinor: 115_000 });
    expect(result.issuedMinor).toBe(150_000);
    expect(result.redeemedMinor).toBe(30_000);
    expect(result.expiredMinor).toBe(5_000);
  });
});

describe('velocity is a signal, not a block', () => {
  it('flags rapid redemptions without stopping any of them', () => {
    const movements = Array.from({ length: 6 }, (_, i) =>
      mv({ movementId: `v-${i}`, deltaMinor: -5_000, at: `2026-08-04T14:${String(i * 5).padStart(2, '0')}:00Z` }),
    );
    const [flag] = flagVelocity({ movements, at: '2026-08-04T15:00:00Z', policy: { velocityCount: 5, velocityWindowMinutes: 60 } });
    expect(flag?.count).toBe(6);
    expect(flag?.valueMinor).toBe(30_000);
    expect(flag?.detail).toContain('nothing is blocked');
  });

  it('ignores redemptions outside the window and quiet instruments', () => {
    const old = Array.from({ length: 6 }, (_, i) =>
      mv({ movementId: `o-${i}`, deltaMinor: -5_000, at: '2026-08-01T10:00:00Z' }),
    );
    expect(flagVelocity({ movements: old, at: '2026-08-04T15:00:00Z' })).toEqual([]);
    expect(flagVelocity({ movements: [mv({})], at: '2026-08-04T15:00:00Z' })).toEqual([]);
  });
});
