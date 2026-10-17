import { describe, it, expect } from 'vitest';
import {
  adapterUsable, adapterHealth, integrationHealth,
  type AdapterConfig, type AdapterHeartbeat,
} from '../../packages/integration/src/adapters';

// C12 · OB-170 "A" (owner, 16 Oct 2026): a payment adapter registered before OB-162 that declares no data region cannot be
// used until an India region is declared. Pure rule level. Synthetic vendors only.

const AT = '2026-10-17T10:00:00.000Z';
const legacy: AdapterConfig = {
  adapterId: 'pay-old', tenantId: 't1', category: 'payment', vendor: 'ExamplePay', environment: 'sandbox',
  credentialRef: 'vault://pay-old', retains: ['provider_token'], enabled: true,
};
const ok: readonly AdapterHeartbeat[] = [{ adapterId: 'pay-old', at: '2026-10-17T09:55:00.000Z', ok: true }];

describe('OB-170: a payment adapter with no data region may not be used', () => {
  it('refuses by name when the region is missing or blank, and says how to fix it', () => {
    for (const config of [legacy, { ...legacy, dataRegion: '   ' }]) {
      const use = adapterUsable(config);
      expect(use).toMatchObject({ usable: false, refusal: 'payment_data_region_not_declared' });
      expect(use.usable ? '' : use.detail).toContain('cannot be used until an India region is declared');
    }
  });

  it('refuses a region outside India by name; an India region is usable', () => {
    expect(adapterUsable({ ...legacy, dataRegion: 'SG' })).toMatchObject({ usable: false, refusal: 'payment_data_outside_india' });
    expect(adapterUsable({ ...legacy, dataRegion: 'IN-TN' })).toEqual({ usable: true });
    expect(adapterUsable({ ...legacy, dataRegion: 'in' })).toEqual({ usable: true });
  });

  it('every other category is usable without a region', () => {
    expect(adapterUsable({ ...legacy, adapterId: 'acc', category: 'accounting', vendor: 'ExampleBooks' })).toEqual({ usable: true });
  });

  it('health shows it as blocked — never healthy from its old heartbeats — and ranks it first', () => {
    const h = adapterHealth({ config: legacy, heartbeats: ok, at: AT });
    expect(h).toMatchObject({ state: 'blocked', usable: false, notUsableBecause: 'payment_data_region_not_declared', minutesSinceLastSuccess: 5 });
    const fixed = adapterHealth({ config: { ...legacy, dataRegion: 'IN' }, heartbeats: ok, at: AT });
    expect(fixed).toMatchObject({ state: 'healthy', usable: true });
    expect(fixed.notUsableBecause).toBeUndefined();

    const report = integrationHealth({
      tenantId: 't1', at: AT, heartbeats: ok,
      configs: [{ ...legacy, adapterId: 'acc', category: 'accounting', vendor: 'ExampleBooks' }, legacy],
    });
    expect(report.adapters.map((a) => `${a.adapterId}:${a.state}`)).toEqual(['pay-old:blocked', 'acc:silent']);
    expect(report.detail).toBe('2 adapter(s) need attention: pay-old, acc — the till is unaffected either way (hard rule #1)');
  });

  it('switched off, it stays disabled but still says it is not usable', () => {
    const h = adapterHealth({ config: { ...legacy, enabled: false }, heartbeats: ok, at: AT });
    expect(h).toMatchObject({ state: 'disabled', usable: false, notUsableBecause: 'payment_data_region_not_declared' });
    expect(h.detail).toContain('this adapter is switched off — and ExamplePay was registered before');
  });
});
