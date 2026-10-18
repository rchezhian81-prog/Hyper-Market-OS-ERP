import { describe, it, expect } from 'vitest';
import { checkDispatchEwb, supplyRouteBetween, EWB_INTER_STATE_THRESHOLD_MINOR, EWB_INTRA_STATE_THRESHOLD_MINOR } from '../../packages/e-way-bill/src/index';

/**
 * R3 · A23 remainder — the pure gate on a dispatch. Signed sentence: "a dispatch at or below the threshold proceeds. One
 * above it without a `generated` e-way bill is refused by name. With one, it proceeds and the movement links to the EWB
 * number."
 */

const gate = (value: number, route: 'intra_state' | 'inter_state' | 'not_known', ewb?: { state: 'generated' | 'pending_unknown' | 'rejected' | 'cancelled' | 'provider_error'; ewbNo?: string }, unvaluedLines = 0) =>
  checkDispatchEwb({ movementId: 'transfer-t1', consignmentValueMinor: value, unvaluedLines, supplyRoute: route, ewb });

describe('the e-way-bill gate on a dispatch', () => {
  it('at or below the threshold proceeds — intra-State ₹1,00,000, inter-State ₹50,000', () => {
    expect(gate(EWB_INTRA_STATE_THRESHOLD_MINOR, 'intra_state')).toMatchObject({ outcome: 'not_required', thresholdMinor: 10_000_000 });
    expect(gate(EWB_INTER_STATE_THRESHOLD_MINOR, 'inter_state')).toMatchObject({ outcome: 'not_required', thresholdMinor: 5_000_000 });
    expect(gate(6_000_000, 'intra_state').outcome).toBe('not_required');
  });

  it('above it without a generated e-way bill is refused by name — whatever state the bill is in', () => {
    const none = gate(EWB_INTRA_STATE_THRESHOLD_MINOR + 1, 'intra_state');
    expect(none).toMatchObject({ outcome: 'refused', code: 'ewb_required', movementId: 'transfer-t1', ewbState: 'none' });
    expect(none.detail).toBe('movement transfer-t1 is worth ₹1,00,000.01, above the ₹1,00,000.00 threshold, and no e-way bill has been generated for it');
    expect(gate(6_000_000, 'inter_state')).toMatchObject({ outcome: 'refused' });
    for (const state of ['pending_unknown', 'rejected', 'cancelled', 'provider_error'] as const) {
      const r = gate(20_000_000, 'intra_state', { state, ewbNo: '123456789012' });
      expect(r).toMatchObject({ outcome: 'refused', ewbState: state });
      expect(r.detail).toMatch(new RegExp(`its e-way bill is ${state.replace(/_/g, ' ')}, not generated`));
    }
    // A "generated" bill without a well-formed number is not one.
    expect(gate(20_000_000, 'intra_state', { state: 'generated', ewbNo: '12' }).outcome).toBe('refused');
  });

  it('with a generated e-way bill it proceeds and carries the number', () => {
    expect(gate(20_000_000, 'intra_state', { state: 'generated', ewbNo: '123456789012' })).toMatchObject({ outcome: 'covered', ewbNo: '123456789012', movementId: 'transfer-t1' });
  });

  it('an unknown route takes the lower inter-State threshold, and says so; unvalued lines are said', () => {
    const r = gate(6_000_000, 'not_known');
    expect(r).toMatchObject({ outcome: 'refused', thresholdMinor: 5_000_000, supplyRoute: 'not_known' });
    expect(r.detail).toMatch(/the GST state of one end is not known, so the lower inter-State threshold applies/);
    expect(gate(100, 'intra_state', undefined, 2).detail).toMatch(/2 line\(s\) have no cost on record and are not in the value/);
    expect(supplyRouteBetween('33', '33')).toBe('intra_state');
    expect(supplyRouteBetween('33', '29')).toBe('inter_state');
    expect(supplyRouteBetween('33', null)).toBe('not_known');
  });
});
