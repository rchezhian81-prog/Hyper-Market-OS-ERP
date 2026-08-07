import { describe, it, expect } from 'vitest';
import {
  TenantSettings, SETTINGS, setupStatus, applyAnswer, setupItem, SetupVersionConflictError,
} from '../../packages/tenant/src/index';
import { ConfigStore } from '../../packages/config/src/index';

// Setup answers carry a version and an audit trail, and a save made against a stale version is
// refused rather than clobbering a newer one (optimistic concurrency, M33-FR-01).

const AT = '2026-08-07T10:00:00Z';
const item = (key: string) => {
  const found = setupItem(key);
  if (found === undefined) throw new Error(`no setup item ${key}`);
  return found;
};

describe('setup versioning and audit', () => {
  it('a fresh tenant is version 0 everywhere, with no audit', () => {
    const status = setupStatus(new TenantSettings(new ConfigStore()), 'acme');
    for (const i of status.items) {
      expect(i.version).toBe(0);
      expect(i.changedBy).toBeUndefined();
      expect(i.changedAt).toBeUndefined();
    }
  });

  it('records the version, who chose it and when', () => {
    const s = new TenantSettings(new ConfigStore());
    applyAnswer(s, 'acme', item('tax.default_bps'), 1800, 'owner-1', AT);
    const tax = setupStatus(s, 'acme').items.find((i) => i.key === 'tax.default_bps');
    expect(tax?.version).toBe(1);
    expect(tax?.changedBy).toBe('owner-1');
    expect(tax?.changedAt).toBe(AT);
  });

  it('accepts a save that matches the current version', () => {
    const s = new TenantSettings(new ConfigStore());
    applyAnswer(s, 'acme', item('tax.default_bps'), 1800, 'owner-1', AT); // → v1
    applyAnswer(s, 'acme', item('tax.default_bps'), 1200, 'owner-1', AT, 'store setup', 1); // ifVersion 1 → v2
    expect(s.get('acme', SETTINGS.DEFAULT_TAX_BPS)).toBe(1200);
    expect(s.versionOf('acme', SETTINGS.DEFAULT_TAX_BPS)).toBe(2);
  });

  it('refuses a save against a stale version and stores nothing', () => {
    const s = new TenantSettings(new ConfigStore());
    applyAnswer(s, 'acme', item('tax.default_bps'), 1800, 'owner-1', AT); // → v1
    expect(() => applyAnswer(s, 'acme', item('tax.default_bps'), 1200, 'owner-2', AT, 'store setup', 0))
      .toThrow(SetupVersionConflictError);
    expect(s.get('acme', SETTINGS.DEFAULT_TAX_BPS)).toBe(1800); // unchanged
    expect(s.versionOf('acme', SETTINGS.DEFAULT_TAX_BPS)).toBe(1);
  });

  it('keeps versions isolated per tenant', () => {
    const s = new TenantSettings(new ConfigStore());
    applyAnswer(s, 'acme', item('tax.default_bps'), 1800, 'owner-1', AT);
    expect(s.versionOf('other', SETTINGS.DEFAULT_TAX_BPS)).toBe(0);
    expect(s.metaOf('other', SETTINGS.DEFAULT_TAX_BPS)).toBeUndefined();
  });
});
