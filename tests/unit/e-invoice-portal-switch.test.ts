import { describe, it, expect } from 'vitest';
import {
  assessGstPortalGate,
  requireGstPortalLive,
  GstPortalDisabledError,
} from '../../packages/e-invoice/src/index';

describe('assessGstPortalGate — feature flag + kill switch, safe default is not-live', () => {
  it('is not live by default (absent controls)', () => {
    const g = assessGstPortalGate();
    expect(g.canGoLive).toBe(false);
    expect(g.reason).toBe('not_enabled');
  });

  it('goes live only when explicitly enabled', () => {
    expect(assessGstPortalGate({ enabled: true }).canGoLive).toBe(true);
    expect(assessGstPortalGate({ enabled: false }).reason).toBe('not_enabled');
  });

  it('lets the kill switch override an enabled integration', () => {
    const g = assessGstPortalGate({ enabled: true, killed: true });
    expect(g.canGoLive).toBe(false);
    expect(g.reason).toBe('killed');
    expect(assessGstPortalGate({ killed: true }).reason).toBe('killed');
  });

  it('names the channel in the reason', () => {
    expect(assessGstPortalGate({}, 'e_way_bill').detail).toContain('e-way-bill');
    expect(assessGstPortalGate({}, 'e_invoice').detail).toContain('e-invoicing');
    expect(assessGstPortalGate({ enabled: true }, 'e_way_bill').channel).toBe('e_way_bill');
  });
});

describe('requireGstPortalLive', () => {
  it('returns the gate when open and throws when closed', () => {
    expect(requireGstPortalLive({ enabled: true }).canGoLive).toBe(true);
    expect(() => requireGstPortalLive({})).toThrow(GstPortalDisabledError);
    expect(() => requireGstPortalLive({ enabled: true, killed: true })).toThrow(GstPortalDisabledError);
    try {
      requireGstPortalLive({}, 'e_way_bill');
    } catch (e) {
      expect((e as GstPortalDisabledError).gate.reason).toBe('not_enabled');
    }
  });
});
