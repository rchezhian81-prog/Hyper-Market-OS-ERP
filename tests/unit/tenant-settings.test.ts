import { describe, it, expect } from 'vitest';
import { TenantSettings, SETTINGS } from '../../packages/tenant/src/index';
import { ConfigStore } from '../../packages/config/src/index';

// Per-tenant settings: every store chooses its own, with a sensible default when
// unset, isolated between tenants, and audited/reversible via the config engine.

const AT = '2026-08-02T10:00:00Z';

function newSettings(): TenantSettings {
  return new TenantSettings(new ConfigStore<unknown>());
}

describe('per-tenant settings', () => {
  it('returns the default when a tenant has not chosen a value', () => {
    const s = newSettings();
    expect(s.get('sre', SETTINGS.TRADING_DAY_CUTOFF)).toBe('00:00');
    expect(s.get('sre', SETTINGS.BASE_CURRENCY)).toBe('INR');
    expect(s.get('sre', SETTINGS.LANGUAGES)).toEqual(['en', 'ta']);
  });

  it('returns a tenant’s chosen value once set', () => {
    const s = newSettings();
    s.set('sre', SETTINGS.TRADING_DAY_CUTOFF, '02:00', 'owner', 'onboarding', AT);
    s.set('sre', SETTINGS.DEFAULT_TAX_BPS, 1800, 'owner', 'GST', AT);
    expect(s.get('sre', SETTINGS.TRADING_DAY_CUTOFF)).toBe('02:00');
    expect(s.get('sre', SETTINGS.DEFAULT_TAX_BPS)).toBe(1800);
  });

  it('keeps tenants isolated', () => {
    const s = newSettings();
    s.set('sre', SETTINGS.DELIVERY_RADIUS_KM, 10, 'owner', 'launch', AT);
    expect(s.get('sre', SETTINGS.DELIVERY_RADIUS_KM)).toBe(10);
    expect(s.get('other-store', SETTINGS.DELIVERY_RADIUS_KM)).toBe(0); // default
  });

  it('returns a stored falsy value rather than the default', () => {
    const s = newSettings();
    s.set('sre', SETTINGS.LANGUAGES, [], 'owner', 'none', AT); // explicitly empty
    expect(s.get('sre', SETTINGS.LANGUAGES)).toEqual([]); // not the ['en','ta'] default
  });

  it('takes the latest chosen value (versioned underneath)', () => {
    const s = newSettings();
    s.set('sre', SETTINGS.BASE_CURRENCY, 'USD', 'owner', 'v1', AT);
    s.set('sre', SETTINGS.BASE_CURRENCY, 'INR', 'owner', 'v2', AT);
    expect(s.get('sre', SETTINGS.BASE_CURRENCY)).toBe('INR');
  });

  /**
   * OB-07 — SRE collects ambient, then the secure cabinet, then the chiller, then the freezer.
   *
   * The setting has **no default**, and that is the part worth a test: which zones a shop has and
   * how long chilled goods may stand out are questions about a licensed premises, and a default
   * here would be this codebase answering a food-safety question for every tenant. The wrong guess
   * is silent — the pick route looks sensible and the milk is warm.
   */
  it('ships NO pick zone order, so a shop that has not said gets none', () => {
    expect(SETTINGS.PICK_ZONE_ORDER.defaultValue).toEqual([]);
    expect(newSettings().get('a-shop-that-has-not-answered', SETTINGS.PICK_ZONE_ORDER)).toEqual([]);
  });

  it('holds SRE’s own answer without changing anybody else’s', () => {
    const s = newSettings();
    s.set('sre', SETTINGS.PICK_ZONE_ORDER, ['ambient', 'secure', 'chilled', 'frozen'], 'owner', 'OB-07', AT);
    expect(s.get('sre', SETTINGS.PICK_ZONE_ORDER)).toEqual(['ambient', 'secure', 'chilled', 'frozen']);
    expect(s.get('another-tenant', SETTINGS.PICK_ZONE_ORDER)).toEqual([]);
  });
});
