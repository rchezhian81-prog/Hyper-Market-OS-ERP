import { describe, it, expect } from 'vitest';
import {
  DurableTenantSettings, setupItem, SetupVersionConflictError, InvalidSetupAnswerError,
} from '../../packages/tenant/src/index';
import { InMemoryConfigVersionStore } from '../../packages/persistence/src/config-store';

// Tenant settings, read and written through the durable, append-only config_versions store, so a
// store's setup answers survive a process restart — with the SAME validation, version and audit
// rules the in-memory path uses (M01-FR-03 / M33-FR-01). InMemoryConfigVersionStore is the store's
// behavioural contract; SqlConfigVersionStore is tested against a real database separately.

const AT = '2026-08-07T10:00:00Z';
const item = (key: string) => {
  const found = setupItem(key);
  if (found === undefined) throw new Error(`no setup item ${key}`);
  return found;
};

describe('DurableTenantSettings', () => {
  it('reads defaults from an empty store, blocked on the tax class', async () => {
    const status = await new DurableTenantSettings(new InMemoryConfigVersionStore()).status('acme');
    expect(status.blocking).toEqual(['tax.default_bps']);
    expect(status.answered).toBe(0);
    expect(status.items.every((i) => i.version === 0)).toBe(true);
  });

  it('persists an answer with version and audit, clearing the block', async () => {
    const s = new DurableTenantSettings(new InMemoryConfigVersionStore());
    await s.apply('acme', item('tax.default_bps'), 1800, 'owner-1', AT);
    const status = await s.status('acme');
    expect(status.complete).toBe(true);
    const tax = status.items.find((i) => i.key === 'tax.default_bps');
    expect(tax?.value).toBe(1800);
    expect(tax?.version).toBe(1);
    expect(tax?.changedBy).toBe('owner-1');
    expect(tax?.changedAt).toBe(AT);
  });

  it('survives a restart: a fresh instance over the same store still sees the answer', async () => {
    const store = new InMemoryConfigVersionStore();
    await new DurableTenantSettings(store).apply('acme', item('trading_day.cutoff'), '22:00', 'owner-1', AT);
    // A brand-new DurableTenantSettings — as after a process restart — reads the persisted value.
    const afterRestart = await new DurableTenantSettings(store).status('acme');
    const cutoff = afterRestart.items.find((i) => i.key === 'trading_day.cutoff');
    expect(cutoff?.value).toBe('22:00');
    expect(cutoff?.version).toBe(1);
    expect(cutoff?.isDefault).toBe(false);
  });

  it('enforces optimistic concurrency', async () => {
    const s = new DurableTenantSettings(new InMemoryConfigVersionStore());
    await s.apply('acme', item('tax.default_bps'), 1800, 'owner-1', AT); // → v1
    await s.apply('acme', item('tax.default_bps'), 1200, 'owner-1', AT, 1); // ifVersion 1 → v2
    expect((await s.status('acme')).items.find((i) => i.key === 'tax.default_bps')?.value).toBe(1200);
    await expect(s.apply('acme', item('tax.default_bps'), 900, 'owner-2', AT, 0))
      .rejects.toThrow(SetupVersionConflictError);
  });

  it('refuses an invalid value and stores nothing', async () => {
    const s = new DurableTenantSettings(new InMemoryConfigVersionStore());
    await expect(s.apply('acme', item('tax.default_bps'), 999_999, 'owner-1', AT))
      .rejects.toThrow(InvalidSetupAnswerError);
    expect((await s.status('acme')).blocking).toEqual(['tax.default_bps']);
  });

  it('keeps tenants isolated', async () => {
    const s = new DurableTenantSettings(new InMemoryConfigVersionStore());
    await s.apply('acme', item('tax.default_bps'), 1800, 'owner-1', AT);
    expect((await s.status('other')).blocking).toEqual(['tax.default_bps']);
  });
});
