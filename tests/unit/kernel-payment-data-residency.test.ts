import { describe, it, expect } from 'vitest';
import { loadConfig, CLOUD_API_CONFIG } from '../../services/kernel/src/config';
import { isIndiaRegion, indiaRegionProblem, checkPaymentDataResidency } from '../../services/kernel/src/data-residency';
import { registerAdapter, type AdapterConfig, type CertifiedEntry } from '../../packages/integration/src/adapters';

// C12 (v2.1 addendum · M32/M35 · ADR-0002): payment data is pinned to an India region; a configuration that puts it
// elsewhere fails a check — at boot (the API does not start) and at payment-adapter registration. No hostnames anywhere.

const KEY = (n: string): string => [n, 'synthetic', 'test', 'value'].join('-').padEnd(48, 'x');
const GOOD_ENV = {
  DATABASE_URL: 'postgres://app@db.invalid:5432/sre', PACK_SIGNING_KEY: KEY('pack'), IDP_SIGNING_KEY: KEY('idp'),
  IDP_ISSUER: 'https://idp.invalid', IDP_AUDIENCE: 'sre-retail-os-api', BOX_HISTORY_SEAL_KEY: KEY('seal'),
};

describe('India, as ISO 3166 — the country or one of its states', () => {
  it('accepts IN and IN-<state>, in any case', () => {
    for (const r of ['IN', 'in', ' IN-MH ', 'IN-TN', 'in-ka']) expect(isIndiaRegion(r), r).toBe(true);
  });
  it('refuses anywhere else, a vendor code, a blank and a typo', () => {
    for (const r of ['SG', 'US-VA', 'EU', 'INDIA', 'IN-', 'IN-MAH', 'NI', '', 'ap-south-1']) expect(isIndiaRegion(r), r).toBe(false);
    expect(indiaRegionProblem('PAYMENT_DATA_REGION', 'SG')).toContain('"SG", which is not India');
    expect(indiaRegionProblem('PAYMENT_DATA_REGION', 'IN-TN')).toBeUndefined();
  });
});

describe('the API does not start with payment data outside India (C12)', () => {
  it('starts with India — the default, or set explicitly', () => {
    const def = loadConfig(CLOUD_API_CONFIG, GOOD_ENV);
    expect(def.ok, def.detail).toBe(true);
    expect(def.value!['PAYMENT_DATA_REGION']).toBe('IN');
    expect(loadConfig(CLOUD_API_CONFIG, { ...GOOD_ENV, PAYMENT_DATA_REGION: 'IN-TN', PAYMENT_BACKUP_REGION: 'IN-MH' }).ok).toBe(true);
  });

  it('refuses to start when payment data, or its off-site copies, would be kept elsewhere — both named at once', () => {
    const r = loadConfig(CLOUD_API_CONFIG, { ...GOOD_ENV, PAYMENT_DATA_REGION: 'SG', PAYMENT_BACKUP_REGION: 'US-VA' });
    expect(r.ok).toBe(false);
    expect(r.value).toBeUndefined();
    expect(r.problems.map((p) => [p.key, p.problem])).toEqual([['PAYMENT_DATA_REGION', 'refused_by_policy'], ['PAYMENT_BACKUP_REGION', 'refused_by_policy']]);
    expect(r.detail).toContain('will not start');
  });

  it('the settings-level check says the same', () => {
    expect(checkPaymentDataResidency({ PAYMENT_DATA_REGION: 'IN' }).ok).toBe(true);
    expect(checkPaymentDataResidency({}).findings.map((f) => f.key)).toEqual(['PAYMENT_DATA_REGION']);
    expect(checkPaymentDataResidency({ PAYMENT_DATA_REGION: 'IN', PAYMENT_BACKUP_REGION: 'SG' }).findings.map((f) => f.key)).toEqual(['PAYMENT_BACKUP_REGION']);
  });
});

describe('a payment provider that keeps payment data outside India is not registered (C12)', () => {
  const matrix: CertifiedEntry[] = [{ entryId: 'm1', category: 'payment', vendor: 'ExamplePay', model: 'gateway', versions: ['1'], certifiedOn: '2026-01-01', rbiAuthorised: true }];
  const config = (over: Partial<AdapterConfig>): AdapterConfig => ({
    adapterId: 'pay-1', tenantId: 't', category: 'payment', vendor: 'ExamplePay', environment: 'sandbox',
    credentialRef: 'vault://pay-1', enabled: true, retains: ['provider_token', 'last4', 'network_name'], ...over,
  });
  it('registers one that declares India, and says where', () => {
    const r = registerAdapter({ config: config({ dataRegion: 'IN-MH' }), matrix, environment: 'sandbox' });
    expect(r.registered).toBe(true);
    expect(r.detail).toContain('payment data kept in IN-MH');
  });
  it('refuses one that declares anywhere else', () => {
    const r = registerAdapter({ config: config({ dataRegion: 'SG' }), matrix, environment: 'sandbox' });
    expect(r).toMatchObject({ registered: false, outcome: 'payment_data_outside_india' });
  });
  it('one that declares nothing is registered, and its words say so', () => {
    expect(registerAdapter({ config: config({}), matrix, environment: 'sandbox' }).detail).toContain('not declared');
  });
});
