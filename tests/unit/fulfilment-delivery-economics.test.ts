import { describe, it, expect } from 'vitest';
import { contributionGate, deliveryCostOf, fleetSettlementOf, SWITCHED_OFF_COURIER, standInCourier } from '../../packages/fulfilment/src/index';

// D09-FR-06 · OB-313 · OB-294 — the contribution rule (threshold "not set" → flag only; below it → a manager approves),
// own-fleet settlement from the drops head office holds, and the courier link built switched OFF. Synthetic data.

describe('the delivery cost of a drop — the owner\'s rates, or "not set"', () => {
  it('is the per-drop cost plus the per-km cost over the straight-line distance, in whole paise', () => {
    expect(deliveryCostOf({ costPerDropMinor: 20_00, costPerKmMinor: 6_00 }, 2_500)).toBe(35_00);
    expect(deliveryCostOf({ costPerDropMinor: 0, costPerKmMinor: 1 }, 1_499)).toBe(1); // half up, once
  });
  it('is never a zero when a rate is missing or the address has no distance', () => {
    expect(deliveryCostOf({ costPerDropMinor: 20_00 }, 2_500)).toBe('rates_not_set');
    expect(deliveryCostOf({}, 2_500)).toBe('rates_not_set');
    expect(deliveryCostOf({ costPerDropMinor: 20_00, costPerKmMinor: 6_00 }, undefined)).toBe('no_distance');
  });
});

describe('the contribution rule (OB-313)', () => {
  const base = { orderId: 'O1', itemsMarginMinor: 30_00, deliveryFeeMinor: 0, orderValueMinor: 300_00, distanceMetres: 4_000 };
  const rates = { costPerDropMinor: 20_00, costPerKmMinor: 5_00 }; // a drop 4 km out costs ₹40
  it('only FLAGS while the owner has not set the threshold — it says what it found and holds nothing', () => {
    const g = contributionGate({ ...base, controls: rates });
    expect(g.outcome).toBe('flag_only');
    expect(g.thresholdMinor).toBeNull();
    expect(g.assessment).toMatchObject({ contributionMinor: -10_00, profitable: false, flagged: true });
    expect(g.detail).toMatch(/not set/);
  });
  it('below the owner\'s threshold, a manager must approve; at or above it, clear', () => {
    expect(contributionGate({ ...base, controls: { ...rates, contributionThresholdMinor: 0 } }).outcome).toBe('needs_manager_approval');
    expect(contributionGate({ ...base, itemsMarginMinor: 60_00, controls: { ...rates, contributionThresholdMinor: 20_00 } }).outcome).toBe('clear');
    expect(contributionGate({ ...base, itemsMarginMinor: 59_99, controls: { ...rates, contributionThresholdMinor: 20_00 } }).outcome).toBe('needs_manager_approval');
  });
  it('is NOT ASSESSED — never assessed as profitable, never held on a guess — when a cost price, a rate or the distance is unknown', () => {
    const g = contributionGate({ ...base, itemsMarginMinor: undefined, distanceMetres: undefined, controls: { contributionThresholdMinor: 100_00 } });
    expect(g.outcome).toBe('not_assessed');
    expect(g.missing).toEqual(['cost_price', 'delivery_rates']);
    expect(g.assessment).toBeNull();
    expect(contributionGate({ ...base, distanceMetres: undefined, controls: { ...rates, contributionThresholdMinor: 1 } }).missing).toEqual(['distance']);
  });
});

describe('own-fleet settlement (D09-FR-06)', () => {
  it('settles per drop or per run at the owner\'s rate; no rate, no settlement; no drop, nothing to settle', () => {
    expect(fleetSettlementOf({ basis: 'per_drop', rateMinor: 40_00 }, 7)).toEqual({ amountMinor: 280_00 });
    expect(fleetSettlementOf({ basis: 'per_run', rateMinor: 500_00 }, 7)).toEqual({ amountMinor: 500_00 });
    expect(fleetSettlementOf(undefined, 7)).toBe('rate_not_set');
    expect(fleetSettlementOf({ basis: 'per_drop', rateMinor: 40_00 }, 0)).toBe('no_drops');
  });
});

describe('the courier-partner link (OB-294: built, switched OFF)', () => {
  it('the running system\'s link sends nothing and says so; the stand-in is for tests only and is handed only an area', async () => {
    expect(SWITCHED_OFF_COURIER.on).toBe(false);
    expect(await SWITCHED_OFF_COURIER.handOff({ orderId: 'O1', area: 'Slot 10:00–11:00', codMinor: 0 })).toMatchObject({ sent: false, reason: 'link_off' });
    const fake = standInCourier();
    expect(await fake.handOff({ orderId: 'O1', area: 'Slot 10:00–11:00', codMinor: 0 })).toEqual({ sent: true, partnerRef: 'STANDIN-1', partner: 'stand-in' });
    expect(Object.keys(fake.handed[0]!)).toEqual(['orderId', 'area', 'codMinor']);
  });
});
