import { describe, it, expect } from 'vitest';
import { loadConfig, CLOUD_API_CONFIG } from '../../services/kernel/src/config';
import { isIndiaRegion, indiaRegionProblem, checkPaymentDataResidency } from '../../services/kernel/src/data-residency';
import { registerAdapter, type AdapterConfig, type CertifiedEntry } from '../../packages/integration/src/adapters';
import { INDIA_SUBDIVISIONS, INDIA_FORMER_SUBDIVISION_CODES, indiaRegionName } from '../../packages/integration/src/india-regions';

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
  // L5 (verifier lane 2) · OB-162: "IN-<state>" is checked against the real ISO 3166-2:IN list, not "any two letters".
  it('the list is the 28 states and 8 union territories of ISO 3166-2:IN, and every one is accepted', () => {
    const codes = Object.keys(INDIA_SUBDIVISIONS).sort();
    expect(codes).toEqual(['AN', 'AP', 'AR', 'AS', 'BR', 'CG', 'CH', 'DH', 'DL', 'GA', 'GJ', 'HP', 'HR', 'JH', 'JK', 'KA', 'KL', 'LA', 'LD', 'MH', 'ML', 'MN', 'MP', 'MZ', 'NL', 'OD', 'PB', 'PY', 'RJ', 'SK', 'TN', 'TR', 'TS', 'UK', 'UP', 'WB']);
    for (const c of codes) expect(isIndiaRegion(`IN-${c}`), c).toBe(true);
    expect(indiaRegionName('IN-TN')).toBe('Tamil Nadu, India');
    expect(indiaRegionName('IN')).toBe('India');
  });
  it('codes ISO used before its 2020/2023 updates still name the same place in India', () => {
    expect(INDIA_FORMER_SUBDIVISION_CODES).toEqual({ CT: 'CG', OR: 'OD', TG: 'TS', UT: 'UK', DD: 'DH', DN: 'DH' });
    for (const c of Object.keys(INDIA_FORMER_SUBDIVISION_CODES)) expect(isIndiaRegion(`IN-${c}`), c).toBe(true);
    expect(indiaRegionName('IN-OR')).toBe('Odisha, India');
  });
  it('"IN-ZZ" and every other two letters that are not an Indian state or territory are refused', () => {
    const known = new Set([...Object.keys(INDIA_SUBDIVISIONS), ...Object.keys(INDIA_FORMER_SUBDIVISION_CODES)]);
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let refused = 0;
    for (const x of A) for (const y of A) {
      const code = `${x}${y}`;
      expect(isIndiaRegion(`IN-${code}`), code).toBe(known.has(code));
      if (!known.has(code)) refused += 1;
    }
    expect(refused).toBe(26 * 26 - 42);
    expect(isIndiaRegion('IN-ZZ')).toBe(false);
    expect(indiaRegionProblem('PAYMENT_DATA_REGION', 'IN-ZZ')).toContain('"IN-ZZ", which is not India');
    expect(isIndiaRegion('IN-TOSTRING')).toBe(false);
    expect(isIndiaRegion('IN-__')).toBe(false);
  });
  it('the API does not start with IN-ZZ as the payment-data or backup region', () => {
    const r = loadConfig(CLOUD_API_CONFIG, { ...GOOD_ENV, PAYMENT_DATA_REGION: 'IN-ZZ', PAYMENT_BACKUP_REGION: 'IN-ZZ' });
    expect(r.ok).toBe(false);
    expect(r.problems.map((p) => [p.key, p.problem])).toEqual([['PAYMENT_DATA_REGION', 'refused_by_policy'], ['PAYMENT_BACKUP_REGION', 'refused_by_policy']]);
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
  it('OB-162 "A": one that declares nothing (or a blank) is REFUSED, and its words say what to declare', () => {
    for (const over of [{}, { dataRegion: '' }, { dataRegion: '   ' }]) {
      const r = registerAdapter({ config: config(over), matrix, environment: 'sandbox' });
      expect(r, JSON.stringify(over)).toMatchObject({ registered: false, outcome: 'payment_data_region_not_declared' });
      expect(r.detail).toContain('only India is accepted');
    }
  });
  it('L5: refuses an "IN-" code that is not a real Indian state or union territory', () => {
    for (const region of ['IN-ZZ', 'IN-XX', 'IN-AA', 'IN-QQ', 'IN-US']) {
      expect(registerAdapter({ config: config({ dataRegion: region }), matrix, environment: 'sandbox' }), region).toMatchObject({ registered: false, outcome: 'payment_data_outside_india' });
    }
    const tn = registerAdapter({ config: config({ dataRegion: 'in-tn' }), matrix, environment: 'sandbox' });
    expect(tn.registered).toBe(true);
    expect(tn.detail).toContain('IN-TN (Tamil Nadu, India)');
  });
  it('a non-payment adapter is not asked for a data region', () => {
    const m: CertifiedEntry[] = [...matrix, { entryId: 'm2', category: 'accounting', vendor: 'ExampleBooks', model: 'api', versions: ['1'], certifiedOn: '2026-01-01' }];
    expect(registerAdapter({ config: config({ category: 'accounting', vendor: 'ExampleBooks', retains: undefined }), matrix: m, environment: 'sandbox' }).registered).toBe(true);
  });
});
