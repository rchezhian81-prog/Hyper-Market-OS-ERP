import { describe, it, expect } from 'vitest';
import {
  TenantSettings,
  SETTINGS,
  SETUP_CATALOGUE,
  setupStatus,
  applyAnswer,
  setupItem,
  InvalidSetupAnswerError,
} from '../../packages/tenant/src/index';
import { ConfigStore } from '../../packages/config/src/index';

// Self-service store setup: every setting has a plain question and a safe default, so a
// fresh store already runs; the required ones block until the tenant gives them; and an
// invalid answer is refused by name, never stored (ADR-0003 §4 / M01-FR-02/03 / M33-FR-01).

const AT = '2026-08-07T10:00:00Z';
const newSettings = (): TenantSettings => new TenantSettings(new ConfigStore<unknown>());
const item = (key: string) => {
  const found = setupItem(key);
  if (found === undefined) throw new Error(`no setup item ${key}`);
  return found;
};

describe('the setup catalogue', () => {
  it('asks a plain question for every settable item, and only the tax class blocks', () => {
    expect(SETUP_CATALOGUE.length).toBeGreaterThanOrEqual(12);
    for (const i of SETUP_CATALOGUE) {
      expect(i.question.trim().length).toBeGreaterThan(0);
    }
    const required = SETUP_CATALOGUE.filter((i) => i.required).map((i) => i.setting.key);
    expect(required).toEqual(['tax.default_bps']);
  });

  it('finds an item by key', () => {
    expect(setupItem('receipt.paper_format')?.setting).toBe(SETTINGS.RECEIPT_PAPER_FORMAT);
    expect(setupItem('nope')).toBeUndefined();
  });
});

describe('setupStatus on a fresh tenant', () => {
  it('runs on defaults, but the required tax class blocks the store from opening', () => {
    const status = setupStatus(newSettings(), 'acme');
    expect(status.answered).toBe(0);
    expect(status.total).toBe(SETUP_CATALOGUE.length);
    expect(status.progressBp).toBe(0);
    expect(status.blocking).toEqual(['tax.default_bps']);
    expect(status.complete).toBe(false);
    // Every non-required item is simply on its default, not blocking.
    const taxItem = status.items.find((i) => i.key === 'tax.default_bps');
    expect(taxItem?.state).toBe('blocking');
    expect(status.items.filter((i) => i.state === 'using_default').length).toBe(SETUP_CATALOGUE.length - 1);
  });
});

describe('answering setup items', () => {
  it('clears the block once the tax class is given, and counts progress', () => {
    const s = newSettings();
    applyAnswer(s, 'acme', item('tax.default_bps'), 1800, 'owner', AT);
    const status = setupStatus(s, 'acme');
    expect(status.blocking).toEqual([]);
    expect(status.complete).toBe(true);
    expect(status.answered).toBe(1);
    expect(status.progressBp).toBe(Math.round((1 / status.total) * 10_000));
    const taxItem = status.items.find((i) => i.key === 'tax.default_bps');
    expect(taxItem?.state).toBe('answered');
    expect(taxItem?.isDefault).toBe(false);
    expect(taxItem?.value).toBe(1800);
  });

  it('records an answer through the versioned engine (audited, reversible)', () => {
    const store = new ConfigStore<unknown>();
    const s = new TenantSettings(store);
    applyAnswer(s, 'acme', item('trading_day.cutoff'), '22:00', 'owner', AT);
    expect(s.get('acme', SETTINGS.TRADING_DAY_CUTOFF)).toBe('22:00');
    // A second tenant is untouched.
    expect(s.isSet('other', SETTINGS.TRADING_DAY_CUTOFF)).toBe(false);
  });

  it('refuses an invalid answer by name and stores nothing', () => {
    const s = newSettings();
    expect(() => applyAnswer(s, 'acme', item('trading_day.cutoff'), '25:99', 'owner', AT))
      .toThrow(InvalidSetupAnswerError);
    expect(() => applyAnswer(s, 'acme', item('tax.default_bps'), 999_999, 'owner', AT))
      .toThrow(/basis points/);
    expect(() => applyAnswer(s, 'acme', item('locale.languages'), [], 'owner', AT))
      .toThrow(InvalidSetupAnswerError);
    // Nothing was written by the refused calls.
    expect(s.isSet('acme', SETTINGS.TRADING_DAY_CUTOFF)).toBe(false);
    expect(s.isSet('acme', SETTINGS.DEFAULT_TAX_BPS)).toBe(false);
  });

  it('validates the receipt paper size against the built-in formats', () => {
    const s = newSettings();
    applyAnswer(s, 'acme', item('receipt.paper_format'), 'thermal-80', 'owner', AT);
    expect(s.get('acme', SETTINGS.RECEIPT_PAPER_FORMAT)).toBe('thermal-80');
    expect(() => applyAnswer(s, 'acme', item('receipt.paper_format'), 'thermal-999', 'owner', AT))
      .toThrow(/thermal-58, thermal-80, thermal-112/);
  });

  it('accepts an explicit empty list for a no-safe-default list setting', () => {
    const s = newSettings();
    applyAnswer(s, 'acme', item('picking.zone_order'), [], 'owner', AT);
    // Explicitly answered, even though the value equals the default shape.
    expect(s.isSet('acme', SETTINGS.PICK_ZONE_ORDER)).toBe(true);
    expect(setupStatus(s, 'acme').items.find((i) => i.key === 'picking.zone_order')?.state).toBe('answered');
  });
});
