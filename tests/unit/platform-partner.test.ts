import { describe, it, expect } from 'vitest';
import {
  checkPartnerAccess,
  certificationStatus,
  seedSandbox,
  type PartnerCredential,
  type ApiVersion,
  type SandboxTenant,
  type Certification,
} from '../../packages/platform/src/partner';

// M36-FR-04 acceptance: "a partner builds an integration against the sandbox using versioned
// APIs, with no SRE code change, and it runs unchanged against a production tenant."

const VERSIONS: readonly ApiVersion[] = [
  { contract: 'API-06 orders', version: 'v3', status: 'current' },
  { contract: 'API-06 orders', version: 'v2', status: 'deprecated' },
  { contract: 'API-06 orders', version: 'v1', status: 'retired', retiredOn: '2026-01-31' },
  { contract: 'API-04 stock', version: 'v2', status: 'current' },
];

const cred = (over: Partial<PartnerCredential> = {}): PartnerCredential => ({
  credentialId: 'pc-1',
  partnerId: 'p-integrator',
  environment: 'production',
  scopedTenantIds: ['t-sre'],
  scopes: ['orders.read', 'orders.write'],
  issuedOn: '2026-01-01',
  expiresOn: '2027-01-01',
  ...over,
});

function access(over: Partial<Parameters<typeof checkPartnerAccess>[0]> = {}) {
  return checkPartnerAccess({
    credential: cred(), environment: 'production', tenantId: 't-sre',
    requiredScope: 'orders.read', contract: 'API-06 orders', requestedVersion: 'v3',
    versions: VERSIONS, today: '2026-08-04', ...over,
  });
}

describe('a sandbox credential can NEVER reach production (hard rule #7)', () => {
  it('allows a properly scoped, versioned production call', () => {
    const d = access();
    expect(d.allowed).toBe(true);
    expect(d.securityEvent).toBe(false);
  });

  it('REFUSES a sandbox credential against production, and records it', () => {
    const d = access({ credential: cred({ environment: 'sandbox' }) });
    expect(d.allowed).toBe(false);
    expect(d.outcome).toBe('sandbox_credential_in_production');
    expect(d.securityEvent).toBe(true);
    expect(d.detail).toContain('whether it was a mistake or not');
  });

  it('stops a production credential in the sandbox WITHOUT calling it an attack', () => {
    const d = access({ environment: 'sandbox' });
    expect(d.allowed).toBe(false);
    expect(d.outcome).toBe('production_credential_in_sandbox');
    // Calling every mix-up an attack trains people to ignore the alerts.
    expect(d.securityEvent).toBe(false);
  });
});

describe('a partner holds keys only to the tenants that engaged them', () => {
  it('REFUSES a tenant outside the engagement, as a security event', () => {
    const d = access({ tenantId: 't-kumar' });
    expect(d.outcome).toBe('tenant_not_in_scope');
    expect(d.securityEvent).toBe(true);
    expect(d.detail).toContain('does not hold a key to every retailer');
  });

  it('treats an empty scope list as NONE, never as all', () => {
    expect(access({ credential: cred({ scopedTenantIds: [] }) }).outcome).toBe('tenant_not_in_scope');
  });

  it('refuses a scope the credential does not carry, without calling it an attack', () => {
    const d = access({ requiredScope: 'finance.read' });
    expect(d.outcome).toBe('scope_missing');
    expect(d.securityEvent).toBe(false);
  });

  it('refuses an expired credential, and a revoked one as a security event', () => {
    expect(access({ credential: cred({ expiresOn: '2026-06-01' }) }).outcome).toBe('expired');
    const revoked = access({ credential: cred({ revokedOn: '2026-07-01' }) });
    expect(revoked.outcome).toBe('revoked');
    expect(revoked.securityEvent).toBe(true);
  });
});

describe('an unversioned call is REFUSED, never defaulted to the latest', () => {
  it('refuses when no version was asked for', () => {
    const d = access({ requestedVersion: undefined });
    expect(d.outcome).toBe('unversioned');
    // Defaulting to latest is what silently breaks a partner on the morning we ship.
    expect(d.detail).toContain('defaulting is what breaks a partner integration');
  });

  it('refuses a version that does not exist and one that was retired', () => {
    expect(access({ requestedVersion: 'v9' }).outcome).toBe('unknown_version');
    const retired = access({ requestedVersion: 'v1' });
    expect(retired.outcome).toBe('version_retired');
    expect(retired.detail).toContain('2026-01-31');
  });

  it('allows a DEPRECATED version and says it will not last', () => {
    const d = access({ requestedVersion: 'v2' });
    expect(d.allowed).toBe(true);
    expect(d.detail).toContain('it will not forever');
  });
});

const certified = (over: Partial<Certification> = {}): Certification => ({
  certificationId: 'cert-1', partnerId: 'p-integrator', connectorId: 'conn-tally',
  certifiedOn: '2026-02-01',
  againstVersions: [{ contract: 'API-06 orders', version: 'v3' }],
  certifiedBy: 'u-platform-admin',
  ...over,
});

describe('a connector certified against v1 and running on v4 is old with a badge', () => {
  const status = (over: Partial<Parameters<typeof certificationStatus>[0]> = {}) =>
    certificationStatus({
      connectorId: 'conn-tally', partnerId: 'p-integrator', certification: certified(),
      currentVersions: VERSIONS, today: '2026-08-04', ...over,
    });

  it('is current when it was tested against the contracts in force', () => {
    const s = status();
    expect(s.verdict).toBe('current');
    expect(s.mayRunInProduction).toBe(true);
  });

  it('goes STALE when the contract moved on, and keeps running', () => {
    const s = status({ certification: certified({ againstVersions: [{ contract: 'API-06 orders', version: 'v2' }] }) });
    expect(s.verdict).toBe('stale_version');
    // Pulling a working integration out of a live shop over paperwork is worse than the risk.
    expect(s.mayRunInProduction).toBe(true);
    expect(s.behind[0]).toEqual({ contract: 'API-06 orders', certified: 'v2', current: 'v3' });
    expect(s.detail).toContain('old with a badge');
  });

  it('expires on age and still runs', () => {
    const s = status({ certification: certified({ certifiedOn: '2023-01-01' }) });
    expect(s.verdict).toBe('expired');
    expect(s.mayRunInProduction).toBe(true);
  });

  it('REFUSES production to a connector that was never certified', () => {
    const s = status({ certification: undefined });
    expect(s.verdict).toBe('never_certified');
    expect(s.mayRunInProduction).toBe(false);
    expect(s.detail).toContain("somebody else's untested software");
  });
});

const sandbox = (over: Partial<SandboxTenant> = {}): SandboxTenant => ({
  tenantId: 't-sandbox-1', partnerId: 'p-integrator',
  createdOn: '2026-07-01', expiresOn: '2026-12-31', syntheticDataOnly: true, ...over,
});

describe('production data can NEVER reach a sandbox (hard rule #7)', () => {
  it('seeds generated records', () => {
    const result = seedSandbox({
      sandbox: sandbox(),
      records: [
        { recordId: 'r-1', origin: 'generated' },
        { recordId: 'r-2', origin: 'generated' },
      ],
      today: '2026-08-04',
    });
    expect(result.seeded).toBe(true);
    expect(result.records).toBe(2);
  });

  it('REFUSES THE WHOLE SEED when one record came from production', () => {
    const result = seedSandbox({
      sandbox: sandbox(),
      records: [
        { recordId: 'r-1', origin: 'generated' },
        { recordId: 'r-2', origin: 'production' },
      ],
      today: '2026-08-04',
    });
    expect(result.seeded).toBe(false);
    expect(result.outcome).toBe('production_data_refused');
    // The temptation always arrives with a good reason.
    expect(result.detail).toContain('whatever the reason given');
  });

  it('refuses to seed an expired sandbox', () => {
    const result = seedSandbox({
      sandbox: sandbox({ expiresOn: '2026-06-30' }),
      records: [{ recordId: 'r-1', origin: 'generated' }],
      today: '2026-08-04',
    });
    expect(result.outcome).toBe('expired');
  });
});
