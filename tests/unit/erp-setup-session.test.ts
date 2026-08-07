import { describe, it, expect } from 'vitest';
import { createSetupSession } from '../../apps/web-erp/src/setup-session';
import {
  TenantSettings, SETTINGS, setupStatus, applyAnswer, setupItem,
  type SetupStatus,
} from '../../packages/tenant/src/index';
import { ConfigStore } from '../../packages/config/src/index';

// The store-setup screen presents the platform API's setup status: grouped settings, a plain
// headline saying whether the store can open, and the block list — with editing gated on a named
// user (ADR-0003 §4 / M33-FR-01 / §27).

const AT = '2026-08-07T10:00:00Z';
const freshStatus = (): SetupStatus => setupStatus(new TenantSettings(new ConfigStore()), 'acme');

function answeredStatus(): SetupStatus {
  const s = new TenantSettings(new ConfigStore());
  applyAnswer(s, 'acme', setupItem('tax.default_bps')!, 1800, 'owner', AT);
  applyAnswer(s, 'acme', setupItem('trading_day.cutoff')!, '22:00', 'owner', AT);
  return setupStatus(s, 'acme');
}

describe('store-setup screen', () => {
  it('headlines a fresh store as not yet openable, and names what is missing', () => {
    const status = freshStatus();
    const session = createSetupSession({ tenantId: 'acme', userId: 'owner-1' }, { status: () => status });
    const h = session.headline();
    expect(h.complete).toBe(false);
    expect(h.blocking.map((b) => b.key)).toEqual(['tax.default_bps']);
    expect(h.blocking[0]?.question).toContain('GST');
    expect(h.sentence).toContain('still needed');
    expect(h.answered).toBe(0);
  });

  it('headlines a configured store as ready, in a plain sentence', () => {
    const status = answeredStatus();
    const session = createSetupSession({ tenantId: 'acme', userId: 'owner-1' }, { status: () => status });
    const h = session.headline();
    expect(h.complete).toBe(true);
    expect(h.blocking).toEqual([]);
    expect(h.answered).toBe(2);
    expect(h.sentence).toContain('complete');
  });

  it('groups settings give-now first, then defaults to check', () => {
    const session = createSetupSession({ tenantId: 'acme', userId: 'owner-1' }, { status: () => freshStatus() });
    const groups = session.groups();
    expect(groups[0]?.group).toBe('give_now');
    expect(groups.map((g) => g.group)).toEqual(['give_now', 'check_default']);
    // The tax class is present, marked as the blocking one.
    const tax = groups.flatMap((g) => g.items).find((i) => i.key === SETTINGS.DEFAULT_TAX_BPS.key);
    expect(tax?.state).toBe('blocking');
    expect(tax?.required).toBe(true);
  });

  it('shows the value in force and whether it is a default', () => {
    const session = createSetupSession({ tenantId: 'acme', userId: 'owner-1' }, { status: () => answeredStatus() });
    const items = session.groups().flatMap((g) => g.items);
    const cutoff = items.find((i) => i.key === 'trading_day.cutoff');
    expect(cutoff?.value).toBe('22:00');
    expect(cutoff?.isDefault).toBe(false);
    const currency = items.find((i) => i.key === 'locale.currency');
    expect(currency?.isDefault).toBe(true); // untouched → default
  });

  it('lets a named user edit, but refuses when the box was not told who is looking', () => {
    const status = freshStatus();
    expect(createSetupSession({ tenantId: 'acme', userId: 'owner-1' }, { status: () => status }).canEdit()).toBe(true);
    expect(createSetupSession({ tenantId: 'acme', userId: null }, { status: () => status }).canEdit()).toBe(false);
  });
});
